// Every change to the data is an operation ("op"). An op is applied to the
// local copy and appended to the outbox in the same transaction, so the local
// copy and the record of what still needs sending can never disagree.
// sync.js drains the outbox through the relay and applies ops from the other
// device with applyRemote().
//
// Ops:
//   trail.create { id, title }          node.create { id, trailId, parentId, pos, kind, ... }
//   trail.rename { id, title }          node.move   { id, parentId, pos }
//   trail.delete { id }                 node.edit   { id, body?, caption? }
//                                       node.delete { id }
//
// Trail markers on a node (node.sync): 'local' = this device only,
// 'relay' = reached the relay, 'both' = on the other device too. node.op is
// the id of the node's latest content op (create or edit); a receipt for that
// op is what turns ◐ into ●.

import { transact, wait, getMeta, setMeta } from './db.js';
import * as tree from './tree.js';
import { uid } from './util.js';

// ---- change notifications -------------------------------------------------
// BroadcastChannel reaches the other contexts (side panel <-> service worker)
// but not the sender itself, so local listeners are called directly too.

const channel = new BroadcastChannel('curiosity-pad');
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  channel.addEventListener('message', (e) => fn(e.data));
}

function announce(message) {
  for (const fn of listeners) fn(message);
  channel.postMessage(message);
}

export const announceCapture = (trailId) => announce({ type: 'captured', trailId });

// ---- applying ops ---------------------------------------------------------

let device;
export const deviceId = () =>
  (device ??= transact(['meta'], 'readwrite', async ({ meta }) => {
    let id = await wait(meta.get('deviceId'));
    if (!id) {
      id = uid();
      await wait(meta.put(id, 'deviceId'));
    }
    return id;
  }));

async function touch(s, trailId, at) {
  const trail = await wait(s.trails.get(trailId));
  if (trail) await wait(s.trails.put({ ...trail, updated: at }));
}

// `remote`: the op came from the other device, so content is already on both.
async function applyOp(s, op, { remote = false } = {}) {
  const d = op.data;
  switch (op.type) {
    case 'trail.create':
      if (remote && (await wait(s.trails.get(d.id)))) break;
      await wait(s.trails.put({ id: d.id, title: d.title, created: op.at, updated: op.at }));
      break;
    case 'trail.rename': {
      const trail = await wait(s.trails.get(d.id));
      if (trail) await wait(s.trails.put({ ...trail, title: d.title, updated: op.at }));
      break;
    }
    case 'trail.delete': {
      const nodes = await wait(s.nodes.index('trailId').getAll(d.id));
      for (const n of nodes) {
        if (n.mediaId) s.media.delete(n.mediaId);
        s.nodes.delete(n.id);
      }
      await wait(s.trails.delete(d.id));
      break;
    }
    case 'node.create': {
      if (remote && (await wait(s.nodes.get(d.id)))) break; // delivered twice
      if (remote && !(await wait(s.trails.get(d.trailId)))) break; // trail deleted here meanwhile
      await wait(s.nodes.put({
        id: d.id,
        trailId: d.trailId,
        parentId: d.parentId ?? null,
        pos: d.pos,
        kind: d.kind,
        body: d.body ?? '',
        caption: d.caption ?? '',
        mediaId: d.mediaId ?? null,
        mime: d.mime ?? null,
        duration: d.duration ?? null,
        source: d.source ?? null,
        created: op.at,
        edited: null,
        op: op.id,
        sync: remote ? 'both' : 'local',
        flag: null,
      }));
      await touch(s, d.trailId, op.at);
      break;
    }
    case 'node.move': {
      const node = await wait(s.nodes.get(d.id));
      if (!node) break;
      await wait(s.nodes.put({ ...node, parentId: d.parentId ?? null, pos: d.pos }));
      await touch(s, node.trailId, op.at);
      break;
    }
    case 'node.edit': {
      const node = await wait(s.nodes.get(d.id));
      if (!node) break;
      const next = { ...node, edited: op.at, op: op.id, sync: remote ? 'both' : 'local' };
      if ('body' in d) next.body = d.body;
      if ('caption' in d) next.caption = d.caption;
      await wait(s.nodes.put(next));
      await touch(s, node.trailId, op.at);
      break;
    }
    case 'node.delete': {
      const node = await wait(s.nodes.get(d.id));
      if (!node) break;
      if (node.mediaId) await wait(s.media.delete(node.mediaId));
      await wait(s.nodes.delete(d.id));
      await touch(s, node.trailId, op.at);
      break;
    }
    case 'restore.request':
      break; // handled by sync.js, not by the data
    default:
      throw new Error(`Unknown op: ${op.type}`);
  }
}

