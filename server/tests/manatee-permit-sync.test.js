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
  jest.clearAllMocks();
});

// Chainable thenable query-builder stub: every method returns itself, and
// awaiting it resolves to `result`.
function builder(result) {
  const b = {};
  for (const m of ['whereNot', 'orderBy', 'first', 'where', 'orWhere', 'insert', 'onConflict', 'merge', 'count']) {
    b[m] = jest.fn(() => b);
  }
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

const CSV = '﻿"RECORD ID","RECORD STATUS","Applicant Job Value","Permit Issued Date","ADDR FULL BLOCK","NAME FML#","BUSINESS NAME","LICENSE NBR","NAME FULL","PARCEL NBR","RECORD TYPE","Type of Project"\r\n'
  + '"BLD2603-0892","Permit Issued","99678","3/11/2026","639 COTELLA CV\nBRADENTON, 34212","DUSTIN RAY POINTER","COAST TO COAST POOLS","CPC1457311","REAGAN FAMILY RANCH LLC","5567383090000-3472867879","Pool-Spa","Residential"\r\n'
  + '"BLD2603-3764","Closed","105758.00","4/7/2026","655 COTELLA CV\nBRADENTON, 34212","","AGNELLI POOLS & CONSTRUCTION LLC","CPC1457571","SMITH EXAMPLE","5567383140000-1111111111","Pool-Spa","Residential"\r\n'
  + '"BLD2604-9999","Canceled","1000","4/30/2026","100 EXAMPLE WAY\nPARRISH, 34219","","","","","1234567890000-2222222222","Pool-Spa","Residential"\r\n';

describe('CSV parse + normalization', () => {
  test('parses BOM, embedded-newline address blocks, city/zip, parcel pin', () => {
    const rows = parsePoolPermitCsv(CSV);
    expect(rows).toHaveLength(3);
    const first = rows[0];
    expect(first.record_id).toBe('BLD2603-0892');
    expect(first.record_status).toBe('Permit Issued');
    expect(first.address_line1).toBe('639 COTELLA CV');
    expect(first.city).toBe('BRADENTON');
    expect(first.zip).toBe('34212');
    expect(first.job_value).toBe(99678);
    expect(first.issued_date).toBe('2026-03-11');
    expect(first.parcel_pin).toBe('5567383090');
    expect(first.address_loose_key).toBe('639cotella34212');
    expect(first.contractor_name).toBe('COAST TO COAST POOLS');
  });

  test('Canceled rows are parsed and kept (exclusion is the READ side)', () => {
    const rows = parsePoolPermitCsv(CSV);
    expect(rows.map((r) => r.record_status)).toContain('Canceled');
  });

  test('rows without a record id are dropped', () => {
    expect(normalizeRow({ 'RECORD ID': '  ' })).toBeNull();
  });

  test('parcelPinFromRaw: 13-digit base parcel → 10-digit PIN; others keep digits', () => {
    expect(parcelPinFromRaw('5567383090000-3472867879')).toBe('5567383090');
    expect(parcelPinFromRaw('5817149090001-123')).toBe('5817149090001');
    expect(parcelPinFromRaw('')).toBeNull();
    expect(parcelPinFromRaw(null)).toBeNull();
  });
});

describe('loose address keys', () => {
  test('report side: house number + first street word + zip', () => {
    expect(looseAddressKey('658 COTELLA CV', '34212')).toBe('658cotella34212');
    expect(looseAddressKey('COTELLA CV', '34212')).toBeNull(); // no house number
    expect(looseAddressKey('658 COTELLA CV', '')).toBeNull(); // no zip
  });

  test('freeform side matches the report side across suffix spellings', () => {
    // The exact shared addressKey can NEVER match here ("cv" is not in the
    // suffix canon) — the loose key is the join that works.
    expect(looseKeyFromFreeform('658 Cotella Cove, Bradenton, FL 34212'))
      .toBe(looseAddressKey('658 COTELLA CV', '34212'));
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

describe('syncPoolPermits fetch + upsert (refresh mode)', () => {
  test('forwards tokens + CSRF headers, upserts parsed rows', async () => {
    process.env.GATE_PERMIT_SYNC = 'true';
    const countBuilder = builder({ n: '42' }); // non-empty table → refresh mode
    const insertBuilders = [];
    db.mockImplementation(() => {
      if (!db.mock.calls.length || db.mock.calls.length === 1) return countBuilder;
      const b = builder(1);
      insertBuilders.push(b);
      return b;
    });
    db.fn = { now: () => 'NOW()' };

    global.fetch = jest.fn()
      .mockResolvedValueOnce(acaResponse({ text: PARAM_PAGE, cookies: ['ASP.NET_SessionId=abc'] }))
      .mockResolvedValueOnce(acaResponse({ text: 'window.location.href = \'ShowReport.aspx?x\'' }))
      .mockResolvedValueOnce(acaResponse({ text: CSV, contentType: 'APPLICATION/CSV' }));

    const res = await syncPoolPermits();
    expect(res.mode).toBe('refresh');
    expect(res.windows).toBe(1);
    expect(res.fetched).toBe(3);
    expect(res.written).toBe(3);

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
    db.mockImplementation(() => builder({ n: '42' }));
    db.fn = { now: () => 'NOW()' };
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
      record_id: 'BLD2603-3764',
      record_status: 'Closed',
      issued_date: '2026-04-07',
    });
    db.mockImplementation(() => b);
    const permit = await findSyncedPoolPermit({ parcelPin: '5567383140', looseKey: '655cotella34212' });
    expect(permit).toEqual({
      permitNo: 'BLD2603-3764',
      type: 'Pool_Spa',
      issuedAt: '2026-04-07',
      status: 'Closed',
    });
    expect(b.whereNot).toHaveBeenCalledWith('record_status', 'Canceled');
  });
});

const UC_CSV = 'Permits Issued by Date Range\n\n<h1>Manatee County Building and Development Services</h1>\n\n"Permit","CurrentStatus","IssuedDate","Type","TypeofWork","Parcel","Owner","JobAddress","JobValue","Lic Number","LicType","BusContact","BusName","BusAddress","BusPhone"\n'
  + '"BLD2508-1704","Permit Issued","8/13/2026 ","Residential","New Single Family","6085387090000-3441044235","EXAMPLE PROPCO LLC","10550 GRAIN SILO TRL  PARRISH 34219"," 330000","CBC1268025","Building Contractor","PAT EXAMPLE","EXAMPLE HOMES INC.","1 EXAMPLE WAY BRADENTON FL 34212","5555550100"\n';

const CO_CSV = 'Certificates of Occupancy Issued by Date Range\n\n<h3>heading</h3>\n\n"Permit","Status","IssuedDate","CODate","Type","Parcel","Owner","JobAddress","JobValue","Lic Number","LicType","BusContact","BusName","BusAddress","BusPhone"\n'
  + '"BLD2508-1704","Closed","8/13/2026 ","2/1/2027","Residential","6085387090000-3441044235","EXAMPLE PROPCO LLC","10550 GRAIN SILO TRL  PARRISH 34219","330000 ","CBC1268025","Building Contractor","PAT EXAMPLE","EXAMPLE HOMES INC.","1 EXAMPLE WAY BRADENTON FL 34212","5555550100"\n';

describe('construction report parse', () => {
  const { _private: cp } = require('../services/property-lookup/manatee-permit-sync');

  test('under_construction: strips HTML preamble, trims padded dates, keys address', () => {
    const rows = cp.parseConstructionCsv(UC_CSV, 'under_construction');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.permit_no).toBe('BLD2508-1704');
    expect(r.status).toBe('Permit Issued');
    expect(r.type_of_work).toBe('New Single Family');
    expect(r.issued_date).toBe('2026-08-13');
    expect(r.co_date).toBeUndefined(); // absent key — the CO report owns it
    expect(r.zip).toBe('34219');
    expect(r.parcel_pin).toBe('6085387090');
    expect(r.address_loose_key).toBe('10550grain34219');
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
    db.mockImplementation(() => builder({
      permit_no: 'BLD2508-1704', status: 'Permit Issued', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: recentIso, co_date: null,
    }));
    const activity = await findConstructionActivity({ parcelPin: '6085387090' });
    expect(activity.underConstruction).toBe(true);
    expect(activity.newBuild).toBe(false);
  });

  test('recent CO → newBuild, not underConstruction', async () => {
    const coIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.mockImplementation(() => builder({
      permit_no: 'BLD2508-1704', status: 'Closed', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: '2026-01-05', co_date: coIso,
    }));
    const activity = await findConstructionActivity({ looseKey: '10550grain34219' });
    expect(activity.newBuild).toBe(true);
    expect(activity.underConstruction).toBe(false);
  });

  test('stale issued permit with no CO is NOT underConstruction (24-month window)', async () => {
    db.mockImplementation(() => builder({
      permit_no: 'BLD2201-0001', status: 'Permit Issued', permit_type: 'Residential',
      type_of_work: 'New Single Family', issued_date: '2022-01-05', co_date: null,
    }));
    const activity = await findConstructionActivity({ parcelPin: '6085387090' });
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

  test('a failing section is reported in errors and never sinks the other', async () => {
    process.env.GATE_PERMIT_SYNC = 'true';
    db.mockImplementation(() => builder({ n: '42' })); // both tables non-empty → refresh
    db.fn = { now: () => 'NOW()' };
    // Pool section: 3 good responses. Construction section: param page fetch throws.
    global.fetch = jest.fn()
      .mockResolvedValueOnce(acaResponse({ text: PARAM_PAGE }))
      .mockResolvedValueOnce(acaResponse({ text: 'ShowReport.aspx' }))
      .mockResolvedValueOnce(acaResponse({ text: CSV, contentType: 'APPLICATION/CSV' }))
      .mockRejectedValue(new Error('ECONNRESET'));
    const res = await syncPermits();
    expect(res.pool.fetched).toBe(3);
    expect(res.construction).toBeUndefined();
    expect(res.errors).toEqual([expect.stringContaining('construction: ')]);
  });
});

describe('county-permits merge', () => {
  test('synced closed permit surfaces when the open-permits GIS layer is empty', async () => {
    jest.resetModules();
    jest.doMock('../services/property-lookup/manatee-permit-sync', () => ({
      findSyncedPoolPermit: jest.fn(async () => ({
        permitNo: 'BLD2603-3764', type: 'Pool_Spa', issuedAt: '2026-04-07', status: 'Closed',
      })),
      looseKeyFromFreeform: jest.fn(() => '655cotella34212'),
    }));
    const { lookupPoolPermitsByParcel } = require('../services/property-lookup/county-permits');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    const result = await lookupPoolPermitsByParcel({
      county: 'Manatee',
      parcelId: '5567383140',
      address: '655 Cotella Cove, Bradenton, FL 34212',
    });
    expect(result.poolPermit).toMatchObject({ permitNo: 'BLD2603-3764', type: 'Pool_Spa' });
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
