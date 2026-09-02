/**
 * Referral share composer — ONE mechanism behind every public "Send My
 * Referral Link" tap (service report, estimate accepted screens).
 *   - the render card is static copy, present only while the live program
 *     is active (strict read; any failure → no card);
 *   - the tap enrolls per-customer through the portal engine, resolves the
 *     household promoter on a 23505 scoped to the account, and composes
 *     owner-voice copy with the referee amount formatted to the cent.
 */
const mockEngine = {
  getLiveSettings: jest.fn(),
  enrollPromoter: jest.fn(),
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
  mockEngine.enrollPromoter.mockResolvedValue({ promoter: { id: 'promo-1', referral_code: 'WAVES-TEST01' } });
  mockEngine.getPromoterReferralLink.mockReturnValue('https://wavespestcontrol.com/r/WAVES-TEST01');
});

describe('composeReferralCard', () => {
  test('static headline + CTA while the program is active; nothing else rides the render', async () => {
    expect(await composeReferralCard()).toEqual(REFERRAL_CARD_COPY);
    expect(mockEngine.enrollPromoter).not.toHaveBeenCalled();
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
    expect(mockEngine.enrollPromoter).not.toHaveBeenCalled();
  });
  test('inactive program → null before any enrollment', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: false });
    expect(await buildReferralShareForCustomer('cust-1')).toBeNull();
    expect(mockEngine.enrollPromoter).not.toHaveBeenCalled();
  });
  test('enrolls per customer and composes owner-voice copy with the live referee amount', async () => {
    const share = await buildReferralShareForCustomer('cust-1');
    expect(mockEngine.enrollPromoter).toHaveBeenCalledWith('cust-1');
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
  test('sibling profile (23505) resolves the household promoter read-only, scoped to the account', async () => {
    const pgError = new Error('duplicate key value violates unique constraint "referral_promoters_customer_phone_key"');
    pgError.code = '23505';
    mockEngine.enrollPromoter.mockRejectedValue(pgError);
    const joined = {
      join: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'promo-h', referral_code: 'WAVES-HOUSE01' }),
    };
    const database = (table) => {
      if (table === 'customers') return { where: () => ({ first: async () => ({ id: 'cust-2', phone: '+15555550100', account_id: 'acct-1' }) }) };
      if (table === 'referral_promoters as rp') return joined;
      throw new Error(`unexpected table ${table}`);
    };
    mockEngine.getPromoterReferralLink.mockReturnValue('https://wavespestcontrol.com/r/WAVES-HOUSE01');
    const share = await buildReferralShareForCustomer('cust-2', { database });
    expect(share.code).toBe('WAVES-HOUSE01');
    expect(joined.where).toHaveBeenCalledWith('c.account_id', 'acct-1');
  });
  test('a 23505 with no account-scoped household match rethrows (never a guessed attribution)', async () => {
    const pgError = new Error('dup');
    pgError.code = '23505';
    mockEngine.enrollPromoter.mockRejectedValue(pgError);
    const database = (table) => {
      if (table === 'customers') return { where: () => ({ first: async () => ({ id: 'cust-3', phone: null, account_id: null }) }) };
      throw new Error(`unexpected table ${table}`);
    };
    await expect(buildReferralShareForCustomer('cust-3', { database })).rejects.toBe(pgError);
  });
  test('an empty code or link is reported unavailable, not a half-composed share', async () => {
    mockEngine.getPromoterReferralLink.mockReturnValue('');
    expect(await buildReferralShareForCustomer('cust-1')).toEqual({ unavailable: true });
  });

  test('an outer transaction is threaded through the enroll and the household fallback reads (GH codex P1 on #3710)', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 2500, base_url: 'https://wavespestcontrol.com' });
    mockEngine.enrollPromoter.mockResolvedValue({ promoter: { id: 'promo-1', referral_code: 'WAVES-TEST01' } });
    mockEngine.getPromoterReferralLink.mockReturnValue('https://wavespestcontrol.com/r/WAVES-TEST01');
    // knex nests a transaction as a SAVEPOINT: the enroll runs on it so a
    // 23505 rolls back only the savepoint and the fallback can still read.
    const sp = jest.fn();
    const conn = jest.fn();
    conn.transaction = jest.fn(async (fn) => fn(sp));
    await buildReferralShareForCustomer('cust-1', { conn });
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    // The settings read rides the outer connection and is reused by the enroll.
    expect(mockEngine.getLiveSettings).toHaveBeenCalledWith(conn);
    expect(mockEngine.enrollPromoter).toHaveBeenCalledWith('cust-1', { conn: sp, settings: expect.objectContaining({ program_active: true }) });
  });

  test('a 23505 inside the savepoint leaves the outer transaction usable for the household fallback', async () => {
    mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 2500, base_url: 'https://wavespestcontrol.com' });
    const dupe = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockEngine.enrollPromoter.mockRejectedValue(dupe);
    mockEngine.getPromoterReferralLink.mockReturnValue('https://wavespestcontrol.com/r/WAVES-HOUSE1');
    const reads = [];
    const builder = (table) => {
      reads.push(table);
      const b = { where: () => b, join: () => b, first: async () => (table === 'customers' ? { id: 'cust-2', phone: '9415550100', account_id: 'acct-1' } : { id: 'promo-h', referral_code: 'WAVES-HOUSE1' }) };
      return b;
    };
    const conn = jest.fn(builder);
    conn.transaction = jest.fn(async (fn) => fn(jest.fn()));
    const out = await buildReferralShareForCustomer('cust-2', { conn });
    expect(out.code).toBe('WAVES-HOUSE1');
    expect(reads).toEqual(['customers', 'referral_promoters as rp']);
  });
});