const ALL = ['trails', 'nodes', 'media', 'outbox', 'meta'];

async function commit(ops, { media = null, trailId = null } = {}) {
  const device = await deviceId();
  const at = Date.now();
  const stamped = ops.map((op) => ({ id: uid(), at, device, ...op }));
  await transact(ALL, 'readwrite', async (s) => {
    if (media) await wait(s.media.put(media));
    for (const op of stamped) {
      await applyOp(s, op);
      await wait(s.outbox.add(op));
    }
  });
  announce({ type: 'changed', trailId });
}

// ---- remote ops (called by sync.js) ---------------------------------------

// Applies ops from the other device, then replays this device's own queued
// moves and edits on top of them, in order. Anything that no longer makes
// sense afterwards is flagged on the entry rather than applied silently.
export async function applyRemote(ops, mediaList = []) {
  const conflicts = [];
  await transact(ALL, 'readwrite', async (s) => {
    for (const m of mediaList) await wait(s.media.put(m));
    for (const op of ops) await applyOp(s, op, { remote: true });

    const queue = await wait(s.outbox.getAll());
    for (const op of queue) {
      if (op.type === 'node.move' || op.type === 'node.edit') {
        if (await wait(s.nodes.get(op.data.id))) {
          await applyOp(s, op);
        } else {
          conflicts.push(`A ${op.type === 'node.edit' ? 'edit' : 'move'} was dropped: the entry was deleted on your other device.`);
          await wait(s.outbox.delete(op.seq));
        }
      } else if (op.type === 'trail.rename' && (await wait(s.trails.get(op.data.id)))) {
        await applyOp(s, op);
      }
    }

    // Entries whose parent is gone surface at the top level, flagged.
    const nodes = await wait(s.nodes.getAll());
    const ids = new Set(nodes.map((n) => n.id));
    const trails = new Set((await wait(s.trails.getAllKeys())));
    for (const n of nodes) {
      if (!trails.has(n.trailId)) { // trail deleted on the other device while this was added here
        if (n.mediaId) s.media.delete(n.mediaId);
        s.nodes.delete(n.id);
        conflicts.push('An entry was dropped: its trail was deleted on your other device.');
        continue;
      }
      if (n.parentId && !ids.has(n.parentId)) {
        const siblings = nodes.filter((x) => x.trailId === n.trailId && x.parentId == null);
        const pos = tree.between(Math.max(0, ...siblings.map((x) => x.pos)), null);
        await wait(s.nodes.put({ ...n, parentId: null, pos, flag: 'The entry this was nested under was deleted on your other device.' }));
        for (const op of queue) {
          if ((op.type === 'node.move' || op.type === 'node.create') && op.data.id === n.id) {
            await wait(s.outbox.put({ ...op, data: { ...op.data, parentId: null, pos } }));
          }
        }
        n.parentId = null;
      }
    }

    if (conflicts.length) {
      const existing = (await wait(s.meta.get('conflicts'))) ?? [];
      await wait(s.meta.put([...existing, ...conflicts].slice(-20), 'conflicts'));
    }
  });
  announce({ type: 'changed', trailId: null });
  return conflicts;
}

// ---- restore from the other device ----------------------------------------

// "Send me everything." Goes out like any op; the other device answers with
// a snapshot addressed only to this device.
export const requestRestore = () => commit([{ type: 'restore.request', data: {} }], { trailId: 'restore' });

// This device's whole data as create ops, for a device that lost its copy.
// Remote creates are skipped where the id already exists, so it is harmless
// if the receiver still had some of it.
export async function snapshotOps() {
  const { trails, nodes } = await everything();
  const device = await deviceId();
  const ops = trails.map((t) => ({ id: uid(), at: t.created, device, type: 'trail.create', data: { id: t.id, title: t.title } }));
  for (const n of nodes) {
    const { sync, flag, op, trailId, created, edited, ...data } = n;
    ops.push({ id: n.op ?? uid(), at: created, device, type: 'node.create', data: { ...data, trailId } });
  }
  return ops;
}

export const outboxOps = () => transact(['outbox'], 'readonly', (s) => wait(s.outbox.getAll()));
export const outboxCount = () => transact(['outbox'], 'readonly', (s) => wait(s.outbox.count()));

export const removeFromOutbox = (seqs) =>
  transact(['outbox'], 'readwrite', async (s) => {
    for (const seq of seqs) await wait(s.outbox.delete(seq));
  });

// Advances markers for the nodes whose latest content op is in `opIds`.
export async function markNodes(opIds, sync) {
  if (!opIds.length) return;
  await transact(['nodes'], 'readwrite', async (s) => {
    const index = s.nodes.index('op');
    for (const opId of opIds) {
      const node = await wait(index.get(opId));
      if (!node) continue;
      if (sync === 'relay' && node.sync === 'both') continue;
      await wait(s.nodes.put({ ...node, sync }));
    }
  });
  announce({ type: 'changed', trailId: null });
}

