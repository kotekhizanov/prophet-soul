// Soul in Omniscient: the page "Soul" in the menu, a 3D graph of memory's
// things and links. Omniscient calls activate(prophet) once per page load;
// the page draws only while it is open. Data comes from the owner's API
// (/api/entities) through prophet.api and is shown as text, never as HTML.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import {
  buildGraph,
  forProject,
  distances,
  edgeBrightness,
  layout,
  nodeBrightness,
  placeLabels,
  search,
  sectors,
  timeline,
} from "./graph.js";

const SPACING = 14;
const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const FONT = "12px ui-sans-serif, system-ui, -apple-system, sans-serif";
const DEFAULTS = { labels: 60, fade_levels: 4, speed: 1, spin: false };
const HELP =
  "Drag — rotate · right drag or Shift — pan · wheel — zoom · " +
  "WASD or arrows — fly · Q/E — down/up · 1–9 — sectors · 0 — overview · " +
  "F — fly to selected · Space — play the timeline · Esc — clear";

export function activate(prophet) {
  try {
    let view = null;
    const page = prophet.ui.page({
      id: "soul",
      title: "Soul",
      icon: "spark",
      render(body) {
        try {
          view = createView(prophet, body);
        } catch (err) {
          console.error("Soul:", err);
          const p = document.createElement("p");
          p.className = "hint";
          p.textContent = `Soul could not open: ${err?.message || err}`;
          body.append(p);
        }
      },
    });
    prophet.on("page", ({ tab }) => view?.shown(tab === `plugin:${prophet.plugin.name}:soul`));
    prophet.on("theme", () => view?.theme());
    prophet.on("settings", (s) => view?.settings(s));
    return page;
  } catch (err) {
    console.error("Soul failed to start:", err);
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(node.style, v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// Play and pause drawn, not typed: "▶" turns into an emoji on some systems.
function icon(kind) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", kind === "pause" ? "M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" : "M3 1.2v9.6L10.5 6z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

function createView(prophet, body) {
  let opts = { ...DEFAULTS, ...prophet.settings() };
  let graph = { nodes: [], edges: [] };
  let list = [];
  let pos = new Float64Array(0);
  let selected = -1;
  let hovered = -1;
  let found = [];
  let currentSector = -1;
  let running = false;
  // The timeline: steps are the times things and links came; `at` is where the
  // slider is (a step index, fractional while playing).
  let steps = [];
  let at = 0;
  let playing = false;
  let shownEdges = -1;

  // ---- the page --------------------------------------------------------------
  body.style.maxWidth = "none";
  const search_ = el("input", { class: "input", type: "search", placeholder: "Search memory…", "aria-label": "Search" });
  search_.style.width = "16rem";
  const projectSel = el("select", { class: "input", "aria-label": "Project" });
  projectSel.style.width = "auto";
  projectSel.append(el("option", { value: "" }, "All projects"));
  const reload = el("button", { type: "button", class: "btn btn-sm" }, "Refresh");
  const overview = el("button", { type: "button", class: "btn btn-sm" }, "Overview");
  const full = el("button", { type: "button", class: "btn btn-sm" }, "Full screen");
  const status = el("span", { class: "hint" });
  const toolbar = el(
    "div",
    { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "10px" } },
    el("div", { style: { position: "relative" } }, search_),
    projectSel,
    reload,
    overview,
    full,
    status,
  );
  const results = el("div", { class: "panel", style: { position: "absolute", zIndex: 5, display: "none", padding: "4px", minWidth: "16rem", maxHeight: "18rem", overflowY: "auto" } });
  search_.parentElement.append(results);

  const root = el("div", {
    style: { position: "relative", width: "100%", height: "calc(100vh - 230px)", minHeight: "420px", overflow: "hidden", borderRadius: "12px", outline: "none" },
    tabindex: "0",
  });
  const canvas = el("canvas", { style: { display: "block", width: "100%", height: "100%", cursor: "grab" } });
  const labels = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" } });
  const sectorBox = el("div", {
    class: "panel",
    style: { position: "absolute", left: "10px", top: "10px", maxHeight: "calc(100% - 64px)", overflowY: "auto", padding: "6px", width: "13rem", fontSize: "12px", opacity: "0.92" },
  });
  const info = el("div", {
    class: "panel",
    style: { position: "absolute", right: "10px", top: "10px", maxHeight: "calc(100% - 64px)", overflowY: "auto", padding: "10px 12px", width: "17rem", fontSize: "13px", display: "none", opacity: "0.95" },
  });
  const help = el("div", { class: "hint", style: { position: "absolute", left: "10px", right: "10px", bottom: "8px", fontSize: "11px", pointerEvents: "none", textAlign: "center" } }, HELP);
  const empty = el("div", { class: "hint", style: { position: "absolute", inset: "0", display: "none", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "24px" } });
  const playBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-label": "Play", title: "Play (Space)" });
  Object.assign(playBtn.style, { width: "1.6rem", height: "1.6rem", padding: "0", flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" });
  playBtn.append(icon("play"));
  const slider = el("input", { type: "range", min: "0", max: "0", step: "any", value: "0", "aria-label": "Time", class: "soul-time" });
  Object.assign(slider.style, { flex: "1", minWidth: "0", cursor: "pointer" });
  // A thin track and a small thumb, the same in every browser.
  const sliderStyle = el(
    "style",
    {},
    `.soul-time{-webkit-appearance:none;appearance:none;background:transparent;height:12px;margin:0}
.soul-time::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:var(--soul-track)}
.soul-time::-moz-range-track{height:3px;border-radius:2px;background:var(--soul-track)}
.soul-time::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;margin-top:-3.5px;border:none;border-radius:50%;background:var(--soul-thumb)}
.soul-time::-moz-range-thumb{width:10px;height:10px;border:none;border-radius:50%;background:var(--soul-thumb)}`,
  );
  // The date sits above the slider, in the middle of it (past the play button).
  const when = el("div", { class: "hint", style: { fontSize: "11px", whiteSpace: "nowrap", textAlign: "center", paddingLeft: "calc(1.6rem + 8px)" } });
  // Quiet until the mouse comes: no panel, a grey slider, half seen.
  const timebar = el(
    "div",
    {
      style: { position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: "32px", width: "max(60%, min(320px, calc(100% - 40px)))", display: "none", flexDirection: "column", gap: "2px", padding: "2px 6px", opacity: "0.45", transition: "opacity 0.2s" },
    },
    when,
    el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, playBtn, slider),
  );
  timebar.onmouseenter = () => (timebar.style.opacity = "0.9");
  timebar.onmouseleave = () => (timebar.style.opacity = playing ? "0.7" : "0.45");
  root.append(sliderStyle, canvas, labels, sectorBox, info, timebar, help, empty);
  body.append(
    el("p", { class: "hint", style: { marginTop: "-8px", marginBottom: "10px" } }, "Memory visualisation: the things confirmed facts are about, and the links between them."),
    toolbar,
    root,
  );

  // ---- three.js ----------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 20000);
  camera.position.set(0, 0, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.zoomSpeed = 1.1;
  controls.autoRotateSpeed = 0.35;
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  camera.add(sun);
  sun.position.set(1, 1, 2);
  scene.add(camera);
  scene.fog = new THREE.Fog(0x000000, 100, 1000);

  const sphere = new THREE.SphereGeometry(1, 16, 12);
  // Each thing has its own opacity (instanceAlpha), so it can come from nothing.
  const nodeMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true });
  nodeMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float instanceAlpha;\nvarying float vAlpha;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAlpha = instanceAlpha;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vAlpha;")
      .replace("#include <opaque_fragment>", "#include <opaque_fragment>\ngl_FragColor.a *= vAlpha;");
  };
  let nodeMesh = null;
  const baseLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1 }),
  );
  baseLines.frustumCulled = false; // its ends move as links come and go
  scene.add(baseLines);
  const glowMaterial = new LineMaterial({ vertexColors: true, linewidth: 1.6, worldUnits: false, transparent: true, opacity: 0.9 });
  let glowLines = null;

  const colours = { bg: new THREE.Color(), fg: new THREE.Color(), hl: new THREE.Color(), panel: "" };
  const tmp = new THREE.Color();
  const mix = (a, b, t) => tmp.copy(a).lerp(b, t);

  function readTheme() {
    const dark = document.documentElement.classList.contains("dark");
    const style = getComputedStyle(document.body);
    const bg = style.backgroundColor;
    const fg = style.color;
    colours.bg.set((bg && cssColour(bg)) || (dark ? "#1c1c1f" : "#fafafa"));
    colours.fg.set((fg && cssColour(fg)) || (dark ? "#e4e4e7" : "#27272a"));
    colours.hl.set(dark ? "#93c5fd" : "#3b82f6");
    colours.dark = dark;
    renderer.setClearColor(colours.bg, 1);
    scene.fog.color.copy(colours.bg);
    root.style.background = `#${colours.bg.getHexString()}`;
    slider.style.setProperty("--soul-track", `#${colours.bg.clone().lerp(colours.fg, 0.3).getHexString()}`);
    slider.style.setProperty("--soul-thumb", `#${colours.bg.clone().lerp(colours.fg, 0.7).getHexString()}`);
    const b = colours.bg;
    colours.labelBg = `rgba(${Math.round(b.r * 255)},${Math.round(b.g * 255)},${Math.round(b.b * 255)},0.62)`;
  }

  // ---- data --------------------------------------------------------------------
  async function loadProjects() {
    try {
      const projects = await prophet.api("/api/projects");
      for (const p of projects || []) projectSel.append(el("option", { value: String(p.id) }, p.name));
    } catch {
      /* without projects the list stays "all" */
    }
  }

  async function load() {
    status.textContent = "Reading memory…";
    empty.style.display = "none";
    let things;
    let facts = null;
    try {
      // All of memory: a project sees its own things and those that hold everywhere (forProject).
      // The facts only give the timeline its times; without them there is none.
      [things, facts] = await Promise.all([prophet.api("/api/entities"), prophet.api("/api/facts?status=confirmed").catch(() => null)]);
      things = forProject(Array.isArray(things) ? things : [], projectSel.value);
    } catch (err) {
      status.textContent = `Could not read memory: ${err?.message || err}`;
      return;
    }
    status.textContent = "Laying out…";
    await new Promise((r) => setTimeout(r, 20));
    graph = buildGraph(Array.isArray(things) ? things : []);
    list = sectors(graph);
    steps = timeline(graph, Array.isArray(facts?.facts) ? facts.facts : []);
    setPlaying(false);
    at = Math.max(0, steps.length - 1);
    shownEdges = -1;
    slider.max = String(at);
    timebar.style.display = steps.length > 1 ? "flex" : "none";
    const big = Math.max(0, ...list.map((s) => (s.lonely ? 0 : s.members.length)));
    pos = layout(graph, list, { spacing: SPACING, iterations: big > 1500 ? 90 : big > 600 ? 160 : 260 });
    selected = -1;
    hovered = -1;
    found = [];
    currentSector = -1;
    labelWidths.clear();
    buildScene();
    drawSectors();
    drawInfo();
    status.textContent = `${graph.nodes.length} things · ${graph.edges.length} links · ${list.length} sectors`;
    if (!graph.nodes.length) {
      empty.textContent = "No things in memory yet. Links appear when links are switched on on the Memory page and there are confirmed facts.";
      empty.style.display = "flex";
    }
    flyOverview(true);
    start();
  }

  function radius(n) {
    return 1.8 + Math.log2(1 + n.degree) * 0.9 + Math.min(n.facts, 40) * 0.02;
  }

  function buildScene() {
    if (nodeMesh) {
      scene.remove(nodeMesh);
      nodeMesh.dispose();
    }
    const count = graph.nodes.length;
    nodeMesh = new THREE.InstancedMesh(sphere, nodeMaterial, Math.max(count, 1));
    sphere.setAttribute("instanceAlpha", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(count, 1)).fill(1), 1));
    nodeMesh.count = count;
    for (const n of graph.nodes) nodeMesh.setColorAt(n.index, colours.fg);
    scene.add(nodeMesh);
    resetAppear();
    placeNodes();
    const p = new Float32Array(graph.edges.length * 6);
    baseLines.geometry.dispose();
    baseLines.geometry = new THREE.BufferGeometry();
    baseLines.geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
    baseLines.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(graph.edges.length * 8), 4));
    placeEdges();
    drawWhen();
    let far = SPACING * 10;
    for (const s of list) far = Math.max(far, Math.hypot(...s.centre) + s.radius);
    scene.fog.near = far * 0.6;
    scene.fog.far = far * 3.2;
    camera.far = far * 8;
    camera.updateProjectionMatrix();
    resetGlow();
    paint();
  }

  // ---- the timeline ----------------------------------------------------------------
  const last_ = () => Math.max(0, steps.length - 1);
  const timeOn = () => steps.length > 1 && at < last_();
  const step = () => Math.floor(at + 1e-9);
  const isShown = (i) => !timeOn() || !(graph.nodes[i].step > step());
  // Highlights walk only the links there now.
  const atStep = () => (timeOn() ? step() : Infinity);

  const edgeThere = (e) => !(e.step > atStep());

  // Coming and going is soft, however fast the timeline runs. A thing that comes
  // grows out of nothing while it fades in (FADE_IN seconds); a link fades in the
  // same way; one that goes fades out. Once a thing or a link has faded in, it
  // flashes: lights up bright at once and dies out within FLASH seconds; a link
  // that has faded in lights up the things at both its ends too. Each has `alpha` (how far it
  // is there, 0 … 1) and `flash` (seconds into its flash; FLASH when done).
  // Seconds on screen, not memory's own time.
  const FADE_IN = 1.5;
  const FLASH = 1;
  const FLASH_RISE = 0.08;
  const FADE_OUT = 0.4;
  const ease = (k) => k * k * (3 - 2 * k);
  const grow = (k) => 1 - (1 - k) ** 3;
  const pulse = (f) => (f >= FLASH ? 0 : f < FLASH_RISE ? f / FLASH_RISE : (1 - (f - FLASH_RISE) / (FLASH - FLASH_RISE)) ** 2);
  let nodeA = new Float64Array(0);
  let nodeF = new Float64Array(0);
  let edgeA = new Float64Array(0);
  let edgeF = new Float64Array(0);
  let settling = false;

  function resetAppear() {
    nodeA = new Float64Array(graph.nodes.length);
    edgeA = new Float64Array(graph.edges.length);
    nodeF = new Float64Array(graph.nodes.length).fill(FLASH);
    edgeF = new Float64Array(graph.edges.length).fill(FLASH);
    graph.nodes.forEach((n, i) => (nodeA[i] = isShown(i) ? 1 : 0));
    graph.edges.forEach((e, k) => (edgeA[k] = edgeThere(e) ? 1 : 0));
    shownEdges = edgeA.reduce((a, b) => a + b, 0);
    settling = false;
  }

  function stepAppear(dt) {
    if (!settling) return;
    let moving = false;
    let shapes = false;
    // Returns true when it has just finished fading in.
    const step_ = (A, F, i, on) => {
      const a = A[i];
      if (on) {
        if (a >= 1 && F[i] >= FLASH) return false;
        moving = true;
        if (a < 1) {
          if (a === 0) shapes = true;
          A[i] = Math.min(1, a + dt / FADE_IN);
          if (A[i] < 1) return false;
          F[i] = 0; // faded in: now it flashes
          return true;
        }
        F[i] = Math.min(FLASH, F[i] + dt);
        return false;
      } else {
        if (a === 0) return false;
        A[i] = Math.max(0, a - dt / FADE_OUT);
        F[i] = FLASH;
        if (A[i] === 0) shapes = true;
        moving = true;
        return false;
      }
    };
    for (let i = 0; i < nodeA.length; i++) step_(nodeA, nodeF, i, isShown(i));
    graph.edges.forEach((e, k) => {
      if (!step_(edgeA, edgeF, k, edgeThere(e))) return;
      for (const end of [e.a, e.b]) if (nodeA[end] >= 1) nodeF[end] = 0;
    });
    if (moving || shapes) {
      placeNodes();
      if (shapes) placeEdges();
      recolour();
    }
    settling = moving;
  }

  // A thing grows from nothing as it fades in; while it flashes it swells a little.
  const matrix = new THREE.Matrix4();
  function placeNodes() {
    if (!nodeMesh) return;
    const alpha = nodeMesh.geometry.getAttribute("instanceAlpha");
    for (const n of graph.nodes) {
      const a = nodeA[n.index] ?? 1;
      const f = pulse(nodeF[n.index] ?? FLASH);
      const r = radius(n) * grow(a) * (1 + 0.35 * f);
      matrix.makeScale(r, r, r).setPosition(pos[n.index * 3], pos[n.index * 3 + 1], pos[n.index * 3 + 2]);
      nodeMesh.setMatrixAt(n.index, matrix);
      alpha?.setX(n.index, ease(a));
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (alpha) alpha.needsUpdate = true;
  }

  // A link fully gone: both ends at one point, so it draws nothing.
  function placeEdges() {
    const attr = baseLines.geometry.getAttribute("position");
    if (!attr) return;
    const p = attr.array;
    graph.edges.forEach((e, k) => {
      const b = (edgeA[k] ?? 1) === 0 ? e.a : e.b;
      p.set([pos[e.a * 3], pos[e.a * 3 + 1], pos[e.a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]], k * 6);
    });
    attr.needsUpdate = true;
  }

  // A little flash on top of the colour a thing or link has anyway.
  const flashColour = new THREE.Color();
  function flashed(c, f, strength) {
    const p = pulse(f);
    if (p > 0) c.lerp(flashColour, p * strength);
    return c;
  }

  function drawWhen() {
    if (steps.length < 2) return;
    const span = steps[steps.length - 1] - steps[0];
    const fmt = { day: "numeric", month: "short", year: "numeric" };
    if (span < 3 * 86400000) Object.assign(fmt, { hour: "2-digit", minute: "2-digit" });
    const s = step();
    let things = 0;
    for (const n of graph.nodes) if (!(n.step > s)) things++;
    when.textContent = `${new Date(steps[s]).toLocaleString(undefined, fmt)} · ${things} of ${graph.nodes.length}`;
    if (!slider.matches(":active")) slider.value = String(at);
  }

  function setAt(v) {
    at = Math.max(0, Math.min(last_(), v));
    let count = 0;
    for (const e of graph.edges) if (edgeThere(e)) count++;
    if (count !== shownEdges) {
      shownEdges = count;
      // The links there changed: the highlight walks again, without blinking.
      if (lit.focus >= 0) {
        light(lit.focus);
        recolour();
      }
    }
    settling = true;
    drawWhen();
    labelsDirty = true;
    start();
  }

  function setPlaying(on) {
    playing = on && steps.length > 1;
    playBtn.replaceChildren(icon(playing ? "pause" : "play"));
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    playBtn.title = playing ? "Pause (Space)" : "Play (Space)";
    if (!timebar.matches(":hover")) timebar.style.opacity = playing ? "0.7" : "0.45";
  }

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    setPlaying(true);
    if (at >= last_()) setAt(0);
    start();
  }

  function stepPlay(dt) {
    if (!playing) return;
    // The whole memory in 8 to 40 seconds, whatever its size.
    const seconds = Math.max(8, Math.min(40, steps.length * 0.08));
    const next = at + (dt * last_()) / seconds;
    if (next >= last_()) {
      setPlaying(false);
      setAt(last_());
    } else setAt(next);
  }

  // ---- the highlight -------------------------------------------------------------
  // The thing under the mouse wins over the chosen one; nothing chosen and nothing
  // under the mouse is the calm graph. The highlight is soft: it fades in and out,
  // tints rather than recolours, and the rest of the graph dims only a little.
  const SOFT = 0.55; // how far the brightest link moves from calm towards the accent
  const FADE_MS = 380;
  let lit = { dist: new Map(), edges: new Map(), focus: -1 };
  let glow = 0; // 0 calm … 1 fully lit
  let glowTarget = 0;
  let glowLast = 0;

  function paint() {
    if (!nodeMesh) return;
    const focus = hovered >= 0 ? hovered : selected;
    if (focus >= 0 && focus !== lit.focus) {
      light(focus);
      glow = Math.min(glow, 0.35); // a new thing: fade in again from soft
    }
    glowTarget = focus >= 0 ? 1 : 0;
    recolour();
    start();
  }

  // What the highlight from a thing reaches, over the links there now.
  function light(focus) {
    const levels = opts.fade_levels;
    const dist = distances(graph, focus, levels, atStep());
    lit = { dist, edges: edgeBrightness(graph, dist, levels, atStep()), focus };
    buildGlow();
  }

  function resetGlow() {
    lit = { dist: new Map(), edges: new Map(), focus: -1 };
    glow = 0;
    glowTarget = 0;
    buildGlow();
  }

  function buildGlow() {
    if (glowLines) {
      scene.remove(glowLines);
      glowLines.geometry.dispose();
      glowLines = null;
    }
    if (!lit.edges.size) return;
    const p = [];
    for (const k of lit.edges.keys()) {
      const e = graph.edges[k];
      p.push(pos[e.a * 3], pos[e.a * 3 + 1], pos[e.a * 3 + 2], pos[e.b * 3], pos[e.b * 3 + 1], pos[e.b * 3 + 2]);
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(p);
    glowLines = new LineSegments2(g, glowMaterial);
    glowLines.renderOrder = 1;
    scene.add(glowLines);
  }

  const WHITE = new THREE.Color(1, 1, 1);
  const calmNode = new THREE.Color();
  const calmEdge = new THREE.Color();
  function recolour() {
    if (!nodeMesh) return;
    const k = glow * glow * (3 - 2 * glow); // smoothstep
    calmNode.copy(mix(colours.bg, colours.fg, colours.dark ? 0.62 : 0.55));
    flashColour.copy(colours.hl).lerp(colours.dark ? WHITE : colours.hl, 0.6);
    for (const n of graph.nodes) {
      const steps = lit.dist.get(n.index);
      const base = list[n.sector]?.lonely ? mix(colours.bg, calmNode, 0.7).clone() : calmNode.clone();
      let c;
      if (steps !== undefined) c = base.lerp(colours.hl, Math.max(0.3, nodeBrightness(steps)) * 0.8 * k);
      else if (found.includes(n.index)) c = base.lerp(colours.hl, 0.5);
      else c = base.lerp(colours.bg, 0.3 * k);
      nodeMesh.setColorAt(n.index, flashed(c, nodeF[n.index] ?? FLASH, 1));
    }
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;

    const colour = baseLines.geometry.getAttribute("color");
    calmEdge.copy(mix(colours.bg, colours.fg, 0.2 - 0.07 * k));
    if (colour) {
      for (let k = 0; k < graph.edges.length; k++) {
        const f = edgeF[k] ?? FLASH;
        const c = f >= FLASH ? calmEdge : flashed(tmp.copy(calmEdge), f, 0.6);
        const a = ease(edgeA[k] ?? 1);
        colour.setXYZW(k * 2, c.r, c.g, c.b, a);
        colour.setXYZW(k * 2 + 1, c.r, c.g, c.b, a);
      }
      colour.needsUpdate = true;
    }
    if (glowLines) {
      const c = [];
      for (const b of lit.edges.values()) {
        const col = calmEdge.clone().lerp(colours.hl, b * SOFT * k);
        c.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
      glowLines.geometry.setColors(c);
      glowLines.visible = k > 0.01;
    }
    labelsDirty = true;
  }

  function stepGlow(now) {
    const dt = glowLast ? now - glowLast : 16;
    glowLast = now;
    if (glow === glowTarget) return;
    const step = dt / FADE_MS;
    glow = glowTarget > glow ? Math.min(glowTarget, glow + step) : Math.max(glowTarget, glow - step);
    if (glow === 0 && glowTarget === 0) {
      lit = { dist: new Map(), edges: new Map(), focus: -1 };
      buildGlow();
    }
    recolour();
  }

  function setHover(i) {
    if (i === hovered) return;
    hovered = i;
    canvas.style.cursor = i >= 0 ? "pointer" : "grab";
    paint();
  }

  function select(i, fly = false) {
    selected = i;
    if (i >= 0) currentSector = graph.nodes[i].sector;
    paint();
    drawInfo();
    drawSectors();
    if (fly && i >= 0) flyToNode(i);
  }

  // ---- panels ----------------------------------------------------------------------
  function drawSectors() {
    sectorBox.replaceChildren(el("div", { class: "section-title", style: { fontSize: "12px", padding: "2px 6px 6px" } }, "Sectors"));
    if (!list.length) {
      sectorBox.style.display = "none";
      return;
    }
    sectorBox.style.display = "";
    list.forEach((s, i) => {
      const b = el(
        "button",
        { type: "button", class: `btn btn-sm ${i === currentSector ? "" : "btn-ghost"}`, title: s.name },
        el("span", { style: { opacity: "0.6", width: "1.4em", display: "inline-block" } }, i < 9 ? String(i + 1) : "·"),
        el("span", { style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" } }, s.name),
        el("span", { style: { opacity: "0.6" } }, String(s.members.length)),
      );
      Object.assign(b.style, { display: "flex", width: "100%", gap: "6px", justifyContent: "flex-start", marginBottom: "2px" });
      b.onclick = () => flyToSector(i);
      sectorBox.append(b);
    });
  }

  function drawInfo() {
    if (selected < 0) {
      info.style.display = "none";
      return;
    }
    const n = graph.nodes[selected];
    info.style.display = "";
    const close = el("button", { type: "button", class: "btn btn-ghost btn-sm", title: "Clear selection", style: { float: "right" } }, "×");
    close.onclick = () => select(-1);
    info.replaceChildren(close, el("div", { class: "section-title" }, n.name));
    const meta = [n.owner ? "you" : "", n.label, n.project, `facts: ${n.facts}`, `links: ${n.degree}`].filter(Boolean).join(" · ");
    info.append(el("p", { class: "hint", style: { marginTop: "2px" } }, meta));
    if (n.aliases.length) info.append(el("p", { class: "hint", style: { marginTop: "4px" } }, `Other names: ${n.aliases.join(", ")}`));
    if (n.links.length) {
      const ul = el("ul", { style: { marginTop: "8px", display: "grid", gap: "4px" } });
      const sorted = [...n.links].sort((x, y) => graph.nodes[y.other].degree - graph.nodes[x.other].degree);
      for (const { edge, other } of sorted.slice(0, 80)) {
        const e = graph.edges[edge];
        const o = graph.nodes[other];
        // One line per direction: "→ works at" (this thing does it), "← owns" (the other one does).
        const out = e.links.filter((l) => l.from === selected).map((l) => l.relation);
        const back = e.links.filter((l) => l.from !== selected).map((l) => l.relation);
        for (const [arrow, relations] of [["→", out], ["←", back]]) {
          if (!relations.length) continue;
          const go = el("button", { type: "button", class: "btn btn-ghost btn-sm", style: { padding: "0 4px" } }, o.name);
          go.onclick = () => select(other, true);
          go.onmouseenter = () => setHover(other);
          go.onmouseleave = () => setHover(-1);
          ul.append(el("li", {}, el("span", { class: "hint" }, `${arrow} ${relations.join("; ")} `), go));
        }
      }
      if (sorted.length > 80) ul.append(el("li", { class: "hint" }, `and ${sorted.length - 80} more`));
      info.append(ul);
    }
    const fly = el("button", { type: "button", class: "btn btn-sm", style: { marginTop: "10px" } }, "Fly to it");
    fly.onclick = () => flyToNode(selected);
    info.append(fly);
  }

  function drawResults() {
    const q = search_.value;
    const hits = search(graph, q, 10);
    found = q.trim() ? search(graph, q, 40).map((n) => n.index) : [];
    paint();
    results.replaceChildren();
    if (!q.trim()) {
      results.style.display = "none";
      return;
    }
    results.style.display = "";
    if (!hits.length) {
      results.append(el("div", { class: "hint", style: { padding: "6px 8px" } }, "Nothing found"));
      return;
    }
    for (const n of hits) {
      const b = el(
        "button",
        { type: "button", class: "btn btn-ghost btn-sm" },
        el("span", { style: { flex: "1", textAlign: "left" } }, n.name),
        el("span", { class: "hint" }, n.label || ""),
      );
      Object.assign(b.style, { display: "flex", width: "100%", gap: "8px" });
      b.onmousedown = (ev) => ev.preventDefault();
      b.onclick = () => pick(n.index);
      b.onmouseenter = () => setHover(n.index);
      b.onmouseleave = () => setHover(-1);
      results.append(b);
    }
  }

  function pick(i) {
    results.style.display = "none";
    setHover(-1);
    select(i, true);
    root.focus({ preventScroll: true });
  }

  // ---- flight ----------------------------------------------------------------------
  let fly = null;
  function flyTo(target, distance, instant = false) {
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const to = new THREE.Vector3(...target);
    const cam = to.clone().add(dir.multiplyScalar(distance));
    if (instant) {
      controls.target.copy(to);
      camera.position.copy(cam);
      fly = null;
      return;
    }
    fly = { t0: performance.now(), from: [camera.position.clone(), controls.target.clone()], to: [cam, to] };
    start();
  }
  function stepFly(now) {
    if (!fly) return;
    const k = Math.min(1, (now - fly.t0) / 750);
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    camera.position.lerpVectors(fly.from[0], fly.to[0], e);
    controls.target.lerpVectors(fly.from[1], fly.to[1], e);
    if (k >= 1) fly = null;
  }
  function flyToNode(i) {
    currentSector = graph.nodes[i].sector;
    drawSectors();
    // Close enough to read it, far enough to see its neighbours.
    let reach = SPACING * 2;
    for (const { other } of graph.nodes[i].links) {
      reach = Math.max(reach, Math.hypot(pos[other * 3] - pos[i * 3], pos[other * 3 + 1] - pos[i * 3 + 1], pos[other * 3 + 2] - pos[i * 3 + 2]));
    }
    flyTo([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], Math.min(reach, SPACING * 12) * 1.9);
  }
  function flyToSector(i) {
    const s = list[i];
    if (!s) return;
    currentSector = i;
    drawSectors();
    flyTo(s.centre, Math.max(SPACING * 3, s.radius * 2.4));
  }
  function flyOverview(instant = false) {
    currentSector = -1;
    drawSectors();
    let r = SPACING * 3;
    for (const s of list) r = Math.max(r, Math.hypot(...s.centre) + s.radius);
    flyTo([0, 0, 0], r * 2.1, instant);
  }

  // ---- free movement -------------------------------------------------------------------
  const keys = new Set();
  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  function onKeyDown(ev) {
    if (!running || typing(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (MOVE_KEYS.includes(ev.code)) {
      keys.add(ev.code);
      ev.preventDefault();
    } else if (/^Digit[1-9]$/.test(ev.code)) {
      flyToSector(Number(ev.code.slice(5)) - 1);
    } else if (ev.code === "Digit0") {
      flyOverview();
    } else if (ev.code === "Space") {
      if (ev.target?.tagName === "BUTTON" || ev.target === slider) return;
      ev.preventDefault();
      togglePlay();
    } else if (ev.code === "KeyF") {
      if (selected >= 0) flyToNode(selected);
    } else if (k === "escape") {
      search_.value = "";
      drawResults();
      select(-1);
    } else if (k === "/") {
      ev.preventDefault();
      search_.focus();
    }
  }
  const onKeyUp = (ev) => keys.delete(ev.code);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => keys.clear());

  const fwd = new THREE.Vector3();
  const side = new THREE.Vector3();
  const move = new THREE.Vector3();
  function stepKeys(dt) {
    if (!keys.size) return;
    const has = (...k) => k.some((x) => keys.has(x));
    camera.getWorldDirection(fwd);
    side.crossVectors(fwd, camera.up).normalize();
    move.set(0, 0, 0);
    if (has("KeyW", "ArrowUp")) move.add(fwd);
    if (has("KeyS", "ArrowDown")) move.sub(fwd);
    if (has("KeyD", "ArrowRight")) move.add(side);
    if (has("KeyA", "ArrowLeft")) move.sub(side);
    if (has("KeyE")) move.add(camera.up);
    if (has("KeyQ")) move.sub(camera.up);
    if (!move.lengthSq()) return;
    const dist = camera.position.distanceTo(controls.target);
    const speed = Math.max(SPACING * 2, dist * 0.9) * opts.speed;
    move.normalize().multiplyScalar(speed * dt);
    fly = null;
    camera.position.add(move);
    controls.target.add(move);
  }

  // ---- labels and picking ---------------------------------------------------------------
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = FONT;
  const labelWidths = new Map();
  const textOf = (n) => n.name;
  const widthOf = (n) => {
    if (!labelWidths.has(n.index)) labelWidths.set(n.index, Math.ceil(measure.measureText(textOf(n)).width) + 10);
    return labelWidths.get(n.index);
  };
  const pool = new Map(); // node index → its label
  let underMouse = null; // {node, x, y}: the label the mouse is on
  let labelsDirty = true;
  let lastCam = "";
  let moving = false;
  let sx = new Float32Array(0);
  let sy = new Float32Array(0);
  let sr = new Float32Array(0);
  let sd = new Float32Array(0);
  const v = new THREE.Vector3();

  function project(w, h) {
    const count = graph.nodes.length;
    if (sx.length !== count) {
      sx = new Float32Array(count);
      sy = new Float32Array(count);
      sr = new Float32Array(count);
      sd = new Float32Array(count);
    }
    const f = h / 2 / Math.tan((camera.fov * Math.PI) / 360);
    camera.updateMatrixWorld();
    const inv = camera.matrixWorldInverse;
    for (let i = 0; i < count; i++) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(inv);
      const d = -v.z;
      sd[i] = d;
      if (d <= camera.near || !isShown(i)) {
        sr[i] = -1;
        continue;
      }
      sx[i] = w / 2 + (v.x / d) * f;
      sy[i] = h / 2 - (v.y / d) * f;
      sr[i] = (radius(graph.nodes[i]) / d) * f;
    }
  }

  function drawLabels(w, h) {
    const count = graph.nodes.length;
    // Nearer than the point the camera looks at: labelled first; behind it: fading.
    const look = Math.max(SPACING * 2, camera.position.distanceTo(controls.target));
    const cand = [];
    const pts = [];
    for (let i = 0; i < count; i++) {
      if (sr[i] < 0 || sx[i] < -50 || sx[i] > w + 50 || sy[i] < -20 || sy[i] > h + 20) continue;
      const steps = lit.dist.get(i);
      const isLit = steps !== undefined;
      const isFound = found.includes(i);
      // Far things fade and lose their labels first; lit and found ones keep them.
      const nearness = Math.max(0, Math.min(1, 1.6 - sd[i] / look));
      if (!isLit && !isFound && nearness <= 0.05) continue;
      const n = graph.nodes[i];
      let score = nearness * 4 + Math.log2(1 + n.degree) * 0.6 + sr[i] * 0.08;
      if (isFound) score += 50;
      if (isLit) score += 100 - steps * 10;
      if (i === selected) score += 200;
      if (i === hovered) score += 300;
      // A label already shown keeps its place before a new one takes it.
      const had = pool.get(i);
      if (had) score += 2.5;
      cand.push({ node: i, x: sx[i], y: sy[i], r: Math.max(sr[i], 2), w: widthOf(n), h: 18, score, isLit, nearness, prefer: had?._slot ?? -1 });
      if (isLit || i === selected) pts.push({ node: i, x: sx[i], y: sy[i], r: Math.max(sr[i], 3) });
    }
    if (underMouse) {
      const c = cand.find((x) => x.node === underMouse.node);
      if (c && !moving) {
        c.fixed = { x: underMouse.x, y: underMouse.y };
        c.score = Infinity;
      } else underMouse = null;
    }
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand.slice(0, opts.labels)) if (!c.isLit) pts.push({ node: c.node, x: c.x, y: c.y, r: Math.max(c.r, 2) });
    const most = Math.max(opts.labels, Math.min(lit.dist.size, 60));
    const box = root.getBoundingClientRect();
    const blocked = [sectorBox, info, timebar, help, toolbar]
      .filter((b) => b.style.display !== "none" && root.contains(b))
      .map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      });
    const placed = placeLabels(cand, { width: w, height: h, most, points: pts, blocked });
    const byNode = new Map(cand.map((c) => [c.node, c]));
    const shown = new Set(placed.map((p) => p.node));
    for (const [node, d] of pool) {
      if (!shown.has(node)) {
        d.remove();
        pool.delete(node);
      }
    }
    const gk = glow * glow * (3 - 2 * glow);
    const fg = `#${colours.fg.getHexString()}`;
    const soft = `#${colours.fg.clone().lerp(colours.hl, 0.75 * gk).getHexString()}`;
    const hl = `#${colours.hl.getHexString()}`;
    for (const p of placed) {
      const c = byNode.get(p.node);
      const n = graph.nodes[p.node];
      let d = pool.get(p.node);
      if (!d) {
        d = el("div", {
          style: { position: "absolute", left: "0", top: "0", font: FONT, lineHeight: "18px", height: "18px", padding: "0 5px", borderRadius: "5px", whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer", userSelect: "none" },
        });
        d.textContent = textOf(n);
        const node = p.node;
        d.onmouseenter = () => {
          underMouse = { node, x: d._x, y: d._y };
          setHover(node);
        };
        d.onmouseleave = () => {
          underMouse = null;
          setHover(-1);
        };
        d.onclick = () => select(node);
        d.ondblclick = () => select(node, true);
        labels.append(d);
        pool.set(p.node, d);
      }
      d._x = p.x;
      d._slot = p.slot;
      d._y = p.y;
      d.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      const strong = p.node === hovered || p.node === selected;
      // A name comes like its thing: fades in, then flashes and settles.
      const fl = pulse(nodeF[p.node] ?? FLASH);
      const colour = c.isLit ? soft : found.includes(p.node) ? hl : fg;
      d.style.color = fl > 0 ? `#${new THREE.Color(colour).lerp(flashColour, fl * 0.5).getHexString()}` : colour;
      d.style.textShadow = fl > 0 ? `0 0 ${(6 * fl).toFixed(1)}px #${flashColour.getHexString()}` : "";
      d.style.fontWeight = strong ? "600" : "400";
      d.style.background = strong ? colours.labelBg : "transparent";
      const calm = 0.35 + c.nearness * 0.6;
      const lit_ = c.isLit ? Math.max(0.5, nodeBrightness(lit.dist.get(p.node))) : 0;
      const there = ease(nodeA[p.node] ?? 1);
      d.style.opacity = String(Math.min(1, there * (c.isLit ? calm + (lit_ - calm) * gk : found.includes(p.node) ? 1 : calm * (1 - 0.35 * gk)) + fl * 0.25));
    }
  }

  let mouse = null;
  let down = null;
  canvas.addEventListener("pointermove", (ev) => {
    const r = canvas.getBoundingClientRect();
    mouse = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (!down) hoverAt(mouse.x, mouse.y);
  });
  canvas.addEventListener("pointerleave", () => {
    mouse = null;
    setHover(-1);
  });
  canvas.addEventListener("pointerdown", (ev) => {
    down = { x: ev.clientX, y: ev.clientY };
    canvas.style.cursor = "grabbing";
    root.focus({ preventScroll: true });
  });
  canvas.addEventListener("pointerup", (ev) => {
    const click = down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5;
    down = null;
    canvas.style.cursor = hovered >= 0 ? "pointer" : "grab";
    if (click) select(hovered);
  });
  canvas.addEventListener("dblclick", () => {
    if (hovered >= 0) select(hovered, true);
  });
  function hoverAt(x, y) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < graph.nodes.length; i++) {
      if (sr[i] < 0) continue;
      const d = Math.hypot(sx[i] - x, sy[i] - y);
      if (d <= Math.max(sr[i] + 3, 8) && sd[i] < bestD) {
        best = i;
        bestD = sd[i];
      }
    }
    setHover(best);
  }

  // ---- the loop ------------------------------------------------------------------------
  let w = 0;
  let h = 0;
  const size = () => {
    const nw = root.clientWidth;
    const nh = root.clientHeight;
    if (!nw || !nh || (nw === w && nh === h)) return;
    w = nw;
    h = nh;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    glowMaterial.resolution.set(w, h);
    labelsDirty = true;
  };
  new ResizeObserver(() => {
    size();
    start();
  }).observe(root);

  const visible = () => root.isConnected && (root.offsetParent !== null || document.fullscreenElement === root);
  let last = 0;
  function frame(now) {
    if (!visible()) {
      running = false;
      keys.clear();
      return;
    }
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    size();
    stepFly(now);
    stepGlow(now);
    stepKeys(dt);
    stepPlay(dt);
    stepAppear(dt);
    controls.autoRotate = opts.spin && !fly && !keys.size && hovered < 0;
    controls.update();
    renderer.render(scene, camera);
    const cam = `${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)},${camera.position.z.toFixed(2)},${controls.target.x.toFixed(2)},${w},${h}`;
    moving = cam !== lastCam;
    if (moving || labelsDirty) {
      lastCam = cam;
      labelsDirty = false;
      project(w, h);
      drawLabels(w, h);
    }
  }
  function start() {
    if (running || !visible()) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }

  // ---- wiring ------------------------------------------------------------------------
  search_.addEventListener("input", drawResults);
  search_.addEventListener("focus", () => search_.value && drawResults());
  search_.addEventListener("blur", () => setTimeout(() => (results.style.display = "none"), 150));
  search_.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      const first = search(graph, search_.value, 1)[0];
      if (first) pick(first.index);
    } else if (ev.key === "Escape") {
      search_.value = "";
      drawResults();
      search_.blur();
    }
  });
  playBtn.onclick = togglePlay;
  slider.addEventListener("input", () => {
    if (playing) setPlaying(false);
    setAt(Number(slider.value));
  });
  slider.addEventListener("keydown", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      togglePlay();
    }
  });
  projectSel.addEventListener("change", load);
  reload.onclick = load;
  overview.onclick = () => flyOverview();
  full.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen?.().catch(() => {});
  };
  document.addEventListener("fullscreenchange", () => {
    full.textContent = document.fullscreenElement === root ? "Exit full screen" : "Full screen";
    if (document.fullscreenElement === root) root.prepend(toolbar);
    else if (toolbar.parentElement === root) root.before(toolbar);
    Object.assign(toolbar.style, document.fullscreenElement === root
      ? { position: "absolute", zIndex: 6, left: "50%", transform: "translateX(-50%)", top: "10px", marginBottom: "0" }
      : { position: "", zIndex: "", left: "", transform: "", top: "", marginBottom: "10px" });
    sectorBox.style.top = info.style.top = document.fullscreenElement === root ? "56px" : "10px";
    start();
  });

  readTheme();
  loadProjects();
  load();

  return {
    shown(on) {
      if (on) start();
    },
    theme() {
      readTheme();
      paint();
      start();
    },
    settings(s) {
      opts = { ...DEFAULTS, ...s };
      lit.focus = -1;
      paint();
    },
  };
}

// Any CSS colour (Omniscient's are oklch) as rgb(), read back from one pixel.
const pixel = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d", { willReadFrequently: true }) : null;
function cssColour(value) {
  if (!pixel) return value;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = "#000";
  pixel.fillStyle = value;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return a === 0 ? null : `rgb(${r}, ${g}, ${b})`;
}
