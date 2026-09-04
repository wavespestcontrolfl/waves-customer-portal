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
