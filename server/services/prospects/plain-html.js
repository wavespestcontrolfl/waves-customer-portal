'use strict';

/**
 * A web page's markup read the way a browser's HTML tokenizer reads it (the HTML standard, "Tokenization"), for a
 * reader that splits a page from one known source on its tags.
 *
 * plainPage(html, tags) rebuilds the page from its tokens: each tag as "<name>" or "</name>" (the name in lower case,
 * the attributes dropped); each run of text with its character references decoded, as a browser decodes them, and
 * then "&", "<" and ">" written back as references; and nothing for a comment (a bogus one too), a doctype, a script,
 * a style or the title. So in the rebuilt page every "<" starts a tag, and joining two runs of text cannot make a
 * reference. A reader that splits it on its tags reads the tokens a browser reads: a ">" inside a quoted attribute
 * value, a "<td>" inside a comment or a script, or a script closed by "</script >" cannot add, end or hide a cell. How
 * a browser then builds its tree from the tokens (an end tag it implies, text it moves out of a table) is the
 * reader's to check. plainPage returns null when it cannot rebuild the page that way, or when the page hides content:
 * - a tag whose name (a letter, then letters or digits: h1 too) is not in `tags`;
 * - an element that changes how a browser reads what follows it, or whose content a browser does not show
 *   (REFUSED_ELEMENTS: a template, a textarea, an svg, a select, a closed details), even when `tags` allows it;
 * - a start tag with the hidden attribute or a style attribute that can hide it (display: none, visibility: hidden
 *   or collapse, content-visibility: hidden), or a style sheet with such a declaration in a rule whose selector can
 *   match an element of the page (canMatch). A CSS escape or an import, which can spell or load any style, counts as
 *   one. Other ways a style can hide text (a size, a colour, a position) are not read, and neither is what a script
 *   does when it runs: the source's own styles and scripts must not hide or add what its reader needs;
 * - a script that holds "<script": after "<!--" in a script, that makes the script run past its first end tag;
 * - a page that ends inside a tag, a comment, a doctype, a script, a style or the title.
 *
 * htmlText(html) is the text a browser shows for a part of a page plainPage rebuilt.
 */

const { decodeHTML } = require('entities');

// HTML's white space: tab, line feed, form feed, carriage return (a line feed once a browser reads it) and space.
// JavaScript's \s holds more (a no-break space), which HTML reads as part of a name or a value.
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const inTagName = (c) => !isSpace(c) && c !== '/' && c !== '>';
const inAttributeName = (c) => inTagName(c) && c !== '=';
const inUnquotedValue = (c) => !isSpace(c) && c !== '>';
const isGap = (c) => isSpace(c) || c === '/';
// The index of the first character from `i` on that `keep` refuses, or the page end.
function skip(html, i, keep) {
  let at = i;
  while (at < html.length && keep(html[at])) at += 1;
  return at;
}

// Elements whose content is text up to their own end tag: script and style, and the title. Each is dropped whole.
const TEXT_ELEMENTS = new Set(['script', 'style', 'title']);
// Elements of which a tag gives null, whatever `tags` allows. Some change how a browser reads what follows them: their
// content is text (textarea, xmp, iframe, noembed, noframes, noscript, plaintext), a template's, or another
// language's (svg, math), or read by other rules (select, frameset). The others hold content a browser does not show:
// a closed details (all but its summary), a closed dialog, a datalist, a ruby fallback (rp), and the fallback content
// of audio, canvas, object and video.
const REFUSED_ELEMENTS = new Set(['frameset', 'iframe', 'math', 'noembed', 'noframes', 'noscript', 'plaintext',
  'select', 'svg', 'template', 'textarea', 'xmp',
  'audio', 'canvas', 'datalist', 'details', 'dialog', 'object', 'rp', 'video']);

