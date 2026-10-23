"""Things Jarvis does on your computer: launch apps, open URLs, play Spotify."""

import os
import shutil
import subprocess
import sys
import urllib.parse
import webbrowser
from pathlib import Path

from .config import ROOT


def open_target(target: str) -> None:
    """Open a file, app, URL or URI (spotify:, mailto:, ...) with the OS default handler."""
    target = os.path.expandvars(os.path.expanduser(target))
    if sys.platform.startswith("win"):
        os.startfile(target)  # noqa: S606 - user-configured target
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target])
    else:
        subprocess.Popen(["xdg-open", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def open_url(url: str) -> str:
    if not urllib.parse.urlparse(url).scheme:
        url = "https://" + url
    webbrowser.open(url)
    return f"Opened {url}"


def web_search(query: str) -> str:
    url = "https://www.google.com/search?q=" + urllib.parse.quote_plus(query)
    webbrowser.open(url)
    return f"Opened a Google search for: {query}"


def youtube_search(query: str) -> str:
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(query)
    webbrowser.open(url)
    return f"Opened a YouTube search for: {query}"


def spotify_uri(link: str) -> str:
    """Turn https://open.spotify.com/track/ID?si=... into spotify:track:ID so the desktop app plays it."""
    parsed = urllib.parse.urlparse(link)
    if parsed.netloc == "open.spotify.com":
        parts = [p for p in parsed.path.split("/") if p and not p.startswith("intl-")]
        if len(parts) >= 2:
            return f"spotify:{parts[0]}:{parts[1]}"
    return link


def play_spotify(link: str) -> str:
    if not link:
        return "No Spotify link configured."
    try:
        open_target(spotify_uri(link))
    except OSError:
        webbrowser.open(link)  # Spotify desktop app not installed: use the web player.
    return "Playing on Spotify."


def launch_app(name: str, apps: dict) -> str:
    """Launch an app by its configured nickname, or by a path/command."""
    key = name.strip().lower()
    target = next((v for k, v in apps.items() if k.lower() == key), None) or name
    try:
        open_target(target)
    except OSError:
        exe = shutil.which(target)
        if not exe:
            known = ", ".join(apps) or "none configured"
            return f"Could not find an app called '{name}'. Known apps: {known}."
        subprocess.Popen([exe])
    return f"Launched {name}."


def find_chrome(configured: str = "") -> str | None:
    candidates = [configured] if configured else []
    if sys.platform.startswith("win"):
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                candidates.append(str(Path(base) / "Google/Chrome/Application/chrome.exe"))
    elif sys.platform == "darwin":
        candidates.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    else:
        candidates += [shutil.which(n) or "" for n in ("google-chrome", "chromium", "chromium-browser")]
    return next((c for c in candidates if c and Path(c).exists()), None)


def open_jarvis_ui(cfg: dict, greet: bool) -> None:
    """Open the Jarvis UI as a Chrome app window.

    A dedicated Chrome profile keeps the microphone permission between runs and
    lets the greeting play without a click (autoplay policy flag).
    """
    url = f"http://{cfg['host']}:{cfg['port']}/" + ("?greet=1" if greet else "")
    chrome = find_chrome(cfg.get("chrome_path", ""))
    if not chrome:
        webbrowser.open(url)
        return
    profile = ROOT / ".chrome-profile"
    subprocess.Popen([
        chrome,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--window-size=520,760",
    ])


def run_startup_sequence(cfg: dict) -> None:
    """Everything that happens after the double clap."""
    for app in cfg.get("startup_apps", []):
        try:
            open_target(app)
        except OSError as e:
            print(f"[jarvis] could not start {app}: {e}")
    for url in cfg.get("startup_urls", []):
        open_url(url)
    if cfg.get("spotify_track"):
        play_spotify(cfg["spotify_track"])
    open_jarvis_ui(cfg, greet=True)
