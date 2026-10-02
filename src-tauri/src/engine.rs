use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use crate::setup::NoWindow;

/// One `go depth N` result line. Scores are from the side to move's perspective.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PvLine {
    pub multipv: u32,
    pub depth: u32,
    pub score_cp: Option<i32>,
    /// Signed: positive means the side to move mates.
    pub mate: Option<i32>,
    pub pv: Vec<String>,
}

fn parse_info_line(line: &str) -> Option<PvLine> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut multipv = 1u32;
    let mut depth = 0u32;
    let mut score_cp = None;
    let mut mate = None;
    let mut pv: Vec<String> = Vec::new();

    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "multipv" => {
                multipv = tokens.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            "depth" => {
                depth = tokens.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(0);
                i += 2;
            }
            "score" => match tokens.get(i + 1).copied() {
                Some("cp") => {
                    score_cp = tokens.get(i + 2).and_then(|s| s.parse().ok());
                    i += 3;
                }
                Some("mate") => {
                    mate = tokens.get(i + 2).and_then(|s| s.parse().ok());
                    i += 3;
                }
                _ => i += 1,
            },
            "pv" => {
                pv = tokens[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => i += 1,
        }
    }

    // Mated/stalemated positions come back as `depth 0` with a score but no pv.
    let terminal = depth == 0 && (score_cp.is_some() || mate.is_some());
    if pv.is_empty() && !terminal {
        None
    } else {
        Some(PvLine {
            multipv,
            depth,
            score_cp,
            mate,
            pv,
        })
    }
}

/// Generic UCI client: Maia-3's console scripts speak plain UCI, same as Stockfish.
pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
}

impl Engine {
    pub fn spawn(command: &str, args: &[String]) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .no_window()
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // A release build on Windows has no console, so there's no stderr to inherit.
            .stderr(if cfg!(all(windows, not(debug_assertions))) {
                Stdio::null()
            } else {
                Stdio::inherit()
            })
            .spawn()
            .map_err(|e| format!("failed to launch '{command}': {e}"))?;

        eprintln!("[engine] started pid {}: {command}", child.id());
        let stdin = child.stdin.take().ok_or("no stdin handle")?;
        let stdout = child.stdout.take().ok_or("no stdout handle")?;

        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut engine = Engine { child, stdin, rx };

        engine.send("uci")?;
        // Should answer before the checkpoint loads.
        if engine.wait_for("uciok", Duration::from_secs(15)).is_none() {
            return Err("engine did not respond to 'uci' (uciok not received)".into());
        }

        engine.send("isready")?;
        // Slow: the checkpoint may need to download or load from disk on first use.
        if engine
            .wait_for("readyok", Duration::from_secs(180))
            .is_none()
        {
            return Err(
                "engine did not respond to 'isready' - it may still be downloading the model"
                    .into(),
            );
        }

