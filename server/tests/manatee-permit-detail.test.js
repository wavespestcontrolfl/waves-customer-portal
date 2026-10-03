/**
 * Manatee permit detail collector (address-match round 2, PR R2-A).
 *
 * Pins: the record-page parser (label/value span pairs; labels with and
 * without colons or help text; thousands separators; a blank value never
 * borrows the next label's; a revision page without the fields; implausible
 * numbers), the page-belongs-to-this-permit check, the search flow (hidden
 * inputs forwarded, revision record first then the real one, a one-hit
 * redirect), the run (gate off = no network, per-run cap, time budget, >= 2 s
 * between requests, five consecutive no_fields or failures stop the run once,
 * an ok read resets the streak, a failed re-read keeps the stored facts) and
 * the read helper's matching rules. All HTML is synthetic.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  syncPermitDetails,
  findPermitBuildingFacts,
  _private: {
    parseDetailFacts, labelValuePairs, hiddenInputs, detailLinks, pageNamesPermit,
    createThrottle, NEW_DWELLING_TYPES,
  },
} = require('../services/property-lookup/manatee-permit-detail');

const savedFetch = global.fetch;
const ENV_KEYS = ['GATE_PERMIT_DETAIL_SYNC', 'PERMIT_DETAIL_SYNC_CAP', 'PERMIT_DETAIL_SYNC_BUDGET_MS', 'PERMIT_DETAIL_SYNC_MIN_GAP_MS'];

afterEach(() => {
  global.fetch = savedFetch;
  for (const k of ENV_KEYS) delete process.env[k];
  db.mockReset();
  jest.clearAllMocks();
});

// ── synthetic ACA markup (modeled on the record page's label/value spans) ──

const label = (text, cls = "ACA_SmLabelBolder font11px") => `<div class='MoreDetail_ItemColASI MoreDetail_ItemCol1'><span class='${cls}'>${text}</span></div>`;
const value = (text) => `<div class='MoreDetail_ItemColASI MoreDetail_ItemCol2'><span class='ACA_SmLabel ACA_SmLabel_FontSize'>${text}</span></div>`;
const row = (labelText, valueText) => label(labelText) + value(valueText);

const HELP = 'If the type of work is New Residential, please enter the total Square Footage. If the type of work is only Alteration and or Addition, please enter the Square Footage for the Alteration and Or Addition: ';

function recordPage(permitNo, rows, { heading = permitNo } = {}) {
  return `<html><body><script>var x = "Square Footage (Conditioned) 9999";</script>
    <div>Record ${heading} : Residential Record Status: Closed</div>
    <div>Application Information</div>
    ${row('Building Type:', 'Single Family')}
    ${rows}
    ${row('Water Meter Size:', '&#190;')}
  </body></html>`;
}

const FULL_ROWS = [
  row(`Total Square Footage (Under Roof)${HELP}`, '3,150'),
  row(`Square Footage (Conditioned) ${HELP}`, '2,240'),
  row('Number of Stories:', '1'),
  row('Number of Units:', '1'),
  row('Number of Bedrooms:', '3'),
  row('Number of Bathrooms:', '2.5'),
].join('');

const resultsPage = (links) => `<html><body>Showing 1-${links.length} of ${links.length}
  ${links.map((l) => `<a href="${l}">Open</a>`).join('')}</body></html>`;
const linkFor = (id) => `CapDetail.aspx?Module=Building&amp;TabName=Building&amp;capID1=REC00&amp;capID2=00000&amp;capID3=${id}&amp;agencyCode=MANATEE`;
const HOME = `<html><form><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="vs+/=" />
  <input type='hidden' value='gen1' name='__VIEWSTATEGENERATOR' />
  <input type="hidden" name="ACA_CS_FIELD" value="" />
  <input type="text" name="ctl00$PlaceHolderMain$generalSearchForm$txtGSPermitNumber" value="" /></form></html>`;

describe('record page parser', () => {
  test('reads all five facts, ignoring script text and unrelated rows', () => {
    expect(parseDetailFacts(recordPage('BLD9801-0101', FULL_ROWS))).toEqual({
      under_roof_sqft: 3150, conditioned_sqft: 2240, stories: 1, bedrooms: 3, bathrooms: 2.5,
    });
  });

  test('labels match by prefix: colon, no colon, help text, extra spaces, double-quoted attributes', () => {
    const html = recordPage('BLD9801-0102', [
      '<span class="ACA_SmLabelBolder font11px">Number of  Stories </span><span class="ACA_SmLabel x">2</span>',
      '<span class="ACA_SmLabelBolder">Number of Bedrooms:</span><span class="ACA_SmLabel">4</span>',
      row('Number of Bathrooms', '3'),
      row('Square Footage (Conditioned)', '1850'),
    ].join(''));
    expect(parseDetailFacts(html)).toEqual({
      under_roof_sqft: null, conditioned_sqft: 1850, stories: 2, bedrooms: 4, bathrooms: 3,
    });
  });

  test('a blank value stays null and never borrows the next label\'s value', () => {
    const html = recordPage('BLD9801-0103', [
      row(`Total Square Footage (Under Roof)${HELP}`, ''),
      label(`Square Footage (Conditioned) ${HELP}`), // no value span at all
      row('Number of Stories:', '1'),
      row('Number of Bedrooms:', '3'),
    ].join(''));
    expect(parseDetailFacts(html)).toEqual({
      under_roof_sqft: null, conditioned_sqft: null, stories: 1, bedrooms: 3, bathrooms: null,
    });
  });

  test('a revision page without the fields yields no facts', () => {
    const html = `<html>Record BLD9801-0104.RR01 : Permit Re-Review
      ${row('Description:', 'Revised trusses.')}${row('Applicant Job Value:', '140000')}</html>`;
    const facts = parseDetailFacts(html);
    expect(Object.values(facts).every((v) => v === null)).toBe(true);
  });

  test('implausible or non-numeric values are dropped', () => {
    const html = recordPage('BLD9801-0105', [
      row('Square Footage (Conditioned)', '12'),
      row('Total Square Footage (Under Roof)', 'N/A'),
      row('Number of Stories:', '40'),
      row('Number of Bedrooms:', 'three'),
      row('Number of Bathrooms:', '0'),
    ].join(''));
    expect(Object.values(parseDetailFacts(html)).every((v) => v === null)).toBe(true);
  });

  test('the first occurrence of a label wins', () => {
    const html = recordPage('BLD9801-0106', row('Number of Bedrooms:', '3') + row('Number of Bedrooms:', '5'));
    expect(parseDetailFacts(html).bedrooms).toBe(3);
  });

  test('only label/value spans are read: contractor-style rows are never in the pairs we use', () => {
    const pairs = labelValuePairs(recordPage('BLD9801-0107', FULL_ROWS));
    expect(pairs.map(([l]) => l)).toContain('number of units:');
    const facts = parseDetailFacts(recordPage('BLD9801-0107', FULL_ROWS));
    expect(Object.keys(facts).sort()).toEqual(['bathrooms', 'bedrooms', 'conditioned_sqft', 'stories', 'under_roof_sqft']);
  });
});

describe('helpers', () => {
  test('pageNamesPermit: the permit or its revision, never a neighbour sharing the prefix', () => {
    expect(pageNamesPermit('<p>Record BLD9801-0101 : Residential</p>', 'BLD9801-0101')).toBe(true);
    expect(pageNamesPermit('<p>Record BLD9801-0101.RR01 : Re-Review</p>', 'BLD9801-0101')).toBe(true);
    expect(pageNamesPermit('<p>Record BLD9801-01011 : Residential</p>', 'BLD9801-0101')).toBe(false);
    expect(pageNamesPermit('<p>Record BLD9801-0101-0002 : Residential</p>', 'BLD9801-0101')).toBe(false);
    expect(pageNamesPermit('<p>Record XBLD9801-0101</p>', 'BLD9801-0101')).toBe(false);
    expect(pageNamesPermit('<input value="BLD9801-0101">', 'BLD9801-0101')).toBe(false);
  });

  test('hiddenInputs reads any attribute order and quote style, decoding entities', () => {
    expect(hiddenInputs(HOME)).toEqual({ __VIEWSTATE: 'vs+/=', __VIEWSTATEGENERATOR: 'gen1', ACA_CS_FIELD: '' });
    expect(hiddenInputs('<input type="hidden" name="a" value="x&amp;y" />')).toEqual({ a: 'x&y' });
  });

  test('detailLinks dedupes and decodes entities', () => {
    const l = linkFor('AAA');
    expect(detailLinks(resultsPage([l, l, linkFor('BBB')]))).toEqual([
      'CapDetail.aspx?Module=Building&TabName=Building&capID1=REC00&capID2=00000&capID3=AAA&agencyCode=MANATEE',
      'CapDetail.aspx?Module=Building&TabName=Building&capID1=REC00&capID2=00000&capID3=BBB&agencyCode=MANATEE',
    ]);
  });

  test('createThrottle spaces requests by the gap measured from the previous finish', async () => {
    let t = 0;
    const sleeps = [];
    const run = createThrottle({ gapMs: 2000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await run(async () => { t += 500; }); // first: no wait
    await run(async () => { t += 100; }); // finished at 500: waits the full 2000
    await run(async () => { t += 3000; });
    await run(async () => {}); // previous finished 3000 ago? no: just finished -> waits
    expect(sleeps).toEqual([2000, 2000, 2000]);
  });

  test('the candidate vocabulary is the three new-dwelling types, lower-case', () => {
    expect(NEW_DWELLING_TYPES).toEqual(['new single family', 'new townhouse', 'new townhouse/duplex']);
  });
});

// ── the run ──

// Chainable thenable stub: awaiting resolves to `rows`; update/where recorded.
function stubDb(rows) {
  const b = {};
  for (const m of ['whereRaw', 'orWhereRaw', 'where', 'whereNull', 'whereNotNull', 'orWhere', 'orderByRaw', 'orderBy', 'limit', 'select', 'update']) {
    b[m] = jest.fn((arg) => {
      // Run grouped where(fn) callbacks so their inner chain is exercised.
      if (typeof arg === 'function') arg(b);
      return b;
    });
  }
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  db.mockImplementation(() => b);
  return b;
}

const response = (text) => ({
  ok: true,
  status: 200,
  text: async () => text,
  headers: { getSetCookie: () => ['ASP.NET_SessionId=abc; path=/; HttpOnly'], get: () => 'text/html' },
});

/**
 * Fake ACA. `permits` maps a permit number to its scenario:
 *   { pages: [html, ...] }  results list linking to each page in order
 *   { direct: html }        the POST answers with the record page itself
 *   { empty: true }         no results
 *   { fail: true }          the POST rejects
 */
