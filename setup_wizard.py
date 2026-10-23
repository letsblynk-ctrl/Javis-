"""Interactive setup: asks the setup questions and writes config.json.

    python setup_wizard.py
"""

import json

from jarvis.config import CONFIG_PATH, EXAMPLE_PATH, save_config


def ask(question: str, default: str = "", secret: bool = False) -> str:
    shown = ("****" + default[-4:]) if (secret and default) else default
    suffix = f" [{shown}]" if shown else ""
    answer = input(f"{question}{suffix}: ").strip()
    return answer or default


def ask_list(question: str, default: list) -> list:
    print(f"{question}\n  One per line, empty line to finish." + (" Enter '-' to keep the current list:" if default else ""))
    for item in default:
        print(f"  current: {item}")
    items = []
    while True:
        line = input("  > ").strip().strip('"')
        if not line:
            break
        if line == "-" and default:
            return default
        items.append(line)
    return items or ([] if not default else default)


def main() -> None:
    base = json.loads((CONFIG_PATH if CONFIG_PATH.exists() else EXAMPLE_PATH).read_text(encoding="utf-8"))
    if not CONFIG_PATH.exists():
        base.update(startup_apps=[], startup_urls=[], apps={}, user_name="", about_me="",
                    anthropic_api_key="", elevenlabs_api_key="")

    print("\n=== Jarvis setup ===  (press Enter to keep the value in brackets)\n")
    cfg = dict(base)
    cfg["user_name"] = ask("1. Your name", base.get("user_name", ""))
    cfg["salutation"] = ask("   How should Jarvis address you (e.g. Sir, Boss, your name)", base.get("salutation", "Sir"))
    cfg["language"] = ask("   Language code for speech (de-DE, en-US, en-GB, ...)", base.get("language", "de-DE"))
    cfg["about_me"] = ask("   A sentence about you, so Jarvis knows who he works for (job, projects, habits)",
                          base.get("about_me", ""))
    cfg["anthropic_api_key"] = ask("2. Anthropic API key (https://console.anthropic.com)", base.get("anthropic_api_key", ""), secret=True)
    cfg["elevenlabs_api_key"] = ask("3. ElevenLabs API key (https://elevenlabs.io) - empty = browser voice",
                                    base.get("elevenlabs_api_key", ""), secret=True)
    cfg["elevenlabs_voice_id"] = ask("   ElevenLabs voice ID", base.get("elevenlabs_voice_id", "JBFqnCBsd6RMkjVDRZzb"))
    cfg["spotify_track"] = ask("4. Spotify link of the song to play at startup (empty = none)", base.get("spotify_track", ""))
    cfg["startup_apps"] = ask_list("5. Programs to start on double clap (full path to the .exe, or a URI like "
                                   "obsidian://open)",
                                   base.get("startup_apps", []))
    cfg["startup_urls"] = ask_list("6. Websites to open on double clap", base.get("startup_urls", []))
    cfg["city"] = ask("7. City for the weather", base.get("city", ""))
    cfg["obsidian_vault"] = ask("8. Obsidian vault folder (optional, for tasks and notes)", base.get("obsidian_vault", ""))

    apps = dict(base.get("apps", {}))
    for path in cfg["startup_apps"]:
        if "://" in path:  # URI like obsidian://open -> nickname "obsidian"
            name = path.split(":", 1)[0].lower()
        else:
            name = path.replace("\\", "/").rsplit("/", 1)[-1].split(".")[0].lower()
        apps.setdefault(name, path)
    cfg["apps"] = apps

    save_config(cfg)
    print(f"\nSaved {CONFIG_PATH}. App nicknames Jarvis knows: {', '.join(apps) or 'none'} "
          "(edit the \"apps\" section to add more).")

    if input("\nTest the API keys now? [Y/n] ").strip().lower() in ("", "y", "yes", "j", "ja"):
        test_keys(cfg)

    print("\nDone. Start Jarvis with:  python jarvis_main.py   (then clap twice)")
    print("Test without clapping:    python jarvis_main.py --wake")


def test_keys(cfg: dict) -> None:
    import anthropic

    from jarvis import tts

    from jarvis.brain import Brain

    try:
        anthropic.Anthropic(api_key=cfg["anthropic_api_key"] or None).models.retrieve(cfg.get("model", "claude-haiku-5-5"))
        print("  Anthropic: OK")
        has_search = Brain(cfg).check_web_search()
        print(f"  Web search: {'OK' if has_search else 'not supported by this model - Jarvis opens Google instead'}")
    except Exception as e:
        print(f"  Anthropic: FAILED - {e}")
    if cfg.get("elevenlabs_api_key"):
        try:
            tts.synthesize("Ready.", cfg)
            print("  ElevenLabs: OK")
        except Exception as e:
            print(f"  ElevenLabs: FAILED - {e}")


if __name__ == "__main__":
    main()
