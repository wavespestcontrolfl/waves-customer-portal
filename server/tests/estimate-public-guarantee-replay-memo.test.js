/**
 * guaranteeServiceRows (routes/estimate-public.js) replays the pricing engine
 * for an inputs-only estimate so its guarantee decisions classify the rows
 * the page renders. Pre-push audit P1 on #4982: both decisions are asked by
 * every reader on a public route, so the replay must run once per parsed
 * estimate-data object, and a failed replay must fail closed once instead of
 * replaying (and warning) at every reader.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/pricing-engine', () => {
  const actual = jest.requireActual('../services/pricing-engine');
  return { ...actual, generateEstimate: jest.fn(actual.generateEstimate) };
});

const logger = require('../services/logger');
const { generateEstimate } = require('../services/pricing-engine');
const { estimateMakesNoGuaranteeClaim, estimateCarriesPlanTerms, estimateHasCommercialScope } = require('../routes/estimate-public');

const inputsOnly = (services) => ({ engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services } });

beforeEach(() => {
  generateEstimate.mockClear();
  logger.warn.mockClear();
});

describe('inputs-only guarantee classification replays the engine once per estimate data', () => {
  test('both decisions, asked repeatedly on the same parsed data, share one replay', () => {
    const estData = inputsOnly({ pest: { frequency: 'quarterly' } });
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(false);
    expect(estimateCarriesPlanTerms(estData)).toBe(true);
    expect(estimateMakesNoGuaranteeClaim(estData, { oneTimeBreakdown: { items: [] } })).toBe(false);
    expect(estimateCarriesPlanTerms(estData, { oneTimeBreakdown: { items: [] } })).toBe(true);
    expect(generateEstimate).toHaveBeenCalledTimes(1);
  });

  test('a different parsed object (or different inputs) replays on its own', () => {
    const pest = inputsOnly({ pest: { frequency: 'quarterly' } });
    const termite = inputsOnly({ termite: { stations: 12 } });
    expect(estimateMakesNoGuaranteeClaim(pest)).toBe(false);
    expect(estimateMakesNoGuaranteeClaim(termite)).toBe(true);
    expect(estimateCarriesPlanTerms(termite)).toBe(false);
    expect(generateEstimate).toHaveBeenCalledTimes(2);
  });

  test('an empty persisted result is a placeholder: the inputs replay once (Codex on 6880c57a95)', () => {
    const estData = { ...inputsOnly({ pest: { frequency: 'quarterly' } }), result: {} };
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(false);
    expect(estimateCarriesPlanTerms(estData)).toBe(true);
    expect(generateEstimate).toHaveBeenCalledTimes(1);
    const lawn = { ...inputsOnly({ lawn: { frequency: 'premium' } }), result: {}, engineResult: { recurring: { services: [] } } };
    expect(estimateMakesNoGuaranteeClaim(lawn)).toBe(false);
    expect(estimateCarriesPlanTerms(lawn)).toBe(true);
    expect(generateEstimate).toHaveBeenCalledTimes(2);
  });

  test('a persisted result never replays', () => {
    const estData = {
      ...inputsOnly({ pest: { frequency: 'quarterly' } }),
      result: { recurring: { services: [{ name: 'Pest Control', mo: 55 }] }, oneTime: { items: [] } },
    };
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(false);
    expect(estimateCarriesPlanTerms(estData)).toBe(true);
    expect(generateEstimate).not.toHaveBeenCalled();
  });

  test('a failed replay fails closed at every reader after one attempt and one warning', () => {
    generateEstimate.mockImplementationOnce(() => { throw new Error('engine down'); });
    const estData = inputsOnly({ pest: { frequency: 'quarterly' } });
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(true);
    expect(estimateCarriesPlanTerms(estData)).toBe(false);
    expect(estimateMakesNoGuaranteeClaim(estData)).toBe(true);
    expect(generateEstimate).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('an inputs-only commercial quote decides like its saved engine result', () => {
  const GATE = 'GATE_COMMERCIAL_ONETIME_SCOPED';
  let priorGate;
  beforeAll(() => { priorGate = process.env[GATE]; process.env[GATE] = '1'; });
  afterAll(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });

  const commercialBedBug = () => ({
    engineInputs: {
      isCommercial: true, category: 'COMMERCIAL', propertyType: 'commercial', commercialRiskType: 'retail_standard',
      homeSqFt: 1500, footprintSqFt: 1500, lotSqFt: 8000,
      services: { bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } },
    },
  });

  test('the replayed rows carry the commercial mark (Codex on 236d3956d6)', () => {
    const inputsOnlyQuote = commercialBedBug();
    const { generateEstimate: realGenerate } = jest.requireActual('../services/pricing-engine');
    const saved = { ...commercialBedBug(), engineResult: realGenerate(inputsOnlyQuote.engineInputs) };
    expect(saved.engineResult.lineItems.map((row) => [row.service, row.isCommercial])).toEqual([['bed_bug', true]]);
    expect(estimateHasCommercialScope(saved)).toBe(true);
    expect(estimateCarriesPlanTerms(saved)).toBe(false);
    expect(estimateHasCommercialScope(inputsOnlyQuote)).toBe(true);
    expect(estimateCarriesPlanTerms(inputsOnlyQuote)).toBe(false);
    expect(estimateMakesNoGuaranteeClaim(inputsOnlyQuote)).toBe(estimateMakesNoGuaranteeClaim(saved));
    expect(generateEstimate).toHaveBeenCalledTimes(1);
    const placeholder = { ...commercialBedBug(), result: {} };
    expect(estimateHasCommercialScope(placeholder)).toBe(true);
    expect(estimateCarriesPlanTerms(placeholder)).toBe(false);
    expect(generateEstimate).toHaveBeenCalledTimes(2);
  });
});