function fakeAca(permits, { clock, tickMs = 0 } = {}) {
  const calls = [];
  const pagesById = new Map();
  global.fetch = jest.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body, headers: opts.headers, at: clock ? clock() : 0 });
    if (clock) clock.advance(tickMs);
    if (/CapHome\.aspx/.test(url) && opts.method === 'GET') return response(HOME);
    if (/CapHome\.aspx/.test(url) && opts.method === 'POST') {
      const params = new URLSearchParams(opts.body);
      const pn = params.get('ctl00$PlaceHolderMain$generalSearchForm$txtGSPermitNumber');
      const sc = permits[pn];
      if (!sc || sc.empty) return response('<html>Notice: Your search returned no results. Please modify your search criteria and try again.</html>');
      if (sc.invalid) return response('<html>Please sign in to continue.</html>');
      if (sc.fail) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      if (sc.direct) return response(sc.direct);
      if (sc.redirectTo) {
        pagesById.set(`${pn}-r`, sc.redirectTo);
        return { ok: false, status: 302, text: async () => '', headers: { getSetCookie: () => [], get: (h) => (h.toLowerCase() === 'location' ? `CapDetail.aspx?capID1=A&capID2=B&capID3=${pn}-r` : null) } };
      }
      const ids = sc.pages.map((html, i) => { const id = `${pn}-${i}`; pagesById.set(id, html); return id; });
      return response(resultsPage(ids.map(linkFor)));
    }
    const id = String(url).match(/capID3=([^&]+)/)?.[1];
    return response(pagesById.get(id) || '<html>unknown</html>');
  });
  return calls;
}

