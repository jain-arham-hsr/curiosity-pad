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

export function createPlayer({ duration = 0 } = {}) {
  const root = document.createElement('div');
  root.className = 'player';
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'play';
  btn.innerHTML = PLAY;
  btn.setAttribute('aria-label', 'Play');
  const wave = document.createElement('div');
  wave.className = 'wave';
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Position');
  const bars = Array.from({ length: BARS }, () => {
    const b = document.createElement('i');
    wave.append(b);
    return b;
  });
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatDuration(duration);
  root.append(audio, btn, wave, time);

  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration);
  const paint = () => {
    const t = total();
    const frac = t ? audio.currentTime / t : 0;
    bars.forEach((b, i) => b.classList.toggle('on', i < Math.round(frac * BARS)));
    time.textContent = audio.paused && audio.currentTime === 0
      ? formatDuration(t)
      : `${formatDuration(audio.currentTime)} / ${formatDuration(t)}`;
  };
  const shape = (peaks) => bars.forEach((b, i) => { b.style.height = `${Math.round(4 + peaks[i] * 22)}px`; });
  shape(FALLBACK.map((p) => p * 0.5));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (audio.paused) {
      for (const other of document.querySelectorAll('.player audio')) if (other !== audio) other.pause();
      audio.play();
    } else {
      audio.pause();
    }
  });
  audio.addEventListener('play', () => { btn.innerHTML = PAUSE; btn.setAttribute('aria-label', 'Pause'); root.classList.add('playing'); });
  audio.addEventListener('pause', () => { btn.innerHTML = PLAY; btn.setAttribute('aria-label', 'Play'); root.classList.remove('playing'); paint(); });
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('loadedmetadata', paint);

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
      audio.src = value;
      if (visible) visible.observe(root); else load();
    },
    get() { return audio.src; },
  });
  return root;
}
