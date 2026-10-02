use chess::{Board, BoardStatus, ChessMove, Color, MoveGen, Piece, Square};
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub fen: String,
    pub turn: String,
    pub in_check: bool,
    pub status: String,          // "ongoing" | "checkmate" | "stalemate" | "draw"
    pub winner: Option<String>,  // "white" | "black" | null
    pub last_move: Option<[String; 2]>,
    pub san_history: Vec<String>,
    pub legal_move_count: usize,
    pub can_undo: bool,
}

struct Snapshot {
    board: Board,
    last_move: Option<(Square, Square)>,
    repetitions: HashMap<String, u8>,
}

pub struct Game {
    board: Board,
    start_fen: String,
    uci_moves: Vec<String>,
    san_history: Vec<String>,
    last_move: Option<(Square, Square)>,
    /// Keyed on the FEN minus the move clocks, so repeated positions match.
    repetitions: HashMap<String, u8>,
    history: Vec<Snapshot>,
}

impl Game {
    pub fn new() -> Self {
        let board = Board::default();
        let mut repetitions = HashMap::new();
        repetitions.insert(repetition_key(&board), 1);
        Game {
            start_fen: format!("{board}"),
            board,
            uci_moves: Vec::new(),
            san_history: Vec::new(),
            last_move: None,
            repetitions,
            history: Vec::new(),
        }
    }

    pub fn from_fen(fen: &str) -> Result<Self, String> {
        let fen = sanitize_castle_rights(fen);
        let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
        let mut repetitions = HashMap::new();
        repetitions.insert(repetition_key(&board), 1);
        Ok(Game {
            start_fen: format!("{board}"),
            board,
            uci_moves: Vec::new(),
            san_history: Vec::new(),
            last_move: None,
            repetitions,
            history: Vec::new(),
        })
    }

    pub fn fen(&self) -> String {
        format!("{}", self.board)
    }

    pub fn legal_targets(&self, from: Square) -> Vec<String> {
        MoveGen::new_legal(&self.board)
            .filter(|m| m.get_source() == from)
            .map(|m| m.get_dest().to_string())
            .collect()
    }

    pub fn try_move(&mut self, from: Square, to: Square, promotion: Option<Piece>) -> Result<(), String> {
        let candidate = ChessMove::new(from, to, promotion);
        if !self.board.legal(candidate) {
            return Err("illegal move".into());
        }
        self.history.push(Snapshot {
            board: self.board.clone(),
            last_move: self.last_move,
            repetitions: self.repetitions.clone(),
        });
        let san = move_to_san(&self.board, candidate);
        self.board = self.board.make_move_new(candidate);
        self.uci_moves.push(candidate.to_string());
        self.san_history.push(san);
        self.last_move = Some((from, to));
        *self.repetitions.entry(repetition_key(&self.board)).or_insert(0) += 1;
        Ok(())
    }

    pub fn undo(&mut self) -> Result<(), String> {
        let snap = self.history.pop().ok_or("nothing to undo")?;
        self.board = snap.board;
        self.last_move = snap.last_move;
        self.repetitions = snap.repetitions;
        self.uci_moves.pop();
        self.san_history.pop();
        Ok(())
    }

    pub fn can_undo(&self) -> bool {
        !self.history.is_empty()
    }

    /// What a UCI `position` command needs to replay this game from scratch.
    pub fn uci_history(&self) -> (&str, &[String]) {
        (&self.start_fen, &self.uci_moves)
    }

    pub fn try_move_uci(&mut self, uci: &str) -> Result<(), String> {
        let uci = uci.trim();
        if uci.len() < 4 {
            return Err(format!("bad uci move: {uci}"));
        }
        let from = Square::from_str(&uci[0..2]).map_err(|e| e.to_string())?;
        let to = Square::from_str(&uci[2..4]).map_err(|e| e.to_string())?;
        let promotion = if uci.len() >= 5 {
            match uci.as_bytes()[4] as char {
                'q' => Some(Piece::Queen),
                'r' => Some(Piece::Rook),
                'b' => Some(Piece::Bishop),
                'n' => Some(Piece::Knight),
                _ => None,
            }
        } else {
            None
        };
        self.try_move(from, to, promotion)
    }

