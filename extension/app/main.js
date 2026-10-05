// The side panel UI. Two views: the list of Question Trails, and one trail.
// Rendering is deliberately simple: on any change, re-read and rebuild the list.

import * as store from './store.js';
import * as backup from './backup.js';
import * as sync from './sync.js';
import { auth } from './supabase.js';
import { compressImage, Recorder } from './media.js';
import { flatten, isWithin } from './tree.js';
import { trailToMarkdown } from './export.js';
import { ago, formatDuration, shortDate, stamp } from './util.js';
import { hasExtension, openMicSetup } from './platform.js';
import { openSheet, closeSheet, coarse } from './sheet.js';
import { attachGestures } from './gestures.js';
import { createPlayer } from './player.js';
import { getMeta, setMeta } from './db.js';

const $ = (id) => document.getElementById(id);
const bar = $('bar');
const statusLine = $('status');
const list = $('list');
const composer = $('composer');

const state = {
  view: 'trails',
  trail: null,
  nodes: [],
  selected: null,
  replyTo: null,
  editing: null,
  draft: '',
  confirming: null, // a node id (keyboard delete)
  renaming: false,
  expanded: new Set(),
  pendingImage: null, // { blob, url }
  recorder: null,
  dragId: null,
  pinBottom: true,
  backup: { state: 'unknown' },
  notice: '',
  account: null, // session, when signed in
  counts: { toSend: 0, inTransit: 0 },
  conflicts: [],
  hintsSeen: 3, // first-use tip shows while < 3
  showDone: false,
};

const refs = {};
const mediaUrls = new Map();
let noticeTimer;
let recordingTimer;
let refreshTimer;

// Trail markers: how far a node has travelled.
const MARKERS = {
  local: ['○', 'Only on this device'],
  relay: ['◐', 'Reached the relay, not yet on your other device'],
  both: ['●', 'On both devices'],
};

const svg = (body, stroke = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  back: svg('<path d="M15 5l-7 7 7 7"/>', 2),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  image: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  send: svg('<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/>'),
  reply: svg('<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10"/>'),
  indent: svg('<path d="M4 6h16M10 12h10M10 18h10M4 10l3 2-3 2"/>'),
  outdent: svg('<path d="M4 6h16M10 12h10M10 18h10M7 10l-3 2 3 2"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  edit: svg('<path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
  more: svg('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01"/>'),
  sync: svg('<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4M4 4v5h5M20 20v-5h-5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  pencil: svg('<path d="M4 20h4l10-10-4-4L4 16v4z"/>', 1.6),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 2),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>', 2.2),
  undo: svg('<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>'),
};
// The app icon, simplified: a spiral pad with a question mark.
const PAD_GLYPH = `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><rect width="128" height="128" rx="28" fill="#0f211d"/>
<g transform="translate(0 -3)"><path d="M30 33h68v68a10 10 0 0 1-10 10H40a10 10 0 0 1-10-10z" fill="#4f8f78"/><path d="M30 33h68v63a10 10 0 0 1-10 10H40a10 10 0 0 1-10-10z" fill="#8cc7ab"/><path d="M30 33h68v60a10 10 0 0 1-10 10H40a10 10 0 0 1-10-10z" fill="#a8d9c3"/>
<g fill="none" stroke="#2a9b74" stroke-width="3.2"><ellipse cx="38.5" cy="33" rx="4.6" ry="8.5" transform="rotate(-22 38.5 33)"/><ellipse cx="55.5" cy="33" rx="4.6" ry="8.5" transform="rotate(-22 55.5 33)"/><ellipse cx="72.5" cy="33" rx="4.6" ry="8.5" transform="rotate(-22 72.5 33)"/><ellipse cx="89.5" cy="33" rx="4.6" ry="8.5" transform="rotate(-22 89.5 33)"/></g>
<g fill="#4f8f78"><circle cx="39.7" cy="40" r="2.6"/><circle cx="56.7" cy="40" r="2.6"/><circle cx="73.7" cy="40" r="2.6"/><circle cx="90.7" cy="40" r="2.6"/></g>
<g transform="translate(64 71) scale(0.95)"><path d="M-14 -10a14 14 0 1 1 21 12c-5.5 3-7 6-7 12" fill="none" stroke="#1f5f4a" stroke-width="8" stroke-linecap="round"/><circle cy="26" r="5" fill="#1f5f4a"/></g></g></svg>`;

// ---- tiny DOM helpers -----------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') el.style.cssText = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function button(label, onclick, { cls = '', title, icon } = {}) {
  const el = h('button', {
    class: cls,
    title,
    type: 'button',
    onclick: (e) => { e.stopPropagation(); onclick(e); },
  });
  if (icon) el.innerHTML = ICONS[icon];
  el.append(label);
  return el;
}

function iconButton(icon, title, onclick, cls = '') {
  return h('button', {
    class: `icon ${cls}`,
    title,
    type: 'button',
    'aria-label': title,
    html: ICONS[icon],
    onclick: (e) => { e.stopPropagation(); onclick(e); },
  });
}

const URL_PATTERN = /(https?:\/\/[^\s<>"')\]]+)/g;

function linkify(text) {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 ? h('a', { href: part, target: '_blank', rel: 'noreferrer' }, part) : part);
}

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

function snippet(node) {
  if (!node) return '';
  const text = node.kind === 'text' ? node.body : node.caption;
  if (text) return text.replace(/\s+/g, ' ').slice(0, 80);
  return node.kind === 'image' ? 'Image' : 'Voice note';
}

const isQuestion = (node) => node.kind === 'text' && /\?\s*$/.test(node.body ?? '');

// A persistent problem goes in the status line; a passing message is a toast.
function notice(message, kind = 'error') {
  state.notice = message;
  state.noticeKind = kind;
  renderStatus();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { state.notice = ''; renderStatus(); }, 8000);
}

