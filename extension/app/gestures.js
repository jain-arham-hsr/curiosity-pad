// Touch gestures on a card: swipe right / left (with the card following the
// finger and a hint label), and long-press. Vertical movement is left to the
// browser: the card has `touch-action: pan-y`, so a vertical pan cancels us.

const DECIDE = 10; // px before we commit to a direction
const FIRE = 60; // px of horizontal travel that triggers the swipe
const HOLD = 450; // ms for a long-press

// After a long-press, the release still fires a click somewhere; eat it.
function swallowNextClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  document.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 500);
}

export function attachGestures(card, { onSwipeRight, onSwipeLeft, onLongPress, hints = {} }) {
  let start = null;
  let axis = null; // 'x' once committed
  let dx = 0;
  let holdTimer = null;
  let hint = null;

  const buzz = () => navigator.vibrate?.(10);

  const reset = (animate) => {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (axis === 'x') {
      card.style.transition = animate ? 'transform 0.15s' : '';
      card.style.transform = '';
      card.classList.remove('swiping');
      hint?.remove();
      hint = null;
    }
    start = null;
    axis = null;
    dx = 0;
  };

  const longPress = () => {
    buzz();
    reset(false);
    swallowNextClick();
    onLongPress?.();
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    if (e.target.closest('a, button, textarea, input, .player')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, at: Date.now() };
    holdTimer = setTimeout(() => { if (start && !axis) longPress(); }, HOLD);
  });

  // Chrome turns a held touch into a context-menu gesture (and cancels the
  // pointer), so that event is the long-press signal when it comes first.
  card.addEventListener('contextmenu', (e) => {
    if (!start || axis) return;
    e.preventDefault();
    longPress();
  });

  card.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (!axis) {
      if (Math.abs(mx) < DECIDE && Math.abs(my) < DECIDE) return;
      if (Math.abs(my) > Math.abs(mx)) { reset(false); return; } // the browser scrolls; we step aside
      axis = 'x';
      clearTimeout(holdTimer);
      card.setPointerCapture(e.pointerId);
      card.classList.add('swiping');
      card.style.transition = '';
      hint = document.createElement('div');
      hint.className = 'swipe-hint';
      card.append(hint);
    }
    dx = mx;
    const armed = Math.abs(dx) >= FIRE;
    const limited = Math.sign(dx) * Math.min(Math.abs(dx), FIRE + (Math.abs(dx) - FIRE) * 0.3);
    card.style.transform = `translateX(${limited}px)`;
    hint.textContent = dx > 0 ? (hints.right ?? 'Nest') : (hints.left ?? 'Un-nest');
    hint.classList.toggle('left', dx < 0);
    if (armed !== hint.classList.contains('armed')) {
      hint.classList.toggle('armed', armed);
      if (armed) buzz();
    }
  });

  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const fire = axis === 'x' && Math.abs(dx) >= FIRE ? (dx > 0 ? onSwipeRight : onSwipeLeft) : null;
    reset(true);
    fire?.();
  };
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', () => reset(true));
}