const cand = (permit_no, extra = {}) => ({ permit_no, co_date: null, detail_status: null, ...extra });
const okPage = (pn) => recordPage(pn, FULL_ROWS);
const noFieldsPage = (pn) => recordPage(pn, row('Number of Units:', '1'));

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; };
  clock.sleep = async (ms) => { t += ms; };
  return clock;
}

describe('search form validation', () => {
  test('a 200 page that is not the search form is an error (never not_found) and five in a row stop as an outage', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const ids = Array.from({ length: 7 }, (_, i) => `BLD9801-096${i}`);
    stubDb(ids.map((id) => cand(id)));
    const calls = fakeAca({}, { clock });
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, opts = {}) => (/CapHome\.aspx/.test(url) && opts.method === 'GET'
      ? response('<html>Scheduled maintenance</html>')
      : realFetch(url, opts)));
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ errors: 5, notFound: 0, stopped: 'outage' });
    expect(global.fetch.mock.calls.some(([, o]) => o.method === 'POST')).toBe(false);
    expect(calls).toBeDefined();
  });
});

describe('round-2 classification', () => {
  test('a link-less search reply without the county\'s empty notice is an error, not not_found', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0971')]);
    fakeAca({ 'BLD9801-0971': { invalid: true } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ errors: 1, notFound: 0 });
  });

  test('linked record GETs answering with a non-record page are errors, not not_found', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0974')]);
    fakeAca({ 'BLD9801-0974': { pages: ['<html>Scheduled maintenance</html>'] } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ errors: 1, notFound: 0 });
  });

  test('a page with partial facts (no conditioned sq ft) is an ok read', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([cand('BLD9801-0972')]);
    fakeAca({ 'BLD9801-0972': { pages: [recordPage('BLD9801-0972', row('Number of Stories:', '2') + row('Number of Bedrooms:', '4'))] } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ ok: 1, noFields: 0 });
    expect(b.update.mock.calls[0][0]).toMatchObject({ conditioned_sqft: null, stories: 2, bedrooms: 4 });
  });

  test('five revision records ahead of the base record: the base record is still reached', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0973')]);
    const pn = 'BLD9801-0973';
    fakeAca({ [pn]: { pages: [...Array.from({ length: 5 }, () => noFieldsPage(pn)), okPage(pn)] } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ ok: 1 });
  });
});

