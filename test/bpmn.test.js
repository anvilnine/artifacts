// BPMN artifacts: what publish refuses, and the layout it draws for a file that has none.
//
// The layout is checked by reading the result back with bpmn-moddle and asking geometric
// questions of it (is every shape inside its lane, does the main path run along one line),
// not by comparing against a stored file. A snapshot would fail on every spacing tweak and say
// nothing about whether the diagram is still readable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BpmnModdle } from 'bpmn-moddle';
import { prepareBpmn, BPMN_LAYOUT_MAX_NODES } from '../lib/bpmn.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', 'bpmn', name), 'utf8');

const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"';
const defs = (body, extra = '') => `<bpmn:definitions ${NS} ${extra} id="Defs">${body}</bpmn:definitions>`;

const LINEAR = defs(`<bpmn:process id="P">
  <bpmn:startEvent id="Start"/>
  <bpmn:task id="Work" name="Do the work"/>
  <bpmn:endEvent id="End"/>
  <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Work"/>
  <bpmn:sequenceFlow id="F2" sourceRef="Work" targetRef="End"/>
</bpmn:process>`);

// Parse a laid-out file and index its DI by element id.
async function readBack(xml) {
  const { rootElement, warnings } = await new BpmnModdle().fromXML(xml);
  assert.deepEqual(warnings.map((w) => w.message), [], 'the laid-out file parses cleanly');
  const shapes = new Map();
  const edges = new Map();
  for (const di of rootElement.diagrams[0].plane.planeElement) {
    if (di.$type === 'bpmndi:BPMNShape') shapes.set(di.bpmnElement.id, di);
    else edges.set(di.bpmnElement.id, di);
  }
  const elements = new Map();
  const walk = (el) => {
    if (el?.id) elements.set(el.id, el);
    for (const k of ['rootElements', 'flowElements', 'participants', 'messageFlows', 'laneSets', 'lanes']) {
      for (const c of el?.[k] || []) walk(c);
    }
  };
  walk(rootElement);
  return { defs: rootElement, shapes, edges, elements };
}

const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const inside = (inner, outer) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

async function refused(xml, pattern) {
  await assert.rejects(prepareBpmn(xml), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, pattern);
    return true;
  });
}

test('a process with no layout gets one, with every node and flow drawn', async () => {
  const { xml, laidOut } = await prepareBpmn(LINEAR);
  assert.equal(laidOut, true);
  const { shapes, edges, elements } = await readBack(xml);
  for (const id of ['Start', 'Work', 'End']) assert.ok(shapes.has(id), `${id} has a shape`);
  for (const id of ['F1', 'F2']) assert.ok(edges.get(id)?.waypoint.length >= 2, `${id} has an edge`);
  // The main path runs left to right along one line.
  const [s, w, e] = ['Start', 'Work', 'End'].map((id) => mid(shapes.get(id).bounds));
  assert.ok(s.x < w.x && w.x < e.x);
  assert.equal(s.y, w.y);
  assert.equal(w.y, e.y);
  // Hand-written XML leaves out <incoming>/<outgoing>; the stored file has them.
  assert.deepEqual(elements.get('Work').incoming.map((f) => f.id), ['F1']);
  assert.deepEqual(elements.get('Work').outgoing.map((f) => f.id), ['F2']);
});

test('a file that already has a layout is stored byte for byte', async () => {
  const { xml: drawn } = await prepareBpmn(LINEAR);
  const withComment = drawn.replace('<bpmn:process', '<!-- keep me --><bpmn:process');
  const out = await prepareBpmn(withComment);
  assert.equal(out.laidOut, false);
  assert.equal(out.xml, withComment);
});

test('lanes with no collaboration get a pool, and each node sits inside its lane', async () => {
  const xml = defs(`<bpmn:process id="P" name="Orders">
    <bpmn:laneSet id="LS">
      <bpmn:lane id="Sales" name="Sales"><bpmn:flowNodeRef>Start</bpmn:flowNodeRef><bpmn:flowNodeRef>Gw</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="Ops" name="Ops"><bpmn:flowNodeRef>A</bpmn:flowNodeRef><bpmn:flowNodeRef>B</bpmn:flowNodeRef><bpmn:flowNodeRef>End</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start"/>
    <bpmn:exclusiveGateway id="Gw"/>
    <bpmn:task id="A"/>
    <bpmn:task id="B"/>
    <bpmn:endEvent id="End"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start" targetRef="Gw"/>
    <bpmn:sequenceFlow id="F2" name="yes" sourceRef="Gw" targetRef="A"/>
    <bpmn:sequenceFlow id="F3" name="no" sourceRef="Gw" targetRef="B"/>
    <bpmn:sequenceFlow id="F4" sourceRef="A" targetRef="End"/>
    <bpmn:sequenceFlow id="F5" sourceRef="B" targetRef="End"/>
  </bpmn:process>`);
  const { defs: root, shapes, edges } = await readBack((await prepareBpmn(xml)).xml);
  const collab = root.rootElements.find((e) => e.$type === 'bpmn:Collaboration');
  assert.ok(collab, 'a collaboration was added to hold the pool');
  assert.equal(collab.participants.length, 1);
  assert.equal(collab.participants[0].processRef.id, 'P');
  assert.equal(collab.participants[0].name, 'Orders');
  assert.equal(root.diagrams[0].plane.bpmnElement, collab);

  const pool = shapes.get(collab.participants[0].id).bounds;
  for (const [lane, ids] of [['Sales', ['Start', 'Gw']], ['Ops', ['A', 'B', 'End']]]) {
    const laneBounds = shapes.get(lane).bounds;
    assert.ok(inside(laneBounds, pool), `${lane} is inside the pool`);
    for (const id of ids) assert.ok(inside(shapes.get(id).bounds, laneBounds), `${id} is inside ${lane}`);
  }
  // Both branches go down into Ops. They must not leave the gateway from the same point, or
  // they share a line and their labels land on each other.
  const starts = ['F2', 'F3'].map((id) => edges.get(id).waypoint[0]);
  assert.notDeepEqual([starts[0].x, starts[0].y], [starts[1].x, starts[1].y]);
});

