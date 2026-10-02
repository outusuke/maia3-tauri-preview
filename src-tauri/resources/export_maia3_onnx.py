#!/usr/bin/env python3
"""
export_maia3_onnx.py — one-time conversion of a Maia3 checkpoint to ONNX.

Run this ONCE, inside the same venv build.sh already creates (the one that
has torch + the `maia3` package installed). It does not run on every game —
only when you need to (re)produce the .onnx file.

Usage:
    python export_maia3_onnx.py --model maia3-23m --output maia3-23m.onnx --validate

Output: a single .onnx file with this I/O contract:
    inputs:
      tokens     float32 [batch, 64, 12*history]   # board history, piece-only one-hot
      self_elos  float32 [batch]
      oppo_elos  float32 [batch]
    outputs:
      logits_move   float32 [batch, 4352]
      logits_value  float32 [batch, 3]              # [loss, draw, win]

`batch` is dynamic, so the same file can score 1 position (bestmove) or several
at once (MultiPV candidate WDL scoring), exactly like maia3_onnx_uci.py does.
"""

import argparse
import sys

import torch
import torch.nn as nn
from torch.nn import RMSNorm

from maia3.model_registry import (
    apply_model_config,
    resolve_checkpoint_path,
    resolve_model_spec,
)
from maia3.models import MAIA3Model


class _DecomposedRMSNorm(nn.Module):
    """Drop-in replacement for torch.nn.RMSNorm using only primitive ops.

    The ONNX opset used here doesn't support the fused aten::rms_norm op, so
    we decompose it the same way before export (numerically identical to
    within float32 rounding — verified against torch.nn.RMSNorm directly)."""

    def __init__(self, rmsnorm: RMSNorm):
        super().__init__()
        self.weight = rmsnorm.weight
        self.eps = rmsnorm.eps if rmsnorm.eps is not None else torch.finfo(torch.float32).eps

    def forward(self, x):
        variance = x.pow(2).mean(-1, keepdim=True)
        x = x * torch.rsqrt(variance + self.eps)
        return x * self.weight


def _decompose_rms_norms(module: nn.Module):
    """Recursively swap every nn.RMSNorm submodule for the decomposed version."""
    for name, child in list(module.named_children()):
        if isinstance(child, RMSNorm):
            setattr(module, name, _DecomposedRMSNorm(child))
        else:
            _decompose_rms_norms(child)


class ExportWrapper(nn.Module):
    """Thin wrapper so the exported graph only has the two heads we use
    (drops the ponder/timing head, which UCI play/analysis never needs)."""

    def __init__(self, model: MAIA3Model):
        super().__init__()
        _decompose_rms_norms(model)  # aten::rms_norm has no ONNX opset-17 mapping
        self.model = model

    def forward(self, tokens, self_elos, oppo_elos):
        logits_move, logits_value, _logits_ponder = self.model(tokens, self_elos, oppo_elos)
        return logits_move, logits_value


def load_pytorch_model(model_alias: str, checkpoint_path: str | None, device: str):
    class _Cfg:
        pass

    cfg = _Cfg()
    spec = resolve_model_spec(model_alias)
    apply_model_config(cfg, spec)
    cfg.device = device
    cfg.trust_checkpoint = False
    cfg.checkpoint_path = checkpoint_path or resolve_checkpoint_path(spec)

    model = MAIA3Model(cfg).to(device)
    ckpt = torch.load(cfg.checkpoint_path, map_location=device, weights_only=True)
    state_dict = ckpt["model_state_dict"] if isinstance(ckpt, dict) and "model_state_dict" in ckpt else ckpt
    state_dict = {k.replace("smolgen", "gab"): v for k, v in state_dict.items()}
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    if missing:
        print(f"warning: missing keys: {missing[:5]}", file=sys.stderr)
    if unexpected:
        print(f"warning: unexpected keys: {unexpected[:5]}", file=sys.stderr)
    model.eval()
    return model, cfg


