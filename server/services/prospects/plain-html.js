'use strict';

/**
 * A web page's markup read the way a browser's HTML tokenizer reads it (the HTML standard, "Tokenization"), for a
 * reader that splits a page from one known source on its tags.
 *
 * plainPage(html, tags) rebuilds the page from its tokens: each tag as "<name>" or "</name>" (the name in lower case,
 * the attributes dropped), the text between tags as it is, and each comment (a bogus one too), doctype, script, style
 * and title as one space. A reader that splits the rebuilt page on its tags reads the tags and the text a browser reads: a ">" inside
 * a quoted attribute value, a "<td>" inside a comment or a script, or a script closed by "</script >" cannot add,
 * end or hide a cell. In the rebuilt page every "<" followed by a letter or "/" starts a tag, and any other "<" is
 * text. It returns null when it cannot rebuild the page that way:
 * - a tag whose name is not in `tags`. A template, a textarea, an svg, a noscript or a select changes how a browser
 *   reads what follows it, so a page holding one is refused, never read another way;
 * - a script that holds "<script": after "<!--" in a script, that makes the script run past its first end tag;
 * - a page that ends inside a tag, a comment, a doctype, a script, a style or the title.
 *
 * htmlText(html) is the text a browser shows for a part of such a page.
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

// Index just past the ">" that ends a tag whose attributes start at `i`, or -1 when the page ends first. Each
// attribute is a name (its first character may be "=", and a quote or a "<" in it is part of it), then optionally
// "=" and a value. A quoted value runs to its closing quote, so a ">" inside it does not end the tag; an unquoted one
// runs to white space or ">". A "/" between attributes reads as white space.
function tagEnd(html, i) {
  let at = i;
  for (;;) {
    at = skip(html, at, isGap);
    if (at >= html.length) return -1;
    if (html[at] === '>') return at + 1;
    at = skip(html, skip(html, at + 1, inAttributeName), isSpace);
    if (html[at] !== '=') continue;
    at = skip(html, at + 1, isSpace);
    const quote = html[at];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, at + 1);
      if (close < 0) return -1;
      at = close + 1;
    } else {
      at = skip(html, at, inUnquotedValue);
    }
  }
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

// Index just past the end tag that closes a script, a style or the title whose content starts at `i`: the first
// "</name" (any case) followed by white space, "/" or ">". -1 when there is none, or when a script holds "<script"
// before it.
function textElementEnd(html, i, name) {
  const close = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi');
  close.lastIndex = i;
  const match = close.exec(html);
  if (!match || (name === 'script' && /<script[\t\n\f\r />]/i.test(html.slice(i, match.index)))) return -1;
  return tagEnd(html, match.index + 2 + name.length);
}

// The tag at `i` ("<" or "</", then a letter): its rebuilt form and the index just past it (for a script, a style or
// the title, past its end tag), or null.
function readTag(html, i, tags) {
  const endTag = html[i + 1] === '/';
  const start = i + (endTag ? 2 : 1);
  const stop = skip(html, start, inTagName);
  const name = html.slice(start, stop);
  const known = /^[A-Za-z]+$/.test(name) ? name.toLowerCase() : null;
  const end = tagEnd(html, stop);
  if (end < 0) return null;
  if (!endTag && TEXT_ELEMENTS.has(known)) {
    const close = textElementEnd(html, end, known);
    return close < 0 ? null : { text: ' ', end: close };
  }
  if (!tags.has(known)) return null;
  return { text: endTag ? `</${known}>` : `<${known}>`, end };
}

// The token at a "<" at `i`: its rebuilt form and the index just past it, or null.
function readToken(html, i, tags) {
  const next = html[i + 1];
  if (isLetter(next) || (next === '/' && isLetter(html[i + 2]))) return readTag(html, i, tags);
  if (html.startsWith('<!--', i)) {
    const end = commentEnd(html, i);
    return end < 0 ? null : { text: ' ', end };
  }
  if (next === '!' || next === '?' || next === '/') {
    // A doctype, a bogus comment ("<?xml …>", "<![CDATA[…]]>", "</ …>") or "</>": each ends at its first ">".
    const close = html.indexOf('>', i + 2);
    return close < 0 ? null : { text: ' ', end: close + 1 };
  }
  return { text: '<', end: i + 1 };
}

function plainPage(html, tags) {
  const page = String(html ?? '');
  let out = '';
  let i = 0;
  for (let at = page.indexOf('<'); at >= 0; at = page.indexOf('<', i)) {
    const token = readToken(page, at, tags);
    if (!token) return null;
    out += page.slice(i, at) + token.text;
    i = token.end;
  }
  return out + page.slice(i);
}

// Text as a browser shows it: tags out, each a space (in a page plainPage rebuilt, "<" then a letter, "/", "!" or "?"
// starts a tag, and any other "<" is text: "Observed < 5 roaches" keeps it), every character reference decoded (named
// or numeric: "&nbsp;", "&#45;", "&#x2D;"), invisible format characters (Unicode Cf: a soft hyphen, a zero-width space)
// taken out as a browser hides them, and NUL characters and runs of white space made one space.
function htmlText(html) {
  return decodeHTML(String(html || '').replace(/<[A-Za-z/!?][^>]*>/g, ' '))
    .replace(/\p{Cf}/gu, '')
    .replaceAll('\0', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { plainPage, htmlText };