export const inTransitCount = () =>
  transact(['nodes'], 'readonly', async (s) => (await wait(s.nodes.getAll())).filter((n) => n.sync === 'relay').length);

export const conflicts = () => getMeta('conflicts').then((c) => c ?? []);
export const clearConflicts = () => setMeta('conflicts', []);

export const clearFlag = (trailId, id) =>
  transact(['nodes'], 'readwrite', async (s) => {
    const node = await wait(s.nodes.get(id));
    if (node) await wait(s.nodes.put({ ...node, flag: null }));
  }).then(() => announce({ type: 'changed', trailId }));

// ---- reads ----------------------------------------------------------------

export const listTrails = () =>
  transact(['trails', 'nodes'], 'readonly', async (s) => {
    const trails = await wait(s.trails.getAll());
    const index = s.nodes.index('trailId');
    const counts = await Promise.all(trails.map((t) => wait(index.count(t.id))));
    return trails.map((t, i) => ({ ...t, count: counts[i] })).sort((a, b) => b.updated - a.updated);
  });

export const getTrail = (id) => transact(['trails'], 'readonly', (s) => wait(s.trails.get(id)));

export const trailNodes = (trailId) =>
  transact(['nodes'], 'readonly', (s) => wait(s.nodes.index('trailId').getAll(trailId)));

export const getMedia = (id) => transact(['media'], 'readonly', (s) => wait(s.media.get(id)));

export const everything = () =>
  transact(['trails', 'nodes'], 'readonly', async (s) => ({
    trails: await wait(s.trails.getAll()),
    nodes: await wait(s.nodes.getAll()),
  }));

export const getActiveTrail = () => getMeta('activeTrailId');
export const setActiveTrail = (id) => setMeta('activeTrailId', id);

// Where a capture from the right-click menu lands: the trail last opened in
// the side panel, else the most recently touched one, else a new "Inbox".
export async function captureTrail() {
  const active = await getActiveTrail();
  if (active && (await getTrail(active))) return active;
  const [recent] = await listTrails();
  if (recent) return recent.id;
  return createTrail('Inbox');
}

// ---- writes ---------------------------------------------------------------

export async function createTrail(title) {
  const id = uid();
  await commit([{ type: 'trail.create', data: { id, title } }], { trailId: id });
  return id;
}

export const renameTrail = (id, title) =>
  commit([{ type: 'trail.rename', data: { id, title } }], { trailId: id });

export const deleteTrail = (id) => commit([{ type: 'trail.delete', data: { id } }], { trailId: id });

export async function addNode(trailId, {
  parentId = null, kind = 'text', body = '', caption = '', blob = null, duration = null, source = null,
} = {}) {
  const nodes = await trailNodes(trailId);
  const parent = parentId && nodes.some((n) => n.id === parentId) ? parentId : null;
  const id = uid();
  const media = blob ? { id: uid(), blob, mime: blob.type } : null;
  await commit([{
    type: 'node.create',
    data: {
      id, trailId, parentId: parent, pos: tree.endOf(nodes, parent), kind, body, caption,
      mediaId: media?.id ?? null, mime: media?.mime ?? null, duration, source,
    },
  }], { media, trailId });
  return id;
}

export const editNode = (trailId, id, changes) =>
  commit([{ type: 'node.edit', data: { id, ...changes } }], { trailId });

async function place(trailId, id, placeFn) {
  const nodes = await trailNodes(trailId);
  const p = placeFn(nodes);
  if (!p) return false;
  await commit([{ type: 'node.move', data: { id, parentId: p.parentId, pos: p.pos } }], { trailId });
  return true;
}

export const indent = (trailId, id) => place(trailId, id, (n) => tree.indentPlace(n, id));
export const outdent = (trailId, id) => place(trailId, id, (n) => tree.outdentPlace(n, id));
export const shift = (trailId, id, dir) => place(trailId, id, (n) => tree.shiftPlace(n, id, dir));
export const drop = (trailId, dragId, targetId, zone) =>
  place(trailId, dragId, (n) => tree.dropPlace(n, dragId, targetId, zone));

// Deleting a node keeps its replies: they move up into its slot first.
export async function deleteNode(trailId, id) {
  const nodes = await trailNodes(trailId);
  const moves = tree.promotePlaces(nodes, id).map((m) => ({ type: 'node.move', data: m }));
  await commit([...moves, { type: 'node.delete', data: { id } }], { trailId });
}
