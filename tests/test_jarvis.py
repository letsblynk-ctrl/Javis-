import numpy as np

from jarvis import actions, knowledge
from jarvis.clap import BLOCK, SAMPLE_RATE, ClapDetector

DT = BLOCK / SAMPLE_RATE


def run(detector, events):
    """events: list of (start_s, duration_s, amplitude). Returns trigger times."""
    total = max(s + d for s, d, _ in events) + 1.0
    triggers = []
    for i in range(int(total / DT)):
        t = i * DT
        amp = 0.02
        for s, d, a in events:
            if s <= t < s + d:
                amp = a
        block = np.random.uniform(-amp, amp, BLOCK).astype("float32")
        block[0] = amp  # guarantee the peak
        if detector.feed(block, t):
            triggers.append(t)
    return triggers


def test_double_clap_triggers_once():
    assert len(run(ClapDetector(), [(1.0, 0.03, 0.8), (1.35, 0.03, 0.8)])) == 1


def test_single_clap_does_not_trigger():
    assert run(ClapDetector(), [(1.0, 0.03, 0.8)]) == []


def test_claps_too_far_apart_do_not_trigger():
    assert run(ClapDetector(), [(1.0, 0.03, 0.8), (2.5, 0.03, 0.8)]) == []


def test_long_loud_sound_is_not_a_clap():
    assert run(ClapDetector(), [(1.0, 0.5, 0.8), (1.7, 0.5, 0.8)]) == []


def test_quiet_sounds_ignored():
    assert run(ClapDetector(), [(1.0, 0.03, 0.2), (1.3, 0.03, 0.2)]) == []


def test_cooldown_blocks_retrigger():
    events = [(1.0, 0.03, 0.8), (1.3, 0.03, 0.8), (2.0, 0.03, 0.8), (2.3, 0.03, 0.8)]
    assert len(run(ClapDetector(cooldown=8), events)) == 1


def test_spotify_uri():
    assert actions.spotify_uri("https://open.spotify.com/track/abc123?si=x") == "spotify:track:abc123"
    assert actions.spotify_uri("https://open.spotify.com/intl-de/album/xyz") == "spotify:album:xyz"
    assert actions.spotify_uri("spotify:playlist:p") == "spotify:playlist:p"


def test_tasks_and_notes(tmp_path, monkeypatch):
    monkeypatch.setattr(knowledge, "TASKS_MD", tmp_path / "missing-tasks.md")
    (tmp_path / "Today.md").write_text("# Today\n- [ ] Call Pepper\n- [x] Done thing\n* [ ] Fix suit\n")
    (tmp_path / "Ideas.md").write_text("Arc reactor redesign: palladium core is toxic.\n")
    cfg = {"obsidian_vault": str(tmp_path), "tasks_file": ""}
    tasks = knowledge.get_tasks(cfg)
    assert "Call Pepper" in tasks and "Fix suit" in tasks and "Done thing" not in tasks
    assert "palladium" in knowledge.search_notes(cfg, "arc reactor")


def test_youtube_search_parsing(monkeypatch):
    from jarvis import youtube

    data = {"contents": [{"videoRenderer": {
        "videoId": "dQw4w9WgXcQ",
        "title": {"runs": [{"text": "Never Gonna Give You Up"}]},
        "ownerText": {"runs": [{"text": "Rick Astley"}]},
        "ownerBadges": [{"metadataBadgeRenderer": {"style": "BADGE_STYLE_TYPE_VERIFIED_ARTIST"}}],
        "lengthText": {"simpleText": "3:33"},
        "viewCountText": {"simpleText": "1,700,000,000 views"},
        "publishedTimeText": {"simpleText": "15 years ago"},
    }}, {"videoRenderer": {"videoId": "liveliveliv", "title": {"runs": [{"text": "Radio"}]}}}]}
    html = "<script>var ytInitialData = " + __import__("json").dumps(data) + ";</script>"

    class Resp:
        text = html
        def raise_for_status(self):
            pass

    monkeypatch.setattr(youtube.requests, "get", lambda *a, **k: Resp())
    videos = youtube.search("rick")
    assert [v["id"] for v in videos] == ["dQw4w9WgXcQ", "liveliveliv"]
    assert videos[0]["verified"] and videos[1]["length"] == "LIVE"
    text = youtube.format_results(videos)
    assert "[dQw4w9WgXcQ] Never Gonna Give You Up - Rick Astley ✓ (3:33" in text


