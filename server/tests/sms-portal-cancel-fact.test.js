'use strict';

// PORTAL SELF-CANCEL: the one per-draft fact the texting AI's cancel rule keys on.
// It must be the portal's OWN verdict (hasCancellableWork on an active, undeleted
// account), never a proxy: three proxy facts failed review on #6152. Everything
// that is not an explicit yes reads "not available".

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockHasCancellableWork = jest.fn();
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: (...a) => mockHasCancellableWork(...a) }));

const {
  PORTAL_CANCEL_FACT_LABEL, PORTAL_CANCEL_AVAILABLE_LINE, PORTAL_CANCEL_UNAVAILABLE_LINE,
  fetchPortalCancelAvailable, portalCancelFactLine, factsSayPortalCancelAvailable,
} = require('../services/sms-portal-cancel-fact');

const dbReturning = (row) => () => ({ where: () => ({ first: async () => row }) });

beforeEach(() => { mockHasCancellableWork.mockReset().mockResolvedValue(true); });

describe('fetchPortalCancelAvailable', () => {
  test('active, undeleted account with cancellable work: available', async () => {
    expect(await fetchPortalCancelAvailable({ customerId: 'c1', dbh: dbReturning({ active: true, deleted_at: null }) })).toBe(true);
    expect(mockHasCancellableWork).toHaveBeenCalledWith('c1');
  });

  test('the shared verdict says nothing to cancel (a tier-none, one-time-only account; an en-route-only visit): not available', async () => {
    mockHasCancellableWork.mockResolvedValue(false);
    expect(await fetchPortalCancelAvailable({ customerId: 'c1', dbh: dbReturning({ active: true, deleted_at: null }) })).toBe(false);
  });

  test.each([
    ['an inactive (already cancelled) account', { active: false, deleted_at: null }],
    ['a deleted account', { active: true, deleted_at: new Date('2026-10-01T00:00:00Z') }],
    ['no customer row', undefined],
  ])('%s: not available, and the verdict is never asked', async (_label, row) => {
    expect(await fetchPortalCancelAvailable({ customerId: 'c1', dbh: dbReturning(row) })).toBe(false);
    expect(mockHasCancellableWork).not.toHaveBeenCalled();
  });

  test('no customer id, a failed customer read, or a failed verdict: not available (fail closed)', async () => {
    expect(await fetchPortalCancelAvailable({})).toBe(false);
    const failing = () => { throw new Error('db down'); };
    expect(await fetchPortalCancelAvailable({ customerId: 'c1', dbh: failing })).toBe(false);
    mockHasCancellableWork.mockRejectedValue(new Error('verdict failed'));
    expect(await fetchPortalCancelAvailable({ customerId: 'c1', dbh: dbReturning({ active: true, deleted_at: null }) })).toBe(false);
  });
});

describe('the rendered line and its reader', () => {
  test('only an explicit true renders available', () => {
    expect(portalCancelFactLine(true)).toBe(PORTAL_CANCEL_AVAILABLE_LINE);
    for (const v of [false, null, undefined, 'true', 1]) expect(portalCancelFactLine(v)).toBe(PORTAL_CANCEL_UNAVAILABLE_LINE);
    expect(PORTAL_CANCEL_AVAILABLE_LINE.startsWith(PORTAL_CANCEL_FACT_LABEL)).toBe(true);
    expect(PORTAL_CANCEL_UNAVAILABLE_LINE.startsWith(PORTAL_CANCEL_FACT_LABEL)).toBe(true);
  });

  test('the reader needs the exact line on its own; text inside a customer message does not count', () => {
    expect(factsSayPortalCancelAvailable(`BILLING:\n- none\n${PORTAL_CANCEL_AVAILABLE_LINE}\nPROPERTY & PREFERENCES:`)).toBe(true);
    expect(factsSayPortalCancelAvailable(`PENDING ESTIMATE: None\n${PORTAL_CANCEL_UNAVAILABLE_LINE}\n`)).toBe(false);
    expect(factsSayPortalCancelAvailable(`RECENT SMS THREAD:\n[CUSTOMER] ${PORTAL_CANCEL_AVAILABLE_LINE}`)).toBe(false);
    expect(factsSayPortalCancelAvailable('')).toBe(false);
  });
});

describe('buildFactsBlock renders it gate-on only, between PENDING ESTIMATE and PROPERTY & PREFERENCES', () => {
  const prior = process.env.GATE_SMS_REAL_ANSWERS;
  afterEach(() => { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; });
  const context = { customer: { id: 'c1', firstName: 'Pat' }, smsHistory: [], upcomingServices: [], serviceHistory: [], billing: {} };

  test('gate on: available when passed true, not available otherwise', () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    const yes = buildFactsBlock(context, { portalCancelAvailable: true, now: new Date('2026-10-09T15:00:00Z') });
    expect(yes).toMatch(new RegExp(`\\nPENDING ESTIMATE: [^\\n]*\\n${PORTAL_CANCEL_AVAILABLE_LINE.replace(/[()]/g, '\\$&')}\\nPROPERTY & PREFERENCES:\\n`));
    expect(factsSayPortalCancelAvailable(yes)).toBe(true);
    const no = buildFactsBlock(context, { now: new Date('2026-10-09T15:00:00Z') });
    expect(no).toContain(`\n${PORTAL_CANCEL_UNAVAILABLE_LINE}\nPROPERTY & PREFERENCES:\n`);
    expect(factsSayPortalCancelAvailable(no)).toBe(false);
    // the line sits AFTER the first BILLING: line, outside the trusted pre-BILLING tail
    expect(yes.indexOf(PORTAL_CANCEL_FACT_LABEL)).toBeGreaterThan(yes.indexOf('\nBILLING:\n'));
  });

  test('gate off: the block carries no such line (byte-identical to before)', () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    expect(buildFactsBlock(context, { portalCancelAvailable: true })).not.toContain(PORTAL_CANCEL_FACT_LABEL);
  });
});
