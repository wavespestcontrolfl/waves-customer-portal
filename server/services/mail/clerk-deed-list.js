'use strict';

/**
 * The Manatee County Clerk's public daily list of recorded documents
 * (https://records.manateeclerk.com/OfficialRecords/Search/Day/YYYY-MM-DD): the whole day on one HTML page, no login.
 * This module only reads and parses that page; services/mail/new-home-list.js decides what to keep.
 *
 * The parser FAILS CLOSED. Names from this page may end up on a postcard, so a page that does not look exactly like
 * the one we studied (a bot wall, a redesign, a second results page, a changed column order) throws a
 * ClerkPageError instead of guessing. The caller records the failed day and goes on with the others.
 *
 * From, To and Description are empty for about the first two days after a recording while the Clerk fills them in.
 * Such a row is returned as it is (empty arrays and an empty description); the caller skips it and reads it again
 * on a later run.
 */

const { decodeHTML } = require('entities');

// Same style as manatee-permit-sync.js: a plain browser-like agent with the job's name in it.
const USER_AGENT = 'Mozilla/5.0 (WavesPortal mail-new-home-list)';
const BASE_URL = 'https://records.manateeclerk.com/OfficialRecords/Search/Day';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

const HEADER_NAMES = ['View', 'Instrument', 'From', 'To', 'Type', 'Book', 'Page', 'Consideration', 'Description', 'Date', 'Pages'];
const ALLOWED_TAGS = new Set(['table', 'tr', 'th', 'td', 'a', 'span', 'ol', 'li', 'tbody', 'thead']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

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

// Tags removed, character references decoded (after the tags are gone, so an encoded "<" stays text), spaces collapsed.
function cellText(fragment) {
  return decodeHTML(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function listNames(fragment) {
  const names = [];
  for (const m of fragment.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const name = cellText(m[1]);
    if (name) names.push(name);
  }
  return names;
}

// The table is the only part of the page we read, so it is the only part that must be clean.
function checkTableMarkup(table) {
  if (table.includes('<!--')) throw new ClerkPageError('comment', 'Clerk results table holds an HTML comment');
  for (const m of table.matchAll(/<(\/?)([^\s>/]*)/g)) {
    const name = m[2].toLowerCase();
    if (!/^[a-z][a-z0-9]*$/.test(name) || !ALLOWED_TAGS.has(name)) {
      throw new ClerkPageError('unknown_tag', 'Clerk results table holds an unexpected tag');
    }
  }
  if ((table.match(/<table\b/gi) || []).length !== 1) {
    throw new ClerkPageError('nested_table', 'Clerk results table is nested');
  }
}

function checkHeader(table) {
  const firstData = table.search(/class="[^"]*\bdata-row\b/i);
  const head = firstData === -1 ? table : table.slice(0, firstData);
  const names = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
  const thTotal = (table.match(/<th\b/gi) || []).length; // a header cell hiding in a data row is a changed page too
  if (thTotal !== HEADER_NAMES.length || names.length !== HEADER_NAMES.length || names.some((n, i) => n !== HEADER_NAMES[i])) {
    throw new ClerkPageError('header', 'Clerk results table header changed');
  }
}

function dataRowFragments(table) {
  const trCount = (table.match(/<tr\b/gi) || []).length;
  const rows = [...table.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
  const dataRows = rows.filter((m) => /\bclass="[^"]*\bdata-row\b/i.test(m[1]));
  const dataMarks = (table.match(/<tr\b[^>]*\bclass="[^"]*\bdata-row\b/gi) || []).length;
  if (trCount !== 1 + dataRows.length || rows.length !== trCount || dataMarks !== dataRows.length) {
    throw new ClerkPageError('row_count', 'Clerk results table row count does not add up');
  }
  return dataRows.map((m) => m[2]);
}

function parseConsideration(text) {
  if (text === '') return null;
  if (!/^\$[\d,]+\.\d{2}$/.test(text)) throw new ClerkPageError('consideration', 'Clerk consideration is not a dollar amount');
  return Number(text.slice(1).replaceAll(',', ''));
}

function parseDataRow(fragment, isoDate) {
  const cells = [...fragment.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
  if (cells.length !== HEADER_NAMES.length || (fragment.match(/<td\b/gi) || []).length !== cells.length) {
    throw new ClerkPageError('cell_count', 'Clerk data row does not have 11 cells');
  }
  const instrument = cellText(cells[1]);
  if (!/^\d{9,14}$/.test(instrument)) throw new ClerkPageError('instrument', 'Clerk instrument number is malformed');
  const dateParts = cellText(cells[9]).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!dateParts || `${dateParts[3]}-${dateParts[1]}-${dateParts[2]}` !== isoDate) {
    throw new ClerkPageError('date', 'Clerk row date is not the day asked for');
  }
  return {
    instrument,
    from: listNames(cells[2]),
    to: listNames(cells[3]),
    type: cellText(cells[4]),
    consideration: parseConsideration(cellText(cells[7])),
    description: cellText(cells[8]),
    date: isoDate,
  };
}

// A second page of results would hide rows, so any pagination beyond one page is an error.
function checkPagination(afterTable) {
  const ul = afterTable.match(/<ul\b[^>]*class="[^"]*\bpagination\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (ul && (ul[1].match(/<li\b/gi) || []).length > 1) {
    throw new ClerkPageError('pagination', 'Clerk results run over more than one page');
  }
}

function parseDayList(html, isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DAY.test(isoDate)) throw new ClerkPageError('bad_day', 'parseDayList needs a date as YYYY-MM-DD');
  const page = String(html || '');
  const starts = [...page.matchAll(/<table\b[^>]*\bid="results"/gi)];
  if (starts.length === 0) {
    // A day with no recordings (weekend, holiday) answers with the search form and no table.
    if (page.includes('action="/OfficialRecords/Search/DoSearch"') && !page.includes('class="data-row"')) return { rows: [] };
    throw new ClerkPageError('not_clerk_page', 'Page is not the Clerk day list');
  }
  if (starts.length > 1) throw new ClerkPageError('multiple_tables', 'Clerk page has more than one results table');
  // The first closing tag AFTER the results table starts: a table earlier on the page is not ours to judge.
  const endInTable = page.slice(starts[0].index).search(/<\/table>/i);
  if (endInTable === -1) throw new ClerkPageError('unclosed_table', 'Clerk results table is not closed');
  const closeAt = starts[0].index + endInTable + '</table>'.length;
  const table = page.slice(starts[0].index, closeAt);
  checkTableMarkup(table);
  checkHeader(table);
  const rows = dataRowFragments(table).map((fragment) => parseDataRow(fragment, isoDate));
  checkPagination(page.slice(closeAt));
  return { rows };
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
    if (status === 200) body = await res.text();
  } catch (err) {
    throw new ClerkPageError('fetch_failed', `Clerk day list request failed (${err.name || 'error'})`);
  } finally {
    clearTimeout(timer);
  }
  if (status !== 200) throw new ClerkPageError('http_status', `Clerk day list answered HTTP ${status}`);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ClerkPageError('too_large', 'Clerk day list is over 8 MB');
  return parseDayList(body, isoDate);
}

module.exports = { ClerkPageError, dayListUrl, parseDayList, fetchDayList, HEADER_NAMES, USER_AGENT };
