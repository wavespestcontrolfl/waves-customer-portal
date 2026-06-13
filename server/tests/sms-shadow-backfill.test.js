/**
 * Shadow backfill (brand-voice loop accelerator) — pure-logic coverage.
 * Same convention as the other brand-voice suites: no DB, no LLM.
 */
const {
  BACKFILL_PROMPT_VERSION,
  REPLY_WINDOW_HOURS,
  isBackfillableNumber,
  buildBackfillDraftRow,
} = require('../services/sms-shadow-backfill');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

describe('shadow backfill — number gate (mirrors the live webhook gate)', () => {
  test('location numbers are backfillable', () => {
    const locationNumbers = Object.values(TWILIO_NUMBERS.locations || {}).map((l) => l.number).filter(Boolean);
    expect(locationNumbers.length).toBeGreaterThan(0);
    for (const number of locationNumbers) {
      expect(isBackfillableNumber(number)).toBe(true);
    }
  });

  test('the AI assistant number is excluded even though the registry calls it a location', () => {
    // twilio-numbers.js reports the toll-free AI line as type 'location'
    // (the documented trap) — the backfill must never draft against a
    // thread the AI already answers live.
    expect(TWILIO_NUMBERS.findByNumber('+18559260203')?.type).toBe('location');
    expect(isBackfillableNumber('+18559260203')).toBe(false);
    expect(isBackfillableNumber('18559260203')).toBe(false);
    expect(isBackfillableNumber('8559260203')).toBe(false);
  });

  test('unknown and empty numbers are not backfillable', () => {
    expect(isBackfillableNumber('+19998887777')).toBe(false);
    expect(isBackfillableNumber('')).toBe(false);
    expect(isBackfillableNumber(null)).toBe(false);
  });
});

describe('shadow backfill — draft row invariants', () => {
  const inbound = {
    id: 'sms-1',
    customer_id: 'cust-1',
    message_body: 'Do you treat for fire ants too?',
    created_at: new Date(Date.UTC(2026, 2, 10, 14, 30)).toISOString(),
  };
  const parsed = {
    reply: 'Hello Dana! Yes — fire ant treatment is part of our WaveGuard plans. Questions or requests? Reply to this message.',
    intended_actions: [{ type: 'none' }],
    missing_info: null,
  };
  const intent = { intent: 'general_customer_sms_needs_review', confidence: 0.62 };
  const row = buildBackfillDraftRow({ inbound, parsed, intent, context: { summary: 's', flags: [] }, draftMs: 1200 });

  test('created_at is BACKDATED to the inbound so the judge is immediately eligible', () => {
    // Judge eligibility is message_drafts.created_at < now-24h; a fresh
    // timestamp would make every backfilled sample wait a day for nothing.
    expect(row.created_at).toBe(inbound.created_at);
  });

  test("status is hard-coded 'shadow' — historical inbounds never publish composer cards", () => {
    expect(row.status).toBe('shadow');
  });

  test('backfill samples are marked with a distinct prompt_version for Phase E weighting', () => {
    expect(BACKFILL_PROMPT_VERSION).toBe('house_voice_v1_backfill');
    expect(row.prompt_version).toBe(BACKFILL_PROMPT_VERSION);
    expect(row.prompt_version).not.toBe('house_voice_v1');
  });

  test('row links the inbound and carries the classified intent', () => {
    expect(row.sms_log_id).toBe('sms-1');
    expect(row.customer_id).toBe('cust-1');
    expect(row.intent).toBe('general_customer_sms_needs_review');
    expect(row.scheduling_intent).toBe(false);
  });

  test('window constant mirrors the judge', () => {
    expect(REPLY_WINDOW_HOURS).toBe(24);
  });
});
