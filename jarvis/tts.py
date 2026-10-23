"""Text-to-speech via the ElevenLabs REST API. Returns MP3 bytes."""

import requests


class TTSError(RuntimeError):
    pass


def synthesize(text: str, cfg: dict) -> bytes | None:
    """Returns MP3 bytes, or None when no ElevenLabs key is configured
    (the browser then falls back to its built-in speech synthesis)."""
    key = cfg.get("elevenlabs_api_key")
    if not key or not text.strip():
        return None
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{cfg['elevenlabs_voice_id']}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": key, "Accept": "audio/mpeg"},
        json={
            "text": text,
            "model_id": cfg.get("elevenlabs_model", "eleven_multilingual_v2"),
            "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.15},
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise TTSError(f"ElevenLabs {resp.status_code}: {resp.text[:200]}")
    return resp.content
