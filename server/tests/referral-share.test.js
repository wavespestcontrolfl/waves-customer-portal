/**
 * Referral share composer — ONE mechanism behind every public "Send My
 * Referral Link" tap (service report, estimate accepted screens).
 *   - the render card is static copy, present only while the live program
 *     is active (strict read; any failure → no card);
 *   - the tap enrolls-or-resolves through referral-engine.resolvePromoter
 *     (the household 23505 fallback is pinned with the engine) and composes
 *     owner-voice copy with the referee amount formatted to the cent.
 */
const mockEngine = {
  getLiveSettings: jest.fn(),
  resolvePromoter: jest.fn(),
  getPromoterReferralLink: jest.fn(),
  referralOfferDecision: jest.fn(),
};
jest.mock('../services/referral-engine', () => mockEngine);

const {
  REFERRAL_CARD_COPY,
  composeReferralCard,
  buildReferralShareForCustomer,
} = require('../services/referral-share');

beforeEach(() => {
  jest.clearAllMocks();
  mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 2500 });
  mockEngine.resolvePromoter.mockResolvedValue({ promoter: { id: 'promo-1', referral_code: 'WAVES-TEST01' } });
  mockEngine.getPromoterReferralLink.mockReturnValue('https://wavespestcontrol.com/r/WAVES-TEST01');
});

describe('composeReferralCard', () => {
  test('static headline + CTA while the program is active; nothing else rides the render', async () => {
    expect(await composeReferralCard()).toEqual(REFERRAL_CARD_COPY);
    expect(mockEngine.resolvePromoter).not.toHaveBeenCalled();
  });
  test('inactive or missing settings → null', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: false });
    expect(await composeReferralCard()).toBeNull();
    mockEngine.getLiveSettings.mockResolvedValue(null);
    expect(await composeReferralCard()).toBeNull();
  });
  test('a settings failure propagates so the caller suppresses the card', async () => {
    mockEngine.getLiveSettings.mockRejectedValue(new Error('db down'));
    await expect(composeReferralCard()).rejects.toThrow('db down');
  });
});

