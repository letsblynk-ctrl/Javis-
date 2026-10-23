"""HTTP server: serves the Jarvis HUD and the chat / voice API."""

import threading
import time
import uuid
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from jarvis import actions, knowledge, tts
from jarvis.brain import Brain
from jarvis.config import load_config

FRONTEND = Path(__file__).resolve().parent / "frontend"

cfg = load_config()
knowledge.ensure_tasks_file()
brain = Brain(cfg)
if cfg.get("anthropic_api_key") and not brain.check_web_search():
    print(f"[jarvis] {cfg.get('model')} has no web search - Jarvis will open Google instead.")
app = FastAPI(title="Jarvis")


class ChatRequest(BaseModel):
    session_id: str | None = None
    text: str = ""


def _call_brain(fn, session_id: str, *args) -> dict:
    try:
        return {"session_id": session_id, "text": fn(session_id, *args)}
    except (anthropic.AuthenticationError, TypeError) as e:
        if isinstance(e, TypeError) and "authentication" not in str(e):
            raise
        raise HTTPException(401, "Anthropic-API-Key fehlt oder ist ungültig - bitte config.json prüfen.")
    except anthropic.RateLimitError:
        raise HTTPException(429, "Zu viele Anfragen an Claude. Bitte gleich nochmal versuchen.")
    except anthropic.APIConnectionError:
        raise HTTPException(503, "Claude ist nicht erreichbar. Internetverbindung prüfen.")
    except anthropic.APIStatusError as e:
        raise HTTPException(502, f"Fehler von Claude: {e.message}")


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
        "reactor_color": cfg.get("reactor_color", "cyan"),
    }


_weather_cache = {"at": -1e9, "data": None, "refreshing": False}


def _refresh_weather():
    try:
        data = knowledge.get_weather_data(cfg["city"], cfg.get("language", "en"))
        if data:
            _weather_cache.update(at=time.monotonic(), data=data)
    finally:
        _weather_cache["refreshing"] = False


def _cached_weather():
    """Weather for the HUD. Never blocks: a stale cache is refreshed in the background
    (at most every 10 minutes) and the HUD picks it up on its next poll."""
    stale = time.monotonic() - _weather_cache["at"] > 600
    if cfg.get("city") and stale and not _weather_cache["refreshing"]:
        _weather_cache["refreshing"] = True
        threading.Thread(target=_refresh_weather, daemon=True).start()
    return _weather_cache["data"]


@app.get("/api/hud")
def hud():
    """Data for the HUD panels: weather, tasks, bookmarks."""
    return {
        "weather": _cached_weather(),
        "tasks": knowledge.list_tasks(cfg, limit=6),
        "bookmarks": cfg.get("bookmarks") or {},
        "model": cfg.get("model"),
        "web_search": any(t.get("name") == "web_search" for t in brain.tools),
    }


@app.post("/api/chat")
def chat(req: ChatRequest):
    if not req.text.strip():
        raise HTTPException(400, "Leere Nachricht")
    return _call_brain(brain.ask, req.session_id or uuid.uuid4().hex, req.text.strip())


@app.post("/api/greet")
def greet(req: ChatRequest):
    return _call_brain(brain.greet, req.session_id or uuid.uuid4().hex)


@app.post("/api/tts")
def speak(req: ChatRequest):
    """MP3 of the text, or 204 when there's no ElevenLabs key (the browser voice takes over)."""
    try:
        mp3 = tts.synthesize(req.text, cfg)
    except Exception as e:
        print(f"[jarvis] ElevenLabs: {e}")
        return Response(status_code=204, headers={"X-TTS-Error": str(e)[:200].encode("ascii", "ignore").decode()})
    if not mp3:
        return Response(status_code=204)
    return Response(content=mp3, media_type="audio/mpeg")


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
