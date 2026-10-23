"""The brain: Claude with a small set of tools, one conversation per browser session.

History is append-only (the system prompt and tool list never change mid-session,
volatile facts like the time go into user turns). When a conversation grows too
long it is restarted from a short text recap instead of trimming earlier turns.
"""

import threading
from datetime import datetime

import anthropic

from . import actions, knowledge, screen, youtube

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
    _tool("get_tasks", "The user's open to-do items (from tasks.md and their Obsidian vault)."),
    _tool("get_news", "Current headlines from Google News in the user's language. Leave topic empty for the top "
          "stories, or give a topic (e.g. 'Immobilien München', 'KI Startups').", {"topic": {"type": "string"}}, ["topic"]),
    _tool("search_notes", "Full-text search in the user's Obsidian notes. Use when they ask about something they wrote down.",
          {"query": {"type": "string"}}, ["query"]),
    _tool("open_website", "Open a URL in the user's browser.", {"url": {"type": "string"}}, ["url"]),
    _tool("open_google_search", "Open a Google results page in the user's browser, for when they want to look "
          "through the results themselves.", {"query": {"type": "string"}}, ["query"]),
    _tool("find_youtube_videos", "Search YouTube and return the top results (id, title, channel, length, views, age) "
          "without opening anything, so you can choose the best video.", {"query": {"type": "string"}}, ["query"]),
    _tool("play_youtube_video", "Open and play a YouTube video in the user's browser by its id from find_youtube_videos.",
          {"video_id": {"type": "string"}}, ["video_id"]),
    _tool("youtube_search", "Open the YouTube results page for a query, for when the user wants to browse the results "
          "themselves.", {"query": {"type": "string"}}, ["query"]),
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
        self.tools = TOOLS + ([self._web_search_tool()] if cfg.get("web_search", True) else [])
        self.system = self._system_prompt()

    def _web_search_tool(self) -> dict:
        """Claude's server-side web search: Anthropic runs the searches, Claude reads and summarizes."""
        tool = {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}
        location = {"type": "approximate"}
        if self.cfg.get("city"):
            location["city"] = self.cfg["city"]
        lang = self.cfg.get("language", "")
        if len(lang) == 5 and lang[2] == "-":
            location["country"] = lang[3:].upper()
        if len(location) > 1:
            tool["user_location"] = location
        return tool

    def check_web_search(self) -> bool:
        """Drop the web search tool if the configured model doesn't support it.

        Runs once at startup, before any conversation exists, so the tool list
        never changes mid-conversation."""
        if not any(t.get("name") == "web_search" for t in self.tools):
            return False
        try:
            client = self.client.with_options(timeout=10, max_retries=1)
            info = client.models.retrieve(self.cfg.get("model", "claude-haiku-5-5"))
            caps = info.model_dump().get("capabilities") or {}
            supported = ((caps.get("server_tools") or {}).get("web_search") or {}).get("supported")
        except Exception:
            return True  # can't tell (offline, no key yet): keep it
        if supported is False:
            self.tools = [t for t in self.tools if t.get("name") != "web_search"]
            self.system = self._system_prompt()
            return False
        return True

    def _system_prompt(self) -> str:
        c = self.cfg
        lang = LANGUAGE_NAMES.get(c.get("language", "en")[:2], c.get("language", "English"))
        apps = ", ".join(c.get("apps", {})) or "none configured"
        about = f"About {c['user_name']}: {c['about_me']}\n\n" if c.get("about_me") else ""
        marks = c.get("bookmarks") or {}
        bookmarks = (
            "Bookmarks - when the user says \"open X\" and X is one of these, open that URL with open_website:\n"
            + "\n".join(f"- {name}: {url}" for name, url in marks.items()) + "\n\n"
        ) if marks else ""
        has_search = any(t.get("name") == "web_search" for t in self.tools)
        search = (
            "Internet: when the user asks about anything current or factual you aren't sure of - news, prices, "
            "scores, opening hours, people, products, events - use web_search yourself and answer from the results "
            "in a few spoken sentences. Don't open a browser for that, don't read out sources or URLs. "
            "Use open_google_search only when the user wants to see the results page.\n\n"
            if has_search else
            "You have no internet search of your own. For questions about current events, open a Google search "
            "with open_google_search and say so.\n\n"
        )
        search += (
            "News: for \"news\", \"what's new\", \"what's happening in the world\" or \"the current situation\", call "
            "get_news and give the three or four most important stories as a short spoken briefing, one sentence "
            "each. For news on a subject, pass it as the topic"
            + (", and use web_search if the user wants details on one story." if has_search else ".") + "\n\n"
        )
        return (
            f"You are J.A.R.V.I.S., the personal AI assistant of {c['user_name']}, inspired by Tony Stark's Jarvis: "
            f"calm, competent, loyal, with dry British wit. Address the user as \"{c['salutation']}\".\n\n"
            f"{about}"
            f"Always answer in {lang}. Everything you write is read aloud by a text-to-speech voice, so write plain "
            "spoken sentences: no markdown, no lists, no emojis, no URLs read out. Keep answers short - usually one "
            "to three sentences - unless the user asks for detail. Say numbers and units the way a person would. "
            "Never write stage directions, emotions or tags in brackets such as [sarcastic], [amused] or (laughs) - "
            "the voice would read them out or act them; let the wit live in the words.\n\n"
            "You can act on the user's computer through your tools: search the internet, open websites, start apps, "
            "play Spotify and YouTube, look at the screen, read the weather, and read their to-dos and notes. When the "
            "user asks for something a tool can do, just do it and briefly confirm. Do not claim to have done "
            "something you have no tool for; say so instead.\n\n"
            "Screen: when the user asks what's on their screen or to look at something, call look_at_screen first "
            "and only then answer - no announcement before it.\n\n"
            f"{search}"
            "YouTube: when the user wants to watch or hear something on YouTube, decide for them. Call "
            "find_youtube_videos, pick the single best result and play it right away with play_youtube_video - "
            "don't read the list out or ask which one. Pick the result that matches what they asked for most "
            "closely (exact song, episode or topic, in their language where that matters); among close matches prefer "
            "the official or verified channel, then the more viewed, and for news or \"latest\" requests the newest. "
            "Avoid live streams unless they asked for one or for continuous music, and avoid compilations or "
            "reactions unless asked. If nothing fits, search again with a better query. Then say in one short sentence "
            "what you're playing and from which channel. Only use youtube_search when they want to browse.\n\n"
            f"{bookmarks}"
            f"Home city: {c.get('city') or 'unknown'}. Known apps: {apps}."
        )

    # ---------- tools ----------

    def _run_tool(self, name: str, args: dict):
        c = self.cfg
        if name == "get_weather":
            return knowledge.get_weather(args.get("city") or c.get("city", ""), c.get("language", "en"))
        if name == "get_tasks":
            return knowledge.get_tasks(c)
        if name == "get_news":
            return knowledge.get_news(c, args.get("topic", ""))
        if name == "search_notes":
            return knowledge.search_notes(c, args["query"])
        if name == "open_website":
            return actions.open_url(args["url"])
        if name == "open_google_search":
            return actions.web_search(args["query"])
        if name == "find_youtube_videos":
            return youtube.format_results(youtube.search(args["query"]))
        if name == "play_youtube_video":
            return youtube.play(args["video_id"].strip())
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
                tools=self.tools,
                messages=messages,
                output_config={"effort": "low"},  # voice assistant: snappy beats deep
                cache_control={"type": "ephemeral"},
            )
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "refusal":
                return "I'm afraid I can't help with that one."
            if response.stop_reason == "pause_turn":
                continue  # a long server-side search paused; resend so it carries on
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
        weather = knowledge.get_weather(c["city"], c.get("language", "en")) if c.get("city") else "No city configured."
        tasks = knowledge.get_tasks(c)
        prompt = (
            "[Event: the user just activated you - their work setup is starting.] Greet them:\n"
            "- Greet them in a way that fits the time of day, and be creative - don't use the same opening every day.\n"
            "- One short sentence on the weather: the temperature, whether it's sunny, clear, cloudy or rainy, and "
            "how it feels. No humidity, no wind figures unless it's stormy.\n"
            "- Summarize the open tasks as an overview in one sentence instead of reading each one out; add a short "
            "witty remark or tip if one fits.\n"
            "- End by asking what's first. Keep it all under 70 words.\n\n"
            f"Weather: {weather}\n\n{tasks}"
        )
        return self.ask(session_id, prompt)

    def reset(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
