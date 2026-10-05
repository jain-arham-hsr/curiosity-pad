// Sync through the relay. The order is fixed: receive everything first, and
// only if that fully succeeds, send. Capturing is never blocked by any of it.
//
//   1. register this device, learn the others
//   2. pull: ops waiting for me  → apply → ack (leaves receipts for the author)
//   3. push: my outbox           → upload media, post ops, mark ◐
//   4. receipts addressed to me  → mark ●, delete them
//
// The relay deletes an op once every device it was pending for has acked it,
// and the last device to ack deletes the op's media. So the relay only ever
// holds what is in transit.

import * as store from './store.js';
import { auth, rest, storage, RelayError } from './supabase.js';
import { getMeta, setMeta } from './db.js';

const BATCH = 100;

export const status = {
  state: 'idle', // idle | syncing | ok | signed-out | alone | error
  message: '',
  kind: null, // RelayError.kind when state === 'error'
  lastSync: null,
  others: [],
};

const watchers = new Set();
export const onStatus = (fn) => { watchers.add(fn); fn(status); };
function set(patch) {
  Object.assign(status, patch);
  for (const fn of watchers) fn(status);
}

let running = null;

export function sync() {
  return (running ??= run().finally(() => { running = null; }));
}

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = typeof chrome !== 'undefined' && chrome.runtime?.id ? 'Chrome extension' : 'App';
  if (os === 'Android') return 'Phone (Android app)';
  return `${os} (${app})`;
}

async function run() {
  if (!(await auth.current())) return set({ state: 'signed-out', message: 'Sign in to sync', kind: null });
  set({ state: 'syncing', message: 'Syncing…', kind: null });
  try {
    const me = await store.deviceId();
    const others = await register(me);
    const askers = await pull(me);
    for (const asker of askers) await pushSnapshot(me, asker);
    const sent = others.length ? await push(me, others) : 0;
    await receipts(me);
    const at = Date.now();
    await setMeta('lastSync', at);
    set({ state: others.length ? 'ok' : 'alone', lastSync: at, others, kind: null, message: '' });
    return { sent };
  } catch (err) {
    console.error('Sync failed', err);
    const kind = err instanceof RelayError ? err.kind : 'request';
    set({ state: kind === 'auth' ? 'signed-out' : kind === 'devices' ? 'devices' : 'error', kind, message: err.message, others: err.devices ?? status.others, lastSync: await getMeta('lastSync') });
    return null;
  }
}

// At most this many devices may be signed in at once. A new device beyond
// that is refused until one of the others is signed out.
export const MAX_DEVICES = 2;

async function register(me) {
  const before = await rest.select('devices', 'select=id,name,last_seen');
  const known = before.some((d) => d.id === me);
  const others = before.filter((d) => d.id !== me);
  if (!known && others.length >= MAX_DEVICES) {
    const err = new RelayError('devices', `Already signed in on ${others.length} devices. Sign one of them out first.`);
    err.devices = others;
    throw err;
  }
  await rest.insert('devices', [{ id: me, name: deviceName(), last_seen: new Date().toISOString() }], { onConflict: 'id', merge: true });
  return others;
}

// Sign another device out of the relay (see remove_device in functions.sql).
export const removeDevice = (id) => rest.rpc('remove_device', { p_id: id });

// Returns the devices that asked for a full restore during this pull.
async function pull(me) {
  const askers = new Set();
  for (;;) {
    const rows = await rest.select('ops', `select=id,device,op&pending_for=cs.{${me}}&order=seq.asc&limit=${BATCH}`);
    if (!rows.length) return [...askers];
    const ops = rows.map((r) => r.op);
    for (const r of rows) if (r.op.type === 'restore.request') askers.add(r.device);
    const media = [];
    for (const op of ops) {
      if (op.type === 'node.create' && op.data.mediaId) {
        const blob = await storage.download(op.data.mediaId);
        media.push({ id: op.data.mediaId, blob, mime: op.data.mime ?? blob.type });
      }
    }
    await store.applyRemote(ops, media);
    const done = (await rest.rpc('ack_ops', { p_ids: ops.map((o) => o.id), p_device: me })) ?? [];
    const doneIds = new Set(done);
    const finished = ops.filter((o) => doneIds.has(o.id) && o.type === 'node.create' && o.data.mediaId);
    await storage.remove(finished.map((o) => o.data.mediaId));
    if (rows.length < BATCH) return [...askers];
  }
}

// Everything this device has, addressed to one device only. Bypasses the
// outbox: nothing changed here, so there is nothing to mark.
async function pushSnapshot(me, asker) {
  const ops = await store.snapshotOps();
  set({ state: 'syncing', message: `Sending everything to your other device (${ops.length})…` });
  for (let i = 0; i < ops.length; i += BATCH) {
    const batch = ops.slice(i, i + BATCH);
    for (const op of batch) {
      if (op.type === 'node.create' && op.data.mediaId) {
        const media = await store.getMedia(op.data.mediaId);
        if (media) await storage.upload(op.data.mediaId, media.blob);
      }
    }
    await rest.insert('ops', batch.map((op) => ({ id: op.id, device: me, pending_for: [asker], op })), {
      onConflict: 'id', ignoreDuplicates: true,
    });
  }
}

async function push(me, others) {
  const queue = await store.outboxOps();
  if (!queue.length) return 0;
  const pendingFor = others.map((d) => d.id);
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch = queue.slice(i, i + BATCH);
    for (const op of batch) {
      if (op.type === 'node.create' && op.data.mediaId) {
        const media = await store.getMedia(op.data.mediaId);
        if (media) await storage.upload(op.data.mediaId, media.blob);
      }
    }
    await rest.insert('ops', batch.map((op) => ({ id: op.id, device: me, pending_for: pendingFor, op })), {
      onConflict: 'id', ignoreDuplicates: true,
    });
    await store.removeFromOutbox(batch.map((op) => op.seq));
    await store.markNodes(batch.filter((op) => op.type === 'node.create' || op.type === 'node.edit').map((op) => op.id), 'relay');
  }
  return queue.length;
}

async function receipts(me) {
  const rows = await rest.select('receipts', `select=seq,op_id&to_device=eq.${me}&order=seq.asc&limit=1000`);
  if (!rows.length) return;
  await store.markNodes(rows.map((r) => r.op_id), 'both');
  await rest.delete('receipts', `to_device=eq.${me}&seq=lte.${rows.at(-1).seq}`);
}
