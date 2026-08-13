/**
 * Manatee pool-permit sync (pool facts Step 3 — the closed-permit backstop).
 *
 * Pins: the CSV parse (quoted embedded-newline address blocks, BOM, city/zip
 * split, parcel-pin normalization, Canceled kept-but-excluded), the loose
 * address keys (report-abbreviated suffixes never match the shared
 * addressKey canon — that's WHY the loose key exists), the gate contract
 * (off → skipped before any fetch/DB read), the backfill-vs-refresh window
 * choice, the ACA fetch flow (tokens forwarded, CSRF headers, non-CSV
 * output rejected), and the county-permits merge (synced permit rides the
 * same keepNewest evidence flow; a DB failure never sinks GIS evidence).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  syncPoolPermits,
  findSyncedPoolPermit,
  looseAddressKey,
  looseKeyFromFreeform,
  _private: { parsePoolPermitCsv, normalizeRow, parcelPinFromRaw, windowsSince, hiddenValue, mdy },
} = require('../services/property-lookup/manatee-permit-sync');

const savedFetch = global.fetch;

afterEach(() => {
  global.fetch = savedFetch;
  delete process.env.GATE_PERMIT_SYNC;
  delete process.env.POOL_PERMIT_SYNC_START;
  delete process.env.CONSTRUCTION_PERMIT_SYNC_START;
  delete db.transaction;
  jest.clearAllMocks();
});

// Chainable thenable query-builder stub: every method returns itself, and
// awaiting it resolves to `result`.
function builder(result) {
  const b = {};
  for (const m of ['whereNot', 'orderBy', 'first', 'where', 'orWhere', 'insert', 'onConflict', 'merge', 'count', 'limit']) {
    b[m] = jest.fn(() => b);
  }
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

const CSV = '﻿"RECORD ID","RECORD STATUS","Applicant Job Value","Permit Issued Date","ADDR FULL BLOCK","NAME FML#","BUSINESS NAME","LICENSE NBR","NAME FULL","PARCEL NBR","RECORD TYPE","Type of Project"\r\n'
  + '"BLD9901-0001","Permit Issued","99678","3/11/2026","101 SAMPLE CV\nBRADENTON, 34212","PAT SAMPLE","EXAMPLE POOLS LLC","CPC0000001","OWNER EXAMPLE LLC","1234567890000-1111111111","Pool-Spa","Residential"\r\n'
  + '"BLD9901-0002","Closed","105758.00","4/7/2026","103 SAMPLE CV\nBRADENTON, 34212","","SAMPLE POOLS LLC","CPC0000002","OWNER TWO EXAMPLE","2345678901000-2222222222","Pool-Spa","Residential"\r\n'
  + '"BLD9901-0003","Canceled","1000","4/30/2026","100 EXAMPLE WAY\nPARRISH, 34219","","","","","3456789012000-3333333333","Pool-Spa","Residential"\r\n';

describe('CSV parse + normalization', () => {
  test('parses BOM, embedded-newline address blocks, city/zip, parcel pin', () => {
    const rows = parsePoolPermitCsv(CSV);
    expect(rows).toHaveLength(3);
    const first = rows[0];
    expect(first.record_id).toBe('BLD9901-0001');
    expect(first.record_status).toBe('Permit Issued');
    expect(first.address_line1).toBe('101 SAMPLE CV');
    expect(first.city).toBe('BRADENTON');
    expect(first.zip).toBe('34212');
    expect(first.job_value).toBe(99678);
    expect(first.issued_date).toBe('2026-03-11');
    expect(first.parcel_pin).toBe('1234567890');
    expect(first.address_loose_key).toBe('101sample34212');
    expect(first.contractor_name).toBe('EXAMPLE POOLS LLC');
  });

  test('Canceled rows are parsed and kept (exclusion is the READ side)', () => {
    const rows = parsePoolPermitCsv(CSV);
    expect(rows.map((r) => r.record_status)).toContain('Canceled');
  });

  test('rows without a record id are dropped', () => {
    expect(normalizeRow({ 'RECORD ID': '  ' })).toBeNull();
  });

  test('parcelPinFromRaw: 13-digit base parcel → 10-digit PIN; others keep digits', () => {
    expect(parcelPinFromRaw('1234567890000-1111111111')).toBe('1234567890');
    expect(parcelPinFromRaw('9876543210001-123')).toBe('9876543210001');
    expect(parcelPinFromRaw('')).toBeNull();
    expect(parcelPinFromRaw(null)).toBeNull();
  });
});

describe('loose address keys', () => {
  test('report side: house number + first street word + zip', () => {
    expect(looseAddressKey('658 SAMPLE CV', '34212')).toBe('658sample34212');
    expect(looseAddressKey('SAMPLE CV', '34212')).toBeNull(); // no house number
    expect(looseAddressKey('658 SAMPLE CV', '')).toBeNull(); // no zip
  });

  test('freeform side matches the report side across suffix spellings', () => {
    // The exact shared addressKey can NEVER match here ("cv" is not in the
    // suffix canon) — the loose key is the join that works.
    expect(looseKeyFromFreeform('658 Sample Cove, Bradenton, FL 34212'))
      .toBe(looseAddressKey('658 SAMPLE CV', '34212'));
  });

  test('freeform side: last 5-digit group is the zip, not a 5-digit house number', () => {
    expect(looseKeyFromFreeform('34205 Main St, Bradenton, FL 34210')).toBe('34205main34210');
    expect(looseKeyFromFreeform('34205 Main St')).toBeNull(); // house number ≠ zip anchor
  });
});

describe('windowsSince', () => {
  test('chunks start→now and clamps the final window to now', () => {
    const windows = windowsSince('2023-01-01', 6);
    expect(windows.length).toBeGreaterThan(5);
    expect(windows[0][0]).toBe('01/01/2023');
    expect(windows[0][1]).toBe('07/01/2023');
    const [, lastTo] = windows[windows.length - 1];
    expect(lastTo).toBe(mdy(new Date()));
  });
});

describe('syncPoolPermits gate contract', () => {
  test('gate off → skipped before any fetch or DB read', async () => {
    global.fetch = jest.fn();
    const res = await syncPoolPermits();
    expect(res).toEqual({ skipped: 'gated' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});

// Minimal ACA response fakes for the 3-step fetch flow.
function acaResponse({ text, contentType = 'text/html', cookies = [] }) {
  return {
    ok: true,
    text: async () => text,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null),
      getSetCookie: () => cookies,
    },
  };
}

const PARAM_PAGE = '<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS123" />'
  + '<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="B2C4EB51" />'
  + '<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="EV456" />'
  + '<input type="hidden" name="ACA_CS_FIELD" id="ACA_CS_FIELD" value="CSRF789" />';

// db.transaction mock: runs the callback with a trx that mirrors the db
// mock's chainable builders. Installed per-test alongside mockImplementation.
function installTransactionMock() {
  const trx = (table) => db(table);
  trx.fn = { now: () => 'NOW()' };
  db.transaction = jest.fn(async (cb) => cb(trx));
}

// One-window full-range sync: start "yesterday" via the env override.
function useSingleWindowSync() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  process.env.POOL_PERMIT_SYNC_START = yesterday;
  process.env.CONSTRUCTION_PERMIT_SYNC_START = yesterday;
}

describe('syncPoolPermits fetch + upsert', () => {
  test('forwards tokens + CSRF headers, upserts parsed rows in a transaction', async () => {
    process.env.GATE_PERMIT_SYNC = 'true';
    useSingleWindowSync();
    db.mockImplementation(() => builder(1));
    db.fn = { now: () => 'NOW()' };
    installTransactionMock();

    global.fetch = jest.fn()
      .mockResolvedValueOnce(acaResponse({ text: PARAM_PAGE, cookies: ['ASP.NET_SessionId=abc'] }))
      .mockResolvedValueOnce(acaResponse({ text: 'window.location.href = \'ShowReport.aspx?x\'' }))
      .mockResolvedValueOnce(acaResponse({ text: CSV, contentType: 'APPLICATION/CSV' }));

    const res = await syncPoolPermits();
    expect(res.windows).toBe(1);
    expect(res.fetched).toBe(3);
    expect(res.written).toBe(3);
    expect(db.transaction).toHaveBeenCalledTimes(1);

    // POST carried the page tokens and the CSRF headers ACA requires.
    const [, postInit] = global.fetch.mock.calls[1];
    expect(postInit.method).toBe('POST');
    expect(postInit.body).toContain('__VIEWSTATE=VS123');
    expect(postInit.body).toContain('ACA_CS_FIELD=CSRF789');
    expect(postInit.body).toContain('__EVENTTARGET=btnSave');
    expect(postInit.headers.Referer).toContain('ReportParameter.aspx');
    expect(postInit.headers.Origin).toBe('https://aca-prod.accela.com');
    // Session cookie from step 1 rode into step 3.
    const [, showInit] = global.fetch.mock.calls[2];
    expect(showInit.headers.Cookie).toContain('ASP.NET_SessionId=abc');
  });

  test('non-CSV report output throws (report moved/renamed → loud failure, not junk rows)', async () => {
    process.env.GATE_PERMIT_SYNC = 'true';
    useSingleWindowSync();
    db.mockImplementation(() => builder({ n: '42' }));
    db.fn = { now: () => 'NOW()' };
    installTransactionMock();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(acaResponse({ text: PARAM_PAGE }))
      .mockResolvedValueOnce(acaResponse({ text: 'ShowReport.aspx' }))
      .mockResolvedValueOnce(acaResponse({ text: '<html>login</html>' }));
    await expect(syncPoolPermits()).rejects.toThrow(/not CSV/);
  });
});

describe('findSyncedPoolPermit', () => {
  test('no identifiers → null without a DB call', async () => {
    expect(await findSyncedPoolPermit({})).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('row → permit shape with GIS-vocabulary type; Canceled excluded in the query', async () => {
    const b = builder({
      record_id: 'BLD9901-0002',
      record_status: 'Closed',
      issued_date: '2026-04-07',
    });
    db.mockImplementation(() => b);
    const permit = await findSyncedPoolPermit({ parcelPin: '2345678901', looseKey: '103sample34212' });
    expect(permit).toEqual({
      permitNo: 'BLD9901-0002',
      type: 'Pool_Spa',
      issuedAt: '2026-04-07',
      status: 'Closed',
    });
    expect(b.whereNot).toHaveBeenCalledWith('record_status', 'Canceled');
  });
});

const UC_CSV = 'Permits Issued by Date Range\n\n<h1>Manatee County Building and Development Services</h1>\n\n"Permit","CurrentStatus","IssuedDate","Type","TypeofWork","Parcel","Owner","JobAddress","JobValue","Lic Number","LicType","BusContact","BusName","BusAddress","BusPhone"\n'
  + '"BLD9902-0001","Permit Issued","8/13/2026 ","Residential","New Single Family","4567890123000-4444444444","EXAMPLE PROPCO LLC","200 SAMPLE TRL  PARRISH 34219"," 330000","CBC0000003","Building Contractor","PAT EXAMPLE","EXAMPLE HOMES INC.","1 EXAMPLE WAY BRADENTON FL 34212","5555550100"\n';

const CO_CSV = 'Certificates of Occupancy Issued by Date Range\n\n<h3>heading</h3>\n\n"Permit","Status","IssuedDate","CODate","Type","Parcel","Owner","JobAddress","JobValue","Lic Number","LicType","BusContact","BusName","BusAddress","BusPhone"\n'
  + '"BLD9902-0001","Closed","8/13/2026 ","2/1/2027","Residential","4567890123000-4444444444","EXAMPLE PROPCO LLC","200 SAMPLE TRL  PARRISH 34219","330000 ","CBC0000003","Building Contractor","PAT EXAMPLE","EXAMPLE HOMES INC.","1 EXAMPLE WAY BRADENTON FL 34212","5555550100"\n';

describe('construction report parse', () => {
  const { _private: cp } = require('../services/property-lookup/manatee-permit-sync');

  test('under_construction: strips HTML preamble, trims padded dates, keys address', () => {
    const rows = cp.parseConstructionCsv(UC_CSV, 'under_construction');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.permit_no).toBe('BLD9902-0001');
    expect(r.status).toBe('Permit Issued');
    expect(r.type_of_work).toBe('New Single Family');
    expect(r.issued_date).toBe('2026-08-13');
    expect(r.co_date).toBeUndefined(); // absent key — the CO report owns it
    expect(r.zip).toBe('34219');
    expect(r.parcel_pin).toBe('4567890123');
    expect(r.address_loose_key).toBe('200sample34219');
    expect(r.job_value).toBe(330000);
  });

  test('cos: carries co_date and omits type_of_work so the merge never nulls it', () => {
    const rows = cp.parseConstructionCsv(CO_CSV, 'cos');
    const r = rows[0];
    expect(r.co_date).toBe('2027-02-01');
    expect(r.status).toBe('Closed');
    expect(r.type_of_work).toBeUndefined();
  });

  test('missing CSV header throws (report moved → loud failure)', () => {
    expect(() => cp.stripReportPreamble('<html>login page</html>')).toThrow(/header not found/);
  });
});

describe('findConstructionActivity', () => {
  const { findConstructionActivity } = require('../services/property-lookup/manatee-permit-sync');

  test('no identifiers → null without a DB call', async () => {
    expect(await findConstructionActivity({})).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('issued recently with no CO → underConstruction evidence', async () => {
    const recentIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.mockImplementation(() => builder([{
      permit_no: 'BLD9902-0001', status: 'Permit Issued', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: recentIso, co_date: null,
      last_seen_at: new Date().toISOString(),
    }]));
    const activity = await findConstructionActivity({ parcelPin: '4567890123' });
    expect(activity.underConstruction).toBe(true);
    expect(activity.newBuild).toBe(false);
  });

  test('recent CO → newBuild, not underConstruction', async () => {
    const coIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.mockImplementation(() => builder([{
      permit_no: 'BLD9902-0001', status: 'Closed', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: '2026-01-05', co_date: coIso,
    }]));
    const activity = await findConstructionActivity({ looseKey: '200sample34219' });
    expect(activity.newBuild).toBe(true);
    expect(activity.underConstruction).toBe(false);
  });

  test('a permit the weekly re-sync stopped seeing is NOT underConstruction', async () => {
    const recentIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.mockImplementation(() => builder([{
      permit_no: 'BLD9902-0003', status: 'Permit Issued', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: recentIso, co_date: null,
      last_seen_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    }]));
    const activity = await findConstructionActivity({ parcelPin: '4567890123' });
    expect(activity.underConstruction).toBe(false);
  });

  test('stale issued permit with no CO is NOT underConstruction (24-month window)', async () => {
    db.mockImplementation(() => builder([{
      permit_no: 'BLD9902-0002', status: 'Permit Issued', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: '2022-01-05', co_date: null,
      last_seen_at: new Date().toISOString(),
    }]));
    const activity = await findConstructionActivity({ parcelPin: '4567890123' });
    expect(activity.underConstruction).toBe(false);
    expect(activity.newBuild).toBe(false);
  });
});

describe('syncPermits', () => {
  const { syncPermits } = require('../services/property-lookup/manatee-permit-sync');

  test('gate off → skipped before any fetch or DB read', async () => {
    global.fetch = jest.fn();
    expect(await syncPermits()).toEqual({ skipped: 'gated' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('a failing section never sinks the other, but the run THROWS so cron health sees it', async () => {
    process.env.GATE_PERMIT_SYNC = 'true';
    useSingleWindowSync();
    db.mockImplementation(() => builder(1));
    db.fn = { now: () => 'NOW()' };
    installTransactionMock();
    // Pool section: 3 good responses. Construction section: param page fetch throws.
    global.fetch = jest.fn()
      .mockResolvedValueOnce(acaResponse({ text: PARAM_PAGE }))
      .mockResolvedValueOnce(acaResponse({ text: 'ShowReport.aspx' }))
      .mockResolvedValueOnce(acaResponse({ text: CSV, contentType: 'APPLICATION/CSV' }))
      .mockRejectedValue(new Error('ECONNRESET'));
    // The pool section completed (fetch was called for all 3 pool steps +
    // the failing construction step) and its partial success is in the
    // error message — but the run still rejects so runExclusive/job health
    // records a failure instead of a silent success.
    await expect(syncPermits()).rejects.toThrow(/construction: .*ECONNRESET.*pool ok \(3 rows\)/);
    expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('county-permits merge', () => {
  test('synced closed permit surfaces when the open-permits GIS layer is empty', async () => {
    jest.resetModules();
    jest.doMock('../services/property-lookup/manatee-permit-sync', () => ({
      findSyncedPoolPermit: jest.fn(async () => ({
        permitNo: 'BLD9901-0002', type: 'Pool_Spa', issuedAt: '2026-04-07', status: 'Closed',
      })),
      looseKeyFromFreeform: jest.fn(() => '103sample34212'),
    }));
    const { lookupPoolPermitsByParcel } = require('../services/property-lookup/county-permits');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    const result = await lookupPoolPermitsByParcel({
      county: 'Manatee',
      parcelId: '2345678901',
      address: '103 Sample Cove, Bradenton, FL 34212',
    });
    expect(result.poolPermit).toMatchObject({ permitNo: 'BLD9901-0002', type: 'Pool_Spa' });
    expect(result.enclosurePermit).toBeNull();
    jest.dontMock('../services/property-lookup/manatee-permit-sync');
  });

  test('synced-table failure never sinks GIS evidence', async () => {
    jest.resetModules();
    jest.doMock('../services/property-lookup/manatee-permit-sync', () => ({
      findSyncedPoolPermit: jest.fn(async () => { throw new Error('relation does not exist'); }),
      looseKeyFromFreeform: jest.fn(() => null),
    }));
    const { lookupPoolPermitsByParcel } = require('../services/property-lookup/county-permits');
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        features: [{ attributes: { PERMIT_NO: 'BLD2601-0001', PERMIT_TYPE: 'Pool_Spa', PERMIT_ISSUE: Date.UTC(2026, 0, 5) } }],
      }),
    }));
    const result = await lookupPoolPermitsByParcel({ county: 'Manatee', parcelId: '1234567890' });
    expect(result.poolPermit).toMatchObject({ permitNo: 'BLD2601-0001' });
    jest.dontMock('../services/property-lookup/manatee-permit-sync');
  });
});
