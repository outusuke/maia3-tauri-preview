#!/usr/bin/env python3
"""
maia3_onnx_uci.py — Maia3 as a UCI engine, running on ONNX Runtime instead of
PyTorch. No torch dependency at runtime; only numpy, onnxruntime, and
python-chess. Reproduces the behavior of `maia3-uci --use-uci-history`
(tokenization, legal-move masking, temperature/top-p sampling, MultiPV WDL
scoring, and the UCI protocol subset it implements).

Requires a .onnx file produced by export_maia3_onnx.py, with I/O contract:
    tokens     float32 [batch, 64, 12*history]
    self_elos  float32 [batch]
    oppo_elos  float32 [batch]
  ->
    logits_move   float32 [batch, 4352]
    logits_value  float32 [batch, 3]   # [loss, draw, win] for the side to move

Usage (same shape as the original uci-wrapper.sh):
    python maia3_onnx_uci.py --onnx maia3-23m.onnx --history 8 --use-uci-history
"""

import argparse
import json
import sys
from collections import deque

import chess
import numpy as np
import onnxruntime as ort

# Move vocabulary; must match maia3.utils.get_all_possible_moves / mirror_move.

def get_all_possible_moves():
    all_moves = []
    for rank in range(8):
        for file in range(8):
            square = chess.square(file, rank)
            for target_rank in range(8):
                for target_file in range(8):
                    target_square = chess.square(target_file, target_rank)
                    all_moves.append(chess.square_name(square) + chess.square_name(target_square))

    promotions = []
    for file_from in "abcdefgh":
        for file_to in "abcdefgh":
            for piece in ["q", "r", "b", "n"]:
                promotions.append(f"{file_from}7{file_to}8{piece}")
    all_moves.extend(promotions)
    return all_moves


def mirror_square(square):
    file = square[0]
    rank = str(9 - int(square[1]))
    return file + rank


def mirror_move(move_uci):
    is_promotion = len(move_uci) > 4
    start_square, end_square = move_uci[:2], move_uci[2:4]
    promotion_piece = move_uci[4:] if is_promotion else ""
    return mirror_square(start_square) + mirror_square(end_square) + promotion_piece


# Tokenization: numpy port of maia3.dataset (no torch).

PIECE_MAP = {
    chess.PAWN: 1, chess.KNIGHT: 2, chess.BISHOP: 3,
    chess.ROOK: 4, chess.QUEEN: 5, chess.KING: 6,
}


def tokenize_board(board):
    tokens = np.zeros((64, 12), dtype=np.float32)
    if board.turn == chess.BLACK:
        board = board.mirror()
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece:
            mapped = PIECE_MAP[piece.piece_type]
            token = mapped + (6 if piece.color == chess.BLACK else 0)
            tokens[square][token - 1] = 1.0
    return tokens


def get_legal_moves_mask(board, all_moves_dict):
    mask = np.zeros((len(all_moves_dict),), dtype=bool)
    for legal_move in board.legal_moves:
        move_uci = legal_move.uci() if board.turn == chess.WHITE else mirror_move(legal_move.uci())
        idx = all_moves_dict.get(move_uci)
        if idx is not None:
            mask[idx] = True
    return mask


def get_historical_tokens(board_history, history_len):
    """(64, 12*history_len) float32 array, padded with the earliest position
    when history is short — same padding rule as the original engine."""
    hist = list(board_history)
    if len(hist) < history_len:
        hist = [hist[0]] * (history_len - len(hist)) + hist
    return np.concatenate(hist, axis=1)  # (64, 12*history_len)


# Sampling / WDL helpers: numpy port of maia3.uci.

def softmax(x, axis=-1):
    x = x - np.max(x, axis=axis, keepdims=True)
    e = np.exp(x)
    return e / np.sum(e, axis=axis, keepdims=True)


def sample_from_logits(logits, temperature, top_p, rng):
    if temperature <= 0:
        return int(np.argmax(logits))

    probs = softmax(logits / temperature)

    if top_p < 1.0:
        order = np.argsort(-probs)
        sorted_probs = probs[order]
        cumulative = np.cumsum(sorted_probs)
        # Uses the mass before each candidate so the move that crosses top_p is kept, not dropped.
        cumulative_before = cumulative - sorted_probs
        keep = cumulative_before < top_p
        keep[0] = True
        kept_probs = sorted_probs[keep]
        kept_idx = order[keep]
        kept_probs = kept_probs / kept_probs.sum()
        choice = rng.choice(len(kept_probs), p=kept_probs)
        return int(kept_idx[choice])

    return int(rng.choice(len(probs), p=probs))


