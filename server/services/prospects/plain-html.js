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
 * reader's to check. plainPage returns null when it cannot rebuild the page that way, or when the page can hide
 * content or reverse its text in one of these ways:
 * - a tag whose name (a letter, then letters or digits: h1 too) is not in `tags`;
 * - a tag of an element that is not plain text in the page's flow (PLAIN_ELEMENTS lists those that are), even when
 *   `tags` allows it: one whose content a browser reads by other rules (a textarea, a template, an svg, a select),
 *   does not show (a details, a media fallback, a meter), shows from its attributes (an input), adds text to (an ol's
 *   numbers, a q's quotation marks) or shows in another direction (a bdo), or one that loads a style sheet (a link);
 * - a start tag with the hidden or popover attribute, a dir other than ltr, a label on an option (which a browser
 *   can show in place of its content), or a style attribute that can hide it or reorder its text (a display,
 *   visibility or content-visibility declaration whose value is none, hidden, collapse, a table column or column
 *   group (whose content a browser does not draw) or a function such as var(); a direction other than ltr; a
 *   unicode-bidi other than normal); or a style sheet (a style element with no type, or of type text/css:
 *   isStyleSheet) with such a declaration in a rule whose selector can match an element of the page (canMatch). A
 *   CSS escape or an import, which can spell or load any style, counts as such a declaration. Of two attributes with
 *   one name, a browser keeps the first, and so does this;
 * - a style that can show what a script, a style or the title holds, whose text this drops (a display other than
 *   none, or an all: SHOWING_RE): in a style attribute of one of them, or in a sheet rule whose selector can match
 *   one of them (canMatchTextElement: a part that can match an element of the page, as canMatch judges it, and
 *   whose last compound is not led by the name of another element; the steps of a @keyframes, "from" and "to",
 *   count, as an animation can run on any element);
 * - a run of text that holds a right-to-left letter (Hebrew, Arabic and the like) or a direction control other than
 *   the left-to-right mark (RIGHT_TO_LEFT_RE). Without them, and without the dir, direction and unicode-bidi above, a
 *   browser shows each line's text in the order it is written;
 * - a script that holds "<script": after "<!--" in a script, that makes the script run past its first end tag;
 * - a page that ends inside a tag, a comment, a doctype, a script, a style or the title.
 *
 * plainPage does not lay the page out. Where a browser shows a box (a float, a position, a table's caption and its
 * head and foot rows, which a browser shows above or below its other rows), how it draws the box and its text (its
 * size, colour, opacity, clip, mask, filter, transform and font, letter case), what a style or the browser adds
 * around a box or puts in place of what it holds (generated content: a list marker, a content property), a display
 * that shows an element plainPage keeps (a span shown as a block), an image's alt text (shown only when the image
 * cannot load) and what a script does when it runs are not read. A reader can rely on the text the page holds and
 * the order in which it is written, not on where or how a browser shows it: the source's own styles, images and
 * scripts must not hide or add what its reader needs. Where this cannot judge a style, it counts it as one that can
 * hide or show: a sheet whatever its media (print only, a screen width), and a selector with a pseudo-class or an
 * attribute as one that can match. So a page can be refused though a browser shows all of it, but it is never read
 * as shown when it can hide or show text in a way listed above.
 *
 * htmlText(html) is the text of a part of a page plainPage rebuilt, as a browser shows it by default: an inline tag
 * (INLINE_TAGS) joins the text on both sides, and any other tag parts it with a space. A browser can part or join
 * words elsewhere (a style that changes a tag's display, such as a span shown as a block; an image it shows as
 * nothing), and it draws some characters this keeps as nothing (a joiner, a variation selector, a tag character: the
 * default-ignorable code points outside INVISIBLE_RE, which shape what a browser shows, such as an emoji). So a
 * reader that must not depend on where words part compares text with its spaces and its default-ignorable code
 * points (\p{Default_Ignorable_Code_Point}) taken out.
 */

const { decodeHTML } = require('entities');
const REFERENCE_NAMES = require('entities/lib/maps/entities.json');
const LEGACY_REFERENCE_NAMES = require('entities/lib/maps/legacy.json');

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
// The elements a browser shows inline by default with nothing of their own between the text on both sides (HTML's
// rendering rules): it shows that text as one run, so "35A-<b>02</b>-8" reads "35A-02-8".
const INLINE_TAGS = new Set(['a', 'abbr', 'acronym', 'b', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i',
  'ins', 'kbd', 'label', 'mark', 'nobr', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt',
  'u', 'var', 'wbr']);
