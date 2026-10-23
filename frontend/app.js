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
// Reactor
// =====================================================================

const cv = $("reactor");
const ctx = cv.getContext("2d");
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
    idle: [255, 64, 160],
    listening: [255, 105, 185],
    thinking: [255, 196, 92],
    speaking: [255, 150, 210],
    error: [255, 110, 60],
  },
};
const COLORS = { ...PALETTES.cyan };
let col = [...COLORS.idle];
let level = 0;
const t0 = performance.now();

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

function drawReactor(now) {
  const t = (now - t0) / 1000;
  const W = cv.width, c = W / 2;
  const target = COLORS[state] || COLORS.idle;
  col = col.map((v, i) => v + (target[i] - v) * 0.06);
  const [r, g, b] = col.map(Math.round);
  const rgba = (a) => `rgba(${r},${g},${b},${a})`;

  let want;
  if (state === "speaking") want = voiceLevel(t);
  else if (state === "thinking") want = 0.35 + 0.2 * Math.sin(t * 6);
  else if (state === "listening") want = 0.18 + 0.07 * Math.sin(t * 2.4);
  else want = 0.08 + 0.03 * Math.sin(t * 1.2);
  level += (want - level) * 0.18;

  ctx.clearRect(0, 0, W, W);
  ctx.lineCap = "round";

  // glow
  const glow = ctx.createRadialGradient(c, c, 60, c, c, 560);
  glow.addColorStop(0, rgba(0.28 + level * 0.25));
  glow.addColorStop(1, rgba(0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, W);

  // outer tick ring
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(t * 0.05);
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const long = i % 15 === 0;
    const r1 = long ? 498 : 510, r2 = 528;
    ctx.strokeStyle = rgba(long ? 0.9 : 0.35);
    ctx.lineWidth = long ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    ctx.stroke();
  }
  ctx.restore();

  // segmented arcs (counter-rotating)
  const arcs = (radius, count, span, speed, width, alpha) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(t * speed);
    ctx.strokeStyle = rgba(alpha);
    ctx.lineWidth = width;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, radius, a, a + span);
      ctx.stroke();
    }
    ctx.restore();
  };
  arcs(468, 6, 0.75, -0.18, 6, 0.55);
  arcs(436, 1, Math.PI * 2, 0, 1.5, 0.35);

  // dashed ring
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(t * 0.35);
  ctx.setLineDash([18, 14]);
  ctx.strokeStyle = rgba(0.45);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 400, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // spectrum bars
  const bars = 96;
  ctx.save();
  ctx.translate(c, c);
  for (let i = 0; i < bars; i++) {
    const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
    let v;
    if (analyser && state === "speaking" && !player.paused) v = freq[(i * 3) % freq.length] / 255;
    else v = level * (0.5 + 0.5 * Math.sin(i * 0.9 + t * 4) * Math.sin(i * 0.37 - t * 2.3));
    const len = 8 + Math.max(0, v) * 70;
    ctx.strokeStyle = rgba(0.35 + v * 0.6);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 300, Math.sin(a) * 300);
    ctx.lineTo(Math.cos(a) * (300 + len), Math.sin(a) * (300 + len));
    ctx.stroke();
  }
  ctx.restore();

  // thick inner arcs
  arcs(262, 3, 1.4 + level, 0.8, 16, 0.75);
  arcs(232, 4, 0.5, -1.1, 4, 0.5);

  // reactor coils
  ctx.save();
  ctx.translate(c, c);
  for (let i = 0; i < 10; i++) {
    ctx.rotate(Math.PI / 5);
    ctx.fillStyle = rgba(0.18 + level * 0.3);
    ctx.strokeStyle = rgba(0.7);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-26, 150);
    ctx.lineTo(26, 150);
    ctx.lineTo(36, 200);
    ctx.lineTo(-36, 200);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // core
  const coreR = 118 * (1 + level * 0.28);
  const core = ctx.createRadialGradient(c, c, 0, c, c, coreR);
  core.addColorStop(0, "rgba(255,255,255,0.98)");
  core.addColorStop(0.35, rgba(0.9));
  core.addColorStop(1, rgba(0.05));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(c, c, coreR, 0, Math.PI * 2);
  ctx.fill();

  // Mk II triangle
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(-Math.PI / 2);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * 92, Math.sin(a) * 92);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = rgba(0.9);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, 128, 0, Math.PI * 2);
  ctx.stroke();

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
  $("micBtn").textContent = micWanted ? "MIKRO AN" : "MIKRO AUS";
  $("micBtn").classList.toggle("on", micWanted);
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
