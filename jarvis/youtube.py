"""YouTube search without an API key, so Jarvis can pick a video himself.

Reads the `ytInitialData` JSON embedded in the public search results page.
"""

import json
import re
import webbrowser

import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "en",
}
# Skips the EU cookie-consent interstitial.
COOKIES = {"SOCS": "CAI", "CONSENT": "YES+1"}
DATA_RE = re.compile(r"var ytInitialData = (\{.*?\});</script>", re.S)
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _video_renderers(node):
    if isinstance(node, dict):
        if "videoRenderer" in node:
            yield node["videoRenderer"]
        for value in node.values():
            yield from _video_renderers(value)
    elif isinstance(node, list):
        for value in node:
            yield from _video_renderers(value)


def _text(field: dict | None) -> str:
    if not field:
        return ""
    if "simpleText" in field:
        return field["simpleText"]
    return "".join(run.get("text", "") for run in field.get("runs", []))


def search(query: str, limit: int = 8) -> list[dict]:
    resp = requests.get(
        "https://www.youtube.com/results",
        params={"search_query": query, "hl": "en"},
        headers=HEADERS, cookies=COOKIES, timeout=15,
    )
    resp.raise_for_status()
    match = DATA_RE.search(resp.text)
    if not match:
        raise RuntimeError("Could not read YouTube's search results (page layout changed?)")

    videos, seen = [], set()
    for v in _video_renderers(json.loads(match.group(1))):
        vid = v.get("videoId")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        videos.append({
            "id": vid,
            "title": _text(v.get("title")),
            "channel": _text(v.get("ownerText")),
            "length": _text(v.get("lengthText")) or "LIVE",
            "views": _text(v.get("viewCountText")),
            "published": _text(v.get("publishedTimeText")),
            "verified": any("VERIFIED" in json.dumps(b) for b in v.get("ownerBadges", [])),
        })
        if len(videos) >= limit:
            break
    return videos


def format_results(videos: list[dict]) -> str:
    if not videos:
        return "No videos found."
    lines = []
    for i, v in enumerate(videos, 1):
        channel = v["channel"] + (" ✓" if v["verified"] else "")
        meta = ", ".join(x for x in (v["length"], v["views"], v["published"]) if x)
        lines.append(f"{i}. [{v['id']}] {v['title']} - {channel} ({meta})")
    return "\n".join(lines)


def play(video_id: str) -> str:
    if not VIDEO_ID_RE.match(video_id):
        return f"'{video_id}' is not a YouTube video ID; use an id from find_youtube_videos."
    webbrowser.open(f"https://www.youtube.com/watch?v={video_id}")
    return f"Playing https://www.youtube.com/watch?v={video_id}"
