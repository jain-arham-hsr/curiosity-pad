// A small Markdown renderer for entries. Builds DOM directly (never innerHTML
// from user text), so it is safe by construction. Supports what notes need:
//
//   # headings            **bold** *italic* ~~strike~~ `code`
//   - / 1. lists          > quotes          [text](url) and bare URLs
//   ```lang fences        $inline math$     $$display math$$
//
// Math is rendered to MathML by Temml when it is loaded (window.temml); with
// it absent, the TeX source is shown in code style.

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const SAFE_HREF = /^(https?:|mailto:)/i;

const el = (tag, cls, ...children) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
};

function math(tex, display) {
  const temml = globalThis.temml;
  if (temml) {
    try {
      const host = el('span', display ? 'math math-display' : 'math');
      host.innerHTML = temml.renderToString(tex, { displayMode: display, throwOnError: true });
      return host;
    } catch { /* fall through to source */ }
  }
  return el('code', 'math-src', display ? `$$${tex}$$` : `$${tex}$`);
}

function link(text, href) {
  const a = el('a', '', text);
  if (SAFE_HREF.test(href)) {
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer';
  }
  return a;
}

// Inline grammar, longest-first: code, math, bold, italic, strike, links, URLs.
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\$([^$\n]+?)\$|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|~~([^~]+?)~~|\[([^\]\n]+?)\]\(([^)\s]+?)\)|(https?:\/\/[^\s<>"')\]]+)/g;

export function renderInline(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] != null) frag.append(el('code', '', m[2]));
    else if (m[3] != null) frag.append(math(m[3], false));
    else if (m[4] != null || m[5] != null) frag.append(el('strong', '', renderInline(m[4] ?? m[5])));
    else if (m[6] != null || m[7] != null) frag.append(el('em', '', renderInline(m[6] ?? m[7])));
    else if (m[8] != null) frag.append(el('s', '', renderInline(m[8])));
    else if (m[9] != null) frag.append(link(m[9], m[10]));
    else if (m[11] != null) frag.append(link(m[11], m[11]));
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function codeBlock(lang, lines) {
  const code = el('code', lang ? `lang-${lang}` : '', lines.join('\n'));
  const pre = el('pre', 'code', code);
  const copy = el('button', 'copy', 'Copy');
  copy.type = 'button';
  copy.title = 'Copy code';
  copy.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code.textContent);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    } catch { copy.textContent = 'Failed'; }
  });
  return el('div', 'codeblock', lang ? el('span', 'lang', lang) : '', copy, pre);
}

// Lines of a paragraph keep their line breaks (notes are not prose).
function paragraph(lines) {
  const p = el('p', '');
  lines.forEach((line, i) => {
    if (i) p.append(el('br'));
    p.append(renderInline(line));
  });
  return p;
}

export function renderMarkdown(text) {
  const root = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { root.append(paragraph(para)); para = []; } };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^```\s*(\w*)\s*$/.exec(line))) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end)
      root.append(codeBlock(m[1], body));
    } else if (/^\$\$\s*$/.test(line) || (/^\$\$.+\$\$\s*$/.test(line))) {
      flush();
      if (/^\$\$.+\$\$\s*$/.test(line)) {
        root.append(el('div', 'math-block', math(line.trim().slice(2, -2), true)));
        i++;
      } else {
        const body = [];
        i++;
        while (i < lines.length && !/^\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        root.append(el('div', 'math-block', math(body.join('\n'), true)));
      }
    } else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      root.append(el(`h${m[1].length + 3}`, 'md-h', renderInline(m[2])));
      i++;
    } else if (/^>\s?/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      const quote = el('blockquote', '');
      quote.append(renderMarkdown(body.join('\n')));
      root.append(quote);
    } else if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      root.append(list(lines, () => i, (n) => { i = n; }));
    } else if (line.trim() === '') {
      flush();
      i++;
    } else {
      para.push(line);
      i++;
    }
  }
  flush();
  return root;
}

// Lists nest by indentation (two spaces or more per level).
function list(lines, getI, setI) {
  const parse = (indent) => {
    const ordered = /^\s*\d+[.)]\s+/.test(lines[getI()]);
    const ul = el(ordered ? 'ol' : 'ul', '');
    while (getI() < lines.length) {
      const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[getI()]);
      if (!m) break;
      const depth = m[1].length;
      if (depth < indent) break;
      if (depth > indent) { ul.lastElementChild?.append(parse(depth)); continue; }
      const li = el('li', '', renderInline(m[3]));
      setI(getI() + 1);
      // continuation lines (indented, not a new bullet) belong to this item
      while (getI() < lines.length && /^\s{2,}\S/.test(lines[getI()]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[getI()])) {
        li.append(el('br'), renderInline(lines[getI()].trim()));
        setI(getI() + 1);
      }
      ul.append(li);
    }
    return ul;
  };
  return parse(/^(\s*)/.exec(lines[getI()])[1].length);
}

// Plain text for previews and search.
export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' [math] ')
    .replace(/[`*_~>#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
