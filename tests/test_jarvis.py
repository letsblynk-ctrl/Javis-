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


def test_tasks_and_notes(tmp_path):
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
