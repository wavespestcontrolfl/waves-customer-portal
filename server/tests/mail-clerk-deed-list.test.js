/**
 * The Clerk day-list parser and fetcher (services/mail/clerk-deed-list.js). The parser fails closed: a page that
 * does not look exactly like the one we studied must throw, never become a wrong name on a postcard. Pages are built
 * with a small helper that follows the real markup; every name, number and legal description here is made up.
 */
const { parseDayList, fetchDayList, dayListUrl, ClerkPageError, HEADER_NAMES } = require('../services/mail/clerk-deed-list');

const DAY = '2026-11-18';

function row({
  instrument = '202699000001', from = ['SAMPLE HOMES LLC'], to = ['TESTER ALEX J'], type = 'DEED',
  consideration = '$425,000.00', description = 'LOT 12 SAMPLE GROVE', date = '11-18-2026', cells = null,
} = {}) {
  const ol = (names) => `<ol>${names.map((n) => `<li>${n}</li>`).join('')}</ol>`;
  const tds = cells || [
    '<a class="doc-btn" href="/OfficialRecords/DisplayInstrument/9000001"><span class="sr-only">View</span></a>',
    instrument, ol(from), ol(to), `${type}${' '.repeat(40)}`, '', '', consideration, `\n   ${description}\n  `, date, '1',
  ];
  return `<tr class="data-row">${tds.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

function page({ rows = [row()], pages = 1, headers = HEADER_NAMES, extraInTable = '', tables = 1 } = {}) {
  const table = `<table id="results" class="table table-primary"><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}${extraInTable}</table>`;
  const pager = `<div class="pagination-container"><ul class="pagination">${Array.from({ length: pages }, (_, i) => `<li${i ? '' : ' class="active"'}><a>${i + 1}</a></li>`).join('')}</ul></div>`;
  return `<html><body><div id="data-display">${Array(tables).fill(table).join('')}${pager}</div></body></html>`;
}

const EMPTY_DAY = '<html><body><form action="/OfficialRecords/Search/DoSearch" method="post"><input name="q"></form></body></html>';

const reasonOf = (fn) => {
  try { fn(); } catch (err) { expect(err).toBeInstanceOf(ClerkPageError); return err.reason; }
  throw new Error('expected a ClerkPageError');
};

describe('dayListUrl', () => {
  test('builds the day url and refuses anything but YYYY-MM-DD', () => {
    expect(dayListUrl(DAY)).toBe('https://records.manateeclerk.com/OfficialRecords/Search/Day/2026-11-18');
    for (const bad of ['11-18-2026', '2026-1-8', '', null, '2026-11-18/../x']) expect(() => dayListUrl(bad)).toThrow();
  });
});

describe('parseDayList: pages that read', () => {
  test('a normal day: two buyers, & in a name, padded type, $10.00, empty consideration', () => {
    const html = page({
      rows: [
        row({ from: ['M &amp; J BUILDERS LLC'], to: ['TESTER ALEX J', 'TESTER JORDAN M'], consideration: '$425,000.00' }),
        row({ instrument: '202699000002', consideration: '$10.00', description: 'LOT 36 BLK 48 NORTH RIVER RANCH' }),
        row({ instrument: '202699000003', consideration: '', type: 'MORTGAGE' }),
      ],
    });
    const { rows } = parseDayList(html, DAY);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      instrument: '202699000001', from: ['M & J BUILDERS LLC'], to: ['TESTER ALEX J', 'TESTER JORDAN M'], type: 'DEED',
      consideration: 425000, description: 'LOT 12 SAMPLE GROVE', date: DAY,
    });
    expect(rows[1].consideration).toBe(10);
    expect(rows[1].description).toBe('LOT 36 BLK 48 NORTH RIVER RANCH');
    expect(rows[2].consideration).toBeNull();
    expect(rows[2].type).toBe('MORTGAGE');
  });

  test('a deed the Clerk has not filled in yet comes back with empty arrays and an empty description', () => {
    const html = page({ rows: [row({ from: [], to: [], description: '', consideration: '' })] });
    const [r] = parseDayList(html, DAY).rows;
    expect(r.from).toEqual([]);
    expect(r.to).toEqual([]);
    expect(r.description).toBe('');
  });

  test('a layout table earlier or later on the page is not read and does not hide the results table', () => {
    const layout = '<table class="layout"><tr><td>menu</td></tr></table>';
    const html = page().replace('<div id="data-display">', `${layout}<div id="data-display">`).replace('</body>', `${layout}</body>`);
    expect(parseDayList(html, DAY).rows).toEqual(parseDayList(page(), DAY).rows);
  });

  test('a day with no recordings (the search form) is an empty day', () => {
    expect(parseDayList(EMPTY_DAY, DAY)).toEqual({ rows: [] });
  });
});

describe('parseDayList: pages that must throw', () => {
  test.each([
    ['a bot wall', '<html><body><h1>Just a moment...</h1></body></html>', 'not_clerk_page'],
    ['a search form that also holds data rows', `${EMPTY_DAY}<tr class="data-row"></tr>`, 'not_clerk_page'],
    ['two results tables', page({ tables: 2 }), 'multiple_tables'],
    ['a table that never closes', page().replace('</table>', ''), 'unclosed_table'],
    ['a comment inside the table', page({ extraInTable: '<!-- note -->' }), 'comment'],
    ['a script tag inside the table', page({ extraInTable: '<script>x()</script>' }), 'unknown_tag'],
    ['an input inside the table', page({ extraInTable: '<input name="q">' }), 'unknown_tag'],
    ['a changed header', page({ headers: HEADER_NAMES.map((h) => (h === 'To' ? 'Grantee' : h)) }), 'header'],
    ['a header with a missing column', page({ headers: HEADER_NAMES.slice(0, 10) }), 'header'],
    ['a row with 10 cells', page({ rows: [row({ cells: ['', '202699000001', '', '', 'DEED', '', '', '$10.00', 'LOT 1 X', '11-18-2026'] })] }), 'cell_count'],
    ['a stray row that is not a data row', page({ extraInTable: '<tr><td>x</td></tr>' }), 'row_count'],
    ['a bad instrument number', page({ rows: [row({ instrument: 'ABC123' })] }), 'instrument'],
    ['a date from another day', page({ rows: [row({ date: '11-17-2026' })] }), 'date'],
    ['a malformed consideration', page({ rows: [row({ consideration: '425000' })] }), 'consideration'],
    ['two pagination pages', page({ pages: 2 }), 'pagination'],
  ])('%s', (_label, html, reason) => {
    expect(reasonOf(() => parseDayList(html, DAY))).toBe(reason);
  });

  test('a bad day argument is refused', () => {
    expect(reasonOf(() => parseDayList(page(), 'yesterday'))).toBe('bad_day');
  });
});

describe('fetchDayList', () => {
  const response = (status, body) => ({ status, text: async () => body });

  test('one GET with the headers and the timeout signal, then the parsed rows', async () => {
    const fetchImpl = jest.fn(async () => response(200, page()));
    const { rows } = await fetchDayList(DAY, { fetchImpl });
    expect(rows).toHaveLength(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(dayListUrl(DAY));
    expect(opts.redirect).toBe('follow');
    expect(opts.headers.Accept).toBe('text/html');
    expect(opts.headers['User-Agent']).toMatch(/WavesPortal/);
    expect(opts.signal).toBeDefined();
  });

  test('HTTP 403 throws with the status in the message', async () => {
    const err = await fetchDayList(DAY, { fetchImpl: async () => response(403, 'no') }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.message).toMatch(/403/);
  });

  test('a body over 8 MB throws', async () => {
    const big = 'a'.repeat(8 * 1024 * 1024 + 1);
    const err = await fetchDayList(DAY, { fetchImpl: async () => response(200, big) }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('too_large');
  });

  test('a page the parser refuses throws, and a network error becomes a ClerkPageError', async () => {
    await expect(fetchDayList(DAY, { fetchImpl: async () => response(200, '<html>wall</html>') })).rejects.toBeInstanceOf(ClerkPageError);
    const err = await fetchDayList(DAY, { fetchImpl: async () => { throw new TypeError('socket closed'); } }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('fetch_failed');
  });
});
