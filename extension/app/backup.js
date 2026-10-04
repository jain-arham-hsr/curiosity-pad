// Mirrors every trail into a folder on disk each time the side panel opens.
// Uses Chrome's File System Access API: the folder is chosen once and its
// handle kept in IndexedDB. Chrome may ask again for permission after a
// restart; that is one click ("Allow backup") in the status line.
//
// Layout:  <folder>/<trail-slug>--<id8>/trail.md, trail.json, media/<node-id>.<ext>
// Only folders matching that pattern are ever removed, and only when their
// trail no longer exists.

import { getMeta, setMeta } from './db.js';
import * as store from './store.js';
import { mediaFileName, trailFolderName, trailToJSON, trailToMarkdown } from './export.js';

const OWNED_FOLDER = /--[0-9a-f]{8}$/;

export const supported = () => typeof globalThis.showDirectoryPicker === 'function';

export async function status() {
  const dir = await getMeta('backupDir');
  if (!dir) return { state: 'unset' };
  const permission = await dir.queryPermission({ mode: 'readwrite' });
  return {
    state: permission === 'granted' ? 'ready' : 'needs-permission',
    name: dir.name,
    last: await getMeta('lastBackup'),
  };
}

export async function chooseFolder() {
  const dir = await showDirectoryPicker({ id: 'curiosity-pad', mode: 'readwrite' });
  await setMeta('backupDir', dir);
  return dir;
}

export async function allow() {
  const dir = await getMeta('backupDir');
  return !!dir && (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (err) {
    if (err.name === 'NotFoundError') return false;
    throw err;
  }
}

async function writeFile(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

// Skip rewriting unchanged text so file dates (and Time Machine) stay quiet.
async function writeText(dir, name, text) {
  try {
    const current = await (await (await dir.getFileHandle(name)).getFile()).text();
    if (current === text) return;
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
  await writeFile(dir, name, text);
}

async function entries(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) out.push([name, handle]);
  return out;
}

export async function run() {
  const dir = await getMeta('backupDir');
  if (!dir) throw new Error('No backup folder chosen');
  const { trails, nodes } = await store.everything();
  const keep = new Set();

  for (const trail of trails) {
    const name = trailFolderName(trail);
    keep.add(name);
    const folder = await dir.getDirectoryHandle(name, { create: true });
    const own = nodes.filter((n) => n.trailId === trail.id);
    await writeText(folder, 'trail.md', trailToMarkdown(trail, own));
    await writeText(folder, 'trail.json', trailToJSON(trail, own));

    const withMedia = own.filter((n) => n.mediaId);
    if (!withMedia.length) continue;
    const mediaDir = await folder.getDirectoryHandle('media', { create: true });
    const wanted = new Set(withMedia.map(mediaFileName));
    for (const node of withMedia) {
      const file = mediaFileName(node);
      if (await exists(mediaDir, file)) continue; // media never changes once sent
      const media = await store.getMedia(node.mediaId);
      if (media) await writeFile(mediaDir, file, media.blob);
    }
    for (const [file, handle] of await entries(mediaDir)) {
      if (handle.kind === 'file' && !wanted.has(file)) await mediaDir.removeEntry(file);
    }
  }

  for (const [name, handle] of await entries(dir)) {
    if (handle.kind === 'directory' && OWNED_FOLDER.test(name) && !keep.has(name)) {
      await dir.removeEntry(name, { recursive: true });
    }
  }

  const at = Date.now();
  await setMeta('lastBackup', at);
  return { name: dir.name, at };
}
