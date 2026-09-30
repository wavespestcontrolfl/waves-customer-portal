// Dunning consolidation PR 1 (inert): the shared constants/key builders, the
// promotion seed (pure; the engine's `promote` and the dry-run script both
// call it), and the cadence helpers invoice-followups.js now exports for it.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {} }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));

const fs = require('fs');
const path = require('path');
const C = require('../services/customer-dunning/constants');
const Followups = require('../services/invoice-followups');
const { promotionSeed, oldestActive } = require('../services/customer-dunning/seed');

const SCHEDULE = { id: '3f2b1c9e-0000-4000-8000-00000000abcd', episode: 12 };

describe('key builders', () => {
  test('identity is (schedule id, episode, step id) — and only that', () => {
    expect(C.eventKey(SCHEDULE, 'd60_reminder')).toBe(`customer-dunning:${SCHEDULE.id}:12:d60_reminder`);
    expect(C.emailIdempotencyKey(SCHEDULE, 'd60_reminder')).toBe(`customer_dunning_email:${SCHEDULE.id}:12:d60_reminder`);
    expect(C.triggerEventId(SCHEDULE, 'd60_reminder')).toBe(`customer_dunning:${SCHEDULE.id}:12:d60_reminder`);
    expect(C.lockKey('cust-1')).toBe('customer-dunning:cust-1');
  });

  test('fixed length, far inside collections_contact_ledger.idempotency_key (120) and email_messages.trigger_event_id (260), whatever the set', () => {
    const steps = ['d3_friendly', 'd7_reminder', 'd14_firmer', 'd30_final', 'd60_reminder', 'd90_final_notice'];
    for (const stepId of steps) {
      for (const episode of [1, 9, 99, 999]) {
        const s = { id: SCHEDULE.id, episode };
        expect(C.emailIdempotencyKey(s, stepId).length).toBeLessThanOrEqual(120);
        expect(C.eventKey(s, stepId).length).toBeLessThanOrEqual(120);
        expect(C.triggerEventId(s, stepId).length).toBeLessThanOrEqual(260);
      }
    }
  });

  test('the three keys are distinct namespaces', () => {
    const keys = [C.eventKey(SCHEDULE, 'x'), C.emailIdempotencyKey(SCHEDULE, 'x'), C.triggerEventId(SCHEDULE, 'x')];
    expect(new Set(keys).size).toBe(3);
    expect(C.SOURCE).toBe('invoice_followups_customer');
  });
});

