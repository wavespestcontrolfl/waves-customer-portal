/**
 * Pure-function tests for the Wallet pass builder — no DB, no signing.
 * (Signing is exercised against the real certs on the rig; these lock the
 * pass.json structure, the DATE-string formatting trap, and the
 * unconfigured-env gate.)
 */

const {
  walletConfigured,
  buildPassJson,
  __private: { etDateLabel },
} = require('../services/wallet-pass');

const BASE = {
  card: { id: 'card-uuid-1', customer_latitude: 27.33, customer_longitude: -82.37 },
  customerFirstName: 'Lena',
  memberSinceYear: 2026,
  techName: 'Adam Benetti',
  location: {
    id: 'sarasota',
    phone: '(941) 297-2606',
    phoneRaw: '+19412972606',
    googleReviewUrl: 'https://g.page/r/x/review',
  },
  reviewUrl: 'https://portal.wavespestcontrol.com/l/g4mty',
  referralUrl: 'https://portal.wavespestcontrol.com/r/LENA25',
  portalUrl: 'https://portal.wavespestcontrol.com',
};

describe('wallet-pass buildPassJson', () => {
  test('builds a generic navy pass with the tracked review QR', () => {
    const p = buildPassJson({ ...BASE, nextVisitLabel: 'Sep 9' });
    expect(p.passTypeIdentifier).toBe('pass.com.wavespestcontrol.card');
    expect(p.teamIdentifier).toBe('BMNXJ4Q89M');
    expect(p.serialNumber).toBe('card-uuid-1');
    expect(p.backgroundColor).toBe('rgb(4,57,94)');
    expect(p.barcodes).toEqual([expect.objectContaining({
      format: 'PKBarcodeFormatQR',
      message: 'https://portal.wavespestcontrol.com/l/g4mty',
    })]);
    expect(p.generic.primaryFields[0].value).toBe('Adam Benetti');
    expect(p.generic.headerFields[0]).toEqual(expect.objectContaining({ label: 'CUSTOMER SINCE', value: '2026' }));
    const next = p.generic.secondaryFields.find((f) => f.key === 'next_visit');
    expect(next.value).toBe('Sep 9');
    // Messages preview stacks description above organizationName — the
    // description must not repeat the company name.
    expect(p.description).toBe('Digital business card');
    expect(p.generic.auxiliaryFields[0]).toEqual(expect.objectContaining({
      label: 'TEXT OR CALL ADAM',
      value: '(941) 297-2606',
    }));
  });

  test('omits next-visit field and locations when data is missing', () => {
    const p = buildPassJson({
      ...BASE,
      card: { id: 'card-uuid-2', customer_latitude: null, customer_longitude: null },
      nextVisitLabel: null,
    });
    expect(p.generic.secondaryFields.map((f) => f.key)).toEqual(['customer']);
    expect(p.locations).toBeUndefined();
  });

  test('lock-screen relevance carries the customer coordinates', () => {
    const p = buildPassJson(BASE);
    expect(p.locations).toEqual([expect.objectContaining({ latitude: 27.33, longitude: -82.37 })]);
    expect(p.locations[0].relevantText).toContain('Adam');
  });

  test('back fields carry tappable contact, portal, referral, license', () => {
    const p = buildPassJson(BASE);
    const keys = p.generic.backFields.map((f) => f.key);
    expect(keys).toEqual(['text', 'call', 'portal', 'referral', 'website', 'license']);
    expect(p.generic.backFields[0].attributedValue).toContain('sms:+19412972606');
    expect(p.generic.backFields[5].value).toMatch(/FL License #/);
  });
});

describe('wallet-pass etDateLabel (pg DATE string trap)', () => {
  test('formats YYYY-MM-DD from string parts — never through Date/UTC', () => {
    expect(etDateLabel('2026-09-09')).toBe('Sep 9');
    expect(etDateLabel('2026-01-01')).toBe('Jan 1');
    expect(etDateLabel('2026-12-31T00:00:00.000Z')).toBe('Dec 31');
    expect(etDateLabel('garbage')).toBeNull();
    expect(etDateLabel(null)).toBeNull();
  });
});

describe('wallet-pass config gate', () => {
  test('unconfigured env reports unavailable (fails closed)', () => {
    const saved = {
      cert: process.env.PASS_SIGNER_CERT_B64,
      key: process.env.PASS_SIGNER_KEY_B64,
      wwdr: process.env.PASS_WWDR_CERT_B64,
    };
    delete process.env.PASS_SIGNER_CERT_B64;
    delete process.env.PASS_SIGNER_KEY_B64;
    delete process.env.PASS_WWDR_CERT_B64;
    expect(walletConfigured()).toBe(false);
    if (saved.cert) process.env.PASS_SIGNER_CERT_B64 = saved.cert;
    if (saved.key) process.env.PASS_SIGNER_KEY_B64 = saved.key;
    if (saved.wwdr) process.env.PASS_WWDR_CERT_B64 = saved.wwdr;
  });
});