let toastEl;
let toastTimer;
function toast(message, { bad = false, ms = 2800 } = {}) {
  toastEl ??= document.body.appendChild(h('div', { id: 'toast', role: 'status' }));
  toastEl.textContent = message;
  toastEl.classList.toggle('bad', bad);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// Full-screen preview of an image. Tap the image to zoom 2x (then scroll to
// pan), tap the backdrop or press Escape to close.
function openLightbox(src, caption) {
  closeSheet();
  const img = h('img', { src, alt: caption || 'Image' });
  const box = h('div', { class: 'lightbox' }, img,
    iconButton('close', 'Close', () => box.remove(), 'lightbox-close'),
    caption ? h('div', { class: 'lightbox-caption' }, caption) : null);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); box.remove(); } };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    const zoomed = box.classList.toggle('zoomed');
    if (zoomed) {
      // keep the tapped point under the finger
      const rx = e.offsetX / img.clientWidth, ry = e.offsetY / img.clientHeight;
      requestAnimationFrame(() => {
        box.scrollLeft = rx * img.clientWidth - box.clientWidth / 2;
        box.scrollTop = ry * img.clientHeight - box.clientHeight / 2;
      });
    }
  });
  const observer = new MutationObserver(() => { if (!box.isConnected) { document.removeEventListener('keydown', onKey); observer.disconnect(); } });
  observer.observe(document.body, { childList: true });
  document.body.append(box);
}

async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch (err) {
    toast(`Couldn't copy: ${err.message}`, { bad: true });
  }
}

// ---- views ----------------------------------------------------------------

function resetTrailState() {
  state.selected = null;
  state.replyTo = null;
  state.editing = null;
  state.confirming = null;
  state.renaming = false;
  state.expanded.clear();
  clearPendingImage();
  cancelRecording();
  closeSheet();
}

function revokeMedia() {
  for (const url of mediaUrls.values()) URL.revokeObjectURL(url);
  mediaUrls.clear();
}

async function showTrails() {
  resetTrailState();
  revokeMedia();
  state.view = 'trails';
  state.trail = null;
  state.nodes = [];
  renderComposer();
  await refresh();
}

async function openTrail(id) {
  const trail = await store.getTrail(id);
  if (!trail) return showTrails();
  if (state.trail?.id !== id) {
    resetTrailState();
    revokeMedia();
    if (state.hintsSeen < 3) {
      state.hintsSeen += 1;
      setMeta('hintsSeen', state.hintsSeen);
    }
  }
  state.view = 'trail';
  state.trail = trail;
  await store.setActiveTrail(id);
  renderComposer();
  await refresh({ scroll: 'bottom' });
  if (!coarse()) refs.textarea?.focus();
}

async function refresh({ scroll } = {}) {
  state.counts = { toSend: await store.outboxCount(), inTransit: await store.inTransitCount() };
  state.conflicts = await store.conflicts();
  if (state.view === 'signin' || state.view === 'recover') {
    renderStatus();
    return;
  }
  if (state.view === 'trails') {
    const trails = await store.listTrails();
    if (state.view !== 'trails') return;
    renderTrailsBar();
    renderTrailList(trails);
  } else {
    const trail = await store.getTrail(state.trail.id);
    if (!trail) return showTrails();
    const nodes = await store.trailNodes(trail.id);
    if (state.view !== 'trail' || state.trail?.id !== trail.id) return;
    state.trail = trail;
    state.nodes = nodes;
    const ids = new Set(nodes.map((n) => n.id));
    for (const key of ['selected', 'replyTo', 'editing', 'confirming']) {
      if (state[key] && !ids.has(state[key])) state[key] = null;
    }
    renderTrailBar();
    renderNodes(scroll);
    renderChips();
  }
  renderStatus();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 30);
}

// ---- trails list ----------------------------------------------------------

function renderTrailsBar() {
  bar.replaceChildren(h('h1', {}, h('span', { class: 'brand', html: PAD_GLYPH }), 'Curiosity Pad'), iconButton('help', 'How to use', (e) => showHelp(e.currentTarget)));
}

function renderTrailList(trails) {
  const version = document.querySelector('meta[name="version"]')?.content;
  const account = h('p', { class: 'account' },
    ...(state.account
      ? [`Signed in as ${state.account.email}. `, button('Sign out', signOut, { cls: 'linkish' })]
      : ['Not syncing. ', button('Sign in', showSignIn, { cls: 'linkish' }), ' to reach your phone.']),
    version ? h('span', { class: 'version' }, ` · v${version}`) : null);
  if (!trails.length) {
    const other = sync.status.others[0];
    const restore = state.account && other
      ? h('p', { class: 'account' }, 'Had trails before? ',
        button(`Restore from ${other.name}`, requestRestore, { cls: 'linkish' }), '.')
      : null;
    list.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'glyph', html: PAD_GLYPH }),
      h('span', {}, 'No Question Trails yet. Start one below with the question you are chasing.')), ...[restore, account].filter(Boolean));
    return;
  }
  const card = (t) => h('button', { class: `trail${t.done ? ' done' : ''}`, type: 'button', onclick: () => openTrail(t.id) },
    h('span', { class: 'trail-title' }, t.done ? h('span', { class: 'tick', html: ICONS.check }) : null, t.title),
    h('span', { class: 'trail-meta' }, h('span', { class: 'count' }, `${t.count} ${t.count === 1 ? 'entry' : 'entries'}`),
      t.done ? `completed ${shortDate(t.done)}` : shortDate(t.updated)));
  const active = trails.filter((t) => !t.done);
  const done = trails.filter((t) => t.done).sort((a, b) => b.done - a.done);
  const parts = active.map(card);
  if (done.length) {
    parts.push(h('button', { class: 'section', type: 'button', onclick: () => { state.showDone = !state.showDone; renderTrailList(trails); } },
      h('span', { class: 'chev', html: state.showDone ? ICONS.down : ICONS.up }), `Completed (${done.length})`));
    if (state.showDone) parts.push(...done.map(card));
  }
  list.replaceChildren(...parts, account);
}