describe('statuses match the table', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260930010000_customer_dunning_schedules.js'), 'utf8');

  test('OPEN_STATUSES is exactly the partial unique index predicate', () => {
    const predicate = migration.match(/WHERE status IN \(([^)]*)\)/)[1];
    const inIndex = [...predicate.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(inIndex).toEqual([...C.OPEN_STATUSES]);
  });

  test('every status and closed reason the constants list is documented in the migration', () => {
    for (const status of C.SCHEDULE_STATUSES) expect(migration).toContain(status);
    for (const reason of C.CLOSED_REASONS) expect(migration).toContain(reason);
  });

  test('a claim goes stale after the same 10 minutes as the per-invoice claim', () => {
    expect(C.CLAIM_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe('invoice-followups.js exports the cadence helpers (no logic change)', () => {
  test.each([
    'computeNextTouchAt', 'anchorTo10amNY', 'sequenceAnchor', 'heldTouchFloor', 'adoptionLanding', 'isStaleTouch', 'firstEligibleFireAt',
  ])('%s is exported as a function', (name) => {
    expect(typeof Followups[name]).toBe('function');
  });

  test('FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID maps the Day 60/90 steps to their single-invoice emails', () => {
    expect(Followups.FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID).toMatchObject({
      d60_reminder: 'invoice.followup_60_day', d90_final_notice: 'invoice.followup_90_day',
    });
  });
});

describe('promotionSeed', () => {
  // Wed 2026-09-30 10:16 ET.
  const NOW = new Date('2026-09-30T14:16:00Z');
  const tenAmET = (isoDay) => new Date(`${isoDay}T14:00:00Z`); // 10:00 EDT

  beforeEach(() => { process.env.GATE_DUNNING_LADDER_90 = 'true'; });
  afterEach(() => { delete process.env.GATE_DUNNING_LADDER_90; });

  const row = (id, anchor, step_index, extra = {}) => ({
    id: `seq-${id}`, invoice_id: `inv-${id}`, anchor_at: new Date(anchor), step_index, touches_sent: step_index, last_touch_at: null, ...extra,
  });

  test('the 8c5c90c6-shaped case: A and B at Day 90 due Oct 20, C at Day 60 due Oct 13 => one Day 90 seed on Oct 20', () => {
    const seed = promotionSeed([
      row('C', '2026-08-14T15:00:00Z', 4), // Day 60 lands Oct 13
      row('A', '2026-07-22T15:00:00Z', 5), // Day 90 lands Oct 20
      row('B', '2026-07-24T15:00:00Z', 5),
    ], NOW);
    expect(seed).toMatchObject({ step_index: 5, step_id: 'd90_final_notice', oldest_invoice_id: 'inv-A' });
    expect(seed.next_touch_at).toEqual(tenAmET('2026-10-20'));
  });

  test('the seed follows the OLDEST active member\'s anchor, not the lowest step', () => {
    const seed = promotionSeed([row('young', '2026-09-20T15:00:00Z', 0), row('old', '2026-08-01T15:00:00Z', 2)], NOW);
    expect(seed.oldest_invoice_id).toBe('inv-old');
    // old: step 2 (Day 17) is Aug 18 -> stale; Day 30 Aug 31 -> stale; Day 60 Sep 30 is today's 10:00, due, not stale
    expect(seed.step_id).toBe('d60_reminder');
  });

  test('never sends in its own run: a step already due lands on the NEXT run, never earlier', () => {
    const seed = promotionSeed([row('a', '2026-08-31T15:00:00Z', 3), row('b', '2026-09-02T15:00:00Z', 1)], NOW);
    // Day 30 on the oldest = Sep 30 10:00 ET, i.e. 16 minutes ago (not stale) => tomorrow's run.
    expect(seed.step_id).toBe('d30_final');
    expect(seed.next_touch_at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(seed.next_touch_at).toEqual(tenAmET('2026-10-01'));
  });

  test('a stale step is passed over, not resent (never seeded from the minimum)', () => {
    const seed = promotionSeed([row('a', '2026-08-01T15:00:00Z', 0), row('b', '2026-08-03T15:00:00Z', 0)], NOW);
    expect(seed.step_index).toBeGreaterThanOrEqual(4);
    expect(seed.step_id).toBe('d60_reminder');
    // Day 60 on Aug 1 is Sep 30 10:00 ET: 16 minutes ago, not stale, so it moves to the next run.
    expect(seed.next_touch_at).toEqual(tenAmET('2026-10-01'));
  });

  test('the final notice is never skipped: every day past => the final step, on the next run', () => {
    const seed = promotionSeed([row('a', '2026-04-01T15:00:00Z', 0), row('b', '2026-04-02T15:00:00Z', 0)], NOW);
    expect(seed).toMatchObject({ step_index: 5, step_id: 'd90_final_notice' });
    expect(seed.next_touch_at).toEqual(tenAmET('2026-10-01'));
  });

  test('last_touch_at and touches_sent are the max across active members', () => {
    const seed = promotionSeed([
      row('a', '2026-07-22T15:00:00Z', 5, { last_touch_at: new Date('2026-09-01T14:00:00Z'), touches_sent: 4 }),
      row('b', '2026-07-24T15:00:00Z', 5, { last_touch_at: new Date('2026-09-15T14:00:00Z'), touches_sent: 6 }),
    ], NOW);
    expect(seed.last_touch_at).toEqual(new Date('2026-09-15T14:00:00Z'));
    expect(seed.touches_sent).toBe(6);
  });

  test('no active member => no seed; quiet members are simply not passed in', () => {
    expect(promotionSeed([], NOW)).toBeNull();
    expect(oldestActive([])).toBeNull();
  });

  test('cadence off the Day 90 ladder caps at the legacy final step', () => {
    delete process.env.GATE_DUNNING_LADDER_90;
    const seed = promotionSeed([row('a', '2026-04-01T15:00:00Z', 0), row('b', '2026-04-02T15:00:00Z', 0)], NOW);
    expect(seed).toMatchObject({ step_index: 3, step_id: 'd30_final' });
  });

  test('the seed is pure: the same input, the same output, and no input is mutated', () => {
    const rows = [row('a', '2026-07-22T15:00:00Z', 5), row('b', '2026-07-24T15:00:00Z', 5)];
    const snapshot = JSON.stringify(rows);
    expect(promotionSeed(rows, NOW)).toEqual(promotionSeed(rows, NOW));
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});
