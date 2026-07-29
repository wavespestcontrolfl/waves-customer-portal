/**
 * Pest curve provenance for unstamped replays (audit 2026-07-28).
 *
 * Estimator-engine drafts persisted engineInputs WITHOUT services.pest.version
 * and the public ladder replay defaulted unstamped inputs to the retired v1
 * curve — rendering (and accepting) a v2-priced draft at v1 bi-monthly/
 * monthly prices. Three layers under test:
 *   1. resolveStoredPestPricingVersion — shared stored-result evidence reader
 *      (estimate-pricing-bundle-utils), used by both the save path
 *      (admin-estimate-persistence) and the public read path.
 *   2. extractEngineInputs (estimate-public) — stamps the resolved curve on
 *      unstamped pest inputs without mutating the stored estimate_data.
 *   3. stampPestCurveVersion (draft-builder) — stamps new drafts at the
 *      source from the engine result they were priced with.
 * Plus the mirrored-section label rule: non-pest sections tracking the pest
 * cadence selector must not wear the pest ladder's "(N visits)" counts.
 */

jest.mock('../models/db', () => {
  const builder = () => {
    const b = {};
    const chain = ['where', 'whereIn', 'whereNull', 'whereNotNull', 'andWhere', 'orderBy', 'select', 'limit'];
    chain.forEach((m) => { b[m] = () => b; });
    b.first = async () => null;
    b.then = (resolve) => resolve([]);
    return b;
  };
  const db = (table) => builder(table);
  db.raw = async () => ({ rows: [] });
  db.schema = { hasTable: async () => false, hasColumn: async () => false };
  db.transaction = async (fn) => fn(db);
  return db;
});

const { resolveStoredPestPricingVersion } = require('../services/estimate-pricing-bundle-utils');
const { stampPestCurveVersion } = require('../services/estimator-engine/draft-builder');
const {
  extractEngineInputs,
  frequencyFromTreatmentRow,
} = require('../routes/estimate-public');

describe('resolveStoredPestPricingVersion', () => {
  test('agent draft: raw engineResult lineItems with v2 pest line resolves v2', () => {
    const estData = {
      engineInputs: { services: { pest: { frequency: 'bimonthly' } } },
      engineResult: {
        lineItems: [
          { service: 'lawn_care', pricingVersion: 'LAWN_PRICING_V2_SPOT_RESERVE' },
          { service: 'pest_control', pricingVersion: 'v2' },
        ],
      },
    };
    expect(resolveStoredPestPricingVersion(estData)).toBe('v2');
  });

  test('mapped result: recurring.services pest line resolves its stamp', () => {
    const estData = {
      result: { recurring: { services: [{ service: 'pest_control', pricingVersion: 'v2' }] } },
    };
    expect(resolveStoredPestPricingVersion(estData)).toBe('v2');
  });

  test('UNSTAMPED stored pest line resolves v1 (pre-#2966 sale replays its sold curve)', () => {
    const estData = {
      result: { recurring: { services: [{ service: 'pest_control', perTreatment: 99.45 }] } },
    };
    expect(resolveStoredPestPricingVersion(estData)).toBe('v1');
  });

  test('no stored pest evidence resolves null (genuinely new pest keeps live default)', () => {
    expect(resolveStoredPestPricingVersion({ result: { recurring: { services: [] } } })).toBeNull();
    expect(resolveStoredPestPricingVersion(null)).toBeNull();
  });
});

describe('extractEngineInputs curve stamping (public replay boundary)', () => {
  test('unstamped agent-draft inputs pick up the v2 stamp from engineResult', () => {
    const estData = {
      engineInputs: { services: { pest: { frequency: 'monthly', roachType: 'none' } } },
      engineResult: { lineItems: [{ service: 'pest_control', pricingVersion: 'v2' }] },
    };
    const out = extractEngineInputs(estData);
    expect(out.services.pest.version).toBe('v2');
  });

  test('stamping does NOT mutate the stored estimate_data object', () => {
    const storedPest = { frequency: 'monthly' };
    const estData = {
      engineInputs: { services: { pest: storedPest } },
      engineResult: { lineItems: [{ service: 'pest_control', pricingVersion: 'v2' }] },
    };
    extractEngineInputs(estData);
    expect(storedPest.version).toBeUndefined();
    expect(estData.engineInputs.services.pest).toBe(storedPest);
  });

  test('explicit stored version wins over result evidence', () => {
    const estData = {
      engineInputs: { services: { pest: { frequency: 'monthly', version: 'v1' } } },
      engineResult: { lineItems: [{ service: 'pest_control', pricingVersion: 'v2' }] },
    };
    expect(extractEngineInputs(estData).services.pest.version).toBe('v1');
  });

  test('no stored pest evidence leaves the input unstamped (legacy v1 replay default downstream)', () => {
    const estData = { engineInputs: { services: { pest: { frequency: 'bimonthly' } } } };
    expect(extractEngineInputs(estData).services.pest.version).toBeUndefined();
  });
});

