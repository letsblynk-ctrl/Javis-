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

// =====================================================================
// Face: a wireframe head (grid lines over a sculpted surface)
// =====================================================================

const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
const bump = (u, v, u0, v0, su, sv) => Math.exp(-(((u - u0) / su) ** 2) - (((v - v0) / sv) ** 2));

// u: angle around the head (0 = facing us), v: -1 crown ... 1 chin. Returns [x, y, z] in head units.
function headPoint(u, v, mouth) {
  // heart-shaped face: full cranium, high cheekbones, slim jaw, delicate chin
  let w;
  if (v < -0.15) w = 0.76 * Math.sqrt(Math.max(0, 1 - ((v + 0.15) / 0.85) ** 2));
  else w = 0.76 + 0.02 * bump(0, v, 0, 0.12, 1, 0.18) - 0.44 * smooth(0.22, 1.08, v) ** 1.2;
  if (v > 0.84) w *= Math.sqrt(Math.max(0, 1 - ((v - 0.84) / 0.22) ** 2));
  const front = Math.max(0, Math.cos(u));
  let x = w * 1.04 * Math.sin(u);
  let z = w * 1.12 * Math.cos(u);
  let y = v * 1.25;

  z += 0.19 * Math.exp(-((u / 0.12) ** 2)) * smooth(-0.02, 0.33, v) * (1 - smooth(0.36, 0.43, v));  // slim nose
  z -= 0.08 * (bump(u, v, -0.33, 0.0, 0.14, 0.08) + bump(u, v, 0.33, 0.0, 0.14, 0.08));           // eye sockets
  z += 0.025 * Math.exp(-(((v + 0.12) / 0.05) ** 2)) * Math.exp(-((u / 0.6) ** 2));              // soft brow bone
  z += 0.065 * (bump(u, v, -0.5, 0.14, 0.18, 0.1) + bump(u, v, 0.5, 0.14, 0.18, 0.1));            // high cheekbones
  z += 0.05 * bump(u, v, 0, 0.555, 0.22, 0.035) + 0.055 * bump(u, v, 0, 0.65, 0.2, 0.045);         // full lips
  z += 0.04 * bump(u, v, 0, 0.93, 0.22, 0.07);                                                      // chin
  y += mouth * 0.11 * smooth(0.596, 0.61, v) * Math.exp(-((u / 0.9) ** 2)) * front;                // jaw
  return [x, y, z];
}

// Plexus layer (points on the head joined by thin lines), fixed once so it doesn't flicker.
const ANCHORS = Array.from({ length: 340 }, () => ({
  u: (Math.random() * 2 - 1) * 1.5,
  v: -0.95 + Math.random() * 1.88,
  seed: Math.random() * TAU,
}));
const LINKS = [];
for (let i = 0; i < ANCHORS.length; i++) {
  for (let j = i + 1; j < ANCHORS.length; j++) {
    const du = (ANCHORS[i].u - ANCHORS[j].u) * 0.8, dv = ANCHORS[i].v - ANCHORS[j].v;
    if (du * du + dv * dv < 0.018) LINKS.push([i, j]);
  }
}

// Long wavy hair with a middle part: each strand runs over the scalp, then falls past the shoulders.
const STRANDS = Array.from({ length: 84 }, (_, i) => {
  const side = i % 2 ? 1 : -1;
  return {
    side,
    depth: Math.random(),                 // 0 = framing the face, 1 = far back
    phase: Math.random() * TAU,
    len: 1.7 + Math.random() * 0.5,       // where the ends fall (in v units)
    spread: 0.25 + Math.random() * 0.4,
    part: 0.02 + Math.random() * 0.05,
  };
});

