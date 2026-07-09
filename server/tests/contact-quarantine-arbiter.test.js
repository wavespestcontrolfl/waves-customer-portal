/**
 * Contact-quarantine arbiter — second-agent verdict on quarantined dictated
 * emails. DNS / ownership / model all injected via deps; the deterministic
 * gates over the model's verdict are the contract under test: the LLM's
 * output must never reach a write path unchecked.
 */

const {
  arbitrateQuarantinedEmail,
  gatherEmailDomainEvidence,
  buildArbiterPrompt,
  parseArbiterResponse,
  ADOPT_CONFIDENCE_FLOOR,
  STORE_CONFIDENCE_FLOOR,
} = require('../services/contact-quarantine-arbiter');

const nxdomain = () => { const e = new Error('queryMx ENOTFOUND'); e.code = 'ENOTFOUND'; return Promise.reject(e); };

const ENTRY = {
  raw_spoken: 'Marty at golf coast shutter co dot com',
  candidates: [
    { value: 'marty@golfcoastshutterco.com', confidence: 0.6, basis: ['diarized transcript'], risks: [] },
    { value: 'marty@gulfcoastshutterco.com', confidence: 0.55, basis: ['contact-pass transcript'], risks: [] },
  ],
  needs_confirmation: true,
  confirmation_question: 'Is that G-O-L-F or G-U-L-F coast shutter co?',
};

// DNS world where only the gulf domain can receive mail.
const DNS_DEPS = {
  resolveMx: (d) => (d === 'gulfcoastshutterco.com' ? Promise.resolve([{ exchange: 'mx1', priority: 10 }]) : nxdomain()),
  resolve4: () => nxdomain(),
  resolve6: () => nxdomain(),
};

const modelSaying = (json) => async () => ({
  model: 'claude-fable-5',
  content: [{ type: 'text', text: JSON.stringify(json) }],
});

function deps(overrides = {}) {
  return {
    ...DNS_DEPS,
    ownedByOther: () => Promise.resolve(false),
    createMessage: modelSaying({
      verdict: 'adopt',
      chosen_value: 'marty@gulfcoastshutterco.com',
      confidence: 0.97,
      eliminated: [{ value: 'marty@golfcoastshutterco.com', reason: 'domain does not exist' }],
      evidence_used: ['DNS'],
      reasoning: 'Only the gulf domain resolves and it matches the stated business.',
      confirmation_question: null,
    }),
    ...overrides,
  };
}

