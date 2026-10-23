"""Weather (Open-Meteo, no key needed) and tasks/notes from an Obsidian vault."""

import re
from pathlib import Path

import requests

WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}

TASK_RE = re.compile(r"^\s*[-*]\s+\[ \]\s+(.+)$")


def get_weather(city: str) -> str:
    try:
        geo = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1}, timeout=10,
        ).json()
        if not geo.get("results"):
            return f"Unknown city: {city}"
        place = geo["results"][0]
        data = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
                "forecast_days": 1,
                "timezone": "auto",
            },
            timeout=10,
        ).json()
    except requests.RequestException as e:
        return f"Weather service unreachable: {e}"

    cur, day = data["current"], data["daily"]
    return (
        f"{place['name']}: now {cur['temperature_2m']}°C (feels like {cur['apparent_temperature']}°C), "
        f"{WEATHER_CODES.get(cur['weather_code'], 'unknown conditions')}, wind {cur['wind_speed_10m']} km/h. "
        f"Today {day['temperature_2m_min'][0]}-{day['temperature_2m_max'][0]}°C, "
        f"{WEATHER_CODES.get(day['weather_code'][0], '')}, "
        f"rain chance {day['precipitation_probability_max'][0]}%."
    )


def _markdown_files(cfg: dict) -> list[Path]:
    if cfg.get("tasks_file"):
        return [Path(cfg["tasks_file"]).expanduser()]
    vault = cfg.get("obsidian_vault")
    if not vault:
        return []
    root = Path(vault).expanduser()
    return [p for p in root.rglob("*.md") if ".obsidian" not in p.parts and ".trash" not in p.parts]


def get_tasks(cfg: dict, limit: int = 15) -> str:
    """Open checkbox tasks (`- [ ] ...`) from the tasks file or the whole vault."""
    files = _markdown_files(cfg)
    if not files:
        return "No task source configured (set obsidian_vault or tasks_file in config.json)."
    tasks = []
    for path in sorted(files, key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                m = TASK_RE.match(line)
                if m:
                    tasks.append(f"{m.group(1).strip()} ({path.stem})")
        except OSError:
            continue
        if len(tasks) >= limit:
            break
    return "Open tasks:\n- " + "\n- ".join(tasks[:limit]) if tasks else "No open tasks."


def search_notes(cfg: dict, query: str, limit: int = 5) -> str:
    """Case-insensitive full-text search over the vault; returns snippets."""
    files = _markdown_files(cfg)
    if not files:
        return "No Obsidian vault configured."
    words = [w.lower() for w in query.split() if len(w) > 2] or [query.lower()]
    hits = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        lower = text.lower()
        score = sum(lower.count(w) for w in words) + 5 * sum(w in path.stem.lower() for w in words)
        if score:
            idx = max(lower.find(words[0]), 0)
            snippet = text[max(idx - 200, 0): idx + 600].strip()
            hits.append((score, path.stem, snippet))
    hits.sort(reverse=True)
    if not hits:
        return f"No notes found for '{query}'."
    return "\n\n".join(f"## {name}\n{snippet}" for _, name, snippet in hits[:limit])
