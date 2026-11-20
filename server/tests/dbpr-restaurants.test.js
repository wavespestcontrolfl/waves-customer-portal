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
function inspRow({ county = 'Manatee', date = '11/16/2026', v35 = 1, visit = '9001', licenseId = '5001', name = 'SAMPLE DINER', city = 'BRADENTON', zip = '34208' } = {}) {
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
function licRow({ app = '7001', county = 'Sarasota', primary = '555-010-0000', mailCounty = '51', secondary = '941-555-0101', seats = '40', date = '11/12/2026', city = 'SARASOTA', zip = '34231-1234', line3 = '' } = {}) {
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

  test('an area row cut short before Violation 35 is counted, never passed over as a visit without code 35', () => {
    const short = inspRow({ visit: '9002' }).split(',').slice(0, 40).join(','); // ends at Violation 24
    const counts = { malformed: 0 }; // a caller's partial counter object gets the missing count
    expect(svc.parseInspectionRows(parseDbprCsv(inspCsv([inspRow(), short])), counts).map((r) => r.source_key)).toEqual(['9001']);
    expect(counts).toEqual({ malformed: 1, valid: 1 });
  });

  test('a row cut before its county is counted, never passed over as outside the area', () => {
    const short = inspRow({ visit: '9002' }).split(',').slice(0, 2).join(','); // ends at County Number
    const counts = { malformed: 0, valid: 0 };
    expect(svc.parseInspectionRows(parseDbprCsv(inspCsv([inspRow(), short])), counts).map((r) => r.source_key)).toEqual(['9001']);
    expect(counts).toEqual({ malformed: 1, valid: 1 });
  });

  test('every row in the area is checked whole, cited or not; a good one counts as good', () => {
    const rows = parseDbprCsv(inspCsv([
      inspRow({ visit: '9201', v35: 0 }), inspRow({ visit: '9202', v35: 0, date: '2026-10-20' }), inspRow({ visit: '9203', v35: '' }),
      inspRow({ visit: '9204', county: 'Polk', date: '2026-10-20' }),
    ]));
    const counts = { malformed: 0, valid: 0 };
    expect(svc.parseInspectionRows(rows, counts)).toEqual([]);
    expect(counts).toEqual({ malformed: 2, valid: 1 });
  });

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
    expect(counts).toEqual({ malformed: 5, valid: 1 });
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
      // A NUL inside the city is cleaned before the check, as it is before storing: 33983 alone does not exclude.
      inspRow({ visit: '9011', county: 'Charlotte', city: 'PUNTA\0GORDA', zip: '33983' }),
      // The shared county test (call-triage-flags.js): any case, with or without the word County.
      inspRow({ visit: '9009', county: 'SARASOTA COUNTY' }),
      inspRow({ visit: '9010', county: 'Lee County' }),
    ]));
    const out = svc.parseInspectionRows(rows);
    expect(out.map((r) => r.source_key)).toEqual(['9001', '9002', '9003', '9009']);
    expect(out[0]).toMatchObject({
      kind: 'inspection', license_id: '5001', license_number: 'SEA0000001', license_type_code: '2010', business_name: 'SAMPLE DINER',
      address: '200 SAMPLE TRL', city: 'BRADENTON', zip: '34208', county: 'Manatee', event_date: '2026-11-16',
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
      licRow({ app: '7005', line3: 'BLDG B', zip: ' 34236-0001' }),
    ]));
    const out = svc.parseLicenseRows(rows, 'new_license');
    expect(out.map((r) => r.source_key)).toEqual(['7001', '7003', '7005']);
    expect(out[2]).toMatchObject({ address: '200 SAMPLE TRL UNIT 3 BLDG B', zip: '34236' });
    expect(out[0]).toMatchObject({
      kind: 'new_license', license_number: 'SEA0000002', business_name: 'SAMPLE DINER', address: '200 SAMPLE TRL UNIT 3',
      city: 'SARASOTA', zip: '34231', county: 'Sarasota', phone: '9415550101', seats: 40, event_date: '2026-11-12',
      detail: { applicationType: 'Plan Review and Initial (COMBO SEAT)' },
    });
    expect(out[1].seats).toBeNull();
  });

  test('an application number longer than the key column, or a date that is not a real day, is skipped and counted', () => {
    const rows = parseDbprCsv(licCsv([
      licRow({ app: 'A'.repeat(40) }), licRow({ app: 'A'.repeat(41) }), licRow({ app: '' }), licRow({ app: '7009', county: 'Polk' }),
      licRow({ app: '7010', date: '02/30/2026' }), licRow({ app: '7011', date: '' }),
    ]));
    const counts = { malformed: 0 };
    expect(svc.parseLicenseRows(rows, 'new_license', counts).map((r) => r.source_key)).toEqual(['A'.repeat(40)]);
    expect(counts).toEqual({ malformed: 4, valid: 1 });
  });

  test('a row cut short is skipped and counted; an empty cell is still a cell', () => {
    const short = licRow({ app: '7002' }).split(',').slice(0, 27).join(','); // ends at Location County
    const noCounty = licRow({ app: '7003' }).split(',').slice(0, 26).join(','); // ends before Location County
    const rows = parseDbprCsv(licCsv([licRow({ app: '7001', seats: '' }), short, noCounty]));
    const counts = { malformed: 0, valid: 0 };
    expect(svc.parseLicenseRows(rows, 'new_license', counts).map((r) => [r.source_key, r.seats])).toEqual([['7001', null]]);
    expect(counts).toEqual({ malformed: 2, valid: 1 });
  });

  test('a NUL character becomes a space, so its insert batch still goes in', () => {
    const withNul = licRow({ app: '7002' }).replace('"SAMPLE DINER"', '"SAMPLE\0DINER"').replace('"200 SAMPLE TRL"', '"200 SAMPLE\0TRL"');
    const out = svc.parseLicenseRows(parseDbprCsv(licCsv([licRow(), withNul])), 'new_license');
    expect(out.map((r) => r.source_key)).toEqual(['7001', '7002']);
    expect(out[1]).toMatchObject({ business_name: 'SAMPLE DINER', address: '200 SAMPLE TRL UNIT 3' });
    expect(JSON.stringify(out)).not.toContain('\\u0000');
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
  let reads;
  let fetchText;

  function makeStore() {
    upserts = [];
    reads = {};
    return {
      upsertRecords: jest.fn(async (records) => { upserts.push(...records); return records.length; }),
      lastRead: jest.fn(async (kind) => reads[kind] || null),
      saveRead: jest.fn(async (kind, read) => { reads[kind] = read; }),
    };
  }
  const files = {
    '7fdinspi.csv': () => inspCsv([inspRow({ visit: '9001' }), inspRow({ visit: '9001' }), inspRow({ visit: '9002', county: 'Hillsborough' })]),
    'newfood.csv': () => licCsv([licRow({ app: '7001' })]),
    'chgownr_food.csv': () => licCsv([licRow({ app: '7001' })]),
  };
  // A fixed day (Thursday Nov 19, 2026, 10:36 AM ET), so the fiscal year and the freshness of the default rows never
  // depend on the day the tests run. A test may pass its own `now`.
  const NOW = new Date('2026-11-19T15:36:00Z');
  const sync = (deps) => svc.syncRestaurantProspects({ now: NOW, ...deps });
  // Both license files with one row on the given day, for a test with its own `now`.
  const licFiles = (date) => ({
    'newfood.csv': () => licCsv([licRow({ app: '7001', date })]),
    'chgownr_food.csv': () => licCsv([licRow({ app: '7001', date })]),
  });
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
    const result = await sync({ fetchText, store });
    expect(upserts.map((r) => `${r.kind}:${r.source_key}`)).toEqual(['inspection:9001', 'new_license:7001', 'owner_change:7001']);
    expect(result.failures).toBe(0);
    expect(result.files.inspection).toEqual({ kept: 1, malformed: 0, upserted: 1 });
  });

  test('a failed download is logged by count, other files still load, and nothing throws', async () => {
    store = makeStore();
    fetchText = makeFetch({ 'newfood.csv': () => new Error('HTTP 403 for SAMPLE DINER'), 'chgownr_food.csv': () => '<html>Not a CSV</html>' });
    const result = await sync({ fetchText, store });
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
    const result = await sync({ fetchText, store });
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
    const result = await sync({ fetchText, store });
    expect(result.files[kind]).toEqual({ failed: true });
    expect(result.failures).toBe(1);
    expect(upserts.some((r) => r.kind === kind)).toBe(false);
  });

  test('a file with a header and no rows fails; a file whose rows all fall outside the area does not', async () => {
    store = makeStore();
    fetchText = makeFetch({ '7fdinspi.csv': () => inspCsv([]), 'newfood.csv': () => licCsv([licRow({ county: 'Polk' })]) });
    const result = await sync({ fetchText, store, now: new Date('2026-11-19T15:36:00Z') });
    expect(result.failures).toBe(1);
    expect(result.files).toMatchObject({ inspection: { failed: true }, new_license: { kept: 0, malformed: 0 }, owner_change: { kept: 1 } });
  });

  test('in the first week of July a header alone is a new fiscal year, not a failed file', async () => {
    store = makeStore();
    fetchText = makeFetch({ ...licFiles('06/28/2030'), '7fdinspi.csv': () => inspCsv([]) });
    // Monday 1 July 2030, 10:36 AM ET; then Sunday 7 July late in the evening ET (already 8 July in UTC); then 8 July.
    for (const at of ['2030-07-01T14:36:00Z', '2030-07-08T03:30:00Z']) {
      const result = await sync({ fetchText, store, now: new Date(at) });
      expect(result.failures).toBe(0);
      expect(result.files.inspection).toEqual({ kept: 0, malformed: 0, upserted: 0 });
    }
    const later = await sync({ fetchText, store, now: new Date('2030-07-08T14:36:00Z') });
    expect(later.files.inspection).toEqual({ failed: true });
  });

  test('a file whose rows in the area all fail to parse fails; a good row beside a bad one does not', async () => {
    store = makeStore();
    fetchText = makeFetch({
      'newfood.csv': () => licCsv([licRow({ app: '7001', date: '2026-08-21' }), licRow({ app: '7002', date: '2026-08-22' })]),
      'chgownr_food.csv': () => licCsv([licRow({ app: '7003', date: '2026-08-21' }), licRow({ app: '7004' })]),
    });
    const result = await sync({ fetchText, store });
    expect(result.failures).toBe(1);
    expect(result.files).toMatchObject({ new_license: { failed: true }, owner_change: { kept: 1, malformed: 1 } });
  });

  test('good inspections that cite nothing, beside a malformed row, are a quiet week, not a failed file', async () => {
    store = makeStore();
    fetchText = makeFetch({ '7fdinspi.csv': () => inspCsv([inspRow({ visit: '9301', v35: 0 }), inspRow({ visit: '9302', date: 'not a date' })]) });
    const result = await sync({ fetchText, store });
    expect(result.failures).toBe(0);
    expect(result.files.inspection).toEqual({ kept: 0, malformed: 1, upserted: 0 });
  });

  test('a row wider than its header is malformed: an extra cell would shift the two report ids', async () => {
    store = makeStore();
    // An extra cell before the ids: License ID would read it, and Inspection Visit ID would read the License ID.
    const wide = inspRow({ visit: '9003' }).replace('"5001","9003"', '"0","5001","9003"');
    fetchText = makeFetch({ '7fdinspi.csv': () => inspCsv([inspRow({ visit: '9001' }), wide]) });
    const result = await sync({ fetchText, store });
    expect(result.files.inspection).toEqual({ kept: 1, malformed: 1, upserted: 1 });
    expect(upserts.filter((r) => r.kind === 'inspection').map((r) => r.source_key)).toEqual(['9001']);
  });

  test('a file without a column the parsers need is refused whole, and the other files still load', async () => {
    store = makeStore();
    fetchText = makeFetch({
      '7fdinspi.csv': () => files['7fdinspi.csv']().replace('"License ID"', '"License Ref"'),
      'newfood.csv': () => files['newfood.csv']().replace('"Location City"', '"Location Town"'),
    });
    const result = await sync({ fetchText, store });
    expect(result.files).toMatchObject({ inspection: { failed: true }, new_license: { failed: true }, owner_change: { kept: 1 } });
    expect(upserts.map((r) => r.kind)).toEqual(['owner_change']);
  });

  test('a database failure fails that file only: it goes into the result, never out of the sync', async () => {
    store = makeStore();
    store.upsertRecords.mockRejectedValueOnce(new Error('connection lost'));
    const result = await sync({ fetchText: makeFetch(), store });
    expect(result.failures).toBe(1);
    expect(result.files).toMatchObject({ inspection: { failed: true }, new_license: { kept: 1 }, owner_change: { kept: 1 } });
  });

  const visitsCsv = (count, date) => inspCsv(Array.from({ length: count }, (_, i) => inspRow({ visit: String(9001 + i), date })));

  test('a read with under 90% of the rows of the fullest complete read is short, every run until a full file comes back', async () => {
    store = makeStore();
    reads.inspection = { fiscalYear: '2026-07-01', rows: 20 };
    // 17 rows, every one whole: a download that stopped early on a row end.
    fetchText = makeFetch({ '7fdinspi.csv': () => visitsCsv(17) });
    const result = await sync({ fetchText, store });
    expect(result.files.inspection).toEqual({ kept: 17, malformed: 0, upserted: 17, short: true });
    expect(result.failures).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith('[dbpr-prospects] inspection file is short: 17 rows, the fullest complete read had 20');
    // A short read never becomes the measure: the same cut fails again.
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 20 });
    expect((await sync({ fetchText, store })).files.inspection.short).toBe(true);
    // A full file passes and moves the measure up.
    fetchText = makeFetch({ '7fdinspi.csv': () => visitsCsv(22) });
    expect((await sync({ fetchText, store })).failures).toBe(0);
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 22 });
  });

  test('90% passes without lowering the measure, and every row counts, kept or not', async () => {
    store = makeStore();
    reads.inspection = { fiscalYear: '2026-07-01', rows: 20 };
    // 18 rows: 2 kept, 16 outside the area.
    const rows = Array.from({ length: 18 }, (_, i) => inspRow({ visit: String(9001 + i), county: i < 2 ? 'Manatee' : 'Hillsborough' }));
    fetchText = makeFetch({ '7fdinspi.csv': () => inspCsv(rows) });
    const result = await sync({ fetchText, store });
    expect(result.files.inspection).toEqual({ kept: 2, malformed: 0, upserted: 2 });
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 20 });
  });

  test('a read belongs to the fiscal year of its rows: a late file is last year\'s, a file started over is measured afresh', async () => {
    store = makeStore();
    reads.inspection = { fiscalYear: '2026-07-01', rows: 20 };
    // July 6, 2027, and the state has not started the file over: its rows are last year's, one stray date aside.
    const late = [...Array.from({ length: 19 }, (_, i) => inspRow({ visit: String(9001 + i), date: '06/28/2027' })), inspRow({ visit: '9101', date: '07/02/2027' })];
    fetchText = makeFetch({ ...licFiles('07/02/2027'), '7fdinspi.csv': () => inspCsv(late) });
    expect((await sync({ fetchText, store, now: new Date('2027-07-06T15:36:00Z') })).failures).toBe(0);
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 20 });
    // Started over: 3 rows of the new year are its first measure, not a short read.
    fetchText = makeFetch({ ...licFiles('07/12/2027'), '7fdinspi.csv': () => visitsCsv(3, '07/06/2027') });
    const restarted = await sync({ fetchText, store, now: new Date('2027-07-13T15:36:00Z') });
    expect(restarted.files.inspection).toEqual({ kept: 3, malformed: 0, upserted: 3 });
    expect(reads.inspection).toEqual({ fiscalYear: '2027-07-01', rows: 3 });
    // Under 20 rows in the measure the check waits: 1 row after 19 passes.
    reads.inspection = { fiscalYear: '2027-07-01', rows: 19 };
    fetchText = makeFetch({ ...licFiles('07/19/2027'), '7fdinspi.csv': () => visitsCsv(1, '07/15/2027') });
    expect((await sync({ fetchText, store, now: new Date('2027-07-20T15:36:00Z') })).failures).toBe(0);
  });

  test('a read is saved only after every row is stored: a failed write keeps the measure', async () => {
    store = makeStore();
    reads.inspection = { fiscalYear: '2026-07-01', rows: 20 };
    // The inspection rows fail to store; the other two files store.
    store.upsertRecords.mockImplementation(async (records) => {
      if (records.some((record) => record.kind === 'inspection')) throw new Error('connection lost');
      return records.length;
    });
    // 22 rows: a full read, so only the failed write keeps it from becoming the measure.
    fetchText = makeFetch({ '7fdinspi.csv': () => visitsCsv(22) });
    const result = await sync({ fetchText, store });
    expect(result.files.inspection).toEqual({ failed: true });
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 20 });
    expect(store.saveRead).not.toHaveBeenCalledWith('inspection', expect.anything());
    expect(store.saveRead).toHaveBeenCalledWith('new_license', { fiscalYear: '2026-07-01', rows: 1 });
  });

  test('in July a header alone fails once a read of the new year held a row; an older year\'s copy is stale', async () => {
    store = makeStore();
    // July 3, 2030: a read of the new year already held 100 rows, so a header alone is a cut download.
    reads.inspection = { fiscalYear: '2030-07-01', rows: 100 };
    fetchText = makeFetch({ ...licFiles('07/02/2030'), '7fdinspi.csv': () => inspCsv([]) });
    const now = new Date('2030-07-03T14:36:00Z');
    expect((await sync({ fetchText, store, now })).files.inspection).toEqual({ failed: true });
    // Only last year's measure: the header is the new year starting.
    reads.inspection = { fiscalYear: '2029-07-01', rows: 6700 };
    expect((await sync({ fetchText, store, now })).failures).toBe(0);
    // August: last year's copy after a read of the new year is stale. Its rows go in; the new year's measure stays.
    reads.inspection = { fiscalYear: '2030-07-01', rows: 50 };
    fetchText = makeFetch({ ...licFiles('08/01/2030'), '7fdinspi.csv': () => visitsCsv(20, '06/28/2030') });
    const stale = await sync({ fetchText, store, now: new Date('2030-08-05T14:36:00Z') });
    expect(stale.files.inspection).toEqual({ kept: 20, malformed: 0, upserted: 20, stale: true });
    expect(stale.failures).toBe(1);
    expect(reads.inspection).toEqual({ fiscalYear: '2030-07-01', rows: 50 });
    expect(logger.warn).toHaveBeenCalledWith('[dbpr-prospects] inspection file is stale: its rows are from the fiscal year that began 2029-07-01, after a read of 2030-07-01');
    // A cut copy of this year is still measured against the 50 rows.
    fetchText = makeFetch({ ...licFiles('08/10/2030'), '7fdinspi.csv': () => visitsCsv(10, '08/10/2030') });
    const cut = await sync({ fetchText, store, now: new Date('2030-08-12T14:36:00Z') });
    expect(cut.files.inspection.short).toBe(true);
  });

  test('a row dated after today is malformed and never stored; a file with no readable date, or none from the last 14 days, fails', async () => {
    store = makeStore();
    reads.inspection = { fiscalYear: '2026-07-01', rows: 20 };
    // One row dated after today (Nov 19, 2026) beside 21 good ones: it is malformed and never stored.
    const rows = [...Array.from({ length: 21 }, (_, i) => inspRow({ visit: String(9001 + i) })), inspRow({ visit: '9101', date: '11/20/2026' })];
    fetchText = makeFetch({ '7fdinspi.csv': () => inspCsv(rows) });
    expect((await sync({ fetchText, store })).files.inspection).toEqual({ kept: 21, malformed: 1, upserted: 21 });
    expect(upserts.map((record) => record.source_key)).not.toContain('9101');
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 22 });
    // A cut file whose one row has a mistyped year: no good row, so it fails and the measure stays.
    fetchText = makeFetch({ '7fdinspi.csv': () => visitsCsv(1, '03/02/2031') });
    expect((await sync({ fetchText, store })).files.inspection).toEqual({ failed: true });
    // A cut file of rows outside the area whose dates do not read: nothing to measure it by.
    fetchText = makeFetch({ '7fdinspi.csv': () => inspCsv([inspRow({ visit: '9001', county: 'Polk', date: '2026-11-16' })]) });
    expect((await sync({ fetchText, store })).files.inspection).toEqual({ failed: true });
    expect(reads.inspection).toEqual({ fiscalYear: '2026-07-01', rows: 22 });
    // Frozen: the newest row is 15 days old, and the state posts every day.
    fetchText = makeFetch({ '7fdinspi.csv': () => visitsCsv(22, '11/04/2026') });
    const frozen = await sync({ fetchText, store });
    expect(frozen.files.inspection).toEqual({ kept: 22, malformed: 0, upserted: 22, stale: true });
    expect(logger.warn).toHaveBeenCalledWith('[dbpr-prospects] inspection file is stale: no row from the last 14 days (newest 2026-11-04)');
    // 14 days old still passes.
    fetchText = makeFetch({ '7fdinspi.csv': () => visitsCsv(22, '11/05/2026') });
    expect((await sync({ fetchText, store })).failures).toBe(0);
  });

  test('a license row with a cell added or lost is malformed; the usual 36 cells and a full 38 load', async () => {
    store = makeStore();
    // 37 cells: an extra cell before Secondary Phone Number would move the phone and the license number.
    const added = licRow({ app: '7002' }).replace('"Sarasota","941-555-0101"', '"Sarasota","X","941-555-0101"');
    const lost = licRow({ app: '7003' }).replace('"UNIT 3",', ''); // 35 cells
    const full = `${licRow({ app: '7004' })},"1","1"`; // 38 cells: the two risk levels filled
    fetchText = makeFetch({ 'newfood.csv': () => licCsv([licRow({ app: '7001' }), added, lost, full]) });
    const result = await sync({ fetchText, store });
    expect(result.files.new_license).toEqual({ kept: 2, malformed: 2, upserted: 2 });
    expect(upserts.filter((r) => r.kind === 'new_license').map((r) => r.source_key)).toEqual(['7001', '7004']);
  });

  test('a short first row never hides a column: the file loads and the short row is counted', async () => {
    store = makeStore();
    const short = licRow({ app: '7002' }).split(',').slice(0, 27).join(',');
    fetchText = makeFetch({ 'newfood.csv': () => licCsv([short, licRow({ app: '7001' })]) });
    const result = await sync({ fetchText, store });
    expect(result.failures).toBe(0);
    expect(result.files.new_license).toEqual({ kept: 1, malformed: 1, upserted: 1 });
  });

  test.each(['1', 'true', 'ON'])('DBPR_PROSPECT_SYNC_DISABLED=%s makes the sync a no-op', async (value) => {
    process.env.DBPR_PROSPECT_SYNC_DISABLED = value;
    store = makeStore();
    fetchText = makeFetch();
    const result = await sync({ fetchText, store });
    expect(result.skipped).toBe('disabled');
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.upsertRecords).not.toHaveBeenCalled();
  });

  test('the Monday job runs under its own lease and a deploy-kill retry, and a failure fails the run', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    expect(src).toMatch(/cron\.schedule\('36 10 \* \* 1', \(\) => runRestaurantProspectSyncTick\(\), \{ timezone: 'America\/New_York' \}\)/);
    // The kill switch returns before the lease, so a run that did nothing never reads as a success in job_health.
    expect(src).toMatch(/const runRestaurantProspectSyncTick = async \(\) => \{\s*const prospects = require\('\.\/prospects\/dbpr-restaurants'\);\s*\/\/[^\n]*\n\s*if \(prospects\.syncDisabled\(\)\) return;\s*await runExclusive\('restaurant-prospect-sync', async \(\) => \{\s*const result = await prospects\.syncRestaurantProspects\(\);/);
    // A failed file or database call must read as a failed run in job_health: the leased callback throws (a count only).
    expect(src).toMatch(/if \(result\.failures > 0\) throw new Error\(`restaurant prospect sync: \$\{result\.failures\} failure\(s\)`\);/);
    expect(src).toMatch(/registerDeployKillRetry\('restaurant-prospect-sync'/);
    // Daily in the last week of June: the files start over on July 1.
    expect(src).toMatch(/cron\.schedule\('36 10 24-30 6 \*', \(\) => runRestaurantProspectSyncTick\(\), \{ timezone: 'America\/New_York' \}\)/);
  });
});