function showHelp(anchor) {
  const touch = coarse();
  openSheet({
    title: 'How to use',
    anchor,
    items: [
      { text: 'A Question Trail is the chain of questions you had to answer to understand something. Add each one as it comes up; nest follow-ups under the question that caused them. Read bottom-up, it is the outline of your note.' },
      { divider: true },
      { text: touch
        ? 'Tap an entry to select it, long-press for all actions.\nSwipe right to nest it under the entry above, left to un-nest.\nPull down at the top to sync.'
        : 'Click an entry to select it.\nTab / Shift+Tab nest and un-nest · Alt+↑↓ move · R reply · E edit · Delete removes.\nDrag an entry onto another: top edge = before, bottom = after, middle = inside.' },
      { divider: true },
      { text: `${MARKERS.local[0]}  ${MARKERS.local[1]}\n${MARKERS.relay[0]}  ${MARKERS.relay[1]}\n${MARKERS.both[0]}  ${MARKERS.both[1]}` },
    ],
  });
}

// ---- sign in / password recovery -----------------------------------------

function field(type, placeholder, autocomplete) {
  return h('input', { type, placeholder, autocomplete, 'aria-label': placeholder, required: true });
}

function showSignIn() {
  resetTrailState();
  state.view = 'signin';
  bar.replaceChildren(iconButton('back', 'Back', showTrails), h('h1', {}, 'Sign in'));
  composer.replaceChildren();
  const email = field('email', 'Email', 'username');
  const password = field('password', 'Password', 'current-password');
  const result = h('p', { class: 'form-result' });
  const form = h('form', { class: 'form' },
    h('p', { class: 'muted' }, 'Once per device. The app stays signed in after this.'),
    email, password,
    h('div', { class: 'form-actions' },
      button('Forgot password?', () => forgotPassword(email.value.trim(), result), { cls: 'linkish' }),
      h('button', { type: 'submit', class: 'primary' }, 'Sign in')),
    result);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    result.textContent = 'Signing in…';
    try {
      state.account = await auth.signIn(email.value.trim(), password.value);
      await showTrails();
      runSync();
    } catch (err) {
      result.textContent = err.kind === 'auth' || err.status === 400 ? 'Wrong email or password.' : err.message;
    }
  });
  list.replaceChildren(form);
  renderStatus();
  email.focus();
}

async function forgotPassword(email, result) {
  if (!email) { result.textContent = 'Type your email first.'; return; }
  try {
    const hosted = location.protocol === 'https:' ? `${location.origin}${location.pathname}` : undefined;
    await auth.recover(email, hosted);
    result.textContent = 'Reset email sent. The link opens the phone app, where you set a new password.';
  } catch (err) {
    result.textContent = err.message;
  }
}

// Reached from the reset email: the tokens are in the URL fragment.
function showRecovery(params) {
  state.view = 'recover';
  bar.replaceChildren(h('h1', {}, 'New password'));
  composer.replaceChildren();
  const password = field('password', 'New password', 'new-password');
  const again = field('password', 'Again', 'new-password');
  const result = h('p', { class: 'form-result' });
  const form = h('form', { class: 'form' }, password, again,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Set password')), result);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (password.value.length < 6) { result.textContent = 'Use at least 6 characters.'; return; }
    if (password.value !== again.value) { result.textContent = "Those don't match."; return; }
    try {
      state.account = await auth.setPassword(password.value, {
        access_token: params.get('access_token'), refresh_token: params.get('refresh_token'),
      });
      history.replaceState(null, '', location.pathname);
      result.textContent = 'Done. You are signed in here; use the new password on your other device.';
      setTimeout(showTrails, 1500);
      runSync();
    } catch (err) {
      result.textContent = err.message;
    }
  });
  list.replaceChildren(form);
  renderStatus();
  password.focus();
}

async function requestRestore() {
  await store.requestRestore();
  toast('Asked your other device. Open Curiosity Pad there to send everything.', { ms: 5000 });
  runSync();
}

async function signOut() {
  await auth.signOut();
  state.account = null;
  await refresh();
  sync.sync();
}

// ---- one trail: header ----------------------------------------------------

function renderTrailBar() {
  if (state.renaming) return; // keep the rename field alive
  const trail = state.trail;
  bar.replaceChildren(
    iconButton('back', 'All Question Trails', showTrails),
    h('h1', { class: `title${trail.done ? ' done' : ''}`, title: 'Rename', onclick: startRename },
      trail.done ? h('span', { class: 'tick', html: ICONS.check, title: `Completed ${shortDate(trail.done)}` }) : null,
      trail.title, h('span', { class: 'pencil', html: ICONS.pencil })),
    iconButton('more', 'Trail menu', (e) => showTrailMenu(e.currentTarget)),
  );
}

