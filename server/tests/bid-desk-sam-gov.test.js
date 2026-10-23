// Bid Desk SAM.gov reader (GATE_BID_DESK_SAM, dark). The mapping is pure; the poll is checked for its gate, its key
// check and its error text with a mocked database and a fake fetch. No network, no real database.
const mockDb = jest.fn(() => { throw new Error('the database must not be touched'); });
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.transaction = (...args) => mockDb(...args);
  db.raw = (...args) => mockDb(...args);
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const sam = require('../services/bid-desk/sam-gov');

const NOW = new Date('2026-10-22T12:00:00Z');

function notice(overrides = {}) {
  return {
    noticeId: 'abc123def456',
    title: 'Pest Control Services, Sarasota National Cemetery',
    solicitationNumber: '36C24826Q0001',
    fullParentPathName: 'VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.NATIONAL CEMETERY ADMINISTRATION',
    type: 'Combined Synopsis/Solicitation',
    active: 'Yes',
    responseDeadLine: '2026-11-05T14:00:00-05:00',
    placeOfPerformance: { city: { name: 'Sarasota' }, state: { code: 'FL' }, zip: '34241' },
    uiLink: 'https://sam.gov/opp/abc123def456/view',
    ...overrides,
  };
}

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  mockDb.mockClear();
});

describe('mapOpportunity', () => {
  test('a Sarasota combined synopsis becomes an unconfirmed sam_gov bid with its deadline and link', () => {
    const { row, skip } = sam.mapOpportunity(notice(), NOW);
    expect(skip).toBeUndefined();
    expect(row).toMatchObject({
      source: 'sam_gov',
      external_id: 'abc123def456',
      external_url: 'https://sam.gov/opp/abc123def456/view',
      project_title: 'Pest Control Services, Sarasota National Cemetery',
      solicitation_number: '36C24826Q0001',
      location: 'Sarasota, FL 34241',
      due_confirmed: false,
      historical: false,
      status: 'new',
    });
    expect(row.due_at.toISOString()).toBe('2026-11-05T19:00:00.000Z');
    expect(row.due_source_line).toBe('SAM.gov response deadline: 2026-11-05T14:00:00-05:00');
    expect(row.gc_or_agency).toBe('VETERANS AFFAIRS, DEPARTMENT OF · NATIONAL CEMETERY ADMINISTRATION');
  });

  test.each([
    ['award notices', { type: 'Award Notice' }, 'type'],
    ['special notices', { type: 'Special Notice' }, 'type'],
    ['inactive notices', { active: 'No' }, 'inactive'],
    ['another state', { placeOfPerformance: { state: { code: 'GA' }, zip: '30301' } }, 'not_florida'],
    ['north Florida', { placeOfPerformance: { state: { code: 'FL' }, zip: '32202' } }, 'outside_area'],
    ['no place ZIP', { placeOfPerformance: { state: { code: 'FL' } } }, 'outside_area'],
    ['a passed deadline', { responseDeadLine: '2026-10-21T14:00:00-04:00' }, 'deadline_passed'],
    ['no notice id', { noticeId: '' }, 'no_notice_id'],
  ])('skips %s', (_label, overrides, reason) => {
    expect(sam.mapOpportunity(notice(overrides), NOW)).toEqual({ skip: reason });
  });

  test('keeps a sources sought with no deadline, and Tampa Bay ZIPs are in the area', () => {
    const { row } = sam.mapOpportunity(notice({ type: 'Sources Sought', responseDeadLine: null, placeOfPerformance: { state: { code: 'FL' }, zip: '33621-5000' } }), NOW);
    expect(row.due_at).toBeNull();
    expect(row.due_source_line).toBeNull();
    expect(row.location).toBe('FL 33621');
  });

  test('a uiLink off sam.gov is not trusted; the link is rebuilt from the notice id', () => {
    const { row } = sam.mapOpportunity(notice({ uiLink: 'https://evil.example/opp' }), NOW);
    expect(row.external_url).toBe('https://sam.gov/opp/abc123def456/view');
    const odd = sam.mapOpportunity(notice({ uiLink: 'javascript:alert(1)', noticeId: 'bad id/../x' }), NOW);
    expect(odd.row.external_url).toBeNull();
  });
});

describe('dates', () => {
  test('API dates are MM/dd/yyyy in the Eastern calendar', () => {
    expect(sam.etYmd(new Date('2026-10-22T02:00:00Z'))).toBe('2026-10-21');
    expect(sam.apiDate('2026-10-21')).toBe('10/21/2026');
    expect(sam.addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('runSamGovPoll', () => {
  test('gate off: no request, no database', async () => {
    process.env.GATE_BID_DESK = 'true';
    delete process.env.GATE_BID_DESK_SAM;
    const fetchImpl = jest.fn();
    expect(await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'k' })).toEqual({ skipped: 'gate_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('the SAM gate alone is not enough: the Bid Desk gate must be on too', async () => {
    delete process.env.GATE_BID_DESK;
    process.env.GATE_BID_DESK_SAM = 'true';
    const fetchImpl = jest.fn();
    expect(await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'k' })).toEqual({ skipped: 'gate_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('no API key: no request, no database', async () => {
    process.env.GATE_BID_DESK = 'true';
    process.env.GATE_BID_DESK_SAM = 'true';
    const fetchImpl = jest.fn();
    expect(await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: '  ' })).toEqual({ skipped: 'no_api_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('fetchPage', () => {
  test('sends the key, codes and Florida filter, and an HTTP error names only the status', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    let caught;
    try {
      await sam.fetchPage({ apiKey: 'SECRET-KEY-123', ncode: '561710', postedFrom: '09/22/2026', postedTo: '10/22/2026', offset: 0, fetchImpl });
    } catch (err) {
      caught = err;
    }
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://api.sam.gov/opportunities/v2/search');
    expect(url.searchParams.get('api_key')).toBe('SECRET-KEY-123');
    expect(url.searchParams.get('ncode')).toBe('561710');
    expect(url.searchParams.get('state')).toBe('FL');
    expect(url.searchParams.get('postedFrom')).toBe('09/22/2026');
    expect(caught).toBeInstanceOf(sam.SamApiError);
    expect(sam.safeError(caught)).toBe('SAM.gov request failed (HTTP 429)');
    expect(sam.safeError(caught)).not.toContain('SECRET');
  });

  test('a network failure never carries the request URL', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed for https://api.sam.gov/?api_key=SECRET'); });
    await expect(sam.fetchPage({ apiKey: 'SECRET', ncode: '561730', postedFrom: 'a', postedTo: 'b', offset: 0, fetchImpl }))
      .rejects.toThrow('SAM.gov request failed (HTTP network)');
  });

  test('a body without opportunitiesData is an error, not an empty day', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: 'x' }) }));
    await expect(sam.fetchPage({ apiKey: 'k', ncode: '561730', postedFrom: 'a', postedTo: 'b', offset: 0, fetchImpl }))
      .rejects.toThrow('bad_body');
  });
});

test('the scheduler checks the SAM gate before the cron lock and logs only the safe error', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
  const at = source.indexOf("'0 25 7 * * *'");
  expect(at).toBeGreaterThan(-1);
  const block = source.slice(at, at + 1400);
  expect(block.indexOf('bidDeskSamLive()')).toBeGreaterThan(-1);
  expect(block.indexOf('bidDeskSamLive()')).toBeLessThan(block.indexOf("runExclusive('bid-desk-sam'"));
  expect(block).toContain('runSamGovPoll');
  expect(block).toContain('safeError(err)');
});
