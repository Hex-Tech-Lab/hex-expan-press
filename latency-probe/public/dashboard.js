// Live dashboard. three.js 0.186.1 from jsDelivr, mapped by the importmap in app/page.tsx.
import * as THREE from "three";

const AUTO_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const REF_IDS = ["iad1"];
const CHART_H = 240;
const PAD = { L: 64, R: 10, T: 10, B: 26 };
const DEPTH = 1000; // camera distance. The z=0 plane maps 1:1 to CSS pixels.
const TIP_HIT = 18;
const TAP_HIT = 22;
const POINT_PX = 16; // sprite size; the drawn marker is about 9 px
const HOVER_SCALE = 1.6;
const LABEL_POOL = 12;
const MAX_STAGGER = 5; // six series at most: indexes 0..5
const PARALLAX = (2 * Math.PI) / 180;
const EXIT_X = -24;
const DUR = {
  entry: { x: 0, y: 0, n: 0, out: 0 },
  refresh: { x: 600, y: 600, n: 400, out: 400 },
  range: { x: 450, y: 450, n: 400, out: 400 },
  metric: { x: 0, y: 500, n: 400, out: 400 },
  resize: { x: 0, y: 0, n: 0, out: 0 },
};

const CAIRO = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
// Cairo time only. The page states the zone once, in the caption.
const CAIRO_DT = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const CAIRO_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23" });
const CAIRO_HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const CAIRO_DM = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short" });
const DAY_MS = 86_400_000;
const $ = (id) => document.getElementById(id);
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const dur = (ms) => (reduced() ? 0 : ms);

const E = {
  expo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  quart: (p) => 1 - Math.pow(1 - p, 4),
  quad: (p) => 1 - (1 - p) * (1 - p),
};

const state = {
  data: null,
  fetchedAt: null,
  failed: false,
  inFlight: false,
  metric: "pageLoadTime",
  range: "24h",
  auto: true,
  nextAt: Date.now() + AUTO_MS,
};

// Marker shapes and dashes differ per series, so colour is not the only cue.
const STYLES = [
  { dash: null, marker: "circle" },
  { dash: [8, 5], marker: "square" },
  { dash: [2, 4], marker: "triangle" },
  { dash: [14, 5], marker: "diamond" },
];

