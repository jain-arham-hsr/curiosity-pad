import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaFileName, trailFolderName, trailToJSON, trailToMarkdown } from '../extension/app/export.js';

const trail = { id: '3f2a9c10-aaaa-bbbb-cccc-000000000000', title: "Why does Kadane's algorithm work?", created: 1, updated: 2 };

const nodes = [
  { id: 'n1', parentId: null, pos: 1, created: 1, kind: 'text', body: 'What is a subarray?\nAs opposed to a subsequence.', caption: '', sync: 'local' },
  { id: 'n2', parentId: 'n1', pos: 1, created: 2, kind: 'image', mediaId: 'm2', mime: 'image/webp', caption: 'Contiguous [slice]', sync: 'local' },
  { id: 'n3', parentId: 'n1', pos: 2, created: 3, kind: 'audio', mediaId: 'm3', mime: 'audio/webm;codecs=opus', duration: 42, caption: '', sync: 'local' },
  { id: 'n4', parentId: null, pos: 2, created: 4, kind: 'text', body: 'Drop a negative prefix.', source: { url: 'https://chatgpt.com/c/abc', title: 'Kadane chat' }, sync: 'local' },
];

test('media file names come from the node id and mime type', () => {
  assert.equal(mediaFileName(nodes[1]), 'n2.webp');
  assert.equal(mediaFileName(nodes[2]), 'n3.webm');
  assert.equal(mediaFileName({ id: 'x', mime: 'application/x-weird' }), 'x.bin');
});

test('trail folders are slug plus short id', () => {
  assert.equal(trailFolderName(trail), 'why-does-kadane-s-algorithm-work--3f2a9c10');
  assert.equal(trailFolderName({ id: '00000000-1', title: '???' }), 'untitled--00000000');
});

test('markdown is an indented outline', () => {
  assert.equal(trailToMarkdown(trail, nodes), [
    "# Why does Kadane's algorithm work?",
    '',
    '- What is a subarray?',
    '  As opposed to a subsequence.',
    '  - ![Contiguous slice](media/n2.webp)',
    '    Contiguous [slice]',
    '  - [Voice note, 0:42](media/n3.webm)',
    '- Drop a negative prefix.',
    '  Source: [Kadane chat](https://chatgpt.com/c/abc)',
    '',
  ].join('\n'));
});

test('json keeps everything except device-local sync state', () => {
  const data = JSON.parse(trailToJSON(trail, nodes));
  assert.equal(data.format, 'curiosity-pad/trail@1');
  assert.deepEqual(data.nodes.map((n) => n.id), ['n1', 'n2', 'n3', 'n4']);
  assert.equal(data.nodes[1].file, 'media/n2.webp');
  assert.ok(data.nodes.every((n) => !('sync' in n)));
});
