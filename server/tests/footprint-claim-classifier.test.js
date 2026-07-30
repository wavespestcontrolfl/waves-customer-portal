jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const {
  classifyFootprintEvidence,
  refineFootprintFindings,
  _internals,
} = require('../services/content/footprint-claim-classifier');
const { _internals: guardrailInternals } = require('../services/content/content-guardrails');

const CLAIM_FINDING = () => ({
  severity: 'P0',
  code: 'OFF_FOOTPRINT_CITY_CLAIM',
  message: 'Draft makes a service claim naming "Naples", which is outside the Waves service footprint (config/locations CITY_TO_LOCATION). Educational mentions and honest out-of-area disclaimers are fine; service/CTA framing is not.',
  evidence: [{ city: 'Naples', clause: 'Our team also treats Naples lawns every spring.' }],
});
const OTHER_FINDING = () => ({ severity: 'P1', code: 'HARDCODED_PRICE', message: 'x' });

beforeEach(() => {
  jest.clearAllMocks();
  _internals.verdictCache.clear();
});

describe('classifyFootprintEvidence', () => {
  test('returns the parsed verdict and caches by (city, clause)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { is_service_claim: false, reason: 'editorial mention' } });
    const first = await classifyFootprintEvidence({ city: 'Naples', clause: 'Researchers call Naples a tegu hotspot.' });
    expect(first).toEqual({ is_service_claim: false, reason: 'editorial mention' });
    const second = await classifyFootprintEvidence({ city: 'Naples', clause: 'Researchers call Naples a tegu hotspot.' });
    expect(second).toEqual(first);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('returns null on provider failure and on malformed output', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'no_key' });
    expect(await classifyFootprintEvidence({ city: 'Tampa', clause: 'We serve Tampa.' })).toBeNull();
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { is_service_claim: 'yes' } });
    expect(await classifyFootprintEvidence({ city: 'Tampa', clause: 'We serve Tampa.' })).toBeNull();
  });

  test('routes through the fastStructured policy with a bounded timeout', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { is_service_claim: true, reason: 'direct claim' } });
    await classifyFootprintEvidence({ city: 'Naples', clause: 'We proudly serve Naples.' });
    const [policy, payload] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(require('../config/models').TEXT_POLICIES.fastStructured);
    expect(payload.jsonMode).toBe(true);
    expect(payload.timeoutMs).toBeLessThanOrEqual(20_000);
    expect(payload.system).toContain('OUTSIDE the Waves service footprint');
  });
});

describe('refineFootprintFindings', () => {
  test('dismisses the finding only when every pair classifies as non-claim', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { is_service_claim: false, reason: 'honest disclaimer' } });
    const refined = await refineFootprintFindings([OTHER_FINDING(), CLAIM_FINDING()]);
    expect(refined.map((f) => f.code)).toEqual(['HARDCODED_PRICE']);
  });

  test('keeps the finding when any pair is confirmed as a claim', async () => {
    dispatchWithFallback
      .mockResolvedValueOnce({ ok: true, json: { is_service_claim: false, reason: 'disclaimer' } })
      .mockResolvedValueOnce({ ok: true, json: { is_service_claim: true, reason: 'CTA framing' } });
    const f = CLAIM_FINDING();
    f.evidence.push({ city: 'Tampa', clause: 'Call us today for Tampa mosquito control.' });
    const refined = await refineFootprintFindings([f]);
    expect(refined).toHaveLength(1);
    expect(refined[0].code).toBe('OFF_FOOTPRINT_CITY_CLAIM');
  });

  test('fails closed on classifier failure', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'error' });
    const refined = await refineFootprintFindings([CLAIM_FINDING()]);
    expect(refined).toHaveLength(1);
  });

  test('fails closed when the evidence list exceeds the refinement bound', async () => {
    const f = CLAIM_FINDING();
    f.evidence = Array.from({ length: _internals.MAX_EVIDENCE_PAIRS + 1 }, (_, i) => ({ city: 'Naples', clause: `clause ${i}` }));
    const refined = await refineFootprintFindings([f]);
    expect(refined).toHaveLength(1);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('passes findings through untouched when nothing is refinable', async () => {
    const noEvidence = { severity: 'P0', code: 'OFF_FOOTPRINT_CITY_CLAIM', message: 'legacy shape' };
    const list = [OTHER_FINDING(), noEvidence];
    expect(await refineFootprintFindings(list)).toEqual(list);
    expect(await refineFootprintFindings(undefined)).toBeUndefined();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('guardrails evidence contract', () => {
  test('offFootprintCityFinding carries every offending (city, clause) pair', () => {
    const text = 'We proudly serve Naples homes. Our techs also treat Fort Myers lawns weekly.';
    const found = guardrailInternals.offFootprintCityFinding(text);
    expect(found).not.toBeNull();
    expect(found.code).toBe('OFF_FOOTPRINT_CITY_CLAIM');
    expect(found.message).toContain('"Naples"');
    const cities = found.evidence.map((e) => e.city);
    expect(cities).toEqual(expect.arrayContaining(['Naples', 'Fort Myers']));
    for (const pair of found.evidence) {
      expect(typeof pair.clause).toBe('string');
      expect(pair.clause.length).toBeGreaterThan(0);
    }
  });

  test('honest disclaimer copy still passes deterministically (no refinement needed)', () => {
    const text = 'Naples is outside our service area, but we serve Sarasota and Venice.';
    expect(guardrailInternals.offFootprintCityFinding(text)).toBeNull();
  });
});