const ms = (v) => (v == null ? "n/a" : `${Math.round(v).toLocaleString("en-US")} ms`);
// Card figures: seconds from 1,000 ms up, so a figure always fits its column.
const short = (v) => (v == null ? "n/a" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const pct = (ok, n) => (n > 0 ? `${Math.round((100 * ok) / n)}%` : "n/a");
const when = (ts) => (ts == null ? "n/a" : cairoTime(ts));
const cairoTime = (ts) => CAIRO_DT.format(ts);
const ago = (ts) => {
  if (ts == null) return "n/a";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const mmss = (t) => {
  const s = Math.max(0, Math.ceil(t / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
// Nearest-rank median, the same definition the server uses.
function median(xs) {
  const a = xs.filter((v) => v != null).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(0.5 * a.length) - 1))] : null;
}
// Largest value, or null when there is none. Used for the "worst" card figures.
const maxOf = (xs) => {
  const a = xs.filter((v) => v != null);
  return a.length ? Math.max(...a) : null;
};
// Source names as people know them. An unlisted source shows its stored id.
const SOURCE_NAME = { "sitespeed.io": "sitespeed.io", webpagetest: "WebPageTest" };
// Short card titles. Other locations use plainLabel.
const CARD_TITLE = { iad1: "US East server" };
// Cairo time (hh:mm) of the newest reading, so a gap in the readings is visible on the card.
const lastTime = (rs) => {
  const t = maxOf(rs.map((r) => r.runAt));
  return t == null ? "n/a" : CAIRO_HM.format(t);
};
const STEPS = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
function niceScale(peak) {
  const target = Math.max(peak * 1.08, 100);
  const step = STEPS.find((s) => Math.ceil(target / s) <= 5) ?? 100000;
  const top = Math.ceil(target / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return { top, ticks };
}
const metricName = () => (state.metric === "ttfb" ? "First byte" : "Full load");
// Plain names for the server's location ids. Anything not listed falls back to the server label.
const PLAIN = {
  iad1: "US East server (Virginia)",
  "us-ca": "California, home connection",
  "us-tx": "Texas, home connection",
  "us-ga": "Georgia, home connection",
  "us-ny": "New York, home connection",
  "us-il": "Illinois, home connection",
};
const plainLabel = (loc) => PLAIN[loc.id] ?? loc.label;

// ---------- Tween system -------------------------------------------------
// One list of tweens drives every animated value. A tween with duration 0 (reduced motion
// or an instant layout) writes its target at once and runs its done callback.
const tweens = new Set();
let raf = 0;
let dirty = false;
let onScreen = true;

function kick() {
  dirty = true;
  if (!raf && onScreen && !document.hidden && chartOK) raf = requestAnimationFrame(frame);
}

function tweenTo(o, k, to, ms, opt = {}) {
  const d = dur(ms);
  for (const t of tweens) if (t.o === o && t.k === k) tweens.delete(t);
  if (d === 0) {
    o[k] = to;
    if (opt.done) opt.done();
    return;
  }
  tweens.add({ o, k, from: o[k], to, d, start: performance.now() + (opt.delay || 0), e: opt.e || E.quart, done: opt.done });
  kick();
}

// Under reduced motion, when the setting changes mid-flight, finish every tween at once.
function finishAll() {
  for (const t of [...tweens]) {
    tweens.delete(t);
    t.o[t.k] = t.to;
    if (t.done) t.done();
  }
}

// Pointer parallax: a 2 degree tilt, lerped at 0.08 per frame.
const par = { tx: 0, ty: 0, cx: 0, cy: 0 };

function frame(now) {
  raf = 0;
  if (!onScreen || document.hidden) return; // paused; kick() resumes
  let busy = false;
  for (const t of [...tweens]) {
    if (now < t.start) {
      busy = true;
      continue;
    }
    const p = Math.min(1, (now - t.start) / t.d);
    t.o[t.k] = t.from + (t.to - t.from) * t.e(p);
    if (p >= 1) {
      tweens.delete(t);
      if (t.done) t.done();
    } else busy = true;
  }
  const dx = par.tx - par.cx;
  const dy = par.ty - par.cy;
  if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
    par.cx += dx * 0.08;
    par.cy += dy * 0.08;
    busy = true;
  } else {
    par.cx = par.tx;
    par.cy = par.ty;
  }
  if (dirty || busy) {
    sync();
    renderer.render(scene, camera);
    dirty = false;
  }
  // A tween callback may already have scheduled a frame through kick(); never run two loops.
  if (busy && !raf) raf = requestAnimationFrame(frame);
}

// ---------- Scene --------------------------------------------------------
let chartOK = false;
let renderer, scene, camera, root, content, gridGroup, gridLines, gridPos;
let host, canvas, tip, ring, axisEl, noteEl, legendEl, summaryEl, lineLbl;
const labelEls = [];
const xLabelEls = [];
const xLabelObjs = Array.from({ length: 24 }, () => ({ x: 0 }));
const tickObjs = [];
const series = new Map(); // key -> series record
const chart = { W: 0, H: CHART_H, t0: 0, t1: 1, top: 100, tickCount: 0, entered: false };
let legendKeys = "";
let tipHit = null; // item shown in the tooltip
let pinHit = null; // sticky selection (tap, click, Enter)
let hoverHit = null;
let focusHit = null;

const PTS_VS = `
attribute float aSize;
attribute float aAlpha;
uniform float uPx;
varying float vA;
void main() {
  vA = aAlpha;
  gl_PointSize = aSize * uPx;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const PTS_FS = `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOp;
varying float vA;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vA * uOp;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}`;

const markerCache = {};
function markerTexture(name) {
  if (markerCache[name]) return markerCache[name];
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.beginPath();
  if (name === "circle") x.arc(16, 16, 9, 0, Math.PI * 2);
  else if (name === "square") x.rect(7, 7, 18, 18);
  else if (name === "triangle") {
    x.moveTo(16, 4);
    x.lineTo(28, 27);
    x.lineTo(4, 27);
  } else {
    x.moveTo(16, 3);
    x.lineTo(29, 16);
    x.lineTo(16, 29);
    x.lineTo(3, 16);
  }
  x.closePath();
  x.fill();
  markerCache[name] = new THREE.CanvasTexture(c);
  return markerCache[name];
}

// Coordinates: the scene is in CSS pixels with y up from the chart's bottom edge. Each series
// sits in a group whose origin is the zero line, so scaleY grows it from the baseline.
function buildScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  canvas = renderer.domElement;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
  root = new THREE.Group();
  content = new THREE.Group();
  scene.add(root);
  root.add(content);

  gridGroup = new THREE.Group();
  gridGroup.position.set(0, PAD.B, 0);
  content.add(gridGroup);
  gridPos = new Float32Array(LABEL_POOL * 6);
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute("position", new THREE.BufferAttribute(gridPos, 3));
  gridLines = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: new THREE.Color(token("--line")), transparent: true, opacity: 0.3 }));
  gridGroup.add(gridLines);

  host = $("chart");
  canvas.setAttribute("role", "img");
  canvas.tabIndex = 0;
  canvas.style.touchAction = "manipulation";
  canvas.style.display = "block";
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  ring = document.createElement("div");
  ring.className = "focus-ring";
  tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("aria-hidden", "true");
  host.replaceChildren(canvas, ring, tip);
  for (let i = 0; i < LABEL_POOL; i++) {
    const el = document.createElement("div");
    el.className = "tick";
    el.style.display = "none";
    host.append(el);
    labelEls.push(el);
    tickObjs.push({ y: 0 });
  }
  for (let i = 0; i < 24; i++) {
    const el = document.createElement("div");
    el.className = "xtick";
    el.style.display = "none";
    host.append(el);
    xLabelEls.push(el);
  }
  lineLbl = document.createElement("div");
  lineLbl.className = "line-label";
  lineLbl.style.display = "none";
  host.append(lineLbl);
  axisEl = $("axis-title");
  noteEl = $("chart-note");
  legendEl = $("legend");
  summaryEl = $("chart-summary");
  setupSize();
}

function setupSize() {
  chart.W = Math.max(280, host.clientWidth);
  chart.H = CHART_H;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(chart.W, chart.H, false);
  canvas.style.width = `${chart.W}px`;
  canvas.style.height = `${chart.H}px`;
  camera.aspect = chart.W / chart.H;
  camera.fov = (2 * Math.atan(chart.H / 2 / DEPTH) * 180) / Math.PI;
  camera.position.set(chart.W / 2, chart.H / 2, DEPTH);
  camera.lookAt(chart.W / 2, chart.H / 2, 0);
  camera.updateProjectionMatrix();
  root.position.set(chart.W / 2, chart.H / 2, 0);
  content.position.set(-chart.W / 2, -chart.H / 2, 0);
  for (const s of series.values()) s.matPts.uniforms.uPx.value = renderer.getPixelRatio();
}

function createSeries(b, index) {
  const ci = b.ci ?? index;
  const kind = b.kind ?? "browser";
  const color = token(`--s${(ci % 7) + 1}`);
  const style = kind === "browser" ? STYLES[ci % STYLES.length] : { dash: null, marker: "circle" };
  const group = new THREE.Group();
  group.position.set(0, PAD.B, 0);
  content.add(group);
  const matLine = style.dash
    ? new THREE.LineDashedMaterial({ color, dashSize: style.dash[0], gapSize: style.dash[1], transparent: true, opacity: 1 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
  const matPts = new THREE.ShaderMaterial({
    vertexShader: PTS_VS,
    fragmentShader: PTS_FS,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uMap: { value: markerTexture(style.marker) },
      uColor: { value: new THREE.Color(color) },
      uOp: { value: 1 },
      uPx: { value: renderer.getPixelRatio() },
    },
  });
  const s = {
    key: b.key,
    label: b.label,
    index,
    ci,
    kind,
    showLine: kind !== "raw",
    showPts: kind !== "median",
    pointPx: kind === "raw" ? 8 : POINT_PX,
    color,
    style,
    group,
    matLine,
    matPts,
    st: { sy: 0, op: 1, hidden: false },
    items: [],
    cap: -1,
    geoLine: null,
    geoPts: null,
    line: null,
    pts: null,
  };
  rebuildBuffers(s);
  return s;
}

// Buffers are sized to the item count. They are rebuilt only when that count changes, and the
// old geometries are disposed at that point.
function rebuildBuffers(s) {
  const n = s.items.length;
  if (n === s.cap) return;
  s.cap = n;
  if (s.line) s.group.remove(s.line, s.pts);
  s.geoLine?.dispose();
  s.geoPts?.dispose();
  const cap = Math.max(n, 1);
  s.posArr = new Float32Array(cap * 3);
  s.sizeArr = new Float32Array(cap);
  s.alphaArr = new Float32Array(cap);
  s.geoLine = new THREE.BufferGeometry();
  s.geoLine.setAttribute("position", new THREE.BufferAttribute(s.posArr, 3));
  s.geoLine.setDrawRange(0, n);
  s.geoPts = new THREE.BufferGeometry();
  s.geoPts.setAttribute("position", new THREE.BufferAttribute(s.posArr, 3));
  s.geoPts.setAttribute("aSize", new THREE.BufferAttribute(s.sizeArr, 1));
  s.geoPts.setAttribute("aAlpha", new THREE.BufferAttribute(s.alphaArr, 1));
  s.geoPts.setDrawRange(0, n);
  s.line = new THREE.Line(s.geoLine, s.matLine);
  s.pts = new THREE.Points(s.geoPts, s.matPts);
  s.group.add(s.line, s.pts);
  s.line.visible = s.showLine;
  s.pts.visible = s.showPts;
}

function sync() {
  scene.updateMatrixWorld(true);
  root.rotation.set(par.cy, par.cx, 0);
  const W = chart.W;
  const H = chart.H;
  for (const s of series.values()) {
    s.group.scale.y = Math.max(0, s.st.sy);
    s.group.visible = s.st.sy > 0.001;
    s.matLine.opacity = s.st.op;
    s.matPts.uniforms.uOp.value = s.st.op;
    rebuildBuffers(s);
    const n = s.items.length;
    for (let i = 0; i < n; i++) {
      const it = s.items[i];
      const o = i * 3;
      s.posArr[o] = it.x;
      s.posArr[o + 1] = it.y;
      s.posArr[o + 2] = 0;
      s.sizeArr[i] = s.pointPx * it.hs;
      s.alphaArr[i] = it.a;
    }
    s.geoLine.attributes.position.needsUpdate = true;
    s.geoPts.attributes.position.needsUpdate = true;
    s.geoPts.attributes.aSize.needsUpdate = true;
    s.geoPts.attributes.aAlpha.needsUpdate = true;
    if (s.style.dash) s.line.computeLineDistances();
  }
  // Gridlines and labels follow the tweened tick values.
  const count = chart.tickCount;
  for (let i = 0; i < count; i++) {
    const y = tickObjs[i].y;
    const o = i * 6;
    gridPos[o] = PAD.L;
    gridPos[o + 1] = y;
    gridPos[o + 2] = 0;
    gridPos[o + 3] = W - PAD.R;
    gridPos[o + 4] = y;
    gridPos[o + 5] = 0;
  }
  gridLines.geometry.attributes.position.needsUpdate = true;
  gridLines.geometry.setDrawRange(0, count * 2);
  for (let i = 0; i < LABEL_POOL; i++) {
    const el = labelEls[i];
    if (i < count && !el.dataset.zero) {
      el.style.display = "";
      el.style.top = `${H - PAD.B - tickObjs[i].y}px`;
    } else el.style.display = "none";
  }
  for (let i = 0; i < xLabelEls.length; i++) {
    const el = xLabelEls[i];
    if (el.style.display === "none") continue;
    el.style.left = `${Math.min(Math.max(xLabelObjs[i].x, 22), W - 22)}px`;
    el.style.top = `${H - PAD.B + 4}px`;
  }
  const med = [...series.values()].find((s) => s.kind === "median");
  const medLast = med && !med.st.hidden && med.st.sy > 0.5 ? [...med.items].reverse().find((it) => !it.exiting && it.a > 0.5) : null;
  if (medLast) {
    const p = toScreen(med, medLast);
    lineLbl.style.display = "";
    lineLbl.style.color = med.color;
    lineLbl.style.left = `${Math.min(Math.max(p.x, 70), W - 4)}px`;
    lineLbl.style.top = `${p.y}px`;
    lineLbl.textContent = "5-run median";
  } else lineLbl.style.display = "none";
  if (tipHit) {
    if (tipHit.it.exiting) hideTip();
    else if (tip.classList.contains("on")) placeTip(toScreen(tipHit.s, tipHit.it));
  }
  if (focusHit && ring.classList.contains("on")) placeRing(focusHit);
}

// Screen position of an item, in CSS pixels from the top-left of the canvas.
function toScreen(s, it) {
  const v = new THREE.Vector3(it.x, it.y, 0);
  s.group.localToWorld(v);
  v.project(camera);
  return { x: ((v.x + 1) / 2) * chart.W, y: ((1 - v.y) / 2) * chart.H };
}

// Nearest visible point within radius, by screen distance. Hit testing is done in screen space
// from the projected positions, so it follows the parallax tilt and the entry scale.
function nearest(px, py, radius) {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  let best = null;
  let bd = radius;
  for (const s of series.values()) {
    if (s.st.hidden || s.st.sy < 0.5 || s.st.op < 0.5 || !s.showPts) continue;
    for (const it of s.items) {
      if (it.exiting || it.a < 0.5) continue;
      const p = toScreen(s, it);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= bd) {
        bd = d;
        best = { s, it, x: p.x, y: p.y };
      }
    }
  }
  return best;
}

// ---------- Layout and data ----------------------------------------------
const xOf = (ts) => {
  const W = chart.W - PAD.L - PAD.R;
  return PAD.L + (chart.t1 === chart.t0 ? W / 2 : ((ts - chart.t0) / (chart.t1 - chart.t0)) * W);
};
const yOf = (v) => (v / chart.top) * (chart.H - PAD.T - PAD.B);

// Rolling median of the last k checks at each point. One slow check then cannot set the line.
function rollingMedian(items, k = 5) {
  return items.map((it, i) => ({ key: it.key, ts: it.ts, v: median(items.slice(Math.max(0, i - k + 1), i + 1).map((x) => x.v)), n: it.n }));
}

function buildSeriesData(d) {
  const key = state.metric === "ttfb" ? "ttfb" : "total";
  const out = [];
  for (const id of REF_IDS) {
    const loc = d.locations.find((l) => l.id === id);
    if (!loc) continue;
    const items = [];
    for (const r of d.runs) {
      const x = r.loc?.[id];
      if (x && x[key] != null) items.push({ key: String(r.ts), ts: r.ts, v: x[key], n: x.n });
    }
    const ci = out.length;
    out.push({ key: `ref:${id}`, label: "Each check", kind: "raw", ci, items });
    out.push({ key: `med:${id}`, label: "5-run median", kind: "median", ci, items: rollingMedian(items) });
  }
  const groups = new Map();
  for (const b of d.browser) {
    const k = `b:${b.page}|${b.source}`;
    if (!groups.has(k)) groups.set(k, { page: b.page, source: b.source, rows: [] });
    groups.get(k).rows.push(b);
  }
  for (const [k, g] of groups) {
    const label = d.pages.find((p) => p.id === g.page)?.label ?? g.page;
    const items = g.rows
      .filter((r) => r.metrics[state.metric] != null)
      .map((r, i) => ({ key: `${r.runAt}:${i}`, ts: r.runAt, v: r.metrics[state.metric], n: r.samples }));
    out.push({ key: k, label: `${label}, real-browser test`, kind: "browser", ci: out.length, items });
  }
  return out;
}

function syncItems(s, list, m, D, delay) {
  const byKey = new Map(s.items.map((it) => [it.key, it]));
  const entering = m === "entry";
  const seen = new Set();
  for (const n of list) {
    seen.add(n.key);
    const X = xOf(n.ts);
    const Yv = yOf(n.v);
    let it = byKey.get(n.key);
    if (it) {
      it.exiting = false;
      it.n = n.n;
      it.v = n.v;
      it.ts = n.ts;
      tweenTo(it, "x", X, D.x, { e: E.quart });
      tweenTo(it, "y", Yv, D.y, { e: E.quart });
    } else {
      it = { key: n.key, ts: n.ts, v: n.v, n: n.n, x: entering ? X : chart.W, y: Yv, a: 0, hs: 1, exiting: false };
      s.items.push(it);
      if (entering) tweenTo(it, "a", 1, 300, { delay });
      else {
        // New points slide in from the right edge.
        tweenTo(it, "x", X, D.n, { e: E.quart });
        tweenTo(it, "a", 1, D.n);
      }
    }
  }
  // Points that fell out of the window slide out to the left, then are removed.
  for (const it of s.items) {
    if (seen.has(it.key) || it.exiting) continue;
    it.exiting = true;
    tweenTo(it, "x", EXIT_X, D.out, { e: E.quart, done: () => removeItem(s, it) });
  }
  s.items.sort((p, q) => p.ts - q.ts);
}

function removeItem(s, it) {
  if (!it.exiting) return;
  s.items = s.items.filter((x) => x !== it);
  kick();
}

// Whole-hour ticks inside [t0, t1]: every 3 hours (24 h) or every midnight (7 d), thinned so that
// no more than maxLabels remain.
function xTicksFor(range, t0, t1, maxLabels) {
  const HOUR = 3_600_000;
  const out = [];
  for (let t = Math.floor(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
    const h = Number(CAIRO_HOUR.format(t));
    if (range === "7d" ? h === 0 : h % 3 === 0) out.push(t);
  }
  const k = Math.max(1, Math.ceil(out.length / maxLabels));
  return out.filter((_, i) => i % k === 0);
}

function renderXLabels(hasData, D) {
  const plot = chart.W - PAD.L - PAD.R;
  const maxLabels = Math.max(2, Math.floor(plot / 52));
  const ticks = hasData ? xTicksFor(state.range, chart.t0, chart.t1, maxLabels) : [];
  xLabelEls.forEach((el, i) => {
    const t = ticks[i];
    if (t === undefined) {
      el.style.display = "none";
      return;
    }
    const top = state.range === "7d" ? CAIRO_DM.format(t) : CAIRO_HM.format(t);
    const bottom = state.range === "7d" ? CAIRO_HM.format(t) : "";
    const a = document.createElement("span");
    a.textContent = top;
    const b = document.createElement("span");
    b.textContent = bottom;
    el.replaceChildren(a, b);
    el.style.display = "";
    tweenTo(xLabelObjs[i], "x", xOf(t), D.x, { e: E.quart });
  });
}

// "Data since" line, and the 7-day label when the store holds less than 7 days.
function renderRangeInfo(d) {
  const first = d.firstRunTs;
  $("r-7d").textContent = first != null && Date.now() - first < 7 * DAY_MS ? "7 days (partial)" : "7 days";
  const info = $("data-since");
  if (first == null) {
    info.textContent = "No data stored yet.";
    return;
  }
  const hours = Math.max(0, Math.round((Date.now() - first) / 3_600_000));
  info.textContent = `Data since ${cairoTime(first)}, about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

function applyChart(d, mode) {
  if (!chartOK) return;
  setupSize();
  const m = chart.entered ? mode : "entry";
  const D = DUR[m] || DUR.resize;
  const built = buildSeriesData(d);
  const all = built.flatMap((b) => b.items);
  let t0 = Infinity;
  let t1 = -Infinity;
  let vmax = 0;
  for (const it of all) {
    t0 = Math.min(t0, it.ts);
    t1 = Math.max(t1, it.ts);
    vmax = Math.max(vmax, it.v);
  }
  if (all.length) {
    chart.t0 = t0;
    chart.t1 = t1;
  }
  const sc = niceScale(vmax || 100);
  chart.top = sc.top;

  const seen = new Set();
  for (const b of built) {
    seen.add(b.key);
    let s = series.get(b.key);
    const created = !s;
    if (created) {
      s = createSeries(b, series.size);
      series.set(b.key, s);
    }
    s.label = b.label;
    if (m === "entry") {
      const delay = Math.min(s.index, MAX_STAGGER) * 60;
      tweenTo(s.st, "sy", 1, 700, { e: E.expo, delay });
      syncItems(s, b.items, m, D, delay);
    } else {
      if (created) tweenTo(s.st, "sy", 1, 700, { e: E.expo });
      syncItems(s, b.items, m, D, 0);
    }
  }
  for (const s of series.values()) if (!seen.has(s.key)) syncItems(s, [], m, D, 0);

  chart.tickCount = Math.min(sc.ticks.length, LABEL_POOL);
  for (let i = 0; i < LABEL_POOL; i++) {
    if (i < chart.tickCount) {
      tweenTo(tickObjs[i], "y", yOf(sc.ticks[i]), D.y, { e: E.quart });
      setLabel(labelEls[i], sc.ticks[i].toLocaleString("en-US"));
      labelEls[i].dataset.zero = sc.ticks[i] === 0 ? "1" : "";
    }
  }
  renderXLabels(all.length > 0, D);
  setLabel(axisEl, state.metric === "ttfb" ? "First byte (ms)" : "Full load (ms)");
  summaryEl.textContent = summaryText(d);
  canvas.setAttribute("aria-label", summaryEl.textContent);

  const hasBrowser = d.browser.length > 0;
  if (!all.length) noteEl.textContent = "No data for this period yet. The first check will appear here once it is recorded.";
  else if (!hasBrowser) noteEl.textContent = "No real-browser tests yet. Their results will appear here once they arrive. The lines shown are checks from our server.";
  else noteEl.textContent = "";

  renderLegend();
  if (all.length && m === "entry") chart.entered = true;
  if (pinHit && pinHit.it.exiting) unpin(true);
  kick();
}

// Crossfade for axis text: the old text fades out, then the new text fades in, 200 ms in total.
function setLabel(el, text) {
  if (el.dataset.text === text) return;
  if (!el.textContent) {
    el.textContent = text;
    el.dataset.text = text;
    return;
  }
  el.dataset.text = text;
  const half = dur(100);
  el.style.transition = `opacity ${half}ms linear`;
  el.style.opacity = "0";
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = text;
    el.style.opacity = "1";
  }, half);
}

