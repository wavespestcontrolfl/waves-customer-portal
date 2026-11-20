/**
 * Weekly restaurant prospect sync (services/prospects/dbpr-restaurants.js): the three file parsers, the phone
 * rule for the swapped ownership-change columns, the report page split (35A pest evidence vs 35B outer openings),
 * and the sync flow with fetch, sleep and the store faked. Fixtures are synthetic: "SAMPLE DINER", "200 SAMPLE TRL".
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn() };
  db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const svc = require('../services/prospects/dbpr-restaurants');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'dbpr-restaurants', name), 'utf8');
const csvLine = (cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');

// Inspection extract: leading-space headers like the real file, 58 violation columns.
const INSP_HEAD = [
  'District', 'County Number', 'County Name', ' License Type Code', ' License Number', 'Business (DBA-Does Business As) Name',
  'Location Address', 'Location City', ' Location Zip Code', 'Inspection Number', 'Visit Number', 'Inspection Class',
  'Inspection Type', 'Inspection Disposition', 'Inspection Date', 'Number of High Priority Violations',
  ...Array.from({ length: 58 }, (_, i) => `Violation ${String(i + 1).padStart(2, '0')}`),
  'License ID', 'Inspection Visit ID',
];
function inspRow({ county = 'Manatee', date = '10/20/2026', v35 = 1, visit = '9001', licenseId = '5001', name = 'SAMPLE DINER' } = {}) {
  const v = Array.from({ length: 58 }, (_, i) => (i === 34 ? String(v35) : '0'));
  return csvLine(['D7', '41', county, '2010', 'SEA0000001', name, '200 SAMPLE TRL', 'BRADENTON', '34208', '1', '1', 'Food',
    'Routine - Food', 'Warning Issued', date, '2', ...v, licenseId, visit]);
}
const inspCsv = (rows) => `${csvLine(INSP_HEAD)}\n${rows.join('\n')}\n`;

// New-license / ownership-change layout: 38 header columns, 36 data columns, trailing space on the date header.
const LIC_HEAD = ['Application Number', 'Application Type', 'Application Approval Date ', 'Board Code', 'License Type Code', 'Licensee Name',
  'Rank Code', 'Modifier Code', 'Mailing Name', 'Mailing Street Address', 'Mailing Address Line 2', 'Mailing Address Line 3',
  'Mailing City', 'Mailing State Code', 'Mailing Zip Code', 'Primary Phone Number', 'Mailing County Code', 'Business Name', 'Filler',
  'Location Street Address', 'Location Address Line 2', 'Location Address Line 3', 'Location City', 'Location State Code',
  'Location Zip Code', 'Location County Code', 'Location County', 'Secondary Phone Number', 'District', 'Region', 'License Number',
  'Primary Status Code', 'Secondary Status Code', 'License Expiry Date', 'Last Inspection Date', 'Number of Seats',
  'Base Risk Level', 'Secondary Risk Level'];
function licRow({ app = '7001', county = 'Sarasota', primary = '555-010-0000', mailCounty = '51', secondary = '941-555-0101', seats = '40', date = '08/21/2026' } = {}) {
  return csvLine([app, 'Plan Review and Initial (COMBO SEAT)', date, '200', '2010', 'SAMPLE DINER LLC', 'SEAT', '', 'SAMPLE DINER LLC', '', '1 MAIL ST', ' ',
    'TAMPA', 'FL', '33601', primary, mailCounty, 'SAMPLE DINER', ' ', '200 SAMPLE TRL', 'UNIT 3', '', 'SARASOTA', 'FL', '34231-1234', '68', county,
    secondary, 'D7', '07', 'SEA0000002', '20', '20', '12/01/2026', '10/29/2026', seats]);
}
const licCsv = (rows) => `${csvLine(LIC_HEAD)}\n${rows.join('\n')}\n`;

describe('parseUsDate', () => {
  test('turns MM/DD/YYYY into a plain date string and rejects anything else', () => {
    expect(svc.parseUsDate('08/21/2026')).toBe('2026-08-21');
    expect(svc.parseUsDate('8/1/2026')).toBe('2026-08-01');
    expect(svc.parseUsDate('02/30/2026')).toBeNull();
    expect(svc.parseUsDate('2026-08-21')).toBeNull();
    expect(svc.parseUsDate('')).toBeNull();
  });
});

describe('parseInspectionRows', () => {
  const { parseDbprCsv } = require('../services/commercial-suite-size/dbpr-food-license');

  test('keeps only code-35 visits in the three counties, with trimmed headers and a plain date', () => {
    const rows = parseDbprCsv(inspCsv([
      inspRow({ visit: '9001' }),
      inspRow({ visit: '9002', county: 'Sarasota' }),
      inspRow({ visit: '9003', county: 'Charlotte' }),
      inspRow({ visit: '9004', county: 'Hillsborough' }),
      inspRow({ visit: '9005', v35: 0 }),
      inspRow({ visit: '9006', date: 'not a date' }),
    ]));
    const out = svc.parseInspectionRows(rows);
    expect(out.map((r) => r.source_key)).toEqual(['9001', '9002', '9003']);
    expect(out[0]).toMatchObject({
      kind: 'inspection', license_id: '5001', license_number: 'SEA0000001', license_type_code: '2010', business_name: 'SAMPLE DINER',
      address: '200 SAMPLE TRL', city: 'BRADENTON', zip: '34208', county: 'Manatee', event_date: '2026-10-20',
      detail: { disposition: 'Warning Issued', inspectionType: 'Routine - Food', highPriority: 2 },
    });
  });
});

describe('parseLicenseRows and the phone rule', () => {
  const { parseDbprCsv } = require('../services/commercial-suite-size/dbpr-food-license');

  test('parses a relaxed-width file into records for the three counties', () => {
    const rows = parseDbprCsv(licCsv([licRow(), licRow({ app: '7002', county: 'Polk' }), licRow({ app: '7003', county: 'Charlotte', seats: '' })]));
    const out = svc.parseLicenseRows(rows, 'new_license');
    expect(out.map((r) => r.source_key)).toEqual(['7001', '7003']);
    expect(out[0]).toMatchObject({
      kind: 'new_license', license_number: 'SEA0000002', business_name: 'SAMPLE DINER', address: '200 SAMPLE TRL UNIT 3',
      city: 'SARASOTA', zip: '34231', county: 'Sarasota', phone: '9415550101', seats: 40, event_date: '2026-08-21',
      detail: { applicationType: 'Plan Review and Initial (COMBO SEAT)' },
    });
    expect(out[1].seats).toBeNull();
  });

  test('ownership change: the phone sits under Mailing County Code and is picked by shape', () => {
    const rows = parseDbprCsv(licCsv([licRow({ app: '8001', primary: '68', mailCounty: '9415550199', secondary: '' })]));
    const [rec] = svc.parseLicenseRows(rows, 'owner_change');
    expect(rec.kind).toBe('owner_change');
    expect(rec.phone).toBe('9415550199');
  });

  test('pickPhone prefers the location line, never returns a county code, and returns null with no phone', () => {
    expect(svc.pickPhone({ 'Primary Phone Number': '68', 'Mailing County Code': '(941) 555-0188', 'Secondary Phone Number': '' })).toBe('9415550188');
    expect(svc.pickPhone({ 'Primary Phone Number': '614-555-0100', 'Mailing County Code': '736', 'Secondary Phone Number': '941-555-0101' })).toBe('9415550101');
    expect(svc.pickPhone({ 'Primary Phone Number': '62', 'Mailing County Code': '51', 'Secondary Phone Number': '' })).toBeNull();
  });
});

describe('parseInspectionReport', () => {
  test('a 35A finding is pest evidence; each 35A entry runs from its code to the next code', () => {
    const report = svc.parseInspectionReport(fixture('report-35a.html'));
    expect(report.pestEvidence).toBe(true);
    expect(report.findings).toEqual([
      { code: '35A-02-8', text: 'High Priority - Live, small flying insects found. Observed 10 small flying insects at the bar & landing on tap spouts.' },
      { code: '35A-01-8', text: 'High Priority - Rodent droppings in dry storage. **Repeat Violation**' },
    ]);
  });

  test('35B only is not pest evidence, and the page footer never lands in a finding', () => {
    expect(svc.parseInspectionReport(fixture('report-35b.html'))).toEqual({ pestEvidence: false, findings: [] });
    const withFooter = svc.parseInspectionReport(fixture('report-35a.html').replace('08A-05-6', '35A-07-1'));
    expect(JSON.stringify(withFooter)).not.toMatch(/Blair Stone|941-777/);
  });

  test('a page with no inspection section is a failed read, not "no pests"', () => {
    expect(svc.parseInspectionReport('<html><body>Service temporarily unavailable</body></html>')).toBeNull();
    expect(svc.parseInspectionReport('')).toBeNull();
  });

  test('finding text is capped', () => {
    const long = `<p>Inspection Information</p><u>35A-02-8</u> ${'x'.repeat(2000)}`;
    expect(svc.parseInspectionReport(long).findings[0].text).toHaveLength(400);
  });
});

describe('reportUrl', () => {
  test('builds the report address only from digit-only ids', () => {
    expect(svc.reportUrl('13751981', '5001')).toBe('https://www.myfloridalicense.com/inspectionDetail.asp?InspVisitID=13751981&id=5001');
    expect(svc.reportUrl('1&x=2', '5001')).toBeNull();
    expect(svc.reportUrl('1', '../5001')).toBeNull();
    expect(svc.reportUrl('1', null)).toBeNull();
  });
});

describe('syncRestaurantProspects', () => {
  const NOW = new Date('2026-11-19T15:00:00Z');
  let store;
  let upserts;
  let fetchText;
  const sleep = jest.fn(async () => {});

  function makeStore(pending) {
    upserts = [];
    return {
      upsertRecords: jest.fn(async (records) => { upserts.push(...records); return records.length; }),
      pendingInspections: jest.fn(async () => pending),
      saveReport: jest.fn(async () => {}),
      bumpAttempts: jest.fn(async () => {}),
    };
  }
  const files = {
    '7fdinspi.csv': () => inspCsv([inspRow({ visit: '9001' }), inspRow({ visit: '9001' }), inspRow({ visit: '9002', county: 'Hillsborough' })]),
    'newfood.csv': () => licCsv([licRow({ app: '7001' })]),
    'chgownr_food.csv': () => licCsv([licRow({ app: '7001' })]),
  };
  function makeFetch(overrides = {}) {
    return jest.fn(async (url) => {
      const name = url.split('/').pop();
      const body = (overrides[name] || files[name] || (() => { throw new Error('unexpected url'); }))();
      if (body instanceof Error) throw body;
      return body;
    });
  }
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DBPR_PROSPECT_SYNC_DISABLED;
  });
  afterAll(() => { delete process.env.DBPR_PROSPECT_SYNC_DISABLED; });

  test('upserts every kind under its own key, once per (kind, source_key), then reads pending reports', async () => {
    store = makeStore([]);
    fetchText = makeFetch();
    const result = await svc.syncRestaurantProspects({ fetchText, sleep, store, now: NOW });
    expect(upserts.map((r) => `${r.kind}:${r.source_key}`)).toEqual(['inspection:9001', 'new_license:7001', 'owner_change:7001']);
    expect(result).toMatchObject({ failures: 0, reportsRead: 0, reportsFailed: 0 });
    expect(result.files.inspection).toEqual({ kept: 1, upserted: 1 });
  });

  test('reads reports for the last 45 days, newest first, at most 100, one request a second', async () => {
    store = makeStore(Array.from({ length: 3 }, (_, i) => ({ id: `id${i}`, source_key: `${9000 + i}`, license_id: '5001' })));
    fetchText = jest.fn(async (url) => {
      if (url.includes('inspectionDetail.asp')) return url.includes('9001') ? fixture('report-35b.html') : fixture('report-35a.html');
      return (files[url.split('/').pop()])();
    });
    const result = await svc.syncRestaurantProspects({ fetchText, sleep, store, now: NOW });
    expect(store.pendingInspections).toHaveBeenCalledWith({ cutoff: '2026-10-05', limit: 100 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(store.saveReport.mock.calls.map(([id, r]) => [id, r.pestEvidence])).toEqual([['id0', true], ['id1', false], ['id2', true]]);
    expect(result).toMatchObject({ reportsRead: 3, reportsFailed: 0, pestFound: 2 });
    const reportCalls = fetchText.mock.calls.filter(([u]) => u.includes('inspectionDetail.asp'));
    expect(reportCalls[0][0]).toBe('https://www.myfloridalicense.com/inspectionDetail.asp?InspVisitID=9000&id=5001');
    expect(reportCalls[0][1]).toBeGreaterThan(0);
  });

  test('a failed or unreadable report adds one attempt and leaves pest_evidence alone; a bad id makes no request', async () => {
    store = makeStore([
      { id: 'a', source_key: '9000', license_id: '5001' },
      { id: 'b', source_key: '9001', license_id: '5001' },
      { id: 'c', source_key: '9002; DROP', license_id: '5001' },
      { id: 'd', source_key: '9003', license_id: '5001' },
    ]);
    fetchText = jest.fn(async (url) => {
      if (url.includes('InspVisitID=9000')) throw new Error('HTTP 503');
      if (url.includes('InspVisitID=9001')) return '<html>error page</html>';
      if (url.includes('inspectionDetail.asp')) return fixture('report-35b.html');
      return files[url.split('/').pop()]();
    });
    const result = await svc.syncRestaurantProspects({ fetchText, sleep, store, now: NOW });
    expect(store.bumpAttempts.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(store.saveReport.mock.calls.map(([id]) => id)).toEqual(['d']);
    expect(fetchText.mock.calls.filter(([u]) => u.includes('inspectionDetail.asp'))).toHaveLength(3);
    expect(result).toMatchObject({ reportsRead: 1, reportsFailed: 3 });
  });

  test('a failed download is logged by count, other files still load, and nothing throws', async () => {
    store = makeStore([]);
    fetchText = makeFetch({ 'newfood.csv': () => new Error('HTTP 403 for SAMPLE DINER'), 'chgownr_food.csv': () => '<html>Not a CSV</html>' });
    const result = await svc.syncRestaurantProspects({ fetchText, sleep, store, now: NOW });
    expect(result.failures).toBe(2);
    expect(result.files.new_license).toEqual({ failed: true });
    expect(result.files.owner_change).toEqual({ failed: true });
    expect(upserts.map((r) => r.kind)).toEqual(['inspection']);
    const logged = [...logger.warn.mock.calls, ...logger.info.mock.calls].map((c) => c[0]).join('\n');
    expect(logged).not.toMatch(/SAMPLE DINER|SAMPLE TRL/);
  });

  test('a database failure goes into the result, never out of the sync', async () => {
    store = makeStore([]);
    store.pendingInspections.mockRejectedValue(new Error('connection lost'));
    const result = await svc.syncRestaurantProspects({ fetchText: makeFetch(), sleep, store, now: NOW });
    expect(result.failures).toBe(1);
  });

  test.each(['1', 'true', 'ON'])('DBPR_PROSPECT_SYNC_DISABLED=%s makes the sync a no-op', async (value) => {
    process.env.DBPR_PROSPECT_SYNC_DISABLED = value;
    store = makeStore([]);
    fetchText = makeFetch();
    const result = await svc.syncRestaurantProspects({ fetchText, sleep, store, now: NOW });
    expect(result.skipped).toBe('disabled');
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.upsertRecords).not.toHaveBeenCalled();
  });

  test('the Monday job runs under its own lease and a deploy-kill retry', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    expect(src).toMatch(/cron\.schedule\('36 10 \* \* 1', \(\) => runRestaurantProspectSyncTick\(\), \{ timezone: 'America\/New_York' \}\)/);
    expect(src).toMatch(/runExclusive\('restaurant-prospect-sync', \(\) => require\('\.\/prospects\/dbpr-restaurants'\)\.syncRestaurantProspects\(\)\)/);
    expect(src).toMatch(/registerDeployKillRetry\('restaurant-prospect-sync'/);
  });
});
