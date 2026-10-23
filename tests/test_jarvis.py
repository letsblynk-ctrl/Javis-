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