function summaryText(d) {
  const key = state.metric === "ttfb" ? "ttfb" : "total";
  let worst = null;
  let ok = 0;
  let n = 0;
  for (const id of REF_IDS) {
    const loc = d.locations.find((l) => l.id === id);
    if (!loc) continue;
    const rs = d.runs.filter((r) => r.loc?.[id]).map((r) => r.loc[id]);
    const med = median(rs.map((x) => x[key]));
    if (med != null && (!worst || med > worst.med)) worst = { label: plainLabel(loc), med };
    for (const x of rs) {
      n += x.n;
      ok += x.ok;
    }
  }
  const worstTxt = worst ? `Slowest location: ${worst.label}, typical ${ms(worst.med)}.` : "No location data yet.";
  const succ = n > 0 ? `Worked ${pct(ok, n)} of the time (${ok} of ${n} checks).` : "";
  const last = d.lastRunTs ? `Last check ${cairoTime(d.lastRunTs)}.` : "No check yet.";
  return `Speed chart, ${metricName()}. ${worstTxt} ${succ} ${last}`;
}

// ---------- Legend -------------------------------------------------------
function glyph(style, color) {
  const dash = style.dash ? `stroke-dasharray="${style.dash.join(",")}"` : "";
  const shape = {
    circle: '<circle cx="20" cy="7" r="3.5" fill="currentColor"/>',
    square: '<rect x="16.5" y="3.5" width="7" height="7" fill="currentColor"/>',
    triangle: '<polygon points="20,3 24,11 16,11" fill="currentColor"/>',
    diamond: '<polygon points="20,2.5 24.5,7 20,11.5 15.5,7" fill="currentColor"/>',
  }[style.marker];
  return `<svg width="40" height="14" viewBox="0 0 40 14" aria-hidden="true" focusable="false" style="color:${color}"><line x1="2" y1="7" x2="38" y2="7" stroke="currentColor" stroke-width="2" ${dash}/>${shape}</svg>`;
}

