// What Soul computes without a browser: the graph from /api/entities, its
// sectors, a 3D layout, the brightness of a highlight and where labels fit.
// No DOM and no three.js here, so `node --test` checks all of it.

const SEP = " — ";

// /api/entities gives things, each with the texts of its links. A link is in
// the lists of both its ends, so a link is the pair of things whose lists hold
// the same (fact, text).
export function buildGraph(things) {
  const nodes = things.map((t, i) => ({
    index: i,
    id: t.id,
    name: String(t.name ?? ""),
    label: t.label ? String(t.label) : "",
    aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : [],
    facts: Number(t.facts) || 0,
    project: t.project || null,
    owner: t.owner === true,
    links: [],
    degree: 0,
  }));
  const ends = new Map();
  things.forEach((t, i) => {
    for (const lk of t.links || []) {
      const key = `${lk.fact_id}|${lk.text}`;
      if (!ends.has(key)) ends.set(key, { text: String(lk.text), fact: lk.fact_id, at: new Set() });
      ends.get(key).at.add(i);
    }
  });
  const edges = [];
  const seen = new Map();
  for (const { text, fact, at } of ends.values()) {
    const [a, b] = [...at];
    if (b === undefined || at.size !== 2) continue;
    const parts = text.split(SEP);
    const relation = parts.length >= 3 ? parts.slice(1, -1).join(SEP) : text;
    // The text starts with the subject's name: that end is "from".
    const fromFirst = text.toLowerCase().startsWith(`${nodes[a].name.toLowerCase()}${SEP}`);
    const [from, to] = fromFirst ? [a, b] : [b, a];
    const pair = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (!seen.has(pair)) {
      seen.set(pair, edges.length);
      edges.push({ index: edges.length, a: from, b: to, relations: [], links: [], facts: [] });
    }
    // Each link keeps its own direction; the same relation from several facts is one link.
    const edge = edges[seen.get(pair)];
    edge.facts.push(fact);
    const same = edge.links.find((l) => l.from === from && l.relation.toLowerCase() === relation.toLowerCase());
    if (same) same.facts.push(fact);
    else edge.links.push({ from, to, relation, facts: [fact] });
    if (!edge.relations.some((r) => r.toLowerCase() === relation.toLowerCase())) edge.relations.push(relation);
  }
  for (const e of edges) {
    nodes[e.a].links.push({ edge: e.index, other: e.b });
    nodes[e.b].links.push({ edge: e.index, other: e.a });
  }
  for (const n of nodes) n.degree = n.links.length;
  return { nodes, edges };
}

// The things one project sees: its own and those that hold everywhere. Soul reads
// all of memory and picks here, so the links between a project's things and the
// things everywhere stay (/api/entities?project_id= gives only the project's own).
export function forProject(things, projectId) {
  if (projectId === null || projectId === undefined || projectId === "") return things;
  const id = Number(projectId);
  return things.filter((t) => t.project_id === null || t.project_id === undefined || Number(t.project_id) === id);
}

