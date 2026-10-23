// Doppelklatsch-Erkennung – dieselbe Logik wie jarvis/clap.py, nur pro Bildschirm-Frame statt pro Audio-Block.
//
// Ein Klatscher: Der Spitzenpegel springt über die Schwelle, direkt nachdem er unter 0,6 × Schwelle lag,
// und ist nach höchstens maxClapMs wieder unten. Längere laute Geräusche (Musik, Reden) zählen nicht.
// Zwei Klatscher im Abstand minGapMs..maxGapMs = Doppelklatschen, danach cooldownMs Pause.

class ClapDetector {
  constructor({ threshold = 0.35, minGapMs = 120, maxGapMs = 700, cooldownMs = 8000, maxClapMs = 120 } = {}) {
    this.threshold = threshold;
    this.minGapMs = minGapMs;
    this.maxGapMs = maxGapMs;
    this.cooldownMs = cooldownMs;
    this.maxClapMs = maxClapMs;
    this.reset();
  }

  reset() {
    this.prevPeak = 0;
    this.loud = false;        // Pegel liegt gerade über der Schwelle
    this.onset = null;        // Beginn eines möglichen Klatschers (nur nach Stille)
    this.lastClap = null;
    this.lastTrigger = -1e12;
  }

  /** Ein Messwert: Spitzenpegel 0..1 zum Zeitpunkt nowMs. Gibt "double", "clap" oder null zurück. */
  feed(peak, nowMs) {
    let result = null;
    if (peak >= this.threshold) {
      if (!this.loud) {
        this.loud = true;
        this.onset = this.prevPeak < this.threshold * 0.6 ? nowMs : null;   // scharfer Anstieg aus der Stille
      } else if (this.onset !== null && nowMs - this.onset > this.maxClapMs) {
        this.onset = null;                                                  // zu lang: kein Klatscher
      }
    } else if (this.loud) {
      this.loud = false;
      if (this.onset !== null && nowMs - this.onset <= this.maxClapMs) result = this._clap(this.onset);
      this.onset = null;
    }
    this.prevPeak = peak;
    return result;
  }

  _clap(t) {
    if (t - this.lastTrigger < this.cooldownMs) return null;
    if (this.lastClap !== null) {
      const gap = t - this.lastClap;
      if (gap >= this.minGapMs && gap <= this.maxGapMs) {
        this.lastClap = null;
        this.lastTrigger = t;
        return "double";
      }
    }
    this.lastClap = t;
    return "clap";
  }
}

if (typeof module !== "undefined") module.exports = { ClapDetector };