// Legend buttons are built once per set of series, so focus survives a refresh.
// aria-pressed is true when the series is shown. A visible "hidden" tag covers the state too.
function renderLegend() {
  const keys = [...series.values()].map((s) => s.key).join("|");
  if (keys !== legendKeys) {
    legendKeys = keys;
    legendEl.replaceChildren();
    for (const s of series.values()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "legend-item";
      btn.dataset.key = s.key;
      btn.innerHTML = `${glyph(s.style, s.color)}<span class="lbl-text"></span><span class="hid-tag"></span>`;
      btn.addEventListener("click", () => toggle(s.key));
      legendEl.append(btn);
    }
  }
  for (const btn of legendEl.querySelectorAll("button")) {
    const s = series.get(btn.dataset.key);
    if (!s) continue;
    btn.setAttribute("aria-pressed", String(!s.st.hidden));
    btn.querySelector(".lbl-text").textContent = s.label;
    btn.querySelector(".hid-tag").textContent = s.st.hidden ? " (hidden)" : "";
  }
}

// Hide: opacity to 0.12 over 200 ms, line collapses to zero height over 300 ms.
// Show: the reverse. Other series are not moved.
function toggle(key) {
  const s = series.get(key);
  if (!s) return;
  s.st.hidden = !s.st.hidden;
  if (s.st.hidden) {
    if (pinHit?.s === s) unpin(true);
    if (hoverHit?.s === s) setHover(null);
    tweenTo(s.st, "op", 0.12, 200);
    tweenTo(s.st, "sy", 0, 300);
  } else {
    tweenTo(s.st, "sy", 1, 300);
    tweenTo(s.st, "op", 1, 200);
  }
  renderLegend();
  kick();
}

// ---------- Tooltip, hover, tap, keyboard -------------------------------
function fillTip(s, it) {
  tip.replaceChildren();
  const add = (cls, txt) => {
    const el = document.createElement("div");
    if (cls) el.className = cls;
    el.textContent = txt;
    tip.append(el);
  };
  add("tip-title", s.label);
  add("", `${metricName()}: ${ms(it.v)}`);
  add("", `${it.n} check${it.n === 1 ? "" : "s"}`);
  add("tip-time", cairoTime(it.ts));
}

function placeTip(p) {
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = p.x + 12;
  let y = p.y - h - 10;
  if (x + w > chart.W - 4) x = p.x - w - 12;
  if (y < 0) y = p.y + 12;
  tip.style.left = `${Math.max(0, x)}px`;
  tip.style.top = `${Math.max(0, y)}px`;
}

function showTip(h) {
  fillTip(h.s, h.it);
  tipHit = h;
  tip.classList.add("on");
  placeTip(toScreen(h.s, h.it));
}

function hideTip() {
  tip.classList.remove("on");
  tipHit = null;
}

function placeRing(h) {
  const p = toScreen(h.s, h.it);
  ring.style.left = `${p.x}px`;
  ring.style.top = `${p.y}px`;
}

function targetScale(it) {
  return (hoverHit?.it === it) || (pinHit?.it === it) ? HOVER_SCALE : 1;
}

function setScale(it) {
  tweenTo(it, "hs", targetScale(it), 150, { e: E.quad });
}

function setHover(h) {
  const prev = hoverHit;
  hoverHit = h;
  if (prev && prev.it !== h?.it) setScale(prev.it);
  if (h) setScale(h.it);
  if (pinHit) return;
  if (h) showTip(h);
  else hideTip();
}

function pin(h) {
  const prev = pinHit;
  pinHit = h;
  if (prev && prev.it !== h.it) setScale(prev.it);
  setScale(h.it);
  showTip(h);
}

function unpin(hide) {
  const prev = pinHit;
  pinHit = null;
  if (prev) setScale(prev.it);
  if (hide) hideTip();
  else if (hoverHit) showTip(hoverHit);
  else hideTip();
}

const liveItems = (s) => s.items.filter((it) => !it.exiting && it.a >= 0.5);
const visibleSeries = () => [...series.values()].filter((s) => s.showPts && !s.st.hidden && s.st.sy >= 0.5 && liveItems(s).length > 0);

function setFocus(h) {
  focusHit = h;
  placeRing(h);
  ring.classList.add("on");
  canvas.setAttribute("aria-description", `${h.s.label}: ${ms(h.it.v)}, ${cairoTime(h.it.ts)}`);
}

function moveFocus(dx, dy) {
  const vs = visibleSeries();
  if (!vs.length) return;
  if (!focusHit || !vs.includes(focusHit.s)) {
    const its = liveItems(vs[0]);
    if (its.length) setFocus({ s: vs[0], it: its[its.length - 1] });
    return;
  }
  if (dx) {
    const its = liveItems(focusHit.s);
    const j = its.indexOf(focusHit.it) + dx;
    if (j >= 0 && j < its.length) setFocus({ s: focusHit.s, it: its[j] });
    return;
  }
  const vi = vs.indexOf(focusHit.s);
  const vj = vi + dy;
  if (vj < 0 || vj >= vs.length) return;
  const its = liveItems(vs[vj]);
  if (!its.length) return;
  let best = its[0];
  for (const it of its) if (Math.abs(it.ts - focusHit.it.ts) < Math.abs(best.ts - focusHit.it.ts)) best = it;
  setFocus({ s: vs[vj], it: best });
}

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function attachCanvas() {
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  canvas.addEventListener("pointermove", (e) => {
    const p = localPoint(e);
    if (e.pointerType === "mouse" && !reduced()) {
      par.tx = clamp((p.x / chart.W) * 2 - 1) * PARALLAX;
      par.ty = clamp((p.y / chart.H) * 2 - 1) * PARALLAX;
      kick();
    }
    if (e.pointerType !== "mouse" || pinHit) return;
    setHover(nearest(p.x, p.y, TIP_HIT));
  });
  canvas.addEventListener("pointerleave", () => {
    if (!reduced()) {
      par.tx = 0;
      par.ty = 0;
      kick();
    }
    if (!pinHit) setHover(null);
  });
  // A tap or click on a point pins its tooltip. A tap elsewhere clears the pin.
  canvas.addEventListener("pointerdown", (e) => {
    const p = localPoint(e);
    const hit = nearest(p.x, p.y, TAP_HIT);
    if (hit) pin(hit);
    else if (pinHit) unpin(true);
  });
  canvas.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowLeft": moveFocus(-1, 0); break;
      case "ArrowRight": moveFocus(1, 0); break;
      case "ArrowUp": moveFocus(0, -1); break;
      case "ArrowDown": moveFocus(0, 1); break;
      case "Enter": if (focusHit) pin(focusHit); break;
      case "Escape": unpin(true); break;
      default: return;
    }
    e.preventDefault();
  });
  canvas.addEventListener("focus", () => {
    if (focusHit) ring.classList.add("on");
    else moveFocus(0, 0);
  });
  canvas.addEventListener("blur", () => ring.classList.remove("on"));
}

// ---------- Startup ------------------------------------------------------
function initChart() {
  // Set before buildScene: the catch below writes to it when WebGL is missing, and setupChart is never reached then.
  noteEl = $("chart-note");
  try {
    buildScene();
    chartOK = true;
  } catch (err) {
    chartOK = false;
    noteEl.textContent = "The chart needs WebGL, which this browser did not provide. The tables below have the same data.";
    return;
  }
  attachCanvas();
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    if (onScreen) kick();
  }).observe(host);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) kick();
  });
  let rt = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => state.data && render("resize"), 150);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    for (const s of series.values()) {
      s.color = token(`--s${(s.ci % 7) + 1}`);
      s.matLine.color.set(s.color);
      s.matPts.uniforms.uColor.value.set(s.color);
    }
    gridLines.material.color.set(token("--line"));
    epRecolor();
    if (state.data) render("resize");
  });
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => finishAll());
}

// Read-only introspection for the browser checks. It reports positions and states only.
window.__chartDebug = () => ({
  tweens: tweens.size,
  W: chart.W,
  top: chart.top,
  t0: chart.t0,
  t1: chart.t1,
  reduced: reduced(),
  series: [...series.values()].map((s) => ({
    key: s.key,
    sy: +s.st.sy.toFixed(3),
    op: +s.st.op.toFixed(3),
    hidden: s.st.hidden,
    items: s.items.map((it) => {
      const p = toScreen(s, it);
      return { ts: it.ts, x: +it.x.toFixed(1), y: +it.y.toFixed(1), a: +it.a.toFixed(3), hs: +it.hs.toFixed(3), exiting: !!it.exiting, sx: +p.x.toFixed(1), sy: +p.y.toFixed(1) };
    }),
  })),
});

// ---------- Cards, tables, status (unchanged behaviour) ------------------
// The status describes the dashboard's connection to its data, based on the last successful load.
// Returns [class, full wording, phone wording]. Phones get the short wording; the full text stays in the accordion.
function statusInfo() {
  if (state.failed) return ["bad", "Can't reach the data", "No connection"];
  if (state.fetchedAt == null) return ["old", "Loading the data", "Loading"];
  const age = Date.now() - state.fetchedAt;
  const s = Math.round(age / 1000);
  const shortAge = s < 90 ? `${s} s` : Math.round(s / 60) < 90 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  if (age > STALE_MS) {
  const m = Math.round(age / 60_000);
  return ["old", `Data ${m} min old`, `Old · ${m} min`];
  }
  return ["ok", `Live, updated ${ago(state.fetchedAt)}`, `Live · ${shortAge}`];
}

function renderTick() {
  const left = state.nextAt - Date.now();
  $("countdown").querySelector(".long").textContent = state.auto ? "Refresh in " : "Auto-refresh ";
  $("cd-time").textContent = state.auto ? (left > 0 ? mmss(left) : "now") : "off";
  const [cls, text, short] = statusInfo();
  $("pill").className = `pill ${cls}`;
  $("pill-text").textContent = text;
  $("pill-short").textContent = short;
  $("updated").textContent = state.fetchedAt ? when(state.fetchedAt) : "not yet";
}

