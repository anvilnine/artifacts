// BPMN 2.0 artifacts: checking the XML on publish, and drawing a layout when it has none.
//
// A .bpmn file carries two things: the process (tasks, gateways, flows, lanes) and the diagram
// interchange (DI), which is the x/y of every shape and the bend points of every arrow. The
// viewer draws only what has DI. Modelling tools always write it; an agent writing XML by hand
// almost never does, and when it tries the coordinates are guesses that overlap. So a file with
// no DI gets one here, at publish time, and what gets stored is the laid-out file. Downloading
// /source then hands over something Camunda Modeler or Signavio opens as a drawn diagram.
//
// A file that already has DI is stored byte for byte. Someone who arranged it in a modeller
// meant that arrangement, and re-serialising would also drop formatting and comments.
//
// Why not bpmn-auto-layout: it lays out the first participant only, draws no pool or lane
// shapes at all, and walks each node's <incoming>/<outgoing> children rather than the flows'
// sourceRef/targetRef, which hand-written XML leaves out. Swimlanes are most of what a process
// map is for, so this does its own small layered layout instead.
//
// Parsing is bpmn-moddle, which does not expand entities: a DOCTYPE with an external or
// recursive entity comes back as an unparsable-content warning, never as file contents or a
// billion "lol"s. It is refused up front anyway so the error says what is actually wrong.

import { BpmnModdle } from 'bpmn-moddle';
import { ApiError } from './errors.js';

// Past this many shapes the layout is refused rather than attempted. Row placement is linear
// per column, so a pathological file with every node in one column costs n squared. A diagram
// this size was drawn in a tool and has DI anyway.
export const BPMN_LAYOUT_MAX_NODES = 2000;

// Shape sizes the bpmn.io modeller uses, so a laid-out file looks native when opened there.
const SIZE = {
  event: { width: 36, height: 36 },
  gateway: { width: 50, height: 50 },
  activity: { width: 100, height: 80 },
};

const COL_W = 160; // centre-to-centre distance between columns
const ROW_H = 110; // height of one row inside a lane
const BAND_PAD = 10; // space above the first row and below the last in a lane
const LABEL_W = 30; // the vertical name strip down the left of a pool, and of each lane
const POOL_GAP = 40; // vertical space between two pools
const ORIGIN = { x: 160, y: 80 };
const ERR_LIMIT = 5; // warnings quoted back in one error

// Parse, check, and lay out if needed. Returns the XML to store. Throws ApiError(400) naming
// what is wrong, worded so an agent that wrote the file can fix it from the message alone.
export async function prepareBpmn(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError(400, 'content (BPMN 2.0 XML) is required for a bpmn artifact');
  }
  if (/<!DOCTYPE/i.test(content)) {
    throw new ApiError(400, 'a bpmn artifact cannot carry a DOCTYPE: remove it and any entity declarations');
  }

  const moddle = new BpmnModdle();
  let parsed;
  try {
    parsed = await moddle.fromXML(content);
  } catch (err) {
    throw new ApiError(400, `not valid BPMN 2.0 XML: ${oneLine(err.message)}`);
  }
  const { rootElement: defs, warnings } = parsed;
  if (warnings.length) {
    const listed = warnings.slice(0, ERR_LIMIT).map(describeWarning).join('; ');
    const more = warnings.length > ERR_LIMIT ? ` (and ${warnings.length - ERR_LIMIT} more)` : '';
    throw new ApiError(400, `BPMN problems: ${listed}${more}`);
  }

  const processes = (defs.rootElements || []).filter((e) => is(e, 'bpmn:Process'));
  const collaboration = (defs.rootElements || []).find((e) => is(e, 'bpmn:Collaboration'));
  if (!processes.length && !collaboration?.participants?.length) {
    throw new ApiError(400, 'BPMN has nothing to draw: add a <bpmn:process> with at least one element');
  }
  for (const proc of processes) checkFlows(proc);

  if (hasDi(defs)) return { xml: content, laidOut: false };

  layout(moddle, defs, processes, collaboration);
  const { xml } = await moddle.toXML(defs, { format: true });
  return { xml, laidOut: true };
}