// Sectors: groups of things tied more to each other than to the rest (label
// propagation, deterministic). Things with no links make one sector of their own.
export function sectors(graph) {
  const { nodes } = graph;
  const group = nodes.map((n) => n.index);
  const order = [...nodes].sort((x, y) => y.degree - x.degree || x.index - y.index);
  for (let round = 0; round < 30; round++) {
    let changed = false;
    for (const n of order) {
      if (!n.links.length) continue;
      const votes = new Map();
      for (const { other } of n.links) votes.set(group[other], (votes.get(group[other]) || 0) + 1);
      let best = group[n.index];
      let most = votes.get(best) || 0;
      for (const [g, v] of votes) if (v > most || (v === most && g < best)) [best, most] = [g, v];
      if (best !== group[n.index]) {
        group[n.index] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byGroup = new Map();
  const lonely = [];
  for (const n of nodes) {
    if (!n.links.length) {
      lonely.push(n.index);
      continue;
    }
    if (!byGroup.has(group[n.index])) byGroup.set(group[n.index], []);
    byGroup.get(group[n.index]).push(n.index);
  }
  const list = [...byGroup.values()]
    .sort((x, y) => y.length - x.length)
    .map((members) => {
      const hub = members.reduce((h, i) => (nodes[i].degree > nodes[h].degree ? i : h), members[0]);
      return { name: nodes[hub].name, hub, members, lonely: false };
    });
  if (lonely.length) list.push({ name: "No links", hub: lonely[0], members: lonely, lonely: true });
  list.forEach((s, i) => {
    s.index = i;
    for (const m of s.members) nodes[m].sector = i;
  });
  return list;
}

function random(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// Points spread evenly over a sphere (Fibonacci).
export function spherePoints(count, radius) {
  if (count === 1) return [[0, 0, 0]];
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.cos(golden * i) * r * radius, y * radius, Math.sin(golden * i) * r * radius]);
  }
  return out;
}

// A 3D layout: each sector its own region, inside it a force layout
// (repulsion keeps things and their labels apart, links pull together).
export function layout(graph, list, { spacing = 14, iterations = 260 } = {}) {
  const { nodes, edges } = graph;
  const rnd = random(nodes.length * 7919 + edges.length);
  const sizes = list.map((s) => spacing * (1.2 + Math.cbrt(s.members.length) * 1.6));
  const biggest = Math.max(spacing, ...sizes);
  const centres = spherePoints(list.length, list.length > 1 ? biggest * (1.4 + Math.sqrt(list.length) * 0.55) : 0);
  const pos = new Float64Array(nodes.length * 3);
  for (const s of list) {
    const c = centres[s.index];
    const r = sizes[s.index];
    if (s.lonely) {
      // Things with no links: a calm shell, nothing pulls them.
      spherePoints(s.members.length, r * 0.9).forEach((p, k) => {
        const i = s.members[k];
        pos.set([c[0] + p[0], c[1] + p[1], c[2] + p[2]], i * 3);
      });
      continue;
    }
    for (const i of s.members) {
      pos.set([c[0] + (rnd() - 0.5) * r, c[1] + (rnd() - 0.5) * r, c[2] + (rnd() - 0.5) * r], i * 3);
    }
  }
  const force = new Float64Array(nodes.length * 3);
  const tied = list.filter((s) => !s.lonely);
  for (let it = 0; it < iterations; it++) {
    const heat = 1 - it / iterations;
    force.fill(0);
    for (const s of tied) {
      const m = s.members;
      for (let x = 0; x < m.length; x++) {
        const i = m[x] * 3;
        for (let y = x + 1; y < m.length; y++) {
          const j = m[y] * 3;
          let dx = pos[i] - pos[j];
          let dy = pos[i + 1] - pos[j + 1];
          let dz = pos[i + 2] - pos[j + 2];
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 0.01) {
            dx = rnd() - 0.5;
            dy = rnd() - 0.5;
            dz = rnd() - 0.5;
            d2 = 0.01;
          }
          const f = (spacing * spacing) / d2;
          force[i] += dx * f;
          force[i + 1] += dy * f;
          force[i + 2] += dz * f;
          force[j] -= dx * f;
          force[j + 1] -= dy * f;
          force[j + 2] -= dz * f;
        }
      }
      const c = centres[s.index];
      for (const n of m) {
        const i = n * 3;
        force[i] += (c[0] - pos[i]) * 0.02;
        force[i + 1] += (c[1] - pos[i + 1]) * 0.02;
        force[i + 2] += (c[2] - pos[i + 2]) * 0.02;
      }
    }
    for (const e of edges) {
      const i = e.a * 3;
      const j = e.b * 3;
      const dx = pos[j] - pos[i];
      const dy = pos[j + 1] - pos[i + 1];
      const dz = pos[j + 2] - pos[i + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      // Links across sectors pull weakly: sectors stay apart.
      const k = (nodes[e.a].sector === nodes[e.b].sector ? 0.06 : 0.004) * (d - spacing);
      const fx = (dx / d) * k;
      const fy = (dy / d) * k;
      const fz = (dz / d) * k;
      force[i] += fx;
      force[i + 1] += fy;
      force[i + 2] += fz;
      force[j] -= fx;
      force[j + 1] -= fy;
      force[j + 2] -= fz;
    }
    const most = spacing * 0.6 * heat + 0.05;
    for (const s of tied) {
      for (const n of s.members) {
        const i = n * 3;
        const f = Math.hypot(force[i], force[i + 1], force[i + 2]);
        const scale = f > most ? most / f : 1;
        pos[i] += force[i] * scale;
        pos[i + 1] += force[i + 1] * scale;
        pos[i + 2] += force[i + 2] * scale;
      }
    }
  }
  // Each sector's own centre and size, then the sectors moved apart as whole
  // pieces, evenly over a sphere wide enough that none touches another.
  const measure = (s) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const n of s.members) {
      x += pos[n * 3];
      y += pos[n * 3 + 1];
      z += pos[n * 3 + 2];
    }
    const k = s.members.length;
    s.centre = [x / k, y / k, z / k];
    let r = 0;
    for (const n of s.members) {
      r = Math.max(r, Math.hypot(pos[n * 3] - s.centre[0], pos[n * 3 + 1] - s.centre[1], pos[n * 3 + 2] - s.centre[2]));
    }
    s.radius = Math.max(r, spacing);
  };
  list.forEach(measure);
  if (list.length > 1) {
    const widest = Math.max(...list.map((s) => s.radius));
    const angle = Math.sqrt((4 * Math.PI) / list.length) * 0.85;
    const R = (widest * 2 + spacing * 3) / (2 * Math.sin(Math.min(angle, Math.PI / 2) / 2));
    const places = spherePoints(list.length, R);
    for (const s of list) {
      const to = places[s.index];
      const d = [to[0] - s.centre[0], to[1] - s.centre[1], to[2] - s.centre[2]];
      for (const n of s.members) {
        pos[n * 3] += d[0];
        pos[n * 3 + 1] += d[1];
        pos[n * 3 + 2] += d[2];
      }
      measure(s);
    }
  }
  return pos;
}

