// Jarvis fürs iPad (Safari / Home-Bildschirm). Läuft komplett im Browser:
// Gehirn = Claude-API, Stimme = ElevenLabs (sonst iPad-Stimme), Spracheingabe = Safari-Spracherkennung,
// Doppelklatschen = Mikrofon + AnalyserNode (clap.js), Start per Siri-Kurzbefehl mit ?activate=1.
// Alle Schlüssel liegen nur im localStorage dieses Geräts, nie im Repo.

const $ = (id) => document.getElementById(id);

// =====================================================================
// Einstellungen
// =====================================================================

const STORE = "jarvis-ipad";
const DEFAULTS = {
  user_name: "", salutation: "Sir", city: "Bad Kissingen", about_me: "", language: "de-DE",
  anthropic_api_key: "", model: "claude-haiku-5-5",
  elevenlabs_api_key: "", elevenlabs_voice_id: "JBFqnCBsd6RMkjVDRZzb", elevenlabs_model: "eleven_multilingual_v2",
  cockpit: { supabase_url: "", anon_key: "", team_code: "", who: "olivia" },
  clap: { threshold: 0.35, enabled: false },
  tasks: [],
  last_seen_message: "",
};
let config = load();

function load() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) || "{}");
    return { ...DEFAULTS, ...c, cockpit: { ...DEFAULTS.cockpit, ...(c.cockpit || {}) }, clap: { ...DEFAULTS.clap, ...(c.clap || {}) } };
  } catch (_) { return structuredClone(DEFAULTS); }
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(config)); } catch (_) {} }

let state = "idle";
let busy = false;           // denkt oder spricht
let conversation = false;   // nach dem Wecken: Jarvis hört nach jeder Antwort wieder zu

// =====================================================================
// Reaktor (aus frontend/app.js der PC-Version, pinker Orb)
// =====================================================================

const cv = $("reactor");
const ctx = cv.getContext("2d");
const TAU = Math.PI * 2;
const UNITS = 1200;  // drawing coordinates; the bitmap itself matches the on-screen size

function fitCanvas() {
  const px = Math.round(Math.min(cv.clientWidth * (window.devicePixelRatio || 1), UNITS)) || UNITS;
  if (cv.width !== px) { cv.width = px; cv.height = px; }
  ctx.setTransform(px / UNITS, 0, 0, px / UNITS, 0, 0);
}
window.addEventListener("resize", fitCanvas);
fitCanvas();

// Reactor colors per state; "reactor_color" in config.json picks the palette.
const PALETTES = {
  cyan: {
    idle: [95, 225, 255],
    listening: [120, 235, 255],
    thinking: [255, 196, 92],
    speaking: [170, 245, 255],
    error: [255, 90, 79],
  },
  pink: {
    idle: [255, 46, 140],
    listening: [255, 90, 170],
    thinking: [255, 196, 92],
    speaking: [255, 120, 190],
    error: [255, 110, 60],
  },
};
const COLORS = { ...PALETTES.cyan };
let col = [...COLORS.idle];
let level = 0;
let spin = 0;
let lastFrame = performance.now();
const t0 = performance.now();

