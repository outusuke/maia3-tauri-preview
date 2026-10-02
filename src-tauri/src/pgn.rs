use chess::{Board, ChessMove, Error};
use serde::Serialize;
use std::str::FromStr;

/// Variations are discarded; only the mainline is kept.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedGame {
    pub headers: Vec<(String, String)>,
    /// Always the actual starting FEN, standard or custom, not only when a [FEN] header exists.
    pub start_fen: String,
    pub sans: Vec<String>,
    pub ucis: Vec<String>,
    /// FEN after each ply, so the frontend can browse a loaded game before any engine pass.
    pub fens: Vec<String>,
    pub result: Option<String>,
}

pub fn parse_pgn(pgn: &str) -> Result<ParsedGame, String> {
    let mut headers = Vec::new();
    let mut start_fen_header = None;
    let mut movetext = String::new();

    for line in pgn.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            if let Some((key, value)) = parse_header(line) {
                if key.eq_ignore_ascii_case("FEN") {
                    start_fen_header = Some(value.clone());
                }
                headers.push((key, value));
            }
        } else if !line.is_empty() {
            movetext.push_str(line);
            movetext.push(' ');
        }
    }

    let start_board = match &start_fen_header {
        Some(fen) => Board::from_str(fen).map_err(|e| format!("invalid [FEN] header: {e}"))?,
        None => Board::default(),
    };

    let stripped = strip_comments_and_variations(&movetext);
    let tokens = tokenize(&stripped);

    let mut board = start_board;
    let mut sans = Vec::new();
    let mut ucis = Vec::new();
    let mut fens = Vec::new();
    let mut result = None;

    for tok in tokens {
        if is_result_token(&tok) {
            result = Some(tok);
            continue;
        }
        let clean = strip_annotation_glyphs(&tok);
        if clean.is_empty() {
            continue;
        }
        let mv = san_to_move(&board, &clean)
            .map_err(|e| format!("could not parse move '{tok}' (position {}): {e}", board))?;
        ucis.push(mv.to_string());
        sans.push(clean);
        board = board.make_move_new(mv);
        fens.push(format!("{board}"));
    }

    if sans.is_empty() {
        return Err("No moves found in that PGN.".into());
    }

    Ok(ParsedGame {
        headers,
        start_fen: format!("{start_board}"),
        sans,
        ucis,
        fens,
        result,
    })
}

/// Used by "Analyze This Game" so a played game skips the PGN text round trip.
pub fn parse_sans(sans_in: &[String], start_fen: Option<&str>) -> Result<ParsedGame, String> {
    let start_board = match start_fen {
        Some(fen) if !fen.trim().is_empty() => {
            Board::from_str(fen).map_err(|e| format!("invalid starting FEN: {e}"))?
        }
        _ => Board::default(),
    };

    let mut board = start_board;
    let mut sans = Vec::new();
    let mut ucis = Vec::new();
    let mut fens = Vec::new();

    for tok in sans_in {
        let clean = strip_annotation_glyphs(tok);
        if clean.is_empty() {
            continue;
        }
        let mv = san_to_move(&board, &clean)
            .map_err(|e| format!("could not replay move '{tok}' (position {}): {e}", board))?;
        ucis.push(mv.to_string());
        sans.push(clean);
        board = board.make_move_new(mv);
        fens.push(format!("{board}"));
    }

    Ok(ParsedGame {
        headers: Vec::new(),
        start_fen: format!("{start_board}"),
        sans,
        ucis,
        fens,
        result: None,
    })
}

/// chess's `from_san` only takes en passant captures written with an " e.p." suffix, which PGN doesn't use.
// also strips "=" since this crate wants "a8Q", not "a8=Q", for promotions
fn san_to_move(board: &Board, san: &str) -> Result<ChessMove, Error> {
    let normalized = san.replace('=', "");
    ChessMove::from_san(board, &normalized)
        .or_else(|first| ChessMove::from_san(board, &format!("{normalized} e.p.")).map_err(|_| first))
}

fn parse_header(line: &str) -> Option<(String, String)> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?;
    let sp = inner.find(' ')?;
    let key = inner[..sp].to_string();
    let value = inner[sp + 1..].trim().trim_matches('"').to_string();
    Some((key, value))
}

/// Tracks paren depth because variations can nest and contain {comments}.
fn strip_comments_and_variations(movetext: &str) -> String {
    let mut out = String::new();
    let mut paren_depth = 0i32;
    let mut in_comment = false;

    for ch in movetext.chars() {
        match ch {
            '{' => in_comment = true,
            '}' => in_comment = false,
            '(' if !in_comment => paren_depth += 1,
            ')' if !in_comment => paren_depth = (paren_depth - 1).max(0),
            _ if in_comment || paren_depth > 0 => {}
            other => out.push(other),
        }
    }
    out
}

/// Handles "1.e4" as well as "1. e4", and drops NAGs like $1.
fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.split_whitespace() {
        let digits_end = raw
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(raw.len());
        let mut s = raw;
        if digits_end > 0 {
            let rest = &raw[digits_end..];
            if let Some(after_dots) = rest.strip_prefix('.') {
                let dots_end = after_dots
                    .find(|c: char| c != '.')
                    .map(|i| i + 1)
                    .unwrap_or(rest.len());
                s = &rest[dots_end..];
            }
        }
        if s.is_empty() || s.starts_with('$') {
            continue;
        }
        out.push(s.to_string());
    }
    out
}

fn is_result_token(tok: &str) -> bool {
    matches!(tok, "1-0" | "0-1" | "1/2-1/2" | "*")
}

/// Leaves +/# alone; `from_san` accepts them.
fn strip_annotation_glyphs(tok: &str) -> String {
    tok.trim_end_matches(|c| c == '!' || c == '?').to_string()
}
