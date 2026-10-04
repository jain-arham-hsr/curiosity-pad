// A compact voice-note player: play/pause, a thin seekable bar, and the time.
// The element exposes a `src` property so media hydration can treat it like
// an <audio>.

import { formatDuration } from './util.js';

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

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
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.append(fill);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatDuration(duration);
  root.append(audio, btn, bar, time);

  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration);
  const paint = () => {
    const t = total();
    fill.style.width = t ? `${(audio.currentTime / t) * 100}%` : '0%';
    time.textContent = audio.paused && audio.currentTime === 0
      ? formatDuration(t)
      : `${formatDuration(audio.currentTime)} / ${formatDuration(t)}`;
  };

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
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = bar.getBoundingClientRect();
    const t = total();
    if (t) audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * t;
    paint();
  });

  Object.defineProperty(root, 'src', { set(url) { audio.src = url; }, get() { return audio.src; } });
  return root;
}
