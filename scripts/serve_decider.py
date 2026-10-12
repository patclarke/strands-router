"""Serve Strands Decider with every model call on one thread, warmed up before it listens.

`strands-decider serve` answers each request on whichever FastAPI worker thread is free. On
an Apple-silicon Mac that crashed the server (segfault) on its second request, while the same
model and requests ran fine when every call stayed on one thread (`decider.sh diagnose`).
This wrapper builds the stock app, then routes model loading and every evaluation through a
single dedicated thread. It also runs a throwaway question first, so the one-off GPU warm-up
(35 s measured) is paid at startup instead of by the first routed prompt.

    python serve_decider.py CHECKPOINT [--host H] [--port P] [--device D] [--no-prefix-cache]
"""

from __future__ import annotations

import argparse
import time
from concurrent.futures import ThreadPoolExecutor


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--device", default=None)
    parser.add_argument("--no-prefix-cache", action="store_true")
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
    engine.evaluate = lambda request: on_model_thread(evaluate, request)

    started = time.perf_counter()
    engine.evaluate(SystemOneRequest.model_validate({
        "state": "rename the variable usr to user",
        "questions": {
            "model": {"type": "choice", "instructions": "Which model should handle this?",
                      "criteria": {"fast": "Trivial work.", "strong": "Hard work."}},
            "scale": {"type": "score", "instructions": "How hard is it?",
                      "criteria": ["easy", "medium", "hard"]},
        },
    }))
    print(f"[strands-router] warmed up in {time.perf_counter() - started:.1f}s", flush=True)

    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
