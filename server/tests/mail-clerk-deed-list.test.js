/**
 * The Clerk day-list parser and fetcher (services/mail/clerk-deed-list.js). The parser fails closed: a page whose
 * tree is not exactly the one we studied must throw, never become a wrong name on a postcard. Pages are built with a
 * small helper that follows the real markup (the same elements, classes and nesting); every name, number and legal
 * description here is made up.
 */
const { parseDayList, fetchDayList, dayListUrl, ClerkPageError, HEADER_NAMES } = require('../services/mail/clerk-deed-list');

const DAY = '2026-11-18';

const ol = (names) => `<ol>${names.map((n) => `<li>${n}</li>`).join('')}</ol>`;
const VIEW = '<a class="doc-btn" href="/OfficialRecords/DisplayInstrument/9000001" title="View"><span class="glyphicon glyphicon-file"></span><span class="sr-only">View</span></a>';

// One data row. `cells` replaces the inner markup of all 11 cells; `tds` replaces the whole <td> list.
function row({
  instrument = '202699000001', from = ['SAMPLE HOMES LLC'], to = ['TESTER ALEX J'], type = 'DEED',
  consideration = '$425,000.00', description = 'LOT 12 SAMPLE GROVE', date = '11-18-2026', cells = null, tds = null, attrs = ' class="data-row"',
} = {}) {
  const inner = cells || [VIEW, instrument, ol(from), ol(to), `${type}${' '.repeat(40)}`, '', '', consideration, `\n   ${description}\n  `, date, '1'];
  const open = (i) => ({ 0: '<td class="no-print">', 9: '<td style="white-space:nowrap;">' }[i] || '<td>');
  return `<tr${attrs}>${tds || inner.map((c, i) => `${open(i)}${c}</td>`).join('')}</tr>`;
}

// A row whose To cell holds `toCell` as it is.
const withToCell = (toCell) => row({ cells: [VIEW, '202699000001', ol(['SAMPLE HOMES LLC']), toCell, 'DEED', '', '', '$10.00', 'LOT 1 SAMPLE GROVE', '11-18-2026', '1'] });

const pager = (items = '<li class="active"><a>1</a></li>') => `<div class="pagination-container"><ul class="pagination">${items}</ul></div>`;
const header = (names = HEADER_NAMES) => `<tr>${names.map((h) => `<th>${h}</th>`).join('')}</tr>`;
const SEARCH_FORM = '<a class="sr-only" href="#data-display">Skip to Details</a><form action="/OfficialRecords/Search/DoSearch" class="form-inline" method="post"><input name="q"></form>';

// The real page: html > body > div.mainContainer > div#content > div.day-listing > (search form, then the results
// panel #data-display with a pager above and below the table). Each option replaces one piece of it.
function page({
  rows = [row()], head = header(), table = null, above = pager(), below = pager(), afterPanel = '',
  panel = '<div id="data-display" class="panel panel-primary">', tableOpen = '<table id="results" class="table table-primary">',
} = {}) {
  const results = table ?? `${tableOpen}${head}${rows.join('')}</table>`;
  return '<!DOCTYPE html><html lang="en"><head><title>Official Records</title></head><body><div class="mainContainer">'
    + `<div id="content" class="container-fluid main-content"><div class="day-listing">${SEARCH_FORM}`
    + `${panel}${above}<div class="panel-body table-responsive">${results}</div>${below}</div>${afterPanel}`
    + '</div></div></div></body></html>';
}

const EMPTY_DAY = '<!DOCTYPE html><html lang="en"><head><title>Official Records</title></head><body><div class="mainContainer">'
  + `<div id="content" class="container-fluid main-content"><div class="day-listing">${SEARCH_FORM}</div></div></div></body></html>`;