test('two pools with lanes, message flows, a boundary event and a loop', async () => {
  const { shapes, edges } = await readBack((await prepareBpmn(fixture('order-pools.bpmn'))).xml);
  const customer = shapes.get('P_cust').bounds;
  const shop = shapes.get('P_shop').bounds;
  assert.ok(customer.y + customer.height <= shop.y, 'pools are stacked, not overlapping');
  for (const id of ['C_start', 'C_send', 'C_pay', 'C_end']) assert.ok(inside(shapes.get(id).bounds, customer), id);
  for (const id of ['S_check', 'S_pick', 'S_ship']) assert.ok(inside(shapes.get(id).bounds, shop), id);
  assert.ok(inside(shapes.get('S_pick').bounds, shapes.get('L_wh').bounds));

  for (const id of ['M1', 'M2']) assert.ok(edges.get(id)?.waypoint.length >= 2, `message flow ${id} is drawn`);
  // M1 runs from the customer pool down into the shop pool.
  const m1 = edges.get('M1').waypoint;
  assert.ok(m1[0].y <= m1[m1.length - 1].y);

  // The timer sits on the bottom edge of the task it is attached to.
  const host = shapes.get('S_pick').bounds;
  const timer = mid(shapes.get('S_timer').bounds);
  assert.equal(timer.y, host.y + host.height);
  assert.ok(timer.x > host.x && timer.x < host.x + host.width);

  // Escalate loops back to Check stock: the flow runs underneath both and comes up into it.
  const loop = edges.get('s6').waypoint;
  const check = shapes.get('S_check').bounds;
  const last = loop[loop.length - 1];
  assert.equal(last.y, check.y + check.height);
  assert.ok(Math.max(...loop.map((p) => p.y)) > check.y + check.height);

  // The main path through the warehouse stays on one line rather than being pushed down by an
  // end event fed from the other lane.
  assert.equal(mid(shapes.get('S_pick').bounds).y, mid(shapes.get('S_ship').bounds).y);
});

test('several processes with no collaboration each get a pool', async () => {
  const xml = defs(`<bpmn:process id="A"><bpmn:task id="Ta"/></bpmn:process><bpmn:process id="B"><bpmn:task id="Tb"/></bpmn:process>`);
  const { defs: root, shapes } = await readBack((await prepareBpmn(xml)).xml);
  const collab = root.rootElements.find((e) => e.$type === 'bpmn:Collaboration');
  assert.deepEqual(collab.participants.map((p) => p.processRef.id), ['A', 'B']);
  assert.ok(shapes.has('Ta') && shapes.has('Tb'));
});

test('ids added by the layout never collide with ids in the file', async () => {
  const xml = defs(`<bpmn:process id="P">
    <bpmn:task id="Work_di"/><bpmn:task id="Work"/><bpmn:task id="BPMNDiagram_1"/>
    <bpmn:sequenceFlow id="F" sourceRef="Work_di" targetRef="Work"/>
  </bpmn:process>`);
  const { xml: out } = await prepareBpmn(xml);
  const ids = [...out.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`);
});

test('vendor extensions survive the rewrite', async () => {
  const xml = defs(
    `<bpmn:process id="P"><bpmn:userTask id="T" camunda:assignee="sam"/></bpmn:process>`,
    'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"',
  );
  const { xml: out } = await prepareBpmn(xml);
  assert.match(out, /camunda:assignee="sam"/);
});

test('what publish refuses, and the reason it gives', async () => {
  await refused('', /BPMN 2\.0 XML\) is required/);
  await refused(undefined, /BPMN 2\.0 XML\) is required/);
  await refused(
    `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${LINEAR}`,
    /cannot carry a DOCTYPE/,
  );
  await refused('just some words', /not valid BPMN 2\.0 XML/);
  await refused('<html><body>hi</body></html>', /not valid BPMN 2\.0 XML/);
  await refused(defs('<bpmn:process id="P"><bpmn:task id="T">'), /not valid BPMN 2\.0 XML/);
  await refused(defs('<bpmn:process id="P"><bpmn:taskk id="T"/></bpmn:process>'), /BPMN problems: unparsable content <bpmn:taskk>/);
  await refused(
    defs('<bpmn:process id="P"><bpmn:task id="T"/><bpmn:sequenceFlow id="F" sourceRef="T" targetRef="Nope"/></bpmn:process>'),
    /unresolved reference <Nope> \(targetRef of "F"\)/,
  );
  await refused(defs('<bpmn:process id="P"><bpmn:task id="T"/><bpmn:task id="T"/></bpmn:process>'), /BPMN problems/);
  await refused(
    defs('<bpmn:process id="P"><bpmn:task id="T"/><bpmn:sequenceFlow id="F" sourceRef="T"/></bpmn:process>'),
    /sequence flow "F" needs both a sourceRef and a targetRef/,
  );
  await refused(defs(''), /nothing to draw/);
});

test('a process too big to lay out is refused with what to do instead', async () => {
  const tasks = Array.from({ length: BPMN_LAYOUT_MAX_NODES + 1 }, (_, i) => `<bpmn:task id="T${i}"/>`).join('');
  await refused(defs(`<bpmn:process id="P">${tasks}</bpmn:process>`), /include|included/);
});