// Geodesic sphere: an icosahedron subdivided twice (162 points, 480 edges).
const SPHERE = (() => {
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const p = (1 + Math.sqrt(5)) / 2;
  const verts = [[-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p],
    [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]].map(norm);
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
    [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11],
    [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let s = 0; s < 2; s++) {
    const cache = new Map();
    const mid = (a, b) => {
      const k = key(a, b);
      if (!cache.has(k)) {
        verts.push(norm(verts[a].map((x, i) => (x + verts[b][i]) / 2)));
        cache.set(k, verts.length - 1);
      }
      return cache.get(k);
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  const seen = new Set(), edges = [];
  for (const [a, b, c] of faces) {
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      if (!seen.has(key(x, y))) { seen.add(key(x, y)); edges.push([x, y]); }
    }
  }
  return { verts, edges };
})();

// Particle wave rings and the spray around them.
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const RINGS = [0, 1, 2].map((k) => ({
  R: 448 + k * 26,
  dir: k % 2 ? -1 : 1,
  phase: Math.random() * 10,
  pts: Array.from({ length: 1000 }, () => ({ a: Math.random() * TAU, o: gauss() * 16 })),
}));
const SPRAY = Array.from({ length: 180 }, () => ({ a: Math.random() * TAU, r0: Math.random() * 100, s: 0.3 + Math.random() }));

function voiceLevel(t) {
  if (analyser && !player.paused) {
    analyser.getByteFrequencyData(freq);
    let sum = 0;
    for (let i = 0; i < freq.length; i++) sum += freq[i];
    return Math.min(1, sum / freq.length / 80);
  }
  if (browserSpeaking) return 0.45 + 0.35 * Math.abs(Math.sin(t * 9) * Math.sin(t * 3.7));
  return 0;
}

function waveRadius(ring, a, t) {
  const p = ring.phase, d = ring.dir;
  return ring.R + level * 26
    + Math.sin(a * 3 + d * t * 0.6 + p) * 14
    + Math.sin(a * 5 - d * t * 0.9 + p * 2) * 9
    + Math.sin(a * 11 + t * 2.4 + p) * (3 + level * 30);
}

function drawReactor(now) {
  // (the first frame's timestamp can be earlier than t0; negative time would break the spray buckets)
  const t = Math.max(0, (now - t0) / 1000);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const W = UNITS, c = W / 2;
  const target = COLORS[state] || COLORS.idle;
  col = col.map((v, i) => v + (target[i] - v) * 0.06);
  const [r, g, b] = col.map(Math.round);
  const rgba = (a) => `rgba(${r},${g},${b},${a})`;
  const [lr, lg, lb] = col.map((v) => Math.round(v + (255 - v) * 0.65));
  const light = (a) => `rgba(${lr},${lg},${lb},${a})`;

  let want;
  if (state === "speaking") want = voiceLevel(t);
  else if (state === "thinking") want = 0.35 + 0.2 * Math.sin(t * 6);
  else if (state === "listening") want = 0.18 + 0.07 * Math.sin(t * 2.4);
  else want = 0.08 + 0.03 * Math.sin(t * 1.2);
  level += (want - level) * 0.18;
  spin += dt * (state === "thinking" ? 1.4 : 0.35 + level * 0.8);

  ctx.clearRect(0, 0, W, W);
  ctx.globalCompositeOperation = "source-over";

  // ambient glow
  const glow = ctx.createRadialGradient(c, c, 80, c, c, 590);
  glow.addColorStop(0, rgba(0.22 + level * 0.2));
  glow.addColorStop(1, rgba(0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, W);

  ctx.globalCompositeOperation = "lighter";

  // particle wave rings
  // (one path per ring: thousands of fillRect calls are too slow)
  RINGS.forEach((ring, k) => {
    ctx.fillStyle = rgba(0.5 + level * 0.35 - k * 0.08);
    ctx.beginPath();
    for (const pt of ring.pts) {
      const a = pt.a + ring.dir * t * 0.05;
      const rad = waveRadius(ring, a, t) + pt.o * (1 + level * 1.5);
      ctx.rect(c + Math.cos(a) * rad, c + Math.sin(a) * rad, 2.8, 2.8);
    }
    ctx.fill();
  });
  // spray fading outwards, drawn in four alpha steps
  const sprayPaths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  for (const sp of SPRAY) {
    const travel = Math.max(0, (sp.r0 + t * 18 * sp.s * (1 + level * 3)) % 100);
    const rad = 470 + travel;
    sprayPaths[Math.min(3, Math.floor(travel / 25))]
      .rect(c + Math.cos(sp.a + t * 0.02) * rad, c + Math.sin(sp.a + t * 0.02) * rad, 2, 2);
  }
  sprayPaths.forEach((path, i) => {
    ctx.fillStyle = rgba((1 - i / 4) * (0.35 + level * 0.4));
    ctx.fill(path);
  });

  // block ring
  const blocks = 60, gap = TAU / blocks;
  for (let i = 0; i < blocks; i++) {
    const a0 = i * gap + t * 0.03 - Math.PI / 2;
    const wave = 0.5 + 0.5 * Math.sin(i * 0.45 - t * 1.6);
    const br = 0.12 + wave * 0.32 + level * 0.35 + (i % 15 === 0 ? 0.2 : 0);
    ctx.beginPath();
    ctx.arc(c, c, 388, a0, a0 + gap * 0.72);
    ctx.arc(c, c, 318 - wave * level * 20, a0 + gap * 0.72, a0, true);
    ctx.closePath();
    ctx.fillStyle = rgba(br * 0.55);
    ctx.fill();
    ctx.strokeStyle = rgba(Math.min(1, br + 0.15));
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // honeycomb band
  ctx.strokeStyle = rgba(0.16 + level * 0.15);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const [radius, size, offset] of [[292, 9, 0], [274, 9, 0.5]]) {
    const n = Math.floor((TAU * radius) / (size * 1.8));
    for (let i = 0; i < n; i++) {
      const a = ((i + offset) / n) * TAU - t * 0.05;
      const hx = c + Math.cos(a) * radius, hy = c + Math.sin(a) * radius;
      for (let j = 0; j < 6; j++) {
        const ha = (j / 6) * TAU + a;
        ctx[j ? "lineTo" : "moveTo"](hx + Math.cos(ha) * size, hy + Math.sin(ha) * size);
      }
      ctx.closePath();
    }
  }
  ctx.stroke();

  // glowing core inside the sphere (petals and lenses, clipped to the sphere)
  const Rs = 205 * (1 + level * 0.08);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, Rs, 0, TAU);
  ctx.clip();
  const body = ctx.createRadialGradient(c, c, 0, c, c, Rs);
  body.addColorStop(0, rgba(0.55));
  body.addColorStop(0.7, rgba(0.18));
  body.addColorStop(1, rgba(0.32));
  ctx.fillStyle = body;
  ctx.fillRect(c - Rs, c - Rs, Rs * 2, Rs * 2);
  const breathe = 1 + level * 0.25 + Math.sin(t * 1.5) * 0.03;
  const orb = config.avatar === "orb";
  if (orb) {
    // glowing orb: overlapping translucent lenses that slowly turn and breathe (no wireframe)
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(Math.sin(t * 0.4) * 0.25);
    const lens = (x, y, rx, ry, fill, edge) => {
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
      ctx.fillStyle = rgba(fill);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = light(edge);
      ctx.stroke();
    };
    const sway = Math.sin(t * 0.9) * 0.04;
    for (const k of [-1, 1]) {
      lens(0, k * Rs * (0.42 + sway), Rs * 0.52 * breathe, Rs * 0.5, 0.2, 0.4);           // big top / bottom lenses
      lens(k * Rs * (0.4 - sway), 0, Rs * 0.55, Rs * 0.72 * breathe, 0.12, 0.25);        // side lenses
      lens(k * Rs * 0.32, k * Rs * 0.32, Rs * 0.38, Rs * 0.38, 0.08, 0.18);               // diagonal lenses
      lens(0, k * Rs * 0.2, Rs * 0.13 * breathe, Rs * 0.2, 0.45 + level * 0.3, 0.7);      // bright inner lobes
    }
    ctx.restore();
  } else for (const k of [-1, 1]) {
    ctx.fillStyle = rgba(0.3);
    ctx.strokeStyle = light(0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(c, c + k * Rs * 0.42, Rs * 0.42 * breathe, Rs * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba(0.1);
    ctx.beginPath();
    ctx.ellipse(c + k * Rs * 0.48, c, Rs * 0.5, Rs * 0.78 * breathe, 0, 0, TAU);
    ctx.fill();
  }
  const beam = ctx.createLinearGradient(c - 40, 0, c + 40, 0);
  beam.addColorStop(0, rgba(0));
  beam.addColorStop(0.5, light(0.55 + level * 0.4));
  beam.addColorStop(1, rgba(0));
  ctx.fillStyle = beam;
  ctx.fillRect(c - 40, c - Rs, 80, Rs * 2);
  const hot = ctx.createRadialGradient(c, c, 0, c, c, 70 * breathe);
  hot.addColorStop(0, "rgba(255,255,255,1)");
  hot.addColorStop(0.3, light(0.9));
  hot.addColorStop(1, rgba(0));
  ctx.fillStyle = hot;
  ctx.beginPath();
  ctx.arc(c, c, 70 * breathe, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  for (let y = c - Rs; y < c + Rs; y += 6) ctx.fillRect(c - Rs, y, Rs * 2, 2);  // scanlines
  ctx.restore();

  // geodesic wireframe
  ctx.globalCompositeOperation = "lighter";
  if (!orb) {
    const ry = spin, rx = 0.35 + Math.sin(t * 0.4) * 0.12;
    const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    const proj = SPHERE.verts.map(([x, y, z]) => {
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
      const y2 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
      return [c + x1 * Rs, c + y2 * Rs, z2];
    });
    ctx.lineWidth = 1.6;
    for (const front of [false, true]) {
      ctx.strokeStyle = front ? light(0.75 + level * 0.25) : rgba(0.18);
      ctx.beginPath();
      for (const [a, bIdx] of SPHERE.edges) {
        const pa = proj[a], pb = proj[bIdx];
        if ((pa[2] + pb[2] > 0) !== front) continue;
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
      }
      ctx.stroke();
    }
  }

  // sphere rim
  ctx.globalCompositeOperation = "source-over";
  // (soft halo via wide translucent strokes - shadowBlur is expensive every frame)
  const rim = orb ? [[20, 0.1], [9, 0.3], [3, 0.55]] : [[22, 0.12], [12, 0.25], [5, 0.95]];
  for (const [w, a] of rim) {
    ctx.strokeStyle = a > 0.5 ? light(a) : rgba(a);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(c, c, Rs + 8, 0, TAU);
    ctx.stroke();
  }

  requestAnimationFrame(drawReactor);
}
requestAnimationFrame(drawReactor);

config.avatar = "orb";
Object.assign(COLORS, PALETTES.pink);
col = [...COLORS.idle];

// =====================================================================
// UI-Helfer
// =====================================================================

const LABELS = { idle: "STANDBY", listening: "ICH HÖRE ZU", thinking: "ANALYSIERE", speaking: "JARVIS SPRICHT", error: "FEHLER" };
function setState(s) { state = s; $("status").textContent = LABELS[s] || s.toUpperCase(); }
function warn(text) { $("warn").hidden = !text; $("warn").textContent = text || ""; }
function toast(text) {
  $("toast").textContent = text; $("toast").hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { $("toast").hidden = true; }, 2200);
}
let typeTimer = null;
function typeCaption(text) {
  clearInterval(typeTimer);
  const el = $("caption"); el.textContent = ""; let i = 0;
  typeTimer = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typeTimer); }, 18);
}
function showLinks(links) {
  $("links").replaceChildren(...links.map(({ url, label }) => {
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label + " ↗"; return a;
  }));
}
function tickClock() { $("clock").textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
setInterval(tickClock, 1000); tickClock();

// =====================================================================
// Ton: ein Audio-Element für alles, beim ersten Tippen freigeschaltet
// =====================================================================

const player = new Audio();
player.playsInline = true;
player.setAttribute("playsinline", "");
let audioCtx = null, analyser = null, freq = new Uint8Array(128);
let browserSpeaking = false;
let audioUnlocked = false;
const SILENCE = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYZ0lc4QAAAAAAAAAAAAAAAAAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQZB4P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(player);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    freq = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (_) { audioCtx = null; analyser = null; }
}

