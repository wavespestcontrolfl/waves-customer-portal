'use strict';

/**
 * The Manatee County Clerk's public daily list of recorded documents
 * (https://records.manateeclerk.com/OfficialRecords/Search/Day/YYYY-MM-DD): the whole day on one HTML page, no login.
 * This module only reads and parses that page; services/mail/new-home-list.js decides what to keep.
 *
 * The parser FAILS CLOSED. Names from this page may end up on a postcard, so the page is read with a real HTML parser
 * (parse5, the tree a browser builds: a commented-out or templated table is not in it) and the tree must be the one
 * we studied, from <html> down to each name:
 *   - the day's panel in its studied place, holding a heading, then a pager, the one table of the page, and a pager;
 *   - the heading's own words: first and last recording on the day asked for, and "Showing 1 to N of N" where N is
 *     the number of rows read (so a cut-off answer, a second page, or rows that a script adds later cannot pass);
 *   - a header row with the 11 studied names, data rows of the 11 studied cells, parties as one plain list;
 *   - or, for a day with no recordings, the panel that says "Searched For: <the day>" and "We found 0 results".
 * Anything else (a bot wall, a redesign, another page of the site) throws a ClerkPageError instead of guessing. The
 * caller records the failed day and goes on with the others. What is proven is the HTML: no script or style sheet
 * is run.
 *
 * From, To and Description are empty for about the first two days after a recording while the Clerk fills them in.
 * Such a row is returned as it is (empty arrays and an empty description); the caller skips it and reads it again
 * on a later run.
 */

const { parse } = require('parse5');

// Same style as manatee-permit-sync.js: a plain browser-like agent with the job's name in it.
const USER_AGENT = 'Mozilla/5.0 (WavesPortal mail-new-home-list)';
const BASE_URL = 'https://records.manateeclerk.com/OfficialRecords/Search/Day';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// The studied page. Attributes are compared as a whole set, so a `hidden`, a `style` or a changed class is a
// changed page, on the table, on a row, on a cell and on every element the table sits in:
//   html[lang=en] > body > div.mainContainer > div#content > div.day-listing > div#data-display.panel
//     > div.panel-heading                      ("Showing First On: ...", "Showing 1 to N of N")
//     > div.panel-body.table-responsive > [ pager, table#results, pager ]
const HEADER_NAMES = ['View', 'Instrument', 'From', 'To', 'Type', 'Book', 'Page', 'Consideration', 'Description', 'Date', 'Pages'];
const CELL_ATTRS = HEADER_NAMES.map((name) => ({ View: { class: 'no-print' }, Date: { style: 'white-space:nowrap;' } }[name] || {}));
const ROW_ATTRS = { class: 'data-row' };
const TABLE_ATTRS = { id: 'results', class: 'table table-primary' };
const LISTING_CLASS = 'day-listing';
const LISTING_ANCESTORS = [ // from the day listing's parent up to <html>
  ['div', { id: 'content', class: 'container-fluid main-content' }],
  ['div', { class: 'mainContainer' }],
  ['body', {}],
  ['html', { lang: 'en' }],
];
// One pager: <div class="small"><div class="pagination-container"><ul class="pagination"><li class="active"><a>1</a>
const PAGER_PATH = [['div', { class: 'pagination-container' }], ['ul', { class: 'pagination' }], ['li', { class: 'active' }], ['a', {}]];
// The heading of a day with rows, all its text in one line. Dates are M/D/YYYY, times are not read.
const HEADING_PATTERN = /^Searched For: Showing First On: (\d{1,2})\/(\d{1,2})\/(\d{4}) \S+ [AP]M Showing Last On: (\d{1,2})\/(\d{1,2})\/(\d{4}) \S+ [AP]M Showing 1 to (\d+) of (\d+)$/;
const COL = Object.fromEntries(HEADER_NAMES.map((name, i) => [name, i]));

class ClerkPageError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'ClerkPageError';
    this.reason = reason;
  }
}

function dayListUrl(isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DAY.test(isoDate)) {
    throw new Error('dayListUrl needs a date as YYYY-MM-DD');
  }
  return `${BASE_URL}/${isoDate}`;
}