def _probabilities_to_permille(probs):
    scaled = [max(0.0, float(p)) * 1000 for p in probs]
    ints = [int(v) for v in scaled]
    remainder = 1000 - sum(ints)
    order = sorted(range(len(scaled)), key=lambda i: scaled[i] - ints[i], reverse=True)
    for i in order[:max(0, remainder)]:
        ints[i] += 1
    return tuple(ints)


def wdl_from_value_logits(logits):
    loss, draw, win = softmax(logits.astype(np.float64)).tolist()
    return _probabilities_to_permille((win, draw, loss))


def invert_wdl(wdl):
    win, draw, loss = wdl
    return loss, draw, win


def cp_from_wdl(wdl):
    win, _draw, loss = wdl
    return win - loss


def clamp_multipv(value):
    return min(20, max(1, int(value)))


class Maia3ONNXEngine:
    def __init__(self, onnx_path, history, use_uci_history, elo, temperature, top_p, multipv, seed, threads=2):
        self.history_len = history
        self.use_uci_history = use_uci_history
        self.self_elo = elo
        self.oppo_elo = elo
        self.temperature = temperature
        self.top_p = top_p
        self.multipv = clamp_multipv(multipv)
        self.rng = np.random.default_rng(seed)

        self.all_moves = get_all_possible_moves()
        self.all_moves_dict = {m: i for i, m in enumerate(self.all_moves)}
        self.idx_to_move = {i: m for m, i in self.all_moves_dict.items()}

        so = ort.SessionOptions()
        # Keep intra-op threads modest; a dual-core box has no headroom for contention.
        so.intra_op_num_threads = threads
        # the arena never shrinks and was sitting near 1 GB after big estimate batches
        so.enable_cpu_mem_arena = False
        so.enable_mem_pattern = False
        self.session = ort.InferenceSession(onnx_path, sess_options=so,
                                             providers=["CPUExecutionProvider"])

        self.board = chess.Board()
        self.history = deque(maxlen=history)
        self.pending_bestmove = None
        self.pending_search = False
        self.game_start, self.game_moves = chess.Board(), []
        self._reset_history()

    def _reset_history(self):
        self.history.clear()
        self.history.append(tokenize_board(self.board))

    def _history_after_move(self, move):
        board = self.board.copy(stack=False)
        board.push(move)
        if self.use_uci_history:
            hist = deque(self.history, maxlen=self.history_len)
            hist.append(tokenize_board(board))
        else:
            hist = deque([tokenize_board(board)], maxlen=self.history_len)
        return hist

    def _tokens_from_history(self, history):
        return get_historical_tokens(history, self.history_len)

    def _move_from_index(self, idx):
        move_uci = self.idx_to_move[int(idx)]
        if self.board.turn == chess.BLACK:
            move_uci = mirror_move(move_uci)
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return None
        if move not in self.board.legal_moves:
            return None
        return move

    def _run(self, tokens_batch, self_elos, oppo_elos):
        out = self.session.run(None, {
            "tokens": tokens_batch.astype(np.float32),
            "self_elos": self_elos.astype(np.float32),
            "oppo_elos": oppo_elos.astype(np.float32),
        })
        return out[0], out[1]

    def score_moves(self):
        if self.board.is_game_over():
            return None, []

        legal_mask = get_legal_moves_mask(self.board, self.all_moves_dict)
        if not legal_mask.any():
            return None, []

        tokens = self._tokens_from_history(self.history)[np.newaxis, :, :]  # (1,64,H)
        self_elos = np.array([self.self_elo], dtype=np.float32)
        oppo_elos = np.array([self.oppo_elo], dtype=np.float32)

        logits_move, _logits_value = self._run(tokens, self_elos, oppo_elos)
        logits = logits_move[0].astype(np.float64)
        logits[~legal_mask] = -np.inf

        idx = sample_from_logits(logits, self.temperature, self.top_p, self.rng)
        move = self._move_from_index(idx)

        probs = softmax(logits)
        top_count = min(self.multipv, int(legal_mask.sum()))
        top_idxs = np.argpartition(-probs, top_count - 1)[:top_count]
        top_idxs = top_idxs[np.argsort(-probs[top_idxs])]

        top_moves = []
        for top_idx in top_idxs.tolist():
            top_move = self._move_from_index(top_idx)
            if top_move is not None:
                top_moves.append({"move": top_move, "policy": float(probs[top_idx]), "wdl": (0, 1000, 0)})

        if top_moves:
            candidate_tokens = np.stack([
                self._tokens_from_history(self._history_after_move(item["move"]))
                for item in top_moves
            ])
            # After our move it's the opponent's turn: swap elos, score from their side, then invert the WDL (same as the original engine).
            cand_self = np.full((len(top_moves),), self.oppo_elo, dtype=np.float32)
            cand_oppo = np.full((len(top_moves),), self.self_elo, dtype=np.float32)
            _move_logits, value_logits = self._run(candidate_tokens, cand_self, cand_oppo)
            for item, vl in zip(top_moves, value_logits):
                item["wdl"] = invert_wdl(wdl_from_value_logits(vl))

        return move, top_moves


    def cmd_insights(self, line):
        # Softmax over legal moves at each Elo (temperature 1, no top-p), whatever the play options are.
        try:
            elos = [int(x) for x in line.split()[1:]]
        except ValueError:
            elos = []
        legal_mask = None if self.board.is_game_over() else get_legal_moves_mask(self.board, self.all_moves_dict)
        if not elos or legal_mask is None or not legal_mask.any():
            print("insights " + json.dumps({"ratings": elos, "policies": [], "winProb": []}), flush=True)
            return

        n = len(elos)
        tokens = self._tokens_from_history(self.history)[np.newaxis, :, :]
        tokens = np.repeat(tokens, n, axis=0)
        elo_arr = np.array(elos, dtype=np.float32)
        logits_move, logits_value = self._run(tokens, elo_arr, elo_arr)

        legal_idxs = np.flatnonzero(legal_mask)
        ucis = []
        for idx in legal_idxs:
            mv = self._move_from_index(idx)
            ucis.append(mv.uci() if mv is not None else None)

        policies, win_prob = [], []
        for i in range(n):
            legal_logits = logits_move[i].astype(np.float64)[legal_idxs]
            probs = softmax(legal_logits)
            # Tail pruned to keep the payload small.
            policies.append({u: round(float(p), 5) for u, p in zip(ucis, probs) if u is not None and p >= 0.0005})
            loss, draw, win = softmax(logits_value[i].astype(np.float64)).tolist()
            win_prob.append(round(win + 0.5 * draw, 4))

        print("insights " + json.dumps({"ratings": elos, "policies": policies, "winProb": win_prob}), flush=True)

    def cmd_estimate(self, line):
        # `estimate P1,P2,... elo...`: log-prob of the move actually played at each listed ply, once per Elo.
        try:
            parts = line.split()
            wanted = [int(x) for x in parts[1].split(",") if x]
            elos = [int(x) for x in parts[2:]]
        except (ValueError, IndexError):
            wanted, elos = [], []
        if not elos:
            print("estimate " + json.dumps({"plies": []}), flush=True)
            return

        board = self.game_start.copy(stack=False)
        boards, toks = [board.copy(stack=False)], [tokenize_board(board)]
        for mv in self.game_moves:
            board.push_uci(mv)
            boards.append(board.copy(stack=False))
            toks.append(tokenize_board(board))

        entries = []
        for i in (w for w in wanted if 0 <= w < len(self.game_moves)):
            b = boards[i]
            if b.legal_moves.count() < 2:
                continue
            uci = self.game_moves[i] if b.turn == chess.WHITE else mirror_move(self.game_moves[i])
            played = self.all_moves_dict.get(uci)
            mask = get_legal_moves_mask(b, self.all_moves_dict)
            if played is None or not mask[played]:
                continue
            hist = toks[max(0, i - self.history_len + 1):i + 1] if self.use_uci_history else [toks[i]]
            legal_idxs = np.flatnonzero(mask)
            entries.append((i, get_historical_tokens(hist, self.history_len), legal_idxs, int(np.searchsorted(legal_idxs, played))))

        n = len(elos)
        elo_arr = np.array(elos, dtype=np.float32)
        out = []
        per_run = max(1, 64 // n)
        for start in range(0, len(entries), per_run):
            chunk = entries[start:start + per_run]
            tokens = np.repeat(np.stack([e[1] for e in chunk]), n, axis=0)
            logits, _ = self._run(tokens, np.tile(elo_arr, len(chunk)), np.tile(elo_arr, len(chunk)))
            logits = logits.reshape(len(chunk), n, -1).astype(np.float64)
            for k, (ply, _, legal_idxs, local) in enumerate(chunk):
                legal = logits[k][:, legal_idxs]
                peak = legal.max(axis=1, keepdims=True)
                logp = legal[:, local] - (peak[:, 0] + np.log(np.exp(legal - peak).sum(axis=1)))
                out.append({"ply": ply, "logp": [round(float(x), 4) for x in logp]})

        print("estimate " + json.dumps({"plies": out}), flush=True)

    # -- UCI protocol --

    def cmd_uci(self):
        print("id name Maia3-ONNX")
        print("id author CSSLab (ONNX Runtime port)")
        print(f"option name Elo type spin default {self.self_elo} min 0 max 5000")
        print(f"option name SelfElo type spin default {self.self_elo} min 0 max 5000")
        print(f"option name OppoElo type spin default {self.oppo_elo} min 0 max 5000")
        print(f"option name Temperature type string default {self.temperature}")
        print(f"option name TopP type string default {self.top_p}")
        print(f"option name MultiPV type spin default {self.multipv} min 1 max 20")
        print("uciok", flush=True)

    def cmd_setoption(self, line):
        try:
            after_name = line.split("name", 1)[1].strip()
            name, _, value = after_name.partition("value")
            name, value = name.strip().lower(), value.strip()
        except (IndexError, ValueError):
            return
        try:
            if name == "elo":
                self.self_elo = self.oppo_elo = int(value)
            elif name == "selfelo":
                self.self_elo = int(value)
            elif name == "oppoelo":
                self.oppo_elo = int(value)
            elif name == "temperature":
                self.temperature = float(value)
            elif name == "topp":
                self.top_p = float(value)
            elif name == "multipv":
                self.multipv = clamp_multipv(value)
        except ValueError:
            return

    def cmd_ucinewgame(self):
        self.board = chess.Board()
        self.pending_bestmove = None
        self.pending_search = False
        self._reset_history()

    def cmd_position(self, line):
        tokens = line.split()
        if len(tokens) < 2:
            return
        i = 1
        if tokens[i] == "startpos":
            board = chess.Board()
            i += 1
        elif tokens[i] == "fen":
            if len(tokens) < i + 7:
                return
            try:
                board = chess.Board(" ".join(tokens[i + 1:i + 7]))
            except ValueError:
                return
            i += 7
        else:
            return

        moves = tokens[i + 1:] if i < len(tokens) and tokens[i] == "moves" else []
        start_board = board.copy()
        self.pending_bestmove = None
        self.pending_search = False

        if self.use_uci_history:
            new_history = deque(maxlen=self.history_len)
            replay = board.copy()
            new_history.append(tokenize_board(replay))
            for mv in moves:
                try:
                    move = chess.Move.from_uci(mv)
                    if move not in replay.legal_moves:
                        return
                    replay.push(move)
                except ValueError:
                    return
                new_history.append(tokenize_board(replay))
            self.board, self.history = replay, new_history
        else:
            for mv in moves:
                try:
                    move = chess.Move.from_uci(mv)
                    if move not in board.legal_moves:
                        return
                    board.push(move)
                except ValueError:
                    return
            self.board = board
            self._reset_history()
        self.game_start, self.game_moves = start_board, moves

    def cmd_go(self, line):
        move, top_moves = self.score_moves()
        for rank, item in enumerate(top_moves, start=1):
            win, draw, loss = item["wdl"]
            cp = cp_from_wdl(item["wdl"])
            print(f"info depth 1 multipv {rank} score cp {cp} wdl {win} {draw} {loss} "
                  f"pv {item['move'].uci()}", flush=True)

        if "infinite" in line.split():
            self.pending_bestmove, self.pending_search = move, True
            return
        self.print_bestmove(move)

    def cmd_stop(self):
        if not self.pending_search:
            return
        self.print_bestmove(self.pending_bestmove)
        self.pending_bestmove, self.pending_search = None, False

    def print_bestmove(self, move):
        print(f"bestmove {move.uci() if move else '0000'}", flush=True)

    def run(self):
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            cmd = line.split()[0]
            if line == "uci":
                self.cmd_uci()
            elif line == "isready":
                print("readyok", flush=True)
            elif line == "ucinewgame":
                self.cmd_ucinewgame()
            elif cmd == "position":
                self.cmd_position(line)
            elif cmd == "go":
                self.cmd_go(line)
            elif cmd == "insights":
                self.cmd_insights(line)
            elif cmd == "estimate":
                self.cmd_estimate(line)
            elif cmd == "setoption":
                self.cmd_setoption(line)
            elif line == "quit":
                return
            elif line == "stop":
                self.cmd_stop()


def main():
    p = argparse.ArgumentParser(description="Run Maia3 (ONNX) as a UCI engine.")
    p.add_argument("--onnx", required=True, help="Path to the exported .onnx file")
    p.add_argument("--history", type=int, default=8)
    p.add_argument("--use-uci-history", action="store_true", default=False)
    p.add_argument("--elo", type=int, default=1500)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--top-p", dest="top_p", type=float, default=1.0)
    p.add_argument("--multipv", type=int, default=5)
    p.add_argument("--seed", type=int, default=None,
                    help="RNG seed for temperature sampling. Omit for a fresh, "
                         "OS-entropy seed each run; pass a value to reproduce a "
                         "specific game.")
    p.add_argument("--threads", type=int, default=2)
    args = p.parse_args()

    engine = Maia3ONNXEngine(
        onnx_path=args.onnx, history=args.history, use_uci_history=args.use_uci_history,
        elo=args.elo, temperature=args.temperature, top_p=args.top_p,
        multipv=args.multipv, seed=args.seed, threads=args.threads,
    )
    engine.run()


if __name__ == "__main__":
    main()