// Beim allerersten Tippen: AudioContext fortsetzen, Audio-Element und Sprachausgabe einmal anstoßen.
// Danach darf Safari auch ohne weiteres Tippen abspielen.
async function unlockAudio() {
  if (audioUnlocked) return;
  ensureAudioGraph();
  try { if (audioCtx && audioCtx.state !== "running") await audioCtx.resume(); } catch (_) {}
  try {
    if (player.paused && !player.src.startsWith("blob:")) { player.src = SILENCE; await player.play(); player.pause(); }
  } catch (_) {}
  try { if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } } catch (_) {}
  audioUnlocked = !audioCtx || audioCtx.state === "running";
}
document.addEventListener("pointerdown", () => { unlockAudio(); }, { capture: true });

// Großer Hinweis: wartet auf ein Tippen. onTap läuft direkt im Tipp-Moment (Safari erlaubt Ton nur dort).
function waitForTap(text = "Tippen, um Jarvis zu hören", onTap = null) {
  return new Promise((resolve) => {
    $("unlock").querySelector(".unlock-text").textContent = text;
    $("unlock").hidden = false;
    $("unlock").onclick = () => {
      $("unlock").hidden = true;
      ensureAudioGraph();
      const resumed = audioCtx && audioCtx.state !== "running" ? audioCtx.resume().catch(() => {}) : Promise.resolve();
      let started = Promise.resolve();
      if (onTap) { try { started = Promise.resolve(onTap()); } catch (e) { started = Promise.reject(e); } }   // synchron im selben Tipp
      resumed.then(() => {});
      started.catch(() => {}).then(() => { audioUnlocked = true; resolve(); });
    };
  });
}

async function playMp3(blob) {
  ensureAudioGraph();
  player.src = URL.createObjectURL(blob);
  // Ende-Listener vor dem Abspielen setzen, damit kein "ended" verloren geht
  const ended = new Promise((resolve) => { player.onended = resolve; player.onerror = resolve; player.onpause = resolve; });
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  try {
    await player.play();
  } catch (err) {
    if (err.name !== "NotAllowedError") throw err;
    let playing = Promise.resolve();
    await waitForTap("Tippen, um Jarvis zu hören", () => { playing = player.play(); return playing; });
    try { await playing; } catch (_) { return; }
  }
  audioUnlocked = true;
  await ended;
}

function germanVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("de"));
  return voices.find((v) => /premium|enhanced|erweitert/i.test(v.name)) || voices.find((v) => /Martin|Markus|Yannick|Viktor/i.test(v.name)) || voices[0];
}

async function browserSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = config.language;
  const v = germanVoice(); if (v) u.voice = v;
  await new Promise((resolve) => {
    let started = false;
    const done = () => { browserSpeaking = false; resolve(); };
    u.onstart = () => { started = true; };
    u.onend = done; u.onerror = done;
    const go = () => { speechSynthesis.cancel(); browserSpeaking = true; speechSynthesis.speak(u); };
    if (audioUnlocked) go();
    else waitForTap("Tippen, um Jarvis zu hören", go);       // Sprachausgabe schweigt ohne vorheriges Tippen
    setTimeout(() => { if (browserSpeaking && !speechSynthesis.speaking) done(); }, 4000 + text.length * 110);
  });
}

async function elevenlabs(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenlabs_voice_id || DEFAULTS.elevenlabs_voice_id)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabs_api_key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: config.elevenlabs_model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  return res.blob();
}

async function speak(text) {
  setState("speaking");
  try {
    if (config.elevenlabs_api_key) { await playMp3(await elevenlabs(text)); return; }
  } catch (e) {
    if (e.name === "NotAllowedError") return;
    warn("Stimme: " + e.message + " – nutze die iPad-Stimme.");
  }
  await browserSpeak(text);
}