function is(el, type) {
  return Boolean(el?.$instanceOf?.(type));
}

// An unresolved reference names only the missing id. Saying which element and attribute held
// it is what lets an agent find the line to fix: `targetRef of "Flow_3"`.
function describeWarning(w) {
  const text = oneLine(w.message);
  if (w.element?.id && w.property) {
    return `${text} (${String(w.property).replace(/^bpmn:/, '')} of "${w.element.id}")`;
  }
  return text;
}

// moddle messages are multi-line ("unresolved reference <X>\n\tline: 3\n\tcolumn: 9 ...").
function oneLine(message) {
  return String(message).replace(/\s*\n\s*/g, ', ').trim();
}

// A sequence flow with no sourceRef or targetRef attribute parses without a warning (there is
// no reference to fail to resolve), and then draws as nothing. Say so at publish instead.
function checkFlows(proc) {
  for (const el of allFlowElements(proc)) {
    if (!is(el, 'bpmn:SequenceFlow')) continue;
    if (!el.sourceRef || !el.targetRef) {
      throw new ApiError(400, `BPMN problems: sequence flow "${el.id}" needs both a sourceRef and a targetRef`);
    }
  }
}

function hasDi(defs) {
  return (defs.diagrams || []).some((d) => d.plane?.planeElement?.length);
}

// The process's own flow elements. A sub-process is drawn collapsed, so what is inside it is
// not walked: its children get no DI and the viewer shows the sub-process as one box.
function allFlowElements(proc) {
  return proc.flowElements || [];
}

