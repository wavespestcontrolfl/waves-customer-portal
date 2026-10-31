/**
 * Newsletter inactivity sunset — pins the guarantees that make the lane safe
 * to arm:
 *
 *   1. GATE_NEWSLETTER_SUNSET off → the job is a pure no-op (zero DB work).
 *   2. The safety valve trips only on BOTH bounds (≥MIN_VALVE_COUNT eligible
 *      AND >MAX_FLAG_FRACTION of the active list) — a tracking outage must
 *      pause the run, a small real cohort must not.
 *   3. With GATE_NEWSLETTER_AUTO_SEND off, the parked win-back draft is
 *      owner-gated by construction: status 'draft', reengagement type
 *      (never AI-validated, never auto-sent),
 *      targets exactly the reengagement_due tag, no social auto-share, and
 *      its copy carries the greeting token + team sign-off with no
 *      price/safety claims.
 *   3b. With the switch on (owner 2026-10-30, option A) a win-back the job
 *      stages queues itself for the next scheduler tick and the "win-back
 *      waiting" alert resolves itself; a draft parked earlier (maybe edited)
 *      stays parked and keeps the alert.
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
  ensureWinbackDraft,
  syncAlert,
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

  test('copy: greeting token, sign-off, scanner-safe quiz CTA in both parts', () => {
    expect(row.html_body).toContain('{{quiz:stay-subscribed-v1}}');
    expect(row.text_body).toContain('{{quiz-text:stay-subscribed-v1}}');
    for (const body of [row.html_body, row.text_body]) {
      expect(body).toContain('{{greeting-name}}');
      expect(body).toContain('— The Waves Pest Control Team');
      // No raw CTA URLs — consent must ride the quiz confirm flow, never a
      // bare link whose provider click event a mail scanner can prefetch.
      expect(body).not.toContain('https://wavespestcontrol.com/');
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

describe('win-back under GATE_NEWSLETTER_AUTO_SEND (owner 2026-10-30, option A)', () => {
  function chain({ first, update = 1, returning = [{ id: 'wb-1' }] } = {}) {
    const q = {};
    ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => first);
    q.update = jest.fn(async () => update);
    q.insert = jest.fn(() => {
      // insert().returning() for the win-back, insert().onConflict().merge().returning() for the alert
      const ins = { returning: jest.fn(async () => returning) };
      ins.onConflict = jest.fn(() => ({ merge: jest.fn(() => ins) }));
      return ins;
    });
    return q;
  }

  test('the staged win-back is queued for the next scheduler tick', async () => {
    const q = chain({ first: undefined });
    db.mockImplementation(() => q);
    expect(await ensureWinbackDraft(12, { autoSend: true })).toEqual({ created: true, openSendId: 'wb-1', queued: true });
    const row = q.insert.mock.calls[0][0];
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toBeInstanceOf(Date);
    // Approved with no approving email = auto-queued: the dispatcher holds it while the switch is off.
    expect(row.proof_approved_at).toBeInstanceOf(Date);
    expect(row).not.toHaveProperty('proof_approval_email_id');
    expect(row.segment_filter).toEqual({ tags: [REENGAGEMENT_TAG] });
  });

  test('switch off: the win-back is parked as a draft, as before', async () => {
    const q = chain({ first: undefined });
    db.mockImplementation(() => q);
    expect((await ensureWinbackDraft(12, { autoSend: false })).queued).toBe(false);
    expect(q.insert.mock.calls[0][0].status).toBe('draft');
    expect(q.insert.mock.calls[0][0]).not.toHaveProperty('scheduled_for');
  });

  test('a win-back parked before the switch went on stays parked: it may have been edited', async () => {
    const q = chain({ first: { id: 'wb-old', status: 'draft' } });
    db.mockImplementation(() => q);
    expect(await ensureWinbackDraft(12, { autoSend: true })).toEqual({ created: false, openSendId: 'wb-old', parked: true });
    expect(q.update).not.toHaveBeenCalled();
    expect(q.insert).not.toHaveBeenCalled();
  });

  test('a win-back already queued or sending is left alone', async () => {
    const q = chain({ first: { id: 'wb-old', status: 'sending' } });
    db.mockImplementation(() => q);
    expect(await ensureWinbackDraft(12, { autoSend: true })).toEqual({ created: false, openSendId: 'wb-old', parked: false });
    expect(q.update).not.toHaveBeenCalled();
  });

  test('the "win-back waiting" alert resolves itself; the safety valve still alerts', async () => {
    const q = chain({ update: 1 });
    db.mockImplementation(() => q);
    db.schema = { hasTable: jest.fn(async () => true) };
    db.raw = jest.fn((sql) => sql);
    try {
      expect(await syncAlert({ valveTripped: false, cohortAwaiting: 12, autoSend: true }, new Date())).toEqual({ resolved: true });
      expect(q.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'resolved' }));
      expect(q.insert).not.toHaveBeenCalled();
      await syncAlert({ valveTripped: true, candidates: 300, sunsetCandidates: 0, activeCount: 600, cohortAwaiting: 0, autoSend: true }, new Date());
      expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Newsletter sunset paused') }));
      // A draft parked before the switch still needs the owner.
      q.insert.mockClear();
      await syncAlert({ valveTripped: false, cohortAwaiting: 12, autoSend: true, winbackParked: true }, new Date());
      expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Newsletter win-back waiting') }));
    } finally {
      delete db.schema;
      delete db.raw;
    }
  });
});

describe('stay-subscribed quiz', () => {
  test('registered, single no-tag answer, thank-you booking pitch suppressed', () => {
    const { getQuiz } = require('../services/newsletter-quiz');
    const quiz = getQuiz('stay-subscribed-v1');
    expect(quiz).not.toBeNull();
    expect(quiz.answers).toHaveLength(1);
    expect(quiz.answers[0].tags).toEqual([]);
    expect(quiz.landingCtaSuppressed).toBe(true);
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
