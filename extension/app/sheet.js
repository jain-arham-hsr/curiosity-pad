// One menu component for everything: a bottom sheet on touch screens, a small
// popover anchored to a button on desktop. Only one is open at a time.
//
// openSheet({ title?, anchor?, items })
//   items: { label, icon?, danger?, hint?, onSelect, confirm? }   a row
//          { text }                                                 plain text row
//          { divider: true }
//   An item with `confirm: 'Really?'` turns into a confirm row on first tap.

export const coarse = () => matchMedia('(pointer: coarse)').matches;

let current = null;

export function closeSheet() {
  if (!current) return;
  current.remove();
  current = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
}

function el(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children.filter((c) => c != null));
  return node;
}

function row(item) {
  if (item.divider) return el('div', 'sheet-divider');
  if (item.text != null) return el('div', 'sheet-text', item.text);
  const btn = el('button', `sheet-item${item.danger ? ' danger' : ''}`,
    item.icon ? Object.assign(el('span', 'sheet-icon'), { innerHTML: item.icon }) : null,
    el('span', 'sheet-label', item.label),
    item.hint ? el('span', 'sheet-hint', item.hint) : null);
  btn.type = 'button';
  if (item.disabled) btn.disabled = true;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (item.confirm) {
      const confirm = el('div', 'sheet-confirm',
        el('span', 'sheet-confirm-text', item.confirm),
        Object.assign(el('button', 'danger', item.label), { type: 'button', onclick: (ev) => { ev.stopPropagation(); closeSheet(); item.onSelect(); } }),
        Object.assign(el('button', '', 'Cancel'), { type: 'button', onclick: (ev) => { ev.stopPropagation(); confirm.replaceWith(row(item)); } }));
      btn.replaceWith(confirm);
      return;
    }
    closeSheet();
    item.onSelect?.();
  });
  return btn;
}

export function openSheet({ title, anchor, items }) {
  closeSheet();
  const panel = el('div', 'sheet-panel', title ? el('div', 'sheet-title', title) : null, ...items.map(row));
  const backdrop = el('div', `sheet-backdrop${coarse() || !anchor ? ' dim' : ''}`, panel);
  // The touch that opened us (a long-press) still produces a click on release;
  // don't let that click close the sheet.
  const openedAt = Date.now();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && Date.now() - openedAt > 400) closeSheet(); });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.body.append(backdrop);
  current = backdrop;
  document.addEventListener('keydown', onKey);

  if (anchor && !coarse()) {
    // Popover: below the anchor, kept inside the viewport.
    const r = anchor.getBoundingClientRect();
    panel.classList.add('popover');
    const width = panel.offsetWidth;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    let top = r.bottom + 4;
    if (top + panel.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - panel.offsetHeight - 4);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  } else {
    panel.classList.add('bottom');
  }
  panel.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
  return { close: closeSheet };
}
