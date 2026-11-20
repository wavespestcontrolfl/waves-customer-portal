/**
 * Weekly restaurant prospect sync (services/prospects/dbpr-restaurants.js): the three file parsers, the phone
 * rule for the swapped ownership-change columns, and the sync flow with fetch and the store faked. Fixtures are
 * synthetic: "SAMPLE DINER", "200 SAMPLE TRL".
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

const csvLine = (cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');

// Inspection extract: leading-space headers like the real file, 58 violation columns.
const INSP_HEAD = [
  'District', 'County Number', 'County Name', ' License Type Code', ' License Number', 'Business (DBA-Does Business As) Name',
  'Location Address', 'Location City', ' Location Zip Code', 'Inspection Number', 'Visit Number', 'Inspection Class',
  'Inspection Type', 'Inspection Disposition', 'Inspection Date', 'Number of High Priority Violations',
  ...Array.from({ length: 58 }, (_, i) => `Violation ${String(i + 1).padStart(2, '0')}`),
  'License ID', 'Inspection Visit ID',
];
function inspRow({ county = 'Manatee', date = '10/20/2026', v35 = 1, visit = '9001', licenseId = '5001', name = 'SAMPLE DINER', city = 'BRADENTON', zip = '34208' } = {}) {
  const v = Array.from({ length: 58 }, (_, i) => (i === 34 ? String(v35) : '0'));
  return csvLine(['D7', '41', county, '2010', 'SEA0000001', name, '200 SAMPLE TRL', city, zip, '1', '1', 'Food',
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
function licRow({ app = '7001', county = 'Sarasota', primary = '555-010-0000', mailCounty = '51', secondary = '941-555-0101', seats = '40', date = '08/21/2026', city = 'SARASOTA', zip = '34231-1234', line3 = '' } = {}) {
  return csvLine([app, 'Plan Review and Initial (COMBO SEAT)', date, '200', '2010', 'SAMPLE DINER LLC', 'SEAT', '', 'SAMPLE DINER LLC', '', '1 MAIL ST', ' ',
    'TAMPA', 'FL', '33601', primary, mailCounty, 'SAMPLE DINER', ' ', '200 SAMPLE TRL', 'UNIT 3', line3, city, 'FL', zip, '68', county,
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

  test('leaves out a row without both digit-only report ids, so a corrected copy in a later file can still enter', () => {
    const rows = parseDbprCsv(inspCsv([
      inspRow({ visit: '9101' }),
      inspRow({ visit: '9102', licenseId: '' }),
      inspRow({ visit: '9103', licenseId: '50-01' }),
      inspRow({ visit: '91O4' }),
      inspRow({ visit: '' }),
      inspRow({ visit: '9105', licenseId: '1234567890123' }),
    ]));
    const counts = { malformed: 0 };
    expect(svc.parseInspectionRows(rows, counts).map((r) => [r.source_key, r.license_id])).toEqual([['9101', '5001']]);
    expect(counts.malformed).toBe(5);
  });

  test('keeps only code-35 visits in the three counties outside Punta Gorda, with trimmed headers and a plain date', () => {
    const rows = parseDbprCsv(inspCsv([
      inspRow({ visit: '9001' }),
      inspRow({ visit: '9002', county: 'Sarasota' }),
      inspRow({ visit: '9003', county: 'Charlotte', city: 'PORT CHARLOTTE', zip: '33952' }),
      inspRow({ visit: '9004', county: 'Hillsborough' }),
      inspRow({ visit: '9005', v35: 0 }),
      inspRow({ visit: '9006', date: 'not a date' }),
      // Punta Gorda is not served (owner ruling 2026-10-22): by city name, or by a ZIP only Punta Gorda uses.
      inspRow({ visit: '9007', county: 'Charlotte', city: 'PUNTA GORDA', zip: '33983' }),
      inspRow({ visit: '9008', county: 'Charlotte', city: '', zip: '33950' }),
      // The shared county test (call-triage-flags.js): any case, with or without the word County.
      inspRow({ visit: '9009', county: 'SARASOTA COUNTY' }),
      inspRow({ visit: '9010', county: 'Lee County' }),
    ]));
    const out = svc.parseInspectionRows(rows);
    expect(out.map((r) => r.source_key)).toEqual(['9001', '9002', '9003', '9009']);
    expect(out[0]).toMatchObject({
      kind: 'inspection', license_id: '5001', license_number: 'SEA0000001', license_type_code: '2010', business_name: 'SAMPLE DINER',
      address: '200 SAMPLE TRL', city: 'BRADENTON', zip: '34208', county: 'Manatee', event_date: '2026-10-20',
      detail: { disposition: 'Warning Issued', inspectionType: 'Routine - Food', highPriority: 2 },
    });
  });
});

describe('parseLicenseRows and the phone rule', () => {
  const { parseDbprCsv } = require('../services/commercial-suite-size/dbpr-food-license');

  test('parses a relaxed-width file into records for the three counties, outside Punta Gorda', () => {
    const rows = parseDbprCsv(licCsv([
      licRow(), licRow({ app: '7002', county: 'Polk' }), licRow({ app: '7003', county: 'Charlotte', seats: '' }),
      licRow({ app: '7004', county: 'Charlotte', city: 'Punta Gorda', zip: '33982-0001' }),
      licRow({ app: '7005', line3: 'BLDG B' }),
    ]));
    const out = svc.parseLicenseRows(rows, 'new_license');
    expect(out.map((r) => r.source_key)).toEqual(['7001', '7003', '7005']);
    expect(out[2].address).toBe('200 SAMPLE TRL UNIT 3 BLDG B');
    expect(out[0]).toMatchObject({
      kind: 'new_license', license_number: 'SEA0000002', business_name: 'SAMPLE DINER', address: '200 SAMPLE TRL UNIT 3',
      city: 'SARASOTA', zip: '34231', county: 'Sarasota', phone: '9415550101', seats: 40, event_date: '2026-08-21',
      detail: { applicationType: 'Plan Review and Initial (COMBO SEAT)' },
    });
    expect(out[1].seats).toBeNull();
  });

  test('an application number longer than the key column is skipped and counted, never cut', () => {
    const rows = parseDbprCsv(licCsv([
      licRow({ app: 'A'.repeat(40) }), licRow({ app: 'A'.repeat(41) }), licRow({ app: '' }), licRow({ app: '7009', county: 'Polk' }),
    ]));
    const counts = { malformed: 0 };
    expect(svc.parseLicenseRows(rows, 'new_license', counts).map((r) => r.source_key)).toEqual(['A'.repeat(40)]);
    expect(counts.malformed).toBe(2);
  });

  test('a row cut short is skipped and counted; an empty cell is still a cell', () => {
    const short = licRow({ app: '7002' }).split(',').slice(0, 27).join(','); // ends at Location County
    const rows = parseDbprCsv(licCsv([licRow({ app: '7001', seats: '' }), short]));
    const counts = { malformed: 0 };
    expect(svc.parseLicenseRows(rows, 'new_license', counts).map((r) => [r.source_key, r.seats])).toEqual([['7001', null]]);
    expect(counts.malformed).toBe(1);
  });

  test('a seat count too big for the integer column is left blank, so its batch still inserts', () => {
    const rows = parseDbprCsv(licCsv([licRow({ seats: '999999999' }), licRow({ app: '7002', seats: '9999999999' })]));
    expect(svc.parseLicenseRows(rows, 'new_license').map((r) => r.seats)).toEqual([999999999, null]);
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

  test.each([
    ['941-555-0101 ext. 23', '9415550101'],
    ['(941) 555-0101 x 7', '9415550101'],
    ['941.555.0101 extension 4021', '9415550101'],
    ['941-555-0101 #12', '9415550101'],
    ['1-941-555-0101', '9415550101'],
  ])('pickPhone reads %s as %s: an extension never joins the number', (value, phone) => {
    expect(svc.pickPhone({ 'Secondary Phone Number': value })).toBe(phone);
  });

  test('a value that is not a valid US number is passed over for the next one', () => {
    // Twelve digits with no extension mark, a bad area code, and a long run of digits are not phones.
    expect(svc.pickPhone({ 'Secondary Phone Number': '941555010123', 'Primary Phone Number': '9415550177' })).toBe('9415550177');
    expect(svc.pickPhone({ 'Secondary Phone Number': '041-555-0101', 'Mailing County Code': '(813) 555-0110' })).toBe('8135550110');
    expect(svc.pickPhone({ 'Secondary Phone Number': '123456789012345', 'Primary Phone Number': '9415550177' })).toBe('9415550177');
    expect(svc.pickPhone({ 'Secondary Phone Number': '1-041-555-0101' })).toBeNull();
  });
});

describe('syncRestaurantProspects', () => {
  let store;
  let upserts;
  let fetchText;

  function makeStore() {
    upserts = [];
    return { upsertRecords: jest.fn(async (records) => { upserts.push(...records); return records.length; }) };
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

  test('upserts every kind under its own key, once per (kind, source_key)', async () => {
    store = makeStore();
    fetchText = makeFetch();
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(upserts.map((r) => `${r.kind}:${r.source_key}`)).toEqual(['inspection:9001', 'new_license:7001', 'owner_change:7001']);
    expect(result.failures).toBe(0);
    expect(result.files.inspection).toEqual({ kept: 1, malformed: 0, upserted: 1 });
  });

  test('a failed download is logged by count, other files still load, and nothing throws', async () => {
    store = makeStore();
    fetchText = makeFetch({ 'newfood.csv': () => new Error('HTTP 403 for SAMPLE DINER'), 'chgownr_food.csv': () => '<html>Not a CSV</html>' });
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(result.failures).toBe(2);
    expect(result.files.new_license).toEqual({ failed: true });
    expect(result.files.owner_change).toEqual({ failed: true });
    expect(upserts.map((r) => r.kind)).toEqual(['inspection']);
    const logged = [...logger.warn.mock.calls, ...logger.info.mock.calls].map((c) => c[0]).join('\n');
    expect(logged).not.toMatch(/SAMPLE DINER|SAMPLE TRL/);
  });

  test('rows skipped for a bad key are counted per file, and the log carries the count only', async () => {
    store = makeStore();
    fetchText = makeFetch({ 'newfood.csv': () => licCsv([licRow({ app: '7001' }), licRow({ app: 'X'.repeat(41) })]) });
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(result.failures).toBe(0);
    expect(result.files.new_license).toEqual({ kept: 1, malformed: 1, upserted: 1 });
    expect(logger.info.mock.calls.map((c) => c[0]).join('\n')).toMatch(/new_license=1\(1 malformed\)/);
  });

  test.each([
    ['Business (DBA-Does Business As) Name', '7fdinspi.csv', 'inspection'],
    ['Location Address', '7fdinspi.csv', 'inspection'],
    ['Business Name', 'newfood.csv', 'new_license'],
    ['Location Street Address', 'newfood.csv', 'new_license'],
    ['Primary Phone Number', 'chgownr_food.csv', 'owner_change'],
  ])('a renamed stored column (%s in %s) refuses that file whole, so blanks are never stored', async (column, name, kind) => {
    store = makeStore();
    fetchText = makeFetch({ [name]: () => files[name]().replace(`"${column}"`, `"${column} (renamed)"`) });
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(result.files[kind]).toEqual({ failed: true });
    expect(result.failures).toBe(1);
    expect(upserts.some((r) => r.kind === kind)).toBe(false);
  });

  test('a file without a column the parsers need is refused whole, and the other files still load', async () => {
    store = makeStore();
    fetchText = makeFetch({
      '7fdinspi.csv': () => files['7fdinspi.csv']().replace('"License ID"', '"License Ref"'),
      'newfood.csv': () => files['newfood.csv']().replace('"Location City"', '"Location Town"'),
    });
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(result.files).toMatchObject({ inspection: { failed: true }, new_license: { failed: true }, owner_change: { kept: 1 } });
    expect(upserts.map((r) => r.kind)).toEqual(['owner_change']);
  });

  test('a database failure fails that file only: it goes into the result, never out of the sync', async () => {
    store = makeStore();
    store.upsertRecords.mockRejectedValueOnce(new Error('connection lost'));
    const result = await svc.syncRestaurantProspects({ fetchText: makeFetch(), store });
    expect(result.failures).toBe(1);
    expect(result.files).toMatchObject({ inspection: { failed: true }, new_license: { kept: 1 }, owner_change: { kept: 1 } });
  });

  test('a short first row never hides a column: the file loads and the short row is counted', async () => {
    store = makeStore();
    const short = licRow({ app: '7002' }).split(',').slice(0, 27).join(',');
    fetchText = makeFetch({ 'newfood.csv': () => licCsv([short, licRow({ app: '7001' })]) });
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(result.failures).toBe(0);
    expect(result.files.new_license).toEqual({ kept: 1, malformed: 1, upserted: 1 });
  });

  test.each(['1', 'true', 'ON'])('DBPR_PROSPECT_SYNC_DISABLED=%s makes the sync a no-op', async (value) => {
    process.env.DBPR_PROSPECT_SYNC_DISABLED = value;
    store = makeStore();
    fetchText = makeFetch();
    const result = await svc.syncRestaurantProspects({ fetchText, store });
    expect(result.skipped).toBe('disabled');
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.upsertRecords).not.toHaveBeenCalled();
  });

  test('the Monday job runs under its own lease and a deploy-kill retry, and a failure fails the run', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    expect(src).toMatch(/cron\.schedule\('36 10 \* \* 1', \(\) => runRestaurantProspectSyncTick\(\), \{ timezone: 'America\/New_York' \}\)/);
    expect(src).toMatch(/runExclusive\('restaurant-prospect-sync', async \(\) => \{\s*const result = await require\('\.\/prospects\/dbpr-restaurants'\)\.syncRestaurantProspects\(\);/);
    // A failed file or database call must read as a failed run in job_health: the leased callback throws (a count only).
    expect(src).toMatch(/if \(result\.failures > 0\) throw new Error\(`restaurant prospect sync: \$\{result\.failures\} failure\(s\)`\);/);
    expect(src).toMatch(/registerDeployKillRetry\('restaurant-prospect-sync'/);
  });
});