describe('arbitrateQuarantinedEmail', () => {
  beforeEach(() => { process.env.CONTACT_QUARANTINE_ARBITER_ENABLED = 'true'; });
  afterEach(() => { delete process.env.CONTACT_QUARANTINE_ARBITER_ENABLED; });

  test('disabled gate returns null without calling anything', async () => {
    delete process.env.CONTACT_QUARANTINE_ARBITER_ENABLED;
    const createMessage = jest.fn();
    const out = await arbitrateQuarantinedEmail({ entry: ENTRY, deps: deps({ createMessage }) });
    expect(out).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });

  test('adopts the candidate the evidence and model agree on', async () => {
    const out = await arbitrateQuarantinedEmail({ entry: ENTRY, deps: deps() });
    expect(out.verdict).toBe('adopt');
    expect(out.chosenValue).toBe('marty@gulfcoastshutterco.com');
    expect(out.domainEvidence.find((e) => e.value === 'marty@golfcoastshutterco.com').deliverable).toBe(false);
  });

  test('demoted extraction value joins the candidate set', async () => {
    const createMessage = jest.fn(modelSaying({ verdict: 'review', chosen_value: null, confidence: 0.4, reasoning: 'coin flip' }));
    await arbitrateQuarantinedEmail({
      entry: { ...ENTRY, candidates: [ENTRY.candidates[0]] },
      demotedEmail: 'marty@gulfcoastshutterco.com',
      deps: deps({ createMessage }),
    });
    const prompt = createMessage.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('marty@gulfcoastshutterco.com');
    expect(prompt).toContain('primary extraction (demoted)');
  });

  test('verdict naming a non-candidate is downgraded to review', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({
        createMessage: modelSaying({ verdict: 'adopt', chosen_value: 'marty@shutterco.com', confidence: 0.99, reasoning: 'invented' }),
      }),
    });
    expect(out.verdict).toBe('review');
    expect(out.chosenValue).toBeNull();
    expect(out.reasoning).toContain('downgraded');
  });

  test('verdict on an undeliverable domain is downgraded to review', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({
        createMessage: modelSaying({ verdict: 'adopt', chosen_value: 'marty@golfcoastshutterco.com', confidence: 0.95, reasoning: 'wrong pick' }),
      }),
    });
    expect(out.verdict).toBe('review');
    expect(out.chosenValue).toBeNull();
  });

  test('verdict on an address owned by another customer is downgraded to review', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({ ownedByOther: (email) => Promise.resolve(email === 'marty@gulfcoastshutterco.com') }),
    });
    expect(out.verdict).toBe('review');
    expect(out.chosenValue).toBeNull();
  });

  test('ownership lookup failure fails closed per candidate', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({ ownedByOther: () => Promise.reject(new Error('db down')) }),
    });
    expect(out.verdict).toBe('review');
    expect(out.chosenValue).toBeNull();
  });

  test('low-confidence adopt degrades to adopt_with_confirmation (value still stored, card stays open)', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({
        createMessage: modelSaying({
          verdict: 'adopt',
          chosen_value: 'marty@gulfcoastshutterco.com',
          confidence: ADOPT_CONFIDENCE_FLOOR - 0.1,
          reasoning: 'circumstantial',
          confirmation_question: 'Confirm gulf, not golf?',
        }),
      }),
    });
    expect(out.verdict).toBe('adopt_with_confirmation');
    expect(out.chosenValue).toBe('marty@gulfcoastshutterco.com');
    expect(out.confirmationQuestion).toBe('Confirm gulf, not golf?');
  });

  test('unknown deliverability (transient DNS) caps adopt at adopt_with_confirmation', async () => {
    const servfail = () => { const e = new Error('ESERVFAIL'); e.code = 'ESERVFAIL'; return Promise.reject(e); };
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({ resolveMx: servfail, resolve4: servfail }),
    });
    expect(out.verdict).toBe('adopt_with_confirmation');
    expect(out.chosenValue).toBe('marty@gulfcoastshutterco.com');
  });

  test('adopt_with_confirmation below the storing floor is downgraded to review', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({
        createMessage: modelSaying({
          verdict: 'adopt_with_confirmation',
          chosen_value: 'marty@gulfcoastshutterco.com',
          confidence: STORE_CONFIDENCE_FLOOR - 0.2,
          reasoning: 'weak guess',
        }),
      }),
    });
    expect(out.verdict).toBe('review');
    expect(out.chosenValue).toBeNull();
    expect(out.reasoning).toContain('below storing floor');
  });

  test('review verdict carries the decoder confirmation question as fallback', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({
        createMessage: modelSaying({ verdict: 'review', chosen_value: null, confidence: 0.5, reasoning: 'coin flip', confirmation_question: null }),
      }),
    });
    expect(out.verdict).toBe('review');
    expect(out.confirmationQuestion).toBe(ENTRY.confirmation_question);
  });

  test('fails open (null) on model error', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: ENTRY,
      deps: deps({ createMessage: () => Promise.reject(new Error('provider down')) }),
    });
    expect(out).toBeNull();
  });

  test('fails open (null) with no usable candidates', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: { raw_spoken: 'mumble', candidates: [{ value: 'not-an-email', confidence: 0.9 }] },
      deps: deps(),
    });
    expect(out).toBeNull();
  });
});