const inEmptyDay = (extra) => EMPTY_DAY.replace('</div></div></div></body>', `${extra}</div></div></div></body>`);

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

  test('the View cell is not read: a document that cannot be viewed has another icon there', () => {
    const noView = '<span><span class="glyphicon glyphicon-remove danger doc-btn" title="Not viewable"></span><span class="sr-only">No image</span></span>';
    const html = page({ rows: [row({ cells: [noView, '202699000001', ol(['SAMPLE HOMES LLC']), ol(['TESTER ALEX J']), 'DEED', '', '', '$10.00', 'LOT 1 SAMPLE GROVE', '11-18-2026', '1'] })] });
    expect(parseDayList(html, DAY).rows[0].to).toEqual(['TESTER ALEX J']);
  });

  test('a results table inside a comment or a template is not on the page: with the search form alone it is an empty day', () => {
    const hidden = `<table id="results" class="table table-primary">${header()}${row()}</table>`;
    expect(parseDayList(inEmptyDay(`<!-- ${hidden} -->`), DAY)).toEqual({ rows: [] });
    expect(parseDayList(inEmptyDay(`<template>${hidden}</template>`), DAY)).toEqual({ rows: [] });
  });

  test('a day with no recordings (the search form alone) is an empty day', () => {
    expect(parseDayList(EMPTY_DAY, DAY)).toEqual({ rows: [] });
  });
});

