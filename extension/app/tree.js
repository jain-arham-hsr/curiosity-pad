// Pure functions over a trail's flat node list. A node's place in the tree is
// just (parentId, pos): siblings are ordered by pos, and a move only ever
// rewrites those two fields. Content is never touched here.

const parentOf = (node) => node.parentId ?? null;

export const byOrder = (a, b) =>
  a.pos - b.pos || a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function childrenOf(nodes, parentId) {
  const key = parentId ?? null;
  return nodes.filter((n) => parentOf(n) === key).sort(byOrder);
}

// Depth-first order, as the trail is displayed. Nodes whose parent is missing,
// or that sit in a cycle, are surfaced as roots rather than silently hidden.
export function flatten(nodes) {
  const kids = new Map();
  for (const n of nodes) {
    const key = parentOf(n);
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(n);
  }
  for (const list of kids.values()) list.sort(byOrder);

  const out = [];
  const seen = new Set();
  const walk = (parentId, depth) => {
    for (const n of kids.get(parentId) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const n of [...nodes].sort(byOrder)) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push({ node: n, depth: 0 });
    walk(n.id, 1);
  }
  return out;
}

// A position strictly between two neighbours (either may be missing).
export function between(before, after) {
  if (before == null && after == null) return 1;
  if (before == null) return after - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

export function endOf(nodes, parentId) {
  return between(childrenOf(nodes, parentId).at(-1)?.pos, null);
}

// True if `id` is `ancestorId` or lies anywhere beneath it.
export function isWithin(nodes, id, ancestorId) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    if (cur.id === ancestorId) return true;
    seen.add(cur.id);
    cur = byId.get(parentOf(cur));
  }
  return false;
}

const find = (nodes, id) => nodes.find((n) => n.id === id);

// Nest under the sibling above, as its last child.
export function indentPlace(nodes, id) {
  const node = find(nodes, id);
  if (!node) return null;
  const siblings = childrenOf(nodes, parentOf(node));
  const i = siblings.findIndex((s) => s.id === id);
  if (i <= 0) return null;
  const newParent = siblings[i - 1];
  return { parentId: newParent.id, pos: endOf(nodes, newParent.id) };
}

// Un-nest: become the sibling directly after the current parent.
export function outdentPlace(nodes, id) {
  const node = find(nodes, id);
  const parent = node && find(nodes, parentOf(node));
  if (!parent) return null;
  const siblings = childrenOf(nodes, parentOf(parent));
  const i = siblings.findIndex((s) => s.id === parent.id);
  return { parentId: parentOf(parent), pos: between(parent.pos, siblings[i + 1]?.pos) };
}

// Swap with the sibling above (dir < 0) or below (dir > 0).
export function shiftPlace(nodes, id, dir) {
  const node = find(nodes, id);
  if (!node) return null;
  const siblings = childrenOf(nodes, parentOf(node));
  const i = siblings.findIndex((s) => s.id === id);
  if (dir < 0) {
    if (i <= 0) return null;
    return { parentId: parentOf(node), pos: between(siblings[i - 2]?.pos, siblings[i - 1].pos) };
  }
  if (i === siblings.length - 1) return null;
  return { parentId: parentOf(node), pos: between(siblings[i + 1].pos, siblings[i + 2]?.pos) };
}

// Drag-and-drop onto `targetId`: land before it, after it, or inside it.
export function dropPlace(nodes, dragId, targetId, zone) {
  const target = find(nodes, targetId);
  if (!target || !find(nodes, dragId) || isWithin(nodes, targetId, dragId)) return null;
  if (zone === 'inside') return { parentId: target.id, pos: endOf(nodes, target.id) };
  const siblings = childrenOf(nodes, parentOf(target)).filter((s) => s.id !== dragId);
  const i = siblings.findIndex((s) => s.id === targetId);
  const pos = zone === 'before'
    ? between(siblings[i - 1]?.pos, target.pos)
    : between(target.pos, siblings[i + 1]?.pos);
  return { parentId: parentOf(target), pos };
}

// Where a deleted node's children go: up one level, in the deleted node's
// slot, keeping their order.
export function promotePlaces(nodes, id) {
  const node = find(nodes, id);
  if (!node) return [];
  const kids = childrenOf(nodes, id);
  if (!kids.length) return [];
  const siblings = childrenOf(nodes, parentOf(node));
  const i = siblings.findIndex((s) => s.id === id);
  const lo = node.pos;
  const hi = siblings[i + 1]?.pos;
  return kids.map((child, j) => ({
    id: child.id,
    parentId: parentOf(node),
    pos: hi == null ? lo + j + 1 : lo + ((hi - lo) * (j + 1)) / (kids.length + 1),
  }));
}
