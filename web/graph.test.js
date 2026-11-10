import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, distances, forProject, edgeBrightness, layout, nodeBrightness, placeLabels, search, sectors, timeline } from "./graph.js";

// What /api/entities answers: each link is in the lists of both its ends.
const link = (s, r, o, fact) => ({ text: `${s} — ${r} — ${o}`, fact_id: fact });
const things = [
  { id: 1, name: "SINCH", label: "supplier", aliases: ["Синч"], facts: 3, links: [link("SINCH", "supplier in", "av88", 10)] },
  { id: 2, name: "av88", label: "project", aliases: [], facts: 5, links: [link("SINCH", "supplier in", "av88", 10), link("Kote", "works on", "av88", 11)] },
  { id: 3, name: "Kote", label: "person", aliases: [], facts: 2, links: [link("Kote", "works on", "av88", 11), link("Kote", "lives in", "Tbilisi", 12)] },
  { id: 4, name: "Tbilisi", label: "city", aliases: [], facts: 1, links: [link("Kote", "lives in", "Tbilisi", 12)] },
  { id: 5, name: "Alone", label: "", aliases: [], facts: 1, links: [] },
];

test("links become edges between both ends, subject first", () => {
  const g = buildGraph(things);
  assert.equal(g.edges.length, 3);
  const e = g.edges.find((x) => x.relations[0] === "supplier in");
  assert.equal(g.nodes[e.a].name, "SINCH");
  assert.equal(g.nodes[e.b].name, "av88");
  assert.equal(g.nodes[1].degree, 2);
  assert.equal(g.nodes[4].degree, 0);
});

test("two facts linking the same pair make one edge with both relations", () => {
  const g = buildGraph([
    { id: 1, name: "A", links: [link("A", "x", "B", 1), link("B", "y", "A", 2)] },
    { id: 2, name: "B", links: [link("A", "x", "B", 1), link("B", "y", "A", 2)] },
  ]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0].relations.sort(), ["x", "y"]);
});

test("each link keeps its own direction; one relation from several facts is shown once", () => {
  const g = buildGraph([
    { id: 1, name: "A", links: [link("A", "boss of", "B", 1), link("B", "reports to", "A", 2), link("A", "Boss of", "B", 3)] },
    { id: 2, name: "B", links: [link("A", "boss of", "B", 1), link("B", "reports to", "A", 2), link("A", "Boss of", "B", 3)] },
  ]);
  const [e] = g.edges;
  assert.deepEqual(e.relations, ["boss of", "reports to"]);
  assert.deepEqual(
    e.links.map((l) => [g.nodes[l.from].name, l.relation, g.nodes[l.to].name, l.facts]),
    [["A", "boss of", "B", [1, 3]], ["B", "reports to", "A", [2]]],
  );
  assert.deepEqual(e.facts, [1, 2, 3]);
});

test("a project sees its own things and those everywhere, with the links between them", () => {
  const all = [
    { id: 1, name: "Owner", project_id: null, owner: true, links: [link("Owner", "runs", "Shop", 1), link("Owner", "visits", "Clinic", 2)] },
    { id: 2, name: "Shop", project_id: 7, links: [link("Owner", "runs", "Shop", 1)] },
    { id: 3, name: "Clinic", project_id: 8, links: [link("Owner", "visits", "Clinic", 2)] },
  ];
  assert.equal(forProject(all, "").length, 3);
  const g = buildGraph(forProject(all, "7"));
  assert.deepEqual(g.nodes.map((n) => n.name), ["Owner", "Shop"]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes[0].owner, true);
});

test("a link with one end outside the listing is left out", () => {
  const g = buildGraph([{ id: 1, name: "A", links: [link("A", "x", "Z", 1)] }]);
  assert.equal(g.edges.length, 0);
});

test("sectors: tied things together, things without links apart", () => {
  const g = buildGraph(things);
  const list = sectors(g);
  assert.equal(list.length, 2);
  assert.equal(list[0].members.length, 4);
  assert.ok(list[1].lonely);
  assert.deepEqual(list[1].members, [4]);
  for (const n of g.nodes) assert.ok(n.sector >= 0);
});

test("layout is deterministic and keeps things apart", () => {
  const g = buildGraph(things);
  const list = sectors(g);
  const a = layout(g, list, { spacing: 10 });
  const b = layout(buildGraph(things), sectors(buildGraph(things)), { spacing: 10 });
  assert.deepEqual([...a], [...b]);
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) {
      const d = Math.hypot(a[i * 3] - a[j * 3], a[i * 3 + 1] - a[j * 3 + 1], a[i * 3 + 2] - a[j * 3 + 2]);
      assert.ok(d > 3, `${i}-${j} too close: ${d}`);
    }
  }
  assert.ok(list.every((s) => s.centre && s.radius > 0));
});