function stopSpeaking() {
  player.pause();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// =====================================================================
// Wetter, Aufgaben, Team-Cockpit
// =====================================================================

const WMO = { 0: "klar", 1: "überwiegend klar", 2: "teils bewölkt", 3: "bewölkt", 45: "neblig", 48: "neblig", 51: "leichter Niesel", 53: "Niesel",
  55: "starker Niesel", 61: "leichter Regen", 63: "Regen", 65: "starker Regen", 71: "leichter Schnee", 73: "Schnee", 75: "starker Schnee",
  80: "Schauer", 81: "Schauer", 82: "heftige Schauer", 95: "Gewitter", 96: "Gewitter mit Hagel", 99: "Gewitter mit Hagel" };
let weatherCache = { at: 0, city: "", data: null };

async function getWeatherData(city) {
  if (weatherCache.city === city && Date.now() - weatherCache.at < 10 * 60 * 1000) return weatherCache.data;
  const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de`)).json();
  const loc = geo.results && geo.results[0];
  if (!loc) throw new Error(`Stadt „${city}“ nicht gefunden`);
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}`
    + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1")).json();
  const data = {
    city: loc.name, temp: Math.round(w.current.temperature_2m), feels: Math.round(w.current.apparent_temperature),
    desc: WMO[w.current.weather_code] || "wechselhaft", wind: Math.round(w.current.wind_speed_10m),
    max: Math.round(w.daily.temperature_2m_max[0]), min: Math.round(w.daily.temperature_2m_min[0]), rain: w.daily.precipitation_probability_max[0],
  };
  weatherCache = { at: Date.now(), city, data };
  return data;
}
async function weatherText(city) {
  try {
    const d = await getWeatherData(city || config.city);
    return `${d.city}: ${d.temp} °C, gefühlt ${d.feels} °C, ${d.desc}. Heute ${d.min} bis ${d.max} °C, Regenrisiko ${d.rain ?? "?"} %, Wind ${d.wind} km/h.`;
  } catch (e) { return `Wetter nicht verfügbar (${e.message}).`; }
}
async function refreshWeatherChip() {
  if (!config.city) { $("weatherChip").textContent = ""; return; }
  try { const d = await getWeatherData(config.city); $("weatherChip").textContent = `${d.city} · ${d.temp} °C · ${d.desc}`; } catch (_) {}
}

// Lokale Aufgaben (auf dem iPad gespeichert)
function openTasks() { return config.tasks.filter((t) => !t.done); }
function tasksText() {
  const open = openTasks();
  return open.length ? `Lokale Aufgaben (${open.length}):\n` + open.map((t) => `- ${t.text}`).join("\n") : "Keine lokalen Aufgaben.";
}

// Team-Cockpit (Supabase-RPCs wie jarvis/cockpit.py)
const RANK = { late: 0, woche: 1, monat: 2, quartal: 3, spaeter: 4 };
const HORIZON_DE = { late: "überfällig", woche: "diese Woche", monat: "diesen Monat", quartal: "dieses Quartal", spaeter: "später" };
let boardCache = { at: 0, data: null };
const cockpitOn = () => !!(config.cockpit.supabase_url && config.cockpit.anon_key && config.cockpit.team_code);

async function rpc(fn, args = {}) {
  const c = config.cockpit;
  const res = await fetch(`${c.supabase_url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: c.anon_key, Authorization: `Bearer ${c.anon_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: c.team_code, ...args }),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    let msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    if (msg === "falscher_code") msg = "Der Team-Code stimmt nicht.";
    if (msg === "permission_denied") msg = "Mit diesem Team-Code gibt es nur Leserechte.";
    throw new Error(msg);
  }
  return data;
}
async function board(fresh = false) {
  if (!fresh && boardCache.data && Date.now() - boardCache.at < 20000) return boardCache.data;
  boardCache = { at: Date.now(), data: (await rpc("board_get")) || {} };
  return boardCache.data;
}
function bucket(t) {
  if (t.due) {
    const days = Math.round((new Date(t.due.slice(0, 10)) - new Date(new Date().toDateString())) / 86400000);
    if (isNaN(days)) return "spaeter";
    return days < 0 ? "late" : days <= 7 ? "woche" : days <= 31 ? "monat" : days <= 105 ? "quartal" : "spaeter";
  }
  return RANK[t.horizon] !== undefined && t.horizon !== "late" ? t.horizon : "spaeter";
}
function nameOf(b, who) { return ({ olivia: "Olivia", arbon: "Arbon", ...(b.names || {}) })[who || ""] || who || "jemand"; }
async function cockpitTasks(project = "", mineOnly = false) {
  const b = await board();
  const names = Object.fromEntries((b.projects || []).map((p) => [p.id, p.name || p.id]));
  const want = project.trim().toLowerCase();
  return (b.tasks || []).filter((t) => t.status !== "erledigt").map((t) => ({ ...t, project: t.project || "blynk" }))
    .filter((t) => !want || [t.project.toLowerCase(), (names[t.project] || "").toLowerCase()].includes(want))
    .filter((t) => !mineOnly || [config.cockpit.who, "beide", null, undefined, ""].includes(t.owner))
    .map((t) => ({ ...t, project_name: names[t.project] || t.project, bucket: bucket(t) }))
    .sort((a, b2) => RANK[a.bucket] - RANK[b2.bucket] || String(a.due || "9").localeCompare(String(b2.due || "9")));
}
async function cockpitTasksText(project = "", mineOnly = false, limit = 15) {
  const b = await board(), tasks = await cockpitTasks(project, mineOnly);
  if (!tasks.length) return "Keine offenen Cockpit-Aufgaben" + (project ? ` für ${project}.` : ".");
  return `Offene Cockpit-Aufgaben (${tasks.length}):\n` + tasks.slice(0, limit).map((t) =>
    `- [${t.id}] ${t.title} (${t.project_name}, ${HORIZON_DE[t.bucket]}${t.due ? ", fällig " + t.due : ""}${t.owner ? ", " + nameOf(b, t.owner) : ""})`).join("\n");
}
async function messages(limit = 5) {
  const b = await board();
  return [...(b.messages || [])].sort((x, y) => String(x.at || "").localeCompare(String(y.at || ""))).slice(-limit).map((m) => ({ ...m, name: nameOf(b, m.who) }));
}
async function newMessagesText() {
  const all = await messages(20);
  const fresh = all.filter((m) => String(m.at || "") > (config.last_seen_message || "") && m.who !== config.cockpit.who);
  return { text: fresh.length ? "Neue Team-Nachrichten:\n" + fresh.map((m) => `- ${m.name}: ${m.text}`).join("\n") : "Keine neuen Team-Nachrichten.",
    newest: all.length ? String(all[all.length - 1].at || "") : config.last_seen_message };
}
async function resolveProject(project) {
  const b = await board(), want = project.trim().toLowerCase();
  const p = (b.projects || []).find((x) => [String(x.id).toLowerCase(), String(x.name || "").toLowerCase()].includes(want));
  if (!p) throw new Error(`Projekt „${project}“ gibt es nicht. Vorhanden: ${(b.projects || []).map((x) => x.name).join(", ")}`);
  return p.id;
}