function renderStatus() {
  const d = state.data;
  const el = $("status");
  $("error-box").hidden = !state.failed;
  if (!d) {
    el.className = `status${state.failed ? " bad" : ""}`;
    el.textContent = state.failed ? "Could not load the data. Check the connection, then retry." : "Loading the latest data.";
    return;
  }
  const span = state.range === "7d" ? "7 days" : "24 hours";
  const b = d.browser.length;
  const s = d.runs.length;
  el.className = state.failed ? "status bad" : "status";
  el.textContent = state.failed
    ? `Could not refresh. Showing data fetched ${ago(state.fetchedAt)}.`
    : `${b} real-browser test${b === 1 ? "" : "s"} and ${s} check${s === 1 ? "" : "s"} from our server in the last ${span}.`;
}

function renderCards(d) {
  const host = $("cards");
  host.innerHTML = "";
  const big = (lbl, v) => `<div class="big"><span class="lbl">${lbl}</span><span class="val">${v}</span></div>`;
  for (const id of REF_IDS) {
    const loc = d.locations.find((l) => l.id === id);
    if (!loc) continue;
    const rs = d.runs.filter((r) => r.loc[id]).map((r) => r.loc[id]);
    const n = rs.reduce((a, s) => a + s.n, 0);
    const ok = rs.reduce((a, s) => a + s.ok, 0);
    const card = document.createElement("article");
    card.className = "stat";
    card.innerHTML = `<h3>${CARD_TITLE[id] ?? plainLabel(loc)}</h3>
      <div class="bigs">${big("First byte", short(median(rs.map((s) => s.ttfb))))}${big("Full load", short(median(rs.map((s) => s.total))))}${big("Worked", pct(ok, n))}${big("Worst full load", short(maxOf(rs.map((s) => s.total))))}</div>
      <p class="small foot">${n} checks</p>`;
    host.append(card);
  }
  for (const page of d.pages) {
    const rows = d.browser.filter((b) => b.page === page.id);
    if (rows.length === 0) continue;
    const card = document.createElement("article");
    card.className = "stat";
    card.innerHTML = `<h3>${page.label.replace(/^ExpanPress /, "")}</h3>`;
    const sources = [...new Set(rows.map((r) => r.source))];
    for (const src of sources) {
      const rs = rows.filter((r) => r.source === src);
      const sub = document.createElement("div");
      sub.className = "src";
      sub.innerHTML = `<p class="small sub">${SOURCE_NAME[src] ?? src} · <time title="Cairo time">${lastTime(rs)}</time></p>
        <div class="bigs">${big("First byte", short(median(rs.map((r) => r.metrics.ttfb))))}${big("Full load", short(median(rs.map((r) => r.metrics.pageLoadTime))))}${big("Main content", short(median(rs.map((r) => r.metrics.largestContentfulPaint))))}${big("Worst full load", short(maxOf(rs.map((r) => r.metrics.pageLoadTime))))}</div>`;
      card.append(sub);
    }
    const samples = rows.reduce((a, r) => a + r.samples, 0);
    card.insertAdjacentHTML("beforeend", `<p class="small foot">${samples} checks</p>`);
    host.append(card);
  }
  if (d.browser.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No real-browser tests in this period yet.";
    host.append(p);
  }
}

function row(cells) {
  const tr = document.createElement("tr");
  cells.forEach((c, i) => {
    const td = document.createElement(i === 0 ? "th" : "td");
    if (i === 0) td.scope = "row";
    td.textContent = c;
    tr.append(td);
  });
  return tr;
}

function renderTables(d) {
  const latest = d.runs.length ? d.runs[d.runs.length - 1] : null;
  $("latest-note").textContent = latest ? `Check at ${when(latest.ts)}.` : "No check recorded yet.";
  const lb = $("latest-body");
  lb.innerHTML = "";
  for (const loc of d.locations.filter((l) => REF_IDS.includes(l.id))) {
    const l = latest?.loc?.[loc.id];
    lb.append(row([plainLabel(loc), ms(l?.total), ms(l?.ttfb), l ? `${l.ok} of ${l.n}` : "n/a", l ? String(l.to) : "n/a"]));
  }
}

// mode: "entry" (first load), "refresh" (5-minute poll), "range", "metric", "resize".
function render(mode = "refresh") {
  renderStatus();
  renderTick();
  const d = state.data;
  if (!d) return;
  renderCards(d);
  renderRangeInfo(d);
  applyChart(d, mode);
  renderTables(d);
  renderPerEndpoint(d, mode);
}

// ---------- Per-endpoint cards -------------------------------------------
// One card per endpoint, two per row on wide screens. Each card has readings (First byte, Full load), a view
// (each run, or block means with the lowest and highest run as markers), its own scale or one shared scale,
// a drag handle, and keyboard reordering. Choices are kept on this device.
const EP_W = 640;
const EP_H = 170;
const EP_PAD = { L: 52, R: 12, T: 10, B: 24 };
const EP_HOVER = 1.6;
const EP_BAD = "#d9534f";
const EP_KEY = "expan-endpoint-layout-v1";
const EP_HIT = 14; // px, hover
const EP_TAP = 22; // px, tap or click
const SVG_NS = "http://www.w3.org/2000/svg";
const EP_NAME = {
  "expanpress-home": "expanpress.com home page",
  "expanpress-terms": "expanpress.com terms page",
  "paddle-api": "Paddle API (live)",
  "paddle-sandbox-api": "Paddle API (sandbox)",
  "paddle-cdn-js": "Paddle.js loader",
  "supabase-rest": "Supabase database API",
  "upstash-rest-prod": "Upstash Redis API",
};
// Full load is drawn first. First byte is dashed on top, so it stays visible where the two readings match.
const EP_FIELDS = [
  { key: "total", label: "Full load", tok: "--s1", dash: null },
  { key: "ttfb", label: "First byte", tok: "--s2", dash: "7 5" },
];
const EP_VIEWS = ["run", "band"];
const EP_EASE = {
  quart: (p) => 1 - Math.pow(1 - p, 4),
  expo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  quad: (p) => 1 - (1 - p) * (1 - p),
};
// Shared by every card, so the time axes line up. Tweened on refresh.
const epDomain = { t0: 0, t1: 1 };
let epXTicks = [];
const epCards = new Map();
const epTweens = new Set();
let epRaf = 0;

function epSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function epMedian(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A check failed when it had an error, no status, or a server error.
const epFailed = (p) => p.e != null || p.s == null || p.s >= 500;
const epX = (ts) => EP_PAD.L + ((ts - epDomain.t0) / (epDomain.t1 - epDomain.t0 || 1)) * (EP_W - EP_PAD.L - EP_PAD.R);
const epY = (c, v) => EP_PAD.T + (1 - v / (c.top || 1)) * (EP_H - EP_PAD.T - EP_PAD.B);
const epPointOf = (c, m) => ({ x: epX(m.it.ts), y: m.it.v === null ? EP_H - EP_PAD.B : epY(c, m.it.v) });
const epBucketMs = () => (state.range === "7d" ? 6 * 3_600_000 : 3 * 3_600_000);
const epBucketLabel = () => (state.range === "7d" ? "6-hour" : "3-hour");

// Layout and choices, kept on this device. Storage can be blocked, so every access is guarded.
function epLoadLayout() {
  try {
    const j = JSON.parse(localStorage.getItem(EP_KEY) || "{}");
    const keys = new Set(EP_FIELDS.map((f) => f.key));
    const pick = {};
    const view = {};
    if (j.pick && typeof j.pick === "object") {
      for (const [id, v] of Object.entries(j.pick)) if (Array.isArray(v)) pick[id] = v.filter((k) => keys.has(k));
    }
    if (j.view && typeof j.view === "object") {
      for (const [id, v] of Object.entries(j.view)) if (EP_VIEWS.includes(v)) view[id] = v;
    }
    return { order: Array.isArray(j.order) ? j.order.filter((s) => typeof s === "string") : [], pick, view, shared: j.shared === true };
  } catch {
    return { order: [], pick: {}, view: {}, shared: false };
  }
}
function epSaveLayout() {
  try {
    localStorage.setItem(EP_KEY, JSON.stringify(epLayout));
  } catch {
    // Storage blocked: the choices still work for this visit.
  }
}
const epLayout = epLoadLayout();

// ---------- Tweens (same rules as the main chart) -----------------------
function epTo(o, k, to, ms, opt = {}) {
  for (const t of epTweens) if (t.o === o && t.k === k) epTweens.delete(t);
  const d = dur(ms);
  if (d === 0) {
    o[k] = to;
    if (opt.done) opt.done();
    return;
  }
  epTweens.add({ o, k, from: o[k], to, d, start: performance.now() + (opt.delay || 0), e: opt.e || EP_EASE.quart, done: opt.done });
  epKick();
}

function epKick() {
  if (!epRaf) epRaf = requestAnimationFrame(epFrame);
}

function epFrame(now) {
  epRaf = 0;
  let busy = false;
  for (const t of [...epTweens]) {
    if (now < t.start) {
      busy = true;
      continue;
    }
    const p = Math.min(1, (now - t.start) / t.d);
    t.o[t.k] = t.from + (t.to - t.from) * t.e(p);
    if (p >= 1) {
      epTweens.delete(t);
      if (t.done) t.done();
    } else busy = true;
  }
  epPaintAll();
  if (busy && !epRaf) epRaf = requestAnimationFrame(epFrame);
}

// ---------- Cards ---------------------------------------------------------
function epMakeCard(id) {
  const name = EP_NAME[id] ?? id;
  const el = document.createElement("article");
  el.className = "ep-card";
  el.dataset.id = id;
  el.style.display = "none";
  el.innerHTML = `
    <div class="ep-head">
      <button type="button" class="ep-handle" title="Drag to move, or use the arrow keys">
        <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg>
      </button>
      <h3 class="ep-title"></h3>
    </div>
    <p class="ep-sub small"></p>
    <div class="ep-controls">
      <div class="seg ep-filters" role="group">
        <button type="button" class="btn" data-f="ttfb" aria-pressed="false">First byte</button>
        <button type="button" class="btn" data-f="total" aria-pressed="false">Full load</button>
      </div>
      <div class="seg ep-views" role="group">
        <button type="button" class="btn" data-v="run" aria-pressed="true">Each run</button>
        <button type="button" class="btn" data-v="band" aria-pressed="false">Low to high</button>
      </div>
    </div>
    <div class="ep-plot"></div>`;
  el.querySelector(".ep-title").textContent = name;
  el.querySelector(".ep-handle").setAttribute("aria-label", `Move ${name}. Drag, or use the arrow keys.`);
  el.querySelector(".ep-filters").setAttribute("aria-label", `Readings for ${name}`);
  el.querySelector(".ep-views").setAttribute("aria-label", `View for ${name}`);

  // The chart takes arrow keys, so it is an application, not a static image. Its label says how to use it.
  const svg = epSvg("svg", { viewBox: `0 0 ${EP_W} ${EP_H}`, class: "ep-svg", role: "application", "aria-roledescription": "chart", tabindex: "0" });
  const gGrid = epSvg("g");
  const grid = [];
  for (let i = 0; i < 6; i++) {
    const line = epSvg("line", { x1: EP_PAD.L, x2: EP_W - EP_PAD.R, stroke: "rgba(128,128,128,.25)", "stroke-width": 1 });
    const text = epSvg("text", { x: EP_PAD.L - 6, "text-anchor": "end", "font-size": 11, fill: "currentColor" });
    gGrid.append(line, text);
    grid.push({ line, text });
  }
  const gX = epSvg("g");
  const xs = [];
  for (let i = 0; i < 6; i++) {
    const tx = epSvg("text", { y: EP_H - 6, "text-anchor": "middle", "font-size": 11, fill: "currentColor" });
    tx.style.display = "none";
    gX.append(tx);
    xs.push(tx);
  }
  svg.append(gGrid, gX);
  const layers = {};
  for (const f of EP_FIELDS) {
    const g = epSvg("g");
    const color = token(f.tok);
    const pathAttrs = { fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linejoin": "round", "stroke-linecap": "round" };
    if (f.dash) pathAttrs["stroke-dasharray"] = f.dash;
    const path = epSvg("path", pathAttrs);
    const dots = epSvg("g");
    const band = epSvg("g");
    band.setAttribute("display", "none");
    g.append(path, dots, band);
    svg.append(g);
    layers[f.key] = { g, path, dots, band, bl: [], bc: [], op: 0, color };
  }
  const ring = epSvg("circle", { r: 9, fill: "none", "stroke-width": 3, stroke: token("--focus") });
  ring.style.display = "none";
  svg.append(ring);
  el.querySelector(".ep-plot").append(svg);

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("aria-hidden", "true");
  el.append(tip);

  const buttons = {};
  for (const b of el.querySelectorAll(".ep-filters button")) buttons[b.dataset.f] = b;
  const views = {};
  for (const b of el.querySelectorAll(".ep-views button")) views[b.dataset.v] = b;
  const c = {
    id,
    name,
    el,
    svg,
    tip,
    tipFor: null,
    tipRaw: null,
    grid,
    xs,
    layers,
    ring,
    buttons,
    views,
    sub: el.querySelector(".ep-sub"),
    handle: el.querySelector(".ep-handle"),
    items: { ttfb: new Map(), total: new Map() },
    bands: { ttfb: [], total: [] },
    sel: null,
    nextSel: null,
    runs: [],
    view: epLayout.view[id] ?? "run",
    top: 100,
    ticks: [],
    vmax: 0,
    index: 0,
    shown: false,
    hover: null,
    pin: null,
    focus: null,
  };
  for (const b of el.querySelectorAll(".ep-filters button")) b.addEventListener("click", () => epToggle(c, b.dataset.f));
  for (const b of el.querySelectorAll(".ep-views button")) b.addEventListener("click", () => epSetView(c, b.dataset.v));
  epApplyView(c);
  epAttachSvg(c);
  epDrag(c);
  return c;
}

// Points for one card. Each run is kept by timestamp, so it can fade in and out.
function epIngest(c, runs, delay) {
  c.runs = runs;
  for (const f of EP_FIELDS) {
    const map = c.items[f.key];
    const seen = new Set();
    for (const p of runs) {
      const v = typeof p[f.key] === "number" ? p[f.key] : null;
      const failed = epFailed(p);
      if (v === null && !failed) continue; // no value and no failure: nothing to draw
      const key = String(p.ts);
      seen.add(key);
      let it = map.get(key);
      if (!it) {
        it = { ts: p.ts, v, failed, raw: p, a: 0, hs: 1, hsT: 1, exiting: false, el: null };
        map.set(key, it);
        epTo(it, "a", 1, 400, { delay, e: EP_EASE.expo });
      } else if (it.exiting) {
        it.exiting = false;
        epTo(it, "a", 1, 300);
      }
      it.v = v;
      it.failed = failed;
      it.raw = p;
    }
    for (const [key, it] of map) {
      if (seen.has(key) || it.exiting) continue;
      it.exiting = true;
      epTo(it, "a", 0, 300, {
        done: () => {
          if (it.exiting) {
            map.delete(key);
            it.el?.remove();
          }
        },
      });
    }
  }
}

// Block means for the low-to-high view: one point per block, with the lowest and highest run in it.
function epBuckets(c, key) {
  const B = epBucketMs();
  const groups = new Map();
  for (const p of c.runs) {
    if (typeof p[key] !== "number") continue;
    const k = Math.floor(p.ts / B);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.values()]
    .sort((a, b) => a[0].ts - b[0].ts)
    .map((rows) => {
      const vs = rows.map((p) => p[key]).sort((a, b) => a - b);
      return {
        ts: rows.reduce((s, p) => s + p.ts, 0) / rows.length,
        mean: vs.reduce((s, v) => s + v, 0) / vs.length,
        min: vs[0],
        max: vs[vs.length - 1],
        n: vs.length,
      };
    });
}

function epSummaryLine(c) {
  const runs = c.runs;
  const ok = runs.filter((p) => !epFailed(p)).length;
  const parts = EP_FIELDS.filter((f) => c.sel?.[f.key]).map((f) => {
    const vals = runs.map((p) => p[f.key]).filter((v) => typeof v === "number");
    const latest = [...runs].reverse().find((p) => typeof p[f.key] === "number");
    return `${f.label}: latest ${latest ? ms(latest[f.key]) : "n/a"}, typical ${ms(epMedian(vals))}`;
  });
  const note = c.view === "band" ? ` · ${epBucketLabel()} means, markers at the lowest and highest run` : "";
  return `${parts.join(" · ") || "No reading selected"} · worked ${ok} of ${runs.length} checks${note}`;
}

function epApplyView(c) {
  for (const k of EP_VIEWS) c.views[k].setAttribute("aria-pressed", String(c.view === k));
}

function epSetView(c, v) {
  if (c.view === v) return;
  c.view = v;
  epLayout.view[c.id] = v;
  epSaveLayout();
  if (v === "band") {
    c.hover = null;
    c.pin = null;
    c.focus = null;
  }
  epApplyView(c);
  epMarks(c);
  c.sub.textContent = epSummaryLine(c);
  epPaintAll();
}

function epApplySel(c, ms_, delay) {
  for (const f of EP_FIELDS) {
    const on = !!c.sel[f.key];
    epTo(c.layers[f.key], "op", on ? 1 : 0, ms_, { delay });
    c.buttons[f.key].setAttribute("aria-pressed", String(on));
  }
  // A hidden reading cannot keep a tooltip, pin or focus.
  if (c.hover && !c.sel[c.hover.f]) c.hover = null;
  if (c.pin && !c.sel[c.pin.f]) c.pin = null;
  if (c.focus && !c.sel[c.focus.f]) c.focus = null;
  epMarks(c);
  c.sub.textContent = epSummaryLine(c);
}

function epToggle(c, f) {
  const on = c.sel[f];
  if (on && !EP_FIELDS.some((g) => g.key !== f && c.sel[g.key])) return; // keep one reading showing
  c.sel = { ...c.sel, [f]: !on };
  epLayout.pick[c.id] = EP_FIELDS.filter((g) => c.sel[g.key]).map((g) => g.key);
  epSaveLayout();
  epApplySel(c, 200, 0);
  epPaintAll();
}

// Hover, pin and focus scale the point under them, like the main chart.
function epMarks(c) {
  for (const f of EP_FIELDS) {
    for (const it of c.items[f.key].values()) {
      const on = [c.hover, c.pin, c.focus].some((m) => m && m.it === it);
      const t = on ? EP_HOVER : 1;
      if (it.hsT !== t) {
        it.hsT = t;
        epTo(it, "hs", t, 150, { e: EP_EASE.quad });
      }
    }
  }
  // Refill when the pinned or hovered point changes, or when a refresh gave it new data.
  const m = c.pin ?? c.hover;
  if (m !== c.tipFor || (m && m.it.raw !== c.tipRaw)) {
    c.tipFor = m;
    c.tipRaw = m ? m.it.raw : null;
    if (m) epFillTip(c, m);
  }
  epKick(); // repaint now, so a cleared tooltip hides even when nothing else is animating
}

function epFillTip(c, m) {
  const f = EP_FIELDS.find((g) => g.key === m.f);
  const p = m.it.raw;
  c.tip.replaceChildren();
  const add = (cls, text) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    c.tip.append(d);
  };
  add("tip-title", `${f.label}: ${m.it.v === null ? "no reply" : ms(m.it.v)}`);
  add("", m.it.failed ? `Failed: ${p.e ? p.e : p.s != null ? `HTTP ${p.s}` : "no reply"}` : "Worked");
  if (p.c || p.ed) add("", `Served: ${p.c ?? "unknown"}${p.ed ? ` from ${p.ed}` : ""}${p.ag != null ? `, cached ${p.ag} s` : ""}`);
  add("tip-time", cairoTime(m.it.ts));
}

function epPlaceTip(c, m) {
  const p = epPointOf(c, m);
  const sr = c.svg.getBoundingClientRect();
  const cr = c.el.getBoundingClientRect();
  const px = sr.left - cr.left + (p.x / EP_W) * sr.width;
  const py = sr.top - cr.top + (p.y / EP_H) * sr.height;
  const w = c.tip.offsetWidth;
  const h = c.tip.offsetHeight;
  let x = px + 12;
  let y = py - h - 10;
  if (x + w > cr.width - 4) x = px - w - 12;
  if (y < 0) y = py + 12;
  c.tip.style.left = `${Math.max(0, x)}px`;
  c.tip.style.top = `${Math.max(0, y)}px`;
}

// Block view: a mean point per block, with a bar from the lowest to the highest run and caps at both ends.
function epPaintBand(c, key, L) {
  const bs = c.bands[key] ?? [];
  let d = "";
  bs.forEach((b, i) => {
    d += `${i ? " L" : "M"}${epX(b.ts).toFixed(1)},${epY(c, b.mean).toFixed(1)}`;
  });
  L.path.setAttribute("d", d);
  bs.forEach((b, i) => {
    if (!L.bl[i]) {
      L.bl[i] = epSvg("path", { fill: "none", "stroke-width": 1.6, "stroke-linecap": "round" });
      L.bc[i] = epSvg("circle", { r: 3 });
      L.band.append(L.bl[i], L.bc[i]);
    }
    const x = epX(b.ts);
    const xs = x.toFixed(1);
    const lo = epY(c, b.min).toFixed(1);
    const hi = epY(c, b.max).toFixed(1);
    const left = (x - 4).toFixed(1);
    const right = (x + 4).toFixed(1);
    L.bl[i].setAttribute("d", `M${xs},${lo} L${xs},${hi} M${left},${lo} L${right},${lo} M${left},${hi} L${right},${hi}`);
    L.bl[i].setAttribute("stroke", L.color);
    L.bl[i].style.display = "";
    L.bc[i].setAttribute("cx", xs);
    L.bc[i].setAttribute("cy", epY(c, b.mean).toFixed(1));
    L.bc[i].setAttribute("fill", L.color);
    L.bc[i].style.display = "";
  });
  for (let i = bs.length; i < L.bl.length; i++) {
    L.bl[i].style.display = "none";
    L.bc[i].style.display = "none";
  }
}

function epPaint(c) {
  if (c.el.style.display === "none") return;
  for (const k of ["hover", "pin", "focus"]) if (c[k] && c[k].it.exiting) c[k] = null;

  c.grid.forEach((g, i) => {
    const t = c.ticks[i];
    const show = t !== undefined;
    g.line.style.display = show ? "" : "none";
    g.text.style.display = show ? "" : "none";
    if (!show) return;
    const y = epY(c, t).toFixed(1);
    g.line.setAttribute("y1", y);
    g.line.setAttribute("y2", y);
    g.text.setAttribute("y", (epY(c, t) + 4).toFixed(1));
    const label = t.toLocaleString("en-US");
    if (g.text.textContent !== label) g.text.textContent = label;
  });
  c.xs.forEach((tx, i) => {
    const t = epXTicks[i];
    tx.style.display = t === undefined ? "none" : "";
    if (t === undefined) return;
    tx.setAttribute("x", epX(t).toFixed(1));
    const label = state.range === "7d" ? `${CAIRO_DM.format(t)} ${CAIRO_HM.format(t)}` : CAIRO_HM.format(t);
    if (tx.textContent !== label) tx.textContent = label;
  });

  const band = c.view === "band";
  for (const f of EP_FIELDS) {
    const L = c.layers[f.key];
    L.g.setAttribute("opacity", L.op.toFixed(3));
    L.dots.setAttribute("display", band ? "none" : "");
    L.band.setAttribute("display", band ? "" : "none");
    if (band) {
      epPaintBand(c, f.key, L);
      continue;
    }
    const items = [...c.items[f.key].values()].sort((a, b) => a.ts - b.ts);
    let d = "";
    let seg = [];
    for (const it of items) {
      // A failed check with no value breaks the line and is drawn as a red mark on the baseline.
      if (it.v === null) {
        if (seg.length > 1) d += `M${seg.join(" L")}`;
        seg = [];
        continue;
      }
      seg.push(`${epX(it.ts).toFixed(1)},${epY(c, it.v).toFixed(1)}`);
    }
    if (seg.length > 1) d += `M${seg.join(" L")}`;
    L.path.setAttribute("d", d);
    for (const it of items) {
      if (!it.el) {
        it.el = epSvg("circle", { r: 2.6 });
        L.dots.append(it.el);
      }
      const y = it.v === null ? EP_H - EP_PAD.B : epY(c, it.v);
      it.el.setAttribute("cx", epX(it.ts).toFixed(1));
      it.el.setAttribute("cy", y.toFixed(1));
      it.el.setAttribute("r", ((it.v === null ? 3.2 : 2.6) * it.hs).toFixed(2));
      it.el.setAttribute("fill", it.failed ? EP_BAD : L.color);
      it.el.setAttribute("opacity", it.a.toFixed(3));
    }
  }

  const m = c.pin ?? c.hover;
  if (m && !m.it.exiting && m.it.a > 0.3) {
    c.tip.classList.add("on");
    epPlaceTip(c, m);
  } else c.tip.classList.remove("on");

  if (c.focus && !c.focus.it.exiting) {
    const p = epPointOf(c, c.focus);
    c.ring.setAttribute("cx", p.x.toFixed(1));
    c.ring.setAttribute("cy", p.y.toFixed(1));
    c.ring.style.display = "";
  } else c.ring.style.display = "none";
}

function epPaintAll() {
  for (const c of epCards.values()) epPaint(c);
}

// Colours follow the theme. Called when the system theme changes.
function epRecolor() {
  for (const c of epCards.values()) {
    for (const f of EP_FIELDS) {
      const L = c.layers[f.key];
      L.color = token(f.tok);
      L.path.setAttribute("stroke", L.color);
    }
  }
}

// ---------- Pointer and keyboard -----------------------------------------
function epToView(c, e) {
  const r = c.svg.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (EP_W / r.width), y: (e.clientY - r.top) * (EP_H / r.height), scale: EP_W / r.width };
}

