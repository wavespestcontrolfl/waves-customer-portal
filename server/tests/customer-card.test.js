/**
 * Pure-function tests for the digital business card service — no DB.
 * (Mint/email paths are DB-backed and exercised in the rig; these lock the
 * vCard escaping and location fallback logic that would fail silently.)
 */

const {
  buildVcard,
  __private: { vcardEscape, firstNameOf },
} = require('../services/customer-card');

describe('customer-card vCard builder', () => {
  test('escapes RFC 6350 specials so names cannot break the file', () => {
    expect(vcardEscape("O'Brien; Sons, Inc\\")).toBe("O'Brien\\; Sons\\, Inc\\\\");
    expect(vcardEscape('line1\nline2')).toBe('line1\\nline2');
    expect(vcardEscape(null)).toBe('');
  });

  test('builds a well-formed vCard with tech, phone, license, address', () => {
    const vcf = buildVcard({
      techName: 'Adam Benetti',
      phoneE164: '+19413187612',
      licenseLine: 'FL License #JB351547',
      addressLine: '13649 Luxe Ave #110, Bradenton, FL 34211',
    });
    expect(vcf.startsWith('BEGIN:VCARD\r\nVERSION:3.0')).toBe(true);
    expect(vcf).toContain('N:Benetti;Adam;;;');
    expect(vcf).toContain('FN:Adam Benetti');
    expect(vcf).toContain('TEL;TYPE=WORK,VOICE:+19413187612');
    expect(vcf).toContain('ORG:Waves Pest Control');
    expect(vcf).toContain('FL License #JB351547');
    expect(vcf).toContain('ADR;TYPE=WORK:;;13649 Luxe Ave #110;Bradenton;FL;34211;USA');
    expect(vcf.trim().endsWith('END:VCARD')).toBe(true);
  });

  test('falls back to the company identity when no tech is on record', () => {
    const vcf = buildVcard({
      techName: null,
      phoneE164: '+19412975749',
      licenseLine: 'FL License #JB351547',
      addressLine: '13649 Luxe Ave #110, Bradenton, FL 34211',
    });
    expect(vcf).toContain('FN:Waves Pest Control');
  });

  test('firstNameOf trims to the first token', () => {
    expect(firstNameOf('Adam Benetti')).toBe('Adam');
    expect(firstNameOf('  ')).toBe('');
    expect(firstNameOf(null)).toBe('');
  });
});

describe('customer-card location pick', () => {
  const { __private: { pickCardLocation } } = require('../services/customer-card');

  test('geodata wins: routes to the nearest GBP office', () => {
    // Venice office coordinates → venice.
    const loc = pickCardLocation({ latitude: 27.0871, longitude: -82.4047, city: 'Bradenton' });
    expect(loc.id).toBe('venice');
    expect(loc.googleReviewUrl).toMatch(/^https:\/\/g\.page\/r\//);
  });

  test('no geodata: falls back to the review-routing city map (with overrides)', () => {
    // Palmetto is a review-only override → bradenton GBP, not parrish.
    const loc = pickCardLocation({ city: 'Palmetto' });
    expect(loc.id).toBe('bradenton');
  });

  test('unknown city and no geodata: defaults to bradenton', () => {
    const loc = pickCardLocation({ city: 'Rotonda West' });
    expect(loc.id).toBe('bradenton');
  });
});
