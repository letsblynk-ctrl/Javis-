// Jarvis UI: Chrome speech recognition in, ElevenLabs (or browser) voice out.

const $ = (id) => document.getElementById(id);
const orb = $("orb");
const statusEl = $("status");
const interimEl = $("interim");
const logEl = $("log");

let config = { language: "en-US", salutation: "Sir" };
let sessionId = null;
let listeningWanted = false; // the user turned the mic on
let busy = false;            // thinking or speaking: mic is paused so Jarvis doesn't hear himself
let recognition = null;
let currentAudio = null;

try { sessionId = sessionStorage.getItem("jarvis-session"); } catch (_) {}

// ---------- UI helpers ----------

function setState(state, label) {
  orb.className = "orb " + state;
  statusEl.textContent = label;
}

function idleState() {
  if (listeningWanted) setState("listening", "Listening");
  else setState("idle", "Standby");
}

function addMessage(who, text, isError = false) {
  const div = document.createElement("div");
  div.className = `msg ${who}${isError ? " error" : ""}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function warn(text) {
  $("warn").hidden = !text;
  $("warn").textContent = text || "";
}

setInterval(() => {
  $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}, 1000);

// ---------- voice out ----------

function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = config.language;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

function playAudio(base64) {
  return new Promise((resolve, reject) => {
    currentAudio = new Audio("data:audio/mpeg;base64," + base64);
    currentAudio.onended = () => resolve();
    currentAudio.onerror = () => reject(new Error("audio error"));
    currentAudio.play().catch(reject);
  });
}

async function speak(reply) {
  setState("speaking", "Speaking");
  try {
    if (reply.audio) {
      try {
        await playAudio(reply.audio);
      } catch (err) {
        if (err && err.name === "NotAllowedError") {
          // Autoplay blocked: ask for one click, then play.
          await new Promise((resolve) => {
            $("unlock").hidden = false;
            $("unlock-btn").onclick = () => { $("unlock").hidden = true; resolve(); };
          });
          await playAudio(reply.audio);
        } else {
          throw err;
        }
      }
    } else {
      await speakWithBrowser(reply.text);
    }
  } catch (_) {
    await speakWithBrowser(reply.text);
  }
}

function stopSpeaking() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- talking to the server ----------

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Server error ${res.status}`);
  return data;
}

async function handle(path, body, userText) {
  if (busy) return;
  busy = true;
  pauseRecognition();
  if (userText) addMessage("user", userText);
  setState("thinking", "Thinking");
  try {
    const reply = await post(path, body);
    sessionId = reply.session_id;
    try { sessionStorage.setItem("jarvis-session", sessionId); } catch (_) {}
    addMessage("jarvis", reply.text);
    if (reply.tts_error) warn("Voice error: " + reply.tts_error);
    await speak(reply);
  } catch (err) {
    setState("error", "Error");
    addMessage("jarvis", err.message, true);
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    busy = false;
    idleState();
    resumeRecognition();
  }
}

// "Jarvis activate" / "Jarvis, aktiviere dich" / "Jarvis wake up" -> the full greeting (weather + tasks).
const ACTIVATE = /\bjarvis\b.{0,12}\b(activate|aktivier\w*|wake up|wach auf)\b/i;

const send = (text) =>
  ACTIVATE.test(text) ? handle("/api/greet", {}, text) : handle("/api/chat", { text }, text);

// ---------- voice in (Chrome Web Speech API) ----------

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    warn("Speech recognition needs Google Chrome. You can still type.");
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
        interimEl.textContent = "";
        if (text) send(text);
      } else {
        interim += res[0].transcript;
      }
    }
    interimEl.textContent = interim;
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      listeningWanted = false;
      warn("Microphone access was denied. Allow it in Chrome's address bar, then click the orb.");
      idleState();
    }
  };
  // Chrome stops recognition after silence; restart while the mic should be on.
  r.onend = () => { if (listeningWanted && !busy) safeStart(); };
  return r;
}

function safeStart() {
  try { recognition && recognition.start(); } catch (_) { /* already running */ }
}
function pauseRecognition() {
  try { recognition && recognition.abort(); } catch (_) {}
}
function resumeRecognition() {
  if (listeningWanted) safeStart();
}

function toggleListening() {
  if (busy) { stopSpeaking(); return; } // clicking while Jarvis talks interrupts him
  if (!recognition) return;
  listeningWanted = !listeningWanted;
  if (listeningWanted) safeStart(); else pauseRecognition();
  idleState();
}

// ---------- wiring ----------

orb.addEventListener("click", toggleListening);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== $("text")) {
    e.preventDefault();
    toggleListening();
  }
  if (e.code === "Escape") stopSpeaking();
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  send(text);
});

(async function init() {
  try {
    config = await (await fetch("/api/config")).json();
  } catch (_) {}
  if (!config.has_brain) warn("No Anthropic API key configured - run setup_wizard.py.");
  else if (!config.has_voice) warn("No ElevenLabs key - using the browser's voice.");

  recognition = setupRecognition();
  idleState();

  const greet = new URLSearchParams(location.search).has("greet");
  if (greet) {
    history.replaceState(null, "", "/"); // don't greet again on reload
    listeningWanted = !!recognition; // after the clap, Jarvis keeps listening
    await handle("/api/greet", {}, null);
  }
})();
