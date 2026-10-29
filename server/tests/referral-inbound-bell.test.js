// The new-referral bell (owner 2026-10-29 "ok go"): one admin row per card in Referrals → Queue, with
// Confirm <referrer> and Not a referral. The row's words and buttons, the sweep, the close, and a tap.
// Customer names below are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  referralInboundBellLive: jest.fn(() => true),
  referralInboundConfirmLive: jest.fn(() => true),
}));
jest.mock('../services/referral-inbound', () => ({
  listInboundReferrals: jest.fn(async () => []),
  confirmInboundReferral: jest.fn(),
  dismissInboundReferral: jest.fn(),
}));
jest.mock('../services/referral-engine', () => ({
  findHouseholdPromoter: jest.fn(async () => null),
  // The engine's own rule (referral-status-transitions.test.js pins it); the engine module is not loaded here.
  milestoneLevelEarned: jest.fn((converted, level) => {
    const held = level || 'none';
    if (converted >= 10 && held !== 'champion') return 'champion';
    if (converted >= 5 && !['champion', 'ambassador'].includes(held)) return 'ambassador';
    if (converted >= 3 && !['champion', 'ambassador', 'advocate'].includes(held)) return 'advocate';
    return null;
  }),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n-1', rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 1),
  openAdminAlertKeys: jest.fn(async () => []),
}));

let mockReviews = {};
let mockPromoters = {};
const mockLocks = [];
jest.mock('../models/db', () => {
  const table = (name) => {
    const filters = {};
    const q = {
      where: jest.fn((f) => { Object.assign(filters, f); return q; }),
      first: jest.fn(async () => {
        if (name === 'referral_inbound_reviews') return mockReviews[filters.customer_id] ? { outcome: mockReviews[filters.customer_id] } : undefined;
        if (name === 'referral_promoters') return mockPromoters[filters.customer_id];
        throw new Error(`unexpected table ${name}`);
      }),
    };
    return q;
  };
  const db = jest.fn(table);
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn(table);
    trx.raw = jest.fn(async (sql, bindings) => { mockLocks.push(bindings[0]); });
    return fn(trx);
  });
  return db;
});

const gates = require('../config/feature-gates');
const inbound = require('../services/referral-inbound');
const episodes = require('../services/admin-alert-episodes');
const { composeAdminAlert, MAX_HEADLINE_CHARS, MAX_WHY_CHARS, MAX_BUTTON_LABEL_CHARS } = require('../services/admin-alert-compose');
const bell = require('../services/referral-inbound-bell');

const { composeCard } = bell._private;
const AMES = '00000000-0000-4000-8000-000000000101';
const LEA = '00000000-0000-4000-8000-000000000102';
const OTHER = '00000000-0000-4000-8000-000000000103';
const TECH = '00000000-0000-4000-8000-0000000000f1';
const LEA_SUGGESTION = { customerId: LEA, name: 'Lea Quill', city: 'Bradenton', phone: '+19415550102', onPlan: true, exact: true, viaCode: true };
const card = (over = {}) => ({
  customerId: AMES,
  name: 'Ames Fenn',
  phone: '+19415550101',
  city: 'Bradenton',
  createdAt: '2026-10-27T15:00:00Z',
  plan: { tier: 'Bronze', monthlyRate: 42.67 },
  creditsNow: false,
  evidence: { source: 'link', code: 'WAVES-TEST', spokenName: null },
  selfReferral: false,
  suggestions: [LEA_SUGGESTION],
  ...over,
});
const spoken = (spokenName, suggestions) => card({ evidence: { source: 'call', code: null, spokenName }, suggestions });
const ids = (composed) => composed.spec.buttons.items.map((b) => b.id);

beforeEach(() => {
  jest.clearAllMocks();
  mockReviews = {};
  mockPromoters = {};
  mockLocks.length = 0;
  gates.referralInboundBellLive.mockReturnValue(true);
  gates.referralInboundConfirmLive.mockReturnValue(true);
  inbound.listInboundReferrals.mockResolvedValue([]);
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n-1', rang: true });
});