describe('stampPestCurveVersion (draft persistence)', () => {
  test('stamps the priced curve onto unstamped inputs without mutating', () => {
    const engineInputs = { services: { pest: { frequency: 'bimonthly' } }, property: { homeSqFt: 2000 } };
    const engineResult = { lineItems: [{ service: 'pest_control', pricingVersion: 'v2' }] };
    const stamped = stampPestCurveVersion(engineInputs, engineResult);
    expect(stamped.services.pest.version).toBe('v2');
    expect(engineInputs.services.pest.version).toBeUndefined();
    expect(stamped.property).toBe(engineInputs.property);
  });

  test('no pest input / no pest line / already stamped → returns input as-is', () => {
    const noPest = { services: { lawn: { frequency: 9 } } };
    expect(stampPestCurveVersion(noPest, { lineItems: [{ service: 'pest_control', pricingVersion: 'v2' }] })).toBe(noPest);
    const noLine = { services: { pest: { frequency: 'monthly' } } };
    expect(stampPestCurveVersion(noLine, { lineItems: [] })).toBe(noLine);
    const stamped = { services: { pest: { frequency: 'monthly', version: 'v1' } } };
    expect(stampPestCurveVersion(stamped, { lineItems: [{ service: 'pest_control', pricingVersion: 'v2' }] })).toBe(stamped);
  });
});

describe('attached-garage adjustment reaches the authoritative path (codex #3040 r2 P1)', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const { generateEstimate } = require('../services/pricing-engine');

  const profileWith = (attachedGarage) => ({
    homeSqFt: 2000,
    lotSqFt: 8000,
    stories: 1,
    propertyType: 'single_family',
    attachedGarage,
  });

  test('adapter forwards profile.attachedGarage into the engine input', () => {
    const v1 = translateV2CallToV1Input(profileWith(true), [{ service: 'pest_control', frequency: 'quarterly' }], {});
    expect(v1.attachedGarage).toBe(true);
  });

  test('engine prices the +$5/visit adjustment from the forwarded flag', () => {
    const services = { pest: { frequency: 'quarterly' } };
    const withGarage = generateEstimate({ ...profileWith(true), services });
    const withoutGarage = generateEstimate({ ...profileWith(false), services });
    const pest = (r) => (r.lineItems || []).find((li) => li.service === 'pest_control');
    expect(pest(withGarage).perApp - pest(withoutGarage).perApp).toBe(5);
  });
});

describe('mirrored-section labels (lawn card must not wear pest visit counts)', () => {
  const baseFrequency = { key: 'bi_monthly', label: 'Bi-monthly (6 visits)' };
  const lawnRow = { displayPrice: 78.67, perTreatment: 78.67, visitsPerYear: 9 };

  test('non-pest mirrored entry keeps the cadence key but drops the pest "(N visits)" count', () => {
    const entry = frequencyFromTreatmentRow(baseFrequency, 'lawn_care', lawnRow, {}, { useBaseFrequencyKey: true });
    expect(entry.key).toBe('bi_monthly');
    expect(entry.label).toBe('Bi-monthly');
    expect(entry.visitsPerYear).toBe(9);
  });

  test('pest section keeps its full ladder label including the visit count', () => {
    const pestRow = { displayPrice: 102.96, perTreatment: 102.96, visitsPerYear: 6 };
    const entry = frequencyFromTreatmentRow(baseFrequency, 'pest_control', pestRow, {}, {});
    expect(entry.label).toBe('Bi-monthly (6 visits)');
  });
});