function showTrailMenu(anchor) {
  const trail = state.trail;
  openSheet({
    title: trail.title,
    anchor,
    items: [
      { label: 'Rename', icon: ICONS.pencil, onSelect: startRename },
      { label: 'Copy as outline', icon: ICONS.copy, hint: 'Markdown', onSelect: () => copyText(trailToMarkdown(trail, state.nodes), 'Outline copied') },
      trail.done
        ? { label: 'Reopen', icon: ICONS.undo, hint: `completed ${shortDate(trail.done)}`, onSelect: () => store.setTrailDone(trail.id, false).then(() => toast('Reopened')) }
        : { label: 'Mark as complete', icon: ICONS.check, onSelect: () => store.setTrailDone(trail.id, true).then(() => toast('Marked complete. Find it under “Completed” in the list.')) },
      { divider: true },
      { label: 'Delete trail', icon: ICONS.trash, danger: true, confirm: 'Delete this trail and everything in it?', onSelect: deleteTrail },
    ],
  });
}

function startRename() {
  state.renaming = true;
  const input = h('input', { type: 'text', class: 'rename', 'aria-label': 'Trail title' });
  input.value = state.trail.title;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    state.renaming = false;
    const title = input.value.trim();
    if (save && title && title !== state.trail.title) await store.renameTrail(state.trail.id, title);
    renderTrailBar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  bar.replaceChildren(iconButton('back', 'All Question Trails', showTrails), input);
  input.focus();
  input.select();
}

async function deleteTrail() {
  const id = state.trail.id;
  await store.deleteTrail(id);
  await showTrails();
  toast('Trail deleted');
}

// ---- one trail: nodes -----------------------------------------------------

function renderNodes(scroll) {
  const top = list.scrollTop;
  const rows = flatten(state.nodes);
  if (!rows.length) {
    list.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'glyph', html: PAD_GLYPH }),
      h('span', {}, 'Nothing here yet. Write what you want to understand, and add each new question as it comes up.')));
  } else {
    list.replaceChildren(...rows.map(nodeRow), ...[tip(rows.length)].filter(Boolean));
  }
  hydrateMedia();
  if (scroll === 'bottom') {
    state.pinBottom = true;
    list.scrollTop = list.scrollHeight;
  } else if (scroll) {
    list.querySelector(`[data-id="${scroll}"]`)?.scrollIntoView({ block: 'nearest' });
  } else {
    list.scrollTop = top;
  }
  if (state.editing) {
    const field = list.querySelector('.edit textarea');
    if (field && document.activeElement !== field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }
}

// Shown under the entries the first few times a trail is opened.
function tip(count) {
  if (count < 2 || state.hintsSeen >= 3) return null;
  const text = coarse()
    ? 'Tap an entry for actions · swipe right to nest it under the one above'
    : 'Click an entry for actions · Tab nests it · drag to reorder';
  return h('div', { class: 'tip' }, h('span', {}, text),
    button('Got it', () => { state.hintsSeen = 3; setMeta('hintsSeen', 3); renderNodes(); }, { cls: 'linkish' }));
}

async function hydrateMedia() {
  for (const el of list.querySelectorAll('[data-media]')) {
    const id = el.dataset.media;
    let url = mediaUrls.get(id);
    if (!url) {
      const media = await store.getMedia(id);
      if (!media) continue;
      url = URL.createObjectURL(media.blob);
      mediaUrls.set(id, url);
    }
    if (el.tagName === 'IMG') el.addEventListener('load', () => { if (state.pinBottom) list.scrollTop = list.scrollHeight; }, { once: true });
    el.src = url;
  }
}

function nodeRow({ node, depth }) {
  const selected = state.selected === node.id;
  const editing = state.editing === node.id;

  const card = h('div', {
    class: `card${selected ? ' selected' : ''}${isQuestion(node) ? ' question' : ''}`,
    tabindex: '0',
    draggable: editing || coarse() ? 'false' : 'true',
  },
  editing ? editor(node) : content(node),
  meta(node),
  selected && !editing ? actions(node) : null);

  card.addEventListener('click', (e) => {
    if (e.target.closest('a, button, textarea, input, .player, img.media')) return;
    select(selected ? null : node.id);
  });
  card.addEventListener('dragstart', (e) => {
    state.dragId = node.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-curiosity-node', node.id);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    state.dragId = null;
    card.classList.remove('dragging');
    clearDropMarks();
  });
  if (!editing) {
    attachGestures(card, {
      onSwipeRight: () => nest(node.id, 1),
      onSwipeLeft: () => nest(node.id, -1),
      onLongPress: () => { select(node.id, { quiet: true }); showActions(node.id); },
    });
  }

  const row = h('div', { class: 'row', style: `--depth:${depth}`, dataset: { id: node.id } }, card);
  row.addEventListener('dragover', (e) => {
    if (!state.dragId || isWithin(state.nodes, node.id, state.dragId)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(row, dropZone(e, card));
  });
  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget)) clearDropMarks(row);
  });
  row.addEventListener('drop', async (e) => {
    if (!state.dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const dragId = state.dragId;
    const zone = dropZone(e, card);
    state.dragId = null;
    clearDropMarks();
    await store.drop(state.trail.id, dragId, node.id, zone);
  });
  return row;
}

// Top 30% of a card: drop before it. Bottom 30%: after it. Middle: nest inside.
function dropZone(e, card) {
  const rect = card.getBoundingClientRect();
  const y = (e.clientY - rect.top) / rect.height;
  return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
}

function markDrop(row, zone) {
  clearDropMarks();
  row.classList.add(`drop-${zone}`);
}

function clearDropMarks(only) {
  for (const row of only ? [only] : list.querySelectorAll('.row')) {
    row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }
}

