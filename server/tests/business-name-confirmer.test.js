jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const { confirmBusinessNames, _internals } = require('../services/content/business-name-confirmer');
const { businessNameCandidatesKey } = require('../services/content/comparison-table-gate');

// Synthetic drafts only. The comparison gate's high-recall candidates go to
// ONE structured FAST call; the answer decides which are companies (Codex r2
// on #5146: word lists cannot tell "Acme Pest Solutions competes with Orkin"
// from "Biological Pest Control offers a way…").
const ACME = { name: 'Acme Pest Solutions', sentence: 'Acme Pest Solutions competes with Orkin in Sarasota.' };
const BIO = { name: 'Biological Pest Control', sentence: 'Biological Pest Control offers a way to reduce chemical use.' };

beforeEach(() => jest.clearAllMocks());

describe('confirmBusinessNames', () => {
  test('one fastStructured call on the registered lane; confirmed companies come back, concepts do not', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { candidates: [
      { candidate: 'Acme Pest Solutions', is_business: true },
      { candidate: 'Biological Pest Control', is_business: false },
    ] } });

    const r = await confirmBusinessNames([ACME, BIO]);

    expect(r).toMatchObject({ ok: true, key: businessNameCandidatesKey([ACME, BIO]), companies: ['Acme Pest Solutions'] });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const [policy, payload] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.fastStructured);
    expect(payload).toMatchObject({ laneId: 'business_name_confirm', jsonMode: true });
    expect(payload.text).toContain(ACME.sentence);
  });

  test('provider failure, a throw, or an answer that does not cover every candidate fails closed', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'no_key' });
    expect(await confirmBusinessNames([ACME])).toMatchObject({ ok: false, reason: 'no_key' });

    dispatchWithFallback.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await confirmBusinessNames([ACME])).toMatchObject({ ok: false });

    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { candidates: [{ candidate: 'Acme Pest Solutions', is_business: true }] } });
    expect(await confirmBusinessNames([ACME, BIO])).toMatchObject({ ok: false });

    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { candidates: [{ candidate: 'Somebody Else', is_business: false }] } });
    expect(await confirmBusinessNames([ACME])).toMatchObject({ ok: false });
  });

  test('no candidates, a reusable stored result, or an oversized list never calls the model', async () => {
    expect(await confirmBusinessNames([])).toMatchObject({ ok: true, companies: [] });

    const prior = { ok: true, key: businessNameCandidatesKey([ACME]), companies: ['Acme Pest Solutions'] };
    expect(await confirmBusinessNames([ACME], { prior })).toBe(prior);

    const many = Array.from({ length: _internals.MAX_CANDIDATES + 1 }, (_, i) => ({ name: `Firm${i} Pest Control`, sentence: `Firm${i} Pest Control treats homes.` }));
    expect(await confirmBusinessNames(many)).toMatchObject({ ok: false, reason: expect.stringMatching(/^too_many_candidates/) });

    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a stored result for DIFFERENT text is not reused', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { candidates: [{ candidate: 'Acme Pest Solutions', is_business: true }] } });
    const stale = { ok: true, key: businessNameCandidatesKey([{ ...ACME, sentence: 'An older sentence.' }]), companies: [] };
    expect(await confirmBusinessNames([ACME], { prior: stale })).toMatchObject({ ok: true, companies: ['Acme Pest Solutions'] });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });
});