const isElement = (node) => typeof node.tagName === 'string';
const attrOf = (node, name) => node.attrs.find((a) => a.name === name)?.value;
const collapse = (text) => text.replace(/\s+/g, ' ').trim();

function hasAttrs(node, expected) {
  return node.attrs.length === Object.keys(expected).length
    && node.attrs.every((a) => Object.hasOwn(expected, a.name) && expected[a.name] === a.value);
}

const is = (node, tag, attrs) => node.tagName === tag && hasAttrs(node, attrs);

// The elements directly under a node. Anything else there must be blank text: a comment or loose text throws.
function elementChildren(node, reason) {
  const elements = [];
  for (const child of node.childNodes) {
    if (isElement(child)) elements.push(child);
    else if (child.nodeName !== '#text' || child.value.trim() !== '') {
      throw new ClerkPageError(reason, 'Clerk page holds text or a comment where only elements are expected');
    }
  }
  return elements;
}

// The text of a node that may hold text and nothing else, spaces collapsed. (parse5 has decoded &amp; and the like.)
function textOnly(node, reason) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') throw new ClerkPageError(reason, 'Clerk page holds markup where only text is expected');
    text += child.value;
  }
  return collapse(text);
}

// All the text under a node, in page order, as one line.
function allText(node) {
  const pieces = [];
  (function gather(n) {
    for (const child of n.childNodes || []) {
      if (child.nodeName === '#text') pieces.push(child.value);
      else gather(child);
    }
  })(node);
  return collapse(pieces.join(' '));
}

// The one element under a node when it is `tag` with exactly `attrs`; null for any other shape.
function onlyChild(node, tag, attrs, reason) {
  const children = elementChildren(node, reason);
  return children.length === 1 && is(children[0], tag, attrs) ? children[0] : null;
}

// Every table, pager list and day listing of the live tree. A <template>'s content is not part of it.
function collect(node, found) {
  for (const child of node.childNodes || []) {
    if (!isElement(child)) continue;
    if (child.tagName === 'table') found.tables.push(child);
    if (child.tagName === 'ul' && /(^|\s)pagination(\s|$)/.test(attrOf(child, 'class') || '')) found.pagers.push(child);
    if (/(^|\s)day-listing(\s|$)/.test(attrOf(child, 'class') || '')) found.listings.push(child);
    collect(child, found);
  }
  return found;
}

// The one panel of the day listing, when the listing sits where the studied page has it; null for any other page.
function dayPanel(found) {
  const listing = found.listings.length === 1 && is(found.listings[0], 'div', { class: LISTING_CLASS }) ? found.listings[0] : null;
  let node = listing && listing.parentNode;
  const inPlace = Boolean(listing) && LISTING_ANCESTORS.every(([tag, attrs]) => {
    const matches = Boolean(node) && is(node, tag, attrs);
    node = node && node.parentNode;
    return matches;
  });
  if (!inPlace || !node || node.nodeName !== '#document') return null;
  const panels = elementChildren(listing, 'not_clerk_page');
  return panels.length === 1 && panels[0].tagName === 'div' ? panels[0] : null; // its attributes: the two callers
}

// A day with no recordings (weekend, holiday) says so itself:
// <div class="panel panel-primary"><div class="panel-heading"><strong>Searched For:</strong> 2026-11-15</div>
// <div class="panel-body"><p class="lg">We found 0 results<span>. Please consider ...</span></p></div></div>
function isEmptyDayPanel(panel, isoDate) {
  if (!hasAttrs(panel, { class: 'panel panel-primary' })) return false;
  const parts = elementChildren(panel, 'not_clerk_page');
  return parts.length === 2
    && is(parts[0], 'div', { class: 'panel-heading' }) && allText(parts[0]) === `Searched For: ${isoDate}`
    && is(parts[1], 'div', { class: 'panel-body' }) && /^We found 0 results\b/.test(allText(parts[1]));
}