function content(node) {
  const parts = [];
  if (node.kind === 'image') {
    parts.push(h('img', {
      class: 'media', alt: node.caption || 'Image', dataset: { media: node.mediaId }, title: 'Tap to enlarge',
      onclick: (e) => { e.stopPropagation(); openLightbox(e.currentTarget.src, node.caption); },
    }));
  }
  if (node.kind === 'audio') {
    const player = createPlayer({ duration: node.duration ?? 0, key: node.mediaId });
    player.dataset.media = node.mediaId;
    parts.push(player);
  }
  const text = node.kind === 'text' ? node.body : node.caption;
  if (text) {
    const long = text.length > 600 || text.split('\n').length > 10;
    const open = state.expanded.has(node.id);
    parts.push(h('div', { class: `text${long && !open ? ' clamp' : ''}` }, ...linkify(text)));
    if (long) {
      parts.push(button(open ? 'Show less' : 'Show more', () => {
        if (open) state.expanded.delete(node.id); else state.expanded.add(node.id);
        renderNodes();
      }, { cls: 'more-text' }));
    }
  }
  return h('div', { class: 'content' }, ...parts);
}

function meta(node) {
  const sync = MARKERS[node.sync] ? node.sync : 'local';
  const [mark, label] = MARKERS[sync];
  const flag = node.flag
    ? h('div', { class: 'flag' }, node.flag, ' ', button('Got it', () => store.clearFlag(node.trailId, node.id), { cls: 'linkish' }))
    : null;
  const marker = coarse()
    ? button(mark, () => toast(label), { cls: `marker ${sync}`, title: label })
    : h('span', { class: `marker ${sync}`, title: label, 'aria-label': label }, mark);
  return h('div', { class: 'meta-wrap' }, flag, h('div', { class: 'meta' },
    node.source?.url
      ? h('a', { class: 'source', href: node.source.url, target: '_blank', rel: 'noreferrer', title: node.source.title || node.source.url }, hostOf(node.source.url))
      : null,
    h('span', { title: new Date(node.created).toLocaleString() }, stamp(node.created)),
    node.edited ? h('span', { class: 'edited', title: `Edited ${new Date(node.edited).toLocaleString()}` }, 'edited') : null,
    marker));
}

// Under a selected entry. Touch gets the essentials and a menu; desktop gets
// the frequent ones inline too.
function actions(node) {
  if (state.confirming === node.id) {
    const hasReplies = state.nodes.some((n) => n.parentId === node.id);
    return h('div', { class: 'actions confirm' },
      h('span', { style: 'margin-right:auto' }, hasReplies ? 'Delete? Its replies move up a level.' : 'Delete this?'),
      button('Delete', () => removeNode(node.id), { cls: 'danger' }),
      button('Cancel', () => { state.confirming = null; renderNodes(); }));
  }
  const more = button('', (e) => showActions(node.id, e.currentTarget), { cls: 'more', icon: 'more', title: 'More' });
  if (coarse()) {
    return h('div', { class: 'actions' },
      button('Reply', () => reply(node.id), { icon: 'reply' }),
      button('Edit', () => startEdit(node.id), { icon: 'edit' }),
      more);
  }
  const t = state.trail.id;
  return h('div', { class: 'actions' },
    button('Reply', () => reply(node.id), { icon: 'reply', title: 'Add a follow-up under this (R)' }),
    button('', () => store.indent(t, node.id), { icon: 'indent', title: 'Nest under the one above (Tab)' }),
    button('', () => store.outdent(t, node.id), { icon: 'outdent', title: 'Un-nest (Shift+Tab)' }),
    button('Edit', () => startEdit(node.id), { icon: 'edit', title: 'Edit (E)' }),
    button('Delete', () => { state.confirming = node.id; renderNodes(); }, { cls: 'danger', icon: 'trash', title: 'Delete (⌫)' }),
    more);
}

function showActions(id, anchor) {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;
  const t = state.trail.id;
  const siblings = flatten(state.nodes).map((r) => r.node.id);
  const text = node.kind === 'text' ? node.body : node.caption;
  const hasReplies = state.nodes.some((n) => n.parentId === id);
  openSheet({
    title: snippet(node),
    anchor,
    items: [
      { label: 'Reply', icon: ICONS.reply, hint: coarse() ? '' : 'R', onSelect: () => reply(id) },
      { label: 'Nest under the one above', icon: ICONS.indent, hint: coarse() ? 'swipe →' : 'Tab', onSelect: () => nest(id, 1) },
      { label: 'Un-nest', icon: ICONS.outdent, hint: coarse() ? '← swipe' : 'Shift+Tab', disabled: !node.parentId, onSelect: () => nest(id, -1) },
      { label: 'Move up', icon: ICONS.up, hint: coarse() ? '' : 'Alt+↑', onSelect: () => store.shift(t, id, -1) },
      { label: 'Move down', icon: ICONS.down, hint: coarse() ? '' : 'Alt+↓', onSelect: () => store.shift(t, id, 1) },
      { divider: true },
      { label: 'Edit', icon: ICONS.edit, hint: coarse() ? '' : 'E', onSelect: () => startEdit(id) },
      { label: 'Copy text', icon: ICONS.copy, disabled: !text, onSelect: () => copyText(text) },
      { divider: true },
      { label: 'Delete', icon: ICONS.trash, danger: true, confirm: hasReplies ? 'Delete? Its replies move up a level.' : 'Delete this entry?', onSelect: () => removeNode(id) },
    ].filter((item) => item.label !== 'Move up' || siblings.length > 1),
  });
}

async function nest(id, dir) {
  const ok = dir > 0 ? await store.indent(state.trail.id, id) : await store.outdent(state.trail.id, id);
  if (!ok) toast(dir > 0 ? 'Nothing above to nest under' : 'Already at the top level');
}