describe('gatherEmailDomainEvidence', () => {
  test('A record makes a no-MX domain deliverable (implicit MX)', async () => {
    const out = await gatherEmailDomainEvidence(['a@apex-only.com'], {
      resolveMx: nxdomain,
      resolve4: () => Promise.resolve(['1.2.3.4']),
      resolve6: nxdomain,
    });
    expect(out[0].deliverable).toBe(true);
    expect(out[0].dns_error).toBeNull();
  });

  test('AAAA record makes an IPv6-only apex deliverable (implicit MX)', async () => {
    const out = await gatherEmailDomainEvidence(['a@v6-only.example'], {
      resolveMx: nxdomain,
      resolve4: nxdomain,
      resolve6: () => Promise.resolve(['2001:db8::1']),
    });
    expect(out[0].deliverable).toBe(true);
    expect(out[0].dns_error).toBeNull();
  });

  test('NXDOMAIN on all lookups is undeliverable with the error preserved', async () => {
    const out = await gatherEmailDomainEvidence(['a@dead.example'], { resolveMx: nxdomain, resolve4: nxdomain, resolve6: nxdomain });
    expect(out[0].deliverable).toBe(false);
    expect(out[0].dns_error).toBe('ENOTFOUND');
  });

  test('transient resolver errors are unknown (null), never a negative', async () => {
    const servfail = () => { const e = new Error('queryMx ESERVFAIL'); e.code = 'ESERVFAIL'; return Promise.reject(e); };
    const out = await gatherEmailDomainEvidence(['a@flaky.example'], { resolveMx: servfail, resolve4: servfail, resolve6: servfail });
    expect(out[0].deliverable).toBeNull();
    expect(out[0].dns_error).toBe('ESERVFAIL');
  });

  test('mixed transient + authoritative stays unknown (cannot prove nonexistence)', async () => {
    const timeout = () => Promise.reject(new Error('timeout'));
    const out = await gatherEmailDomainEvidence(['a@half-checked.example'], { resolveMx: timeout, resolve4: nxdomain, resolve6: nxdomain });
    expect(out[0].deliverable).toBeNull();
  });

  test('transient MX failure stays unknown even when A/AAAA resolve (implicit MX needs authoritative no-MX)', async () => {
    const servfail = () => { const e = new Error('queryMx ESERVFAIL'); e.code = 'ESERVFAIL'; return Promise.reject(e); };
    const out = await gatherEmailDomainEvidence(['a@mx-flaky.example'], {
      resolveMx: servfail,
      resolve4: () => Promise.resolve(['1.2.3.4']),
      resolve6: nxdomain,
    });
    expect(out[0].deliverable).toBeNull();
    expect(out[0].dns_error).toBe('ESERVFAIL');
  });

  test('transient IPv6 failure alone keeps the domain unknown', async () => {
    const timeout = () => Promise.reject(new Error('timeout'));
    const out = await gatherEmailDomainEvidence(['a@v6-flaky.example'], { resolveMx: nxdomain, resolve4: nxdomain, resolve6: timeout });
    expect(out[0].deliverable).toBeNull();
  });

  test('Null MX (RFC 7505) is authoritatively undeliverable, even with A records', async () => {
    const out = await gatherEmailDomainEvidence(['a@no-mail.example'], {
      resolveMx: () => Promise.resolve([{ exchange: '', priority: 0 }]),
      resolve4: () => Promise.resolve(['1.2.3.4']),
    });
    expect(out[0].deliverable).toBe(false);
    expect(out[0].dns_error).toBe('NULL_MX');
  });

  test('a real MX alongside a null entry still counts as deliverable', async () => {
    const out = await gatherEmailDomainEvidence(['a@mixed.example'], {
      resolveMx: () => Promise.resolve([{ exchange: '.', priority: 0 }, { exchange: 'mx1.mixed.example', priority: 10 }]),
      resolve4: nxdomain,
    });
    expect(out[0].deliverable).toBe(true);
    expect(out[0].mx_records).toBe(1);
  });

  test('deduplicates DNS lookups per domain', async () => {
    const resolveMx = jest.fn(() => Promise.resolve([{ exchange: 'mx', priority: 10 }]));
    await gatherEmailDomainEvidence(['a@same.com', 'b@same.com'], { resolveMx, resolve4: nxdomain });
    expect(resolveMx).toHaveBeenCalledTimes(1);
  });
});

describe('parseArbiterResponse', () => {
  test('unknown verdicts and out-of-range confidence are clamped', () => {
    const out = parseArbiterResponse(JSON.stringify({ verdict: 'ship_it', chosen_value: 'X@Y.com', confidence: 7 }));
    expect(out.verdict).toBe('review');
    expect(out.confidence).toBe(1);
    expect(out.chosen_value).toBe('x@y.com');
  });

  test('strips markdown fences', () => {
    const out = parseArbiterResponse('```json\n{"verdict":"adopt","chosen_value":"a@b.com","confidence":0.95}\n```');
    expect(out.verdict).toBe('adopt');
  });
});

describe('buildArbiterPrompt', () => {
  test('includes evidence, hard rules, and both transcripts', () => {
    const prompt = buildArbiterPrompt({
      fieldType: 'email',
      quarantineReason: 'conflicting candidates',
      rawSpoken: ENTRY.raw_spoken,
      candidates: ENTRY.candidates,
      evidence: [{ value: 'marty@gulfcoastshutterco.com', deliverable: true, owned_by_other_customer: false }],
      transcripts: { primary: 'PRIMARY_T', contactPass: 'SECOND_T' },
      callerContext: { organization: 'Gulf Coast Shutter Co' },
    });
    expect(prompt).toContain('owned_by_other_customer');
    expect(prompt).toContain('NEVER invent a value');
    expect(prompt).toContain('PRIMARY_T');
    expect(prompt).toContain('SECOND_T');
    expect(prompt).toContain('Gulf Coast Shutter Co');
  });
});
