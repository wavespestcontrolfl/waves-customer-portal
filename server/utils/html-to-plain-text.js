const { parseFragment } = require('parse5');

const SKIP_TAGS = new Set(['style', 'script', 'head', 'title', 'noscript']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'header', 'footer',
]);
const QUOTE_CLASS_RE = /\b(?:gmail_quote|yahoo_quoted)\b/i;
const SIGNATURE_CLASS_RE = /\bgmail_signature\b/i;

function attrValue(node, name) {
  const attr = (node.attrs || []).find((a) => a.name === name);
  return attr ? String(attr.value || '').trim() : '';
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

function renderAnchor(node) {
  const labelParts = [];
  for (const child of node.childNodes || []) collectText(child, labelParts);
  const label = labelParts.join('').replace(/\s+/g, ' ').trim();
  const href = attrValue(node, 'href');
  if (!href || /^(?:javascript|data):/i.test(href)) return label;
  if (!label || label === href) return href;
  return `${label} (${href})`;
}

function renderChildren(node) {
  const inner = [];
  for (const child of node.childNodes || []) collectText(child, inner);
  return normalizeLines(inner.join(''));
}

function collectText(node, out) {
  if (!node) return;
  if (node.nodeName === '#text') {
    out.push(String(node.value || '').replace(/\u00a0/g, ' '));
    return;
  }
  const tag = String(node.tagName || '').toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (tag === 'br') {
    out.push('\n');
    return;
  }
  if (tag === 'a') {
    out.push(renderAnchor(node));
    return;
  }
  if (isQuoteContainer(node, tag)) {
    const quoted = renderChildren(node);
    if (quoted) {
      out.push(`\n${quoted.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n`);
    }
    return;
  }
  if (isSignatureContainer(node)) {
    const sig = renderChildren(node);
    if (sig) out.push(`\n--\n${sig}\n`);
    return;
  }
  for (const child of node.childNodes || []) collectText(child, out);
  if (BLOCK_TAGS.has(tag)) out.push('\n');
}

function htmlToPlainText(html) {
  const fragment = parseFragment(String(html || ''));
  const parts = [];
  for (const child of fragment.childNodes || []) collectText(child, parts);
  return normalizeLines(parts.join(''));
}

module.exports = { htmlToPlainText };
