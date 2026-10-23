// Jarvis HUD: Chrome speech recognition in, ElevenLabs (or browser) voice out,
// an arc-reactor canvas that reacts to the voice, and live HUD panels.

const $ = (id) => document.getElementById(id);

let config = { language: "de-DE", salutation: "Sir", user_name: "", has_brain: false, has_voice: false };
let sessionId = null;
let micWanted = false;  // the user wants the mic on
let busy = false;       // thinking or speaking: mic is paused so Jarvis doesn't hear himself
let recognition = null;
let state = "idle";

try { sessionId = sessionStorage.getItem("jarvis-session"); } catch (_) {}

// =====================================================================
// Reactor: particle waves, block ring, geodesic sphere with a glowing core
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
  const t = (now - t0) / 1000;
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
    const travel = (sp.r0 + t * 18 * sp.s * (1 + level * 3)) % 100;
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
  for (const k of [-1, 1]) {
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

  // sphere rim
  ctx.globalCompositeOperation = "source-over";
  // (soft halo via wide translucent strokes - shadowBlur is expensive every frame)
  for (const [w, a] of [[22, 0.12], [12, 0.25], [5, 0.95]]) {
    ctx.strokeStyle = a > 0.5 ? light(a) : rgba(a);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(c, c, Rs + 8, 0, TAU);
    ctx.stroke();
  }

  requestAnimationFrame(drawReactor);
}
requestAnimationFrame(drawReactor);

// =====================================================================
// UI helpers
// =====================================================================

const LABELS = { idle: "STANDBY", listening: "ICH HÖRE ZU", thinking: "ANALYSIERE", speaking: "JARVIS SPRICHT", error: "FEHLER" };

function setState(s) {
  state = s;
  $("status").textContent = LABELS[s] || s.toUpperCase();
}

function idleState() {
  setState(micWanted && recognition ? "listening" : "idle");
}

function warn(text) {
  $("warn").hidden = !text;
  $("warn").textContent = text || "";
}

let typeTimer = null;
function typeCaption(text) {
  clearInterval(typeTimer);
  const el = $("caption");
  el.textContent = "";
  const textNode = document.createTextNode("");
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.textContent = "▌";
  el.append(textNode, cursor);
  let i = 0;
  typeTimer = setInterval(() => {
    i += 2;
    textNode.textContent = text.slice(0, i);
    if (i >= text.length) { clearInterval(typeTimer); cursor.remove(); }
  }, 22);
}

function updateMicUi() {
  $("micBtn").classList.toggle("on", micWanted);
  $("micBtn").title = micWanted ? "Mikrofon ausschalten (Leertaste)" : "Mikrofon einschalten (Leertaste)";
  $("stMic").textContent = micWanted ? "AN" : "AUS";
  $("stMic").classList.toggle("off", !micWanted);
}

// =====================================================================
// HUD panels
// =====================================================================

const WEATHER_DE = {
  0: "Klarer Himmel", 1: "Überwiegend klar", 2: "Teilweise bewölkt", 3: "Bedeckt", 45: "Nebel", 48: "Raureifnebel",
  51: "Leichter Niesel", 53: "Nieselregen", 55: "Starker Niesel", 61: "Leichter Regen", 63: "Regen", 65: "Starker Regen",
  66: "Gefrierender Regen", 67: "Gefrierender Regen", 71: "Leichter Schnee", 73: "Schnee", 75: "Starker Schnee",
  77: "Schneegriesel", 80: "Leichte Schauer", 81: "Schauer", 82: "Heftige Schauer", 85: "Schneeschauer",
  86: "Starke Schneeschauer", 95: "Gewitter", 96: "Gewitter mit Hagel", 99: "Gewitter mit Hagel",
};

function tickClock() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
setInterval(tickClock, 1000);
tickClock();

function renderList(el, items, render, emptyText) {
  el.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = emptyText;
    el.append(li);
    return;
  }
  for (const item of items) el.append(render(item));
}

