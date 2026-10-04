import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flatten, between, indentPlace, outdentPlace, shiftPlace, dropPlace, promotePlaces, isWithin,
} from '../extension/app/tree.js';

let clock = 0;
const node = (id, parentId, pos) => ({ id, parentId, pos, created: ++clock });

// Applies a {parentId, pos} placement and returns the display order as "id:depth".
const apply = (nodes, id, place) => nodes.map((n) => (n.id === id ? { ...n, ...place } : n));
const shape = (nodes) => flatten(nodes).map(({ node: n, depth }) => `${n.id}:${depth}`).join(' ');

// a
//   b
//   c
// d
const sample = () => [node('a', null, 1), node('b', 'a', 1), node('c', 'a', 2), node('d', null, 2)];

test('flatten is depth-first with depths', () => {
  assert.equal(shape(sample()), 'a:0 b:1 c:1 d:0');
});

test('flatten surfaces orphans and cycles instead of hiding them', () => {
  const orphan = [node('a', null, 1), node('x', 'missing', 1)];
  assert.equal(shape(orphan), 'a:0 x:0');
  const cycle = [node('p', 'q', 1), node('q', 'p', 1)];
  assert.equal(flatten(cycle).length, 2);
});

test('between', () => {
  assert.equal(between(null, null), 1);
  assert.equal(between(3, null), 4);
  assert.equal(between(null, 3), 2);
  assert.equal(between(1, 2), 1.5);
});

test('indent nests under the sibling above, at the end', () => {
  const nodes = sample();
  assert.equal(indentPlace(nodes, 'a'), null); // first sibling cannot indent
  assert.equal(indentPlace(nodes, 'b'), null);
  assert.equal(shape(apply(nodes, 'c', indentPlace(nodes, 'c'))), 'a:0 b:1 c:2 d:0');
  assert.equal(shape(apply(nodes, 'd', indentPlace(nodes, 'd'))), 'a:0 b:1 c:1 d:1');
});

test('outdent places the node right after its parent', () => {
  const nodes = sample();
  assert.equal(outdentPlace(nodes, 'a'), null);
  assert.equal(shape(apply(nodes, 'b', outdentPlace(nodes, 'b'))), 'a:0 c:1 b:0 d:0');
});

test('shift swaps with neighbours, stopping at the ends', () => {
  const nodes = sample();
  assert.equal(shiftPlace(nodes, 'b', -1), null);
  assert.equal(shiftPlace(nodes, 'c', 1), null);
  assert.equal(shape(apply(nodes, 'c', shiftPlace(nodes, 'c', -1))), 'a:0 c:1 b:1 d:0');
  assert.equal(shape(apply(nodes, 'a', shiftPlace(nodes, 'a', 1))), 'd:0 a:0 b:1 c:1');
});

test('drop before, after and inside', () => {
  const nodes = sample();
  assert.equal(shape(apply(nodes, 'd', dropPlace(nodes, 'd', 'b', 'before'))), 'a:0 d:1 b:1 c:1');
  assert.equal(shape(apply(nodes, 'd', dropPlace(nodes, 'd', 'b', 'after'))), 'a:0 b:1 d:1 c:1');
  assert.equal(shape(apply(nodes, 'd', dropPlace(nodes, 'd', 'b', 'inside'))), 'a:0 b:1 d:2 c:1');
  assert.equal(shape(apply(nodes, 'b', dropPlace(nodes, 'b', 'd', 'after'))), 'a:0 c:1 d:0 b:0');
});

test('drop refuses to put a node inside itself or its descendants', () => {
  const nodes = sample();
  assert.equal(dropPlace(nodes, 'a', 'a', 'inside'), null);
  assert.equal(dropPlace(nodes, 'a', 'b', 'inside'), null);
  assert.equal(isWithin(nodes, 'c', 'a'), true);
  assert.equal(isWithin(nodes, 'd', 'a'), false);
});

test('deleting a node promotes its replies into its slot, in order', () => {
  let nodes = sample();
  for (const m of promotePlaces(nodes, 'a')) nodes = apply(nodes, m.id, m);
  nodes = nodes.filter((n) => n.id !== 'a');
  assert.equal(shape(nodes), 'b:0 c:0 d:0');
});