describe('the row for one card', () => {
  test('a link card with its code owner offers Confirm and Not a referral, and opens the Queue', () => {
    const composed = composeCard(card());
    expect(composeAdminAlert(composed.spec)).toMatchObject({
      headline: "Customers — confirm Ames Fenn's referrer",
      why: "Came in Oct 27 through Lea Quill's referral link; $25 each after the first plan visit.",
      link: '/admin/referrals?tab=queue',
      metadata: { area: 'Customers', severity: 'needs-you', subject: { type: 'customer', id: AMES }, doneWhen: 'referral_answered', who: 'person' },
    });
    expect(composed.spec.buttons).toEqual({
      kind: 'referral_inbound',
      items: [
        { id: 'confirm', label: 'Confirm Lea Quill', prompt: 'Make Lea Quill the referrer of Ames Fenn, with $25 each after the first plan visit?', args: { referrerCustomerId: LEA } },
        { id: 'dismiss', label: 'Not a referral', prompt: 'Remove Ames Fenn from the referral list for good?' },
      ],
    });
    expect(composed.detail).toMatch(/one thank-you email at the next 9:00 AM ET\. Nothing is sent and no money moves at the tap\./);
  });

  test('a caller who named one customer by first and last name gets Confirm too', () => {
    const composed = composeCard(spoken('Lea Quill', [{ ...LEA_SUGGESTION, viaCode: false }]));
    expect(composed.spec.why).toBe('Came in Oct 27 and named Lea Quill as the referrer; $25 each after the first plan visit.');
    expect(ids(composed)).toEqual(['confirm', 'dismiss']);
  });

  test.each([
    ['two customers match the spoken name', spoken('Lea Quill', [{ ...LEA_SUGGESTION, viaCode: false }, { ...LEA_SUGGESTION, customerId: OTHER, viaCode: false }]),
      'Came in Oct 27 and named Lea Quill as the referrer; pick the referrer in the Queue.'],
    ['only the last name matches', spoken('Lea Quill', [{ ...LEA_SUGGESTION, name: 'Rae Quill', exact: false, viaCode: false }]),
      'Came in Oct 27 and named Lea Quill as the referrer; pick the referrer in the Queue.'],
    ['the caller gave no name', spoken(null, []),
      'Came in Oct 27 and said a customer referred them, with no name; pick the referrer in the Queue.'],
    ['nobody holds the link code', card({ suggestions: [] }),
      'Came in Oct 27 through a referral link no customer holds; pick the referrer in the Queue.'],
    ['the code is their own household\'s', card({ selfReferral: true, suggestions: [] }),
      'Came in Oct 27 through a referral link from their own household; mark it not a referral.'],
    ['a plan visit is already done (a confirm would post the credits at once)', card({ creditsNow: true }),
      "Came in Oct 27 through Lea Quill's referral link; a visit is done, so confirm in the Queue for $25 each now."],
  ])('no Confirm when %s', (_name, value, why) => {
    const composed = composeCard(value);
    expect(composed.spec.why).toBe(why);
    expect(ids(composed)).toEqual(['dismiss']);
    expect(() => composeAdminAlert(composed.spec)).not.toThrow();
  });

  test('no Confirm when the confirm would be the referrer\'s milestone referral (a bonus and a text at once)', () => {
    const composed = composeCard(card(), { milestone: true });
    expect(composed.spec.why).toBe("Came in Oct 27 through Lea Quill's referral link; it earns a milestone bonus, so confirm in the Queue.");
    expect(ids(composed)).toEqual(['dismiss']);
    expect(composed.detail).toMatch(/pays a bonus and sends a text at once/);
  });

  test('a household\'s own code reads as a review, not a confirm', () => {
    expect(composeCard(card({ selfReferral: true, suggestions: [] })).spec.action).toBe("review Ames Fenn's referral");
  });

  test('long names still fit every limit and compose', () => {
    const long = card({
      name: 'Bartholomew Alexander Quillington-Fenn',
      suggestions: [{ ...LEA_SUGGESTION, name: 'Maximiliana Theodora Worthington-Smythe' }],
    });
    const { spec } = composeCard(long);
    const alert = composeAdminAlert(spec);
    expect(alert.headline.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
    expect(alert.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    const [confirm] = spec.buttons.items;
    expect(confirm.label).toBe('Confirm Maximiliana W');
    expect(confirm.label.length).toBeLessThanOrEqual(MAX_BUTTON_LABEL_CHARS);
    expect(confirm.prompt.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
  });

  test('a name with an initial or a dot still composes as one sentence', () => {
    const { spec } = composeCard(card({ name: 'Mary St. James', suggestions: [{ ...LEA_SUGGESTION, name: 'John Q. Public' }] }));
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(spec.buttons.items[0].label).toBe('Confirm John Q Public');
  });
});

describe('syncReferralInboundBells: the fifteen-minute sweep', () => {
  test('off: nothing is read', async () => {
    gates.referralInboundBellLive.mockReturnValue(false);
    await expect(bell.syncReferralInboundBells()).resolves.toEqual({ skipped: 'disabled' });
    expect(episodes.openAdminAlertKeys).not.toHaveBeenCalled();
    expect(inbound.listInboundReferrals).not.toHaveBeenCalled();
  });

  test('with the Queue\'s own gate off, every open row closes', async () => {
    gates.referralInboundConfirmLive.mockReturnValue(false);
    episodes.openAdminAlertKeys.mockResolvedValue([`referral-inbound:${AMES}`]);
    await expect(bell.syncReferralInboundBells()).resolves.toMatchObject({ closed: 1, raised: 0 });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`referral-inbound:${AMES}`], 'referral_queue_off',
      expect.objectContaining({ resolution: 'The Referrals Queue confirm step is off' }));
    expect(inbound.listInboundReferrals).not.toHaveBeenCalled();
  });

  test('a listed card rings under its own lock, read again inside it; a row whose card was answered closes', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([`referral-inbound:${OTHER}`]);
    inbound.listInboundReferrals.mockImplementation(async (_conn, opts = {}) => {
      if (!opts.customerId) return [card()];
      return opts.customerId === AMES ? [card()] : [];
    });
    mockReviews[OTHER] = 'dismissed';
    await expect(bell.syncReferralInboundBells()).resolves.toEqual({ raised: 1, unchanged: 0, closed: 1, failed: 0 });
    expect(mockLocks.sort()).toEqual([`admin:referral-inbound:${AMES}`, `admin:referral-inbound:${OTHER}`].sort());

    const [category, headline, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, headline, why]).toEqual(['customer', "Customers — confirm Ames Fenn's referrer", "Came in Oct 27 through Lea Quill's referral link; $25 each after the first plan visit."]);
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: `referral-inbound:${AMES}`,
      refreshOnDedupe: true,
      link: '/admin/referrals?tab=queue',
      metadata: { customerId: AMES, buttons: { kind: 'referral_inbound' }, subject: { type: 'customer', id: AMES } },
    });
    expect(opts.trx).toBeDefined();
    // A changed card rewrites the row quietly; the buttons version that change.
    expect(opts.ringOnRefresh()).toBe(false);
    expect(opts.dedupeVersion).toMatch(/^[0-9a-f]{16}$/);

    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`referral-inbound:${OTHER}`], 'referral_answered',
      expect.objectContaining({ resolution: 'Marked not a referral' }));
  });

  test('a referrer one conversion short of a milestone gets no Confirm on the row', async () => {
    inbound.listInboundReferrals.mockResolvedValue([card()]);
    mockPromoters[LEA] = { total_referrals_converted: 2, milestone_level: 'none' };
    await bell.syncReferralInboundBells();
    const items = episodes.raiseAdminAlertWithReopen.mock.calls[0][3].metadata.buttons.items;
    expect(items.map((b) => b.id)).toEqual(['dismiss']);
  });

  test('a household promoter counts when the referrer has none of their own', async () => {
    inbound.listInboundReferrals.mockResolvedValue([card()]);
    require('../services/referral-engine').findHouseholdPromoter.mockResolvedValueOnce({ total_referrals_converted: 4, milestone_level: 'none' });
    await bell.syncReferralInboundBells();
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][3].metadata.buttons.items.map((b) => b.id)).toEqual(['dismiss']);
  });

  test('a standing row that did not ring counts as unchanged, and one card\'s failure never stops the rest', async () => {
    const BAD = '00000000-0000-4000-8000-000000000104';
    inbound.listInboundReferrals.mockImplementation(async (_conn, opts = {}) => {
      if (opts.customerId === BAD) throw new Error('read failed');
      return opts.customerId ? [card({ customerId: opts.customerId })] : [card({ customerId: BAD }), card()];
    });
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n-1', rang: false, deduped: true });
    await expect(bell.syncReferralInboundBells()).resolves.toEqual({ raised: 0, unchanged: 1, closed: 0, failed: 1 });
  });
});

