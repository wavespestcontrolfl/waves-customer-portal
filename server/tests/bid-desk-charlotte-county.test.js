// Bid Desk Charlotte County due dates (GATE_BID_DESK_CHARLOTTE_DATES): the pure list parser, the one fixed outside
// call (a fake fetch; no test reaches the county), the strict gate and the scheduler wiring. Synthetic rows only.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const county = require('../services/bid-desk/charlotte-county');
const { parseCountyList, fetchCountyList } = county;

const row = (over = {}) => ({
  FileNo: '26-601', FileNumber10: '20260601', Description: 'Sample Grounds Contract', DueDate: '/Date(1793818800000)/',
  bAwarded: false, Link: '<a href="#">x</a>', ...over,
});

describe('parseCountyList', () => {
  test('a good row maps its bid number to the due date (1793818800000 is Nov 4 2026, 2:00 PM ET)', () => {
    const map = parseCountyList([row()]);
    expect([...map.keys()]).toEqual(['26-601']);
    const due = map.get('26-601');
    expect(due).toBeInstanceOf(Date);
    expect(due.getTime()).toBe(1793818800000);
    expect(due.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })).toBe('Nov 4, 2026, 2:00 PM');
  });

  test('a bid number that is not NN-NNN or NN-NNNN is skipped', () => {
    const map = parseCountyList([row({ FileNo: '26-60' }), row({ FileNo: '2026-601' }), row({ FileNo: '26-60123' }), row({ FileNo: 'ABC' }),
      row({ FileNo: null }), row({ FileNo: 26601 }), row({ FileNo: '26-6010' })]);
    expect([...map.keys()]).toEqual(['26-6010']);
  });

  test('a due date that is not "/Date(ms)/" or not a real time is skipped', () => {
    const bad = ['2026-11-04', '/Date(abc)/', '/Date()/', '/Date(1793818800000+0500)/', null, 1793818800000, '/Date(99999999999999999999)/', '/Date(8640000000000001)/'];
    const map = parseCountyList(bad.map((DueDate, i) => row({ FileNo: `26-7${String(i).padStart(2, '0')}`, DueDate })));
    expect(map.size).toBe(0);
  });

  test('an awarded bid is skipped', () => {
    expect(parseCountyList([row({ bAwarded: true }), row({ FileNo: '26-602', bAwarded: false })]).has('26-601')).toBe(false);
    expect(parseCountyList([row({ bAwarded: true }), row({ FileNo: '26-602' })]).has('26-602')).toBe(true);
  });

  test('a bid number that appears twice is dropped, whatever the other row says', () => {
    const map = parseCountyList([row(), row({ DueDate: '/Date(1793905200000)/' }), row({ FileNo: '26-603' }),
      row({ FileNo: '26-604' }), row({ FileNo: '26-604', bAwarded: true })]);
    expect([...map.keys()]).toEqual(['26-603']);
  });

  test('anything that is not a list gives an empty map', () => {
    for (const value of [null, undefined, {}, 'x', 5]) expect(parseCountyList(value).size).toBe(0);
    expect(parseCountyList([null, 'x', 4, row()]).size).toBe(1);
  });
});

