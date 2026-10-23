# Jarvis - notes for Claude Code

Personal voice assistant: double clap -> startup apps/websites/Spotify open -> Jarvis UI (Chrome app window)
greets with weather + tasks -> free voice conversation. Brain = Claude (`jarvis/brain.py`), voice = ElevenLabs
(`jarvis/tts.py`), speech input = Chrome Web Speech API (`frontend/app.js`), clap detection = `jarvis/clap.py`.

## When the user says "Set up Jarvis for me" / "Richte Jarvis für mich ein"

Run the setup as a conversation (in the user's language), don't make them run the wizard:

1. Ask for, one or two at a time:
   - name, and how Jarvis should address them (e.g. "Sir"); speech language (`de-DE`, `en-US`, ...)
   - Anthropic API key (console.anthropic.com) - the brain
   - ElevenLabs API key (elevenlabs.io) - the voice; optional voice ID (default `JBFqnCBsd6RMkjVDRZzb`)
   - Spotify link of the startup song
   - programs to start on double clap - find the real `.exe` paths yourself (e.g. search
     `%LOCALAPPDATA%\Programs`, `C:\Program Files`) and confirm them with the user
   - websites to open
   - city for the weather
   - optional Obsidian vault folder (tasks are `- [ ]` checkboxes anywhere in the vault)
2. Write `config.json` (schema: `config.example.json`). Add each startup program to `apps` under a short
   lowercase nickname so Jarvis can launch it by voice. Never commit `config.json` (it holds keys).
3. Install: `py -3 -m venv .venv`, then `.venv\Scripts\pip install -r requirements.txt`.
4. Verify the keys (the interactive wizard isn't needed when you write the config yourself):
   `.venv\Scripts\python -c "from setup_wizard import test_keys; from jarvis.config import load_config; test_keys(load_config())"`.
5. Calibrate claps: ask the user to run `.venv\Scripts\python jarvis_main.py --calibrate` in their own
   terminal and clap a few times, then set `clap.threshold` to roughly half of a clap's peak but well above
   the background level.
6. Offer autostart: `powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1`.
7. First run: `.venv\Scripts\python jarvis_main.py --wake`. Chrome will ask for microphone access once
   (dedicated profile in `.chrome-profile/`).

## Conventions

- Keep the Claude conversation append-only: don't edit the system prompt or tools mid-session, don't trim old
  turns (the brain restarts from a text recap instead). Put volatile info (time, weather) in user turns.
- Replies are spoken: the system prompt asks for short, plain sentences without markdown.
- New capability = add a tool schema to `TOOLS` and a branch in `Brain._run_tool`.
- Tests: `python -m pytest tests`.
