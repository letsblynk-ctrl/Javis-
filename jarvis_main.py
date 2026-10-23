"""Start Jarvis: web server + double-clap listener.

    python jarvis_main.py              server + clap listener (normal mode)
    python jarvis_main.py --no-clap    server only; open http://127.0.0.1:8340
    python jarvis_main.py --wake       run the startup sequence once right away
    python jarvis_main.py --calibrate  show microphone levels to tune clap.threshold
"""

import argparse
import threading
import time
import urllib.request

import uvicorn

from jarvis import actions
from jarvis.config import CONFIG_PATH, load_config


def wait_for_server(cfg: dict, timeout: float = 15) -> None:
    url = f"http://{cfg['host']}:{cfg['port']}/api/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except OSError:
            time.sleep(0.3)


def main() -> None:
    parser = argparse.ArgumentParser(description="Jarvis personal assistant")
    parser.add_argument("--no-clap", action="store_true", help="do not listen for claps")
    parser.add_argument("--wake", action="store_true", help="run the startup sequence immediately")
    parser.add_argument("--calibrate", action="store_true", help="print microphone levels while listening")
    args = parser.parse_args()

    if not CONFIG_PATH.exists():
        print("[jarvis] no config.json yet - run `python setup_wizard.py` first (using defaults for now).")
    cfg = load_config()

    from server import app  # imported here so config warnings print first

    server = uvicorn.Server(uvicorn.Config(app, host=cfg["host"], port=cfg["port"], log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    wait_for_server(cfg)
    print(f"[jarvis] online at http://{cfg['host']}:{cfg['port']}")

    if args.wake:
        actions.run_startup_sequence(cfg)

    try:
        if args.no_clap:
            while True:
                time.sleep(3600)
        else:
            from jarvis.clap import listen

            listen(cfg, lambda: actions.run_startup_sequence(cfg), calibrate=args.calibrate)
    except KeyboardInterrupt:
        print("\n[jarvis] shutting down.")


if __name__ == "__main__":
    main()