// HUD-Panels
async function renderPanels() {
  const local = openTasks();
  let rows = local.map((t) => ({ text: t.text, tag: "iPad" }));
  if (cockpitOn()) {
    try {
      const ct = await cockpitTasks("", true);
      rows = ct.slice(0, 8).map((t) => ({ text: t.title, tag: t.project_name, late: t.bucket === "late" })).concat(rows);
      const msgs = await messages(3);
      $("chatPanel").hidden = !msgs.length;
      $("chat").replaceChildren(...msgs.map((m) => { const li = document.createElement("li"); const b = document.createElement("span"); b.className = "tag"; b.textContent = m.name; li.append(b, document.createTextNode(" " + m.text)); return li; }));
    } catch (e) { warn("Cockpit: " + e.message); }
  }
  $("taskCount").textContent = rows.length ? `(${rows.length})` : "";
  if (!rows.length) { $("tasks").innerHTML = '<li class="muted">Keine offenen Aufgaben.</li>'; return; }
  $("tasks").replaceChildren(...rows.slice(0, 10).map((r) => {
    const li = document.createElement("li"); const tag = document.createElement("span"); tag.className = "tag" + (r.late ? " late" : ""); tag.textContent = r.tag;
    li.append(tag, document.createTextNode(" " + r.text)); return li;
  }));
}

// =====================================================================
// Gehirn: Claude direkt aus dem Browser, mit Werkzeugen
// =====================================================================

const tool = (name, description, properties = {}, required = []) =>
  ({ name, description, input_schema: { type: "object", properties, required, additionalProperties: false } });
const S = { type: "string" };
const TOOLS = [
  tool("get_weather", "Aktuelles Wetter und heutige Vorhersage für eine Stadt. Ohne andere Angabe die Heimatstadt.", { city: S }, ["city"]),
  tool("get_tasks", "Die lokalen Aufgaben auf dem iPad."),
  tool("add_task", "Eine lokale Aufgabe auf dem iPad anlegen.", { text: S }, ["text"]),
  tool("complete_task", "Eine lokale Aufgabe abhaken (Text oder Teil davon).", { text: S }, ["text"]),
  tool("open_website", "Einen Link als Button anzeigen, den der Nutzer antippt (z. B. Gmail, Dashboard).", { url: S, label: S }, ["url", "label"]),
  tool("open_google_search", "Eine Google-Suche als Button anzeigen, wenn der Nutzer die Ergebnisse selbst sehen will.", { query: S }, ["query"]),
  tool("youtube_search", "Eine YouTube-Suche als Button anzeigen.", { query: S }, ["query"]),
  tool("play_spotify", "Einen Spotify-Link als Button anzeigen (Song, Album, Playlist).", { link: S, label: S }, ["link", "label"]),
];
const COCKPIT_TOOLS = [
  tool("get_cockpit_overview", "Alle Projekte im Startup-Cockpit mit Status, nächstem Schritt und offenen Aufgaben."),
  tool("get_cockpit_tasks", "Offene Cockpit-Aufgaben, dringendste zuerst, mit IDs. project leer = alle; mine_only=true für eigene.",
    { project: S, mine_only: { type: "boolean" } }, ["project", "mine_only"]),
  tool("add_cockpit_task", "Aufgabe im Cockpit anlegen. due als YYYY-MM-DD oder leer; owner = olivia, arbon, beide oder leer.",
    { project: S, title: S, due: S, detail: S, owner: S }, ["project", "title", "due", "detail", "owner"]),
  tool("complete_cockpit_task", "Cockpit-Aufgabe per ID (aus get_cockpit_tasks) erledigen.", { task_id: S }, ["task_id"]),
  tool("get_team_messages", "Die letzten Nachrichten im Team-Chat."),
  tool("post_team_message", "Nachricht in den Team-Chat posten (das ganze Team sieht sie). project optional.", { text: S, project: S }, ["text", "project"]),
  tool("get_app_numbers", "Live-Zahlen der BLYNK-App."),
];
const WEB_SEARCH = () => ({ type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: { type: "approximate", city: config.city || "Bad Kissingen", country: "DE" } });

function systemPrompt() {
  const c = config;
  const about = c.about_me ? `Über ${c.user_name || "den Nutzer"}: ${c.about_me}\n\n` : "";
  const cockpit = cockpitOn() ? "Startup-Cockpit: Du bist mit dem Team-Cockpit verbunden (Projekte, Aufgaben, Team-Chat, BLYNK-App-Zahlen). "
    + "Lies es, statt zu raten. Änderungen sieht das ganze Team: Lege Aufgaben nur an, erledige sie oder poste nur, wenn der Nutzer es klar sagt, "
    + "und bestätige in einem Satz. Hol vor dem Erledigen die ID mit get_cockpit_tasks.\n\n" : "";
  return `Du bist J.A.R.V.I.S., der persönliche KI-Assistent von ${c.user_name || "deinem Nutzer"}, inspiriert von Tony Starks Jarvis: ruhig, kompetent, loyal, mit trockenem britischem Witz. Sprich den Nutzer mit „${c.salutation || "Sir"}“ an.

${about}Antworte immer auf Deutsch. Alles wird vorgelesen: schreib schlichte gesprochene Sätze, kein Markdown, keine Listen, keine Emojis, keine URLs vorlesen. Meist ein bis drei Sätze. Schreib niemals Regieanweisungen oder Tags in Klammern wie [sarkastisch] oder (lacht).

Du läufst auf einem iPad im Browser. Du kannst keine Apps starten und den Bildschirm nicht sehen. Links (Websites, Google, YouTube, Spotify) zeigst du mit deinen Werkzeugen als Button an, den der Nutzer antippt; sag kurz, dass er tippen soll. Behaupte nie, etwas getan zu haben, wofür du kein Werkzeug hast.

Internet: Bei allem Aktuellen (Nachrichten, Preise, Ergebnisse, Öffnungszeiten, Personen) nutze web_search selbst und antworte aus den Ergebnissen in wenigen gesprochenen Sätzen, ohne Quellen vorzulesen. Für „Nachrichten“ oder „was gibt's Neues“: drei bis vier wichtige Meldungen, je ein Satz.

${cockpit}Heimatstadt: ${c.city || "unbekannt"}.`;
}

let history = [];
function tools() { return [...TOOLS, ...(cockpitOn() ? COCKPIT_TOOLS : []), WEB_SEARCH()]; }

async function callClaude(messagesList) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropic_api_key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.model || DEFAULTS.model, max_tokens: 2048, system: systemPrompt(), tools: tools(), messages: messagesList }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("Anthropic-API-Key fehlt oder ist ungültig. Bitte in den Einstellungen prüfen.");
    if (res.status === 429) throw new Error("Zu viele Anfragen an Claude. Gleich nochmal versuchen.");
    throw new Error("Claude: " + msg);
  }
  return data;
}

