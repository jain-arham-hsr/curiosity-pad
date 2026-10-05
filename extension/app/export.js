// Turns a trail into files a person can read without the app.

import { flatten } from './tree.js';
import { slugify, formatDuration } from './util.js';

const EXTENSIONS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
};

export function mediaFileName(node) {
  const base = (node.mime ?? '').split(';')[0].trim();
  return `${node.id}.${EXTENSIONS[base] ?? 'bin'}`;
}

// The id suffix keeps folder names unique when two trails share a title.
export const trailFolderName = (trail) => `${slugify(trail.title)}--${trail.id.slice(0, 8)}`;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim();

function nodeMarkdown(node) {
  const parts = [];
  if (node.kind === 'text') parts.push(node.body);
  if (node.kind === 'image') parts.push(`![${oneLine(node.caption)}](media/${mediaFileName(node)})`);
  if (node.kind === 'audio') {
    const length = node.duration ? `, ${formatDuration(node.duration)}` : '';
    parts.push(`[Voice note${length}](media/${mediaFileName(node)})`);
  }
  if (node.kind !== 'text' && node.caption) parts.push(node.caption);
  if (node.source?.url) parts.push(`Source: [${oneLine(node.source.title) || node.source.url}](${node.source.url})`);
  return parts.join('\n');
}

export function trailToMarkdown(trail, nodes) {
  const lines = [`# ${trail.title}`, ''];
  if (trail.done) lines.push(`_Completed ${new Date(trail.done).toISOString().slice(0, 10)}_`, '');
  for (const { node, depth } of flatten(nodes)) {
    const pad = '  '.repeat(depth);
    const [first, ...rest] = nodeMarkdown(node).split('\n');
    lines.push(`${pad}- ${first}`);
    for (const line of rest) lines.push(line ? `${pad}  ${line}` : '');
  }
  return `${lines.join('\n')}\n`;
}

// Complete enough to rebuild the trail from the backup folder alone.
export function trailToJSON(trail, nodes) {
  return `${JSON.stringify({
    format: 'curiosity-pad/trail@1',
    trail,
    nodes: flatten(nodes).map(({ node }) => {
      const { sync, ...rest } = node;
      return node.mediaId ? { ...rest, file: `media/${mediaFileName(node)}` } : rest;
    }),
  }, null, 2)}\n`;
}
