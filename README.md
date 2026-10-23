# J.A.R.V.I.S.

Your personal AI assistant, inspired by Iron Man's Jarvis.

- **Clap twice** and your whole work setup starts: apps, websites, your Spotify song.
- Jarvis **greets you** with the weather and your open tasks.
- **Talk freely** with Jarvis; he answers out loud (ElevenLabs voice).
- Jarvis can **control your browser** (search Google or YouTube, open sites) and **start apps**.
- **YouTube on command:** say "play the latest Tagesschau" or "put on some lofi" and Jarvis searches
  YouTube, picks the best video himself (official channels, newest for news, no reaction videos) and plays it.
- Jarvis can **look at your screen** and describe it ("What's on my screen?", "Explain this error").
- Optional: reads to-dos and notes from your **Obsidian** vault.

```
 microphone ──► clap detector ──► startup sequence ──► apps / websites / Spotify
                                         │
                                         ▼
 Chrome app window (orb UI) ◄──► local server (FastAPI) ◄──► Claude (brain + tools)
   speech recognition (Chrome)            │                    weather · tasks · notes
   voice playback                         └──► ElevenLabs      browser · apps · screenshot
```

## Requirements

- Windows 10/11 (macOS/Linux work too, except autostart scripts)
- Python 3.10+
- Google Chrome (speech recognition + Jarvis window)
- An [Anthropic API key](https://console.anthropic.com) (the brain, Claude Haiku 5.5 by default)
- An [ElevenLabs API key](https://elevenlabs.io) for the voice (optional: without it the browser's voice is used)

## Setup

**Option A - with Claude Code:** open this folder in VS Code, start Claude Code and say
*"Set up Jarvis for me"* (or *"Richte Jarvis für mich ein"*). It asks you the questions, writes
`config.json`, installs everything and helps you calibrate the claps.

**Option B - by hand (Windows):** double-click `scripts\setup_windows.bat`. It creates a virtual
environment, installs the dependencies and runs the setup wizard, which asks for:

1. your name and how Jarvis should address you (e.g. "Sir")
2. Anthropic API key
3. ElevenLabs API key
4. the Spotify song for the startup
5. programs to start on double clap
6. websites to open
7. city for the weather
8. Obsidian vault (optional)

On macOS/Linux: `python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && python setup_wizard.py`.

## Run

```bash
python jarvis_main.py              # listens for a double clap
python jarvis_main.py --wake       # run the startup sequence right away (test without clapping)
python jarvis_main.py --calibrate  # print mic levels to tune clap.threshold in config.json
python jarvis_main.py --no-clap    # server only, open http://127.0.0.1:8340 yourself
```

Autostart at login (Windows): `powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1`
(remove again with `-Remove`).

In the Jarvis window: **click the orb or press Space** to turn the microphone on or off, **Esc** stops
Jarvis talking, or just type. After a double clap the mic is on automatically. While Jarvis is
speaking the mic pauses so he doesn't hear himself.

## Tuning

| Setting in `config.json` | What it does |
|---|---|
| `model` | Claude model. `claude-haiku-5-5` is fast and cheap; `claude-sonnet-5-5` is smarter but slower. |
| `elevenlabs_voice_id` | Any voice from your ElevenLabs library. Default: "George" (British). |
| `clap.threshold` | Peak level (0-1) a clap must reach. Raise it if music or typing triggers Jarvis. |
| `clap.min_gap` / `max_gap` | Allowed time between the two claps in seconds. |
| `apps` | Nicknames → paths, so you can say "start VS Code". |
| `tasks_file` | Use a single Markdown file for tasks instead of scanning the whole vault. |

API keys can also come from the environment variables `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY`
instead of `config.json`.

## Privacy

Everything runs locally except: your messages and screenshots (only when you ask Jarvis to look) go to
the Anthropic API, Jarvis's replies go to ElevenLabs for the voice, and Chrome's speech recognition
sends your audio to Google while the mic is on. `config.json` holds your keys and is git-ignored.