function editor(node) {
  const field = node.kind === 'text' ? 'body' : 'caption';
  const original = node[field] ?? '';
  const save = async () => {
    const value = state.draft.trim();
    state.editing = null;
    if (field === 'body' && !value) return renderNodes(); // a text entry can't be emptied
    if (value !== original.trim()) await store.editNode(state.trail.id, node.id, { [field]: value });
    else renderNodes();
  };
  const cancel = () => { state.editing = null; renderNodes(); };
  const area = h('textarea', {
    rows: '4',
    placeholder: field === 'caption' ? 'Caption' : '',
    oninput: (e) => { state.draft = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    },
  });
  area.value = state.draft;
  const preview = node.kind === 'text' ? null : content({ ...node, caption: '' });
  return h('div', { class: 'edit' }, preview, area,
    h('div', { class: 'edit-actions' },
      h('span', { class: 'hint fine-only' }, '⌘↩ to save'),
      button('Cancel', cancel),
      button('Save', save, { cls: 'primary' })));
}

function select(id, { quiet = false } = {}) {
  state.selected = id;
  state.confirming = null;
  renderNodes();
  if (id && !quiet) list.querySelector(`[data-id="${id}"] .card`)?.focus({ preventScroll: true });
}

function reply(id) {
  state.replyTo = id;
  renderChips();
  refs.textarea?.focus();
}

function startEdit(id) {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;
  state.editing = id;
  state.draft = (node.kind === 'text' ? node.body : node.caption) ?? '';
  renderNodes();
}

async function removeNode(id) {
  state.confirming = null;
  if (state.selected === id) state.selected = null;
  await store.deleteNode(state.trail.id, id);
}

// ---- composer -------------------------------------------------------------

function renderComposer() {
  for (const key of Object.keys(refs)) delete refs[key];

  if (state.view === 'trails') {
    const input = h('input', { type: 'text', placeholder: 'Start a new Question Trail…', 'aria-label': 'New trail' });
    const start = async () => {
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      await openTrail(await store.createTrail(title));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
    composer.replaceChildren(h('div', { class: 'compose-row' }, input, button('Start', start, { cls: 'primary' })));
    return;
  }

  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (file) setPendingImage(file);
  });

  const area = h('textarea', { rows: '1', placeholder: 'Ask, note, paste…', 'aria-label': 'Message', enterkeyhint: 'send' });
  area.addEventListener('input', () => { autosize(); updatePrimary(); });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); primaryAction(); }
    if (e.key === 'Escape' && state.replyTo) { state.replyTo = null; renderChips(); }
  });
  area.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    setPendingImage(file);
  });

  const primary = h('button', { class: 'icon round primary', type: 'button', onclick: () => primaryAction() });
  refs.textarea = area;
  refs.primary = primary;
  refs.chips = h('div', { class: 'chips' });

  composer.replaceChildren(
    refs.chips,
    h('div', { class: 'compose-row' },
      iconButton('image', 'Add an image (or paste / drop one)', () => fileInput.click(), 'round'),
      area,
      primary),
    fileInput,
  );
  updatePrimary();
  renderChips();
}

function autosize() {
  const area = refs.textarea;
  if (!area) return;
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
}

function updatePrimary() {
  if (!refs.primary) return;
  const sending = state.recorder || state.pendingImage || refs.textarea.value.trim();
  refs.primary.innerHTML = sending ? ICONS.send : ICONS.mic;
  const label = state.recorder ? 'Send voice note' : sending ? 'Send (Enter)' : 'Record a voice note';
  refs.primary.title = label;
  refs.primary.setAttribute('aria-label', label);
}

function renderChips() {
  if (!refs.chips) return;
  const chips = [];
  if (state.replyTo) {
    const target = state.nodes.find((n) => n.id === state.replyTo);
    chips.push(h('div', { class: 'chip' },
      h('span', { class: 'chip-label' }, '↳ Replying to'),
      h('span', { class: 'chip-text' }, snippet(target)),
      button('×', () => { state.replyTo = null; renderChips(); }, { cls: 'ghost', title: 'Cancel reply' })));
  }
  if (state.pendingImage) {
    chips.push(h('div', { class: 'chip' },
      h('img', { class: 'thumb', src: state.pendingImage.url, alt: '' }),
      h('span', { class: 'chip-text' }, 'Image ready. Anything you type becomes its caption.'),
      button('×', clearPendingImage, { cls: 'ghost', title: 'Remove image' })));
  }
  if (state.recorder) {
    chips.push(h('div', { class: 'chip recording' },
      h('span', { class: 'dot' }),
      h('span', { class: 'chip-text' }, `Recording ${formatDuration(state.recorder.elapsed())}. Anything you type becomes its caption.`),
      button('Cancel', cancelRecording, { cls: 'ghost' })));
  }
  refs.chips.replaceChildren(...chips);
}

async function setPendingImage(file) {
  try {
    const blob = await compressImage(file);
    clearPendingImage();
    state.pendingImage = { blob, url: URL.createObjectURL(blob) };
    renderChips();
    updatePrimary();
    refs.textarea?.focus();
  } catch (err) {
    toast(`Couldn't read that image: ${err.message}`, { bad: true });
  }
}

function clearPendingImage() {
  if (state.pendingImage) URL.revokeObjectURL(state.pendingImage.url);
  state.pendingImage = null;
  renderChips();
  updatePrimary();
}

async function primaryAction() {
  if (state.recorder) return finishRecording();
  if (state.pendingImage || refs.textarea.value.trim()) return send();
  return startRecording();
}

