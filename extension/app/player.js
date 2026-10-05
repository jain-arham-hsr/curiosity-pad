// A compact voice-note player: round play/pause, a waveform that fills as it
// plays (and can be scrubbed), and the time. The element exposes a `src`
// property so media hydration can treat it like an <audio>.

import { formatDuration } from './util.js';

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const BARS = 40;

// Peaks are computed once per media and kept for the session.
const peaksCache = new Map();
let audioContext;

// A gentle, static shape for when the audio can't be decoded.
const FALLBACK = Array.from({ length: BARS }, (_, i) => 0.35 + 0.25 * Math.sin(i * 0.9) * Math.sin(i * 0.37));

async function computePeaks(url) {
  if (peaksCache.has(url)) return peaksCache.get(url);
  const promise = (async () => {
    try {
      const buffer = await (await fetch(url)).arrayBuffer();
      audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
      const audio = await audioContext.decodeAudioData(buffer);
      const data = audio.getChannelData(0);
      const chunk = Math.max(1, Math.floor(data.length / BARS));
      const peaks = [];
      for (let b = 0; b < BARS; b++) {
        let sum = 0;
        const start = b * chunk;
        const end = Math.min(data.length, start + chunk);
        for (let i = start; i < end; i++) sum += data[i] * data[i];
        peaks.push(Math.sqrt(sum / Math.max(1, end - start)));
      }
      const max = Math.max(...peaks) || 1;
      return peaks.map((p) => Math.max(0.12, Math.pow(p / max, 0.7)));
    } catch {
      return FALLBACK;
    }
  })();
  peaksCache.set(url, promise);
  return promise;
}

// Decode only once the player is actually on screen.
const visible = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.dispatchEvent(new Event('player:visible')); visible.unobserve(e.target); }
  }, { rootMargin: '200px' })
  : null;

// One <audio> per media id, shared across re-renders: the list is rebuilt on
// every change (including incoming syncs), and a fresh element would stop
// playback and show 0:00 while the detached old one kept playing. The
// element's listeners are registered once and talk to whichever UI is
// currently bound to it.
const audioPool = new Map();
function pooledAudio(key) {
  if (key && audioPool.has(key)) return audioPool.get(key);
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.ui = null;
  audio.addEventListener('play', () => audio.ui?.onPlay());
  audio.addEventListener('pause', () => audio.ui?.onPause());
  audio.addEventListener('ended', () => { audio.currentTime = 0; audio.ui?.paint(); });
  audio.addEventListener('timeupdate', () => audio.ui?.paint());
  audio.addEventListener('loadedmetadata', () => audio.ui?.paint());
  if (key) audioPool.set(key, audio);
  return audio;
}

export function createPlayer({ duration = 0, key = null } = {}) {
  const root = document.createElement('div');
  root.className = 'player';
  const audio = pooledAudio(key);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'play';
  btn.innerHTML = PLAY;
  btn.setAttribute('aria-label', 'Play');
  const wave = document.createElement('div');
  wave.className = 'wave';
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Position');
  // Two identical bar layers: the muted base, and an accent copy on top that
  // is clipped to the played fraction, so progress glides rather than steps.
  const makeLayer = (cls) => {
    const layer = document.createElement('div');
    layer.className = cls;
    const items = Array.from({ length: BARS }, () => {
      const b = document.createElement('i');
      layer.append(b);
      return b;
    });
    wave.append(layer);
    return { layer, items };
  };
  const base = makeLayer('bars');
  const played = makeLayer('bars on');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatDuration(duration);
  root.append(audio, btn, wave, time);

  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration);
  const paint = () => {
    const t = total();
    const frac = t ? Math.max(0, Math.min(1, audio.currentTime / t)) : 0;
    played.layer.style.clipPath = `inset(0 ${((1 - frac) * 100).toFixed(2)}% 0 0)`;
    time.textContent = audio.paused && audio.currentTime === 0
      ? formatDuration(t)
      : `${formatDuration(audio.currentTime)} / ${formatDuration(t)}`;
  };
  const shape = (peaks) => {
    for (const { items } of [base, played]) items.forEach((b, i) => { b.style.height = `${Math.round(4 + peaks[i] * 22)}px`; });
  };
  shape(FALLBACK.map((p) => p * 0.5));
  paint();
  // While playing, repaint every frame; currentTime advances continuously.
  let raf = 0;
  const tick = () => { paint(); if (!audio.paused) raf = requestAnimationFrame(tick); };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (audio.paused) {
      for (const other of document.querySelectorAll('.player audio')) if (other !== audio) other.pause();
      audio.play();
    } else {
      audio.pause();
    }
  });
  const onPlay = () => { btn.innerHTML = PAUSE; btn.setAttribute('aria-label', 'Pause'); root.classList.add('playing'); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
  const onPause = () => { btn.innerHTML = PLAY; btn.setAttribute('aria-label', 'Play'); root.classList.remove('playing'); cancelAnimationFrame(raf); paint(); };
  audio.ui = { onPlay, onPause, paint };
  if (!audio.paused) onPlay(); // re-rendered while playing: carry on

  // Scrub: click or drag across the bars.
  let scrubbing = false;
  const seekTo = (clientX) => {
    const r = wave.getBoundingClientRect();
    const t = total();
    if (t) audio.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * t;
    paint();
  };
  wave.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    scrubbing = true;
    wave.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  });
  wave.addEventListener('pointermove', (e) => { if (scrubbing) seekTo(e.clientX); });
  const stop = () => { scrubbing = false; };
  wave.addEventListener('pointerup', stop);
  wave.addEventListener('pointercancel', stop);
  wave.addEventListener('click', (e) => e.stopPropagation());

  let url = null;
  const load = () => { if (url) computePeaks(url).then(shape); };
  root.addEventListener('player:visible', load, { once: true });
  Object.defineProperty(root, 'src', {
    set(value) {
      url = value;
      if (audio.src !== value) audio.src = value; // re-setting would restart playback
      if (visible) visible.observe(root); else load();
    },
    get() { return audio.src; },
  });
  return root;
}
