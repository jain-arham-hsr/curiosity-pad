// Registers the service worker (as a module, so it can share app/store.js)
// and tidies the URL after a share-sheet capture.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch((err) => console.error('SW failed', err));
}

if (location.search.includes('shared=1')) {
  history.replaceState(null, '', location.pathname + location.hash);
}