// Pull what the other device sent before showing a new entry, so nothing
// pops in above it a moment later. Capped so a slow network can't hold the
// entry back for long; offline or signed out, there is nothing to wait for.
function settleFirst() {
  if (!state.account || !navigator.onLine) return Promise.resolve();
  return Promise.race([runSync(), new Promise((r) => setTimeout(r, 2500))]);
}

// Sends run one after another, so quick successive entries keep their order.
let sendChain = Promise.resolve();
function enqueueSend(trailId, entry) {
  const parentId = state.replyTo;
  state.replyTo = null;
  renderChips();
  sendChain = sendChain
    .then(settleFirst)
    .then(async () => {
      if (!state.trail || state.trail.id !== trailId) { await store.addNode(trailId, { ...entry, parentId }); return; }
      const id = await store.addNode(trailId, { ...entry, parentId });
      await refresh({ scroll: parentId ? id : 'bottom' });
    })
    .catch((err) => toast(`Couldn't add that: ${err.message}`, { bad: true }));
  return sendChain;
}

function clearComposer() {
  refs.textarea.value = '';
  autosize();
  updatePrimary();
}

function send() {
  const text = refs.textarea.value.trim();
  const trailId = state.trail.id;
  if (state.pendingImage) {
    const { blob } = state.pendingImage;
    clearPendingImage();
    clearComposer();
    return enqueueSend(trailId, { kind: 'image', blob, caption: text });
  }
  if (!text) return Promise.resolve();
  clearComposer();
  return enqueueSend(trailId, { kind: 'text', body: text });
}

async function startRecording() {
  const recorder = new Recorder();
  try {
    await recorder.start();
  } catch (err) {
    if (err.name === 'NotAllowedError' && hasExtension) {
      toast('Chrome needs one-time microphone access. Allow it in the tab that just opened, then record again.', { ms: 6000 });
      openMicSetup();
    } else {
      toast(`Couldn't start recording: ${err.message}`, { bad: true });
    }
    return;
  }
  state.recorder = recorder;
  recordingTimer = setInterval(renderChips, 500);
  renderChips();
  updatePrimary();
}

async function finishRecording() {
  const recorder = state.recorder;
  clearInterval(recordingTimer);
  state.recorder = null;
  const { blob, duration } = await recorder.stop();
  const caption = refs.textarea.value.trim();
  const trailId = state.trail.id;
  clearComposer();
  await enqueueSend(trailId, { kind: 'audio', blob, duration, caption });
}

function cancelRecording() {
  clearInterval(recordingTimer);
  state.recorder?.cancel();
  state.recorder = null;
  renderChips();
  updatePrimary();
}

// ---- status line: one pill; details in a sheet ----------------------------

function renderStatus() {
  if (state.notice) {
    statusLine.replaceChildren(h('span', { class: state.noticeKind === 'info' ? 'info' : 'notice' }, state.notice));
    return;
  }
  const { mark, text, tone } = statusSummary();
  const pill = h('button', { class: `pill${tone ? ` ${tone}` : ''}`, type: 'button', title: 'Sync and backup details', onclick: (e) => showSyncSheet(e.currentTarget) },
    h('span', { class: `marker ${mark === MARKERS.both[0] ? 'both' : mark === MARKERS.relay[0] ? 'relay' : 'local'}` }, mark), text);
  const extra = [];
  if (state.conflicts.length) extra.push(h('span', { class: 'notice' }, `${state.conflicts.length} change${state.conflicts.length === 1 ? '' : 's'} dropped`));
  if (state.backup.state === 'needs-permission') extra.push(button('Allow backup', allowBackup, { cls: 'linkish' }));
  statusLine.replaceChildren(pill, ...extra);
}

function statusSummary() {
  const s = sync.status;
  const { toSend, inTransit } = state.counts;
  switch (s.state) {
    case 'signed-out': return { mark: MARKERS.local[0], text: toSend ? `${toSend} not synced` : 'Not synced', tone: null };
    case 'syncing': return { mark: MARKERS.relay[0], text: s.message || 'Syncing…', tone: null };
    case 'alone': return { mark: MARKERS.local[0], text: toSend ? `${toSend} waiting for your phone` : 'Waiting for your phone', tone: null };
    case 'error': return { mark: MARKERS.local[0], text: s.kind === 'paused' ? 'Relay paused' : s.kind === 'offline' ? 'Offline' : 'Sync failed', tone: s.kind === 'paused' ? 'bad' : 'warn' };
    default:
      if (toSend) return { mark: MARKERS.local[0], text: `${toSend} to send`, tone: null };
      if (inTransit) return { mark: MARKERS.relay[0], text: `${inTransit} in transit`, tone: null };
      return { mark: MARKERS.both[0], text: 'Synced', tone: null };
  }
}

