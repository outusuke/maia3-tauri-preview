use crate::brilliant::{is_brilliant, BrilliantInput, Eval};
use crate::engine::Engine;
use crate::game::move_to_san;
use crate::pgn::ParsedGame;
use chess::{Board, ChessMove, Color, MoveGen};
use serde::Serialize;
use std::str::FromStr;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveGrade {
    Brilliant,
    OnlyMove,
    Best,
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAnalysis {
    pub ply: usize,
    pub san: String,
    pub uci: String,
    pub fen_before: String,
    pub fen_after: String,
    pub grade: MoveGrade,
    /// White's perspective so signs compare across plies; None for mate scores (see the mate fields).
    pub eval_before_cp: Option<i32>,
    pub eval_after_cp: Option<i32>,
    pub mate_before: Option<i32>,
    pub mate_after: Option<i32>,
    pub best_move_uci: Option<String>,
    pub best_move_san: Option<String>,
    pub best_line_san: Vec<String>,
    /// UCI form of `best_line_san`, used for arrows.
    pub best_line_uci: Vec<String>,
    /// Position after each line move, so the UI can step through it.
    pub best_line_fens: Vec<String>,
    /// UCI moves within the "good" eval window of the best move; any of them solves the puzzle.
    pub acceptable_moves: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AnalysisConfig {
    pub depth: u32,
    pub multipv: u32,
    // Winning-chances units (-1..1), same scale and constants Lichess grades moves on.
    pub inaccuracy_wc: f64,
    pub mistake_wc: f64,
    pub blunder_wc: f64,
    pub acceptable_cp: i32,
    pub move_timeout: Duration,
    // Max winning-chances loss for a non-top move to still count as Best.
    pub best_loss_wc: f64,
    // Min winning-chances gap to the second-best line for a top move to count as an only move.
    pub only_move_gap_wc: f64,
}

impl Default for AnalysisConfig {
    fn default() -> Self {
        AnalysisConfig {
            depth: 14,
            multipv: 3,
            inaccuracy_wc: 0.1,
            mistake_wc: 0.2,
            blunder_wc: 0.3,
            acceptable_cp: 20,
            move_timeout: Duration::from_secs(60),
            best_loss_wc: 0.01,
            only_move_gap_wc: 0.2,
        }
    }
}

/// Stand-in magnitude so mate scores compare sensibly against centipawns.
const MATE_CP_MAGNITUDE: i32 = 100_000;

pub(crate) fn effective_cp(cp: Option<i32>, mate: Option<i32>) -> i32 {
    match mate {
        Some(m) if m > 0 => MATE_CP_MAGNITUDE - m,
        Some(m) => -MATE_CP_MAGNITUDE - m,
        None => cp.unwrap_or(0),
    }
}

// lichess's cp->winning-chances curve; saturates near the edges so a shuffle in a won endgame isn't a "blunder"
pub(crate) fn winning_chances(effective_cp: i32) -> f64 {
    2.0 / (1.0 + (-0.004 * effective_cp as f64).exp()) - 1.0
}

fn to_eval(cp: Option<i32>, mate: Option<i32>, sign: i32) -> Eval {
    match mate {
        Some(m) => Eval { mate: true, value: m * sign },
        None => Eval { mate: false, value: cp.unwrap_or(0) * sign },
    }
}

fn flip_if_black(value: i32, side_to_move: Color) -> i32 {
    if side_to_move == Color::White {
        value
    } else {
        -value
    }
}

/// Reuses the top-line search for the played move's eval when it matches; otherwise runs a second single-line search.
pub fn analyze_game(
    engine: &mut Engine,
    parsed: &ParsedGame,
    start_board: Board,
    config: &AnalysisConfig,
) -> Result<Vec<MoveAnalysis>, String> {
    let mut board = start_board;
    let mut out = Vec::with_capacity(parsed.ucis.len());

    for (ply, (uci, san)) in parsed.ucis.iter().zip(parsed.sans.iter()).enumerate() {
        let fen_before = format!("{board}");
        let side_to_move = board.side_to_move();

        let lines = engine.analyze(&fen_before, config.depth, config.multipv, config.move_timeout)?;
        let best = lines
            .iter()
            .find(|l| l.multipv == 1)
            .ok_or("engine returned no best line")?;
        let best_effective = effective_cp(best.score_cp, best.mate);

        let mv = ChessMove::from_str(uci).map_err(|e| format!("bad uci '{uci}': {e}"))?;
        let board_after = board.make_move_new(mv);
        let played_is_best = best.pv.first().map(|m| m.as_str()) == Some(uci.as_str());

        // Scores from the mover's perspective; the after-move search reports the opponent's.
        let (played_effective, played_eval) = if played_is_best {
            (best_effective, to_eval(best.score_cp, best.mate, 1))
        } else {
            let after_fen = format!("{board_after}");
            let after_lines = engine.analyze(&after_fen, config.depth, 1, config.move_timeout)?;
            let after_best = after_lines
                .first()
                .ok_or("engine returned no line for the played move")?;
            (
                -effective_cp(after_best.score_cp, after_best.mate),
                to_eval(after_best.score_cp, after_best.mate, -1),
            )
        };

        let loss = (winning_chances(best_effective) - winning_chances(played_effective)).max(0.0);
        let mut grade = if loss < config.inaccuracy_wc {
            MoveGrade::Good
        } else if loss < config.mistake_wc {
            MoveGrade::Inaccuracy
        } else if loss < config.blunder_wc {
            MoveGrade::Mistake
        } else {
            MoveGrade::Blunder
        };

        let second = lines.iter().find(|l| l.multipv == 2);
        let second_effective = second.map(|l| effective_cp(l.score_cp, l.mate));
        let gap_wc = second_effective.map_or(0.0, |e| winning_chances(best_effective) - winning_chances(e));
        // Same cutoff WintrChess uses for "already winning anyway".
        let second_still_winning = second_effective.map_or(false, |e| e >= 700);
        let already_mating = best.mate.map_or(false, |m| m > 0);

        if played_is_best
            && gap_wc >= config.only_move_gap_wc
            && !second_still_winning
            && !already_mating
            && played_effective >= 0
            && MoveGen::new_legal(&board).len() > 1
        {
            grade = MoveGrade::OnlyMove;
        } else if played_is_best || loss < config.best_loss_wc {
            grade = MoveGrade::Best;
        }

        let second_eval = second.map(|l| to_eval(l.score_cp, l.mate, 1));
        if is_brilliant(&BrilliantInput {
            fen_before: &fen_before,
            uci,
            top_move_played: played_is_best,
            prev_top: to_eval(best.score_cp, best.mate, 1),
            prev_second: second_eval,
            current: played_eval,
        }) {
            grade = MoveGrade::Brilliant;
        }

        let eval_before_cp = best.score_cp.map(|cp| flip_if_black(cp, side_to_move));
        let mate_before = best.mate.map(|m| flip_if_black(m, side_to_move));
        // Sign flips only when Black was the mover.
        let eval_after_cp = if played_is_best {
            eval_before_cp
        } else {
            Some(flip_if_black(played_effective, side_to_move))
        };
        let mate_after = if played_is_best { mate_before } else { None };

        let best_move_uci = best.pv.first().cloned();
        let best_move_san = best_move_uci.as_ref().and_then(|u| {
            ChessMove::from_str(u)
                .ok()
                .filter(|m| board.legal(*m))
                .map(|m| move_to_san(&board, m))
        });
        let (best_line_san, best_line_uci, best_line_fens) = sanify_line(&board, &best.pv);

        let acceptable_moves: Vec<String> = lines
            .iter()
            .filter(|l| {
                let eff = effective_cp(l.score_cp, l.mate);
                (best_effective - eff).max(0) < config.acceptable_cp
            })
            .filter_map(|l| l.pv.first().cloned())
            .collect();

        out.push(MoveAnalysis {
            ply,
            san: san.clone(),
            uci: uci.clone(),
            fen_before: fen_before.clone(),
            fen_after: format!("{board_after}"),
            grade,
            eval_before_cp,
            eval_after_cp,
            mate_before,
            mate_after,
            best_move_uci,
            best_move_san,
            best_line_san,
            best_line_uci,
            best_line_fens,
            acceptable_moves,
        });

        board = board_after;
    }

    Ok(out)
}

/// (SAN, UCI, FEN after) per move; stops early if the PV goes illegal, which can happen right at mate.
pub(crate) fn sanify_line(start: &Board, ucis: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut board = start.clone();
    let mut sans = Vec::new();
    let mut moves = Vec::new();
    let mut fens = Vec::new();
    for u in ucis.iter().take(8) {
        let Ok(mv) = ChessMove::from_str(u) else {
            break;
        };
        if !board.legal(mv) {
            break;
        }
        sans.push(move_to_san(&board, mv));
        moves.push(u.clone());
        board = board.make_move_new(mv);
        fens.push(format!("{board}"));
    }
    (sans, moves, fens)
}
