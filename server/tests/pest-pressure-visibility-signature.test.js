const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const {
  pestPressureVisibilitySignature,
  invalidatePdfCacheForServiceRecord,
  VISIBILITY_AFFECTING_FIELDS,
} = require('../services/pest-pressure/store');
const { reportPdfStorageKey } = require('../services/service-report/pdf-storage');

function clone(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

describe('pestPressureVisibilitySignature', () => {
  test('returns a stable 12-char hex hash for identical configs', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature(clone(DEFAULT_CONFIG));
    expect(sig1).toMatch(/^[0-9a-f]{12}$/);
    expect(sig1).toBe(sig2);
  });

  test('changes when enabled flips', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, enabled: false });
    expect(sig1).not.toBe(sig2);
  });

  test('changes when showOnCustomerReport flips', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, showOnCustomerReport: false });
    expect(sig1).not.toBe(sig2);
  });

  test('changes when enabledServiceLines content changes', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, enabledServiceLines: ['pest'] });
    expect(sig1).not.toBe(sig2);
  });

  test('changes when requireRecurringFrequency flips', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, requireRecurringFrequency: false });
    expect(sig1).not.toBe(sig2);
  });

  test('STABLE across allowed-line ordering (pest,mosquito === mosquito,pest)', () => {
    // Sorted internally so admin reordering the array doesn't gratuitously
    // invalidate every cached PDF.
    const sigA = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, enabledServiceLines: ['pest', 'mosquito'] });
    const sigB = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, enabledServiceLines: ['mosquito', 'pest'] });
    expect(sigA).toBe(sigB);
  });

  test('STABLE when a non-visibility field changes (e.g. weights)', () => {
    // The signature must NOT bump on weight/label edits — those affect the
    // calculated score, not customer visibility. Cached PDFs render the
    // displayed score from pest_pressure_scores, which gets a fresh row
    // on the next service-record recalc.
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({
      ...DEFAULT_CONFIG,
      weights: { client: 30, technician: 25, reService: 20, recurring: 15, risk: 10 },
    });
    expect(sig1).toBe(sig2);
  });

  test('handles null / undefined config defensively (no throw)', () => {
    expect(() => pestPressureVisibilitySignature(null)).not.toThrow();
    expect(() => pestPressureVisibilitySignature(undefined)).not.toThrow();
    // Both should produce the same "everything-false" signature.
    expect(pestPressureVisibilitySignature(null)).toBe(pestPressureVisibilitySignature(undefined));
  });

  test('changes when showHowCalculated flips', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, showHowCalculated: false });
    expect(sig1).not.toBe(sig2);
  });

  test('changes when showComponentBreakdownToCustomer flips', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({ ...DEFAULT_CONFIG, showComponentBreakdownToCustomer: true });
    expect(sig1).not.toBe(sig2);
  });

  test('changes when customerExplanationText is edited (copy edit invalidates cache)', () => {
    const sig1 = pestPressureVisibilitySignature(DEFAULT_CONFIG);
    const sig2 = pestPressureVisibilitySignature({
      ...DEFAULT_CONFIG,
      customerExplanationText: `${DEFAULT_CONFIG.customerExplanationText}\n\n(Updated.)`,
    });
    expect(sig1).not.toBe(sig2);
  });

  test('VISIBILITY_AFFECTING_FIELDS lists all customer-facing visibility controls', () => {
    expect(VISIBILITY_AFFECTING_FIELDS).toEqual([
      'enabled',
      'showOnCustomerReport',
      'enabledServiceLines',
      'requireRecurringFrequency',
      'showHowCalculated',
      'customerExplanationText',
      'showComponentBreakdownToCustomer',
    ]);
  });
});

describe('invalidatePdfCacheForServiceRecord', () => {
  function mockKnex({ updateImpl } = {}) {
    const builder = {
      where: jest.fn().mockReturnThis(),
      update: jest.fn(updateImpl || (() => Promise.resolve(1))),
    };
    const knex = jest.fn().mockReturnValue(builder);
    return { knex, builder };
  }

  test('nulls out pdf_storage_key on the named service record', async () => {
    const { knex, builder } = mockKnex();
    await invalidatePdfCacheForServiceRecord(knex, 'svc-1');
    expect(knex).toHaveBeenCalledWith('service_records');
    expect(builder.where).toHaveBeenCalledWith({ id: 'svc-1' });
    expect(builder.update).toHaveBeenCalledWith({ pdf_storage_key: null });
  });

  test('no-op when serviceRecordId is missing', async () => {
    const { knex } = mockKnex();
    await invalidatePdfCacheForServiceRecord(knex, null);
    expect(knex).not.toHaveBeenCalled();
  });

  test('swallows UPDATE errors (best-effort side effect)', async () => {
    const { knex } = mockKnex({ updateImpl: () => Promise.reject(new Error('connection refused')) });
    // Must not throw — the score write is the primary record; a cache
    // invalidation failure shouldn't fail the user-facing operation.
    await expect(invalidatePdfCacheForServiceRecord(knex, 'svc-1')).resolves.toBeUndefined();
  });
});

describe('reportPdfStorageKey: visibilitySignature embedding', () => {
  test('omits the signature suffix when not supplied (back-compat)', () => {
    const key = reportPdfStorageKey('svc-1');
    expect(key).toMatch(/^reports\/svc-1\/report-[^.]+\.pdf$/);
    expect(key).not.toContain('-pp');
  });

  test('embeds the signature in the path when supplied', () => {
    const key = reportPdfStorageKey('svc-1', { visibilitySignature: 'abc123def456' });
    expect(key).toContain('-ppabc123def456');
  });

  test('different signatures produce different keys (cache miss)', () => {
    const k1 = reportPdfStorageKey('svc-1', { visibilitySignature: 'sig1' });
    const k2 = reportPdfStorageKey('svc-1', { visibilitySignature: 'sig2' });
    expect(k1).not.toBe(k2);
  });
});
