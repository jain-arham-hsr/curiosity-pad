// Registers the service worker (as a module, so it can share app/store.js)
// and tidies the URL after a share-sheet capture.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch((err) => console.error('SW failed', err));
  // A new version has taken over: reload right away if the app only just
  // opened, otherwise leave it for the next launch rather than interrupt.
  const openedAt = Date.now();
  const hadController = !!navigator.serviceWorker.controller; // false on the very first install
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && Date.now() - openedAt < 20000) location.reload();
  });
}

if (location.search.includes('shared=1')) {
  history.replaceState(null, '', location.pathname + location.hash);
}

// Pull down at the top of the list to sync (replaces the browser's
// pull-to-refresh, which would reload the whole app).
const list = document.getElementById('list');
const hint = document.createElement('div');
hint.className = 'pull';
list.before(hint);
let startY = null;
let pulled = 0;
const THRESHOLD = 70;
list.addEventListener('touchstart', (e) => {
  startY = list.scrollTop === 0 ? e.touches[0].clientY : null;
  pulled = 0;
}, { passive: true });
list.addEventListener('touchmove', (e) => {
  if (startY == null) return;
  pulled = Math.max(0, e.touches[0].clientY - startY);
  if (pulled > 0 && list.scrollTop === 0) {
    hint.style.height = `${Math.min(pulled / 2, 40)}px`;
    hint.textContent = pulled > THRESHOLD ? 'Release to sync' : 'Pull to sync';
    hint.classList.toggle('ready', pulled > THRESHOLD);
  }
}, { passive: true });
list.addEventListener('touchend', async () => {
  const go = startY != null && pulled > THRESHOLD;
  startY = null;
  hint.style.height = '0';
  hint.classList.remove('ready');
  if (go) (await import('./app/sync.js')).sync();
}, { passive: true });
