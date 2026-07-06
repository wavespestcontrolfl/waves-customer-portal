// Phase 3 (marketing experiments): attribution.anon_id → leads.anon_id
// joinability. The id must satisfy the SAME shape contract as the public
// exposure intake's UNIT_ID_RE, or the experiment_exposures join is dead
// weight — sanitizeAnonUnitId is the single gate all three public lead-intake
// routes share.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { sanitizeAnonUnitId } = require('../services/experimentation/growthbook');
const { _test } = require('../routes/lead-webhook');
const { buildLeadWebhookIntake } = _test;

describe('sanitizeAnonUnitId — exposure-intake shape contract', () => {
  test('accepts a crypto.randomUUID-style id (the waves_exp_uid happy path)', () => {
    const uid = '1c9f2a44-9b1e-4c5d-8a3f-2b7c6d5e4f30';
    expect(sanitizeAnonUnitId(uid)).toBe(uid);
  });

  test('accepts the storage-blocked fallback format (anon-<ts>-<rand>)', () => {
    expect(sanitizeAnonUnitId('anon-m3k9x1-a1b2c3d4e5')).toBe('anon-m3k9x1-a1b2c3d4e5');
  });

  test('rejects too-short, too-long, and charset-violating values', () => {
    expect(sanitizeAnonUnitId('short')).toBeNull();               // < 8 chars
    expect(sanitizeAnonUnitId('x'.repeat(191))).toBeNull();       // > 190 chars
    expect(sanitizeAnonUnitId('has spaces not allowed')).toBeNull();
    expect(sanitizeAnonUnitId("uid'; DROP TABLE leads;--")).toBeNull();
    expect(sanitizeAnonUnitId('emoji-💥-payload')).toBeNull();
  });

  test('rejects non-strings (objects/arrays/numbers from a crafted payload)', () => {
    expect(sanitizeAnonUnitId(null)).toBeNull();
    expect(sanitizeAnonUnitId(undefined)).toBeNull();
    expect(sanitizeAnonUnitId(12345678)).toBeNull();
    expect(sanitizeAnonUnitId({ uid: 'a'.repeat(20) })).toBeNull();
    expect(sanitizeAnonUnitId(['a'.repeat(20)])).toBeNull();
  });

  test('accepts exactly the boundary lengths (8 and 190)', () => {
    expect(sanitizeAnonUnitId('a'.repeat(8))).toBe('a'.repeat(8));
    expect(sanitizeAnonUnitId('a'.repeat(190))).toBe('a'.repeat(190));
  });
});

describe('buildLeadWebhookIntake — anonId capture', () => {
  const UID = 'de305d54-75b4-431b-adb2-eb6b9e546014';

  test('captures anon_id from the nested attribution object (Astro forms)', () => {
    const intake = buildLeadWebhookIntake({ attribution: { anon_id: UID } });
    expect(intake.anonId).toBe(UID);
  });

  test('top-level body.anon_id wins over the nested value (flat-caller precedence)', () => {
    const other = '9b2cfa10-0d5c-4a6e-bb1f-3e8a7c6d5e4f';
    const intake = buildLeadWebhookIntake({ anon_id: other, attribution: { anon_id: UID } });
    expect(intake.anonId).toBe(other);
  });

  test('null when absent — never an empty string (column stays NULL, metric filter clean)', () => {
    expect(buildLeadWebhookIntake({}).anonId).toBeNull();
    expect(buildLeadWebhookIntake({ attribution: {} }).anonId).toBeNull();
  });

  test('null when malformed — a junk id must not reach the leads column', () => {
    expect(buildLeadWebhookIntake({ attribution: { anon_id: 'nope' } }).anonId).toBeNull();
    expect(buildLeadWebhookIntake({ attribution: { anon_id: { $gt: '' } } }).anonId).toBeNull();
  });
});