// The heading and the body of the panel of a day with rows; the body is a pager, the table, a pager.
function resultsParts(panel, table) {
  const parts = hasAttrs(panel, { id: 'data-display', class: 'panel panel-primary' }) ? elementChildren(panel, 'table_place') : [];
  const [heading, body] = parts;
  const inBody = parts.length === 2 && is(heading, 'div', { class: 'panel-heading' }) && is(body, 'div', { class: 'panel-body table-responsive' })
    ? elementChildren(body, 'table_place') : [];
  if (inBody.length !== 3 || inBody[1] !== table || !hasAttrs(table, TABLE_ATTRS)) {
    throw new ClerkPageError('table_place', 'Clerk results table is not where the studied page has it');
  }
  return { heading, pagers: [inBody[0], inBody[2]] };
}

// A second page of results would hide rows. Each pager must be exactly "page 1 of one".
function isSinglePagePager(box) {
  let node = is(box, 'div', { class: 'small' }) ? box : null;
  for (const [tag, attrs] of PAGER_PATH) node = node && onlyChild(node, tag, attrs, 'pagination');
  return Boolean(node) && textOnly(node, 'pagination') === '1';
}

// The heading's own account of the page: both recordings on the day asked for, and rows 1 to N of N.
function checkHeading(heading, isoDate, rowCount) {
  const m = allText(heading).match(HEADING_PATTERN);
  const isoOf = (month, day, year) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!m || isoOf(m[1], m[2], m[3]) !== isoDate || isoOf(m[4], m[5], m[6]) !== isoDate) {
    throw new ClerkPageError('heading', 'Clerk results heading is not the studied one for the day asked for');
  }
  if (Number(m[7]) !== rowCount || Number(m[8]) !== rowCount) {
    throw new ClerkPageError('row_total', 'Clerk page does not hold all the rows its heading counts');
  }
}

function checkHeader(tr) {
  const cells = tr.attrs.length === 0 ? elementChildren(tr, 'header') : [];
  const names = cells.map((th) => (th.tagName === 'th' ? textOnly(th, 'header') : null));
  if (names.length !== HEADER_NAMES.length || names.some((name, i) => name !== HEADER_NAMES[i])) {
    throw new ClerkPageError('header', 'Clerk results table header changed');
  }
}

// A From or To cell is one plain list: <ol><li>NAME</li>...</ol>, or an empty <ol></ol> while the Clerk has not
// filled it in. Reading part of any other shape would drop a buyer or join two names.
function partyNames(td) {
  const lists = elementChildren(td, 'party_cell');
  const plainList = lists.length === 1 && lists[0].tagName === 'ol' && lists[0].attrs.length === 0;
  const items = plainList ? elementChildren(lists[0], 'party_cell') : null;
  if (!items || items.some((li) => li.tagName !== 'li' || li.attrs.length !== 0)) {
    throw new ClerkPageError('party_cell', 'Clerk party cell is not one plain list of names');
  }
  return items.map((li) => {
    const name = textOnly(li, 'party_cell');
    if (!name) throw new ClerkPageError('party_cell', 'Clerk party cell holds an empty name');
    return name;
  });
}

function parseConsideration(text) {
  if (text === '') return null;
  // "$425,000.00" or "$425000.00": digits, with commas only as full groups of three.
  if (!/^\$(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/.test(text)) throw new ClerkPageError('consideration', 'Clerk consideration is not a dollar amount');
  return Number(text.slice(1).replaceAll(',', ''));
}

function readDataRow(tr, isoDate) {
  const cells = hasAttrs(tr, ROW_ATTRS) ? elementChildren(tr, 'row_shape') : [];
  if (cells.length !== HEADER_NAMES.length || cells.some((td, i) => td.tagName !== 'td' || !hasAttrs(td, CELL_ATTRS[i]))) {
    throw new ClerkPageError('row_shape', 'Clerk data row is not the 11 studied cells');
  }
  const instrument = textOnly(cells[COL.Instrument], 'cell');
  if (!/^\d{9,14}$/.test(instrument)) throw new ClerkPageError('instrument', 'Clerk instrument number is malformed');
  const dateParts = textOnly(cells[COL.Date], 'cell').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!dateParts || `${dateParts[3]}-${dateParts[1]}-${dateParts[2]}` !== isoDate) {
    throw new ClerkPageError('date', 'Clerk row date is not the day asked for');
  }
  const type = textOnly(cells[COL.Type], 'cell');
  if (!type) throw new ClerkPageError('type', 'Clerk row has no document type');
  return {
    instrument,
    from: partyNames(cells[COL.From]),
    to: partyNames(cells[COL.To]),
    type,
    consideration: parseConsideration(textOnly(cells[COL.Consideration], 'cell')),
    description: textOnly(cells[COL.Description], 'cell'),
    date: isoDate,
  };
}

