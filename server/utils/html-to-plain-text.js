const { parseFragment } = require('parse5');

const SKIP_TAGS = new Set(['style', 'script', 'head', 'title', 'noscript']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'header', 'footer',
]);
const CELL_TAGS = new Set(['td', 'th']);
const QUOTE_CLASS_RE = /(?:gmail_quote|yahoo_quoted)/i;
const QUOTE_ID_RE = /^yahoo_quoted/i;
const SIGNATURE_CLASS_RE = /gmail_signature/i;
const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const ATTRIBUTION_END_RE = /(?:wrote:|from:|original message\s*-{2,}|forwarded message\s*-{2,})\s*$/i;

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
  return tag === 'blockquote'
    || QUOTE_CLASS_RE.test(attrValue(node, 'class'))
    || QUOTE_ID_RE.test(attrValue(node, 'id'));
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

function trimTrailingAttribution(out, patterns) {
  if (!patterns?.length) return;
  const current = out.join('').replace(/[ \t\n]+$/, '');
  const tailStart = Math.max(0, current.lastIndexOf('\n\n'), current.length - 250);
  const tailFlat = current.slice(tailStart).replace(/\n/g, ' ');
  const indices = patterns
    .map((re) => {
      const m = re.exec(tailFlat);
      return m ? m.index : null;
    })
    .filter((i) => i != null);
  if (!indices.length) return;
  const cutAt = tailStart + Math.min(...indices);
  if (!ATTRIBUTION_END_RE.test(current.slice(cutAt).replace(/\n/g, ' '))) return;
  out.length = 0;
  const kept = current.slice(0, cutAt).replace(/[ \t]+$/, '');
  if (kept) out.push(kept, '\n');
}

function renderAnchor(node, opts, state) {
  const labelParts = [];
  for (const child of node.childNodes || []) collectText(child, labelParts, opts, state);
  const label = labelParts.join('').replace(/\s+/g, ' ').trim();
  const href = attrValue(node, 'href');
  if (!href || /^(?:javascript|data):/i.test(href)) return label;
  if (!label || label === href) return href;
  return `${label} (${href})`;
}

function renderChildren(node, opts, state) {
  const inner = [];
  for (const child of node.childNodes || []) collectText(child, inner, opts, state);
  return normalizeLines(inner.join(''));
}

function renderCell(node, out, opts, state) {
  const cell = renderChildren(node, opts, state);
  if (!cell) return;
  if (!endsWith(out, /[\s\n]$/)) out.push(' ');
  out.push(cell);
}

function renderQuoteOrSig(node, tag, out, opts, state) {
  if (isQuoteContainer(node, tag)) {
    state.hasQuoteContainer = true;
    if (opts.stripQuotes) {
      trimTrailingAttribution(out, opts.attributionPatterns);
      return true;
    }
    const quoted = renderChildren(node, opts, state);
    if (quoted) out.push(`\n${quoted.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n`);
    return true;
  }
  if (isSignatureContainer(node)) {
    if (opts.stripSignatures) return true;
    const sig = renderChildren(node, opts, state);
    if (sig) out.push(`\n--\n${sig}\n`);
    return true;
  }
  return false;
}

function renderSpecialTag(node, tag, out, opts, state) {
  if (tag === 'br') { out.push('\n'); return true; }
  if (tag === 'img') {
    const alt = attrValue(node, 'alt');
    if (alt) {
      if (!endsWith(out, /[\s\n]$/)) out.push(' ');
      out.push(alt);
    }
    return true;
  }
  if (tag === 'a') { out.push(renderAnchor(node, opts, state)); return true; }
  if (CELL_TAGS.has(tag)) { renderCell(node, out, opts, state); return true; }
  return renderQuoteOrSig(node, tag, out, opts, state);
}

function collectText(node, out, opts, state) {
  if (!node) return;
  if (node.nodeName === '#text') {
    out.push(String(node.value || '').replace(/\u00a0/g, ' '));
    return;
  }
  const tag = String(node.tagName || '').toLowerCase();
  if (SKIP_TAGS.has(tag) || isHiddenNode(node)) return;
  if (renderSpecialTag(node, tag, out, opts, state)) return;
  if (BLOCK_TAGS.has(tag) && !endsWith(out, /\n$/)) out.push('\n');
  for (const child of node.childNodes || []) collectText(child, out, opts, state);
  if (BLOCK_TAGS.has(tag) && !endsWith(out, /\n$/)) out.push('\n');
}

function htmlToPlainTextWithMeta(html, opts = {}) {
  const fragment = parseFragment(String(html || ''));
  const parts = [];
  const state = { hasQuoteContainer: false };
  for (const child of fragment.childNodes || []) collectText(child, parts, opts, state);
  return { text: normalizeLines(parts.join('')), hasQuoteContainer: state.hasQuoteContainer };
}

function htmlToPlainText(html, opts = {}) {
  return htmlToPlainTextWithMeta(html, opts).text;
}

module.exports = { htmlToPlainText, htmlToPlainTextWithMeta };