function sizeOf(node) {
  if (is(node, 'bpmn:Event')) return SIZE.event;
  if (is(node, 'bpmn:Gateway')) return SIZE.gateway;
  return SIZE.activity;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function layout(moddle, defs, processes, collaboration) {
  const ids = collectIds(defs);
  const uniqueId = (base) => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}_${n}`;
    ids.add(id);
    return id;
  };

  // Lanes are children of a pool in the viewer, and one diagram plane shows one process unless
  // it is a collaboration. So a file with lanes or with several processes, and no collaboration
  // to hold them, gets one: a pool per process, named after it.
  const needsPools = processes.length > 1 || processes.some((p) => leafLanes(p).length);
  if (!collaboration && needsPools) {
    collaboration = moddle.create('bpmn:Collaboration', { id: uniqueId('Collaboration_1') });
    collaboration.participants = processes.map((proc) => {
      const part = moddle.create('bpmn:Participant', {
        id: uniqueId(`Participant_${proc.id}`),
        name: proc.name || undefined,
        processRef: proc,
      });
      part.$parent = collaboration;
      return part;
    });
    collaboration.$parent = defs;
    defs.rootElements.unshift(collaboration);
  }

  const planeElement = [];
  const bounds = new Map(); // element -> { x, y, width, height }
  const addShape = (el, b, extra = {}) => {
    bounds.set(el, b);
    planeElement.push(moddle.create('bpmndi:BPMNShape', {
      id: uniqueId(`${el.id}_di`),
      bpmnElement: el,
      bounds: moddle.create('dc:Bounds', b),
      ...extra,
    }));
  };

  const bands = [];
  if (collaboration) {
    // Pools first, so their size is known before anything inside them is placed. A black-box
    // pool (no processRef) is an empty strip; message flows still land on its edge.
    const pools = (collaboration.participants || []).map((part) => ({
      part,
      plan: part.processRef ? planProcess(part.processRef) : null,
    }));
    const contentCols = Math.max(1, ...pools.map((p) => (p.plan ? p.plan.cols : 1)));
    let y = ORIGIN.y;
    const plans = [];
    for (const { part, plan } of pools) {
      const depth = plan ? plan.laneDepth : 0;
      const contentX = ORIGIN.x + LABEL_W * (1 + depth);
      const width = contentX - ORIGIN.x + contentCols * COL_W + 40;
      const height = plan ? plan.height : 100;
      addShape(part, { x: ORIGIN.x, y, width, height }, { isHorizontal: true });
      if (plan) {
        placeLanes(plan, { x: ORIGIN.x + LABEL_W, y, right: ORIGIN.x + width }, addShape);
        plans.push({ plan, contentX, top: y });
      }
      y += height + POOL_GAP;
    }
    for (const { plan, contentX, top } of plans) bands.push(placeNodes(plan, contentX, top, addShape));
  } else {
    const plan = planProcess(processes[0]);
    bands.push(placeNodes(plan, ORIGIN.x, ORIGIN.y, addShape));
  }

  for (const { flows } of bands) {
    const sideExits = gatewaySideExits(flows, bounds);
    for (const flow of flows) {
      const s = bounds.get(flow.sourceRef);
      const t = bounds.get(flow.targetRef);
      if (!s || !t) continue;
      const points = sequenceWaypoints(flow, s, t, sideExits.has(flow));
      planeElement.push(edge(moddle, uniqueId(`${flow.id}_di`), flow, points));
    }
  }
  for (const flow of collaboration?.messageFlows || []) {
    const s = bounds.get(flow.sourceRef);
    const t = bounds.get(flow.targetRef);
    if (!s || !t) continue;
    planeElement.push(edge(moddle, uniqueId(`${flow.id}_di`), flow, messageWaypoints(flow, s, t)));
  }

  const root = collaboration || processes[0];
  const diagram = moddle.create('bpmndi:BPMNDiagram', {
    id: uniqueId('BPMNDiagram_1'),
    plane: moddle.create('bpmndi:BPMNPlane', {
      id: uniqueId('BPMNPlane_1'),
      bpmnElement: root,
      planeElement,
    }),
  });
  defs.diagrams = [diagram];
}

function collectIds(defs) {
  const ids = new Set();
  const walk = (el) => {
    if (!el || typeof el !== 'object') return;
    if (typeof el.id === 'string') ids.add(el.id);
    for (const key of Object.keys(el)) {
      if (key.startsWith('$')) continue;
      const v = el[key];
      if (Array.isArray(v)) v.forEach((c) => c?.$type && walk(c));
      else if (v?.$type && v.$parent === el) walk(v);
    }
  };
  walk(defs);
  return ids;
}

// Leaf lanes in document order, each with the chain of lanes above it. Nested lane sets draw
// as lanes inside lanes, each level with its own name strip.
function leafLanes(proc) {
  const out = [];
  const walk = (laneSets, ancestors) => {
    for (const set of laneSets || []) {
      for (const lane of set.lanes || []) {
        const kids = lane.childLaneSet ? [lane.childLaneSet] : [];
        if (kids.length && kids[0].lanes?.length) walk(kids, [...ancestors, lane]);
        else out.push({ lane, ancestors });
      }
    }
  };
  walk(proc.laneSets, []);
  return out;
}

// Everything about one process that does not depend on where its pool ends up: which shapes it
// has, which lane band each sits in, its column, and its row inside the band.
function planProcess(proc) {
  const elements = allFlowElements(proc);
  const nodes = elements.filter((e) => is(e, 'bpmn:FlowNode') && !is(e, 'bpmn:BoundaryEvent'));
  const boundaries = elements.filter((e) => is(e, 'bpmn:BoundaryEvent') && nodes.includes(e.attachedToRef));
  const flows = elements.filter((e) => is(e, 'bpmn:SequenceFlow'));
  if (nodes.length > BPMN_LAYOUT_MAX_NODES) {
    throw new ApiError(
      400,
      `process "${proc.id}" has ${nodes.length} elements, over the ${BPMN_LAYOUT_MAX_NODES} this server will lay out: publish it with diagram layout (BPMNDiagram) included`,
    );
  }

  // Hand-written XML rarely lists <incoming>/<outgoing> on each node. Modellers expect them and
  // the file is being rewritten anyway, so they are filled in from the flows.
  for (const f of flows) {
    pushOnce(f.sourceRef.get('outgoing'), f);
    pushOnce(f.targetRef.get('incoming'), f);
  }

  // A flow leaving a boundary event is laid out as if it left the host, one row down: the
  // exception path runs under the task it escapes from.
  const layoutSource = (f) => (is(f.sourceRef, 'bpmn:BoundaryEvent') ? f.sourceRef.attachedToRef : f.sourceRef);
  const nodeSet = new Set(nodes);
  const out = new Map(nodes.map((n) => [n, []]));
  const inc = new Map(nodes.map((n) => [n, []]));
  for (const f of flows) {
    const s = layoutSource(f);
    if (!nodeSet.has(s) || !nodeSet.has(f.targetRef) || s === f.targetRef) continue;
    out.get(s).push({ node: f.targetRef, flow: f });
    inc.get(f.targetRef).push({ node: s, flow: f });
  }

  // Columns: longest path from a start, with loops cut where a depth-first walk meets a node
  // already on its stack. Walks begin at start events, then at anything with no incoming flow,
  // then at whatever a cycle left unreached, so every node gets a column.
  const back = new Set();
  const state = new Map(); // undefined = unseen, 1 = on stack, 2 = done
  const order = [];
  const visit = (root) => {
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [node, i] = top;
      const next = out.get(node)[i];
      if (!next) {
        state.set(node, 2);
        order.push(node);
        stack.pop();
        continue;
      }
      top[1]++;
      const seen = state.get(next.node);
      if (seen === 1) back.add(next.flow);
      else if (!seen) {
        state.set(next.node, 1);
        stack.push([next.node, 0]);
      }
    }
  };
  const starts = [
    ...nodes.filter((n) => is(n, 'bpmn:StartEvent')),
    ...nodes.filter((n) => !inc.get(n).length),
    ...nodes,
  ];
  for (const n of starts) if (!state.get(n)) visit(n);

  const col = new Map(nodes.map((n) => [n, 0]));
  for (const n of order.reverse()) {
    for (const { node, flow } of out.get(n)) {
      if (!back.has(flow)) col.set(node, Math.max(col.get(node), col.get(n) + 1));
    }
  }

  // Bands: one per leaf lane, or one for the whole process when it has no lanes. A node no lane
  // claims sits in the first band, which keeps it on the page rather than dropping it.
  const leaves = leafLanes(proc);
  const bandOf = new Map();
  const bandList = leaves.length ? leaves.map((l) => ({ ...l, rows: 1 })) : [{ lane: null, ancestors: [], rows: 1 }];
  leaves.forEach((l, i) => {
    for (const ref of l.lane.flowNodeRef || []) if (nodeSet.has(ref) && !bandOf.has(ref)) bandOf.set(ref, i);
  });
  for (const n of nodes) if (!bandOf.has(n)) bandOf.set(n, 0);

  // Rows: each node takes the free row nearest the average row of the nodes feeding it from the
  // same band, so the main path stays on one line and a gateway's second branch drops below it.
  const row = new Map();
  const taken = new Map(); // `${band}:${col}` -> Set of rows
  // Within a column, a node fed from its own band picks first. A node fed only from another
  // lane has no row to line up with, so it should not take the slot the main path runs along.
  const docOrder = new Map(nodes.map((n, i) => [n, i]));
  const local = (n) => (inc.get(n).some((e) => !back.has(e.flow) && bandOf.get(e.node) === bandOf.get(n)) ? 0 : 1);
  const byColumn = [...nodes].sort(
    (a, b) => col.get(a) - col.get(b) || local(a) - local(b) || docOrder.get(a) - docOrder.get(b),
  );
  for (const n of byColumn) {
    const band = bandOf.get(n);
    const feeders = inc.get(n).filter((e) => !back.has(e.flow) && bandOf.get(e.node) === band && row.has(e.node));
    const want = feeders.length
      ? Math.round(feeders.reduce((sum, e) => sum + row.get(e.node) + (is(e.flow.sourceRef, 'bpmn:BoundaryEvent') ? 1 : 0), 0) / feeders.length)
      : 0;
    const key = `${band}:${col.get(n)}`;
    if (!taken.has(key)) taken.set(key, new Set());
    const used = taken.get(key);
    // want, then want+1, want-1, want+2, ... skipping anything above the band's first row.
    let r = want;
    for (let d = 1; used.has(r) || r < 0; d++) r = want + (d % 2 ? Math.ceil(d / 2) : -d / 2);
    used.add(r);
    row.set(n, r);
    bandList[band].rows = Math.max(bandList[band].rows, r + 1);
  }

  const laneDepth = leaves.length ? Math.max(...leaves.map((l) => l.ancestors.length + 1)) : 0;
  const height = bandList.reduce((sum, b) => sum + bandHeight(b), 0);
  const cols = nodes.length ? Math.max(...nodes.map((n) => col.get(n))) + 1 : 1;
  return { proc, nodes, boundaries, flows, bands: bandList, bandOf, col, row, cols, laneDepth, height };
}

function pushOnce(list, item) {
  if (!list.includes(item)) list.push(item);
}

function bandHeight(band) {
  return Math.max(120, band.rows * ROW_H + 2 * BAND_PAD);
}

// Lane shapes: leaf lanes stacked down the pool, each parent lane spanning its children.
function placeLanes(plan, { x, y, right }, addShape) {
  if (!plan.bands[0].lane) return;
  let top = y;
  const span = new Map(); // parent lane -> { top, bottom, depth }
  for (const band of plan.bands) {
    const h = bandHeight(band);
    band.top = top;
    const lx = x + LABEL_W * band.ancestors.length;
    addShape(band.lane, { x: lx, y: top, width: right - lx, height: h }, { isHorizontal: true });
    band.ancestors.forEach((a, depth) => {
      const s = span.get(a) || { top, bottom: top, depth };
      s.bottom = top + h;
      span.set(a, s);
    });
    top += h;
  }
  for (const [lane, s] of span) {
    const lx = x + LABEL_W * s.depth;
    addShape(lane, { x: lx, y: s.top, width: right - lx, height: s.bottom - s.top }, { isHorizontal: true });
  }
}

function placeNodes(plan, contentX, poolTop, addShape) {
  let top = poolTop;
  for (const band of plan.bands) {
    band.top = top;
    top += bandHeight(band);
  }
  const placed = new Map();
  for (const n of plan.nodes) {
    const { width, height } = sizeOf(n);
    const cx = contentX + COL_W / 2 + plan.col.get(n) * COL_W;
    const cy = plan.bands[plan.bandOf.get(n)].top + BAND_PAD + plan.row.get(n) * ROW_H + ROW_H / 2;
    const b = { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height };
    placed.set(n, b);
    const extra = {};
    if (is(n, 'bpmn:SubProcess')) extra.isExpanded = false;
    if (is(n, 'bpmn:ExclusiveGateway')) extra.isMarkerVisible = true;
    addShape(n, b, extra);
  }
  // Boundary events sit on the bottom edge of their host, spread from the right.
  const perHost = new Map();
  for (const ev of plan.boundaries) {
    const host = placed.get(ev.attachedToRef);
    const i = perHost.get(host) || 0;
    perHost.set(host, i + 1);
    const { width, height } = SIZE.event;
    addShape(ev, {
      x: host.x + host.width - width - 8 - i * (width + 6),
      y: host.y + host.height - height / 2,
      width,
      height,
    });
  }
  return { flows: plan.flows };
}

function edge(moddle, id, flow, points) {
  return moddle.create('bpmndi:BPMNEdge', {
    id,
    bpmnElement: flow,
    waypoint: points.map(([x, y]) => moddle.create('dc:Point', { x: Math.round(x), y: Math.round(y) })),
  });
}

// A gateway sends its branches out of the top or bottom, which is clean until two branches go
// the same way: then they leave from the same point down the same line, and their labels land
// on each other. In that case the nearest one leaves from the side instead.
function gatewaySideExits(flows, bounds) {
  const side = new Set();
  const byGateway = new Map();
  for (const f of flows) {
    if (!is(f.sourceRef, 'bpmn:Gateway')) continue;
    const s = bounds.get(f.sourceRef);
    const t = bounds.get(f.targetRef);
    if (!s || !t || centre(t).x <= s.x + s.width) continue;
    if (!byGateway.has(s)) byGateway.set(s, []);
    byGateway.get(s).push({ f, dy: centre(t).y - centre(s).y });
  }
  for (const out of byGateway.values()) {
    if (out.length < 2 || out.some((o) => o.dy === 0)) continue;
    if (out.every((o) => o.dy > 0) || out.every((o) => o.dy < 0)) {
      out.sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy));
      side.add(out[0].f);
    }
  }
  return side;
}

// Right angles only. Forward flows leave the right side; a gateway sends a branch out of its
// top or bottom; a flow into a merge runs along its own row and drops in from above or below;
// a loop back runs underneath both shapes.
function sequenceWaypoints(flow, s, t, sideExit = false) {
  const sc = centre(s);
  const tc = centre(t);
  const boundary = is(flow.sourceRef, 'bpmn:BoundaryEvent');
  if (tc.x > s.x + s.width) {
    if (boundary) {
      return [[sc.x, s.y + s.height], [sc.x, tc.y], [t.x, tc.y]];
    }
    if (sc.y === tc.y) return [[s.x + s.width, sc.y], [t.x, tc.y]];
    if (is(flow.sourceRef, 'bpmn:Gateway') && !sideExit) {
      const exitY = tc.y > sc.y ? s.y + s.height : s.y;
      return [[sc.x, exitY], [sc.x, tc.y], [t.x, tc.y]];
    }
    if ((flow.targetRef.incoming || []).length > 1) {
      const entryY = sc.y > tc.y ? t.y + t.height : t.y;
      return [[s.x + s.width, sc.y], [tc.x, sc.y], [tc.x, entryY]];
    }
    const midX = (s.x + s.width + t.x) / 2;
    return [[s.x + s.width, sc.y], [midX, sc.y], [midX, tc.y], [t.x, tc.y]];
  }
  const under = Math.max(s.y + s.height, t.y + t.height) + 25;
  return [[sc.x, s.y + s.height], [sc.x, under], [tc.x, under], [tc.x, t.y + t.height]];
}

// Message flows cross between pools, so they run vertically: out of the facing edge of the
// source, across at the midpoint, into the facing edge of the target. A pool as either end
// uses the other end's x, so the arrow lands square on the pool's edge.
function messageWaypoints(flow, s, t) {
  const sc = centre(s);
  const tc = centre(t);
  const down = tc.y > sc.y;
  const sx = is(flow.sourceRef, 'bpmn:Participant') ? tc.x : sc.x;
  const tx = is(flow.targetRef, 'bpmn:Participant') ? sx : tc.x;
  const sy = down ? s.y + s.height : s.y;
  const ty = down ? t.y : t.y + t.height;
  if (sx === tx) return [[sx, sy], [tx, ty]];
  const midY = (sy + ty) / 2;
  return [[sx, sy], [sx, midY], [tx, midY], [tx, ty]];
}

function centre(b) {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