function hairPoint(h, s, t) {
  const uEnd = h.side * (1.05 + h.depth * 1.3);
  if (s < 0.3) {                          // over the scalp from the parting line
    const k = s / 0.3;
    const v0 = -0.62 - h.depth * 0.36;    // parting runs from the hairline back over the crown
    const v = v0 + k * (-0.35 - v0);
    const [x, y, z] = headPoint(h.side * h.part + (uEnd - h.side * h.part) * k ** 0.8, v, 0);
    const puff = 1.06 + 0.05 * Math.sin(k * Math.PI);  // volume
    return [x * puff, y - 0.03, z * puff];
  }
  const [x0, y0, z0] = headPoint(uEnd, -0.35, 0);
  const k = (s - 0.3) / 0.7;
  const wave = (0.07 + 0.11 * k) * Math.sin(k * 6 + h.phase * 0.3 + t * 0.8) * k;  // big, mostly in-phase waves
  return [
    x0 * 1.08 + h.side * (h.spread * k ** 1.3 + 0.1 * Math.sin(k * Math.PI)) + wave,
    y0 + k * (h.len + 0.35) * 1.25,
    z0 * 1.05 - 0.2 * k,
  ];
}

function drawFace(c, t, rgba, light, open, blink, glance) {
  const S = 196;  // head units -> canvas units
  const yaw = 0.26 * Math.sin(t * 0.33) + 0.06 * Math.sin(t * 0.81);
  const pitch = -0.05 + 0.04 * Math.sin(t * 0.27);
  const roll = 0.04 * Math.sin(t * 0.21);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const top = c - 70;  // head sits a little higher to leave room for hair and neck
  const project = ([x, y, z]) => {
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const x3 = x1 * cr - y2 * sr, y3 = x1 * sr + y2 * cr;
    const f = 1 / (1 - z2 * 0.12);
    return [c + x3 * S * f, top + y3 * S * f, z2];
  };
  const P = (u, v) => project(headPoint(u, v, open));
  const range = (n, f) => Array.from({ length: n + 1 }, (_, k) => f(k / n));
  const violet = (a) => `rgba(175,95,255,${a})`;
  const path = (pts) => { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); return p; };
  const curve = (pts, width, alpha, close) => {
    const p = path(pts);
    if (close) p.closePath();
    ctx.lineWidth = width;
    ctx.strokeStyle = light(alpha);
    ctx.stroke(p);
  };

  // HUD corner brackets
  ctx.strokeStyle = rgba(0.85);
  ctx.lineWidth = 7;
  for (const [bx, by] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = c + bx * 310, y = c + by * 310;
    ctx.beginPath();
    ctx.moveTo(x, y - by * 80);
    ctx.lineTo(x, y);
    ctx.lineTo(x - bx * 80, y);
    ctx.stroke();
  }

  // "particles" style: everything is drawn as dots, the face stays hollow (no body, no grid lines)
  const dotted = config.face_style === "particles";
  if (dotted) { ctx.setLineDash([0.1, 5.5]); ctx.lineCap = "round"; }

  // halo
  const halo = ctx.createRadialGradient(c, top, 40, c, top, 330);
  halo.addColorStop(0, rgba(0.32 + open * 0.2));
  halo.addColorStop(1, rgba(0));
  ctx.fillStyle = halo;
  ctx.fillRect(c - 340, top - 340, 680, 680);

  ctx.globalCompositeOperation = "lighter";

  // hair behind the head
  const hairBack = new Path2D(), hairFront = new Path2D();
  for (const h of STRANDS) {
    const pts = range(36, (s) => project(hairPoint(h, s, t)));
    const target = h.depth > 0.45 ? hairBack : hairFront;
    pts.forEach(([x, y], i) => (i ? target.lineTo(x, y) : target.moveTo(x, y)));
  }
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = violet(0.32);
  ctx.stroke(hairBack);

  // neck
  for (const side of [-1, 1]) {
    curve(range(12, (k) => project([side * (0.3 + 0.06 * k ** 2), (0.78 + k * 0.75) * 1.25, 0.12 - 0.1 * k])), 2, 0.45);
  }

  // silhouette and translucent body
  const left = [], right = [];
  for (let i = 0; i <= 32; i++) {
    const v = -1 + (i / 32) * 2;
    let lo = null, hi = null;
    for (let j = 0; j < 48; j++) {
      const p = P(-Math.PI + (j / 48) * TAU, v);
      if (!lo || p[0] < lo[0]) lo = p;
      if (!hi || p[0] > hi[0]) hi = p;
    }
    left.push(lo);
    right.push(hi);
  }
  const silhouette = path([...left, ...right.reverse()]);
  silhouette.closePath();
  if (!dotted) {
    const body = ctx.createRadialGradient(c, top - 20, 20, c, top, 260);
    body.addColorStop(0, rgba(0.32));
    body.addColorStop(0.75, rgba(0.16));
    body.addColorStop(1, rgba(0.3));
    ctx.fillStyle = body;
    ctx.fill(silhouette);
    ctx.save();
    ctx.clip(silhouette);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = top - 300; y < top + 300; y += 6) ctx.fillRect(c - 300, y, 600, 2);
    ctx.restore();
    ctx.globalCompositeOperation = "lighter";
  }

  if (dotted) {
    // point cloud: dense at the silhouette, sparse towards the middle - the hollow look
    const rimDots = new Path2D(), midDots = new Path2D(), faintDots = new Path2D();
    for (let i = 0; i <= 40; i++) {
      const v = -0.98 + (i / 40) * 1.96;
      for (let j = 0; j < 96; j++) {
        const u = -Math.PI + (j / 96) * TAU + (i % 2) * (TAU / 192);
        const q = headPoint(u, v, open);
        const r = Math.hypot(q[0], q[2]) || 1;
        const [x, y, z] = project(q);
        if (z < -0.15 * r) continue;
        const rim = 1 - Math.max(0, z) / r;
        (rim > 0.72 ? rimDots : rim > 0.42 ? midDots : faintDots).rect(x - 1.3, y - 1.3, 2.6, 2.6);
      }
    }
    ctx.fillStyle = light(0.9);
    ctx.fill(rimDots);
    ctx.fillStyle = rgba(0.6);
    ctx.fill(midDots);
    ctx.fillStyle = rgba(0.16);
    ctx.fill(faintDots);
  } else {
    // grid
    const front = new Path2D(), back = new Path2D();
    const seg = (a, b) => { const p = a[2] + b[2] > 0 ? front : back; p.moveTo(a[0], a[1]); p.lineTo(b[0], b[1]); };
    for (let i = 0; i <= 34; i++) {
      const v = -0.97 + (i / 34) * 1.94;
      let prev = P(-Math.PI, v);
      for (let j = 1; j <= 80; j++) { const cur = P(-Math.PI + (j / 80) * TAU, v); seg(prev, cur); prev = cur; }
    }
    for (let i = 0; i < 40; i++) {
      const u = -Math.PI + (i / 40) * TAU;
      let prev = P(u, -1);
      for (let j = 1; j <= 48; j++) { const cur = P(u, -1 + (j / 48) * 2); seg(prev, cur); prev = cur; }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(0.1);
    ctx.stroke(back);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = light(0.38 + open * 0.2);
    ctx.stroke(front);
  }

  // plexus
  const pts = ANCHORS.map((a) => P(a.u, a.v));
  const links = new Path2D();
  for (const [i, j] of LINKS) {
    if (pts[i][2] < 0.05 || pts[j][2] < 0.05) continue;
    links.moveTo(pts[i][0], pts[i][1]);
    links.lineTo(pts[j][0], pts[j][1]);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = violet((dotted ? 0.5 : 0.38) + open * 0.2);
  if (dotted) ctx.setLineDash([]);  // the web itself stays as fine lines
  ctx.stroke(links);
  if (dotted) ctx.setLineDash([0.1, 5.5]);
  const bright = new Path2D(), dim = new Path2D();
  ANCHORS.forEach((a, i) => {
    const [x, y, z] = pts[i];
    if (z < 0) return;
    (Math.sin(t * 2.4 + a.seed) > 0.3 ? bright : dim).rect(x - 2, y - 2, 4, 4);
  });
  ctx.fillStyle = light(0.95);
  ctx.fill(bright);
  ctx.fillStyle = rgba(0.55);
  ctx.fill(dim);

  // face outline (heart shape)
  curve([
    ...range(24, (k) => P(-0.92, 0.82 - k * 1.38)),
    ...range(24, (k) => P(-0.92 + k * 1.84, -0.56 - Math.sin(k * Math.PI) * 0.1)),
    ...range(24, (k) => P(0.92, -0.56 + k * 1.38)),
    ...range(16, (k) => P(0.92 - k * 1.84, 0.82 + Math.sin(k * Math.PI) * 0.13)),
  ], 3.5, 0.85, true);

  // brows: strong, defined, lifted arch (filled)
  for (const side of [-1, 1]) {
    const browAt = (k, thick) => {           // k: 0 inner .. 1 tail
      const u = side * (0.13 + k * 0.42);
      const v = -0.12 - 0.075 * Math.sin(Math.min(1, k / 0.72) * Math.PI / 2) + (k > 0.72 ? (k - 0.72) * 0.16 : 0);
      return P(u, v - thick * (1 - k * 0.75));
    };
    const brow = path([...range(16, (k) => browAt(k, 0.032)), ...range(16, (k) => browAt(1 - k, 0))]);
    brow.closePath();
    if (dotted) {
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = light(0.9);
      ctx.stroke(brow);
    } else {
      ctx.fillStyle = light(0.75);
      ctx.fill(brow);
    }
  }

  // eyes: lifted almond shape, winged liner, glowing iris that glances around
  for (const side of [-1, 1]) {
    const u0 = side * 0.33, lid = (1 - blink);
    const inner = [u0 - side * 0.145, 0.012], outer = [u0 + side * 0.155, -0.028];
    const lidAt = (k, sign, h) => {
      const u = inner[0] + (outer[0] - inner[0]) * k;
      const v = inner[1] + (outer[1] - inner[1]) * k + sign * h * Math.sin(k * Math.PI) ** 0.9;
      return P(u, v);
    };
    const upper = range(18, (k) => lidAt(k, -1, 0.06 * lid + 0.004));
    const lower = range(18, (k) => lidAt(1 - k, 1, 0.026 * lid + 0.002));
    const eye = path([...upper, ...lower]);
    eye.closePath();
    if (lid > 0.2) {
      ctx.save();
      ctx.clip(eye);
      const [ix, iy] = P(u0 + glance * 0.05 + side * 0.005, -0.012);
      const ir = 0.05 * S;
      const iris = ctx.createRadialGradient(ix, iy, 0, ix, iy, ir);
      iris.addColorStop(0, "rgba(20,0,12,0.9)");
      iris.addColorStop(0.35, light(0.9));
      iris.addColorStop(1, rgba(0.25));
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = iris;
      ctx.beginPath();
      ctx.arc(ix, iy, ir, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(ix - ir * 0.35, iy - ir * 0.45, ir * 0.22, ir * 0.22);  // catchlight
      ctx.restore();
      ctx.globalCompositeOperation = "lighter";
    }
    curve(upper, 4, 0.95);
    curve(lower, 1.6, 0.6);
    // winged liner from the outer corner
    const wingStart = P(outer[0], outer[1] - 0.004);
    const wingEnd = P(outer[0] + side * 0.085, outer[1] - 0.06);
    curve([wingStart, wingEnd], 4, 0.95);
    curve(range(14, (k) => P(u0 - side * 0.1 + side * k * 0.22, -0.065 - Math.sin(k * Math.PI) * 0.02)), 1.2, 0.35);
  }

  // nose: slim bridge, small rounded tip
  curve(range(10, (k) => P(-0.03, 0.08 + k * 0.24)), 1.4, 0.4);
  curve(range(10, (k) => P(0.03, 0.08 + k * 0.24)), 1.4, 0.25);
  curve([
    ...range(16, (k) => P(-0.075 + k * 0.15, 0.425 - Math.sin(k * Math.PI) * 0.08)),
    ...range(8, (k) => P(0.075 - k * 0.15, 0.425 + Math.sin(k * Math.PI) * 0.01)),
  ], 3, 0.9, true);

  // full lips with a defined cupid's bow, glossy; they part when Jarvis speaks
  const topLip = range(24, (k) => {
    const u = -0.19 + k * 0.38;
    return P(u, 0.56 - 0.036 * Math.sin(k * Math.PI) ** 0.7 + 0.018 * Math.exp(-((u / 0.045) ** 2)));
  });
  const upperLine = range(24, (k) => P(0.19 - k * 0.38, 0.594 + 0.004 * Math.sin(k * Math.PI)));
  const lowerLine = range(24, (k) => P(-0.19 + k * 0.38, 0.612));
  const bottomLip = range(24, (k) => P(0.19 - k * 0.38, 0.612 + 0.066 * Math.sin(k * Math.PI) ** 0.8));
  if (open > 0.04) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(12,0,8,0.8)";
    ctx.fill(path([...upperLine, ...lowerLine]));
    ctx.globalCompositeOperation = "lighter";
  }
  for (const lip of [[...topLip, ...upperLine], [...lowerLine, ...bottomLip]]) {
    const p = path(lip);
    p.closePath();
    ctx.fillStyle = rgba(dotted ? 0.1 : 0.38);
    ctx.fill(p);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = light(0.85);
    ctx.stroke(p);
  }
  const [gx, gy, gz] = P(0.06, 0.635);             // gloss
  if (gz > 0) { ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.fillRect(gx - 6, gy - 1.5, 12, 3); }

  // hair in front, framing the face
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = light(0.5);
  ctx.stroke(hairFront);

  if (dotted) {                                   // the glowing nose is the focal point of this style
    const [nx, ny, nz] = P(0, 0.37);
    if (nz > 0) {
      const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, 46);
      g.addColorStop(0, light(0.9));
      g.addColorStop(0.4, rgba(0.45));
      g.addColorStop(1, rgba(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(nx, ny, 46, 0, TAU);
      ctx.fill();
    }
  }

  // highlighter: cheekbones and nose bridge; earrings
  for (const [u, v, phase, size] of [[-0.5, 0.12, 1.7, 1], [0.5, 0.12, 3.1, 1], [0, 0.2, 0, 0.7], [-1.5, 0.36, 0.5, 0.6], [1.5, 0.36, 2.5, 0.6]]) {
    const [x, y, z] = P(u, v);
    if (z < -0.2) continue;
    const r = (3.5 + 1.5 * Math.sin(t * 2.2 + phase) + open * 2) * size;
    const dot = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    dot.addColorStop(0, "rgba(255,255,255,1)");
    dot.addColorStop(0.3, light(0.8));
    dot.addColorStop(1, rgba(0));
    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(x, y, r * 3, 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.setLineDash([]);
  ctx.lineCap = "butt";
}

// blink every few seconds
let blinkAt = performance.now() + 2500;
let glanceAt = performance.now() + 5000, glanceDir = 1;
function glanceAmount(now) {
  if (now > glanceAt + 1600) { glanceAt = now + 4000 + Math.random() * 5000; glanceDir = Math.random() < 0.5 ? -1 : 1; }
  const k = (now - glanceAt) / 1600;
  return k < 0 || k > 1 ? 0 : glanceDir * Math.min(1, Math.sin(k * Math.PI) * 1.6);
}

function blinkAmount(now) {
  if (now > blinkAt + 180) blinkAt = now + 2500 + Math.random() * 3500;
  const k = (now - blinkAt) / 180;
  return k < 0 || k > 1 ? 0 : Math.sin(k * Math.PI);
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

  if (config.avatar !== "face") {  // the face gets corner brackets instead of these rings
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
  }

  if (config.avatar === "face") {
    drawFace(c, t, rgba, light, state === "speaking" ? Math.min(1, level * 1.4) : 0, blinkAmount(now), glanceAmount(now));
    requestAnimationFrame(drawReactor);
    return;
  }

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

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

let cockpitConnected = false;
let lastHud = null;

function renderLocalTasks(tasks) {
  $("taskSource").textContent = "· tasks.md";
  renderList($("tasks"), tasks, (task) => {
    const li = el("li");
    li.append(el("span", "t-title", task));
    return li;
  }, "Keine offenen Aufgaben");
}

function renderBookmarks(bookmarks) {
  renderList($("projects"), Object.entries(bookmarks), ([name, url]) => {
    const li = el("li");
    const a = el("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    const head = el("div", "p-head");
    head.append(el("span", "p-name", name), el("span", "p-count", "↗"));
    a.append(head);
    li.append(a);
    return li;
  }, "Keine Lesezeichen");
}

async function loadHud() {
  let hud;
  try { hud = await (await fetch("/api/hud")).json(); } catch (_) { return; }
  lastHud = hud;

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

  if (!cockpitConnected) {
    renderLocalTasks(hud.tasks || []);
    renderBookmarks(hud.bookmarks || {});
  }

  $("stWeb").textContent = hud.web_search ? "ONLINE" : "GOOGLE";
  const model = (hud.model || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").toUpperCase();
  $("stBrain").textContent = config.has_brain ? model || "CLAUDE" : "KEIN KEY";
  $("stBrain").classList.toggle("off", !config.has_brain);
}

const BUCKET_LABEL = { late: "überfällig", woche: "Woche", monat: "Monat", quartal: "Quartal", spaeter: "später" };

async function loadCockpit() {
  let cp;
  try { cp = await (await fetch("/api/cockpit")).json(); } catch (_) { return; }
  cockpitConnected = !!cp.connected;
  const chip = $("stCockpit");
  chip.textContent = cp.connected ? "ONLINE" : cp.error ? "FEHLER" : "AUS";
  chip.classList.toggle("off", !cp.connected && !cp.error);
  chip.classList.toggle("bad", !!cp.error);
  chip.title = cp.error || "";
  $("chatPanel").hidden = !cp.connected;
  $("kpiPanel").hidden = !cp.connected || !Object.keys(cp.kpis || {}).length;

  if (!cp.connected) {
    if (lastHud) { renderLocalTasks(lastHud.tasks || []); renderBookmarks(lastHud.bookmarks || {}); }
    return;
  }

  const link = $("cockpitLink");
  link.hidden = !cp.web_url;
  if (cp.web_url) link.href = cp.web_url;

  $("taskSource").textContent = "· Cockpit";
  renderList($("tasks"), cp.tasks || [], (t) => {
    const li = el("li");
    const title = el("span", "t-title", t.title);
    title.append(el("span", "t-proj", t.project + (t.due ? " · " + new Date(t.due + "T00:00").toLocaleDateString("de-DE", { day: "numeric", month: "short" }) : "")));
    li.append(el("span", "badge " + t.bucket, BUCKET_LABEL[t.bucket] || t.bucket), title);
    return li;
  }, "Nichts offen. Queen-Modus: Freizeit.");

  renderList($("projects"), cp.projects || [], (p) => {
    const li = el("li");
    const a = el("a");
    a.href = (cp.web_url || "#") + "#" + encodeURIComponent(p.id);
    a.target = "_blank";
    a.rel = "noopener";
    if (p.color) a.style.setProperty("--p-color", p.color);
    const head = el("div", "p-head");
    const count = el("span", "p-count", `${p.open} offen`);
    if (p.late) count.append(" · ", el("span", "late", `${p.late} überfällig`));
    head.append(el("span", "p-name", p.name), count);
    a.append(head, el("div", "p-next", p.next ? "Nächster Schritt: " + p.next : p.status || ""));
    li.append(a);
    return li;
  }, "Keine Projekte");

  renderList($("chat"), cp.messages || [], (m) => {
    const li = el("li");
    const text = el("div", "chat-text");
    text.append(el("b", null, m.who), m.text || "");
    li.append(text);
    return li;
  }, "Noch keine Nachrichten");

  const kpis = $("kpis");
  kpis.replaceChildren(...Object.entries(cp.kpis || {}).slice(0, 6).map(([label, value]) => {
    const box = el("div", "kpi");
    box.append(el("b", null, String(value)), el("span", null, label));
    return box;
  }));
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
    loadCockpit();
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
  loadCockpit();
  setInterval(loadHud, 10 * 60 * 1000);
  setInterval(loadCockpit, 30 * 1000);

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