describe('redirect hops', () => {
  test('a one-hit search redirect is followed through the throttle (≥2 s before the redirected GET), cookies kept', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0951')]);
    const calls = fakeAca({ 'BLD9801-0951': { redirectTo: okPage('BLD9801-0951') } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ ok: 1 });
    const post = calls.findIndex((c) => c.method === 'POST');
    const hop = calls[post + 1];
    expect(hop.method).toBe('GET');
    expect(hop.url).toMatch(/CapDetail\.aspx/);
    expect(hop.at - calls[post].at).toBeGreaterThanOrEqual(2000);
    expect(hop.headers.Cookie).toMatch(/ASP\.NET_SessionId/);
    // fetch itself never follows redirects.
    expect(global.fetch.mock.calls.every(([, o]) => o.redirect === 'manual')).toBe(true);
  });
});

describe('syncPermitDetails', () => {
  test('gate off (unset or anything but "true"): no network, no DB read', async () => {
    global.fetch = jest.fn();
    expect(await syncPermitDetails()).toEqual({ skipped: 'gated' });
    process.env.GATE_PERMIT_DETAIL_SYNC = '1';
    expect(await syncPermitDetails()).toEqual({ skipped: 'gated' });
    process.env.GATE_PERMIT_DETAIL_SYNC = 'TRUE';
    expect(await syncPermitDetails()).toEqual({ skipped: 'gated' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('an ok read stores the five facts, the CO date it saw, and nothing else', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([cand('BLD9801-0201', { co_date: '2026-09-01' })]);
    const calls = fakeAca({ 'BLD9801-0201': { pages: [okPage('BLD9801-0201')] } }, { clock });

    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ candidates: 1, attempted: 1, ok: 1, stopped: null });

    const update = b.update.mock.calls[0][0];
    expect(update).toEqual({
      detail_status: 'ok',
      detail_fetched_at: expect.any(Date),
      detail_co_date: '2026-09-01',
      conditioned_sqft: 2240, under_roof_sqft: 3150, stories: 1, bedrooms: 3, bathrooms: 2.5,
    });
    expect(b.where).toHaveBeenCalledWith({ permit_no: 'BLD9801-0201' });

    // Search flow: form GET, then POST carrying every hidden input, the
    // permit number and the search target, with the CSRF headers.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    const post = new URLSearchParams(calls[1].body);
    expect(post.get('__VIEWSTATE')).toBe('vs+/=');
    expect(post.get('ACA_CS_FIELD')).toBe('');
    expect(post.get('__EVENTTARGET')).toBe('ctl00$PlaceHolderMain$btnNewSearch');
    expect(post.get('ctl00$PlaceHolderMain$generalSearchForm$txtGSPermitNumber')).toBe('BLD9801-0201');
    expect(calls[1].headers.Referer).toMatch(/CapHome\.aspx/);
    expect(calls[1].headers.Origin).toBe('https://aca-prod.accela.com');
    expect(calls[1].headers.Cookie).toContain('ASP.NET_SessionId=abc');
  });

  test('a revision record listed first is skipped for the record that has the fields', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([cand('BLD9801-0202')]);
    const calls = fakeAca({
      'BLD9801-0202': { pages: [
        `<html>Record BLD9801-0202.RR01 : Permit Re-Review ${row('Description:', 'Revised trusses.')}</html>`,
        okPage('BLD9801-0202'),
      ] },
    }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out.ok).toBe(1);
    expect(calls).toHaveLength(4); // form, search, revision, record
    expect(b.update.mock.calls[0][0].conditioned_sqft).toBe(2240);
  });

  test('a one-hit search that redirects straight to the record page is read in place', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0203')]);
    const calls = fakeAca({ 'BLD9801-0203': { direct: okPage('BLD9801-0203') } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out.ok).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test('a page for a different permit that merely shares the prefix is never read', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([cand('BLD9801-0204')]);
    fakeAca({ 'BLD9801-0204': { pages: [okPage('BLD9801-02049')] } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ ok: 0, notFound: 1 });
    expect(b.update.mock.calls[0][0]).toMatchObject({ detail_status: 'not_found', conditioned_sqft: null });
  });

  test('statuses: no results = not_found, a record without the fields = no_fields, a request failure = error', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([cand('BLD9801-0301'), cand('BLD9801-0302'), cand('BLD9801-0303')]);
    fakeAca({
      'BLD9801-0301': { empty: true },
      'BLD9801-0302': { pages: [noFieldsPage('BLD9801-0302')] },
      'BLD9801-0303': { fail: true },
    }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ attempted: 3, ok: 0, notFound: 1, noFields: 1, errors: 1, stopped: null });
    expect(b.update.mock.calls.map(([u]) => u.detail_status)).toEqual(['not_found', 'no_fields', 'error']);
  });

  test('at least 2 s between ANY two requests, even with a smaller configured gap', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    process.env.PERMIT_DETAIL_SYNC_MIN_GAP_MS = '10';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0401'), cand('BLD9801-0402')]);
    const calls = fakeAca({
      'BLD9801-0401': { pages: [okPage('BLD9801-0401')] },
      'BLD9801-0402': { pages: [okPage('BLD9801-0402')] },
    }, { clock, tickMs: 300 });
    await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(calls).toHaveLength(6);
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(2000);
    }
  });

  test('requests never overlap: each starts only after the previous one finished', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0411'), cand('BLD9801-0412')]);
    fakeAca({ 'BLD9801-0411': { empty: true }, 'BLD9801-0412': { empty: true } }, { clock });
    let inFlight = 0;
    let max = 0;
    const inner = global.fetch;
    global.fetch = jest.fn(async (...args) => {
      inFlight += 1; max = Math.max(max, inFlight);
      try { await new Promise((r) => { setImmediate(r); }); return await inner(...args); } finally { inFlight -= 1; }
    });
    await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(max).toBe(1);
  });

  test('the per-run cap bounds the candidate query (default 400, env override)', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    let b = stubDb([]);
    await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(b.limit).toHaveBeenCalledWith(400);
    process.env.PERMIT_DETAIL_SYNC_CAP = '3';
    b = stubDb([cand('BLD9801-0501'), cand('BLD9801-0502'), cand('BLD9801-0503')]);
    fakeAca({}, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(b.limit).toHaveBeenCalledWith(3);
    expect(out.stopped).toBe('cap'); // a full page of candidates: more may be waiting
  });

  test('the candidate query asks for the new-dwelling vocabulary, excluding canceled and withdrawn', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([]);
    await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(b.whereRaw).toHaveBeenCalledWith('LOWER(TRIM(type_of_work)) = ANY(?)', [NEW_DWELLING_TYPES]);
    expect(b.whereRaw.mock.calls.some(([sql]) => /NOT IN \('canceled', 'withdrawn'\)/.test(sql))).toBe(true);
  });

  test('the budget is enforced before every hop: a permit spanning the deadline stops mid-way, unrecorded', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    process.env.PERMIT_DETAIL_SYNC_BUDGET_MS = '9000';
    const clock = fakeClock();
    const pn = 'BLD9801-0611';
    const b = stubDb([cand(pn)]);
    const calls = fakeAca({ [pn]: { pages: [...Array.from({ length: 6 }, () => noFieldsPage(pn)), okPage(pn)] } }, { clock, tickMs: 1000 });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ stopped: 'budget', attempted: 0 });
    // Every request that went out started before the deadline.
    expect(calls.every((c) => c.at < 1_700_000_000_000 + 9000)).toBe(true);
    expect(calls.length).toBeLessThan(9);
    // Nothing recorded for the interrupted permit — it stays a candidate.
    expect(b.update).not.toHaveBeenCalled();
  });

  test('the time budget stops the run between permits', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    // One full permit (3 hops of 3 s plus the gaps, ~14 s) fits; the next does not.
    process.env.PERMIT_DETAIL_SYNC_BUDGET_MS = '15000';
    const clock = fakeClock();
    stubDb([cand('BLD9801-0601'), cand('BLD9801-0602'), cand('BLD9801-0603')]);
    fakeAca({
      'BLD9801-0601': { pages: [okPage('BLD9801-0601')] },
      'BLD9801-0602': { pages: [okPage('BLD9801-0602')] },
      'BLD9801-0603': { pages: [okPage('BLD9801-0603')] },
    }, { clock, tickMs: 3000 });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out.stopped).toBe('budget');
    expect(out.attempted).toBe(1);
  });

  test('five consecutive no_fields stop the run and log ONE structural warning', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const ids = Array.from({ length: 8 }, (_, i) => `BLD9801-070${i}`);
    stubDb(ids.map((id) => cand(id)));
    fakeAca(Object.fromEntries(ids.map((id) => [id, { pages: [noFieldsPage(id)] }])), { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ attempted: 5, noFields: 5, stopped: 'structure' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/page structure changed/);
    // No permit number, address or parcel in any log line.
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.info.mock.calls]);
    expect(logged).not.toMatch(/BLD98/);
  });

  test('an ok read resets the no_fields streak', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const plan = ['nf', 'nf', 'nf', 'nf', 'ok', 'nf', 'nf', 'nf', 'nf'];
    const ids = plan.map((_, i) => `BLD9801-080${i}`);
    stubDb(ids.map((id) => cand(id)));
    fakeAca(Object.fromEntries(ids.map((id, i) => [id, { pages: [plan[i] === 'ok' ? okPage(id) : noFieldsPage(id)] }])), { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ attempted: 9, ok: 1, noFields: 8, stopped: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a not_found or a request failure also breaks a no_fields streak (scattered no_fields never stop the run)', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const plan = ['nf', 'nf', 'nf', 'nf', 'missing', 'nf', 'nf', 'nf', 'nf', 'fail', 'nf'];
    const ids = plan.map((_, i) => `BLD9801-085${String(i).padStart(2, '0')}`);
    stubDb(ids.map((id) => cand(id)));
    fakeAca(Object.fromEntries(ids.map((id, i) => [id,
      plan[i] === 'fail' ? { fail: true } : plan[i] === 'missing' ? { empty: true } : { pages: [noFieldsPage(id)] }])), { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ attempted: 11, noFields: 9, stopped: null });
  });

  test('five consecutive request failures stop the run as an outage', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const ids = Array.from({ length: 7 }, (_, i) => `BLD9801-090${i}`);
    stubDb(ids.map((id) => cand(id)));
    fakeAca(Object.fromEntries(ids.map((id) => [id, { fail: true }])), { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ attempted: 5, errors: 5, stopped: 'outage' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a failed re-read of an ok permit keeps its stored facts; a good re-read replaces them', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([
      cand('BLD9801-1001', { detail_status: 'ok', co_date: '2026-09-10' }),
      cand('BLD9801-1002', { detail_status: 'ok', co_date: '2026-09-11' }),
    ]);
    fakeAca({
      'BLD9801-1001': { fail: true },
      'BLD9801-1002': { pages: [recordPage('BLD9801-1002', row('Square Footage (Conditioned)', '2,400') + row('Number of Bedrooms:', '4'))] },
    }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ attempted: 2, errors: 1, ok: 1 });
    // The failed re-read only stamps its attempt time (facts and status
    // untouched, so it backs off); the good one replaces the facts.
    expect(b.update).toHaveBeenCalledTimes(2);
    expect(Object.keys(b.update.mock.calls[0][0])).toEqual(['detail_fetched_at']);
    expect(b.where).toHaveBeenCalledWith({ permit_no: 'BLD9801-1002' });
    expect(b.update.mock.calls[1][0]).toMatchObject({ conditioned_sqft: 2400, bedrooms: 4, under_roof_sqft: null, detail_co_date: '2026-09-11' });
  });

  test('a write failure never stops the loop, and the run then fails for job health (counts only)', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const b = stubDb([cand('BLD9801-1101'), cand('BLD9801-1102')]);
    b.update.mockImplementation(() => { throw Object.assign(new Error('boom BLD9801-1101'), { code: '22001' }); });
    const calls = fakeAca({
      'BLD9801-1101': { pages: [okPage('BLD9801-1101')] },
      'BLD9801-1102': { pages: [okPage('BLD9801-1102')] },
    }, { clock });
    await expect(syncPermitDetails({ now: clock, sleep: clock.sleep })).rejects.toThrow('2 result write(s) failed');
    // Both permits were still attempted (per-row isolation).
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/BLD98/);
  });

  test('a revision with only some facts does not end the read: the fuller base record wins', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const pn = 'BLD9801-1103';
    const b = stubDb([cand(pn)]);
    fakeAca({ [pn]: { pages: [recordPage(pn, row('Number of Stories:', '2')), okPage(pn)] } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ ok: 1 });
    expect(b.update.mock.calls[0][0].conditioned_sqft).not.toBeNull();
  });

  test('only partial pages anywhere: the best partial is stored', async () => {
    process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
    const clock = fakeClock();
    const pn = 'BLD9801-1104';
    const b = stubDb([cand(pn)]);
    fakeAca({ [pn]: { pages: [recordPage(pn, row('Number of Stories:', '2')), recordPage(pn, row('Number of Stories:', '2') + row('Number of Bedrooms:', '4'))] } }, { clock });
    const out = await syncPermitDetails({ now: clock, sleep: clock.sleep });
    expect(out).toMatchObject({ ok: 1 });
    expect(b.update.mock.calls[0][0]).toMatchObject({ conditioned_sqft: null, stories: 2, bedrooms: 4 });
  });
});

