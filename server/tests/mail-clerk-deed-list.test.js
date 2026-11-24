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

// A row whose To cell (or View cell) holds the given markup as it is.
const withToCell = (toCell) => row({ cells: [VIEW, '202699000001', ol(['SAMPLE HOMES LLC']), toCell, 'DEED', '', '', '$10.00', 'LOT 1 SAMPLE GROVE', '11-18-2026', '1'] });
const withViewCell = (viewCell) => row({ cells: [viewCell, '202699000001', ol(['SAMPLE HOMES LLC']), ol(['TESTER ALEX J']), 'DEED', '', '', '$10.00', 'LOT 1 SAMPLE GROVE', '11-18-2026', '1'] });

const pager = (items = '<li class="active"><a>1</a></li>') => `<div class="small"><div class="pagination-container"><ul class="pagination">${items}</ul></div></div>`;
const TWO_PAGES = '<li class="active"><a>1</a></li><li><a href="?page=2">2</a></li>';
const TH_OPEN = { View: '<th class="no-print">', From: '<th style="width:18em;">', To: '<th style="width:18em;">' };
const header = (names = HEADER_NAMES) => `<tr>${names.map((h, i) => `${TH_OPEN[HEADER_NAMES[i]] || '<th>'}${h}</th>`).join('')}</tr>`;
const heading = ({ first = '11/18/2026', last = '11/18/2026', to = 1, of = to } = {}) => '<div class="panel-heading"><div class="row">'
  + '<div id="searchedfor" class="col-md-3"><strong>Searched For:</strong></div>'
  + `<div class="col-md-3"><strong>Showing First On:</strong> ${first} 8:34:52 AM</div>`
  + `<div class="col-md-3"><strong>Showing Last On:</strong> ${last} 4:30:43 PM</div>`
  + `<div class="col-md-3">Showing 1 to ${to} of ${of}</div></div></div>`;

const TOP = '<!DOCTYPE html><html lang="en"><head><title>Official Records</title></head><body><div class="mainContainer">'
  + '<div id="content" class="container-fluid main-content"><div class="row"><a class="sr-only" href="#data-display">Skip to Details</a>'
  + '<form action="/OfficialRecords/Search/DoSearch" class="form-inline" method="post"><input name="q"></form></div>';
const END = '</div></div></body>\r\n</html>\r\n';

// The real page of a day with rows: div#content > div.day-listing > the panel #data-display, which holds the heading
// and then a pager, the table, a pager. Each option replaces one piece. The heading counts `rows` unless told.
function page({
  rows = [row()], head = header(), table = null, above = pager(), below = pager(), afterListing = '', listing = '<div class="day-listing">',
  panel = '<div id="data-display" class="panel panel-primary">', tableOpen = '<table id="results" class="table table-primary">',
  top = heading({ to: rows.length }),
} = {}) {
  const results = table ?? `${tableOpen}${head}${rows.join('')}</table>`;
  return `${TOP}${listing}${panel}${top}<div class="panel-body table-responsive">${above}${results}${below}</div></div></div>${afterListing}${END}`;
}

// The real page of a day with no recordings: the listing holds one plain panel that names the day and says so.
const HINT = '. Please consider expanding your search, double check spelling or try different dates.';
const emptyPanel = ({ day = DAY, found = 'We found 0 results', hint = `<span>${HINT}</span>`, more = '' } = {}) => '<div class="panel panel-primary">'
  + `<div class="panel-heading"><strong>Searched For:</strong> ${day}</div>`
  + `<div class="panel-body"><p class="lg">${found}${hint}</p>${more}</div></div>`;
const emptyDay = ({ inListing = emptyPanel(), afterListing = '', listing = '<div class="day-listing">' } = {}) => `${TOP}${listing}${inListing}</div>${afterListing}${END}`;

