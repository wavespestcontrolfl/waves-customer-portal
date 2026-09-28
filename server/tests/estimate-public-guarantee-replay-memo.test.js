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
const { estimateMakesNoGuaranteeClaim, estimateCarriesPlanTerms } = require('../routes/estimate-public');

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
