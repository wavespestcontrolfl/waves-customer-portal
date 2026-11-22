'use strict';

/**
 * The Manatee County Clerk's public daily list of recorded documents
 * (https://records.manateeclerk.com/OfficialRecords/Search/Day/YYYY-MM-DD): the whole day on one HTML page, no login.
 * This module only reads and parses that page; services/mail/new-home-list.js decides what to keep.
 *
 * The parser FAILS CLOSED. Names from this page may end up on a postcard, so the page is read with a real HTML parser
 * (parse5, the tree a browser builds: a commented-out or templated table is not in it) and the tree must be the one
 * we studied: one results table in its studied place, a header row with the 11 studied names, data rows of the 11
 * studied cells, parties as one plain list, and pagers that say "page 1 of 1". Anything else (a bot wall, a redesign,
 * a second results page, rows loaded later by a script) throws a ClerkPageError instead of guessing. The caller
 * records the failed day and goes on with the others. What is proven is the HTML: no script or style sheet is run.
 *
 * From, To and Description are empty for about the first two days after a recording while the Clerk fills them in.
 * Such a row is returned as it is (empty arrays and an empty description); the caller skips it and reads it again
 * on a later run.
 */

const { parse } = require('parse5');

// Same style as manatee-permit-sync.js: a plain browser-like agent with the job's name in it.
const USER_AGENT = 'Mozilla/5.0 (WavesPortal mail-new-home-list)';
const BASE_URL = 'https://records.manateeclerk.com/OfficialRecords/Search/Day';
const SEARCH_FORM_ACTION = '/OfficialRecords/Search/DoSearch';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// The studied page. Attributes are compared as a whole set, so a `hidden`, a `style` or a changed class is a
// changed page, on the table, on a row, on a cell and on every element the table sits in.
const HEADER_NAMES = ['View', 'Instrument', 'From', 'To', 'Type', 'Book', 'Page', 'Consideration', 'Description', 'Date', 'Pages'];
const CELL_ATTRS = HEADER_NAMES.map((name) => ({ View: { class: 'no-print' }, Date: { style: 'white-space:nowrap;' } }[name] || {}));
const ROW_ATTRS = { class: 'data-row' };
const TABLE_ATTRS = { id: 'results', class: 'table table-primary' };
const TABLE_ANCESTORS = [ // from the table's parent up to <html>
  ['div', { class: 'panel-body table-responsive' }],
  ['div', { id: 'data-display', class: 'panel panel-primary' }],
  ['div', { class: 'day-listing' }],
  ['div', { id: 'content', class: 'container-fluid main-content' }],
  ['div', { class: 'mainContainer' }],
  ['body', {}],
  ['html', { lang: 'en' }],
];
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

function hasAttrs(node, expected) {
  return node.attrs.length === Object.keys(expected).length
    && node.attrs.every((a) => Object.hasOwn(expected, a.name) && expected[a.name] === a.value);
}

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
  return text.replace(/\s+/g, ' ').trim();
}

// Every table, form, pager and #data-display element of the live tree. A <template>'s content is not part of it.
function collect(node, found) {
  for (const child of node.childNodes || []) {
    if (!isElement(child)) continue;
    if (child.tagName === 'table') found.tables.push(child);
    if (child.tagName === 'form') found.forms.push(child);
    if (child.tagName === 'ul' && /(^|\s)pagination(\s|$)/.test(attrOf(child, 'class') || '')) found.pagers.push(child);
    if (attrOf(child, 'id') === 'data-display') found.displays.push(child);
    collect(child, found);
  }
  return found;
}

// A day with no recordings (weekend, holiday) answers with the search form alone: no table, no pager and no results
// panel. (A page that kept the panel and filled it later by script would have the panel, so it is not this page.)
function isEmptyDay(found) {
  return found.pagers.length === 0 && found.displays.length === 0
    && found.forms.length === 1 && attrOf(found.forms[0], 'action') === SEARCH_FORM_ACTION;
}

function checkTablePlace(table) {
  let node = table.parentNode;
  const inPlace = hasAttrs(table, TABLE_ATTRS) && TABLE_ANCESTORS.every(([tag, attrs]) => {
    const matches = Boolean(node) && node.tagName === tag && hasAttrs(node, attrs);
    node = node && node.parentNode;
    return matches;
  });
  if (!inPlace || !node || node.nodeName !== '#document') {
    throw new ClerkPageError('table_place', 'Clerk results table is not where the studied page has it');
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
  if (!/^\$[\d,]+\.\d{2}$/.test(text)) throw new ClerkPageError('consideration', 'Clerk consideration is not a dollar amount');
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
  // A header with no rows is not an empty day (that one has no table): it is a page that gets its rows some other way.
  if (dataRows.length === 0) throw new ClerkPageError('no_rows', 'Clerk results table has a header and no rows');
  const rows = dataRows.map((tr) => readDataRow(tr, isoDate));
  // The instrument number is a deed's identity for the caller: a repeat would let one row overwrite another.
  if (new Set(rows.map((r) => r.instrument)).size !== rows.length) {
    throw new ClerkPageError('duplicate_instrument', 'Clerk page lists an instrument number twice');
  }
  return rows;
}

// A second page of results would hide rows. The real page prints its pager above and below the table, each exactly
// <ul class="pagination"><li class="active"><a>1</a></li></ul>: at least one pager, and every pager that one shape.
function isSinglePagePager(ul) {
  if (!hasAttrs(ul, { class: 'pagination' })) return false;
  const items = elementChildren(ul, 'pagination');
  if (items.length !== 1 || items[0].tagName !== 'li' || !hasAttrs(items[0], { class: 'active' })) return false;
  const links = elementChildren(items[0], 'pagination');
  return links.length === 1 && links[0].tagName === 'a' && links[0].attrs.length === 0 && textOnly(links[0], 'pagination') === '1';
}

function parseDayList(html, isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DAY.test(isoDate)) throw new ClerkPageError('bad_day', 'parseDayList needs a date as YYYY-MM-DD');
  const found = collect(parse(String(html || '')), { tables: [], forms: [], pagers: [], displays: [] });
  if (found.tables.length === 0) {
    if (isEmptyDay(found)) return { rows: [] };
    throw new ClerkPageError('not_clerk_page', 'Page is not the Clerk day list');
  }
  // One table on the whole page: a row can only live in a table, so no row is outside the one that is read.
  if (found.tables.length > 1) throw new ClerkPageError('multiple_tables', 'Clerk page has more than one table');
  checkTablePlace(found.tables[0]);
  const rows = readRows(found.tables[0], isoDate);
  if (found.pagers.length === 0 || !found.pagers.every(isSinglePagePager)) {
    throw new ClerkPageError('pagination', 'Clerk results run over more than one page, or the pager changed');
  }
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