// The elements whose content a browser shows as plain text in the page's flow: the inline ones, and blocks, table
// parts, line breaks and images, each of which parts the text around it. A tag of any other element gives null,
// whatever `tags` allows: its content is read by other rules (textarea, xmp, iframe, noscript, plaintext, template,
// svg, math, select, frameset), is not shown (details, dialog, datalist, rp, the fallback of audio, canvas, meter,
// object, progress and video), comes from its attributes (input) or from the browser (ol's numbers, q's quotation
// marks), or runs in another direction (bdi, bdo); or the element loads a style sheet (link) or another page (meta).
const PLAIN_ELEMENTS = new Set([...INLINE_TAGS, 'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption',
  'center', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'img', 'li', 'main', 'nav', 'option', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);

// The attributes of a tag whose attributes start at `i`, and the index just past the ">" that ends it, or null when
// the page ends first. Each attribute is a name (its first character may be "=", and a quote or a "<" in it is part
// of it), then optionally "=" and a value. A quoted value runs to its closing quote, so a ">" inside it does not end
// the tag; an unquoted one runs to white space or ">". A "/" between attributes reads as white space. An attribute
// whose name an earlier one of the tag has is read past and dropped, as a browser drops it.
function readAttributes(html, i) {
  const attributes = [];
  const names = new Set();
  let at = i;
  for (;;) {
    at = skip(html, at, isGap);
    if (at >= html.length) return null;
    if (html[at] === '>') return { attributes, end: at + 1 };
    const nameEnd = skip(html, at + 1, inAttributeName);
    const attribute = { name: html.slice(at, nameEnd).toLowerCase(), value: '' };
    if (!names.has(attribute.name)) {
      names.add(attribute.name);
      attributes.push(attribute);
    }
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

// A style's text read left to right, as CSS reads it: a comment becomes a space, and a string or an unquoted url()
// (whose "/*" or quote is part of the address) is emptied, so none of them can hide a declaration from a test or add
// one to it; the "<!--" and "-->" a style sheet may wrap itself in are out. A "url(" opens a url() where a token
// starts and the first character after its white space is not a quote. CSS white space is a space, a tab or a line
// break, not a no-break space: "url(&nbsp;'" opens one, which runs to the first ")". A "-->" is the wrapper only
// where a token starts too. After a name character (a NUL reads as one), a "#" or an "@", either one is part of a
// name, a hash or an at-keyword: "#url(" is a hash and a "(", after which a "/*" opens a comment, and ".nav-->" is
// the class "nav--" and a ">". A "<!--" is out wherever it is, as no name holds a "<". A CSS escape ("\6e one"
// spells "none") can spell any style, so a style that holds a backslash is not read this way: it counts as one that
// can hide.
const CSS_SKIP_RE = /\/\*[\s\S]*?(?:\*\/|$)|"[^"\n\r\f]*"?|'[^'\n\r\f]*'?|(?<![-\w#@\x00\u0080-\uffff])url\([ \t\n\r\f]*(?=[^ \t\n\r\f"'])[^)]*(?:\)|$)/gi;
const flatCss = (css) => css.replace(CSS_SKIP_RE, (skipped) => (skipped[0] === '/' ? ' ' : '""')).replace(/<!--/g, ' ')
  .replace(/(?<![-\w#@\x00\u0080-\uffff])-->/g, ' ');
// Whether one declaration (a run of a style's flat text between ";", "{" and "}") can hide its element or reorder its
// text: display, visibility or content-visibility with a value of none, hidden or collapse, a table column or column
// group (a browser does not draw what one holds), or a function (var(), attr()), which can stand for any value;
// direction with any value but ltr; unicode-bidi with any value but normal. A custom property (--display) sets
// nothing by itself. Each run is read once, so no style can make it slow.
const HIDING_RE = /^\s*(?:(?:display|visibility|content-visibility)\s*:[\s\S]*(?:none|hidden|collapse|column|\()|direction\s*:(?!\s*ltr\b)|unicode-bidi\s*:(?!\s*normal\b))/i;
const hidingStyle = (css) => css.includes('\\') || flatCss(css).split(/[;{}]/).some((run) => HIDING_RE.test(run));
// Whether one declaration can show what a script, a style or the title holds (a browser shows none of them by
// default, and plainPage drops their text): a display with any value but none, or an all, which can reset display.
const SHOWING_RE = /^\s*(?:display\s*:(?!\s*none\s*(?:!\s*important\s*)?$)|all\s*:)/i;
const showingStyle = (css) => css.includes('\\') || flatCss(css).split(/[;{}]/).some((run) => SHOWING_RE.test(run));
// An attribute value with its character references decoded as a browser decodes them in an attribute: as in text
// (decodeHTML), except that a named reference without its ";" is kept as written unless it is a whole legacy name
// (one HTML lets go without ";") before anything but "=": "&quotA", "&quot=" and "&notit;" stay, "&quot " does not.
// Each reference kept is written "&amp;" first, so decodeHTML keeps it.
const decodeAttribute = (value) => decodeHTML(value.replace(/&([A-Za-z0-9]+)(?=([;=]?))/g, (reference, name, next) => (
  (next === ';' && Object.hasOwn(REFERENCE_NAMES, name)) || (next === '' && Object.hasOwn(LEGACY_REFERENCE_NAMES, name))
    ? reference : `&amp;${name}`)));
// Whether a start tag of `element` can hide its content or reorder its text: hidden or popover (shown only once a
// script opens it), a dir other than ltr, a label on an option (a browser can show it in place of the content), or a
// style attribute that can (hidingStyle), read with its character references decoded (decodeAttribute).
const hides = (element, attributes) => attributes.some(({ name, value }) => name === 'hidden' || name === 'popover'
  || (name === 'dir' && decodeAttribute(value).toLowerCase() !== 'ltr')
  || (element === 'option' && name === 'label')
  || (name === 'style' && hidingStyle(decodeAttribute(value))));
// Whether a style element is a style sheet a browser can apply: one with no type, or with a type that is empty or
// text/css in any case. Some browsers read only the type's first part ("text/css; charset=utf-8"), so that part, its
// white space aside, decides; any other type ("text/plain") leaves the element inert. A sheet's media (print only, a
// screen width) are not judged: it counts whatever they are.
const isStyleSheet = (attributes) => attributes.every(({ name, value }) => name !== 'type'
  || ['', 'text/css'].includes(decodeAttribute(value).split(';')[0].trim().toLowerCase()));
// The class and id names of a start tag: ".name" for each class and "#name" for its id, in lower case (a page in
// quirks mode matches them in any case).
const namesOf = (attributes) => attributes.flatMap(({ name, value }) => {
  const text = decodeAttribute(value).toLowerCase();
  if (name === 'class') return text.split(/[\t\n\f\r ]+/).filter(Boolean).map((token) => `.${token}`);
  return name === 'id' ? [`#${text}`] : [];
});
// Whether a selector can match an element of a page whose elements have the class and id names `names`. A selector
// (each part between commas) of only type names, classes, ids and combinators matches nothing when it names a class
// or an id no element has. Any other selector (a pseudo-class, an attribute, "*") may match any element.
const canMatch = (selector, names) => selector.split(',').some((part) => !/^[-\w \t\n\r\f.#>+~]*$/.test(part)
  || (part.match(/[.#][-\w]+/g) || []).every((name) => names.has(name.toLowerCase())));
// Whether a selector can match a script, a style or the title of a page whose elements have the class and id names
// `names`: some part (between commas) that can match an element of the page (canMatch, which counts their names
// too) and is an at-rule's prelude (which this cannot tell) or has a last compound selector not led by the name of
// another element, with only classes, ids, pseudo-classes without arguments and attribute tests after it
// ("a.top:link", "input[type=text]"). Only CSS white space or a combinator ends a compound: a no-break space is
// part of a name. "from" and "to" (KEYFRAME_STEPS) name no element here: in a @keyframes they are the first and
// last steps of an animation, which can run on any element, a script too.
const TYPE_LED_RE = /(?:^|[ \t\n\r\f>+~])([A-Za-z][-\w]*)(?:[.#][-\w]+|::?[-\w]+|\[[^\]]*\])*[ \t\n\r\f]*$/;
const KEYFRAME_STEPS = new Set(['from', 'to']);
const canMatchTextElement = (selector, names) => selector.split(',').some((part) => {
  if (!canMatch(part, names)) return false;
  if (part.includes('@')) return true;
  const name = TYPE_LED_RE.exec(part)?.[1].toLowerCase();
  return !name || TEXT_ELEMENTS.has(name) || KEYFRAME_STEPS.has(name);
});
// Whether a style sheet can hide an element of a page whose elements have the class and id names `names`, or show
// what a script, a style or the title holds: it holds a backslash, or an import (a sheet this cannot read); or it
// holds a hiding declaration (HIDING_RE) whose rule this cannot tell (one with no rule, or one after a nested rule)
// or whose rule's selector can match an element (canMatch), or a showing declaration (SHOWING_RE) whose rule this
// cannot tell or whose selector can match a script, a style or the title (canMatchTextElement). The sheet is read
// once, run by run: a "{" opens a block, whose selector (the run before it) is judged once, and a "}" ends one.
function sheetCanHide(css, names) {
  if (css.includes('\\')) return true;
  const flat = flatCss(css);
  if (/@import/i.test(flat)) return true;
  // Whether the block the walk is in can match an element, and a script, a style or the title: true where this
  // cannot tell.
  let matches = true;
  let matchesText = true;
  let before = '';
  for (const [, mark, run] of flat.matchAll(/([;{}]?)([^;{}]*)/g)) {
    if (mark === '{') {
      matches = canMatch(before, names);
      matchesText = canMatchTextElement(before, names);
    } else if (mark === '}') {
      matches = true;
      matchesText = true;
    }
    if ((matches && HIDING_RE.test(run)) || (matchesText && SHOWING_RE.test(run))) return true;
    before = run;
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
// the title, past its end tag), or null. It adds a style sheet's text (isStyleSheet) to page.sheets, and a start
// tag's class and id names to page.names.
function readTag(html, i, page) {
  const endTag = html[i + 1] === '/';
  const start = i + (endTag ? 2 : 1);
  const stop = skip(html, start, inTagName);
  const name = html.slice(start, stop);
  const known = /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name.toLowerCase() : null;
  const read = readAttributes(html, stop);
  if (!read) return null;
  // Every start tag's class and id names count for the style sheets: a script's, a style's and the title's too.
  if (!endTag) namesOf(read.attributes).forEach((named) => page.names.add(named));
  if (!endTag && TEXT_ELEMENTS.has(known)) {
    // A style attribute that can show what the element holds, whose text this drops.
    if (read.attributes.some(({ name, value }) => name === 'style' && showingStyle(decodeAttribute(value)))) return null;
    const close = textElementEnd(html, read.end, known);
    if (close && known === 'style' && isStyleSheet(read.attributes)) page.sheets.push(html.slice(read.end, close.contentEnd));
    return close && { text: '', end: close.end };
  }
  // A browser ignores an end tag's attributes.
  if (!PLAIN_ELEMENTS.has(known) || !page.tags.has(known) || (!endTag && hides(known, read.attributes))) return null;
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

// A right-to-left letter (Hebrew, Arabic and every other such script, with their digits: Unicode's right-to-left
// blocks) or a direction control other than the left-to-right mark. Text that holds one can be shown in another order
// than it is written; text that holds none cannot, on a page with no dir, direction or unicode-bidi (a bdi and a bdo
// are not plain elements).
const RIGHT_TO_LEFT_RE = /[\u0590-\u08ff\u200f\u202a-\u202e\u2066-\u2069\ufb1d-\ufdff\ufe70-\ufefe\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

// A run of text between tokens, its character references decoded as a browser decodes them (a reference never runs
// past a "<"), then "&", "<" and ">" written back as references; or null when it holds a RIGHT_TO_LEFT_RE character.
function plainText(text) {
  const decoded = decodeHTML(text);
  return RIGHT_TO_LEFT_RE.test(decoded) ? null : decoded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plainPage(html, tags) {
  const source = String(html ?? '');
  const page = { tags, sheets: [], names: new Set() };
  let out = '';
  let i = 0;
  for (let at = source.indexOf('<'); at >= 0; at = source.indexOf('<', i)) {
    const token = readToken(source, at, page);
    const text = plainText(source.slice(i, at));
    if (!token || text === null) return null;
    out += text + token.text;
    i = token.end;
  }
  // A style sheet applies to the whole page, so it is judged once every element's names are known.
  if (page.sheets.some((css) => sheetCanHide(css, page.names))) return null;
  const rest = plainText(source.slice(i));
  return rest === null ? null : out + rest;
}

// Characters a browser draws as nothing that join or shape no glyph: the soft hyphen, the zero-width space, the
// left-to-right mark (plainPage refuses the other direction controls), the word joiner and the invisible operators,
// and the byte-order mark. The joiners (U+200C, U+200D) and the other default-ignorable code points (a variation
// selector, a tag character) are not among them: they shape what a browser shows, such as an emoji sequence.
const INVISIBLE_RE = /[\u00ad\u200b\u200e\u2060-\u2064\ufeff]/g;

// The text a browser shows for a part of a page plainPage rebuilt: an inline tag (INLINE_TAGS) out with nothing in
// its place, any other tag (a cell, a row, a paragraph, a line break, an image) a space, the references decoded, the
// INVISIBLE_RE characters and NUL characters taken out (so "Callba&shy;ck" reads "Callback"; a browser drops a NUL
// in text), and runs of white space made one space.
function htmlText(html) {
  return decodeHTML(String(html || '').replace(/<\/?([a-z][a-z0-9]*)>/g, (tag, name) => (INLINE_TAGS.has(name) ? '' : ' ')))
    .replace(INVISIBLE_RE, '')
    .replaceAll('\0', '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { plainPage, htmlText };
