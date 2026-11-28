const { parseFragment } = require('parse5');

const SKIP_TAGS = new Set(['style', 'script', 'head', 'title', 'noscript']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'header', 'footer',
]);
const CELL_TAGS = new Set(['td', 'th']);
const QUOTE_CLASS_RE = /(?:gmail_quote|yahoo_quoted)/i;
const SIGNATURE_CLASS_RE = /gmail_signature/i;
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

function isQuoteContainer(node, tag) {
  return tag === 'blockquote' || QUOTE_CLASS_RE.test(attrValue(node, 'class'));
}

function isSignatureContainer(node) {
  return SIGNATURE_CLASS_RE.test(attrValue(node, 'class'));
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

function renderAnchor(node, opts) {
  const labelParts = [];
  for (const child of node.childNodes || []) collectText(child, labelParts, opts);
  const label = labelParts.join('').replace(/\s+/g, ' ').trim();
  const href = attrValue(node, 'href');
  if (!href || /^(?:javascript|data):/i.test(href)) return label;
  if (!label || label === href) return href;
  return `${label} (${href})`;
}

function renderChildren(node, opts) {
  const inner = [];
  for (const child of node.childNodes || []) collectText(child, inner, opts);
  return normalizeLines(inner.join(''));
}

function renderCell(node, out, opts) {
  const cell = renderChildren(node, opts);
  if (!cell) return;
  if (!endsWith(out, /[\s\n]$/)) out.push(' ');
  out.push(cell);
}

function renderQuoteOrSig(node, tag, out, opts) {
  if (isQuoteContainer(node, tag)) {
    if (opts.stripQuotes) return true;
    const quoted = renderChildren(node, opts);
    if (quoted) out.push(`\n${quoted.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n`);
    return true;
  }
  if (isSignatureContainer(node)) {
    if (opts.stripSignatures) return true;
    const sig = renderChildren(node, opts);
    if (sig) out.push(`\n--\n${sig}\n`);
    return true;
  }
  return false;
}

function renderSpecialTag(node, tag, out, opts) {
  if (tag === 'br') { out.push('\n'); return true; }
  if (tag === 'img') {
    const alt = attrValue(node, 'alt');
    if (alt) {
      if (!endsWith(out, /[\s\n]$/)) out.push(' ');
      out.push(alt);
    }
    return true;
  }
  if (tag === 'a') { out.push(renderAnchor(node, opts)); return true; }
  if (CELL_TAGS.has(tag)) { renderCell(node, out, opts); return true; }
  return renderQuoteOrSig(node, tag, out, opts);
}

function collectText(node, out, opts) {
  if (!node) return;
  if (node.nodeName === '#text') {
    out.push(String(node.value || '').replace(/\u00a0/g, ' '));
    return;
  }
  const tag = String(node.tagName || '').toLowerCase();
  if (SKIP_TAGS.has(tag) || isHiddenNode(node)) return;
  if (renderSpecialTag(node, tag, out, opts)) return;
  if (BLOCK_TAGS.has(tag) && !endsWith(out, /\n$/)) out.push('\n');
  for (const child of node.childNodes || []) collectText(child, out, opts);
  if (BLOCK_TAGS.has(tag) && !endsWith(out, /\n$/)) out.push('\n');
}

function htmlToPlainText(html, opts = {}) {
  const fragment = parseFragment(String(html || ''));
  const parts = [];
  for (const child of fragment.childNodes || []) collectText(child, parts, opts);
  return normalizeLines(parts.join(''));
}

module.exports = { htmlToPlainText };