// The attributes of a tag whose attributes start at `i`, and the index just past the ">" that ends it, or null when
// the page ends first. Each attribute is a name (its first character may be "=", and a quote or a "<" in it is part
// of it), then optionally "=" and a value. A quoted value runs to its closing quote, so a ">" inside it does not end
// the tag; an unquoted one runs to white space or ">". A "/" between attributes reads as white space.
function readAttributes(html, i) {
  const attributes = [];
  let at = i;
  for (;;) {
    at = skip(html, at, isGap);
    if (at >= html.length) return null;
    if (html[at] === '>') return { attributes, end: at + 1 };
    const nameEnd = skip(html, at + 1, inAttributeName);
    const attribute = { name: html.slice(at, nameEnd).toLowerCase(), value: '' };
    attributes.push(attribute);
    at = skip(html, nameEnd, isSpace);
    if (html[at] !== '=') continue;
    at = skip(html, at + 1, isSpace);
    const quote = html[at];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, at + 1);
      if (close < 0) return null;
      attribute.value = html.slice(at + 1, close);
      at = close + 1;
    } else {
      const start = at;
      at = skip(html, at, inUnquotedValue);
      attribute.value = html.slice(start, at);
    }
  }
}

// A style's text read left to right, as CSS reads it: a comment becomes a space and a string is emptied, so neither
// can hide a declaration from a test or add one to it; the "<!--" and "-->" a style sheet may wrap itself in are out.
// A CSS escape ("\6e one" spells "none") can spell any style, so a style that holds a backslash is not read this way:
// it counts as one that can hide.
const CSS_SKIP_RE = /\/\*[\s\S]*?(?:\*\/|$)|"[^"\n\r\f]*"?|'[^'\n\r\f]*'?/g;
const flatCss = (css) => css.replace(CSS_SKIP_RE, (skipped) => (skipped[0] === '/' ? ' ' : '""')).replace(/<!--|-->/g, ' ');
// A declaration that hides its element: display: none, or visibility: hidden or collapse (the test finds
// content-visibility: hidden too).
const HIDING_RE = /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i;
const hidingStyle = (css) => css.includes('\\') || HIDING_RE.test(flatCss(css));
// Whether a start tag's attributes hide its element: hidden (the HTML standard's own), or a style attribute that can
// (hidingStyle), read with its character references decoded.
const hides = (attributes) => attributes.some(({ name, value }) => name === 'hidden'
  || (name === 'style' && hidingStyle(decodeHTML(value))));