describe('parseDayList: pages that must throw', () => {
  test.each([
    ['a bot wall', '<html><body><h1>Just a moment...</h1></body></html>', 'not_clerk_page'],
    ['nothing', '', 'not_clerk_page'],
    ['a search form next to an empty results panel (rows would come later by script)', inEmptyDay('<div id="data-display" class="panel panel-primary"></div>'), 'not_clerk_page'],
    ['a search form with a pager', inEmptyDay(pager()), 'not_clerk_page'],
    ['two search forms', inEmptyDay(SEARCH_FORM), 'not_clerk_page'],
    ['a search form that posts somewhere else', EMPTY_DAY.replace('/OfficialRecords/Search/DoSearch', '/OfficialRecords/Search/Other'), 'not_clerk_page'],

    ['a results page whose table is commented out', page({ table: `<!-- <table id="results" class="table table-primary">${header()}${row()}</table> -->` }), 'not_clerk_page'],
    ['a results page whose table sits in a template', page({ table: `<template><table id="results" class="table table-primary">${header()}${row()}</table></template>` }), 'not_clerk_page'],

    ['a second table anywhere on the page', page({ afterPanel: '<table><tr><td>x</td></tr></table>' }), 'multiple_tables'],
    ['a second results table in single quotes', page({ afterPanel: `<table id='results'>${header()}${row({ instrument: '202699000009' })}</table>` }), 'multiple_tables'],
    ['a results table outside the results panel', page({ panel: '<div id="other" class="panel panel-primary">' }), 'table_place'],
    ['a hidden results panel', page({ panel: '<div id="data-display" class="panel panel-primary" hidden>' }), 'table_place'],
    ['a results panel with a changed class', page({ panel: '<div id="data-display" class="panel panel-primary hide">' }), 'table_place'],
    ['a results table with a style', page({ tableOpen: '<table id="results" class="table table-primary" style="display:none">' }), 'table_place'],
    ['a results table with another id', page({ tableOpen: '<table id="archive" class="table table-primary">' }), 'table_place'],

    ['a comment inside the table', page({ rows: [row(), '<!-- note -->'] }), 'table_shape'],
    ['a script inside the table', page({ rows: [row(), '<script>x()</script>'] }), 'table_shape'],
    ['a header section', page({ table: `<table id="results" class="table table-primary"><thead>${header()}</thead><tbody>${row()}</tbody></table>` }), 'table_shape'],
    ['a table with nothing in it', page({ table: '<table id="results" class="table table-primary"></table>' }), 'table_shape'],
    ['a header and no rows (rows would come later by script)', page({ rows: [] }), 'no_rows'],
    ['a changed header', page({ head: header(HEADER_NAMES.map((h) => (h === 'To' ? 'Grantee' : h))) }), 'header'],
    ['a header with a missing column', page({ head: header(HEADER_NAMES.slice(0, 10)) }), 'header'],
    ['no header row', page({ head: '' }), 'header'],

    ['a row with 10 cells', page({ rows: [row({ tds: '<td class="no-print"></td><td>202699000001</td><td><ol></ol></td><td><ol></ol></td><td>DEED</td><td></td><td></td><td>$10.00</td><td>LOT 1 X</td><td style="white-space:nowrap;">11-18-2026</td>' })] }), 'row_shape'],
    ['a row with 12 cells', page({ rows: [row().replace('</tr>', '<td>x</td></tr>')] }), 'row_shape'],
    ['a row that is not a data row', page({ rows: [row(), row({ instrument: '202699000002', attrs: '' })] }), 'row_shape'],
    ['a hidden row', page({ rows: [row({ attrs: ' class="data-row" hidden' })] }), 'row_shape'],
    ['a row with one more class', page({ rows: [row({ attrs: ' class="data-row deleted"' })] }), 'row_shape'],
    ['a cell that spans two columns', page({ rows: [row().replace('<td>202699000001</td>', '<td colspan="2">202699000001</td>')] }), 'row_shape'],
    ['a comment between two cells', page({ rows: [row().replace('<td>202699000001</td>', '<td>202699000001</td><!-- x -->')] }), 'row_shape'],

    ['a bad instrument number', page({ rows: [row({ instrument: 'ABC123' })] }), 'instrument'],
    ['an instrument number inside a link', page({ rows: [row({ instrument: '<a href="/x">202699000001</a>' })] }), 'cell'],
    ['the same instrument number on two rows', page({ rows: [row(), row({ to: ['TESTER JORDAN M'] })] }), 'duplicate_instrument'],
    ['a date from another day', page({ rows: [row({ date: '11-17-2026' })] }), 'date'],
    ['no document type', page({ rows: [row({ type: '' })] }), 'type'],
    ['a malformed consideration', page({ rows: [row({ consideration: '425000' })] }), 'consideration'],
    ['a description with markup in it', page({ rows: [row({ description: 'LOT 12 <b>SAMPLE</b> GROVE' })] }), 'cell'],

    ['a buyer in a span next to the listed buyer', page({ rows: [withToCell(`${ol(['TESTER ALEX J'])}<span>TESTER JORDAN M</span>`)] }), 'party_cell'],
    ['a buyer in a span and no list', page({ rows: [withToCell('<span>TESTER ALEX J</span>')] }), 'party_cell'],
    ['a buyer as bare text', page({ rows: [withToCell('TESTER ALEX J')] }), 'party_cell'],
    ['a buyer as bare text next to the list', page({ rows: [withToCell(`${ol(['TESTER ALEX J'])} TESTER JORDAN M`)] }), 'party_cell'],
    ['two lists in one cell', page({ rows: [withToCell(ol(['TESTER ALEX J']) + ol(['TESTER JORDAN M']))] }), 'party_cell'],
    ['a list inside a list item', page({ rows: [withToCell(`<ol><li>TESTER ALEX J${ol(['TESTER JORDAN M'])}</li></ol>`)] }), 'party_cell'],
    ['a name inside a link', page({ rows: [withToCell('<ol><li><a href="/x">TESTER ALEX J</a></li></ol>')] }), 'party_cell'],
    ['an empty list item', page({ rows: [withToCell('<ol><li>TESTER ALEX J</li><li> </li></ol>')] }), 'party_cell'],
    ['a comment in the list', page({ rows: [withToCell('<ol><li>TESTER ALEX J</li><!-- <li>TESTER JORDAN M</li> --></ol>')] }), 'party_cell'],
    ['a bullet list in place of the numbered one', page({ rows: [withToCell('<ul><li>TESTER ALEX J</li></ul>')] }), 'party_cell'],

    ['two pagination pages below the table', page({ below: pager('<li class="active"><a>1</a></li><li><a href="?page=2">2</a></li>') }), 'pagination'],
    ['two pagination pages above the table only', page({ above: pager('<li class="active"><a>1</a></li><li><a href="?page=2">2</a></li>') }), 'pagination'],
    ['a pager with only a Next link', page({ below: pager('<li><a href="?page=2">Next</a></li>') }), 'pagination'],
    ['an empty pager', page({ below: pager('') }), 'pagination'],
    ['a pager on page 2', page({ below: pager('<li class="active"><a>2</a></li>') }), 'pagination'],
    ['a pager whose page 1 is a link to follow', page({ below: pager('<li class="active"><a href="?page=1">1</a></li>') }), 'pagination'],
    ['a pager in single quotes with two pages', page({ above: "<ul class='pagination'><li class='active'><a>1</a></li><li><a>2</a></li></ul>" }), 'pagination'],
    ['a pager with one more class', page({ below: '<ul class="pagination pagination-lg"><li class="active"><a>1</a></li></ul>' }), 'pagination'],
    ['no pager at all', page({ above: '', below: '' }), 'pagination'],
  ])('%s', (_label, html, reason) => {
    expect(reasonOf(() => parseDayList(html, DAY))).toBe(reason);
  });

  test('a list item that never closes is read as the browser reads it: two names, not one joined name', () => {
    const html = page({ rows: [withToCell('<ol><li>TESTER ALEX J<li>TESTER JORDAN M</li></ol>')] });
    expect(parseDayList(html, DAY).rows[0].to).toEqual(['TESTER ALEX J', 'TESTER JORDAN M']);
  });

  test('a bad day argument is refused', () => {
    expect(reasonOf(() => parseDayList(page(), 'yesterday'))).toBe('bad_day');
  });
});

