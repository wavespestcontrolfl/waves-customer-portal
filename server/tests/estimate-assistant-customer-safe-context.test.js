// AW-04 (Ask Waves audit, 2026-09-25): the public estimate assistant serializes
// the ENTIRE context object — including context.supportContext.repositoryFiles
// — straight into the model prompt (buildAssistantUserContent). The repo-file
// loader used to scan internal wiki/docs trees (business strategy, dispatch
// rules, docs/pricing/POLICY.md); a customer question about material/labor
// cost pulled internal margin targets and technician-assignment notes into
// that prompt. This test mirrors the audit's own reproduction
// (ask-waves-audit-20260925/estimates/repro_internal_context.js): it stubs
// the LLM dispatch call, asks the exact audited question against the exact
// audited estimate shape, and inspects the literal text handed to the model.
jest.mock('../services/llm/call', () => ({
  dispatch: jest.fn(),
}));

const { dispatch } = require('../services/llm/call');
const { answerEstimateQuestion } = require('../services/estimate-assistant');

const INTERNAL_MARKERS = [
  'contribution margin',
  'margin',
  'cogs',
  'markup',
  'labor rate',
  'labor cost',
  'material cost',
  'dispatch',
  'route density',
  'adam only',
];

describe('estimate assistant model prompt — customer-safe context boundary (AW-04)', () => {
  beforeEach(() => {
    dispatch.mockReset();
    dispatch.mockResolvedValue({ ok: true, text: 'stub answer' });
  });

  test('the audited material/labor cost question never sends internal repo content to the model', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'What material cost and labor cost do you use for palm service?',
      estimate: {
        id: 'synthetic-estimate',
        token: 'synthetic-token',
        status: 'sent',
        customer_name: 'Synthetic Customer',
        address: 'Synthetic Address',
      },
      estData: { services: [{ service: 'tree_shrub', label: 'Tree & Shrub' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });

    // This question does not hit any deterministic fallback branch (it isn't
    // quote-required, Bora-Care, or a FORCE_FALLBACK safety/product phrasing)
    // — the audit's own reproduction confirmed it reaches the live model path,
    // which is exactly the path that serializes supportContext into the prompt.
    expect(result.source).toBe('openai');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const [, dispatchArgs] = dispatch.mock.calls[0];
    const prompt = String(dispatchArgs.text || '');
    expect(prompt).toContain('Customer question:');
    expect(prompt).toContain('Estimate context JSON:');

    const context = JSON.parse(prompt.slice(prompt.indexOf('Estimate context JSON:\n') + 'Estimate context JSON:\n'.length));
    const repositoryFiles = Array.isArray(context.supportContext?.repositoryFiles)
      ? context.supportContext.repositoryFiles
      : [];

    // The AW-04 boundary: no repo-file source at all for this question (the
    // allowlist's only entry, the misting protocol, does not match a palm/
    // tree_shrub cost question), and no internal marker anywhere in the
    // estimate context JSON handed to the model. Checked against the
    // context object only (not the whole prompt) — the customer's OWN
    // question legitimately contains "material cost"/"labor cost" verbatim
    // and is expected to reach the model; what must never reach it is
    // internal SOURCE material echoing those same ideas back.
    expect(repositoryFiles).toEqual([]);

    const lowerContext = JSON.stringify(context).toLowerCase();
    for (const marker of INTERNAL_MARKERS) {
      expect(lowerContext).not.toContain(marker);
    }
  });
});
