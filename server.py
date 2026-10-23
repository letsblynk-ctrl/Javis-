"""HTTP server: serves the Jarvis UI and the chat API."""

import base64
import uuid
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from jarvis import actions, tts
from jarvis.brain import Brain
from jarvis.config import load_config

FRONTEND = Path(__file__).resolve().parent / "frontend"

cfg = load_config()
brain = Brain(cfg)
if cfg.get("anthropic_api_key") and not brain.check_web_search():
    print(f"[jarvis] {cfg.get('model')} has no web search - Jarvis will open Google instead.")
app = FastAPI(title="Jarvis")


class ChatRequest(BaseModel):
    session_id: str | None = None
    text: str = ""


def _reply(session_id: str, text: str) -> dict:
    audio = None
    tts_error = None
    try:
        mp3 = tts.synthesize(text, cfg)
        audio = base64.b64encode(mp3).decode("ascii") if mp3 else None
    except Exception as e:  # voice failure shouldn't lose the answer
        tts_error = str(e)
    return {"session_id": session_id, "text": text, "audio": audio, "tts_error": tts_error}


def _call_brain(fn, session_id: str, *args) -> dict:
    try:
        return _reply(session_id, fn(session_id, *args))
    except (anthropic.AuthenticationError, TypeError) as e:
        if isinstance(e, TypeError) and "authentication" not in str(e):
            raise
        raise HTTPException(401, "Anthropic API key is missing or invalid - check config.json.")
    except anthropic.RateLimitError:
        raise HTTPException(429, "Rate limited by the Anthropic API. Try again in a moment.")
    except anthropic.APIConnectionError:
        raise HTTPException(503, "Cannot reach the Anthropic API. Check your internet connection.")
    except anthropic.APIStatusError as e:
        raise HTTPException(502, f"Anthropic API error: {e.message}")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/api/config")
def public_config():
    return {
        "user_name": cfg["user_name"],
        "salutation": cfg["salutation"],
        "language": cfg["language"],
        "has_voice": bool(cfg.get("elevenlabs_api_key")),
        "has_brain": bool(cfg.get("anthropic_api_key")),
    }


@app.post("/api/chat")
def chat(req: ChatRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty message")
    return _call_brain(brain.ask, req.session_id or uuid.uuid4().hex, req.text.strip())


@app.post("/api/greet")
def greet(req: ChatRequest):
    return _call_brain(brain.greet, req.session_id or uuid.uuid4().hex)


@app.post("/api/reset")
def reset(req: ChatRequest):
    if req.session_id:
        brain.reset(req.session_id)
    return {"ok": True}


@app.post("/api/wake")
def wake():
    """Run the double-clap startup sequence (also handy for testing without clapping)."""
    actions.run_startup_sequence(cfg)
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=cfg["host"], port=cfg["port"])