let pendingLinks = [];
async function runTool(name, a) {
  switch (name) {
    case "get_weather": return weatherText(a.city);
    case "get_tasks": return tasksText();
    case "add_task": { const t = String(a.text || "").trim(); if (!t) throw new Error("leer"); config.tasks.push({ id: Date.now(), text: t, done: false }); save(); renderPanels(); return `Aufgabe „${t}“ angelegt.`; }
    case "complete_task": {
      const q = String(a.text || "").toLowerCase(), hit = openTasks().find((t) => t.text.toLowerCase().includes(q));
      if (!hit) return "Keine passende Aufgabe. Offen: " + openTasks().map((t) => t.text).join(", ");
      hit.done = true; save(); renderPanels(); return `„${hit.text}“ erledigt.`;
    }
    case "open_website": { let u = String(a.url || ""); if (!/^https?:\/\//.test(u)) u = "https://" + u; pendingLinks.push({ url: u, label: a.label || u }); return "Button angezeigt."; }
    case "open_google_search": pendingLinks.push({ url: "https://www.google.com/search?q=" + encodeURIComponent(a.query), label: "Google: " + a.query }); return "Button angezeigt.";
    case "youtube_search": pendingLinks.push({ url: "https://www.youtube.com/results?search_query=" + encodeURIComponent(a.query), label: "YouTube: " + a.query }); return "Button angezeigt.";
    case "play_spotify": pendingLinks.push({ url: a.link, label: a.label || "Spotify" }); return "Button angezeigt.";
    case "get_cockpit_overview": {
      const b = await board(), tasks = await cockpitTasks();
      return "Projekte im Cockpit:\n" + (b.projects || []).map((p) => { const o = tasks.filter((t) => t.project === p.id);
        return `- ${p.name} (${p.id}): Status ${p.status || "-"}; nächster Schritt: ${p.next || "-"}; ${o.length} offen (${o.filter((t) => t.bucket === "late").length} überfällig, ${o.filter((t) => t.bucket === "woche").length} diese Woche)`; }).join("\n");
    }
    case "get_cockpit_tasks": return cockpitTasksText(a.project || "", !!a.mine_only);
    case "add_cockpit_task": {
      const pid = await resolveProject(a.project);
      await rpc("board_task_add", { p_who: config.cockpit.who, p_project: pid, p_title: String(a.title).trim(), p_done_when: a.detail || null,
        p_owner: (a.owner || "").toLowerCase() || null, p_due: a.due || null, p_horizon: a.due ? null : "monat" });
      boardCache.at = 0; renderPanels(); return `Aufgabe „${a.title}“ angelegt.`;
    }
    case "complete_cockpit_task": {
      const t = ((await board()).tasks || []).find((x) => String(x.id) === String(a.task_id));
      if (!t) throw new Error(`Keine Aufgabe mit ID ${a.task_id}.`);
      await rpc("board_set_status", { p_id: t.id, p_status: "erledigt", p_who: config.cockpit.who });
      boardCache.at = 0; renderPanels(); return `„${t.title}“ ist erledigt.`;
    }
    case "get_team_messages": { const m = await messages(5); return m.length ? m.map((x) => `- ${x.name}: ${x.text}`).join("\n") : "Keine Team-Nachrichten."; }
    case "post_team_message": {
      await rpc("board_post_to", { p_who: config.cockpit.who, p_text: String(a.text).trim(), p_project: a.project ? await resolveProject(a.project) : null });
      boardCache.at = 0; return "Nachricht gepostet.";
    }
    case "get_app_numbers": { const k = (await rpc("board_kpis")) || {}; return "BLYNK-App: " + Object.entries(k).map(([x, v]) => `${x}: ${v}`).join(", "); }
  }
  throw new Error("Unbekanntes Werkzeug " + name);
}

async function ask(text) {
  if (!config.anthropic_api_key) throw new Error("Kein Anthropic-API-Key. Tippe oben rechts auf Einstellungen.");
  if (history.length > 60) {
    const recap = history.filter((m) => typeof m.content === "string").slice(-12).map((m) => `${m.role}: ${m.content.slice(0, 400)}`).join("\n");
    history = []; text = "Zusammenfassung unseres bisherigen Gesprächs:\n" + recap + "\n\n" + text;
  }
  const stamp = new Date().toLocaleString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  history.push({ role: "user", content: `[${stamp}] ${text}` });
  try {
    for (let round = 0; round < 8; round++) {
      const r = await callClaude(history);
      history.push({ role: "assistant", content: r.content });
      if (r.stop_reason === "pause_turn") continue;
      if (r.stop_reason !== "tool_use") return r.content.filter((b) => b.type === "text").map((b) => b.text).join("").replace(/\[[^\]]{1,30}\]/g, "").trim();
      const results = [];
      for (const b of r.content) {
        if (b.type !== "tool_use") continue;
        try { results.push({ type: "tool_result", tool_use_id: b.id, content: String(await runTool(b.name, b.input || {})) }); }
        catch (e) { results.push({ type: "tool_result", tool_use_id: b.id, content: "Fehler: " + e.message, is_error: true }); }
      }
      history.push({ role: "user", content: results });
    }
    return "Das hat mehr Schritte gebraucht als gedacht. Versuch es bitte noch einmal.";
  } catch (e) { history = []; throw e; }
}

async function greetPrompt() {
  const weather = config.city ? await weatherText(config.city) : "Keine Stadt eingestellt.";
  let tasks = tasksText(), newest = null;
  if (cockpitOn()) {
    try {
      const nm = await newMessagesText(); newest = nm.newest;
      tasks = [await cockpitTasksText("", true, 10), nm.text, tasks].join("\n\n");
    } catch (e) { tasks += `\n(Cockpit nicht erreichbar: ${e.message})`; }
  }
  const prompt = "[Ereignis: Der Nutzer hat dich gerade aktiviert.] Begrüße ihn:\n"
    + "- passend zur Tageszeit und kreativ, nicht jeden Tag gleich.\n"
    + "- Ein kurzer Satz zum Wetter: Temperatur, ob sonnig, klar, bewölkt oder Regen, und wie es sich anfühlt. Keine Luftfeuchtigkeit.\n"
    + "- Die offenen Aufgaben in einem Satz als Überblick, nicht einzeln vorlesen; Überfälliges oder diese Woche Fälliges erwähnen.\n"
    + "- Wenn es neue Team-Nachrichten gibt, in einem halben Satz erwähnen, von wem.\n"
    + "- Am Ende fragen, womit ihr anfangt. Alles unter 70 Wörtern.\n\n"
    + `Wetter: ${weather}\n\n${tasks}`;
  return { prompt, newest };
}

// =====================================================================
// Ablauf: Wecken → Begrüßen → Zuhören → Antworten → … → Standby
// =====================================================================

const ACTIVATE = /\b(jarvis|davis|jervis|jarviz)\b.{0,12}\b(activate|aktivier\w*|wake up|wach auf)\b/i;

async function handle(text, { greeting = false } = {}) {
  if (busy) return;
  busy = true;
  stopRecognition();
  stopClap();
  pendingLinks = []; showLinks([]);
  if (text && !greeting) $("you").textContent = "„" + text + "“";
  setState("thinking");
  try {
    let reply;
    if (greeting) {
      const g = await greetPrompt();
      reply = await ask(g.prompt);
      if (g.newest) { config.last_seen_message = g.newest; save(); }
    } else {
      reply = await ask(text);
    }
    showLinks(pendingLinks);
    typeCaption(reply);
    await speak(reply);
    warn("");
  } catch (err) {
    setState("error");
    $("caption").textContent = err.message === "Failed to fetch" ? "Keine Verbindung. Ist das iPad online?" : err.message;
    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    busy = false;
    renderPanels();
    if (conversation) listen(); else goStandby();
  }
}

function send(text) { ACTIVATE.test(text) ? wake() : handle(text); }

function wake() {
  conversation = true;
  handle(null, { greeting: true });
}

function goStandby() {
  conversation = false;
  stopRecognition();
  setState("idle");
  updateMicUi();
  if (config.clap.enabled) startClap();
}

// =====================================================================
// Spracheingabe (Safari-Spracherkennung)
// =====================================================================

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null, recActive = false, heard = false, silentRounds = 0;

function listen() {
  if (!SR) {
    warn("Spracherkennung gibt es in diesem Browser nicht. Tippe unten auf „Tippen“ und nutze das Mikrofon der Tastatur.");
    return goStandby();
  }
  stopClap();                       // Klatsch-Mikro und Spracherkennung stören sich in Safari
  conversation = true;
  heard = false;
  recognition = new SR();
  recognition.lang = config.language;
  recognition.continuous = false;   // Safari ist mit kurzen Runden zuverlässiger
  recognition.interimResults = true;
  recognition.onstart = () => { recActive = true; setState("listening"); updateMicUi(); };
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { const t = r[0].transcript.trim(); if (t) { heard = true; silentRounds = 0; recognition.abort(); send(t); } }
      else interim += r[0].transcript;
    }
    if (interim) $("you").textContent = interim;
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      warn("Spracherkennung blockiert. iPad-Einstellungen → Safari → Mikrofon → Erlauben, und Siri & Diktieren eingeschaltet lassen. Bis dahin: „Tippen“.");
      conversation = false;
    }
  };
  recognition.onend = () => {
    recActive = false;
    if (heard || busy) return;                  // Antwort läuft schon
    if (conversation && ++silentRounds < 3) return listen();   // kurz still: weiter zuhören
    silentRounds = 0;
    goStandby();                                // lange still: zurück in den Standby
  };
  try { recognition.start(); } catch (_) { goStandby(); }
}
function stopRecognition() {
  if (recognition) { recognition.onend = null; try { recognition.abort(); } catch (_) {} }
  recognition = null; recActive = false;
}
function updateMicUi() {
  $("micBtn").classList.toggle("on", recActive);
  $("micLabel").textContent = recActive ? "Hört zu" : "Sprechen";
}