describe('fetchCountyList', () => {
  const reply = (over = {}) => ({
    ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => JSON.stringify([row()]), ...over,
  });

  test('one GET of the fixed address, no cookies, a plain User-Agent, and the parsed list comes back', async () => {
    const fetchImpl = jest.fn(async () => reply());
    expect(await fetchCountyList({ fetchImpl })).toEqual([row()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://purchasingbids.charlottecountyfl.gov/ContractsCatalogs/GetContractData');
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(init.headers['User-Agent']).toBe('WavesBidDesk/1.0');
    expect(init.headers).not.toHaveProperty('Cookie');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.signal).toBeDefined();
  });

  test('a non-2xx answer fails with the status only', async () => {
    await expect(fetchCountyList({ fetchImpl: async () => reply({ ok: false, status: 503, text: async () => 'SECRET BODY' }) }))
      .rejects.toThrow(/^Charlotte County list HTTP 503$/);
  });

  test('a non-JSON content type fails', async () => {
    const html = reply({ headers: { get: () => 'text/html' }, text: async () => '<html>SECRET</html>' });
    await expect(fetchCountyList({ fetchImpl: async () => html })).rejects.toThrow(/^Charlotte County list is not JSON$/);
  });

  test('a body that is not valid JSON, or not a list, fails without echoing it', async () => {
    await expect(fetchCountyList({ fetchImpl: async () => reply({ text: async () => '{oops SECRET' }) })).rejects.toThrow(/^Charlotte County list is not JSON$/);
    await expect(fetchCountyList({ fetchImpl: async () => reply({ text: async () => '{"a":1}' }) })).rejects.toThrow(/^Charlotte County list is not a list$/);
  });

  test('a body over 5 MB fails, by header or by size', async () => {
    const big = 'x'.repeat(county.MAX_BODY_BYTES + 1);
    await expect(fetchCountyList({ fetchImpl: async () => reply({ text: async () => big }) })).rejects.toThrow(/too large/);
    const declared = reply({ headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : String(county.MAX_BODY_BYTES + 1)) } });
    await expect(fetchCountyList({ fetchImpl: async () => declared })).rejects.toThrow(/too large/);
  });

  test('a streamed body over 5 MB is cut off', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let reads = 0;
    const cancel = jest.fn(async () => {});
    const body = { getReader: () => ({ read: async () => { reads += 1; return reads > 20 ? { done: true } : { done: false, value: chunk }; }, cancel }) };
    await expect(fetchCountyList({ fetchImpl: async () => reply({ body }) })).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalled();
    expect(reads).toBeLessThan(10);
  });

  test('a network error or an abort carries the error class only', async () => {
    const reset = Object.assign(new Error('connect ECONNRESET 10.1.2.3:443 SECRET'), { name: 'TypeError', code: 'ECONNRESET' });
    await expect(fetchCountyList({ fetchImpl: async () => { throw reset; } })).rejects.toThrow(/^Charlotte County list request failed: TypeError$/);
    const abort = Object.assign(new Error('The operation was aborted SECRET'), { name: 'AbortError' });
    await expect(fetchCountyList({ fetchImpl: async () => { throw abort; } })).rejects.toThrow(/^Charlotte County list request failed: AbortError$/);
  });

  test('the 15 second limit aborts a call that never answers', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      const pending = fetchCountyList({ fetchImpl });
      const settled = expect(pending).rejects.toThrow(/AbortError$/);
      await jest.advanceTimersByTimeAsync(county.REQUEST_TIMEOUT_MS);
      await settled;
      expect(county.REQUEST_TIMEOUT_MS).toBe(15000);
    } finally { jest.useRealTimers(); }
  });
});

describe('GATE_BID_DESK_CHARLOTTE_DATES', () => {
  const { bidDeskCharlotteDatesLive } = require('../config/feature-gates');
  afterEach(() => { delete process.env.GATE_BID_DESK; delete process.env.GATE_BID_DESK_CHARLOTTE_DATES; });

  test('dark by default, strict, and it needs the Bid Desk on', () => {
    expect(bidDeskCharlotteDatesLive()).toBe(false);
    process.env.GATE_BID_DESK = 'true';
    expect(bidDeskCharlotteDatesLive()).toBe(false);
    for (const value of ['true ', '1', 'TRUE', 'on', 'yes']) {
      process.env.GATE_BID_DESK_CHARLOTTE_DATES = value;
      expect(bidDeskCharlotteDatesLive()).toBe(false);
    }
    process.env.GATE_BID_DESK_CHARLOTTE_DATES = 'true';
    expect(bidDeskCharlotteDatesLive()).toBe(true);
    delete process.env.GATE_BID_DESK;
    expect(bidDeskCharlotteDatesLive()).toBe(false);
  });

  test('gate off: the run returns before any database query or outside call', async () => {
    const fetchImpl = jest.fn();
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ skipped: 'gate_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

test('the scheduler checks the gate before the cron lock, runs hourly 7:40-18:40 ET and logs only the safe error', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
  const at = source.indexOf("'0 40 7-18 * * *'");
  expect(at).toBeGreaterThan(-1);
  const block = source.slice(at, at + 1500);
  expect(block).toContain("timezone: 'America/New_York'");
  expect(block.indexOf('bidDeskCharlotteDatesLive()')).toBeGreaterThan(-1);
  expect(block.indexOf('bidDeskCharlotteDatesLive()')).toBeLessThan(block.indexOf("runExclusive('bid-desk-charlotte'"));
  expect(block).toContain('runCharlotteDates');
  expect(block).toContain('safeError(err)');
  expect(block).toContain("recordJobEnd('bid-desk-charlotte'");
});