// Nearest visible run within radius (in viewBox units). The block view has no per-run points to hit.
function epNearest(c, px, py, radius) {
  if (c.view === "band") return null;
  let best = null;
  let bd = radius;
  for (const f of EP_FIELDS) {
    if (c.layers[f.key].op < 0.5) continue;
    for (const it of c.items[f.key].values()) {
      if (it.exiting || it.a < 0.5) continue;
      const q = epPointOf(c, { it });
      const d = Math.hypot(q.x - px, q.y - py);
      if (d <= bd) {
        bd = d;
        best = { f: f.key, it };
      }
    }
  }
  return best;
}

function epVisible(c) {
  const list = [];
  for (const f of EP_FIELDS) {
    if (!c.sel?.[f.key]) continue;
    for (const it of c.items[f.key].values()) if (!it.exiting && it.a >= 0.5) list.push({ f: f.key, it });
  }
  return list.sort((a, b) => a.it.ts - b.it.ts);
}

function epStep(c, dir) {
  if (c.view === "band") return;
  const list = epVisible(c);
  if (!list.length) return;
  let i = c.focus ? list.findIndex((m) => m.it === c.focus.it) : -1;
  i = i < 0 ? list.length - 1 : Math.min(list.length - 1, Math.max(0, i + dir));
  c.focus = list[i];
}

function epAttachSvg(c) {
  const svg = c.svg;
  svg.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const p = epToView(c, e);
    c.hover = epNearest(c, p.x, p.y, EP_HIT * p.scale);
    epMarks(c);
  });
  svg.addEventListener("pointerleave", () => {
    c.hover = null;
    epMarks(c);
  });
  // A tap or click on a point pins its tooltip. A tap elsewhere clears the pin.
  svg.addEventListener("pointerdown", (e) => {
    const p = epToView(c, e);
    c.pin = epNearest(c, p.x, p.y, EP_TAP * p.scale);
    epMarks(c);
  });
  svg.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowLeft":
        epStep(c, -1);
        break;
      case "ArrowRight":
        epStep(c, 1);
        break;
      case "Enter":
        c.pin = c.focus;
        break;
      case "Escape":
        c.pin = null;
        c.focus = null;
        break;
      default:
        return;
    }
    e.preventDefault();
    epMarks(c);
  });
  svg.addEventListener("blur", () => {
    c.focus = null;
    epMarks(c);
  });
}

// ---------- Placing cards: drag, keyboard, FLIP animation ----------------
const epVisibleCards = (host) => [...host.children].filter((el) => el.style.display !== "none");

function epSaveOrder(host) {
  epLayout.order = [...host.children].map((el) => el.dataset.id);
  epSaveLayout();
}

// Cards slide from their old place to the new one, 280 ms, like the main chart's transitions.
function epFlip(els, before) {
  if (reduced()) return;
  for (const el of els) {
    const b = before.get(el);
    if (!b) continue;
    const a = el.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 280, easing: "cubic-bezier(.16, 1, .3, 1)" });
  }
}