describe('composeReferralCard with GATE_REFERRAL_STEP2 (the offer line)', () => {
  const { gates } = require('../config/feature-gates');
  const ONE = 'They get a $50 credit after their first plan service. You get $25.';
  const decision = (over = {}) => ({ gateOn: true, skip: false, atLimit: false, memberCents: 2500, refereeCents: 5000, ...over });
  beforeEach(() => { mockEngine.referralOfferDecision.mockResolvedValue(decision()); });
  afterEach(() => { gates.referralStep2 = false; });

  test('gate off: the static copy exactly, and the offer decision is never read', async () => {
    gates.referralStep2 = false;
    const card = await composeReferralCard({ customerId: 'cust-1' });
    expect(card).toEqual(REFERRAL_CARD_COPY);
    expect(Object.keys(card)).toEqual(['headline', 'cta']);
    expect(mockEngine.referralOfferDecision).not.toHaveBeenCalled();
  });
  test('gate on: headline and CTA unchanged, plus the offer from the live amounts', async () => {
    gates.referralStep2 = true;
    const card = await composeReferralCard({ customerId: 'cust-1' });
    expect(card).toEqual({ ...REFERRAL_CARD_COPY, offer: ONE });
    expect(mockEngine.referralOfferDecision).toHaveBeenCalledWith(expect.anything(), 'cust-1');
    expect(mockEngine.resolvePromoter).not.toHaveBeenCalled();
  });
  test('gate on, a member at the yearly limit never reads "You get"', async () => {
    gates.referralStep2 = true;
    mockEngine.referralOfferDecision.mockResolvedValue(decision({ atLimit: true }));
    expect((await composeReferralCard({ customerId: 'cust-1' })).offer).toBe('They get a $50 credit after their first plan service.');
  });
  test('gate on, a friend amount of 0 leaves the member sentence alone', async () => {
    gates.referralStep2 = true;
    mockEngine.referralOfferDecision.mockResolvedValue(decision({ refereeCents: 0 }));
    expect((await composeReferralCard({ customerId: 'cust-1' })).offer).toBe('You get $25.');
  });
  test('gate on, no sentence left: the static copy, no offer key', async () => {
    gates.referralStep2 = true;
    mockEngine.referralOfferDecision.mockResolvedValue(decision({ refereeCents: 0, memberCents: 0 }));
    expect(await composeReferralCard({ customerId: 'cust-1' })).toEqual(REFERRAL_CARD_COPY);
  });
  test('gate on, a skipped decision (program paused or settings unreadable): no card, so no button that would answer 404', async () => {
    gates.referralStep2 = true;
    mockEngine.referralOfferDecision.mockResolvedValue({ gateOn: true, skip: true, atLimit: false, reason: 'program paused' });
    expect(await composeReferralCard({ customerId: 'cust-1' })).toBeNull();
    mockEngine.referralOfferDecision.mockResolvedValue({ gateOn: true, skip: true, atLimit: false, reason: 'settings unavailable' });
    expect(await composeReferralCard({ customerId: 'cust-1' })).toBeNull();
  });
  test('gate on, no customer id: the static copy and no decision read', async () => {
    gates.referralStep2 = true;
    expect(await composeReferralCard()).toEqual(REFERRAL_CARD_COPY);
    expect(mockEngine.referralOfferDecision).not.toHaveBeenCalled();
  });
  test('gate on, for a known customer the settings are read once, by the decision', async () => {
    gates.referralStep2 = true;
    await composeReferralCard({ customerId: 'cust-1' });
    expect(mockEngine.referralOfferDecision).toHaveBeenCalledTimes(1);
    expect(mockEngine.getLiveSettings).not.toHaveBeenCalled();
  });
  test('gate on, no customer id and an inactive program: still null', async () => {
    gates.referralStep2 = true;
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: false });
    expect(await composeReferralCard()).toBeNull();
    expect(mockEngine.referralOfferDecision).not.toHaveBeenCalled();
  });
  test('an outer transaction rides the read on both paths', async () => {
    gates.referralStep2 = true;
    const conn = jest.fn();
    await composeReferralCard({ customerId: 'cust-1', conn });
    expect(mockEngine.referralOfferDecision).toHaveBeenCalledWith(conn, 'cust-1');
    await composeReferralCard({ conn });
    expect(mockEngine.getLiveSettings).toHaveBeenCalledWith(conn);
  });
  test('an offer-decision failure propagates so the caller suppresses the card', async () => {
    gates.referralStep2 = true;
    mockEngine.referralOfferDecision.mockRejectedValue(new Error('db down'));
    await expect(composeReferralCard({ customerId: 'cust-1' })).rejects.toThrow('db down');
  });
});