def test_youtube_play_rejects_bad_ids(monkeypatch):
    from jarvis import youtube

    opened = []
    monkeypatch.setattr(youtube.webbrowser, "open", opened.append)
    assert "not a YouTube video ID" in youtube.play("https://evil.example")
    youtube.play("dQw4w9WgXcQ")
    assert opened == ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]


def _brain(**overrides):
    from jarvis.brain import Brain
    from jarvis.config import load_config

    cfg = load_config()
    cfg.update(anthropic_api_key="test", user_name="Julian", city="Hamburg", language="de-DE", **overrides)
    return Brain(cfg)


def test_web_search_tool_and_prompt():
    brain = _brain(about_me="KI-Berater")
    search = [t for t in brain.tools if t.get("name") == "web_search"]
    assert search and search[0]["type"] == "web_search_20250305"
    assert search[0]["user_location"] == {"type": "approximate", "city": "Hamburg", "country": "DE"}
    assert len({t["name"] for t in brain.tools}) == len(brain.tools)  # no name clashes
    assert "About Julian: KI-Berater" in brain.system
    assert "[sarcastic]" in brain.system and "use web_search yourself" in brain.system


def test_web_search_dropped_when_model_lacks_it():
    from types import SimpleNamespace as NS
    from unittest import mock

    brain = _brain()
    info = NS(model_dump=lambda: {"capabilities": {"server_tools": {"web_search": {"supported": False}}}})
    with mock.patch.object(type(brain.client.with_options(timeout=10, max_retries=1).models), "retrieve", return_value=info):
        assert brain.check_web_search() is False
    assert not any(t.get("name") == "web_search" for t in brain.tools)
    assert "no internet search of your own" in brain.system


def test_pause_turn_is_resumed():
    from types import SimpleNamespace as NS
    from unittest import mock

    brain = _brain()
    replies = iter([
        NS(stop_reason="pause_turn", content=[NS(type="server_tool_use", id="s1", name="web_search")]),
        NS(stop_reason="end_turn", content=[NS(type="text", text="Drei Schlagzeilen, Sir.")]),
    ])
    with mock.patch.object(brain.client.messages, "create", side_effect=lambda **kw: next(replies)) as create:
        assert brain.ask("s", "Was gibt's Neues?") == "Drei Schlagzeilen, Sir."
    assert create.call_count == 2


def test_tasks_md_comes_first(tmp_path, monkeypatch):
    tasks_md = tmp_path / "tasks.md"
    monkeypatch.setattr(knowledge, "TASKS_MD", tasks_md)
    knowledge.ensure_tasks_file()
    tasks_md.write_text(tasks_md.read_text() + "- [ ] Exposé Filmcasino\n- [x] erledigt\n")
    assert knowledge.list_tasks({"obsidian_vault": "", "tasks_file": ""}) == ["Jarvis ausprobieren", "Exposé Filmcasino"]


def test_news_feed_parsing(monkeypatch):
    rss = b"""<?xml version="1.0"?><rss><channel>
      <item><title>Schlagzeile Eins - Quelle</title><pubDate>Fri, 23 Oct 2026 07:00:00 GMT</pubDate></item>
      <item><title>Schlagzeile Zwei</title></item></channel></rss>"""
    seen = {}

    class Resp:
        content = rss
        def raise_for_status(self):
            pass

    def fake_get(url, params, **kw):
        seen.update(url=url, params=params)
        return Resp()

    monkeypatch.setattr(knowledge.requests, "get", fake_get)
    out = knowledge.get_news({"language": "de-DE"}, "KI Startups")
    assert "Schlagzeile Eins - Quelle (Fri, 23 Oct 2026)" in out and "Schlagzeile Zwei" in out
    assert seen["url"].endswith("/rss/search") and seen["params"]["q"] == "KI Startups"
    assert seen["params"]["ceid"] == "DE:de"


def test_bookmarks_in_prompt_and_news_tool():
    brain = _brain(bookmarks={"KUBON": "https://example.com/kubon/"})
    assert "- KUBON: https://example.com/kubon/" in brain.system
    assert "get_news" in {t["name"] for t in brain.tools}


def test_tts_endpoint_without_key_returns_204(monkeypatch):
    from fastapi.testclient import TestClient

    import server

    monkeypatch.setitem(server.cfg, "elevenlabs_api_key", "")
    client = TestClient(server.app)
    assert client.post("/api/tts", json={"text": "Hallo"}).status_code == 204
    hud = client.get("/api/hud").json()
    assert set(hud) >= {"weather", "tasks", "bookmarks", "web_search"}