async function loadHud() {
  let hud;
  try { hud = await (await fetch("/api/hud")).json(); } catch (_) { return; }

  const w = hud.weather;
  if (!w && !loadHud.retried) {
    loadHud.retried = true;  // weather is still loading on the server: ask again shortly
    setTimeout(loadHud, 4000);
  }
  if (w) {
    $("wCity").textContent = w.city;
    $("wTemp").textContent = Math.round(w.temp) + "°";
    $("wDesc").textContent = WEATHER_DE[w.code] || w.description;
    $("wRange").textContent = `${Math.round(w.min)}° / ${Math.round(w.max)}° · Regen ${w.rain_chance}%`;
    $("wFeels").textContent = `gefühlt ${Math.round(w.feels_like)}°`;
  }

  renderList($("tasks"), hud.tasks || [], (task) => {
    const li = document.createElement("li");
    li.textContent = task;
    return li;
  }, "Keine offenen Aufgaben");

  renderList($("bookmarks"), Object.entries(hud.bookmarks || {}), ([name, url]) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = name;
    const arrow = document.createElement("span");
    arrow.textContent = "↗";
    a.append(arrow);
    li.append(a);
    return li;
  }, "Keine Lesezeichen");

  $("stWeb").textContent = hud.web_search ? "ONLINE" : "GOOGLE";
  const model = (hud.model || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").toUpperCase();
  $("stBrain").textContent = config.has_brain ? model || "CLAUDE" : "KEIN KEY";
  $("stBrain").classList.toggle("off", !config.has_brain);
}

// =====================================================================
// Voice out
// =====================================================================

const player = new Audio();
let audioCtx = null, analyser = null, freq = new Uint8Array(128);
let browserSpeaking = false;

function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(player);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    freq = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (_) { audioCtx = null; analyser = null; }
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = config.language;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(config.language.slice(0, 2)) && /Google|Conrad|Stefan|male/i.test(v.name));
    if (voice) u.voice = voice;
    browserSpeaking = true;
    u.onend = u.onerror = () => { browserSpeaking = false; resolve(); };
    speechSynthesis.speak(u);
  });
}

function waitForClick() {
  return new Promise((resolve) => {
    $("unlock").hidden = false;
    $("unlockBtn").onclick = () => { $("unlock").hidden = true; resolve(); };
  });
}

async function playMp3(blob) {
  player.src = URL.createObjectURL(blob);
  ensureAudioGraph();
  if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
  try {
    await player.play();
  } catch (err) {
    if (err.name !== "NotAllowedError") throw err;
    await waitForClick();  // autoplay blocked: one click unlocks audio
    if (audioCtx) await audioCtx.resume();
    await player.play();
  }
  await new Promise((resolve) => { player.onended = resolve; player.onerror = resolve; });
}

async function speak(text) {
  setState("speaking");
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.status === 200) {
      await playMp3(await res.blob());
    } else {
      const err = res.headers.get("X-TTS-Error");
      if (err) warn("ElevenLabs: " + err);
      await browserSpeak(text);
    }
  } catch (_) {
    await browserSpeak(text);
  }
}

