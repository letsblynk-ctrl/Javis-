"""The brain: Claude with a small set of tools, one conversation per browser session.

History is append-only (the system prompt and tool list never change mid-session,
volatile facts like the time go into user turns). When a conversation grows too
long it is restarted from a short text recap instead of trimming earlier turns.
"""

import threading
from datetime import datetime

import anthropic

from . import actions, knowledge, screen

MAX_MESSAGES = 60      # restart the conversation from a recap after this many messages
MAX_TOOL_ROUNDS = 8    # safety stop for the tool loop

LANGUAGE_NAMES = {"de": "German", "en": "English", "fr": "French", "es": "Spanish", "it": "Italian", "nl": "Dutch"}


def _tool(name: str, description: str, properties: dict | None = None, required: list | None = None) -> dict:
    return {
        "name": name,
        "description": description,
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": properties or {},
            "required": required or [],
            "additionalProperties": False,
        },
    }


TOOLS = [
    _tool("get_weather", "Current weather and today's forecast for a city. Use the user's home city unless they name another.",
          {"city": {"type": "string"}}, ["city"]),
    _tool("get_tasks", "The user's open to-do items from their Obsidian vault."),
    _tool("search_notes", "Full-text search in the user's Obsidian notes. Use when they ask about something they wrote down.",
          {"query": {"type": "string"}}, ["query"]),
    _tool("open_website", "Open a URL in the user's browser.", {"url": {"type": "string"}}, ["url"]),
    _tool("web_search", "Open a Google search for a query in the user's browser.", {"query": {"type": "string"}}, ["query"]),
    _tool("youtube_search", "Open a YouTube search for a query in the user's browser.", {"query": {"type": "string"}}, ["query"]),
    _tool("launch_app", "Start a program on the user's computer by its nickname (see the list of known apps) or path.",
          {"name": {"type": "string"}}, ["name"]),
    _tool("play_spotify", "Play a Spotify link (track, album or playlist URL). Leave link empty to play the user's startup song.",
          {"link": {"type": "string"}}, ["link"]),
    _tool("look_at_screen", "Take a screenshot of the user's main monitor so you can see and describe what is on it."),
]


class Brain:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.client = anthropic.Anthropic(api_key=cfg.get("anthropic_api_key") or None)
        self.sessions: dict[str, list] = {}
        self.locks: dict[str, threading.Lock] = {}
        self.system = self._system_prompt()

    def _system_prompt(self) -> str:
        c = self.cfg
        lang = LANGUAGE_NAMES.get(c.get("language", "en")[:2], c.get("language", "English"))
        apps = ", ".join(c.get("apps", {})) or "none configured"
        return (
            f"You are J.A.R.V.I.S., the personal AI assistant of {c['user_name']}, inspired by Tony Stark's Jarvis: "
            f"calm, competent, loyal, with dry British wit. Address the user as \"{c['salutation']}\".\n\n"
            f"Always answer in {lang}. Everything you write is read aloud by a text-to-speech voice, so write plain "
            "spoken sentences: no markdown, no lists, no emojis, no URLs read out. Keep answers short - usually one "
            "to three sentences - unless the user asks for detail. Say numbers and units the way a person would.\n\n"
            "You can act on the user's computer through your tools: open websites and searches, start apps, play "
            "Spotify, look at the screen, read the weather, and read their to-dos and notes. When the user asks for "
            "something a tool can do, just do it and briefly confirm. Do not claim to have done something you have "
            "no tool for; say so instead.\n\n"
            f"Home city: {c.get('city') or 'unknown'}. Known apps: {apps}."
        )

    # ---------- tools ----------

    def _run_tool(self, name: str, args: dict):
        c = self.cfg
        if name == "get_weather":
            return knowledge.get_weather(args.get("city") or c.get("city", ""))
        if name == "get_tasks":
            return knowledge.get_tasks(c)
        if name == "search_notes":
            return knowledge.search_notes(c, args["query"])
        if name == "open_website":
            return actions.open_url(args["url"])
        if name == "web_search":
            return actions.web_search(args["query"])
        if name == "youtube_search":
            return actions.youtube_search(args["query"])
        if name == "launch_app":
            return actions.launch_app(args["name"], c.get("apps", {}))
        if name == "play_spotify":
            return actions.play_spotify(args.get("link") or c.get("spotify_track", ""))
        if name == "look_at_screen":
            return [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": screen.capture_screen_b64()}},
                {"type": "text", "text": "Screenshot of the user's main monitor."},
            ]
        raise ValueError(f"Unknown tool {name}")

    # ---------- conversation ----------

    def _context_line(self) -> str:
        return datetime.now().strftime("[%A, %d %B %Y, %H:%M]")

    def _recap(self, messages: list) -> str:
        lines = []
        for m in messages:
            if isinstance(m["content"], str):
                lines.append(f"{m['role']}: {m['content'][:500]}")
            else:
                for b in m["content"]:
                    if getattr(b, "type", None) == "text":
                        lines.append(f"{m['role']}: {b.text[:500]}")
        return "Recap of our earlier conversation:\n" + "\n".join(lines[-12:])

    def ask(self, session_id: str, text: str) -> str:
        lock = self.locks.setdefault(session_id, threading.Lock())
        with lock:
            messages = self.sessions.setdefault(session_id, [])
            if len(messages) > MAX_MESSAGES:
                # Start over from a plain-text recap rather than editing old turns.
                text = self._recap(messages) + "\n\n" + text
                messages = self.sessions[session_id] = []
            messages.append({"role": "user", "content": f"{self._context_line()} {text}"})
            try:
                return self._loop(messages)
            except Exception:
                # Never leave the history ending on a dangling user/tool turn.
                self.sessions.pop(session_id, None)
                raise

    def _loop(self, messages: list) -> str:
        for _ in range(MAX_TOOL_ROUNDS):
            response = self.client.messages.create(
                model=self.cfg.get("model", "claude-haiku-5-5"),
                max_tokens=16000,
                system=self.system,
                tools=TOOLS,
                messages=messages,
                output_config={"effort": "low"},  # voice assistant: snappy beats deep
                cache_control={"type": "ephemeral"},
            )
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "refusal":
                return "I'm afraid I can't help with that one."
            if response.stop_reason != "tool_use":
                return "".join(b.text for b in response.content if b.type == "text").strip()

            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                try:
                    content = self._run_tool(block.name, block.input)
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": content})
                except Exception as e:  # report tool failures to Claude instead of crashing
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": f"Error: {e}", "is_error": True})
            messages.append({"role": "user", "content": results})
        return "That took more steps than expected. Please try again."

    def greet(self, session_id: str) -> str:
        """Greeting after the double clap: weather and today's tasks."""
        c = self.cfg
        weather = knowledge.get_weather(c["city"]) if c.get("city") else "No city configured."
        tasks = knowledge.get_tasks(c)
        prompt = (
            "[Event: the user just double-clapped to start their work setup. Their apps are opening and music is "
            "starting.] Greet them according to the time of day, give a one-sentence weather summary, then mention "
            "the most important open tasks (at most three) and ask how you can help. Keep it under 70 words.\n\n"
            f"Weather: {weather}\n\n{tasks}"
        )
        return self.ask(session_id, prompt)

    def reset(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