describe('buildReferralShareForCustomer', () => {
  test('no customer → null, nothing enrolled', async () => {
    expect(await buildReferralShareForCustomer(null)).toBeNull();
    expect(mockEngine.resolvePromoter).not.toHaveBeenCalled();
  });
  test('inactive program → null before any enrollment', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: false });
    expect(await buildReferralShareForCustomer('cust-1')).toBeNull();
    expect(mockEngine.resolvePromoter).not.toHaveBeenCalled();
  });
  test('enrolls per customer and composes owner-voice copy with the live referee amount', async () => {
    const share = await buildReferralShareForCustomer('cust-1');
    expect(mockEngine.resolvePromoter).toHaveBeenCalledWith('cust-1', { conn: null, settings: expect.objectContaining({ program_active: true }) });
    expect(share.code).toBe('WAVES-TEST01');
    expect(share.link).toBe('https://wavespestcontrol.com/r/WAVES-TEST01');
    expect(share.smsBody).toContain('$25 off');
    expect(share.smsBody).toContain('wavespestcontrol.com/r/WAVES-TEST01');
    expect(share.smsBody).not.toContain('https://');
    // Texts say "Waves" (owner 2026-11-04); the email keeps the full name.
    expect(share.smsBody).toMatch(/^We use Waves and /);
    expect(share.smsBody).not.toContain('Waves Pest Control');
    expect(share.emailBody).toContain('https://wavespestcontrol.com/r/WAVES-TEST01');
    expect(share.emailSubject).toBe('$25 off Waves Pest Control');
    expect(/\p{Extended_Pictographic}/u.test(share.smsBody + share.emailBody)).toBe(false);
  });
  test('fractional referee discounts format EXACTLY, never rounded up a dollar', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 4999 });
    const share = await buildReferralShareForCustomer('cust-1');
    expect(share.smsBody).toContain('$49.99 off');
    expect(share.smsBody).not.toContain('$50');
  });
  test('no referee discount → asks to mention the code, never invents $ off', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 0 });
    const share = await buildReferralShareForCustomer('cust-1');
    expect(share.smsBody).not.toContain('$');
    expect(share.smsBody).toContain('mention my code WAVES-TEST01');
    expect(share.emailSubject).toBe('Waves Pest Control');
  });
  test('a resolve failure propagates (callers answer 503, logging err.code only)', async () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "referral_promoters_customer_phone_key"'), { code: '23505' });
    mockEngine.resolvePromoter.mockRejectedValue(pgError);
    await expect(buildReferralShareForCustomer('cust-3')).rejects.toBe(pgError);
  });
  test('an empty code or link is reported unavailable, not a half-composed share', async () => {
    mockEngine.getPromoterReferralLink.mockReturnValue('');
    expect(await buildReferralShareForCustomer('cust-1')).toEqual({ unavailable: true });
  });

  test('an outer transaction and its settings read are threaded through the resolve (GH codex P1 on #3710)', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 2500, base_url: 'https://wavespestcontrol.com' });
    const conn = jest.fn();
    await buildReferralShareForCustomer('cust-1', { conn });
    // The settings read rides the outer connection and is reused by the enroll.
    expect(mockEngine.getLiveSettings).toHaveBeenCalledWith(conn);
    expect(mockEngine.resolvePromoter).toHaveBeenCalledWith('cust-1', { conn, settings: expect.objectContaining({ program_active: true }) });
  });
});

describe('buildReferralShareForCustomer with GATE_REFERRAL_STEP2', () => {
  const { gates } = require('../config/feature-gates');
  afterEach(() => { gates.referralStep2 = false; });

  test('gate on: a credit after the first plan service, from the setting; the subject drops "off"', async () => {
    gates.referralStep2 = true;
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 5000 });
    const share = await buildReferralShareForCustomer('cust-1');
    expect(share.smsBody).toBe("We use Waves and they'll give you a $50 credit after your first plan service with my code WAVES-TEST01. wavespestcontrol.com/r/WAVES-TEST01");
    expect(share.emailBody).toBe("We use Waves Pest Control and they'll give you a $50 credit after your first plan service with my code WAVES-TEST01.\n\nhttps://wavespestcontrol.com/r/WAVES-TEST01");
    expect(share.emailSubject).toBe('Waves Pest Control');
  });
  test('gate on: cents read exactly', async () => {
    gates.referralStep2 = true;
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 3250 });
    expect((await buildReferralShareForCustomer('cust-1')).smsBody).toContain('a $32.50 credit after');
  });
  test('gate on, no amount: mention the code, as today', async () => {
    gates.referralStep2 = true;
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 0 });
    const share = await buildReferralShareForCustomer('cust-1');
    expect(share.smsBody).toBe('We use Waves and mention my code WAVES-TEST01 when you book. wavespestcontrol.com/r/WAVES-TEST01');
    expect(share.emailSubject).toBe('Waves Pest Control');
  });
  test('gate off: today, word for word', async () => {
    gates.referralStep2 = false;
    const share = await buildReferralShareForCustomer('cust-1');
    expect(share.smsBody).toBe("We use Waves and they'll take $25 off your first service with my code WAVES-TEST01. wavespestcontrol.com/r/WAVES-TEST01");
    expect(share.emailBody).toBe("We use Waves Pest Control and they'll take $25 off your first service with my code WAVES-TEST01.\n\nhttps://wavespestcontrol.com/r/WAVES-TEST01");
    expect(share.emailSubject).toBe('$25 off Waves Pest Control');
  });
});