test("highlight: own links full, links of links half, then a quarter", () => {
  const g = buildGraph(things);
  const sinch = 0;
  const dist = distances(g, sinch, 4);
  assert.equal(dist.get(1), 1);
  assert.equal(dist.get(2), 2);
  assert.equal(dist.get(3), 3);
  assert.equal(dist.has(4), false);
  const b = edgeBrightness(g, dist, 4);
  const by = (r) => b.get(g.edges.find((e) => e.relations[0] === r).index);
  assert.equal(by("supplier in"), 1);
  assert.equal(by("works on"), 0.5);
  assert.equal(by("lives in"), 0.25);
  assert.equal(nodeBrightness(0), 1);
  assert.equal(nodeBrightness(1), 1);
  assert.equal(nodeBrightness(2), 0.5);
});

test("highlight stops after the levels the owner set", () => {
  const g = buildGraph(things);
  const dist = distances(g, 0, 1);
  const b = edgeBrightness(g, dist, 1);
  assert.equal(b.size, 1);
});

test("search finds by name, other name and label, whole name first", () => {
  const g = buildGraph(things);
  assert.equal(search(g, "синч")[0].name, "SINCH");
  assert.equal(search(g, "av")[0].name, "av88");
  assert.equal(search(g, "person")[0].name, "Kote");
  assert.deepEqual(search(g, "   "), []);
  assert.deepEqual(search(g, "nothing"), []);
});

test("labels never overlap and skip what does not fit", () => {
  const cand = [];
  for (let i = 0; i < 30; i++) cand.push({ node: i, x: 100 + (i % 3), y: 100, r: 3, w: 60, h: 18 });
  const out = placeLabels(cand, { width: 400, height: 300, most: 30 });
  assert.ok(out.length >= 2 && out.length <= 4, `placed ${out.length}`);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      const overlap = a.x < b.x + 60 && b.x < a.x + 60 && a.y < b.y + 18 && b.y < a.y + 18;
      assert.ok(!overlap);
    }
  }
});

test("labels keep to the limit, stay on screen and off important points", () => {
  const cand = [];
  for (let i = 0; i < 50; i++) cand.push({ node: i, x: 20 + (i % 10) * 90, y: 20 + Math.floor(i / 10) * 60, r: 2, w: 40, h: 18 });
  const out = placeLabels(cand, { width: 900, height: 320, most: 7, points: [{ node: 99, x: 50, y: 20, r: 10 }] });
  assert.equal(out.length, 7);
  for (const p of out) {
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + 40 <= 900 && p.y + 18 <= 320);
    assert.ok(!(p.x < 60 && p.x + 40 > 40 && p.y < 30 && p.y + 18 > 10), "covers the point");
  }
});

test("labels keep off the panels", () => {
  const cand = [{ node: 0, x: 50, y: 50, r: 3, w: 40, h: 18 }, { node: 1, x: 300, y: 50, r: 3, w: 40, h: 18 }];
  const out = placeLabels(cand, { width: 400, height: 300, most: 5, blocked: [{ x: 0, y: 0, w: 150, h: 300 }] });
  assert.deepEqual(out.map((p) => p.node), [1]);
});

// Facts 10, 11, 12 confirmed one day apart; Alone has no link.
const facts = [
  { id: 10, created_at: "2026-01-01T09:00:00Z", decided_at: "2026-01-01T10:00:00Z" },
  { id: 11, created_at: "2026-01-02T10:00:00Z", decided_at: null },
  { id: 12, created_at: "2026-01-03T10:00:00Z", decided_at: "2026-01-03T10:00:00Z" },
];

test("timeline: links by their fact, things by their first link, the rest by id", () => {
  const g = buildGraph(things);
  const steps = timeline(g, facts);
  assert.deepEqual(steps, [Date.parse("2026-01-01T10:00:00Z"), Date.parse("2026-01-02T10:00:00Z"), Date.parse("2026-01-03T10:00:00Z")]);
  const byName = Object.fromEntries(g.nodes.map((n) => [n.name, n.step]));
  assert.deepEqual(byName, { SINCH: 0, av88: 0, Kote: 1, Tbilisi: 2, Alone: 2 });
  assert.deepEqual(g.edges.map((e) => [e.relations[0], e.step]), [["supplier in", 0], ["works on", 1], ["lives in", 2]]);
});

test("timeline without times gives nothing and leaves no steps", () => {
  const g = buildGraph(things);
  assert.deepEqual(timeline(g, []), []);
  assert.equal(g.nodes[0].step, undefined);
  assert.equal(distances(g, 0, 3).size, 4);
});

test("highlight walks only the links there at a step", () => {
  const g = buildGraph(things);
  timeline(g, facts);
  const sinch = g.nodes.findIndex((n) => n.name === "SINCH");
  assert.deepEqual([...distances(g, sinch, 5, 0).keys()].map((i) => g.nodes[i].name), ["SINCH", "av88"]);
  assert.equal(distances(g, sinch, 5, 1).size, 3);
  assert.equal(edgeBrightness(g, distances(g, sinch, 5), 5, 1).size, 2);
});

test("a label keeps the place it had before when it is free", () => {
  const c = { node: 0, x: 100, y: 100, r: 4, w: 40, h: 18 };
  assert.equal(placeLabels([c], { width: 400, height: 400, most: 5 })[0].slot, 0);
  const again = placeLabels([{ ...c, prefer: 2 }], { width: 400, height: 400, most: 5 })[0];
  assert.equal(again.slot, 2);
  assert.equal(again.y, 100 - 8 - 18);
});