def main():
    parser = argparse.ArgumentParser(description="Export a Maia3 checkpoint to ONNX.")
    parser.add_argument("--model", required=True, help="Built-in alias, e.g. maia3-23m")
    parser.add_argument("--checkpoint", default=None, help="Optional local .pt path; otherwise downloaded from HF")
    parser.add_argument("--output", required=True, help="Output .onnx path")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--validate", action="store_true",
                         help="Run a parity check between PyTorch and the exported ONNX graph")
    args = parser.parse_args()

    print(f"==> Loading PyTorch checkpoint for {args.model} ...")
    model, cfg = load_pytorch_model(args.model, args.checkpoint, device="cpu")
    wrapper = ExportWrapper(model)

    history_dim = 12 * cfg.history  # include_time_info is False for all built-in sizes
    dummy_tokens = torch.zeros(1, 64, history_dim, dtype=torch.float32)
    dummy_self_elo = torch.tensor([1500.0], dtype=torch.float32)
    dummy_oppo_elo = torch.tensor([1500.0], dtype=torch.float32)

    print(f"==> Exporting to {args.output} (opset {args.opset}) ...")
    torch.onnx.export(
        wrapper,
        (dummy_tokens, dummy_self_elo, dummy_oppo_elo),
        args.output,
        input_names=["tokens", "self_elos", "oppo_elos"],
        output_names=["logits_move", "logits_value"],
        dynamic_axes={
            "tokens": {0: "batch"},
            "self_elos": {0: "batch"},
            "oppo_elos": {0: "batch"},
            "logits_move": {0: "batch"},
            "logits_value": {0: "batch"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
        dynamo=False,  # avoid requiring the onnxscript package on torch >= 2.9
    )
    print(f"==> Wrote {args.output}")

    if args.validate:
        print("==> Validating ONNX Runtime output against PyTorch ...")
        import numpy as np
        import onnxruntime as ort
        import chess
        import random

        from maia3.dataset import tokenize_board, get_historical_tokens
        from collections import deque

        sess = ort.InferenceSession(args.output, providers=["CPUExecutionProvider"])

        random.seed(0)
        max_move_diff = 0.0
        max_value_diff = 0.0
        for trial in range(20):
            board = chess.Board()
            for _ in range(random.randint(0, 20)):
                if board.is_game_over():
                    break
                board.push(random.choice(list(board.legal_moves)))

            hist = deque([tokenize_board(board)], maxlen=cfg.history)
            tokens = get_historical_tokens(hist, cfg, base=0.0, inc=0.0,
                                            clk_left_before=0.0, clk_ponder=0.0)
            tokens = tokens[:, :history_dim].unsqueeze(0)  # (1, 64, history_dim)
            self_elo = torch.tensor([1500.0])
            oppo_elo = torch.tensor([1600.0])

            with torch.no_grad():
                pt_move, pt_value = wrapper(tokens, self_elo, oppo_elo)

            ort_out = sess.run(None, {
                "tokens": tokens.numpy().astype(np.float32),
                "self_elos": self_elo.numpy().astype(np.float32),
                "oppo_elos": oppo_elo.numpy().astype(np.float32),
            })
            ort_move, ort_value = ort_out

            move_diff = float(np.abs(pt_move.numpy() - ort_move).max())
            value_diff = float(np.abs(pt_value.numpy() - ort_value).max())
            max_move_diff = max(max_move_diff, move_diff)
            max_value_diff = max(max_value_diff, value_diff)

        print(f"    max |PyTorch - ONNX| over 20 random positions: "
              f"move_logits={max_move_diff:.2e}, value_logits={max_value_diff:.2e}")
        if max_move_diff > 1e-2 or max_value_diff > 1e-2:
            print("    WARNING: difference looks larger than expected float32 export noise.",
                  file=sys.stderr)
        else:
            print("    OK — matches PyTorch to within normal float32 export tolerance.")


if __name__ == "__main__":
    main()
