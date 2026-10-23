const { ClapDetector } = require(process.argv[2] || "./clap.js");
const FRAME = 16.7;
// Pegelverlauf erzeugen: events = [{at, dur, peak}] -> Frames
function run(events, totalMs, opts = {}, noise = 0.05) {
  const d = new ClapDetector(opts); const out = [];
  for (let t = 0; t < totalMs; t += FRAME) {
    let p = noise * Math.random();
    for (const e of events) if (t >= e.at && t < e.at + e.dur) p = Math.max(p, e.peak);
    const r = d.feed(p, t); if (r) out.push([r, Math.round(t)]);
  }
  return out.filter(x => x[0] === "double").length;
}
const clap = (at, peak = .8) => ({ at, dur: 30, peak });
const cases = [
  ["Doppelklatschen 350 ms", [clap(500), clap(850)], 1],
  ["Doppelklatschen 150 ms", [clap(500), clap(650)], 1],
  ["Doppelklatschen 650 ms", [clap(500), clap(1150)], 1],
  ["Zu langsam (900 ms)", [clap(500), clap(1400)], 0],
  ["Einzelner Klatscher", [clap(500)], 0],
  ["Musik (laut, durchgehend)", [{ at: 200, dur: 3000, peak: .7 }], 0],
  ["Reden (lange laute Silben)", [{ at: 300, dur: 250, peak: .5 }, { at: 600, dur: 200, peak: .5 }, { at: 900, dur: 300, peak: .5 }], 0],
  ["Leise Klatscher unter Schwelle", [clap(500, .25), clap(850, .25)], 0],
  ["Pause: 2x doppelt in 3 s", [clap(500), clap(850), clap(2500), clap(2850)], 1],
  ["Nach 8 s Pause wieder", [clap(500), clap(850), clap(9500), clap(9850)], 2],
  ["Drei schnelle Klatscher", [clap(500), clap(800), clap(1100)], 1],
  ["Klatschen während Musik (Pegel nie still)", [{ at: 0, dur: 3000, peak: .3 }, clap(500), clap(850)], 0],
];
let ok = 0;
for (const [name, ev, want] of cases) {
  const got = run(ev, 12000);
  console.log((got === want ? "OK  " : "FAIL") + "  " + name + "  (Auslösungen " + got + ", erwartet " + want + ")");
  ok += got === want;
}
console.log(ok + "/" + cases.length + " bestanden");
