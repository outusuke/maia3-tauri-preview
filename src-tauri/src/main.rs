// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod brilliant;
mod engine;
mod game;
mod insights;
mod pgn;
mod setup;

use analysis::{AnalysisConfig, MoveAnalysis};
use chess::{Board, Piece, Square};
use engine::Engine;
use game::{Game, GameState};
use setup::{install_stockfish, remove_onnx_model, remove_stockfish, run_setup, setup_status};
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

struct AppState {
    game: Mutex<Game>,
    engine: Mutex<Option<Engine>>,
    /// Separate from `engine` so a running game and an analysis don't fight over one subprocess.
    stockfish: Mutex<Option<Engine>>,
    /// Own Maia process so Analyze doesn't disturb a game in progress on the Play tab.
    insights: Mutex<Option<Engine>>,
    insights_model: Mutex<Option<String>>,
    insights_last_used: Mutex<Instant>,
}

const INSIGHTS_IDLE: Duration = Duration::from_secs(120);

// the idle reaper may have killed it, so respawn on demand
fn insights_slot<'a>(
    app: &AppHandle,
    state: &'a AppState,
) -> Result<MutexGuard<'a, Option<Engine>>, String> {
    let mut slot = state.insights.lock().map_err(|e| e.to_string())?;
    if slot.is_none() {
        let model = state
            .insights_model
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("Maia insights engine is not running")?;
        let (cmd, args) =
            setup::onnx_engine_command(app, &model, vec!["--threads".into(), "2".into()])?;
        *slot = Some(Engine::spawn(&cmd, &args)?);
    }
    *state.insights_last_used.lock().map_err(|e| e.to_string())? = Instant::now();
    Ok(slot)
}

fn parse_promotion(p: Option<String>) -> Option<Piece> {
    match p.as_deref() {
        Some("q") => Some(Piece::Queen),
        Some("r") => Some(Piece::Rook),
        Some("b") => Some(Piece::Bishop),
        Some("n") => Some(Piece::Knight),
        _ => None,
    }
}

#[tauri::command]
fn new_game(state: State<AppState>, fen: Option<String>) -> Result<GameState, String> {
    let mut game = state.game.lock().map_err(|e| e.to_string())?;
    *game = match fen {
        Some(f) if !f.trim().is_empty() => Game::from_fen(&f)?,
        _ => Game::new(),
    };
    Ok(game.state())
}

#[tauri::command]
fn get_state(state: State<AppState>) -> Result<GameState, String> {
    let game = state.game.lock().map_err(|e| e.to_string())?;
    Ok(game.state())
}

#[tauri::command]
fn legal_targets(state: State<AppState>, square: String) -> Result<Vec<String>, String> {
    let sq = Square::from_str(&square).map_err(|e| e.to_string())?;
    let game = state.game.lock().map_err(|e| e.to_string())?;
    Ok(game.legal_targets(sq))
}

#[tauri::command]
fn make_move(
    state: State<AppState>,
    from: String,
    to: String,
    promotion: Option<String>,
) -> Result<GameState, String> {
    let from_sq = Square::from_str(&from).map_err(|e| e.to_string())?;
    let to_sq = Square::from_str(&to).map_err(|e| e.to_string())?;
    let promo = parse_promotion(promotion);
    let mut game = state.game.lock().map_err(|e| e.to_string())?;
    game.try_move(from_sq, to_sq, promo)?;
    Ok(game.state())
}

// (async) moves slow commands off the UI thread; a plain sync command freezes the window until it returns.

