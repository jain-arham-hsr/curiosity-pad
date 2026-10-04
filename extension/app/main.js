// The side panel UI. Two views: the list of Question Trails, and one trail.
// Rendering is deliberately simple: on any change, re-read and rebuild the list.

import * as store from './store.js';
import * as backup from './backup.js';
import * as sync from './sync.js';
import { auth } from './supabase.js';
import { compressImage, Recorder } from './media.js';
import { flatten, isWithin } from './tree.js';
import { ago, formatDuration, shortDate, stamp } from './util.js';
import { hasExtension, openMicSetup } from './platform.js';

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
  confirming: null, // a node id, or 'trail'
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
};

const refs = {};
const mediaUrls = new Map();
let noticeTimer;
let recordingTimer;
let refreshTimer;

// Trail markers: how far a node has travelled.
const MARKERS = {
  local: ['○', 'On this device only'],
  relay: ['◐', 'Reached the relay'],
  both: ['●', 'On both devices'],
};

const ICONS = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/></svg>',
};

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

function button(label, onclick, { cls = '', title } = {}) {
  return h('button', {
    class: cls,
    title,
    onclick: (e) => { e.stopPropagation(); onclick(e); },
  }, label);
}

function iconButton(icon, title, onclick, cls = '') {
  return h('button', {
    class: `icon ${cls}`,
    title,
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

function notice(message, kind = 'error') {
  state.notice = message;
  state.noticeKind = kind;
  renderStatus();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { state.notice = ''; renderStatus(); }, 8000);
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
  }
  state.view = 'trail';
  state.trail = trail;
  await store.setActiveTrail(id);
  renderComposer();
  await refresh({ scroll: 'bottom' });
  refs.textarea?.focus();
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
    for (const key of ['selected', 'replyTo', 'editing']) {
      if (state[key] && !ids.has(state[key])) state[key] = null;
    }
    if (state.confirming && state.confirming !== 'trail' && !ids.has(state.confirming)) state.confirming = null;
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
  bar.replaceChildren(h('h1', {}, 'Curiosity Pad'));
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
    list.replaceChildren(h('p', { class: 'empty' },
      'No Question Trails yet. Start one below with the question you are chasing.'), restore, account);
    return;
  }
  list.replaceChildren(...trails.map((t) => h('button', { class: 'trail', onclick: () => openTrail(t.id) },
    h('span', { class: 'trail-title' }, t.title),
    h('span', { class: 'trail-meta' }, `${t.count} ${t.count === 1 ? 'entry' : 'entries'} · ${shortDate(t.updated)}`))), account);
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
  notice('Asked your other device. Open Curiosity Pad there; it will send everything on its next sync.', 'info');
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
  const parts = [iconButton('back', 'All Question Trails', showTrails)];
  if (state.confirming === 'trail') {
    parts.push(
      h('span', { class: 'bar-confirm' }, 'Delete this trail and everything in it?'),
      button('Delete', deleteTrail, { cls: 'danger' }),
      button('Cancel', () => { state.confirming = null; renderTrailBar(); }),
    );
  } else {
    parts.push(
      h('h1', { class: 'title', title: 'Click to rename', onclick: startRename }, trail.title),
      iconButton('trash', 'Delete this trail', () => { state.confirming = 'trail'; renderTrailBar(); }),
    );
  }
  bar.replaceChildren(...parts);
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
  state.confirming = null;
  await store.deleteTrail(id);
  await showTrails();
}

// ---- one trail: nodes -----------------------------------------------------