        Ok(engine)
    }

    pub fn send(&mut self, line: &str) -> Result<(), String> {
        writeln!(self.stdin, "{line}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    pub fn wait_for(&self, prefix: &str, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(line) => {
                    if line.starts_with(prefix) {
                        return Some(line);
                    }
                }
                Err(_) => return None,
            }
        }
    }

    /// Elo applies to both sides; Maia-3 also has SelfElo and OppoElo options.
    pub fn set_elo(&mut self, elo: u32) -> Result<(), String> {
        self.send(&format!("setoption name Elo value {elo}"))
    }

    /// `go nodes 1` on purpose: Maia is a single forward pass, so a deeper search wouldn't change its move.
    /// Takes the whole game, not just the current fen, so --use-uci-history has real moves to replay.
    pub fn best_move(&mut self, start_fen: &str, moves: &[String], timeout: Duration) -> Result<String, String> {
        self.send(&position_command(start_fen, moves))?;
        self.send("go nodes 1")?;
        let line = self
            .wait_for("bestmove", timeout)
            .ok_or("timed out waiting for bestmove")?;
        line.split_whitespace()
            .nth(1)
            .map(|s| s.to_string())
            .ok_or_else(|| format!("could not parse bestmove line: {line}"))
    }

    pub fn set_multipv(&mut self, n: u32) -> Result<(), String> {
        self.send(&format!("setoption name MultiPV value {n}"))
    }

    /// Fixed-depth search for Stockfish-style engines; keeps the latest info line per multipv index until bestmove.
    pub fn analyze(
        &mut self,
        fen: &str,
        depth: u32,
        multipv: u32,
        timeout: Duration,
    ) -> Result<Vec<PvLine>, String> {
        self.set_multipv(multipv.max(1))?;
        self.send(&format!("position fen {}", uci_fen(fen)))?;
        self.send(&format!("go depth {depth}"))?;
        self.read_search(timeout)
    }

    /// `searchmoves` so a human-likely blunder still gets a real eval instead of dropping off a top-N list.
    pub fn analyze_candidates(
        &mut self,
        fen: &str,
        depth: u32,
        candidates: &[String],
        timeout: Duration,
    ) -> Result<Vec<PvLine>, String> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        self.set_multipv(candidates.len() as u32)?;
        self.send(&format!("position fen {}", uci_fen(fen)))?;
        self.send(&format!(
            "go depth {depth} searchmoves {}",
            candidates.join(" ")
        ))?;
        self.read_search(timeout)
    }

    /// Log-probability of the move actually played at each of `plies`, one entry per requested rating.
    pub fn maia_estimate(
        &mut self,
        start_fen: &str,
        moves: &[String],
        plies: &[usize],
        ratings: &[u32],
        timeout: Duration,
    ) -> Result<Vec<PlyLogProbs>, String> {
        self.send(&position_command(start_fen, moves))?;
        let list: Vec<String> = ratings.iter().map(|r| r.to_string()).collect();
        let wanted: Vec<String> = plies.iter().map(|p| p.to_string()).collect();
        self.send(&format!("estimate {} {}", wanted.join(","), list.join(" ")))?;
        let line = self
            .wait_for("estimate ", timeout)
            .ok_or("timed out waiting for the rating estimate (is the engine an older maia3_onnx_uci.py?)")?;
        let parsed: EstimateReply = serde_json::from_str(&line["estimate ".len()..])
            .map_err(|e| format!("could not parse rating estimate: {e}"))?;
        Ok(parsed.plies)
    }

    fn read_search(&mut self, timeout: Duration) -> Result<Vec<PvLine>, String> {
        let deadline = Instant::now() + timeout;
        let mut lines: HashMap<u32, PvLine> = HashMap::new();

        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err("timed out waiting for analysis".into());
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(line) => {
                    if line.starts_with("bestmove") {
                        break;
                    } else if line.starts_with("info") {
                        if let Some(pv) = parse_info_line(&line) {
                            lines.insert(pv.multipv, pv);
                        }
                    }
                }
                Err(_) => return Err("engine closed unexpectedly during analysis".into()),
            }
        }

        if lines.is_empty() {
            return Err("engine returned no analysis lines".into());
        }
        let mut result: Vec<PvLine> = lines.into_values().collect();
        result.sort_by_key(|l| l.multipv);
        Ok(result)
    }

    /// Needs the `insights` command from our maia3_onnx_uci.py; sends the whole game so the 8-ply history is real.
    pub fn maia_insights(
        &mut self,
        start_fen: &str,
        moves: &[String],
        ratings: &[u32],
        timeout: Duration,
    ) -> Result<MaiaInsights, String> {
        self.send(&position_command(start_fen, moves))?;
        let list: Vec<String> = ratings.iter().map(|r| r.to_string()).collect();
        self.send(&format!("insights {}", list.join(" ")))?;
        let line = self
            .wait_for("insights ", timeout)
            .ok_or("timed out waiting for Maia insights (is the engine an older maia3_onnx_uci.py?)")?;
        serde_json::from_str(&line["insights ".len()..])
            .map_err(|e| format!("could not parse Maia insights: {e}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlyLogProbs {
    pub ply: usize,
    pub logp: Vec<f64>,
}

#[derive(Deserialize)]
struct EstimateReply {
    plies: Vec<PlyLogProbs>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaiaInsights {
    pub ratings: Vec<u32>,
    pub policies: Vec<HashMap<String, f64>>,
    /// Side to move's expected score (win + draw/2).
    pub win_prob: Vec<f64>,
}

impl Drop for Engine {
    fn drop(&mut self) {
        eprintln!("[engine] stopping pid {}", self.child.id());
        let _ = self.send("quit");
        std::thread::sleep(Duration::from_millis(50));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The chess crate writes the en passant square as the pawn's square (d4); UCI engines want the target (d3) and ignore anything else.
fn uci_fen(fen: &str) -> String {
    let mut fields: Vec<String> = fen.split_whitespace().map(String::from).collect();
    if fields.len() >= 4 && fields[3].len() == 2 {
        let rank = if fields[1] == "w" { '6' } else { '3' };
        fields[3] = format!("{}{}", &fields[3][..1], rank);
    }
    fields.join(" ")
}

fn position_command(start_fen: &str, moves: &[String]) -> String {
    let fen = uci_fen(start_fen);
    if moves.is_empty() {
        format!("position fen {fen}")
    } else {
        format!("position fen {fen} moves {}", moves.join(" "))
    }
}
