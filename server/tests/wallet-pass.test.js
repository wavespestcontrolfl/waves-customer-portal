/**
 * Pure-function tests for the Wallet pass builder — no DB, no signing.
 * (Signing is exercised against the real certs on the rig; these lock the
 * pass.json structure and the unconfigured-env gate.)
 */

const {
  walletConfigured,
  buildPassJson,
} = require('../services/wallet-pass');

const BASE = {
  card: { id: 'card-uuid-1' },
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
  cardUrl: 'https://portal.wavespestcontrol.com/card/abc',
};

describe('wallet-pass buildPassJson', () => {
  test('builds a generic navy pass with the tracked review QR', () => {
    const p = buildPassJson(BASE);
    expect(p.passTypeIdentifier).toBe('pass.com.wavespestcontrol.card');
    expect(p.teamIdentifier).toBe('BMNXJ4Q89M');
    expect(p.serialNumber).toBe('card-uuid-1');
    expect(p.backgroundColor).toBe('rgb(4,57,94)');
    expect(p.description).toBe('Digital business card');
    expect(p.barcodes).toEqual([expect.objectContaining({
      format: 'PKBarcodeFormatQR',
      message: 'https://portal.wavespestcontrol.com/l/g4mty',
      altText: 'Review Waves on Google',
    })]);
    expect(p.generic.primaryFields[0].value).toBe('Adam Benetti');
    expect(p.generic.headerFields[0]).toEqual(expect.objectContaining({ label: 'CUSTOMER SINCE', value: '2026' }));
    expect(p.generic.auxiliaryFields[0]).toEqual(expect.objectContaining({
      label: 'TEXT OR CALL ADAM',
      value: '(941) 297-2606',
    }));
  });

  test('static pass carries NO next-visit field and NO customer coordinates', () => {
    // Codex #2592: no PassKit update plumbing → a next-visit date would sit
    // stale forever, and home coordinates in a downloadable pkpass leak to
    // anyone holding the file.
    const p = buildPassJson(BASE);
    expect(p.generic.secondaryFields.map((f) => f.key)).toEqual(['customer']);
    expect(p.locations).toBeUndefined();
  });

  test('already-reviewed customers get a card-link QR, not a review ask', () => {
    const p = buildPassJson({ ...BASE, hasLeftGoogleReview: true });
    expect(p.barcodes).toEqual([expect.objectContaining({
      message: 'https://portal.wavespestcontrol.com/card/abc',
      altText: 'Open your Waves card',
    })]);
  });

  test('back fields carry card link, tappable contact, portal, referral, socials, license', () => {
    const p = buildPassJson(BASE);
    const keys = p.generic.backFields.map((f) => f.key);
    expect(keys).toEqual(['card', 'text', 'call', 'portal', 'referral', 'website', 'instagram', 'facebook', 'license']);
    expect(p.generic.backFields[0].attributedValue).toContain('/card/abc');
    expect(p.generic.backFields[1].attributedValue).toContain('sms:+19412972606');
    expect(keys[keys.length - 1]).toBe('license');
    expect(p.associatedStoreIdentifiers).toEqual([6782775654]);
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
