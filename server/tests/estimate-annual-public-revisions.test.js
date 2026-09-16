const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const {
  annualPlanOfferFingerprint,
  annualPlanHasDeliveredOffer,
  annualPlanPublicReplayBlocked,
  captureAnnualPlanPublicRevision,
  stampAnnualPlanPublicRevision,
} = require('../services/estimate-offer-version');

const copy = (value) => JSON.parse(JSON.stringify(value));
const originalGates = {
  annual: process.env.GATE_TERMITE_ANNUAL_PLAN,
  cancellation: process.env.GATE_CANCEL_FLOW_V2,
};

function restoreGate(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let annualResult;
let annualInputs;

beforeAll(() => {
  process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  try {
    annualInputs = {
      homeSqFt: 2000, lotSqFt: 8000, propertyType: 'single_family',
      services: {
        pest: { frequency: 'quarterly' },
        termite: { system: 'trelona', plan: 'annual_protection' },
      },
    };
    const raw = generateEstimate(annualInputs);
    expect(raw.lineItems.find((line) => line.service === 'termite_bait')).toMatchObject({
      plan: 'annual_protection', visitsPerYear: 1,
    });
    annualResult = { raw, mapped: mapV1ToLegacyShape(raw) };
    expect(annualResult.mapped.results.tmBait).toMatchObject({ plan: 'annual_protection' });
  } finally {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    delete process.env.GATE_CANCEL_FLOW_V2;
  }
});

afterAll(() => {
  restoreGate('GATE_TERMITE_ANNUAL_PLAN', originalGates.annual);
  restoreGate('GATE_CANCEL_FLOW_V2', originalGates.cancellation);
});

function annualRow() {
  // PostgreSQL JSONB has already removed undefined mapper fields by read time.
  const data = JSON.parse(JSON.stringify({
    engineInputs: copy(annualInputs),
    engineResult: copy(annualResult.raw),
    result: copy(annualResult.mapped),
  }));
  return {
    id: 'estimate-annual', token: 'annual-token', status: 'sent',
    customer_id: 'customer-1', property_id: 'property-1', estimate_group_id: 'group-1',
    customer_name: 'Ada Customer', customer_phone: '555-0100', customer_email: 'ada@example.test',
    address: '1 Main St', notes: 'Original scope',
    monthly_total: data.result.recurring.monthlyTotal,
    annual_total: data.result.recurring.annualTotal,
    onetime_total: data.result.oneTime.total,
    show_one_time_option: true, bill_by_invoice: false,
    estimate_data: data,
  };
}

function deliveredAnnual() {
  const row = annualRow();
  row.estimate_data.deliveryState = {
    firstDeliveredAt: '2026-09-12T00:00:00.000Z',
    annualPlanOfferFingerprint: annualPlanOfferFingerprint(row),
  };
  expect(annualPlanHasDeliveredOffer(row)).toBe(true);
  return row;
}

function changedData(row, change) {
  const data = copy(row.estimate_data);
  change(data);
  return { estimate_data: data };
}

function persistRevision(row, kind, change) {
  const source = captureAnnualPlanPublicRevision(row);
  expect(source).not.toBeNull();
  expect(annualPlanHasDeliveredOffer(source)).toBe(true);
  const writes = stampAnnualPlanPublicRevision(source, changedData(row, change), kind);
  return { ...row, ...writes, estimate_data: JSON.parse(writes.estimate_data) };
}

function expectConflict(fn) {
  try {
    fn();
    throw new Error('Expected annual revision conflict');
  } catch (error) {
    expect(error.status).toBe(409);
  }
}

describe('delivered annual public revisions', () => {
  test('post-handoff automatic-send bookkeeping does not change the offer witness', () => {
    const row = deliveredAnnual();
    row.estimate_data.automation = { autoSend: { attemptedAt: new Date().toISOString(), result: 'sent',
      sentChannels: ['email'], failedChannels: [] } };
    expect(annualPlanHasDeliveredOffer(row)).toBe(true);
    row.estimate_data.automation.offerScope = 'changed';
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
  });
  test('the witness survives decimal-string totals and JSONB object key ordering', () => {
    const source = deliveredAnnual();
    const writes = stampAnnualPlanPublicRevision(captureAnnualPlanPublicRevision(source), {
      monthly_total: 45, annual_total: 540,
      estimate_data: JSON.stringify({ ...source.estimate_data, preferences: { interior_spray: false } }),
    }, 'preferences');
    const persisted = { ...source, ...writes, monthly_total: '45.00', annual_total: '540.00',
      onetime_total: Number(source.onetime_total).toFixed(2),
      estimate_data: JSON.parse(writes.estimate_data, (_key, value) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, value[key]])) : value
      )),
    };
    expect(annualPlanHasDeliveredOffer(persisted)).toBe(true);
    expect(annualPlanPublicReplayBlocked(persisted)).toBe(false);
    persisted.monthly_total = '46.00';
    expect(annualPlanHasDeliveredOffer(persisted)).toBe(false);
  });

  test.each([
    ['select-tier', (data) => { data.result.recurring.tier = 'Gold'; }],
    ['preferences', (data) => { data.customerPreferences = { preferredVisitDay: 'Tuesday' }; }],
    ['interior-service', (data) => { data.interiorService = { selected: true }; }],
    ['service-mix', (data) => { data.result.recurring.services.push({ service: 'mosquito', mo: 20 }); }],
  ])('%s can revise the real delivered annual offer while the selection gate is closed', (kind, change) => {
    const original = deliveredAnnual();
    const root = original.estimate_data.deliveryState.annualPlanOfferFingerprint;
    const revised = persistRevision(original, kind, change);
    const [revision] = revised.estimate_data.deliveryState.annualPlanPublicRevisions;
    expect(revision).toMatchObject({
      version: 1, kind, sourceFingerprint: root, previousFingerprint: root,
      fingerprint: annualPlanOfferFingerprint(revised),
    });
    expect(revision.at).toEqual(expect.any(String));
    expect(revised.estimate_data.deliveryState.annualPlanOfferFingerprint).toBe(root);
    expect(annualPlanHasDeliveredOffer(revised)).toBe(true);
    expect(annualPlanPublicReplayBlocked(revised)).toBe(false);
    expect(annualPlanOfferFingerprint(revised)).not.toBe(root);
  });

  test('successive edits retain the original handoff and bound the revision history to 32', () => {
    let row = deliveredAnnual();
    const root = row.estimate_data.deliveryState.annualPlanOfferFingerprint;
    for (let index = 0; index < 36; index += 1) {
      const before = annualPlanOfferFingerprint(row);
      row = persistRevision(row, 'preferences', (data) => { data.customerPreferences = { sequence: index }; });
      const revisions = row.estimate_data.deliveryState.annualPlanPublicRevisions;
      expect(revisions.at(-1)).toMatchObject({
        sourceFingerprint: root, previousFingerprint: before,
        fingerprint: annualPlanOfferFingerprint(row),
      });
      expect(revisions).toHaveLength(Math.min(index + 1, 32));
      expect(row.estimate_data.deliveryState.annualPlanOfferFingerprint).toBe(root);
      expect(annualPlanHasDeliveredOffer(row)).toBe(true);
      expect(annualPlanPublicReplayBlocked(row)).toBe(false);
    }
    expect(row.estimate_data.deliveryState.annualPlanPublicRevisions[0].previousFingerprint).not.toBe(root);
  });

  test('capture deep-copies the offer before in-place reconciliation changes it', () => {
    const row = deliveredAnnual();
    const source = captureAnnualPlanPublicRevision(row);
    const originalFingerprint = annualPlanOfferFingerprint(source);
    row.estimate_data.result.recurring.tier = 'Gold';
    expect(source.estimate_data.result.recurring.tier).not.toBe('Gold');
    expect(annualPlanOfferFingerprint(source)).toBe(originalFingerprint);
    const stamped = stampAnnualPlanPublicRevision(source, { estimate_data: copy(row.estimate_data) }, 'select-tier');
    const revised = { ...row, ...stamped, estimate_data: JSON.parse(stamped.estimate_data) };
    expect(annualPlanHasDeliveredOffer(revised)).toBe(true);
  });

  test('a repeated write leaves the witness history unchanged', () => {
    const row = persistRevision(deliveredAnnual(), 'preferences', (data) => { data.customerPreferences = { sequence: 1 }; });
    const writes = changedData(row, () => {});
    expect(stampAnnualPlanPublicRevision(captureAnnualPlanPublicRevision(row), writes, 'preferences')).toBe(writes);
  });

  test('undelivered or stale annual rows cannot create a handoff witness', () => {
    const neverDelivered = annualRow();
    const earlierQuarterlyHandoff = annualRow();
    earlierQuarterlyHandoff.estimate_data.deliveryState = { firstDeliveredAt: '2026-09-12T00:00:00.000Z' };
    const stale = deliveredAnnual();
    stale.estimate_data.result.recurring.tier = 'Changed after delivery';
    for (const row of [neverDelivered, earlierQuarterlyHandoff, stale]) {
      expect(captureAnnualPlanPublicRevision(row)).toBeNull();
      expect(annualPlanHasDeliveredOffer(row)).toBe(false);
      expect(annualPlanPublicReplayBlocked(row)).toBe(true);
      const writes = changedData(row, (data) => { data.customerPreferences = { preferredVisitDay: 'Tuesday' }; });
      expect(stampAnnualPlanPublicRevision(null, writes, 'preferences')).toBe(writes);
      expect(writes.estimate_data.deliveryState?.annualPlanPublicRevisions).toBeUndefined();
      expectConflict(() => stampAnnualPlanPublicRevision(row, writes, 'preferences'));
    }
  });

  test.each([
    ['notes', (row) => { row.notes = 'Different scope'; }],
    ['recipient', (row) => { row.customer_email = 'other@example.test'; }],
    ['property', (row) => { row.property_id = 'property-2'; }],
    ['one-time option', (row) => { row.show_one_time_option = false; }],
    ['billing mode', (row) => { row.bill_by_invoice = true; }],
    ['annual fee', (row) => { row.estimate_data.result.results.tmBait.annualFee += 50; }],
    ['station setup', (row) => { row.estimate_data.result.results.tmBait.setupFee += 30; }],
  ])('rejects changed %s with 409', (_label, change) => {
    const original = deliveredAnnual();
    const next = copy(original);
    change(next);
    next.estimate_data.customerPreferences = { preferredVisitDay: 'Tuesday' };
    const writes = { ...next, estimate_data: next.estimate_data };
    expectConflict(() => stampAnnualPlanPublicRevision(captureAnnualPlanPublicRevision(original), writes, 'preferences'));
  });

  test('an unrelated change after a recognized revision invalidates the full fingerprint', () => {
    const row = persistRevision(deliveredAnnual(), 'preferences', (data) => { data.customerPreferences = { sequence: 1 }; });
    row.estimate_data.unrecognizedOfferChange = { newTerm: 'extra' };
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
    expect(annualPlanPublicReplayBlocked(row)).toBe(true);
    expect(captureAnnualPlanPublicRevision(row)).toBeNull();
    expectConflict(() => stampAnnualPlanPublicRevision(row, changedData(row, (data) => {
      data.customerPreferences = { sequence: 2 };
    }), 'preferences'));
  });

  test.each([
    ['wrong root', (revision) => { revision.sourceFingerprint = 'forged-root'; }],
    ['disconnected chain', (revision) => { revision.previousFingerprint = 'disconnected'; }],
    ['unrecognized kind', (revision) => { revision.kind = 'admin-reprice'; }],
  ])('rejects a %s revision witness', (_label, corrupt) => {
    let row = persistRevision(deliveredAnnual(), 'preferences', (data) => { data.customerPreferences = { sequence: 1 }; });
    row = persistRevision(row, 'select-tier', (data) => { data.result.recurring.tier = 'Gold'; });
    corrupt(row.estimate_data.deliveryState.annualPlanPublicRevisions[1]);
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
    expect(annualPlanPublicReplayBlocked(row)).toBe(true);
    expect(captureAnnualPlanPublicRevision(row)).toBeNull();
  });

  test('a quarterly estimate keeps its existing public replay behavior', () => {
    const row = annualRow();
    row.estimate_data.result.results.tmBait.plan = 'quarterly';
    row.estimate_data.engineResult.lineItems.find((line) => line.service === 'termite_bait').plan = 'quarterly';
    expect(annualPlanOfferFingerprint(row)).toBeNull();
    expect(annualPlanHasDeliveredOffer(row)).toBe(false);
    expect(annualPlanPublicReplayBlocked(row)).toBe(false);
    expect(captureAnnualPlanPublicRevision(row)).toBeNull();
  });
});