function readRows(table, isoDate) {
  // The page writes rows straight into the table; the parser wraps them in one <tbody>, as a browser does.
  const sections = elementChildren(table, 'table_shape');
  const body = sections.length === 1 && sections[0].tagName === 'tbody' && sections[0].attrs.length === 0 ? sections[0] : null;
  const trs = body ? elementChildren(body, 'table_shape') : [];
  if (trs.length === 0 || trs.some((tr) => tr.tagName !== 'tr')) {
    throw new ClerkPageError('table_shape', 'Clerk results table is not one plain list of rows');
  }
  const [head, ...dataRows] = trs;
  checkHeader(head);
  // A day with no recordings has no table at all, so a header with no rows is not a page we know.
  if (dataRows.length === 0) throw new ClerkPageError('no_rows', 'Clerk results table has a header and no rows');
  const rows = dataRows.map((tr) => readDataRow(tr, isoDate));
  // The instrument number is a deed's identity for the caller: a repeat would let one row overwrite another.
  if (new Set(rows.map((r) => r.instrument)).size !== rows.length) {
    throw new ClerkPageError('duplicate_instrument', 'Clerk page lists an instrument number twice');
  }
  return rows;
}

function parseDayList(html, isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DAY.test(isoDate)) throw new ClerkPageError('bad_day', 'parseDayList needs a date as YYYY-MM-DD');
  const found = collect(parse(String(html || '')), { tables: [], pagers: [], listings: [] });
  const panel = dayPanel(found);
  if (!panel) throw new ClerkPageError('not_clerk_page', 'Page is not the Clerk day list');
  if (found.tables.length === 0) {
    if (found.pagers.length === 0 && isEmptyDayPanel(panel, isoDate)) return { rows: [] };
    throw new ClerkPageError('not_clerk_page', 'Page is not the Clerk day list');
  }
  // One table on the whole page: a row can only live in a table, so no row is outside the one that is read.
  if (found.tables.length > 1) throw new ClerkPageError('multiple_tables', 'Clerk page has more than one table');
  const { heading, pagers } = resultsParts(panel, found.tables[0]);
  if (found.pagers.length !== pagers.length || !pagers.every(isSinglePagePager)) {
    throw new ClerkPageError('pagination', 'Clerk results run over more than one page, or the pager changed');
  }
  const rows = readRows(found.tables[0], isoDate);
  checkHeading(heading, isoDate, rows.length);
  return { rows };
}

// Reads the body up to the cap, whatever the headers say (same form as bid-desk/charlotte-county.js readCapped).
async function readCapped(res) {
  const tooLarge = () => new ClerkPageError('too_large', 'Clerk day list is over 8 MB');
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const body = await res.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw tooLarge();
  return body;
}

async function fetchDayList(isoDate, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = dayListUrl(isoDate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status;
  let body;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    status = res.status;
    if (status === 200) body = await readCapped(res);
  } catch (err) {
    if (err instanceof ClerkPageError) throw err;
    throw new ClerkPageError('fetch_failed', `Clerk day list request failed (${err.name || 'error'})`);
  } finally {
    clearTimeout(timer);
    // Ends the request when its answer was refused before the body was read to the end (a non-200 status, a
    // declared length over the limit). After a complete read this does nothing.
    controller.abort();
  }
  if (status !== 200) throw new ClerkPageError('http_status', `Clerk day list answered HTTP ${status}`);
  return parseDayList(body, isoDate);
}

module.exports = { ClerkPageError, dayListUrl, parseDayList, fetchDayList, HEADER_NAMES, USER_AGENT };
