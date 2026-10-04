// Service worker for the phone app. Two jobs:
//   1. keep the app shell cached so it opens offline;
//   2. receive Android share-sheet captures (POST ./share) and store them
//      straight into the same local database the page reads.
// __VERSION__ is replaced at build time; a new version means a fresh cache.

import * as store from './app/store.js';
import { compressImage } from './app/media.js';

const VERSION = '__VERSION__';
const CACHE = `curiosity-pad-${VERSION}`;
const SHELL = [
  './', 'index.html', 'pwa.js', 'manifest.webmanifest',
  'app/main.js', 'app/store.js', 'app/db.js', 'app/tree.js', 'app/export.js', 'app/backup.js',
  'app/media.js', 'app/platform.js', 'app/util.js', 'app/sync.js', 'app/supabase.js', 'app/config.js',
  'app/styles.css', 'icons/192.png', 'icons/512.png', 'icons/512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(cacheFirst(e.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

const looksLikeUrl = (s) => /^https?:\/\/\S+$/.test((s ?? '').trim());

async function handleShare(request) {
  const home = new URL('./', request.url).href;
  try {
    const form = await request.formData();
    const title = (form.get('title') ?? '').toString().trim();
    const text = (form.get('text') ?? '').toString().trim();
    let url = (form.get('url') ?? '').toString().trim();
    // Some apps put the link in `text` instead of `url`.
    let body = text;
    if (!url && looksLikeUrl(text)) { url = text; body = ''; }
    const source = url ? { url, title } : null;
    const trailId = await store.captureTrail();
    const image = form.get('image');
    if (image && image.size) {
      const blob = await compressImage(image).catch(() => image);
      await store.addNode(trailId, { kind: 'image', blob, caption: body || title, source });
    } else if (body || title || url) {
      await store.addNode(trailId, { kind: 'text', body: body || title || url, source });
    }
    store.announceCapture(trailId);
  } catch (err) {
    console.error('Share failed', err);
  }
  return Response.redirect(`${home}?shared=1`, 303);
}
