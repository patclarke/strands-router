"""Serve Strands Decider with every model call on one thread, warmed up before it listens.

`strands-decider serve` answers each request on whichever FastAPI worker thread is free. On
an Apple-silicon Mac that crashed the server (segfault) on its second request, while the same
model and requests ran fine when every call stayed on one thread (`decider.sh diagnose`).
This wrapper builds the stock app, then routes model loading and every evaluation through a
single dedicated thread. It also runs a throwaway question first, so the one-off GPU warm-up
(35 s measured) is paid at startup instead of by the first routed prompt.

The model also goes cold when idle: measured on an Apple-silicon Mac, a question took 1 s right
after another but 11-14 s after a few idle minutes, past the router's deadline, and coding turns
are usually minutes apart. So while idle, a tiny question runs every --keep-warm seconds to keep
the weights resident and the GPU awake (0 disables it).

    python serve_decider.py CHECKPOINT [--host H] [--port P] [--device D] [--no-prefix-cache]
                                       [--keep-warm SECONDS]
"""

from __future__ import annotations

import argparse
import threading
import time
from concurrent.futures import ThreadPoolExecutor

WARM_REQUEST = {
    "state": "rename the variable usr to user",
    "questions": {
        "model": {"type": "choice", "instructions": "Which model should handle this?",
                  "criteria": {"fast": "Trivial work.", "strong": "Hard work."}},
        "scale": {"type": "score", "instructions": "How hard is it?",
                  "criteria": ["easy", "medium", "hard"]},
    },
}


def keep_warm(evaluate, request, interval: float, last_used: list[float], stop: threading.Event) -> None:
    """Run `request` whenever the server has been idle for `interval` seconds."""
    while not stop.wait(interval / 4):
        if time.monotonic() - last_used[0] >= interval:
            try:
                evaluate(request)
            except Exception as exc:  # a failed ping must never take the server down
                print(f"[strands-router] keep-warm failed: {exc}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--device", default=None)
    parser.add_argument("--no-prefix-cache", action="store_true")
    parser.add_argument("--keep-warm", type=float, default=20.0)
    args = parser.parse_args()

    import uvicorn
    from strands_decider import server
    from strands_decider.cli import _auto_device
    from strands_decider.schema import SystemOneRequest

    device = args.device or _auto_device()
    model_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="decider-model")
    on_model_thread = lambda fn, *a, **kw: model_thread.submit(fn, *a, **kw).result()  # noqa: E731

    print(f"[strands-router] loading {args.checkpoint} on {device}", flush=True)
    app = on_model_thread(
        server.create_app, args.checkpoint, device=device,
        use_prefix_cache=not args.no_prefix_cache,
    )
    engine = server.get_engine()
    evaluate = engine.evaluate
    last_used = [time.monotonic()]

    def evaluate_on_model_thread(request):
        try:
            return on_model_thread(evaluate, request)
        finally:
            last_used[0] = time.monotonic()

    engine.evaluate = evaluate_on_model_thread

    warm = SystemOneRequest.model_validate(WARM_REQUEST)
    started = time.perf_counter()
    engine.evaluate(warm)
    print(f"[strands-router] warmed up in {time.perf_counter() - started:.1f}s", flush=True)

    if args.keep_warm > 0:
        threading.Thread(
            target=keep_warm, args=(engine.evaluate, warm, args.keep_warm, last_used, threading.Event()),
            name="decider-keep-warm", daemon=True,
        ).start()
        print(f"[strands-router] keeping the model warm when idle for {args.keep_warm:g}s", flush=True)

    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