function showSyncSheet(anchor) {
  const s = sync.status;
  const { toSend, inTransit } = state.counts;
  const lines = [];
  if (s.state === 'signed-out') lines.push('Not signed in. Entries stay on this device.');
  else if (s.state === 'alone') lines.push('No other device has signed in yet, so nothing is sent.');
  else if (s.state === 'error') lines.push(s.message);
  else lines.push(s.lastSync ? `Last synced ${ago(s.lastSync)}.` : 'Not synced yet.');
  if (s.others.length) lines.push(`Other device: ${s.others.map((d) => d.name).join(', ')}.`);
  lines.push(`${toSend} ${MARKERS.local[0]} to send · ${inTransit} ${MARKERS.relay[0]} in transit.`);

  const items = [{ text: lines.join('\n') }];
  if (state.conflicts.length) {
    items.push({ divider: true }, { text: state.conflicts.join('\n') },
      { label: 'Clear these', onSelect: async () => { await store.clearConflicts(); refresh(); } });
  }
  items.push({ divider: true });
  if (s.state === 'signed-out') items.push({ label: 'Sign in', icon: ICONS.user, onSelect: showSignIn });
  else items.push({ label: 'Sync now', icon: ICONS.sync, onSelect: runSync });
  if (s.state === 'error' && s.kind === 'paused') items.push({ text: 'Open the Supabase dashboard and restore the project, then sync again.' });

  const b = state.backup;
  if (b.state !== 'unsupported' && b.state !== 'unknown') {
    items.push({ divider: true });
    if (b.state === 'unset') items.push({ label: 'Choose backup folder', icon: ICONS.folder, hint: 'on this Mac', onSelect: chooseBackup });
    else if (b.state === 'needs-permission') items.push({ label: 'Allow backup', icon: ICONS.folder, hint: b.name, onSelect: allowBackup });
    else if (b.state === 'running') items.push({ text: 'Backing up…' });
    else if (b.state === 'error') items.push({ label: 'Backup failed. Retry', icon: ICONS.folder, danger: true, onSelect: runBackup });
    else items.push({ label: 'Back up now', icon: ICONS.folder, hint: `${b.name} · ${ago(b.last)}`, onSelect: runBackup });
  }
  if (state.account) items.push({ divider: true }, { label: `Sign out (${state.account.email})`, icon: ICONS.user, onSelect: signOut });
  openSheet({ title: 'Sync', anchor, items });
}

let syncTimer;
function runSync() {
  clearTimeout(syncTimer);
  return sync.sync();
}
function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 1500);
}

async function backupOnOpen() {
  if (!backup.supported()) {
    state.backup = { state: 'unsupported' };
    return renderStatus();
  }
  const s = await backup.status();
  if (s.state === 'ready') return runBackup();
  state.backup = s;
  renderStatus();
}

async function runBackup() {
  state.backup = { ...state.backup, state: 'running' };
  renderStatus();
  try {
    const result = await backup.run();
    state.backup = { state: 'done', name: result.name, last: result.at };
  } catch (err) {
    console.error('Backup failed', err);
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') state.backup = await backup.status();
    else if (err.name === 'NotFoundError') state.backup = { state: 'unset' };
    else state.backup = { state: 'error', message: err.message };
    toast(`Backup failed: ${err.message}`, { bad: true });
  }
  renderStatus();
}

async function chooseBackup() {
  try {
    await backup.chooseFolder();
    await runBackup();
    toast('Backup folder set. It refreshes every time you open the panel.');
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Couldn't use that folder: ${err.message}`, { bad: true });
  }
}

async function allowBackup() {
  try {
    if (await backup.allow()) await runBackup();
    else await backupOnOpen();
  } catch (err) {
    toast(`Couldn't get permission: ${err.message}`, { bad: true });
  }
}

// ---- keyboard, drag-in files, wiring --------------------------------------

document.addEventListener('keydown', (e) => {
  if (state.view !== 'trail') return;
  if (e.target.closest?.('textarea, input, .sheet-panel')) return;
  const id = state.selected;
  if (!id) return;
  const trailId = state.trail.id;
  if (e.key === 'Tab') {
    e.preventDefault();
    nest(id, e.shiftKey ? -1 : 1);
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    store.shift(trailId, id, e.key === 'ArrowUp' ? -1 : 1);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const order = flatten(state.nodes).map((r) => r.node.id);
    const next = order[order.indexOf(id) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) {
      select(next);
      list.querySelector(`[data-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  } else if (e.key === 'Escape') {
    select(null);
  } else if (e.key === 'r') {
    e.preventDefault();
    reply(id);
  } else if (e.key === 'e') {
    e.preventDefault();
    startEdit(id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    state.confirming = id;
    renderNodes();
  }
});

// Images dragged in from Finder or another page.
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file && state.view === 'trail') setPendingImage(file);
});

list.addEventListener('scroll', () => {
  state.pinBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
});

// When the keyboard opens the list shrinks; keep it pinned to the latest entry.
window.visualViewport?.addEventListener('resize', () => {
  if (state.view === 'trail' && state.pinBottom) list.scrollTop = list.scrollHeight;
});

store.onChange((message) => {
  if (message?.type === 'captured') {
    if (state.view === 'trail' && state.trail?.id === message.trailId) refresh({ scroll: 'bottom' });
    else openTrail(message.trailId);
    store.getTrail(message.trailId).then((t) => { if (t) toast(`Added to “${t.title}”`); });
    syncSoon();
    return;
  }
  scheduleRefresh();
  if (message?.type === 'changed' && message.trailId !== null) syncSoon(); // a local change; remote ones carry null
});

sync.onStatus(() => {
  if (sync.status.state !== 'syncing') {
    auth.current().then((s) => { state.account = s; refresh(); });
  } else {
    renderStatus();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const stale = !state.backup.last || Date.now() - state.backup.last > 5 * 60 * 1000;
  if (state.backup.state === 'done' && stale) runBackup();
  runSync();
});
setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60 * 1000);

async function start() {
  navigator.storage?.persist?.();
  renderStatus();
  state.account = await auth.current();
  state.hintsSeen = (await getMeta('hintsSeen')) ?? 0;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('type') === 'recovery' && hash.get('access_token')) return showRecovery(hash);
  const active = await store.getActiveTrail();
  if (active && (await store.getTrail(active))) await openTrail(active);
  else await showTrails();
  backupOnOpen();
  runSync();
}

start();