// When things and links came into memory, from the confirmed facts
// (/api/facts: id, created_at, decided_at). A link: when its first fact was
// confirmed. A thing: when its first link came; a thing with none takes the time
// of the thing before it by id (ids grow with time). Gives the sorted distinct
// times, `steps`; each thing and link gets `time` and `step`, its index there.
// Without any time, steps is empty and nothing gets one.
export function timeline(graph, facts) {
  const when = new Map();
  for (const f of facts || []) {
    const t = Date.parse(f.decided_at || f.created_at);
    if (Number.isFinite(t)) when.set(f.id, t);
  }
  for (const e of graph.edges) {
    e.time = Infinity;
    for (const id of e.facts || []) if (when.has(id)) e.time = Math.min(e.time, when.get(id));
  }
  for (const n of graph.nodes) {
    n.time = Infinity;
    for (const { edge } of n.links) n.time = Math.min(n.time, graph.edges[edge].time);
  }
  const byId = [...graph.nodes].sort((x, y) => Number(x.id) - Number(y.id) || x.index - y.index);
  const first = byId.find((n) => Number.isFinite(n.time));
  const clear = () => {
    for (const x of [...graph.nodes, ...graph.edges]) delete x.time;
    return [];
  };
  if (!first) return clear();
  let prev = first.time;
  for (const n of byId) {
    if (Number.isFinite(n.time)) prev = n.time;
    else n.time = prev;
  }
  for (const e of graph.edges) {
    if (!Number.isFinite(e.time)) e.time = Math.max(graph.nodes[e.a].time, graph.nodes[e.b].time);
  }
  const steps = [...new Set([...graph.nodes, ...graph.edges].map((x) => x.time))].sort((a, b) => a - b);
  const index = new Map(steps.map((t, i) => [t, i]));
  for (const x of [...graph.nodes, ...graph.edges]) x.step = index.get(x.time);
  return steps;
}

// Whether a link is there at step `at` (no step: always).
const there = (e, at) => !(e.step > at);