function renderNodes(scroll) {
  const top = list.scrollTop;
  const rows = flatten(state.nodes);
  if (!rows.length) {
    list.replaceChildren(h('p', { class: 'empty' },
      'Nothing here yet. Write what you want to understand, and add each new question as it comes up.'));
  } else {
    list.replaceChildren(...rows.map(nodeRow));
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
    class: `card${selected ? ' selected' : ''}`,
    tabindex: '0',
    draggable: editing ? 'false' : 'true',
  },
  editing ? editor(node) : content(node),
  meta(node),
  selected && !editing ? actions(node) : null);

  card.addEventListener('click', (e) => {
    if (e.target.closest('a, audio, button, textarea, input')) return;
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
  if (node.kind === 'image') parts.push(h('img', { class: 'media', alt: node.caption || 'Image', dataset: { media: node.mediaId } }));
  if (node.kind === 'audio') parts.push(h('audio', { controls: true, preload: 'metadata', dataset: { media: node.mediaId } }));
  const text = node.kind === 'text' ? node.body : node.caption;
  if (text) {
    const long = text.length > 600 || text.split('\n').length > 10;
    const open = state.expanded.has(node.id);
    parts.push(h('div', { class: `text${long && !open ? ' clamp' : ''}` }, ...linkify(text)));
    if (long) {
      parts.push(button(open ? 'Show less' : 'Show more', () => {
        if (open) state.expanded.delete(node.id); else state.expanded.add(node.id);
        renderNodes();
      }, { cls: 'more' }));
    }
  }
  return h('div', { class: 'content' }, ...parts);
}

function meta(node) {
  const [mark, label] = MARKERS[node.sync] ?? MARKERS.local;
  const flag = node.flag
    ? h('div', { class: 'flag' }, node.flag, ' ', button('OK', () => store.clearFlag(node.trailId, node.id), { cls: 'linkish' }))
    : null;
  return h('div', { class: 'meta-wrap' }, flag, h('div', { class: 'meta' },
    node.source?.url
      ? h('a', { class: 'source', href: node.source.url, target: '_blank', rel: 'noreferrer', title: node.source.title || node.source.url }, hostOf(node.source.url))
      : null,
    node.kind === 'audio' && node.duration ? h('span', {}, formatDuration(node.duration)) : null,
    h('span', { title: new Date(node.created).toLocaleString() }, stamp(node.created)),
    node.edited ? h('span', { class: 'edited', title: `Edited ${new Date(node.edited).toLocaleString()}` }, 'edited') : null,
    h('span', { class: 'marker', title: label, 'aria-label': label }, mark)));
}

function actions(node) {
  if (state.confirming === node.id) {
    const hasReplies = state.nodes.some((n) => n.parentId === node.id);
    return h('div', { class: 'actions confirm' },
      h('span', {}, hasReplies ? 'Delete? Its replies move up a level.' : 'Delete this?'),
      button('Delete', () => removeNode(node.id), { cls: 'danger' }),
      button('Cancel', () => { state.confirming = null; renderNodes(); }));
  }
  return h('div', { class: 'actions' },
    button('Reply', () => reply(node.id), { title: 'Add a follow-up under this (R)' }),
    button('←', () => store.outdent(state.trail.id, node.id), { title: 'Un-nest (Shift+Tab)' }),
    button('→', () => store.indent(state.trail.id, node.id), { title: 'Nest under the one above (Tab)' }),
    button('↑', () => store.shift(state.trail.id, node.id, -1), { title: 'Move up (Alt+↑)', cls: 'touch-only' }),
    button('↓', () => store.shift(state.trail.id, node.id, 1), { title: 'Move down (Alt+↓)', cls: 'touch-only' }),
    button('Edit', () => startEdit(node.id), { title: 'Edit (E)' }),
    button('Delete', () => { state.confirming = node.id; renderNodes(); }, { cls: 'danger', title: 'Delete' }));
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
      h('span', { class: 'hint' }, '⌘↩ to save'),
      button('Cancel', cancel),
      button('Save', save, { cls: 'primary' })));
}

