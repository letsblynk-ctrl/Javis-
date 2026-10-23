"""Loads config.json (falling back to config.example.json defaults)."""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_PATH = ROOT / "config.example.json"


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    defaults = json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))
    # The example file contains placeholder paths; never launch those.
    defaults["startup_apps"] = []
    defaults["startup_urls"] = []
    defaults["apps"] = {}
    defaults["spotify_track"] = ""
    defaults["about_me"] = ""

    cfg = defaults
    if CONFIG_PATH.exists():
        cfg = _merge(defaults, json.loads(CONFIG_PATH.read_text(encoding="utf-8")))

    # Environment variables win over the file, so keys never have to be on disk.
    cfg["anthropic_api_key"] = os.environ.get("ANTHROPIC_API_KEY") or cfg.get("anthropic_api_key", "")
    cfg["elevenlabs_api_key"] = os.environ.get("ELEVENLABS_API_KEY") or cfg.get("elevenlabs_api_key", "")
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
