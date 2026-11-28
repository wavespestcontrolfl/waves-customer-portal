const { parseFragment } = require('parse5');

const SKIP_TAGS = new Set(['style', 'script', 'head', 'title', 'noscript']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'header', 'footer',
]);
const CELL_TAGS = new Set(['td', 'th']);
const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

function hasAttr(node, name) {
  return (node.attrs || []).some((a) => a.name === name);
}

function attrValue(node, name) {
  const attr = (node.attrs || []).find((a) => a.name === name);
  return attr ? String(attr.value || '').trim() : '';
}

function isHiddenNode(node) {
  return hasAttr(node, 'hidden') || HIDDEN_STYLE_RE.test(attrValue(node, 'style'));
}

function normalizeLines(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function endsWith(out, re) {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]) return re.test(out[i]);
  }
  return true;
}

function pushChildren(stack, node) {
  const children = node.childNodes || [];
  for (let i = children.length - 1; i >= 0; i -= 1) {
    stack.push({ kind: 'node', node: children[i] });
  }
}

function applyExitFrame(frame, out) {
  if (frame.kind === 'block-exit') {
    if (!endsWith(out, /\n$/)) out.push('\n');
    return;
  }
  const inner = out.splice(frame.start).join('');
  if (frame.kind === 'anchor-exit') {
    const label = inner.replace(/\s+/g, ' ').trim();
    const { href } = frame;
    if (!href || /^(?:javascript|data):/i.test(href)) out.push(label);
    else if (!label || label === href) out.push(href);
    else out.push(`${label} (${href})`);
    return;
  }
  const normalized = normalizeLines(inner);
  if (!normalized) return;
  if (frame.kind === 'cell-exit') {
    if (!endsWith(out, /[\s\n]$/)) out.push(' ');
    out.push(normalized);
  }
}

function enterElement(node, stack, out) {
  const tag = String(node.tagName || '').toLowerCase();
  if (SKIP_TAGS.has(tag) || isHiddenNode(node)) return;
  if (tag === 'br') { out.push('\n'); return; }
  if (tag === 'img') {
    const alt = attrValue(node, 'alt');
    if (alt) {
      if (!endsWith(out, /[\s\n]$/)) out.push(' ');
      out.push(alt);
    }
    return;
  }
  if (tag === 'a') {
    stack.push({ kind: 'anchor-exit', href: attrValue(node, 'href'), start: out.length });
    pushChildren(stack, node);
    return;
  }
  if (CELL_TAGS.has(tag)) {
    stack.push({ kind: 'cell-exit', start: out.length });
    pushChildren(stack, node);
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    if (!endsWith(out, /\n$/)) out.push('\n');
    stack.push({ kind: 'block-exit' });
  }
  pushChildren(stack, node);
}

function htmlToPlainText(html) {
  const fragment = parseFragment(String(html || ''));
  const out = [];
  const stack = [];
  pushChildren(stack, fragment);
  while (stack.length) {
    const frame = stack.pop();
    if (frame.kind !== 'node') {
      applyExitFrame(frame, out);
    } else if (frame.node?.nodeName === '#text') {
      out.push(String(frame.node.value || '').replace(/\u00a0/g, ' '));
    } else if (frame.node) {
      enterElement(frame.node, stack, out);
    }
  }
  return normalizeLines(out.join(''));
}

module.exports = { htmlToPlainText };