const RESULTS_TABLE = `<table id="results" class="table table-primary">${header()}${row()}</table>`;

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

  test('amounts with and without commas', () => {
    const amounts = ['$0.00', '$999.99', '$1,000.00', '$1,250,000.00', '$425000.00'];
    const html = page({ rows: amounts.map((consideration, i) => row({ instrument: `20269900000${i}`, consideration })) });
    expect(parseDayList(html, DAY).rows.map((r) => r.consideration)).toEqual([0, 999.99, 1000, 1250000, 425000]);
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
    expect(parseDayList(page({ rows: [withViewCell(noView)] }), DAY).rows[0].to).toEqual(['TESTER ALEX J']);
  });

  test('a single-digit month and day in the heading is the same day', () => {
    const html = page({ rows: [row({ date: '01-05-2026' })], top: heading({ first: '1/5/2026', last: '1/5/2026' }) });
    expect(parseDayList(html, '2026-01-05').rows).toHaveLength(1);
  });

  test('a day with no recordings says so itself: an empty day', () => {
    expect(parseDayList(emptyDay(), DAY)).toEqual({ rows: [] });
  });

  test('a results table inside a comment or a template is not on the page: the empty day stays an empty day', () => {
    expect(parseDayList(emptyDay({ afterListing: `<!-- ${RESULTS_TABLE} -->` }), DAY)).toEqual({ rows: [] });
    expect(parseDayList(emptyDay({ afterListing: `<template>${RESULTS_TABLE}</template>` }), DAY)).toEqual({ rows: [] });
  });
});