describe('closeReferralInboundBell: an answer closes the row', () => {
  test.each([
    ['confirmed', 'Referrer confirmed'],
    ['dismissed', 'Marked not a referral'],
    ['anything else', 'No longer waiting in Referrals → Queue'],
  ])('%s', async (outcome, resolution) => {
    await bell.closeReferralInboundBell(AMES, outcome);
    expect(mockLocks).toEqual([`admin:referral-inbound:${AMES}`]);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`referral-inbound:${AMES}`], 'referral_answered', expect.objectContaining({ resolution }));
  });
});

describe('a tap', () => {
  const row = { id: 'n-1', metadata: { subject: { type: 'customer', id: AMES } } };
  const CONFIRM = { id: 'confirm', label: 'Confirm Lea Quill', args: { referrerCustomerId: LEA } };
  const DISMISS = { id: 'dismiss', label: 'Not a referral' };
  const run = (item, over = {}) => bell.buttonHandler.run({ row, item, technicianId: TECH, ...over });

  beforeEach(() => {
    inbound.listInboundReferrals.mockResolvedValue([card()]);
  });

  test('the buttons are live only while both gates are on', () => {
    expect(bell.buttonHandler.live()).toBe(true);
    gates.referralInboundConfirmLive.mockReturnValue(false);
    expect(bell.buttonHandler.live()).toBe(false);
  });

  test('Not a referral runs the Queue\'s own dismiss for the row\'s customer', async () => {
    await expect(run(DISMISS)).resolves.toEqual({ ok: true, message: 'Ames Fenn is marked not a referral.', resolution: 'Marked not a referral' });
    expect(inbound.listInboundReferrals).toHaveBeenCalledWith(expect.anything(), { customerId: AMES });
    expect(inbound.dismissInboundReferral).toHaveBeenCalledWith({ customerId: AMES, reviewedBy: TECH });
  });

  test('Confirm runs the Queue\'s own confirm with the card\'s sure referrer', async () => {
    inbound.confirmInboundReferral.mockResolvedValue({ referralId: 'r-1', converted: true, creditsNow: false, credited: null, error: null });
    await expect(run(CONFIRM)).resolves.toEqual({
      ok: true, message: "Lea Quill is confirmed as Ames Fenn's referrer. $25 each after the first plan visit.", resolution: 'Referrer confirmed',
    });
    expect(inbound.confirmInboundReferral).toHaveBeenCalledWith({ customerId: AMES, referrerCustomerId: LEA, reviewedBy: TECH });
  });

  test('a conversion that failed after the save says so', async () => {
    inbound.confirmInboundReferral.mockResolvedValue({ referralId: 'r-1', converted: false, creditsNow: false, credited: null, error: 'convert_failed' });
    await expect(run(CONFIRM)).resolves.toMatchObject({ ok: true, message: expect.stringMatching(/conversion failed\. Use Convert/) });
  });

  test.each([
    ['the card was answered meanwhile', 'confirmed', { code: 'answered', message: 'This referral was already answered.', close: 'Referrer confirmed' }],
    ['the card left the list', null, { code: 'answered', message: 'This customer is no longer waiting in Referrals → Queue.', close: 'No longer waiting in Referrals → Queue' }],
  ])('nothing runs when %s, and the row closes', async (_name, answer, expected) => {
    inbound.listInboundReferrals.mockResolvedValue([]);
    if (answer) mockReviews[AMES] = answer;
    await expect(run(CONFIRM)).resolves.toEqual({ ok: false, ...expected });
    expect(inbound.confirmInboundReferral).not.toHaveBeenCalled();
  });

  test.each([
    ['the sure referrer changed', () => inbound.listInboundReferrals.mockResolvedValue([card({ suggestions: [{ ...LEA_SUGGESTION, customerId: OTHER }] })]), 'referrer_changed'],
    ['no single sure referrer is left', () => inbound.listInboundReferrals.mockResolvedValue([card({ suggestions: [] })]), 'referrer_changed'],
    ['the first plan visit happened since the row rang', () => inbound.listInboundReferrals.mockResolvedValue([card({ creditsNow: true })]), 'first_visit_done'],
    ['the referrer would reach a milestone', () => { mockPromoters[LEA] = { total_referrals_converted: 4, milestone_level: 'advocate' }; }, 'milestone'],
  ])('Confirm is refused when %s, and the row stays open', async (_name, arrange, code) => {
    arrange();
    const result = await run(CONFIRM);
    expect(result).toMatchObject({ ok: false, code });
    expect(result).not.toHaveProperty('close');
    expect(inbound.confirmInboundReferral).not.toHaveBeenCalled();
  });

  test('the step\'s own refusal comes back in its words; an answered card closes the row', async () => {
    inbound.confirmInboundReferral.mockRejectedValueOnce(Object.assign(new Error('This customer was already confirmed or dismissed'), { statusCode: 409, code: 'ALREADY_REVIEWED' }));
    mockReviews[AMES] = 'dismissed';
    await expect(run(CONFIRM)).resolves.toEqual({ ok: false, code: 'already_reviewed', message: 'This customer was already confirmed or dismissed', close: 'Marked not a referral' });

    inbound.dismissInboundReferral.mockRejectedValueOnce(Object.assign(new Error('Customer not found'), { statusCode: 404, code: 'NOT_FOUND' }));
    await expect(run(DISMISS)).resolves.toEqual({ ok: false, code: 'not_found', message: 'Customer not found' });
  });

  test('an unexpected failure is thrown, not answered', async () => {
    inbound.confirmInboundReferral.mockRejectedValueOnce(new Error('connection reset'));
    await expect(run(CONFIRM)).rejects.toThrow('connection reset');
  });

  test('a reviewer id that is not a technician uuid is not recorded', async () => {
    await run(DISMISS, { technicianId: 'tech-1' });
    expect(inbound.dismissInboundReferral).toHaveBeenCalledWith({ customerId: AMES, reviewedBy: null });
  });

  test('a row that names no customer runs nothing', async () => {
    await expect(run(DISMISS, { row: { id: 'n-1', metadata: { subject: { type: 'visit', id: AMES } } } })).resolves.toMatchObject({ ok: false, code: 'invalid' });
    expect(inbound.listInboundReferrals).not.toHaveBeenCalled();
  });
});
