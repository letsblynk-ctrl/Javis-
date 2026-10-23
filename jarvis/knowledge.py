"""Weather (Open-Meteo), news (Google News RSS) - no keys needed - and tasks/notes
from tasks.md and an optional Obsidian vault."""

import re
from pathlib import Path
from xml.etree import ElementTree

import requests

from .config import ROOT

WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}

TASK_RE = re.compile(r"^\s*[-*]\s+\[ \]\s+(.+)$")
TASKS_MD = ROOT / "tasks.md"  # personal, git-ignored; created on first start
TASKS_TEMPLATE = (
    "# Aufgaben\n\n"
    "Offene Aufgaben als Checkboxen. Jarvis liest alle `- [ ]`-Zeilen, erledigte (`- [x]`) nicht.\n\n"
    "- [ ] Jarvis ausprobieren\n"
)


def ensure_tasks_file() -> None:
    if not TASKS_MD.exists():
        TASKS_MD.write_text(TASKS_TEMPLATE, encoding="utf-8")


def get_weather_data(city: str, lang: str = "en") -> dict | None:
    """Current weather and today's range as a dict, or None if unavailable."""
    try:
        geo = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1, "language": lang[:2]}, timeout=10,
        ).json()
        if not geo.get("results"):
            return None
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
    except (requests.RequestException, ValueError):
        return None

    cur, day = data["current"], data["daily"]
    return {
        "city": place["name"],
        "temp": cur["temperature_2m"],
        "feels_like": cur["apparent_temperature"],
        "description": WEATHER_CODES.get(cur["weather_code"], "unknown conditions"),
        "code": cur["weather_code"],
        "wind": cur["wind_speed_10m"],
        "min": day["temperature_2m_min"][0],
        "max": day["temperature_2m_max"][0],
        "rain_chance": day["precipitation_probability_max"][0],
        "today": WEATHER_CODES.get(day["weather_code"][0], ""),
    }


def get_weather(city: str, lang: str = "en") -> str:
    w = get_weather_data(city, lang)
    if not w:
        return f"No weather available for {city}."
    return (
        f"{w['city']}: now {w['temp']}°C (feels like {w['feels_like']}°C), {w['description']}, "
        f"wind {w['wind']} km/h. Today {w['min']}-{w['max']}°C, {w['today']}, rain chance {w['rain_chance']}%."
    )


def get_news(cfg: dict, topic: str = "", limit: int = 10) -> str:
    """Top headlines (or headlines about a topic) from Google News in the user's language."""
    lang = cfg.get("language", "de-DE")
    hl, gl = (lang.split("-") + ["DE"])[:2]
    params = {"hl": hl, "gl": gl.upper(), "ceid": f"{gl.upper()}:{hl}"}
    url = "https://news.google.com/rss"
    if topic:
        url += "/search"
        params["q"] = topic
    try:
        resp = requests.get(url, params=params, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        root = ElementTree.fromstring(resp.content)
    except (requests.RequestException, ElementTree.ParseError) as e:
        return f"News feed unavailable: {e}"
    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if title:
            items.append(f"- {title} ({(item.findtext('pubDate') or '')[:16]})")
        if len(items) >= limit:
            break
    return "Headlines:\n" + "\n".join(items) if items else "No headlines found."


def _vault_files(cfg: dict) -> list[Path]:
    vault = cfg.get("obsidian_vault")
    if not vault or not Path(vault).expanduser().exists():
        return []
    root = Path(vault).expanduser()
    return [p for p in root.rglob("*.md") if ".obsidian" not in p.parts and ".trash" not in p.parts]


def _task_files(cfg: dict) -> list[Path]:
    if cfg.get("tasks_file"):
        return [Path(cfg["tasks_file"]).expanduser()]
    vault = sorted(_vault_files(cfg), key=lambda p: p.stat().st_mtime, reverse=True)
    return [TASKS_MD] + vault


def list_tasks(cfg: dict, limit: int = 15) -> list[str]:
    """Open checkbox tasks (`- [ ] ...`): tasks.md first, then the most recently edited vault notes."""
    tasks = []
    for path in _task_files(cfg):
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for line in lines:
            m = TASK_RE.match(line)
            if m:
                tasks.append(m.group(1).strip() if path == TASKS_MD else f"{m.group(1).strip()} ({path.stem})")
        if len(tasks) >= limit:
            break
    return tasks[:limit]


def get_tasks(cfg: dict) -> str:
    tasks = list_tasks(cfg)
    return "Open tasks:\n- " + "\n- ".join(tasks) if tasks else "No open tasks."


def search_notes(cfg: dict, query: str, limit: int = 5) -> str:
    """Case-insensitive full-text search over the vault; returns snippets."""
    files = _vault_files(cfg)
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
