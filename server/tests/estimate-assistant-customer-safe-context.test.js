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

  // AW-04 rd2 (Codex P1, estimate-ai-context.js:902 / estimate-assistant.js
  // ~L1490): with the fixed repo-file allowlist above, repositoryFiles is
  // empty for a non-misting question, and with database: null every DB-backed
  // support lookup (knowledgeBase, agronomicWiki, serviceLibrary,
  // productCatalog) also returns empty — so supportRows(context) is [].
  // The force-fallback gate used to also require supportRows(context).length,
  // so a pesticide safety/pet/kid question with zero support rows fell
  // through to the live model instead of the deterministic label-safety
  // branch. That gate is now unconditional on the pattern match alone.
  test('a pet-safety question reaches the deterministic path (never the live model) when every support lookup returns nothing', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'Is this safe for my dog?',
      estimate: {
        id: 'synthetic-estimate-2',
        token: 'synthetic-token-2',
        status: 'sent',
        customer_name: 'Synthetic Customer',
        address: 'Synthetic Address',
      },
      estData: { services: [{ service: 'pest_control', label: 'Pest Control' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
    expect(result.answer).toContain('follow the product label directions');
  });

  // AW-04 round 3 (Codex P2): the fix above made the ENTIRE
  // FORCE_FALLBACK_QUESTION_PATTERN unconditional, not just its safety
  // wording — that pattern also carries generic service-family words (lawn,
  // pest, inside, outside…), so a non-safety scheduling question naming a
  // service family with zero support rows also force-routed to the
  // deterministic fallback instead of reaching the live model. Only the
  // safety-specific LABEL_SAFETY_QUESTION_PATTERN is unconditional now; the
  // broader family-word pattern keeps its original `&& supportRows(context)
  // .length` requirement.
  test('a non-safety scheduling question naming a service family reaches the live model when every support lookup returns nothing', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'Can I schedule my lawn treatment for Tuesday?',
      estimate: {
        id: 'synthetic-estimate-3',
        token: 'synthetic-token-3',
        status: 'sent',
        customer_name: 'Synthetic Customer',
        address: 'Synthetic Address',
      },
      estData: { services: [{ service: 'lawn_care', label: 'Lawn Care' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
  });

  test('"When is my application?" with empty support reaches the model, not the safety fallback', async () => {
    dispatch.mockResolvedValue({ ok: true, provider: 'openai', text: 'Your first application is scheduled once you accept.' });
    const result = await answerEstimateQuestion({
      database: null,
      question: 'When is my application?',
      estimate: {
        id: 'synthetic-estimate-4',
        token: 'synthetic-token-4',
        status: 'sent',
        customer_name: 'Synthetic Customer',
        address: 'Synthetic Address',
      },
      estData: { services: [{ service: 'lawn_care', label: 'Lawn Care' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
  });

  test('"Do you spray inside?" with empty support reaches the model, not the safety fallback', async () => {
    dispatch.mockResolvedValue({ ok: true, provider: 'openai', text: 'Interior service is included on request.' });
    const result = await answerEstimateQuestion({
      database: null,
      question: 'Do you spray inside?',
      estimate: { id: 'synthetic-estimate-5', token: 'synthetic-token-5', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'pest_control', label: 'Pest Control' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
  });

  test('"Why is my lawn dry?" with empty support reaches the model, not the safety fallback', async () => {
    dispatch.mockResolvedValue({ ok: true, provider: 'openai', text: 'Dry patches usually mean irrigation coverage gaps.' });
    const result = await answerEstimateQuestion({
      database: null,
      question: 'Why is my lawn dry?',
      estimate: { id: 'synthetic-estimate-6', token: 'synthetic-token-6', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'lawn_care', label: 'Lawn Care' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
  });

  test.each([
    'Is it safe to enter my credit card here?',
    'Is my payment information safe?',
  ])('payment-security question "%s" with empty support reaches the model, not the pesticide fallback', async (question) => {
    dispatch.mockResolvedValue({ ok: true, provider: 'openai', text: 'Payments are processed securely by Stripe.' });
    const result = await answerEstimateQuestion({
      database: null,
      question,
      estimate: { id: 'synthetic-estimate-7', token: 'synthetic-token-7', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'pest_control', label: 'Pest Control' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
  });

  test('a pesticide question that also mentions paying stays on the safety route', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'Is it safe for my kids? I already paid with my card.',
      estimate: { id: 'synthetic-estimate-8', token: 'synthetic-token-8', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'pest_control', label: 'Pest Control' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
  });

  test('"Do you treat fleas on dogs?" with empty support reaches the model; "Is this safe for my dog?" does not', async () => {
    dispatch.mockResolvedValue({ ok: true, provider: 'openai', text: 'Flea treatment covers the home and yard; your vet treats the pet.' });
    const base = {
      database: null,
      estimate: { id: 'synthetic-estimate-9', token: 'synthetic-token-9', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'pest_control', label: 'Pest Control' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    };
    const coverage = await answerEstimateQuestion({ ...base, question: 'Do you treat fleas on dogs?' });
    expect(coverage.source).toBe('openai');
    dispatch.mockClear();
    const safety = await answerEstimateQuestion({ ...base, question: 'Is this safe for my dog?' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(safety.source).toBe('fallback');
  });

  test.each([
    'Which chemical do you apply for my lawn treatment?',
    'What product do you spray around the house?',
  ])('explicit product question "%s" with empty support stays on the controlled fallback', async (question) => {
    const result = await answerEstimateQuestion({
      database: null,
      question,
      estimate: { id: 'synthetic-estimate-10', token: 'synthetic-token-10', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'lawn_care', label: 'Lawn Care' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
  });

  test('"What pesticide do you use?" with empty support gets the controlled product/label answer', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'What pesticide do you use?',
      estimate: { id: 'synthetic-estimate-11', token: 'synthetic-token-11', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'pest_control', label: 'Pest Control' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
    expect(result.answer).toContain('follow the product label directions');
  });

  test.each([
    'Is it safe to accept this estimate?',
    'What does fertilization do for my lawn?',
  ])('non-pesticide question "%s" with empty support reaches the model', async (question) => {
    dispatch.mockResolvedValue({ ok: true, provider: 'openai', text: 'Here is how that works.' });
    const result = await answerEstimateQuestion({
      database: null,
      question,
      estimate: { id: 'synthetic-estimate-12', token: 'synthetic-token-12', status: 'sent', customer_name: 'Synthetic Customer', address: 'Synthetic Address' },
      estData: { services: [{ service: 'lawn_care', label: 'Lawn Care' }] },
      pricingBundle: { waveGuardTier: 'WaveGuard' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
  });
});