// =====================================================================
// Klatsch-Modus: Mikrofon + AnalyserNode, Spitzenpegel pro Frame
// =====================================================================

const detector = new ClapDetector({ threshold: config.clap.threshold });
let clapStream = null, clapSource = null, clapAnalyser = null, clapBuf = null, clapRaf = 0, meterMode = false, meterPeak = 0;
let wakeLock = null;

async function startClap() {
  if (clapStream || busy || recActive) return;
  try {
    clapStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    clapStream = null;
    warn("Kein Mikrofon für den Klatsch-Modus (" + (e.name || e.message) + "). iPad-Einstellungen → Safari → Mikrofon → Erlauben.");
    return;
  }
  if (busy || recActive) { stopClap(); return; }   // inzwischen geweckt
  ensureAudioGraph();
  if (audioCtx.state !== "running") {
    try { await audioCtx.resume(); } catch (_) {}
    if (audioCtx.state !== "running") await waitForTap("Tippen, um den Klatsch-Modus zu starten");
  }
  clapSource = audioCtx.createMediaStreamSource(clapStream);
  clapAnalyser = audioCtx.createAnalyser();
  clapAnalyser.fftSize = 1024;                     // ~21 ms Fenster
  clapAnalyser.smoothingTimeConstant = 0;
  clapBuf = new Float32Array(clapAnalyser.fftSize);
  clapSource.connect(clapAnalyser);                // nicht an die Lautsprecher anschließen
  detector.threshold = config.clap.threshold;
  detector.reset();
  const frame = () => {
    if (!clapAnalyser) return;
    clapAnalyser.getFloatTimeDomainData(clapBuf);
    let peak = 0;
    for (let i = 0; i < clapBuf.length; i++) { const v = Math.abs(clapBuf[i]); if (v > peak) peak = v; }
    peak = Math.min(1, peak);
    meterPeak = Math.max(peak, meterPeak * 0.9);
    if (!$("sheet").hidden) drawMeter(peak);
    const r = detector.feed(peak, performance.now());
    if (r && meterMode) toast(r === "double" ? "Doppelklatschen erkannt" : "Klatscher");
    if (r === "double" && !meterMode && !busy && state !== "speaking") wake();
    clapRaf = requestAnimationFrame(frame);
  };
  clapRaf = requestAnimationFrame(frame);
}

function stopClap() {
  cancelAnimationFrame(clapRaf);
  if (clapSource) try { clapSource.disconnect(); } catch (_) {}
  if (clapStream) clapStream.getTracks().forEach((t) => t.stop());
  clapStream = clapSource = clapAnalyser = null;
}

let meterMax = 0;
function drawMeter(peak) {
  meterMax = Math.max(meterMax * 0.995, peak);
  $("meterFill").style.width = (peak * 100).toFixed(1) + "%";
  $("meterInfo").textContent = `Spitze: ${meterMax.toFixed(2).replace(".", ",")}`;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    warn("Dieses iPad kann den Bildschirm nicht wach halten. Stell unter Einstellungen → Anzeige & Helligkeit → Automatische Sperre auf „Nie“.");
    return;
  }
  try { wakeLock = await navigator.wakeLock.request("screen"); }
  catch (_) { warn("Bildschirm wach halten wurde abgelehnt. Stell die automatische Sperre auf „Nie“."); }
}
function releaseWakeLock() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (config.clap.enabled) { requestWakeLock(); if (!busy && !recActive) startClap(); }
  } else {
    stopClap();               // im Hintergrund kein Mikro
  }
});