// Steps from a thing along links, up to `levels`: Map(node index → steps).
// Only links there at step `at` count.
export function distances(graph, start, levels, at = Infinity) {
  const out = new Map([[start, 0]]);
  let front = [start];
  for (let d = 1; d <= levels && front.length; d++) {
    const next = [];
    for (const n of front) {
      for (const { edge, other } of graph.nodes[n].links) {
        if (out.has(other) || !there(graph.edges[edge], at)) continue;
        out.set(other, d);
        next.push(other);
      }
    }
    front = next;
  }
  return out;
}

// The brightness of the highlight from a thing: its own links 1, the links of
// those things 1/2, the next 1/4 and so on. Edge index → brightness.
export function edgeBrightness(graph, dist, levels, at = Infinity) {
  const out = new Map();
  for (const e of graph.edges) {
    if (!there(e, at)) continue;
    const da = dist.get(e.a);
    const db = dist.get(e.b);
    if (da === undefined || db === undefined) continue;
    const step = Math.min(da, db); // 0: a link of the thing itself
    if (step >= levels) continue;
    out.set(e.index, 1 / 2 ** step);
  }
  return out;
}

export function nodeBrightness(steps) {
  return steps === 0 ? 1 : 1 / 2 ** (steps - 1);
}

// Search by name, other names and label: whole name first, then the start of a
// name, then anywhere.
export function search(graph, text, most = 8) {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const n of graph.nodes) {
    let best = 0;
    for (const [k, v] of [[n.name, 3], ...n.aliases.map((a) => [a, 2.5]), [n.label, 1]]) {
      const s = k.toLowerCase();
      if (!s) continue;
      if (s === q) best = Math.max(best, v * 3);
      else if (s.startsWith(q)) best = Math.max(best, v * 2);
      else if (s.includes(q)) best = Math.max(best, v);
    }
    if (best) scored.push([best + Math.min(n.degree, 20) / 100, n]);
  }
  return scored
    .sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name))
    .slice(0, most)
    .map(([, n]) => n);
}

// Where labels go on screen. Candidates come most important first; a label
// takes the first of four places by its point that hits no label already
// placed and no important point, or is left out. A candidate's `prefer` (0–3),
// the place it had before, is tried first, so labels do not jump around.
// Gives {node, x, y, slot} for each.
export function placeLabels(candidates, { width, height, most, pad = 3, points = [], blocked = [] }) {
  // blocked: rectangles {x, y, w, h} where nothing is placed (panels over the view).
  const placed = blocked.map((b) => ({ ...b, node: -1 }));
  const out = [];
  const hits = (r) => {
    if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) return true;
    for (const p of placed) {
      if (r.x < p.x + p.w + pad && p.x < r.x + r.w + pad && r.y < p.y + p.h + pad && p.y < r.y + r.h + pad) return true;
    }
    for (const p of points) {
      if (p.node === r.node) continue;
      if (p.x + p.r > r.x && p.x - p.r < r.x + r.w && p.y + p.r > r.y && p.y - p.r < r.y + r.h) return true;
    }
    return false;
  };
  for (const c of candidates) {
    if (out.length >= most) break;
    if (c.fixed) {
      // A label under the mouse stays where it is.
      placed.push({ x: c.fixed.x, y: c.fixed.y, w: c.w, h: c.h, node: c.node });
      out.push({ node: c.node, x: c.fixed.x, y: c.fixed.y });
      continue;
    }
    const gap = c.r + 4;
    const tries = [
      [c.x + gap, c.y - c.h / 2],
      [c.x - gap - c.w, c.y - c.h / 2],
      [c.x - c.w / 2, c.y - gap - c.h],
      [c.x - c.w / 2, c.y + gap],
    ];
    const order = [0, 1, 2, 3];
    if (c.prefer >= 0 && c.prefer < 4) order.unshift(...order.splice(c.prefer, 1));
    for (const slot of order) {
      const [x, y] = tries[slot];
      const r = { x, y, w: c.w, h: c.h, node: c.node };
      if (hits(r)) continue;
      placed.push(r);
      out.push({ node: c.node, x, y, slot });
      break;
    }
  }
  return out;
}
