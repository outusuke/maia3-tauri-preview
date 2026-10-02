use crate::analysis::{effective_cp, winning_chances, AnalysisConfig};
use crate::engine::{Engine, MaiaInsights};
use crate::game::move_to_san;
use chess::{Board, ChessMove};
use serde::Serialize;
use std::str::FromStr;
use std::time::Duration;

const COVERAGE: f64 = 0.9;
const MAX_CANDIDATES: usize = 6;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanMove {
    pub uci: String,
    pub san: String,
    pub prob: f64,
    pub played: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanMoves {
    pub maia: MaiaInsights,
    pub moves: Vec<HumanMove>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveScore {
    pub uci: String,
    pub win_loss: f64,
    pub class: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveScores {
    pub best_uci: Option<String>,
    pub scores: Vec<MoveScore>,
}

// Same cutoffs the game grader uses, in win-rate units (winning chances run -1..1, so halve them).
fn classify(win_loss: f64, cfg: &AnalysisConfig) -> &'static str {
    if win_loss < cfg.inaccuracy_wc / 2.0 {
        "good"
    } else if win_loss < cfg.mistake_wc / 2.0 {
        "ok"
    } else {
        "blunder"
    }
}

fn position_after(start_fen: &str, ucis: &[String]) -> Result<Board, String> {
    let mut board = Board::from_str(start_fen).map_err(|e| format!("invalid start FEN: {e}"))?;
    for u in ucis {
        let mv = ChessMove::from_str(u).map_err(|e| format!("bad uci '{u}': {e}"))?;
        if !board.legal(mv) {
            return Err(format!("illegal move '{u}' in game history"));
        }
        board = board.make_move_new(mv);
    }
    Ok(board)
}

// Fast half: one Maia pass, no Stockfish, so the UI can draw right away.
pub fn human_moves(
    maia: &mut Engine,
    start_fen: &str,
    ucis: &[String],
    played: Option<&str>,
    ratings: &[u32],
    rating: u32,
) -> Result<HumanMoves, String> {
    let board = position_after(start_fen, ucis)?;
    let maia_data = maia.maia_insights(start_fen, ucis, ratings, TIMEOUT)?;

    let idx = ratings
        .iter()
        .position(|r| *r == rating)
        .ok_or_else(|| format!("rating {rating} isn't in the requested ratings"))?;
    let Some(policy) = maia_data.policies.get(idx).filter(|p| !p.is_empty()) else {
        return Ok(HumanMoves { maia: maia_data, moves: Vec::new() });
    };

    let mut ranked: Vec<(&String, f64)> = policy.iter().map(|(m, p)| (m, *p)).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));

    let mut ucis_out: Vec<(String, f64)> = Vec::new();
    let mut covered = 0.0;
    for (m, p) in ranked.into_iter().take(MAX_CANDIDATES) {
        ucis_out.push((m.clone(), p));
        covered += p;
        if covered >= COVERAGE {
            break;
        }
    }
    if let Some(p) = played {
        let legal = ChessMove::from_str(p).map(|m| board.legal(m)).unwrap_or(false);
        if legal && !ucis_out.iter().any(|(m, _)| m == p) {
            ucis_out.push((p.to_string(), policy.get(p).copied().unwrap_or(0.0)));
        }
    }

    let moves = ucis_out
        .into_iter()
        .filter_map(|(uci, prob)| {
            let mv = ChessMove::from_str(&uci).ok()?;
            Some(HumanMove {
                san: move_to_san(&board, mv),
                played: played == Some(uci.as_str()),
                uci,
                prob,
            })
        })
        .collect();

    Ok(HumanMoves { maia: maia_data, moves })
}

// Slow half: Stockfish loss of each candidate against its own best move.
pub fn score_moves(
    stockfish: &mut Engine,
    start_fen: &str,
    ucis: &[String],
    moves: &[String],
    depth: u32,
) -> Result<MoveScores, String> {
    if moves.is_empty() {
        return Ok(MoveScores { best_uci: None, scores: Vec::new() });
    }
    let fen = format!("{}", position_after(start_fen, ucis)?);

    let best = stockfish
        .analyze(&fen, depth, 1, TIMEOUT)?
        .into_iter()
        .next()
        .ok_or("engine returned no best line")?;
    let best_eff = effective_cp(best.score_cp, best.mate);
    let cfg = AnalysisConfig::default();

    let scores = stockfish
        .analyze_candidates(&fen, depth, moves, TIMEOUT)?
        .into_iter()
        .filter_map(|line| {
            let uci = line.pv.first()?.clone();
            let eff = effective_cp(line.score_cp, line.mate);
            let win_loss = ((winning_chances(best_eff) - winning_chances(eff)) / 2.0).max(0.0);
            Some(MoveScore { class: classify(win_loss, &cfg), uci, win_loss })
        })
        .collect();

    Ok(MoveScores { best_uci: best.pv.first().cloned(), scores })
}