describe('parseDayList: pages that must throw', () => {
  test.each([
    ['a bot wall', '<html><body><h1>Just a moment...</h1></body></html>', 'not_clerk_page'],
    ['nothing', '', 'not_clerk_page'],
    ['the search page with no day listing', `${TOP}${END}`, 'not_clerk_page'],
    ['an empty day for another day', emptyDay({ inListing: emptyPanel({ day: '2026-11-17' }) }), 'not_clerk_page'],
    ['a panel that found 12 results and shows none', emptyDay({ inListing: emptyPanel({ found: 'We found 12 results' }) }), 'not_clerk_page'],
    ['"We found 0 results" hidden next to a loading message', emptyDay({ inListing: emptyPanel({ found: '', hint: '<span hidden>We found 0 results</span><span>Loading results...</span>' }) }), 'not_clerk_page'],
    ['"We found 0 results" and then more in the panel body', emptyDay({ inListing: emptyPanel({ more: '<p class="lg">Results are still loading</p>' }) }), 'not_clerk_page'],
    ['"We found 0 results" with another hint', emptyDay({ inListing: emptyPanel({ hint: '<span>. The search failed, try again.</span>' }) }), 'not_clerk_page'],
    ['"We found 0 results" outside the studied paragraph', emptyDay({ inListing: emptyPanel().replace('<p class="lg">', '<p class="lg hide">') }), 'not_clerk_page'],
    ['an empty-day heading with one more element', emptyDay({ inListing: emptyPanel().replace('</strong>', '</strong><em>all days</em>') }), 'not_clerk_page'],
    ['a comment in the empty-day message', emptyDay({ inListing: emptyPanel({ found: 'We found 0 results<!-- 12 -->' }) }), 'not_clerk_page'],
    ['an empty results panel (rows would come later by script)', emptyDay({ inListing: '<div id="data-display" class="panel panel-primary"></div>' }), 'not_clerk_page'],
    ['an empty day with a pager on the page', emptyDay({ afterListing: pager() }), 'not_clerk_page'],
    ['two panels in the day listing', emptyDay({ inListing: emptyPanel() + emptyPanel() }), 'not_clerk_page'],
    ['loose text in the day listing', emptyDay({ inListing: `${emptyPanel()} 12 more` }), 'not_clerk_page'],
    ['two day listings', emptyDay({ afterListing: `<div class="day-listing">${emptyPanel()}</div>` }), 'not_clerk_page'],
    ['a hidden day listing', emptyDay({ listing: '<div class="day-listing" hidden>' }), 'not_clerk_page'],
    ['a day listing one level deeper than studied', emptyDay({ listing: '<div class="wrap"><div class="day-listing">', afterListing: '</div>' }), 'not_clerk_page'],
    ['a results page whose table is commented out', page({ table: `<!-- ${RESULTS_TABLE} -->` }), 'not_clerk_page'],
    ['a results page whose table sits in a template', page({ table: `<template>${RESULTS_TABLE}</template>` }), 'not_clerk_page'],

    ['a second table anywhere on the page', page({ afterListing: '<table><tr><td>x</td></tr></table>' }), 'multiple_tables'],
    ['a second results table in single quotes', page({ afterListing: `<table id='results'>${header()}${row({ instrument: '202699000009' })}</table>` }), 'multiple_tables'],
    ['a table inside a cell', page({ rows: [withViewCell('<table><tr><td>x</td></tr></table>')] }), 'multiple_tables'],
    ['a results table outside the results panel', page({ panel: '<div id="other" class="panel panel-primary">' }), 'table_place'],
    ['a hidden results panel', page({ panel: '<div id="data-display" class="panel panel-primary" hidden>' }), 'table_place'],
    ['a results panel with a changed class', page({ panel: '<div id="data-display" class="panel panel-primary hide">' }), 'table_place'],
    ['a results table with a style', page({ tableOpen: '<table id="results" class="table table-primary" style="display:none">' }), 'table_place'],
    ['a results table with another id', page({ tableOpen: '<table id="archive" class="table table-primary">' }), 'table_place'],
    ['something more between the pager and the table', page({ above: `${pager()}<div class="more">Load more</div>` }), 'table_place'],
    ['no pager below the table', page({ below: '' }), 'table_place'],
    ['no pager at all', page({ above: '', below: '' }), 'table_place'],
    ['a page cut off after its last row', page().split('</table>')[0], 'table_place'],
    ['a page cut off after the first of two rows', page({ rows: [row(), row({ instrument: '202699000002' })] }).split('</tr>').slice(0, 2).join('</tr>'), 'table_place'],

    ['two pagination pages below the table', page({ below: pager(TWO_PAGES) }), 'pagination'],
    ['two pagination pages above the table only', page({ above: pager(TWO_PAGES) }), 'pagination'],
    ['a pager with only a Next link', page({ below: pager('<li><a href="?page=2">Next</a></li>') }), 'pagination'],
    ['an empty pager', page({ below: pager('') }), 'pagination'],
    ['a pager on page 2', page({ below: pager('<li class="active"><a>2</a></li>') }), 'pagination'],
    ['a pager whose page 1 is a link to follow', page({ below: pager('<li class="active"><a href="?page=1">1</a></li>') }), 'pagination'],
    ['a pager in single quotes with two pages', page({ above: "<ul class='pagination'><li class='active'><a>1</a></li><li><a>2</a></li></ul>" }), 'pagination'],
    ['a pager with one more class', page({ below: pager().replace('class="pagination"', 'class="pagination pagination-lg"') }), 'pagination'],
    ['a third pager, inside a cell', page({ rows: [withViewCell('<ul class="pagination"><li><a href="?page=2">2</a></li></ul>')] }), 'pagination'],

    ['a comment inside the table', page({ rows: [row(), '<!-- note -->'] }), 'table_shape'],
    ['a script inside the table', page({ rows: [row(), '<script>x()</script>'] }), 'table_shape'],
    ['a header section', page({ table: `<table id="results" class="table table-primary"><thead>${header()}</thead><tbody>${row()}</tbody></table>` }), 'table_shape'],
    ['a table with nothing in it', page({ table: '<table id="results" class="table table-primary"></table>' }), 'table_shape'],
    ['a header and no rows, counted as 0 of 0', page({ rows: [] }), 'no_rows'],
    ['a changed header', page({ head: header(HEADER_NAMES.map((h) => (h === 'To' ? 'Grantee' : h))) }), 'header'],
    ['a header with a missing column', page({ head: header(HEADER_NAMES.slice(0, 10)) }), 'header'],
    ['no header row', page({ head: '' }), 'header'],
    ['a From header that spans two columns', page({ head: header().replace('<th style="width:18em;">From', '<th style="width:18em;" colspan="2">From') }), 'header'],
    ['a header cell that spans two columns, one header cell less', page({ head: header().replace('<th>Book</th><th>Page</th>', '<th colspan="2">Book</th>') }), 'header'],
    ['a header name inside a link', page({ head: header().replace('<th>Type</th>', '<th><a href="?sort=type">Type</a></th>') }), 'header'],

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
    ['a description with markup in it', page({ rows: [row({ description: 'LOT 12 <b>SAMPLE</b> GROVE' })] }), 'cell'],
    ...['425000', '$,.00', '$.00', '$1,00.00', '$12,3456.00', '$1,000', '$1,000.0', '$-5.00', '$1 000.00'].map((amount) => (
      [`a malformed consideration: ${amount}`, page({ rows: [row({ consideration: amount })] }), 'consideration']
    )),

    ['a replacement character in a name', page({ rows: [row({ to: ['TEST\uFFFDR ALEX J'] })] }), 'encoding'],
    ['a NUL character reference in a name', page({ rows: [row({ to: ['TEST&#0;ER ALEX J'] })] }), 'encoding'],
    ['a raw NUL in a name', page({ rows: [row({ to: ['TEST\u0000ER ALEX J'] })] }), 'encoding'],
    ['a raw NUL anywhere on the page', page().replace('<title>', '<title>\u0000'), 'encoding'],
    ['a letter outside plain text in a name', page({ rows: [row({ to: ['TEST\u00C9R ALEX J'] })] }), 'encoding'],
    ['a replacement character in a description', page({ rows: [row({ description: 'LOT 12 SAMPLE GR\uFFFDVE' })] }), 'encoding'],
    ['a byte order mark inside a name (it would read as a space)', page({ rows: [row({ to: ['TESTER AL\uFEFFEX J'] })] }), 'encoding'],
    ['a no-break space inside a name', page({ rows: [row({ to: ['TESTER\u00A0ALEX J'] })] }), 'encoding'],
    ['a no-break space reference inside a name', page({ rows: [row({ to: ['TESTER&nbsp;ALEX J'] })] }), 'encoding'],
    ['a line separator inside a description', page({ rows: [row({ description: 'LOT 12\u2028SAMPLE GROVE' })] }), 'encoding'],
    ['a zero-width space in an instrument number', page({ rows: [row({ instrument: '2026990\u200B00001' })] }), 'encoding'],

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

    ['a heading for another day', page({ top: heading({ first: '11/17/2026', last: '11/17/2026' }) }), 'heading'],
    ['a heading whose last recording is on another day', page({ top: heading({ last: '11/19/2026' }) }), 'heading'],
    ['a heading with other words', page({ top: '<div class="panel-heading">Results</div>' }), 'heading'],
    ['a heading with a fifth column', page({ top: heading().replace('</div></div></div>', '</div><div class="col-md-3">Showing 1 to 1 of 9</div></div></div>') }), 'heading'],
    ['a heading whose count column is hidden', page({ top: heading().replace('<div class="col-md-3">Showing 1', '<div class="col-md-3" hidden>Showing 1') }), 'heading'],
    ['a heading whose count holds markup', page({ top: heading().replace('Showing 1 to 1 of 1', 'Showing 1 to 1 of 1<span hidden>2</span>') }), 'heading'],
    ['a heading with a search term', page({ top: heading().replace('<strong>Searched For:</strong>', '<strong>Searched For:</strong> SAMPLE') }), 'heading'],
    ['a heading with a time that is not a time', page({ top: heading({ first: '11/18/2026 x', last: '11/18/2026' }) }), 'heading'],
    ['a heading that counts more rows than the page holds', page({ top: heading({ to: 2 }) }), 'row_total'],
    ['a heading for the first page of two', page({ top: heading({ to: 1, of: 2 }) }), 'row_total'],
    ['a heading that counts fewer rows than the page holds', page({ rows: [row(), row({ instrument: '202699000002' })], top: heading({ to: 1 }) }), 'row_total'],
  ])('%s', (_label, html, reason) => {
    expect(reasonOf(() => parseDayList(html, DAY))).toBe(reason);
  });

  test('a list item that never closes is read as the browser reads it: two names, not one joined name', () => {
    const html = page({ rows: [withToCell('<ol><li>TESTER ALEX J<li>TESTER JORDAN M</li></ol>')] });
    expect(parseDayList(html, DAY).rows[0].to).toEqual(['TESTER ALEX J', 'TESTER JORDAN M']);
  });

  test('the page of one day is refused when another day is asked for', () => {
    expect(reasonOf(() => parseDayList(page(), '2026-11-17'))).toBe('date');
    expect(reasonOf(() => parseDayList(emptyDay(), '2026-11-17'))).toBe('not_clerk_page');
  });

  test('a bad day argument is refused', () => {
    expect(reasonOf(() => parseDayList(page(), 'yesterday'))).toBe('bad_day');
  });
});