/// "onnx" needs the model exported first by run_onnx_setup; "pytorch" is the legacy pip console-script path.
#[tauri::command(async)]
fn start_engine(
    app: AppHandle,
    state: State<AppState>,
    command: String,
    elo: u32,
    backend: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<(), String> {
    let (cmd, args) = match backend.as_deref() {
        Some("onnx") => setup::onnx_engine_command(&app, &command, extra_args.unwrap_or_default())?,
        _ => (command, extra_args.unwrap_or_default()),
    };

    let mut slot = state.engine.lock().map_err(|e| e.to_string())?;
    // Dropping the old engine sends `quit` and kills it.
    *slot = None;

    let mut eng = Engine::spawn(&cmd, &args)?;
    eng.set_elo(elo)?;
    *slot = Some(eng);
    Ok(())
}

#[tauri::command(async)]
fn start_insights_engine(
    app: AppHandle,
    state: State<AppState>,
    command: String,
) -> Result<(), String> {
    *state.insights_model.lock().map_err(|e| e.to_string())? = Some(command);
    drop(insights_slot(&app, state.inner())?);
    Ok(())
}

#[tauri::command(async)]
fn human_moves(
    app: AppHandle,
    state: State<AppState>,
    start_fen: String,
    ucis: Vec<String>,
    played: Option<String>,
    ratings: Vec<u32>,
    rating: u32,
) -> Result<insights::HumanMoves, String> {
    let mut slot = insights_slot(&app, state.inner())?;
    let maia = slot.as_mut().ok_or("Maia insights engine is not running")?;
    insights::human_moves(maia, &start_fen, &ucis, played.as_deref(), &ratings, rating)
}

#[tauri::command(async)]
fn maia_estimate(
    app: AppHandle,
    state: State<AppState>,
    start_fen: String,
    ucis: Vec<String>,
    plies: Vec<usize>,
    ratings: Vec<u32>,
) -> Result<Vec<engine::PlyLogProbs>, String> {
    let mut slot = insights_slot(&app, state.inner())?;
    let maia = slot.as_mut().ok_or("Maia insights engine is not running")?;
    maia.maia_estimate(&start_fen, &ucis, &plies, &ratings, std::time::Duration::from_secs(120))
}

#[tauri::command(async)]
fn score_human_moves(
    state: State<AppState>,
    start_fen: String,
    ucis: Vec<String>,
    moves: Vec<String>,
    depth: Option<u32>,
) -> Result<insights::MoveScores, String> {
    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    let sf = slot.as_mut().ok_or("stockfish is not running")?;
    insights::score_moves(sf, &start_fen, &ucis, &moves, depth.unwrap_or(10))
}

#[tauri::command]
fn stop_engine(state: State<AppState>) -> Result<(), String> {
    let mut slot = state.engine.lock().map_err(|e| e.to_string())?;
    *slot = None;
    Ok(())
}

#[tauri::command]
fn set_engine_elo(state: State<AppState>, elo: u32) -> Result<(), String> {
    let mut slot = state.engine.lock().map_err(|e| e.to_string())?;
    match slot.as_mut() {
        Some(eng) => eng.set_elo(elo),
        None => Err("engine not running".into()),
    }
}

#[tauri::command(async)]
fn engine_move(state: State<AppState>) -> Result<GameState, String> {
    let (start_fen, moves) = {
        let game = state.game.lock().map_err(|e| e.to_string())?;
        let (start_fen, moves) = game.uci_history();
        (start_fen.to_string(), moves.to_vec())
    };

    let uci_move = {
        let mut slot = state.engine.lock().map_err(|e| e.to_string())?;
        let eng = slot.as_mut().ok_or("engine not running")?;
        eng.best_move(&start_fen, &moves, Duration::from_secs(30))?
    };

    let mut game = state.game.lock().map_err(|e| e.to_string())?;
    game.try_move_uci(&uci_move)?;
    Ok(game.state())
}

#[tauri::command]
fn engine_running(state: State<AppState>) -> Result<bool, String> {
    let slot = state.engine.lock().map_err(|e| e.to_string())?;
    Ok(slot.is_some())
}

#[tauri::command]
fn undo_move(state: State<AppState>) -> Result<GameState, String> {
    let mut game = state.game.lock().map_err(|e| e.to_string())?;
    game.undo()?;
    Ok(game.state())
}

/// Leave `command` empty to auto-locate Stockfish; a "not-found:" error prefix lets the UI offer a download.
#[tauri::command(async)]
fn start_stockfish(
    app: AppHandle,
    state: State<AppState>,
    command: Option<String>,
) -> Result<(), String> {
    let resolved = match command.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() && c != "stockfish" => c.to_string(),
        _ => setup::resolve_stockfish(&app).ok_or_else(setup::stockfish_not_found_message)?,
    };

    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    *slot = None;
    let eng = Engine::spawn(&resolved, &[])?;
    *slot = Some(eng);
    Ok(())
}

#[tauri::command]
fn stop_stockfish(state: State<AppState>) -> Result<(), String> {
    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    *slot = None;
    Ok(())
}

#[tauri::command]
fn stockfish_running(state: State<AppState>) -> Result<bool, String> {
    let slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    Ok(slot.is_some())
}

#[tauri::command(async)]
fn analyze_position(
    state: State<AppState>,
    fen: String,
    depth: Option<u32>,
    multipv: Option<u32>,
) -> Result<Vec<engine::PvLine>, String> {
    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    let eng = slot.as_mut().ok_or("stockfish is not running")?;
    eng.analyze(
        &fen,
        depth.unwrap_or(14),
        multipv.unwrap_or(1),
        Duration::from_secs(60),
    )
}

/// One live-analysis line; scores are from White's perspective so the eval doesn't flip with the side to move.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveLine {
    multipv: u32,
    depth: u32,
    score_cp: Option<i32>,
    mate: Option<i32>,
    sans: Vec<String>,
    ucis: Vec<String>,
    fens: Vec<String>,
}

#[tauri::command(async)]
fn engine_lines(
    state: State<AppState>,
    fen: String,
    depth: u32,
    multipv: u32,
) -> Result<Vec<LiveLine>, String> {
    let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
    let sign = if board.side_to_move() == chess::Color::White { 1 } else { -1 };

    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    let eng = slot.as_mut().ok_or("stockfish is not running")?;
    let mut lines = eng.analyze(&fen, depth, multipv.max(1), Duration::from_secs(60))?;
    lines.sort_by_key(|l| l.multipv);

    Ok(lines
        .into_iter()
        .map(|l| {
            let (sans, ucis, fens) = analysis::sanify_line(&board, &l.pv);
            LiveLine {
                multipv: l.multipv,
                depth: l.depth,
                score_cp: l.score_cp.map(|cp| cp * sign),
                mate: l.mate.map(|m| m * sign),
                sans,
                ucis,
                fens,
            }
        })
        .collect())
}

