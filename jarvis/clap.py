"""Double-clap detection from the microphone.

A clap is a short, loud transient: the block peak jumps above `threshold`
right after a quiet block and drops again quickly. Two claps between
`min_gap` and `max_gap` seconds apart trigger the callback.
"""

import time

import numpy as np

SAMPLE_RATE = 44100
BLOCK = 512  # ~12 ms per block


class ClapDetector:
    def __init__(self, threshold=0.35, min_gap=0.12, max_gap=0.7, cooldown=8.0, max_clap_len=0.12):
        self.threshold = threshold
        self.min_gap = min_gap
        self.max_gap = max_gap
        self.cooldown = cooldown
        self.max_clap_blocks = max(1, int(max_clap_len * SAMPLE_RATE / BLOCK))
        self.prev_peak = 0.0
        self.loud_blocks = 0
        self.onset_time = None
        self.last_clap = None
        self.last_trigger = -1e9

    def feed(self, block: np.ndarray, now: float) -> bool:
        """Feed one block of float samples (-1..1). Returns True on a double clap."""
        peak = float(np.max(np.abs(block))) if block.size else 0.0
        triggered = False

        if peak >= self.threshold:
            if self.loud_blocks == 0 and self.prev_peak < self.threshold * 0.6:
                self.onset_time = now  # sharp onset after quiet
            self.loud_blocks += 1
        else:
            if self.onset_time is not None and 0 < self.loud_blocks <= self.max_clap_blocks:
                triggered = self._register_clap(self.onset_time)
            self.onset_time = None
            self.loud_blocks = 0

        self.prev_peak = peak
        return triggered

    def _register_clap(self, t: float) -> bool:
        if t - self.last_trigger < self.cooldown:
            return False
        if self.last_clap is not None and self.min_gap <= t - self.last_clap <= self.max_gap:
            self.last_clap = None
            self.last_trigger = t
            return True
        self.last_clap = t
        return False


def listen(cfg: dict, on_double_clap, calibrate: bool = False) -> None:
    """Blocking microphone loop."""
    import sounddevice as sd

    c = cfg.get("clap", {})
    detector = ClapDetector(c.get("threshold", 0.35), c.get("min_gap", 0.12), c.get("max_gap", 0.7), c.get("cooldown", 8.0))
    loudest = 0.0
    last_print = time.monotonic()

    with sd.InputStream(samplerate=SAMPLE_RATE, blocksize=BLOCK, channels=1, dtype="float32", device=c.get("device")) as stream:
        print("[jarvis] listening for a double clap... (Ctrl+C to quit)")
        while True:
            data, _ = stream.read(BLOCK)
            samples = data[:, 0]
            now = time.monotonic()
            if calibrate:
                loudest = max(loudest, float(np.max(np.abs(samples))))
                if now - last_print > 0.5:
                    bar = "#" * int(loudest * 50)
                    print(f"peak {loudest:4.2f} |{bar:<50}| threshold {detector.threshold:.2f}")
                    loudest, last_print = 0.0, now
            if detector.feed(samples, now):
                print("[jarvis] double clap!")
                on_double_clap()