def _cockpit(monkeypatch, board, calls=None, status=200):
    from jarvis import cockpit as cp_mod

    class Resp:
        def __init__(self, data, code):
            self._data, self.status_code = data, code
            self.ok = code < 400
            self.text = "x"

        def json(self):
            return self._data

    def fake_post(url, headers, json, timeout):
        fn = url.rsplit("/", 1)[-1]
        if calls is not None:
            calls.append((fn, json))
        if status != 200:
            return Resp({"message": "falscher_code"}, status)
        return Resp(board if fn == "board_get" else {"mitglieder": 64} if fn == "board_kpis" else None, 200)

    monkeypatch.setattr(cp_mod.requests, "post", fake_post)
    return cp_mod.Cockpit({"cockpit": {"supabase_url": "https://x.supabase.co", "anon_key": "k",
                                       "team_code": "code", "who": "olivia", "web_url": "https://cockpit"}})


BOARD = {
    "projects": [{"id": "kubon", "name": "KUBON", "ord": 2, "next": "Anfragen"},
                 {"id": "wolki", "name": "Wolki", "ord": 1, "main": True}],
    "tasks": [
        {"id": 1, "title": "Alt", "project": "wolki", "due": "2000-01-01", "status": "offen", "owner": "olivia"},
        {"id": 2, "title": "Später", "project": "kubon", "horizon": "spaeter", "status": "offen", "owner": "arbon"},
        {"id": 3, "title": "Fertig", "project": "kubon", "status": "erledigt"},
    ],
    "messages": [{"who": "arbon", "text": "Hallo", "at": "2026-10-23T08:00"}],
}


def test_cockpit_reading(monkeypatch):
    cp = _cockpit(monkeypatch, BOARD)
    assert [p["id"] for p in cp.projects()] == ["wolki", "kubon"]  # main project first
    tasks = cp.open_tasks()
    assert [t["title"] for t in tasks] == ["Alt", "Später"] and tasks[0]["bucket"] == "late"
    assert [t["title"] for t in cp.open_tasks(mine_only=True)] == ["Alt"]
    assert "[1] Alt (Wolki, überfällig" in cp.tasks_text()
    assert "Arbon" in cp.messages_text()
    hud = cp.hud()
    assert hud["connected"] and hud["kpis"] == {"Mitglieder": 64}
    assert {p["name"]: p["late"] for p in hud["projects"]} == {"Wolki": 1, "KUBON": 0}


def test_cockpit_writing(monkeypatch):
    calls = []
    cp = _cockpit(monkeypatch, BOARD, calls)
    cp.add_task("kubon", "Muster bestellen", due="2026-11-01")
    fn, body = calls[-1]
    assert fn == "board_task_add" and body["p_project"] == "kubon" and body["p_code"] == "code"
    assert body["p_due"] == "2026-11-01" and body["p_horizon"] is None and body["p_who"] == "olivia"
    cp.complete_task("2")
    assert calls[-1][0] == "board_set_status" and calls[-1][1]["p_status"] == "erledigt"
    import pytest
    from jarvis.cockpit import CockpitError
    with pytest.raises(CockpitError, match="gibt es im Cockpit nicht"):
        cp.add_task("Marvel", "x")


def test_cockpit_wrong_code_and_tools(monkeypatch):
    cp = _cockpit(monkeypatch, BOARD, status=403)
    assert cp.hud() == {"connected": False, "error": "Der Team-Code stimmt nicht."}
    assert "get_cockpit_tasks" not in {t["name"] for t in _brain().tools}  # no team code -> no cockpit tools
    brain = _brain(cockpit={"supabase_url": "https://x", "anon_key": "k", "team_code": "c"})
    assert {"get_cockpit_tasks", "post_team_message"} <= {t["name"] for t in brain.tools}
    assert "Startup-Cockpit" in brain.system


def test_profile_file_goes_into_prompt(tmp_path):
    profile = tmp_path / "me.md"
    profile.write_text("# Profil\n- Erinnere mich an Fristen beim Steuerberater.\n", encoding="utf-8")
    brain = _brain(profile_file=str(profile))
    assert "<profile>" in brain.system and "Steuerberater" in brain.system
    assert "<profile>" not in _brain(profile_file=str(tmp_path / "missing.md")).system