    pub fn state(&self) -> GameState {
        let turn = match self.board.side_to_move() {
            Color::White => "white",
            Color::Black => "black",
        };
        let in_check = self.board.checkers().popcnt() > 0;

        let is_draw_by_repetition = self.repetitions.values().any(|&c| c >= 3);
        let halfmove_clock: u16 = self
            .fen()
            .split_whitespace()
            .nth(4)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let is_draw_by_fifty_move = halfmove_clock >= 100;

        let (status, winner) = match self.board.status() {
            BoardStatus::Checkmate => {
                // side_to_move is the player who got mated.
                let winner = match self.board.side_to_move() {
                    Color::White => "black",
                    Color::Black => "white",
                };
                ("checkmate".to_string(), Some(winner.to_string()))
            }
            BoardStatus::Stalemate => ("stalemate".to_string(), None),
            BoardStatus::Ongoing => {
                if is_draw_by_repetition {
                    ("draw".to_string(), None)
                } else if is_draw_by_fifty_move {
                    ("draw".to_string(), None)
                } else {
                    ("ongoing".to_string(), None)
                }
            }
        };

        GameState {
            fen: self.fen(),
            turn: turn.to_string(),
            in_check,
            status,
            winner,
            last_move: self
                .last_move
                .map(|(f, t)| [f.to_string(), t.to_string()]),
            san_history: self.san_history.clone(),
            legal_move_count: MoveGen::new_legal(&self.board).len(),
            can_undo: self.can_undo(),
        }
    }
}

/// Free function so analysis.rs can reuse it on arbitrary positions without a full `Game`.
pub fn move_to_san(board: &Board, mv: ChessMove) -> String {
    let from = mv.get_source();
    let to = mv.get_dest();
    let piece = board.piece_on(from).unwrap_or(Piece::Pawn);

    if piece == Piece::King {
        let file_delta = (to.get_file().to_index() as i8) - (from.get_file().to_index() as i8);
        if file_delta == 2 {
            return with_check_suffix(board, mv, "O-O".to_string());
        } else if file_delta == -2 {
            return with_check_suffix(board, mv, "O-O-O".to_string());
        }
    }

    let is_en_passant =
        piece == Piece::Pawn && from.get_file() != to.get_file() && board.piece_on(to).is_none();
    let is_capture = board.piece_on(to).is_some() || is_en_passant;

    let piece_letter = match piece {
        Piece::Pawn => "",
        Piece::Knight => "N",
        Piece::Bishop => "B",
        Piece::Rook => "R",
        Piece::Queen => "Q",
        Piece::King => "K",
    };

    let mut san = String::new();
    if piece == Piece::Pawn {
        if is_capture {
            san.push(file_char(from));
            san.push('x');
        }
    } else {
        san.push_str(piece_letter);
        san.push_str(&disambiguation(board, mv, piece));
        if is_capture {
            san.push('x');
        }
    }
    san.push_str(&to.to_string());

    if let Some(promo) = mv.get_promotion() {
        san.push('=');
        san.push_str(match promo {
            Piece::Queen => "Q",
            Piece::Rook => "R",
            Piece::Bishop => "B",
            Piece::Knight => "N",
            _ => "Q",
        });
    }

    with_check_suffix(board, mv, san)
}

