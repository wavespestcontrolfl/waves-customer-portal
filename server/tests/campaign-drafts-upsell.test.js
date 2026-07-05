/**
 * Upsell campaign draft generator (campaign-drafts V1).
 *
 * Pins:
 *  - reads status='identified' opportunities for LIVE customers only
 *    (pipeline_stage in CUSTOMER_STAGES, active, not soft-deleted)
 *  - never re-pitches: source_ref draft dedupe + non-identified row for the
 *    same customer+service both skip
 *  - unified 30d cooldown: campaign drafts, campaign-grade sms_log types, and
 *    prepay renewal notices all suppress
 *  - prefs guard: sms_enabled=false or seasonal_tips=false skips
 *  - gate off = shadow mode: candidate count only, zero drafts
 *  - deterministic GSM-7 copy with a reply CTA; no LLM
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const { CUSTOMER_STAGES } = require('../services/customer-stages');
const {
  generateUpsellDrafts,
  toGsm7Safe,
  CAMPAIGN_SMS_TYPES,
  _internals: { UPSELL_COPY, buildUpsellBody, serviceCountFromReason },
} = require('../services/campaign-drafts');

const inserts = [];
const builders = [];
function makeBuilder(table, cfg = {}) {
  const b = { _table: table };
  for (const m of [
    'join', 'leftJoin', 'whereIn', 'whereNull', 'whereNotNull', 'whereNot',
    'orWhere', 'orWhereNull', 'orderBy', 'select', 'groupBy', 'limit',
  ]) b[m] = jest.fn(() => b);
  b.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(b, b);
    return b;
  });
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.insert = jest.fn((payload) => { b._mode = 'insert'; inserts.push({ table, payload }); return b; });
  b.then = (resolve, reject) => {
    const value = b._mode === 'insert' ? (cfg.insert ?? [1])
      : b._mode === 'first' ? cfg.first
        : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  builders.push(b);
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

function opportunity(overrides = {}) {
  return {
    opportunity_id: 'opp-1',
    customer_id: 'cust-1',
    recommended_service: 'lawn_care',
    reason: 'Has pest but no lawn - bundling saves 15% with WaveGuard Gold',
    first_name: 'Dana',
    // Customer columns the source query selects and injects into the shared
    // pre-send gate (the join already filtered on live-customer values).
    customer_active: true,
    customer_pipeline_stage: 'active_customer',
    customer_deleted_at: null,
    customer_churned_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  // NOTE: clearAllMocks does NOT clear the once-style queues — reset them here.
  jest.clearAllMocks();
  inserts.length = 0;
  builders.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  db.raw.mockImplementation((expr) => expr);
  isEnabled.mockReturnValue(true);
});

describe('source query', () => {
  test('reads identified opportunities for live customers only', async () => {
    enqueue('upsell_opportunities as uo', { rows: [] });

    await generateUpsellDrafts();

    const src = builders.find((b) => b._table === 'upsell_opportunities as uo');
    expect(src.where).toHaveBeenCalledWith('uo.status', 'identified');
    expect(src.where).toHaveBeenCalledWith('c.active', true);
    expect(src.whereNull).toHaveBeenCalledWith('c.deleted_at');
    expect(src.whereIn).toHaveBeenCalledWith('c.pipeline_stage', CUSTOMER_STAGES);
    expect(src.whereNotNull).toHaveBeenCalledWith('c.phone');
  });
});

describe('gate on — drafts', () => {
  test('writes a pending upsell draft with campaign fields and GSM-7 copy', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    // guards all pass: source_ref dedupe, pitched-row check, prefs, cooldowns
    // default to empty.

    const result = await generateUpsellDrafts();

    expect(result).toMatchObject({ gate: 'on', candidates: 1, drafted: 1 });
    expect(inserts).toHaveLength(1);
    const { table, payload } = inserts[0];
    expect(table).toBe('message_drafts');
    expect(payload).toMatchObject({
      customer_id: 'cust-1',
      status: 'pending',
      campaign_type: 'upsell',
      purpose: 'marketing',
      source_ref: 'upsell_opportunities:opp-1',
    });
    expect(payload.draft_response).toMatch(/^Hi Dana, thanks for trusting Waves with your pest control/);
    expect(payload.draft_response).toMatch(/Reply here/);
    // GSM-7 safe: plain ASCII, straight apostrophes, no emoji/smart punctuation
    expect(payload.draft_response).toMatch(/^[\x20-\x7E]*$/);
  });

  test('one draft per customer per run', async () => {
    enqueue('upsell_opportunities as uo', {
      rows: [
        opportunity(),
        opportunity({ opportunity_id: 'opp-2', recommended_service: 'termite_monitoring' }),
      ],
    });

    const result = await generateUpsellDrafts();

    expect(result.drafted).toBe(1);
    expect(result.skipped.customer_already_in_run).toBe(1);
    expect(inserts).toHaveLength(1);
  });

  test('unknown recommended_service is skipped (no template, no draft)', async () => {
    enqueue('upsell_opportunities as uo', {
      rows: [opportunity({ recommended_service: 'jet_ski_detailing' })],
    });

    const result = await generateUpsellDrafts();

    expect(result).toMatchObject({ candidates: 0, drafted: 0 });
    expect(result.skipped.no_template).toBe(1);
    expect(inserts).toEqual([]);
  });
});

describe('never-re-pitch reconciliation', () => {
  test('an opportunity that already produced a draft (source_ref) is skipped', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: { id: 'draft-old' } }); // source_ref hit

    const result = await generateUpsellDrafts();

    expect(result).toMatchObject({ candidates: 0, drafted: 0 });
    expect(result.skipped.already_drafted).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('a pitched row for the same customer+service blocks re-pitching', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: undefined }); // no prior draft
    enqueue('upsell_opportunities', { first: { id: 'opp-pitched' } }); // pitched/accepted/declined/deferred

    const result = await generateUpsellDrafts();

    expect(result).toMatchObject({ candidates: 0, drafted: 0 });
    expect(result.skipped.already_pitched).toBe(1);
    expect(inserts).toEqual([]);
  });
});

describe('guards', () => {
  test('sms_enabled=false skips', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: undefined });
    enqueue('upsell_opportunities', { first: undefined });
    enqueue('notification_prefs', { first: { sms_enabled: false, seasonal_tips: true } });

    const result = await generateUpsellDrafts();

    expect(result.skipped.prefs_opted_out).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('seasonal_tips=false skips', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: undefined });
    enqueue('upsell_opportunities', { first: undefined });
    enqueue('notification_prefs', { first: { sms_enabled: true, seasonal_tips: false } });

    const result = await generateUpsellDrafts();

    expect(result.skipped.prefs_opted_out).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('recent campaign draft (any campaign lane) suppresses for 30d', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: undefined }); // source_ref dedupe: clean
    enqueue('upsell_opportunities', { first: undefined });
    enqueue('message_drafts', { first: { id: 'draft-recent' } }); // cooldown hit

    const result = await generateUpsellDrafts();

    expect(result.skipped.recent_campaign_draft).toBe(1);
    expect(inserts).toEqual([]);
  });

  test('recent campaign-grade sms_log row suppresses (cross-lane dedupe)', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: undefined });
    enqueue('upsell_opportunities', { first: undefined });
    enqueue('message_drafts', { first: undefined });
    enqueue('sms_log', { first: { id: 'sms-1' } });

    const result = await generateUpsellDrafts();

    expect(result.skipped.recent_campaign_sms).toBe(1);
    expect(inserts).toEqual([]);

    // The cross-lane message types cover all five existing senders.
    // 'retention' = Customer-Intel retention approvals (admin-customer-intel
    // logs original_message_type 'retention'), distinct from the retention
    // agent's 'retention_outreach' — Codex round-3 finding.
    const smsBuilder = builders.find((b) => b._table === 'sms_log');
    expect(smsBuilder.whereIn).toHaveBeenCalledWith('message_type', CAMPAIGN_SMS_TYPES);
    expect(CAMPAIGN_SMS_TYPES.sort()).toEqual(['reactivation', 'renewal', 'retention', 'retention_outreach', 'upsell'].sort());
  });

  test('recent annual-prepay renewal notice suppresses', async () => {
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });
    enqueue('message_drafts', { first: undefined });
    enqueue('upsell_opportunities', { first: undefined });
    enqueue('message_drafts', { first: undefined });
    enqueue('sms_log', { first: undefined });
    enqueue('annual_prepay_terms', { first: { id: 'apt-1' } });

    const result = await generateUpsellDrafts();

    expect(result.skipped.recent_prepay_notice).toBe(1);
    expect(inserts).toEqual([]);
  });
});

describe('gate off — shadow mode', () => {
  test('logs candidate count, writes zero drafts', async () => {
    isEnabled.mockReturnValue(false);
    enqueue('upsell_opportunities as uo', { rows: [opportunity()] });

    const result = await generateUpsellDrafts();

    expect(result).toMatchObject({ gate: 'off', candidates: 1, drafted: 0 });
    expect(inserts).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/shadow: 1 upsell draft candidate/));
  });
});

describe('copy — deterministic GSM-7 templates', () => {
  test('every template renders ASCII-only copy with a soft reply CTA', () => {
    for (const [service, template] of Object.entries(UPSELL_COPY)) {
      const body = template({ firstName: 'Dana', serviceCount: 3 });
      expect(body).toMatch(/^[\x20-\x7E]*$/); // plain ASCII: no emoji, no smart punctuation
      expect(body).toMatch(/Reply here/);
      expect(body.length).toBeLessThanOrEqual(320); // ~2 SMS segments max
      expect(service).toBeTruthy();
    }
  });

  test('tier-upgrade copy surfaces the true service count from the reason field', () => {
    expect(serviceCountFromReason('Has 3 services on Bronze - Silver saves 10%')).toBe(3);
    expect(serviceCountFromReason('unrelated')).toBeNull();

    const body = buildUpsellBody(opportunity({
      recommended_service: 'tier_upgrade_silver',
      reason: 'Has 3 services on Bronze - Silver saves 10%',
    }));
    expect(body).toMatch(/3 services/);
  });

  test('toGsm7Safe normalizes smart punctuation', () => {
    expect(toGsm7Safe('“Hi” — it’s us… now')).toBe('"Hi" - it\'s us... now');
    expect(toGsm7Safe(null)).toBe('');
  });
});
