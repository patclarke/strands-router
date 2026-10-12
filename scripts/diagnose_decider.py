"""Find a Strands Decider configuration that runs the router's request on this machine.

Each configuration runs in its own subprocess, so a native crash (a segfault in a GPU
kernel, say) is reported for that row and the others still run. Prints one table and a
recommendation. Run through `scripts/decider.sh diagnose`, which supplies the request the
router actually sends.

    python diagnose_decider.py CHECKPOINT REQUEST_JSON
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time

# (label, device, use_prefix_cache, request kind, repeats, timeout seconds)
CONFIGS = [
    ("mps, 1 question", "mps", True, "single", 3, 300),
    ("mps, router request, prefix cache", "mps", True, "router", 3, 300),
    ("mps, router request, no prefix cache", "mps", False, "router", 3, 300),
    ("cpu, router request, prefix cache", "cpu", True, "router", 2, 600),
]


def child(checkpoint: str, request_path: str, device: str, prefix: bool, kind: str, repeats: int) -> None:
    import faulthandler

    faulthandler.enable()
    from strands_decider.infer import load_engine
    from strands_decider.schema import SystemOneRequest

    with open(request_path) as f:
        request = json.load(f)
    if kind == "single":
        request["questions"] = {"model": request["questions"]["model"]}
    parsed = SystemOneRequest.model_validate(request)

    started = time.perf_counter()
    engine = load_engine(checkpoint, device=device, use_prefix_cache=prefix)
    load_s = time.perf_counter() - started
    times = []
    answer = None
    for _ in range(repeats):
        t = time.perf_counter()
        out = engine.evaluate(parsed)
        times.append(round((time.perf_counter() - t) * 1000))
        answer = out.answers["model"]
    print(json.dumps({"load_s": round(load_s, 1), "ms": times,
                      "choice": answer.choice, "confidence": answer.confidence}), flush=True)


def main() -> None:
    checkpoint, request_path = sys.argv[1], sys.argv[2]
    import torch
    import transformers

    print(f"python {platform.python_version()}  torch {torch.__version__}  "
          f"transformers {transformers.__version__}  macOS {platform.mac_ver()[0] or '-'}  "
          f"mps available: {torch.backends.mps.is_available()}\n", flush=True)

    rows = []
    for label, device, prefix, kind, repeats, timeout in CONFIGS:
        print(f"... {label}", flush=True)
        cmd = [sys.executable, __file__, "--child", checkpoint, request_path,
               device, "1" if prefix else "0", kind, str(repeats)]
        env = {**os.environ, "PYTHONFAULTHANDLER": "1"}
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            rows.append((label, f"TIMEOUT after {timeout}s", ""))
            continue
        result = next((json.loads(line) for line in proc.stdout.splitlines()
                       if line.startswith("{")), None)
        if proc.returncode == 0 and result:
            first, *rest = result["ms"]
            warm = f"warm {min(rest)}-{max(rest)} ms" if rest else ""
            rows.append((label, "OK",
                         f"first {first} ms, {warm}; -> {result['choice']} "
                         f"(conf {result['confidence']:.2f}); load {result['load_s']}s"))
        else:
            why = (f"CRASH (signal {-proc.returncode})" if proc.returncode < 0
                   else f"FAILED (exit {proc.returncode})")
            tail = "\n".join(proc.stderr.strip().splitlines()[-25:])
            rows.append((label, why, tail))

    print("\n=== results ===")
    for label, status, detail in rows:
        print(f"{label:40} {status}")
        if detail:
            for line in detail.splitlines():
                print(f"    {line}")

    ok = {label for label, status, _ in rows if status == "OK"}
    print("\n=== recommendation ===")
    if "mps, router request, prefix cache" in ok:
        print("Default settings work: scripts/decider.sh serve")
    elif "mps, router request, no prefix cache" in ok:
        print("Use: STRANDS_DECIDER_PREFIX_CACHE=0 scripts/decider.sh serve")
    elif "cpu, router request, prefix cache" in ok:
        print("Only CPU works here: STRANDS_DECIDER_DEVICE=cpu scripts/decider.sh serve (slow)")
    else:
        print("No configuration ran the router request; paste this whole output.")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        _, _, ckpt, req, dev, pre, kind, reps = sys.argv
        child(ckpt, req, dev, pre == "1", kind, int(reps))
    else:
        main()
