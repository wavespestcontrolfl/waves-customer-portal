/**
 * Shadow backfill (brand-voice loop accelerator) — pure-logic coverage.
 * Same convention as the other brand-voice suites: no DB, no LLM.
 */
const {
  BACKFILL_PROMPT_VERSION,
  REPLY_WINDOW_HOURS,
  PREHANDLED_INBOUND_TYPES,
  isBackfillableNumber,
  boundContextToInbound,
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

describe('shadow backfill — live-parity exclusions (Codex P2)', () => {
  test('excludes every inbound type the live webhook handles before the drafter runs', () => {
    // Mirror of the early-return branches in twilio-webhook.js — if a new
    // pre-drafter branch is added there, this list must grow too.
    for (const type of ['opt_out', 'opt_in', 'sms_reaction', 'reschedule_reply', 'lead_intake']) {
      expect(PREHANDLED_INBOUND_TYPES).toContain(type);
    }
  });
});

describe('shadow backfill — ground-truth leak guard (Codex P1)', () => {
  const inboundAt = new Date(Date.UTC(2026, 2, 10, 14, 30)).toISOString();
  const at = (offsetMin) => new Date(Date.UTC(2026, 2, 10, 14, 30 + offsetMin)).toISOString();

  test("the human's reply (the judge's ground truth) never reaches the prompt context", () => {
    const context = {
      summary: 'kept',
      smsHistory: [
        { direction: 'outbound', body: 'THE GROUND TRUTH REPLY', date: at(5), type: 'manual' },
        { direction: 'inbound', body: 'the inbound itself', date: at(0), type: null },
        { direction: 'outbound', body: 'an older reply', date: at(-60), type: 'manual' },
        { direction: 'inbound', body: 'an older question', date: at(-65), type: null },
      ],
    };
    const bounded = boundContextToInbound(context, inboundAt);
    const bodies = bounded.smsHistory.map((m) => m.body);
    expect(bodies).toEqual(['an older reply', 'an older question']);
    // Strictly-before also drops the inbound itself — buildUserPrompt
    // appends it separately, same as the live path.
    expect(bodies).not.toContain('THE GROUND TRUTH REPLY');
    expect(bodies).not.toContain('the inbound itself');
    expect(bounded.summary).toBe('kept');
  });

  test('unparseable history dates are dropped, never assumed old', () => {
    const bounded = boundContextToInbound(
      { smsHistory: [{ body: 'no date', date: null }, { body: 'bad date', date: 'nope' }] },
      inboundAt
    );
    expect(bounded.smsHistory).toEqual([]);
  });

  test('missing history is tolerated', () => {
    expect(boundContextToInbound({}, inboundAt).smsHistory).toEqual([]);
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
    expect(BACKFILL_PROMPT_VERSION).toBe('house_voice_v2_backfill');
    expect(row.prompt_version).toBe(BACKFILL_PROMPT_VERSION);
    expect(row.prompt_version).not.toBe('house_voice_v2');
  });

  test('row links the inbound and carries the classified intent', () => {
    expect(row.sms_log_id).toBe('sms-1');
    expect(row.customer_id).toBe('cust-1');
    expect(row.intent).toBe('general_customer_sms_needs_review');
    expect(row.scheduling_intent).toBe(false);
  });

  test('scheduling texts keep the live high-stakes flag (same classifier as the webhook)', () => {
    const schedulingRow = buildBackfillDraftRow({
      inbound: { ...inbound, message_body: 'Can we reschedule my appointment to next Tuesday?' },
      parsed,
      intent,
      context: { summary: 's', flags: [] },
      draftMs: 900,
    });
    expect(schedulingRow.scheduling_intent).toBe(true);
  });

  test('window constant mirrors the judge', () => {
    expect(REPLY_WINDOW_HOURS).toBe(24);
  });
});
