/**
 * Newsletter inactivity sunset — pins the guarantees that make the lane safe
 * to arm:
 *
 *   1. GATE_NEWSLETTER_SUNSET off → the job is a pure no-op (zero DB work).
 *   2. The safety valve trips only on BOTH bounds (≥MIN_VALVE_COUNT eligible
 *      AND >MAX_FLAG_FRACTION of the active list) — a tracking outage must
 *      pause the run, a small real cohort must not.
 *   3. The parked win-back draft is owner-gated by construction: status
 *      'draft', reengagement type (never AI-validated, never auto-sent),
 *      targets exactly the reengagement_due tag, no social auto-share, and
 *      its copy carries the greeting token + team sign-off with no
 *      price/safety claims.
 *   4. A sunset ('inactive') subscriber who re-subscribes goes through the
 *      normal DOI resubscribe path AND gets the hygiene markers cleared —
 *      without this they'd be stuck invisible forever.
 */

jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const {
  runNewsletterSunset,
  safetyValveTripped,
  buildWinbackDraftRow,
  MIN_VALVE_COUNT,
  REENGAGEMENT_TAG,
  REENGAGEMENT_TYPE,
} = require('../services/newsletter-sunset');
const { getNewsletterType, requiresClaimValidation } = require('../config/newsletter-types');

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_NEWSLETTER_SUNSET;
});

describe('gate', () => {
  test('gate off → skipped with zero DB work', async () => {
    delete process.env.GATE_NEWSLETTER_SUNSET;
    await expect(runNewsletterSunset()).resolves.toEqual({ skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('gate requires the literal string true', async () => {
    process.env.GATE_NEWSLETTER_SUNSET = '1';
    await expect(runNewsletterSunset()).resolves.toEqual({ skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('safetyValveTripped', () => {
  test('small cohorts never valve, whatever the fraction', () => {
    expect(safetyValveTripped(MIN_VALVE_COUNT - 1, 30)).toBe(false);
    expect(safetyValveTripped(0, 600)).toBe(false);
  });

  test('large cohort valves only above the fraction of the active list', () => {
    expect(safetyValveTripped(200, 600)).toBe(true);   // 33% > 30%
    expect(safetyValveTripped(150, 600)).toBe(false);  // 25%
  });

  test('empty active list never valves (no divide-by-zero flag-all)', () => {
    expect(safetyValveTripped(100, 0)).toBe(false);
  });
});

describe('win-back draft row', () => {
  const row = buildWinbackDraftRow();

  test('is owner-gated by construction', () => {
    expect(row.status).toBe('draft');
    expect(row.newsletter_type).toBe(REENGAGEMENT_TYPE);
    expect(row.auto_share_social).toBe(false);
    expect(row.created_by).toBeNull();
    expect(row.indexability).toBe('noindex');
  });

  test('targets exactly the reengagement tag', () => {
    expect(row.segment_filter).toEqual({ tags: [REENGAGEMENT_TAG] });
  });

  test('copy: greeting token, sign-off, CTA in both parts', () => {
    for (const body of [row.html_body, row.text_body]) {
      expect(body).toContain('{{greeting-name}}');
      expect(body).toContain('— The Waves Pest Control Team');
      expect(body).toContain('https://wavespestcontrol.com/');
    }
  });

  test('copy: no prices, no safety/guarantee claims, right brand name', () => {
    const all = [row.subject, row.preview_text, row.html_body, row.text_body].join('\n');
    expect(all).not.toMatch(/\$\d/);
    expect(all.toLowerCase()).not.toContain('guarantee');
    expect(all.toLowerCase()).not.toMatch(/\bsafe\b/);
    expect(row.from_name).toBe('Waves Pest Control');
    expect(all).not.toContain('Waves Lawn & Pest');
  });
});

describe('reengagement newsletter type', () => {
  test('registered, fully manual, exempt from AI claim validation', () => {
    const t = getNewsletterType(REENGAGEMENT_TYPE);
    expect(t).not.toBeNull();
    expect(t.autonomy).toEqual({
      aiDraftAllowed: false,
      autoScheduleAllowed: false,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    });
    expect(requiresClaimValidation(REENGAGEMENT_TYPE)).toBe(false);
  });
});

describe('inactive subscriber resubscribe', () => {
  function makeChain({ firstResult, updateResult } = {}) {
    const chain = {
      where: jest.fn(() => chain),
      first: jest.fn(async () => firstResult),
      update: jest.fn(async () => updateResult ?? 1),
    };
    return chain;
  }

  test('re-enters DOI and clears the sunset hygiene markers', async () => {
    const existing = {
      id: 42,
      email: 'lapsed@example.com',
      status: 'inactive',
      first_name: 'Lapsed',
      last_name: null,
      deactivated_at: new Date('2026-05-01T00:00:00Z'),
      deactivated_reason: 'sunset_inactive_90d',
      reengagement_flagged_at: new Date('2026-03-01T00:00:00Z'),
    };
    const lookup = makeChain({ firstResult: existing });
    const write = makeChain();
    const reread = makeChain({ firstResult: { ...existing, status: 'pending' } });
    db.mockImplementationOnce(() => lookup)
      .mockImplementationOnce(() => write)
      .mockImplementationOnce(() => reread);
    db.raw = jest.fn((sql) => ({ __raw: sql }));

    const { subscribeOrResubscribe } = require('../services/newsletter-subscribers');
    const result = await subscribeOrResubscribe({
      email: 'lapsed@example.com',
      requireConfirmation: true,
      linkCustomer: false,
    });

    expect(result.action).toBe('confirmation_sent');
    const updates = write.update.mock.calls[0][0];
    expect(updates.status).toBe('pending');
    expect(updates.deactivated_at).toBeNull();
    expect(updates.deactivated_reason).toBeNull();
    expect(updates.reengagement_flagged_at).toBeNull();
    expect(updates.resubscribed_at).toBeInstanceOf(Date);
  });
});