#[tauri::command(async)]
fn analyze_pgn(
    state: State<AppState>,
    pgn_text: String,
    depth: Option<u32>,
    multipv: Option<u32>,
) -> Result<Vec<MoveAnalysis>, String> {
    let parsed = pgn::parse_pgn(&pgn_text)?;
    let start_board =
        Board::from_str(&parsed.start_fen).map_err(|e| format!("invalid start FEN: {e}"))?;

    let mut config = AnalysisConfig::default();
    if let Some(d) = depth {
        config.depth = d;
    }
    if let Some(mpv) = multipv {
        config.multipv = mpv.max(1);
    }

    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    let eng = slot.as_mut().ok_or("stockfish is not running")?;
    analysis::analyze_game(eng, &parsed, start_board, &config)
}

/// Backs "Analyze This Game" so a played game skips the PGN round trip.
#[tauri::command(async)]
fn analyze_moves(
    state: State<AppState>,
    sans: Vec<String>,
    start_fen: Option<String>,
    depth: Option<u32>,
    multipv: Option<u32>,
) -> Result<Vec<MoveAnalysis>, String> {
    let parsed = pgn::parse_sans(&sans, start_fen.as_deref())?;
    let start_board =
        Board::from_str(&parsed.start_fen).map_err(|e| format!("invalid start FEN: {e}"))?;

    let mut config = AnalysisConfig::default();
    if let Some(d) = depth {
        config.depth = d;
    }
    if let Some(mpv) = multipv {
        config.multipv = mpv.max(1);
    }

    let mut slot = state.stockfish.lock().map_err(|e| e.to_string())?;
    let eng = slot.as_mut().ok_or("stockfish is not running")?;
    analysis::analyze_game(eng, &parsed, start_board, &config)
}

#[tauri::command]
fn parse_pgn(pgn_text: String) -> Result<pgn::ParsedGame, String> {
    pgn::parse_pgn(&pgn_text)
}

#[tauri::command]
fn validate_fen(fen: String) -> Result<(), String> {
    game::validate_fen(&fen)
}

#[tauri::command]
fn scratch_legal_targets(fen: String, square: String) -> Result<Vec<String>, String> {
    let sq = Square::from_str(&square).map_err(|e| e.to_string())?;
    game::scratch_legal_targets(&fen, sq)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScratchMoveResult {
    fen: String,
    san: String,
    uci: String,
}

#[tauri::command]
fn scratch_try_move(
    fen: String,
    from: String,
    to: String,
    promotion: Option<String>,
) -> Result<ScratchMoveResult, String> {
    let from_sq = Square::from_str(&from).map_err(|e| e.to_string())?;
    let to_sq = Square::from_str(&to).map_err(|e| e.to_string())?;
    let promo = parse_promotion(promotion);
    let (fen, san, uci) = game::scratch_try_move(&fen, from_sq, to_sq, promo)?;
    Ok(ScratchMoveResult { fen, san, uci })
}

/// Exports the model to ONNX via a throwaway torch venv; see setup.rs for the details.
#[tauri::command]
async fn run_onnx_setup(app: AppHandle, model: String) -> Result<(), String> {
    // Minutes of pip and export work: run on a blocking thread so the UI stays responsive.
    tauri::async_runtime::spawn_blocking(move || setup::run_onnx_setup(&app, &model))
        .await
        .map_err(|e| format!("setup task failed: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            game: Mutex::new(Game::new()),
            engine: Mutex::new(None),
            stockfish: Mutex::new(None),
            insights: Mutex::new(None),
            insights_model: Mutex::new(None),
            insights_last_used: Mutex::new(Instant::now()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(15));
                let state = handle.state::<AppState>();
                let idle = state
                    .insights_last_used
                    .lock()
                    .map(|t| t.elapsed() > INSIGHTS_IDLE)
                    .unwrap_or(false);
                if idle {
                    if let Ok(mut slot) = state.insights.try_lock() {
                        if slot.is_some() {
                            eprintln!("[insights] idle, shutting down");
                            *slot = None;
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            new_game,
            get_state,
            legal_targets,
            make_move,
            undo_move,
            start_engine,
            stop_engine,
            start_insights_engine,
            human_moves,
            score_human_moves,
            maia_estimate,
            set_engine_elo,
            engine_move,
            engine_running,
            start_stockfish,
            stop_stockfish,
            stockfish_running,
            analyze_position,
            engine_lines,
            analyze_pgn,
            analyze_moves,
            parse_pgn,
            validate_fen,
            scratch_legal_targets,
            scratch_try_move,
            setup_status,
            run_setup,
            run_onnx_setup,
            install_stockfish,
            remove_onnx_model,
            remove_stockfish,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Maia Chess");
}
