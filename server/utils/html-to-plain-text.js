const { parseFragment } = require('parse5');

const SKIP_TAGS = new Set(['style', 'script', 'head', 'title', 'noscript']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'header', 'footer',
]);

function attrValue(node, name) {
  const attr = (node.attrs || []).find((a) => a.name === name);
  return attr ? String(attr.value || '').trim() : '';
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
    const labelParts = [];
    for (const child of node.childNodes || []) collectText(child, labelParts);
    const label = labelParts.join('').replace(/\s+/g, ' ').trim();
    const href = attrValue(node, 'href');
    if (!href || /^(?:javascript|data):/i.test(href)) {
      out.push(label);
    } else if (!label || label === href) {
      out.push(href);
    } else {
      out.push(`${label} (${href})`);
    }
    return;
  }
  for (const child of node.childNodes || []) collectText(child, out);
  if (BLOCK_TAGS.has(tag)) out.push('\n');
}

function htmlToPlainText(html) {
  const fragment = parseFragment(String(html || ''));
  const parts = [];
  for (const child of fragment.childNodes || []) collectText(child, parts);
  return parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { htmlToPlainText };