function setClapMode(on) {
  config.clap.enabled = on; save();
  $("clapBtn").classList.toggle("on", on);
  $("clapBtn").setAttribute("aria-pressed", String(on));
  $("clapPill").hidden = !on;
  if (on) { requestWakeLock(); if (!busy && !recActive) startClap(); toast("Klatsch-Modus an: zweimal klatschen weckt Jarvis"); }
  else { stopClap(); releaseWakeLock(); toast("Klatsch-Modus aus"); }
}

// =====================================================================
// Bedienung
// =====================================================================

$("micBtn").onclick = () => {
  if (state === "speaking") { stopSpeaking(); return; }
  if (recActive) { conversation = false; goStandby(); return; }
  conversation = true; listen();
};
$("reactorBtn").onclick = () => {
  if (state === "speaking") { stopSpeaking(); return; }
  if (!busy && !recActive) wake();
};
$("clapBtn").onclick = () => setClapMode(!config.clap.enabled);
$("typeBtn").onclick = () => {
  const f = $("typeForm"); f.hidden = !f.hidden; $("typeBtn").classList.toggle("on", !f.hidden);
  if (!f.hidden) { stopRecognition(); $("typeInput").focus(); }
};
$("typeForm").onsubmit = (e) => {
  e.preventDefault(); const t = $("typeInput").value.trim(); if (!t) return;
  $("typeInput").value = ""; $("typeInput").blur(); send(t);
};

// Einstellungen
const FIELDS = { cfgName: "user_name", cfgSalutation: "salutation", cfgCity: "city", cfgAbout: "about_me", cfgAnthropic: "anthropic_api_key",
  cfgModel: "model", cfgEleven: "elevenlabs_api_key", cfgVoice: "elevenlabs_voice_id" };
const CP_FIELDS = { cfgSbUrl: "supabase_url", cfgSbKey: "anon_key", cfgSbCode: "team_code", cfgSbWho: "who" };
const shortcutUrl = () => location.origin + location.pathname + "?activate=1";

function fillSettings() {
  for (const [id, k] of Object.entries(FIELDS)) $(id).value = config[k] || "";
  for (const [id, k] of Object.entries(CP_FIELDS)) $(id).value = config.cockpit[k] || "";
  $("cfgThreshold").value = config.clap.threshold; showThreshold();
  $("shortcutUrl").textContent = shortcutUrl();
}
function showThreshold() {
  const v = Number($("cfgThreshold").value);
  $("thrOut").textContent = v.toFixed(2).replace(".", ",");
  $("meterThr").style.left = v * 100 + "%";
  detector.threshold = v;
}
function readSettings() {
  for (const [id, k] of Object.entries(FIELDS)) config[k] = $(id).value.trim();
  for (const [id, k] of Object.entries(CP_FIELDS)) config.cockpit[k] = $(id).value.trim();
  config.salutation ||= "Sir"; config.model ||= DEFAULTS.model; config.elevenlabs_voice_id ||= DEFAULTS.elevenlabs_voice_id;
  config.clap.threshold = Number($("cfgThreshold").value);
}
$("settingsBtn").onclick = () => { fillSettings(); $("sheet").hidden = false; };
$("closeSettings").onclick = () => { closeSettings(); };
function closeSettings() {
  $("sheet").hidden = true;
  if (meterMode) { meterMode = false; $("meterBtn").textContent = "Pegel testen"; if (!config.clap.enabled) stopClap(); }
}
$("cfgThreshold").oninput = showThreshold;
$("meterBtn").onclick = async () => {
  meterMode = !meterMode;
  $("meterBtn").textContent = meterMode ? "Test beenden" : "Pegel testen";
  meterMax = 0;
  if (meterMode) await startClap(); else if (!config.clap.enabled) stopClap();
};
$("saveSettings").onclick = () => {
  readSettings(); save(); history = []; boardCache.at = 0;
  closeSettings(); toast("Gespeichert"); refreshWeatherChip(); renderPanels();
};
$("copyUrl").onclick = () => copy(shortcutUrl(), "Link kopiert");
$("exportBtn").onclick = () => { readSettings(); save(); copy(btoa(unescape(encodeURIComponent(JSON.stringify(config)))), "Code kopiert – enthält deine Schlüssel, nicht weitergeben"); };
$("importBtn").onclick = () => {
  const ta = $("importText");
  if (ta.hidden) { ta.hidden = false; ta.focus(); $("importBtn").textContent = "Übernehmen"; return; }
  try {
    const c = JSON.parse(decodeURIComponent(escape(atob(ta.value.trim()))));
    config = { ...DEFAULTS, ...c, cockpit: { ...DEFAULTS.cockpit, ...(c.cockpit || {}) }, clap: { ...DEFAULTS.clap, ...(c.clap || {}) }, avatar: "orb" };
    save(); fillSettings(); ta.value = ""; ta.hidden = true; $("importBtn").textContent = "Code einfügen"; toast("Einstellungen übernommen");
  } catch (_) { toast("Der Code ist ungültig"); }
};
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch (_) { toast("Kopieren ging nicht – bitte markieren und kopieren"); }
}

// =====================================================================
// Start
// =====================================================================

(function init() {
  setState("idle");
  $("clapBtn").classList.toggle("on", config.clap.enabled);
  $("clapPill").hidden = !config.clap.enabled;
  refreshWeatherChip(); renderPanels();
  setInterval(refreshWeatherChip, 10 * 60 * 1000);
  setInterval(() => { if (cockpitOn()) { boardCache.at = 0; renderPanels(); } }, 60 * 1000);

  const params = new URLSearchParams(location.search);
  const activate = params.has("activate") || location.hash === "#activate";
  if (activate) history_replace();

  if (!config.anthropic_api_key) {
    typeCaption("Willkommen. Tippe oben rechts auf Einstellungen und trag deinen Anthropic-Schlüssel ein.");
    if (config.clap.enabled) { requestWakeLock(); startClap(); }
    return;
  }
  if (activate) { wake(); return; }                         // Siri-Kurzbefehl: sofort begrüßen
  typeCaption(`Bereit, ${config.salutation}. ${config.clap.enabled ? "Zweimal klatschen, " : ""}auf den Orb tippen oder „Sprechen“.`);
  if (config.clap.enabled) { requestWakeLock(); startClap(); }
})();

function history_replace() {
  // Parameter entfernen, damit ein Neuladen nicht noch einmal begrüßt
  window.history.replaceState(null, "", location.pathname);
}