// The class and id names of a start tag: ".name" for each class and "#name" for its id, in lower case (a page in
// quirks mode matches them in any case).
const namesOf = (attributes) => attributes.flatMap(({ name, value }) => {
  const text = decodeHTML(value).toLowerCase();
  if (name === 'class') return text.split(/[\t\n\f\r ]+/).filter(Boolean).map((token) => `.${token}`);
  return name === 'id' ? [`#${text}`] : [];
});
// Whether a selector can match an element of a page whose elements have the class and id names `names`. A selector
// (each part between commas) of only type names, classes, ids and combinators matches nothing when it names a class
// or an id no element has. Any other selector (a pseudo-class, an attribute, "*") may match any element.
const canMatch = (selector, names) => selector.split(',').some((part) => !/^[-\w \t\n\r\f.#>+~]*$/.test(part)
  || (part.match(/[.#][-\w]+/g) || []).every((name) => names.has(name.toLowerCase())));
// Whether a style sheet can hide an element of a page whose elements have the class and id names `names`: it holds a
// backslash, or an import (a sheet this cannot read); or it holds a hiding declaration whose rule this cannot tell
// (one with no rule, or one after a nested rule), or whose rule's selector can match an element.
function sheetCanHide(css, names) {
  if (css.includes('\\')) return true;
  const flat = flatCss(css);
  if (/@import/i.test(flat)) return true;
  for (const declaration of flat.matchAll(new RegExp(HIDING_RE, 'gi'))) {
    const open = flat.lastIndexOf('{', declaration.index);
    if (open < 0 || flat.lastIndexOf('}', declaration.index) > open) return true;
    const from = Math.max(flat.lastIndexOf('{', open - 1), flat.lastIndexOf('}', open - 1), flat.lastIndexOf(';', open - 1));
    if (canMatch(flat.slice(from + 1, open), names)) return true;
  }
  return false;
}

// Index just past the comment that starts at `i` ("<!--"), or -1: "<!-->" and "<!--->" end at once, and any other
// comment at its first "-->" or "--!>".
function commentEnd(html, i) {
  if (html[i + 4] === '>') return i + 5;
  if (html[i + 4] === '-' && html[i + 5] === '>') return i + 6;
  const end = /--!?>/g;
  end.lastIndex = i + 4;
  return end.exec(html) ? end.lastIndex : -1;
}

// The end tag that closes a script, a style or the title whose content starts at `i`: the first "</name" (any case)
// followed by white space, "/" or ">". Returns where the content ends and the index just past the end tag, or null
// when there is none, when a script holds "<script" before it, or when the page ends inside the end tag.
function textElementEnd(html, i, name) {
  const close = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi');
  close.lastIndex = i;
  const match = close.exec(html);
  if (!match) return null;
  if (name === 'script' && /<script[\t\n\f\r />]/i.test(html.slice(i, match.index))) return null;
  const read = readAttributes(html, match.index + 2 + name.length);
  return read && { contentEnd: match.index, end: read.end };
}

// The tag at `i` ("<" or "</", then a letter): its rebuilt form and the index just past it (for a script, a style or
// the title, past its end tag), or null. It adds a style sheet's text to page.sheets, and a start tag's class and id
// names to page.names.
function readTag(html, i, page) {
  const endTag = html[i + 1] === '/';
  const start = i + (endTag ? 2 : 1);
  const stop = skip(html, start, inTagName);
  const name = html.slice(start, stop);
  const known = /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name.toLowerCase() : null;
  const read = readAttributes(html, stop);
  if (!read) return null;
  if (!endTag && TEXT_ELEMENTS.has(known)) {
    const close = textElementEnd(html, read.end, known);
    if (close && known === 'style') page.sheets.push(html.slice(read.end, close.contentEnd));
    return close && { text: '', end: close.end };
  }
  // A browser ignores an end tag's attributes.
  if (REFUSED_ELEMENTS.has(known) || !page.tags.has(known) || (!endTag && hides(read.attributes))) return null;
  if (!endTag) namesOf(read.attributes).forEach((named) => page.names.add(named));
  return { text: endTag ? `</${known}>` : `<${known}>`, end: read.end };
}

// The token at a "<" at `i`: its rebuilt form and the index just past it, or null.
function readToken(html, i, page) {
  const next = html[i + 1];
  if (isLetter(next) || (next === '/' && isLetter(html[i + 2]))) return readTag(html, i, page);
  if (html.startsWith('<!--', i)) {
    const end = commentEnd(html, i);
    return end < 0 ? null : { text: '', end };
  }
  if (next === '!' || next === '?' || next === '/') {
    // A doctype, a bogus comment ("<?xml …>", "<![CDATA[…]]>", "</ …>") or "</>": each ends at its first ">".
    const close = html.indexOf('>', i + 2);
    return close < 0 ? null : { text: '', end: close + 1 };
  }
  return { text: '&lt;', end: i + 1 };
}

// A run of text between tokens, its character references decoded as a browser decodes them (a reference never runs
// past a "<"), then "&", "<" and ">" written back as references.
const plainText = (text) => decodeHTML(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plainPage(html, tags) {
  const source = String(html ?? '');
  const page = { tags, sheets: [], names: new Set() };
  let out = '';
  let i = 0;
  for (let at = source.indexOf('<'); at >= 0; at = source.indexOf('<', i)) {
    const token = readToken(source, at, page);
    if (!token) return null;
    out += plainText(source.slice(i, at)) + token.text;
    i = token.end;
  }
  // A style sheet applies to the whole page, so it is judged once every element's names are known.
  if (page.sheets.some((css) => sheetCanHide(css, page.names))) return null;
  return out + plainText(source.slice(i));
}

// Inline formatting tags: a browser shows the text on both sides of one as one run, so "35A-<b>02</b>-8" reads
// "35A-02-8". Any other tag (a cell, a row, a paragraph, a line break, an image) parts the text around it.
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i',
  'kbd', 'mark', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr']);

// Characters a browser draws as nothing that join or shape no glyph: the soft hyphen, the zero-width space, the
// direction marks, embeddings and isolates, the word joiner and the invisible operators, and the byte-order mark.
// The joiners (U+200C, U+200D) are not among them: they shape what a browser shows, such as an emoji sequence.
const INVISIBLE_RE = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// The text a browser shows for a part of a page plainPage rebuilt: an inline tag out with nothing in its place, any
// other tag a space, the references decoded, the INVISIBLE_RE characters taken out (so "Callba&shy;ck" reads
// "Callback"), and NUL characters and runs of white space made one space.
function htmlText(html) {
  return decodeHTML(String(html || '').replace(/<\/?([a-z][a-z0-9]*)>/g, (tag, name) => (INLINE_TAGS.has(name) ? '' : ' ')))
    .replace(INVISIBLE_RE, '')
    .replaceAll('\0', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { plainPage, htmlText };