function epDrag(c) {
  const h = c.handle;
  h.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const host = $("per-endpoint");
    h.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let target = null;
    let side = "before";
    c.el.classList.add("dragging");

    const onMove = (ev) => {
      c.el.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
      target = null;
      for (const el of epVisibleCards(host)) {
        if (el === c.el) continue;
        const r = el.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          target = el;
          side = ev.clientX < r.left + r.width / 2 ? "before" : "after";
        }
      }
      for (const el of epVisibleCards(host)) {
        if (el === target) el.dataset.drop = side;
        else delete el.dataset.drop;
      }
    };

    const cleanup = () => {
      h.removeEventListener("pointermove", onMove);
      h.removeEventListener("pointerup", onUp);
      h.removeEventListener("pointercancel", onCancel);
      if (h.hasPointerCapture(e.pointerId)) h.releasePointerCapture(e.pointerId);
      for (const el of epVisibleCards(host)) delete el.dataset.drop;
    };

    const onUp = () => {
      cleanup();
      const els = epVisibleCards(host);
      const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
      c.el.style.transform = "";
      if (target && target !== c.el) {
        const ref = side === "before" ? target : target.nextElementSibling;
        if (ref !== c.el) host.insertBefore(c.el, ref);
      }
      c.el.classList.remove("dragging");
      epFlip(els, before);
      epSaveOrder(host);
      h.focus({ preventScroll: true });
    };

    const onCancel = () => {
      cleanup();
      c.el.style.transform = "";
      c.el.classList.remove("dragging");
    };

    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerup", onUp);
    h.addEventListener("pointercancel", onCancel);
  });

  // Keyboard: the arrow keys move the card one place at a time.
  h.addEventListener("keydown", (e) => {
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const host = $("per-endpoint");
    const vis = epVisibleCards(host);
    const i = vis.indexOf(c.el);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= vis.length) return;
    const before = new Map(vis.map((el) => [el, el.getBoundingClientRect()]));
    if (dir < 0) host.insertBefore(c.el, vis[j]);
    else host.insertBefore(c.el, vis[j].nextElementSibling);
    epFlip(vis, before);
    epSaveOrder(host);
    h.focus({ preventScroll: true });
  });
}

// Order: saved order first; endpoints not saved yet follow in their server order.
function epPlaceCards(host, all) {
  const rank = (id) => {
    const i = epLayout.order.indexOf(id);
    return i < 0 ? 1000 + all.indexOf(id) : i;
  };
  const ordered = [...all].sort((a, b) => rank(a) - rank(b)).map((id) => epCards.get(id).el);
  const cur = [...host.children];
  if (cur.length === ordered.length && cur.every((el, i) => el === ordered[i])) return;
  host.append(...ordered);
}

function renderPerEndpoint(d, mode = "refresh") {
  const host = $("per-endpoint");
  if (!host) return;
  const series = d.series || {};
  const all = d.targetIds || [];
  for (const id of all) if (!epCards.has(id)) epCards.set(id, epMakeCard(id));
  const live = all.filter((id) => (series[id] || []).length > 0);
  epPlaceCards(host, all);
  $("ep-empty").hidden = live.length > 0;
  $("ep-shared").setAttribute("aria-pressed", String(epLayout.shared));

  // The readings a card shows: its own choice if it made one, otherwise the main chart's reading.
  const fallback = state.metric === "ttfb" ? ["ttfb"] : ["total"];
  let t0 = Infinity;
  let t1 = -Infinity;
  let sharedMax = 0;
  live.forEach((id, k) => {
    const c = epCards.get(id);
    c.index = k;
    const pick = epLayout.pick[id];
    const want = Array.isArray(pick) && pick.length ? pick : fallback;
    c.nextSel = { ttfb: want.includes("ttfb"), total: want.includes("total") };
    c.view = epLayout.view[id] ?? "run";
    epApplyView(c);
    c.vmax = 0;
    for (const p of series[id]) {
      t0 = Math.min(t0, p.ts);
      t1 = Math.max(t1, p.ts);
      for (const f of EP_FIELDS) if (c.nextSel[f.key] && typeof p[f.key] === "number") c.vmax = Math.max(c.vmax, p[f.key]);
    }
    sharedMax = Math.max(sharedMax, c.vmax);
  });
  if (!live.length) {
    t0 = 0;
    t1 = 1;
  }
  const moveMs = mode === "entry" || mode === "resize" ? 0 : 500;

  // Scale: each card fits its own readings, with headroom, or every card shares one scale.
  for (const id of live) {
    const c = epCards.get(id);
    // Own scale: small readings get about 4.5x headroom (50-100 ms reads on a 450-500 axis); large ones
    // get 2x, so a 1.2 s page is not drawn on an 8 s axis. Never below 250 ms.
    const headroom = c.vmax <= 200 ? c.vmax * 4.5 : c.vmax * 2;
    const sc = niceScale(epLayout.shared ? Math.max(250, sharedMax) : Math.max(250, headroom));
    c.ticks = sc.ticks;
    epTo(c, "top", sc.top, moveMs);
  }
  epTo(epDomain, "t0", t0, moveMs);
  epTo(epDomain, "t1", t1, moveMs);
  epXTicks = live.length ? xTicksFor(state.range, t0, t1, Math.max(2, Math.floor((EP_W - EP_PAD.L - EP_PAD.R) / 110))) : [];

  for (const id of all) {
    const c = epCards.get(id);
    if (!live.includes(id)) {
      c.el.style.display = "none";
      continue;
    }
    const first = !c.shown;
    c.shown = true;
    c.el.style.display = "";
    const changed = !c.sel || c.sel.ttfb !== c.nextSel.ttfb || c.sel.total !== c.nextSel.total;
    if (first || changed) {
      c.sel = c.nextSel;
      if (first && !reduced()) {
        c.el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 400, delay: c.index * 60, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "backwards" });
      }
      epIngest(c, series[id], first ? c.index * 60 : 0);
      c.bands = { ttfb: epBuckets(c, "ttfb"), total: epBuckets(c, "total") };
      epApplySel(c, first ? 300 : 200, first ? c.index * 60 : 0);
    } else {
      epIngest(c, series[id], 0);
      c.bands = { ttfb: epBuckets(c, "ttfb"), total: epBuckets(c, "total") };
      epMarks(c); // a pinned tooltip picks up the refreshed values
      c.sub.textContent = epSummaryLine(c);
    }
    c.svg.setAttribute("aria-label", `${c.name}. ${c.sub.textContent}`);
  }
  epPaintAll();
}

// Empty the saved arrangement, choices and scale setting, back to the defaults.
function epResetLayout() {
  epLayout.order = [];
  epLayout.pick = {};
  epLayout.view = {};
  epLayout.shared = false;
  epSaveLayout();
}

async function refresh(mode = "refresh") {
  if (state.inFlight) return;
  state.inFlight = true;
  let ok = false;
  try {
    const res = await fetch(`/api/dashboard-data?window=${state.range}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`http_${res.status}`);
    state.data = await res.json();
    state.fetchedAt = Date.now();
    state.failed = false;
    ok = true;
  } catch {
    state.failed = true;
  } finally {
    state.inFlight = false;
    state.nextAt = Date.now() + AUTO_MS;
  }
  render(mode);
  if (ok) $("announce").textContent = `Updated at ${cairoTime(state.fetchedAt)}`;
}

function setPressed(ids, activeId) {
  for (const id of ids) $(id).setAttribute("aria-pressed", String(id === activeId));
}

$("refresh").addEventListener("click", () => refresh("refresh"));
$("retry").addEventListener("click", () => refresh("refresh"));
$("auto").addEventListener("change", (e) => {
  state.auto = e.target.checked;
  if (state.auto) state.nextAt = Date.now() + AUTO_MS;
  renderTick();
});
// The main reading buttons set every card at once, so they clear each card's own choice.
$("m-ttfb").addEventListener("click", () => {
  epLayout.pick = {};
  epSaveLayout();
  state.metric = "ttfb";
  setPressed(["m-ttfb", "m-total"], "m-ttfb");
  if (state.data) render("metric");
});
$("m-total").addEventListener("click", () => {
  epLayout.pick = {};
  epSaveLayout();
  state.metric = "pageLoadTime";
  setPressed(["m-ttfb", "m-total"], "m-total");
  if (state.data) render("metric");
});
$("r-24h").addEventListener("click", () => {
  state.range = "24h";
  setPressed(["r-24h", "r-7d"], "r-24h");
  refresh("range");
});
$("r-7d").addEventListener("click", () => {
  state.range = "7d";
  setPressed(["r-24h", "r-7d"], "r-7d");
  refresh("range");
});

$("ep-shared").addEventListener("click", () => {
  epLayout.shared = !epLayout.shared;
  epSaveLayout();
  if (state.data) render("refresh");
});

$("ep-reset").addEventListener("click", () => {
  epResetLayout();
  if (state.data) render("metric");
});

// Controls panel: a native disclosure button, closed by default.
$("controls-btn").addEventListener("click", (e) => {
  const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
  e.currentTarget.setAttribute("aria-expanded", String(open));
  $("controls-panel").hidden = !open;
});

// The bar turns translucent once the page scrolls under it, and is opaque at the top.
const topbar = $("topbar");
const onScroll = () => topbar.classList.toggle("scrolled", window.scrollY > 0);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// One timer drives the countdown, the status pill and the 5-minute auto-refresh.
setInterval(() => {
  if (state.auto && Date.now() >= state.nextAt && !state.inFlight) refresh("refresh");
  else renderTick();
}, 1000);

initChart();
refresh("entry");
