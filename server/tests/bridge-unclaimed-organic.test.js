/**
 * attributeUnclaimedBridgeLeads — "attribute organic if the bridge hasn't
 * claimed it after N days".
 *
 * Calls to the Google Ads call-bridge target number are held out of organic
 * attribution at call time (the bridge gets first claim), but the bridge had
 * claimed ZERO calls ever while 57 leads/90d sat funnel-invisible. This job
 * declares leads still on a bridge-target lead_sources row (a claim repoints
 * lead_source_id, so claimed leads self-exclude) with no funnel row after the
 * window organic, via the normal recordCallPpcAttribution path.
 */

let listByTable = {};
let firstByTable = {};
const insertCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  const self = () => b;
  [
    'where', 'whereIn', 'whereRaw', 'whereNotNull', 'whereNotExists', 'whereNot',
    'select', 'orderBy', 'limit', 'onConflict', 'ignore', 'merge', 'update',
  ].forEach((m) => { b[m] = jest.fn(self); });
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.insert = jest.fn((row) => { insertCalls.push({ table, row }); return b; });
  b.then = (res, rej) => Promise.resolve(
    listByTable[table] !== undefined ? listByTable[table] : [1],
  ).then(res, rej);
  return b;
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({
  etDateString: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '2026-07-01'),
}));
// Bridge target = the shared Bradenton number, format-agnostic (mirrors
// google-call-bridge.isBridgeTargetNumber's last-10 semantics).
jest.mock('../services/ads/google-call-bridge', () => ({
  isBridgeTargetNumber: (p) => String(p || '').replace(/\D/g, '').endsWith('9413187612'),
}));

const { attributeUnclaimedBridgeLeads } = require('../services/ads/call-attribution');

const BRIDGE_SOURCE = {
  id: 'src-bridge',
  name: 'Website — Bradenton (city page)',
  source_type: 'main_site',
  twilio_phone_number: '+19413187612',
};
const OTHER_SOURCE = {
  id: 'src-parrish',
  name: 'Website — Parrish (city page)',
  source_type: 'main_site',
  twilio_phone_number: '+19412972817',
};

beforeEach(() => {
  jest.clearAllMocks();
  listByTable = {};
  firstByTable = {};
  insertCalls.length = 0;
});

describe('attributeUnclaimedBridgeLeads', () => {
  test('records an organic waves_website funnel row for an unclaimed bridge lead', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE, OTHER_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-1',
      customer_id: 'c1',
      service_interest: 'pest control',
      first_contact_at: '2026-06-11T14:00:00Z',
      created_at: '2026-06-11T14:00:00Z',
      lead_source_id: 'src-bridge',
    }];

    const res = await attributeUnclaimedBridgeLeads({ olderThanDays: 7 });

    expect(res).toEqual({ candidates: 1, recorded: 1, skipped: 0 });
    const row = insertCalls.find((c) => c.table === 'ad_service_attribution').row;
    expect(row).toMatchObject({
      lead_id: 'lead-1',
      customer_id: 'c1',
      lead_source: 'waves_website',       // main_site → shared map channel
      lead_source_detail: BRIDGE_SOURCE.name,
      funnel_stage: 'lead',
      is_paid: false,                     // unclaimed ⇒ organic
      lead_date: '2026-06-11',            // dated by the call, not the run
    });
  });

  test('customer-less lead is skipped by the no_customer gate (matches live call path)', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-anon', customer_id: null, created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 1 });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('no bridge-target lead_sources rows → no-op zeros', async () => {
    listByTable.lead_sources = [OTHER_SOURCE];
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 0, recorded: 0, skipped: 0 });
    expect(mockDb).not.toHaveBeenCalledWith('leads as l');
  });

  test('unmapped source_type fails closed — no funnel row', async () => {
    listByTable.lead_sources = [{ ...BRIDGE_SOURCE, source_type: 'tollfree' }];
    listByTable['leads as l'] = [{
      id: 'lead-1', customer_id: 'c1', created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 1 });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('an existing funnel row for the lead is not duplicated (dedupe via recordCallPpcAttribution)', async () => {
    listByTable.lead_sources = [BRIDGE_SOURCE];
    listByTable['leads as l'] = [{
      id: 'lead-1', customer_id: 'c1', created_at: '2026-06-01', lead_source_id: 'src-bridge',
    }];
    // recordCallPpcAttribution's lead_id lookup finds a row owned by another source
    firstByTable.ad_service_attribution = { id: 'asa-1', lead_source: 'google_ads' };
    const res = await attributeUnclaimedBridgeLeads();
    expect(res).toEqual({ candidates: 1, recorded: 0, skipped: 1 });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });
});

describe('scheduler wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');

  test('fallback runs INSIDE the 6:20 bridge cron, after applyBridge, under one shared lease', () => {
    // One cron body, one runExclusive: the fallback can never run while a
    // bridge scan is mid-claim, and a deploy-overlap instance skips the pair
    // atomically — never the fallback without the bridge.
    expect(src).toMatch(/runExclusive\('google-call-bridge-organic'/);
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 3000);
    const bridgeIdx = block.indexOf('applyBridge');
    const sweepIdx = block.indexOf('attributeUnclaimedBridgeLeads');
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(bridgeIdx); // strict order: claim, then fallback
    expect(block).toMatch(/BRIDGE_UNCLAIMED_ORGANIC_DISABLED/);
    expect(block).toMatch(/BRIDGE_UNCLAIMED_ORGANIC_DAYS/);
    // No separate fallback cron remains: exactly one require + one call site,
    // both inside this block.
    expect(src.match(/attributeUnclaimedBridgeLeads/g)).toHaveLength(2);
    expect(block.match(/attributeUnclaimedBridgeLeads/g)).toHaveLength(2);
  });

  test('fallback requires a COMPLETE healthy bridge pass — outage, row cap, or write failure blocks it', () => {
    const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 4500);
    expect(block).toMatch(/bridgeBlockedReason = 'scan_failed'/);
    expect(block).toMatch(/bridgeBlockedReason = 'row_cap_hit'/);
    expect(block).toMatch(/bridgeBlockedReason = 'bridge_write_failed'/);
    expect(block).toMatch(/if \(bridgeBlockedReason\)/);
    expect(block.indexOf('if (bridgeBlockedReason)')).toBeLessThan(block.indexOf('attributeUnclaimedBridgeLeads'));
  });

  test('manual admin bridge-apply is serialized under the same lease', () => {
    const adminSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-ads.js'), 'utf8');
    const applyBlock = adminSrc.split("'/call-bridge/apply'")[1].slice(0, 1200);
    expect(applyBlock).toMatch(/runExclusive\('google-call-bridge-organic'/);
    expect(applyBlock).toMatch(/status\(409\)/); // lease held → busy, not silent no-op
  });

  test('selection is limited to CALL leads (web leads got their funnel row at webhook time)', () => {
    const ca = fs.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    expect(ca).toMatch(/\.where\('l\.first_contact_channel', 'call'\)/);
  });
});