function stopSpeaking() {
  player.pause();
  player.dispatchEvent(new Event("ended"));
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// =====================================================================
// Talking to the server
// =====================================================================

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Serverfehler ${res.status}`);
  return data;
}

async function handle(path, body, userText, beforeReply) {
  if (busy) return;
  let done = false;
  const before = beforeReply && (async () => { if (!done) { done = true; await beforeReply(); } });
  busy = true;
  pauseRecognition();
  if (userText) $("you").textContent = "„" + userText + "“";
  setState("thinking");
  try {
    const reply = await post(path, body);
    sessionId = reply.session_id;
    try { sessionStorage.setItem("jarvis-session", sessionId); } catch (_) {}
    if (before) await before();
    typeCaption(reply.text);
    await speak(reply.text);
  } catch (err) {
    if (before) await before();
    setState("error");
    $("caption").textContent = err.message === "Failed to fetch" ? "Server nicht erreichbar. Läuft Jarvis?" : err.message;
    await new Promise((r) => setTimeout(r, 1800));
  } finally {
    busy = false;
    idleState();
    resumeRecognition();
    loadHud();
  }
}

// "Jarvis activate" / "Jarvis, aktiviere dich" / "Jarvis wach auf" (Chrome sometimes hears Davis/Jervis)
const ACTIVATE = /\b(jarvis|davis|jervis|jarviz)\b.{0,12}\b(activate|aktivier\w*|wake up|wach auf)\b/i;

const send = (text) =>
  ACTIVATE.test(text) ? handle("/api/greet", {}, text) : handle("/api/chat", { text }, text);

// =====================================================================
// Voice in (Chrome Web Speech API)
// =====================================================================

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    warn("Spracheingabe braucht Google Chrome. Tippen geht trotzdem.");
    return null;
  }
  const r = new SR();
  r.lang = config.language;
  r.continuous = true;
  r.interimResults = true;

  r.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const text = res[0].transcript.trim();
        if (text) send(text);
      } else {
        interim += res[0].transcript;
      }
    }
    if (interim) $("you").textContent = interim;
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      micWanted = false;
      updateMicUi();
      warn("Mikrofon blockiert. Oben in der Adressleiste erlauben und dann MIKRO AN klicken.");
      idleState();
    }
  };
  // Chrome stops after silence; restart while the mic should be on.
  r.onend = () => { if (micWanted && !busy) setTimeout(safeStart, 250); };
  return r;
}

function safeStart() { try { recognition && recognition.start(); } catch (_) { /* already running */ } }
function pauseRecognition() { try { recognition && recognition.abort(); } catch (_) {} }
function resumeRecognition() { if (micWanted) safeStart(); }

function setMic(on) {
  if (!recognition) return;
  micWanted = on;
  updateMicUi();
  if (on && !busy) safeStart(); else pauseRecognition();
  if (!busy) idleState();
}

// =====================================================================
// Controls
// =====================================================================

$("micBtn").onclick = () => setMic(!micWanted);
$("stopBtn").onclick = () => stopSpeaking();
$("reactorBtn").onclick = () => {
  ensureAudioGraph();
  if (audioCtx) audioCtx.resume();
  if (state === "speaking") stopSpeaking(); else setMic(!micWanted);
};
$("typeBtn").onclick = () => {
  const form = $("typeForm");
  form.hidden = !form.hidden;
  $("typeBtn").classList.toggle("on", !form.hidden);
  if (!form.hidden) $("typeInput").focus();
};
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("typeInput").value.trim();
  if (!text) return;
  $("typeInput").value = "";
  send(text);
};
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== $("typeInput")) {
    e.preventDefault();
    setMic(!micWanted);
  }
  if (e.code === "Escape") stopSpeaking();
});

// =====================================================================
// Boot sequence (after the double clap) and start
// =====================================================================

async function bootSequence() {
  const name = (config.user_name || "").toUpperCase();
  const lines = [
    "INITIALISIERE J.A.R.V.I.S. ...........",
    "STELLE VERBINDUNG ZUM NEURALEN NETZ HER ... OK",
    `LADE PROFIL: ${name || "BENUTZER"} ............. OK`,
    "SYNCHRONISIERE PROJEKTE & AUFGABEN ...... OK",
    "KALIBRIERE SPRACHMODUL ................. OK",
    "ALLE SYSTEME ONLINE.",
  ];
  $("boot").hidden = false;
  const log = $("bootLog");
  for (let i = 0; i < lines.length; i++) {
    log.textContent += lines[i] + "\n";
    $("bootBar").style.width = `${((i + 1) / lines.length) * 100}%`;
    await new Promise((r) => setTimeout(r, 380));
  }
}

function endBoot() {
  return new Promise((resolve) => {
    if ($("boot").hidden) return resolve();
    $("boot").classList.add("fade");
    setTimeout(() => { $("boot").hidden = true; resolve(); }, 600);
  });
}

(async function init() {
  try { config = await (await fetch("/api/config")).json(); } catch (_) {}
  Object.assign(COLORS, PALETTES[config.reactor_color] || PALETTES.cyan);
  col = [...COLORS.idle];
  const [ar, ag, ab] = COLORS.idle;
  document.documentElement.style.setProperty("--accent", `rgb(${ar},${ag},${ab})`);
  document.documentElement.style.setProperty("--accent-soft", `rgba(${ar},${ag},${ab},0.35)`);
  $("stVoice").textContent = config.has_voice ? "ELEVENLABS" : "BROWSER";
  if (!config.has_brain) warn("Kein Anthropic-API-Key - bitte setup_wizard.py ausführen.");

  recognition = setupRecognition();
  updateMicUi();
  idleState();
  loadHud();
  setInterval(loadHud, 10 * 60 * 1000);

  const greet = new URLSearchParams(location.search).has("greet");
  if (greet) {
    history.replaceState(null, "", "/");  // don't greet again on reload
    micWanted = !!recognition;            // after the clap, Jarvis keeps listening
    updateMicUi();
    const boot = bootSequence();
    await handle("/api/greet", {}, null, async () => { await boot; await endBoot(); });
  } else {
    typeCaption(`Bereit, ${config.salutation}. Sag „Jarvis activate“ oder stell einfach eine Frage.`);
  }
})();