describe('fetchDayList', () => {
  // An answer as the real fetch gives it: a byte stream of `chunks`, then done. `canceled` counts cancel calls.
  const streamed = (chunks, headers = {}, status = 200) => {
    const state = { reads: 0, canceled: 0 };
    const res = {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
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
  const response = (status, body) => streamed([Buffer.from(body)], {}, status).res;
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
    expect(opts.redirect).toBe('manual');
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
    expect(err.status).toBe(403); // the run's failure line names the number
    expect(seen.signal.aborted).toBe(true);
  });

  test('a redirect is refused, not followed', async () => {
    const { fetchImpl, seen } = capture(streamed([Buffer.from(page())], { location: 'https://elsewhere.example/day' }, 302).res);
    const err = await fetchDayList(DAY, { fetchImpl }).catch((e) => e);
    expect(err.reason).toBe('http_status');
    expect(err.message).toMatch(/302/);
    expect(seen.signal.aborted).toBe(true);
  });

  test('bytes that are not UTF-8 are refused, never turned into a replacement character in a name', async () => {
    const bytes = Buffer.from(page());
    const at = bytes.indexOf('TESTER ALEX J');
    const damaged = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 1)]);
    const err = await fetchDayList(DAY, { fetchImpl: async () => streamed([damaged]).res }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('encoding');
  });

  test('a two-byte letter split across two pieces of the stream is not a decoding error', async () => {
    // In the View cell, which is not read: in a part that is read, the same letter is refused as not plain text.
    const bytes = Buffer.from(page({ rows: [withViewCell('<span>Caf\u00E9</span>')] }));
    const at = bytes.indexOf(Buffer.from('\u00E9')) + 1; // between the two bytes of the letter
    const { res } = streamed([bytes.subarray(0, at), bytes.subarray(at)]);
    expect((await fetchDayList(DAY, { fetchImpl: async () => res })).rows).toHaveLength(1);
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

  test('a streamed answer that ends after a complete row is refused, not read as a short day', async () => {
    const cut = Buffer.from(page({ rows: [row(), row({ instrument: '202699000002' })] }).split('</tr>').slice(0, 2).join('</tr>'));
    const { res } = streamed([cut]);
    const err = await fetchDayList(DAY, { fetchImpl: async () => res }).catch((e) => e);
    expect(err.reason).toBe('table_place');
  });

  test('a page the parser refuses throws, and a network error becomes a ClerkPageError', async () => {
    await expect(fetchDayList(DAY, { fetchImpl: async () => response(200, '<html>wall</html>') })).rejects.toBeInstanceOf(ClerkPageError);
    const err = await fetchDayList(DAY, { fetchImpl: async () => { throw new TypeError('socket closed'); } }).catch((e) => e);
    expect(err).toBeInstanceOf(ClerkPageError);
    expect(err.reason).toBe('fetch_failed');
  });
});