/// Disambiguates by file, then rank, then both, only when another piece could reach the square.
fn disambiguation(board: &Board, mv: ChessMove, piece: Piece) -> String {
    let from = mv.get_source();
    let to = mv.get_dest();
    let others: Vec<Square> = MoveGen::new_legal(board)
        .filter(|m| {
            m.get_dest() == to
                && m.get_source() != from
                && board.piece_on(m.get_source()) == Some(piece)
        })
        .map(|m| m.get_source())
        .collect();

    if others.is_empty() {
        return String::new();
    }
    let same_file = others.iter().any(|s| s.get_file() == from.get_file());
    let same_rank = others.iter().any(|s| s.get_rank() == from.get_rank());
    if !same_file {
        file_char(from).to_string()
    } else if !same_rank {
        rank_char(from).to_string()
    } else {
        format!("{}{}", file_char(from), rank_char(from))
    }
}

fn with_check_suffix(board: &Board, mv: ChessMove, mut san: String) -> String {
    let after = board.make_move_new(mv);
    if after.checkers().popcnt() > 0 {
        if after.status() == BoardStatus::Checkmate {
            san.push('#');
        } else {
            san.push('+');
        }
    }
    san
}

fn file_char(sq: Square) -> char {
    (b'a' + sq.get_file().to_index() as u8) as char
}
fn rank_char(sq: Square) -> char {
    (b'1' + sq.get_rank().to_index() as u8) as char
}

/// The FEN-based helpers below serve the puzzle board and setup preview, which never touch the live `Game`.
pub fn scratch_legal_targets(fen: &str, from: Square) -> Result<Vec<String>, String> {
    let fen = sanitize_castle_rights(fen);
    let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
    Ok(MoveGen::new_legal(&board)
        .filter(|m| m.get_source() == from)
        .map(|m| m.get_dest().to_string())
        .collect())
}

pub fn scratch_try_move(
    fen: &str,
    from: Square,
    to: Square,
    promotion: Option<Piece>,
) -> Result<(String, String, String), String> {
    let fen = sanitize_castle_rights(fen);
    let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
    let mv = ChessMove::new(from, to, promotion);
    if !board.legal(mv) {
        return Err("illegal move".into());
    }
    let san = move_to_san(&board, mv);
    let after = board.make_move_new(mv);
    Ok((format!("{after}"), san, mv.to_string()))
}

pub fn validate_fen(fen: &str) -> Result<(), String> {
    let fen = sanitize_castle_rights(fen);
    Board::from_str(&fen).map(|_| ()).map_err(|e| format!("invalid FEN: {e}"))
}

// Strip castling rights if the king moved; `chess` crate errors on stale flags instead of ignoring them
fn sanitize_castle_rights(fen: &str) -> String {
    let mut fields: Vec<&str> = fen.split_whitespace().collect();
    if fields.len() < 3 || fields[2] == "-" {
        return fen.to_string();
    }

    let ranks: Vec<&str> = fields[0].split('/').collect();
    if ranks.len() != 8 {
        return fen.to_string(); // malformed placement; let Board::from_str raise the real error
    }

    // FEN ranks run 8 -> 1, so rank 8 (Black's back rank) is ranks[0], rank 1 (White's) is ranks[7].
    let king_on_e_file = |rank: &str, king_char: char| -> bool {
        let mut file = 0u8;
        for c in rank.chars() {
            match c.to_digit(10) {
                Some(skip) => file += skip as u8,
                None => {
                    if file == 4 && c == king_char {
                        return true;
                    }
                    file += 1;
                }
            }
        }
        false
    };

    let white_king_home = king_on_e_file(ranks[7], 'K');
    let black_king_home = king_on_e_file(ranks[0], 'k');

    let cleaned: String = fields[2]
        .chars()
        .filter(|c| match c {
            'K' | 'Q' => white_king_home,
            'k' | 'q' => black_king_home,
            _ => true,
        })
        .collect();

    fields[2] = if cleaned.is_empty() { "-" } else { &cleaned };
    fields.join(" ")
}

/// FEN without the move clocks: the fields that define a repeated position.
fn repetition_key(board: &Board) -> String {
    let fen = format!("{board}");
    fen.split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}