function select(id) {
  state.selected = id;
  state.confirming = null;
  renderNodes();
  if (id) list.querySelector(`[data-id="${id}"] .card`)?.focus({ preventScroll: true });
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

  const area = h('textarea', { rows: '1', placeholder: 'Ask, note, paste…', 'aria-label': 'Message' });
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

  const primary = h('button', { class: 'icon round primary', onclick: () => primaryAction() });
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
    notice(`Couldn't read that image: ${err.message}`);
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
    .catch((err) => notice(`Couldn't add that: ${err.message}`));
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
      notice('Chrome needs one-time microphone access. Allow it in the tab that just opened, then record again.');
      openMicSetup();
    } else {
      notice(`Couldn't start recording: ${err.message}`);
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

// ---- status line: trail markers + backup ----------------------------------

function renderStatus() {
  const left = state.notice ? h('span', { class: state.noticeKind === 'info' ? 'info' : 'notice' }, state.notice) : syncSummary();
  const conflict = state.conflicts.length
    ? h('div', { class: 'conflicts' }, state.conflicts.at(-1),
      state.conflicts.length > 1 ? ` (+${state.conflicts.length - 1} more)` : '', ' ',
      button('OK', async () => { await store.clearConflicts(); refresh(); }, { cls: 'linkish' }))
    : null;
  statusLine.replaceChildren(h('div', { class: 'status-row' }, left, backupControl() ?? ''), conflict ?? '');
}

// The trail markers, totalled: what is still to send (○) and in transit (◐).
function syncSummary() {
  const s = sync.status;
  const { toSend, inTransit } = state.counts;
  const retry = (label = 'Retry') => button(label, runSync, { cls: 'linkish' });
  const totals = [];
  if (toSend) totals.push(`${toSend} ${MARKERS.local[0]} to send`);
  if (inTransit) totals.push(`${inTransit} ${MARKERS.relay[0]} in transit`);
  const summary = totals.length ? totals.join(' · ') : `All ${MARKERS.both[0]}`;

  switch (s.state) {
    case 'signed-out':
      return h('span', { class: 'sync' }, `${toSend ? `${toSend} ${MARKERS.local[0]} on this device` : `${MARKERS.local[0]} On this device only`}. `,
        button('Sign in', showSignIn, { cls: 'linkish' }));
    case 'syncing':
      return h('span', { class: 'sync' }, s.message || 'Syncing…');
    case 'alone':
      return h('span', { class: 'sync', title: 'Nothing is sent until a second device has signed in, so the relay never holds data nobody will collect.' },
        `${toSend ? `${toSend} ${MARKERS.local[0]} waiting` : 'Ready'}. Sign in on your phone to start syncing.`);
    case 'ok':
      return h('span', { class: 'sync', title: `Synced ${ago(s.lastSync)}. Click to sync now.` }, summary, ' ', retry('↻'));
    case 'error':
      return h('span', { class: 'notice', title: s.message },
        s.kind === 'paused' ? 'Relay is paused. Restore it in Supabase. ' : s.kind === 'offline' ? "Can't reach the relay. " : `Sync failed: ${s.message} `,
        retry());
    default:
      return h('span', { class: 'sync' }, summary);
  }
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

function backupControl() {
  const b = state.backup;
  const link = (label, onclick, title) => button(label, onclick, { cls: 'linkish', title });
  switch (b.state) {
    case 'unset': return link('Choose backup folder', chooseBackup, 'Pick a folder on your Mac. Every time you open this panel, your trails are copied there.');
    case 'needs-permission': return link('Allow backup', allowBackup, `Chrome needs your OK to write to "${b.name}" again.`);
    case 'running': return h('span', { class: 'backup' }, 'Backing up…');
    case 'done': return link(`Backed up ${ago(b.last)}`, runBackup, `Folder: ${b.name}. Click to back up now.`);
    case 'error': return link('Backup failed. Retry', runBackup, b.message);
    default: return null;
  }
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
  }
  renderStatus();
}

async function chooseBackup() {
  try {
    await backup.chooseFolder();
    await runBackup();
  } catch (err) {
    if (err.name !== 'AbortError') notice(`Couldn't use that folder: ${err.message}`);
  }
}

async function allowBackup() {
  try {
    if (await backup.allow()) await runBackup();
    else await backupOnOpen();
  } catch (err) {
    notice(`Couldn't get permission: ${err.message}`);
  }
}

// ---- keyboard, drag-in files, wiring --------------------------------------

document.addEventListener('keydown', (e) => {
  if (state.view !== 'trail') return;
  if (e.target.closest?.('textarea, input')) return;
  const id = state.selected;
  if (!id) return;
  const trailId = state.trail.id;
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) store.outdent(trailId, id); else store.indent(trailId, id);
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

store.onChange((message) => {
  if (message?.type === 'captured') {
    if (state.view === 'trail' && state.trail?.id === message.trailId) refresh({ scroll: 'bottom' });
    else openTrail(message.trailId);
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
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('type') === 'recovery' && hash.get('access_token')) return showRecovery(hash);
  const active = await store.getActiveTrail();
  if (active && (await store.getTrail(active))) await openTrail(active);
  else await showTrails();
  backupOnOpen();
  runSync();
}

start();