// ── read helper ──

function helperStub(results) {
  const queries = [];
  db.mockImplementation((table) => {
    const q = { table, wheres: [], then: null };
    for (const m of ['where', 'whereRaw', 'orderByRaw', 'orderBy', 'first']) {
      q[m] = jest.fn((...a) => { q.wheres.push([m, ...a]); return q; });
    }
    q.where = jest.fn((...a) => { q.wheres.push(['where', ...a]); if (typeof a[0] === 'function') a[0](q); return q; });
    q.whereNull = jest.fn(() => q);
    q.orWhere = jest.fn(() => q);
    q.orWhereRaw = jest.fn(() => q);
    const result = results.shift();
    q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    queries.push(q);
    return q;
  });
  return queries;
}

const FACT_ROW = {
  permit_no: 'BLD9801-1201', type_of_work: 'New Single Family', issued_date: '2026-03-02', co_date: '2026-08-20',
  detail_fetched_at: new Date('2026-09-14T09:00:00Z'), conditioned_sqft: 2240, under_roof_sqft: 3150, stories: '1.0', bedrooms: 3, bathrooms: '2.5',
};

describe('findPermitBuildingFacts', () => {
  test('parcel tier first; returns the newest ok row with source and fetch date', async () => {
    const queries = helperStub([FACT_ROW]);
    const out = await findPermitBuildingFacts({ parcelPin: '1234567890', looseKey: '100sample34219' });
    expect(out).toEqual({
      source: 'manatee_permit_detail',
      permitNo: 'BLD9801-1201',
      typeOfWork: 'New Single Family',
      issuedAt: '2026-03-02',
      coIssuedAt: '2026-08-20',
      fetchedAt: '2026-09-14',
      conditionedSqft: 2240, underRoofSqft: 3150, stories: 1, bedrooms: 3, bathrooms: 2.5,
    });
    expect(queries).toHaveLength(1); // strict precedence: no loose-key query once the parcel hit
    expect(queries[0].table).toBe('construction_permit_records');
    expect(queries[0].wheres).toEqual(expect.arrayContaining([
      ['where', 'parcel_pin', '1234567890'],
      ['where', 'detail_status', 'ok'],
    ]));
    expect(queries[0].wheres.some(([m, sql]) => m === 'whereRaw' && /NOT IN \('canceled', 'withdrawn'\)/.test(sql))).toBe(true);
    expect(queries[0].wheres.some(([m, sql]) => m === 'orderByRaw' && /issued_date DESC NULLS LAST/.test(sql))).toBe(true);
  });

  test('a parcel miss falls to the loose key, with the different-parcel guard when the parcel is known', async () => {
    const queries = helperStub([undefined, FACT_ROW]);
    const out = await findPermitBuildingFacts({ parcelPin: '1234567890', looseKey: '100sample34219' });
    expect(out.permitNo).toBe('BLD9801-1201');
    expect(queries).toHaveLength(2);
    expect(queries[1].wheres).toEqual(expect.arrayContaining([['where', 'address_loose_key', '100sample34219']]));
    // The guard is a grouped where(fn): pin-less, same pin, or odd-format rows only.
    expect(queries[1].wheres.some(([m, a]) => m === 'where' && typeof a === 'function')).toBe(true);
    expect(queries[0].wheres.some(([m, a]) => m === 'where' && typeof a === 'function')).toBe(false);
  });

  test('loose key alone has no parcel guard; no keys = null without a query', async () => {
    const queries = helperStub([FACT_ROW]);
    await findPermitBuildingFacts({ looseKey: '100sample34219' });
    expect(queries[0].wheres.some(([m, a]) => m === 'where' && typeof a === 'function')).toBe(false);
    db.mockClear();
    expect(await findPermitBuildingFacts({})).toBeNull();
    expect(await findPermitBuildingFacts()).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('no ok row on either tier = null', async () => {
    helperStub([undefined, undefined]);
    expect(await findPermitBuildingFacts({ parcelPin: '1234567890', looseKey: '100sample34219' })).toBeNull();
  });

  test('missing numeric facts stay null, not 0', async () => {
    helperStub([{ ...FACT_ROW, under_roof_sqft: null, stories: null, bedrooms: null, bathrooms: null, co_date: null }]);
    const out = await findPermitBuildingFacts({ parcelPin: '1234567890' });
    expect(out).toMatchObject({ underRoofSqft: null, stories: null, bedrooms: null, bathrooms: null, coIssuedAt: null });
  });
});