describe('fetchDayList', () => {
  const response = (status, body) => ({ status, text: async () => body });
  // A streamed answer, as the real fetch gives it: `chunks` byte arrays, then done. `canceled` counts cancel calls.
  const streamed = (chunks, headers = {}) => {
    const state = { reads: 0, canceled: 0 };
    const res = {
      status: 200,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => { throw new Error('text() must not be used on a streamed answer'); },
      body: {
        getReader: () => ({
          read: async () => {
            const value = chunks[state.reads];
            state.reads += 1;
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          cancel: async () => { state.canceled += 1; },
        }),
      },
    };
    return { res, state };
  };
  // Keeps the request's abort signal so a test can see that a refused answer was let go.
  const capture = (res) => {
    const seen = {};
    const fetchImpl = async (_url, opts) => { seen.signal = opts.signal; return res; };
    return { fetchImpl, seen };
  };

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

  test('HTTP 403 throws with the status in the message, and the unread answer is let go', async () => {
    const { fetchImpl, seen } = capture(response(403, 'no'));
    const err = await fetchDayList(DAY, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('http_status');
    expect(err.message).toMatch(/403/);
    expect(seen.signal.aborted).toBe(true);
  });

  test('a body over 8 MB throws', async () => {
    const big = 'a'.repeat(8 * 1024 * 1024 + 1);
    const err = await fetchDayList(DAY, { fetchImpl: async () => response(200, big) }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('too_large');
  });

  test('a streamed answer is read in pieces and parsed', async () => {
    const bytes = Buffer.from(page());
    const { res } = streamed([bytes.subarray(0, 100), bytes.subarray(100)]);
    expect((await fetchDayList(DAY, { fetchImpl: async () => res })).rows).toHaveLength(1);
  });

  test('a streamed answer stops at the piece that crosses 8 MB: the rest is never read', async () => {
    const piece = new Uint8Array(3 * 1024 * 1024);
    const { res, state } = streamed([piece, piece, piece, piece, piece]);
    const err = await fetchDayList(DAY, { fetchImpl: async () => res }).catch((e) => e);
    expect(err.reason).toBe('too_large');
    expect(state.reads).toBe(3);
    expect(state.canceled).toBe(1);
  });

  test('a declared length over 8 MB is refused before any piece is read, and the answer is let go', async () => {
    const { res, state } = streamed([new Uint8Array(10)], { 'content-length': String(8 * 1024 * 1024 + 1) });
    const { fetchImpl, seen } = capture(res);
    const err = await fetchDayList(DAY, { fetchImpl }).catch((e) => e);
    expect(err.reason).toBe('too_large');
    expect(state.reads).toBe(0);
    expect(seen.signal.aborted).toBe(true);
  });

  test('a page the parser refuses throws, and a network error becomes a ClerkPageError', async () => {
    await expect(fetchDayList(DAY, { fetchImpl: async () => response(200, '<html>wall</html>') })).rejects.toBeInstanceOf(ClerkPageError);
    const err = await fetchDayList(DAY, { fetchImpl: async () => { throw new TypeError('socket closed'); } }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('fetch_failed');
  });
});
