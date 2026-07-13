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

  test('EBADNAME (malformed name) is authoritatively undeliverable, not a transient unknown', async () => {
    const ebadname = () => { const e = new Error('queryMx EBADNAME'); e.code = 'EBADNAME'; return Promise.reject(e); };
    const out = await gatherEmailDomainEvidence(['a@bad..com'], { resolveMx: ebadname, resolve4: ebadname, resolve6: ebadname });
    expect(out[0].deliverable).toBe(false);
    expect(out[0].dns_error).toBe('EBADNAME');
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

// ── Same-mailbox short-circuit (gmail dot-equivalence) ──────────────────────
// Real case 2026-07-13: "Charles W. Robb ... at Gmail" — the transcript's
// punctuation after the spoken initial became a literal dot and the arbiter
// coin-flipped between charlesw.robb@ and charleswrobb@, two spellings of the
// SAME mailbox. These pin the deterministic collapse.

const GMAIL_ENTRY = {
  raw_spoken: 'Charles W. Robb, R-O-B-B, at Gmail.',
  candidates: [
    { value: 'charlesw.robb@gmail.com', confidence: 0.8, basis: ['diarized transcript'], risks: [] },
    { value: 'charleswrobb@gmail.com', confidence: 0.7, basis: ['contact-pass transcript'], risks: [] },
  ],
  needs_confirmation: true,
  confirmation_question: 'Is there a period after the W?',
};

const GMAIL_DNS = {
  resolveMx: () => Promise.resolve([{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }]),
  resolve4: nxdomain,
  resolve6: nxdomain,
};

describe('same-mailbox short-circuit', () => {
  beforeEach(() => { process.env.CONTACT_QUARANTINE_ARBITER_ENABLED = 'true'; });
  afterEach(() => { delete process.env.CONTACT_QUARANTINE_ARBITER_ENABLED; });

  test('gmail dot-variants adopt the V2-agreed spelling without calling the model', async () => {
    const createMessage = jest.fn();
    const out = await arbitrateQuarantinedEmail({
      entry: GMAIL_ENTRY,
      callerContext: { v2_email: 'charleswrobb@gmail.com' },
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(false), createMessage },
    });
    expect(createMessage).not.toHaveBeenCalled();
    expect(out.verdict).toBe('adopt');
    expect(out.chosenValue).toBe('charleswrobb@gmail.com');
    expect(out.confirmationQuestion).toBeNull();
    expect(out.model).toBeNull();
  });

  test('without a V2 opinion, prefers the dot-free form when "dot" was never spoken', async () => {
    const createMessage = jest.fn();
    const out = await arbitrateQuarantinedEmail({
      entry: GMAIL_ENTRY,
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(false), createMessage },
    });
    expect(createMessage).not.toHaveBeenCalled();
    expect(out.verdict).toBe('adopt');
    expect(out.chosenValue).toBe('charleswrobb@gmail.com');
  });

  test('prefers the dotted form when the caller actually spoke "dot"', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: { ...GMAIL_ENTRY, raw_spoken: 'charles w dot robb at gmail dot com' },
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(false), createMessage: jest.fn() },
    });
    expect(out.verdict).toBe('adopt');
    expect(out.chosenValue).toBe('charlesw.robb@gmail.com');
  });

  test('googlemail.com collapses into the same mailbox as gmail.com', async () => {
    const out = await arbitrateQuarantinedEmail({
      entry: {
        ...GMAIL_ENTRY,
        candidates: [
          { value: 'charlesw.robb@googlemail.com', confidence: 0.8, basis: [], risks: [] },
          { value: 'charleswrobb@gmail.com', confidence: 0.7, basis: [], risks: [] },
        ],
      },
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(false), createMessage: jest.fn() },
    });
    expect(out.verdict).toBe('adopt');
    expect(out.chosenValue).toBe('charleswrobb@gmail.com');
  });

  test('ownership hit on the preferred spelling falls through to the model', async () => {
    const createMessage = jest.fn(modelSaying({ verdict: 'review', chosen_value: null, confidence: 0.3, reasoning: 'owned elsewhere' }));
    const out = await arbitrateQuarantinedEmail({
      entry: GMAIL_ENTRY,
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(true), createMessage },
    });
    expect(createMessage).toHaveBeenCalled();
    expect(out.verdict).toBe('review');
  });

  test('unknown deliverability caps the collapse at adopt_with_confirmation', async () => {
    const timeoutErr = () => { const e = new Error('queryMx timeout'); e.code = 'ETIMEOUT'; return Promise.reject(e); };
    const out = await arbitrateQuarantinedEmail({
      entry: GMAIL_ENTRY,
      deps: { resolveMx: timeoutErr, resolve4: timeoutErr, resolve6: timeoutErr, ownedByOther: () => Promise.resolve(false), createMessage: jest.fn() },
    });
    expect(out.verdict).toBe('adopt_with_confirmation');
    expect(out.chosenValue).toBe('charleswrobb@gmail.com');
    expect(out.confirmationQuestion).toBe('Is there a period after the W?');
  });

  test('non-Google domains never collapse — dots are significant elsewhere', async () => {
    const createMessage = jest.fn(modelSaying({ verdict: 'review', chosen_value: null, confidence: 0.4, reasoning: 'coin flip' }));
    await arbitrateQuarantinedEmail({
      entry: {
        ...GMAIL_ENTRY,
        candidates: [
          { value: 'charlesw.robb@yahoo.com', confidence: 0.8, basis: [], risks: [] },
          { value: 'charleswrobb@yahoo.com', confidence: 0.7, basis: [], risks: [] },
        ],
      },
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(false), createMessage },
    });
    expect(createMessage).toHaveBeenCalled();
  });

  test('a mixed gmail/non-gmail candidate set never collapses', async () => {
    const createMessage = jest.fn(modelSaying({ verdict: 'review', chosen_value: null, confidence: 0.4, reasoning: 'genuinely different mailboxes' }));
    await arbitrateQuarantinedEmail({
      entry: {
        ...GMAIL_ENTRY,
        candidates: [
          { value: 'charleswrobb@gmail.com', confidence: 0.8, basis: [], risks: [] },
          { value: 'charleswrobb@comcast.net', confidence: 0.7, basis: [], risks: [] },
        ],
      },
      deps: { ...GMAIL_DNS, ownedByOther: () => Promise.resolve(false), createMessage },
    });
    expect(createMessage).toHaveBeenCalled();
  });

  test('v2_email reaches the model prompt as caller context', async () => {
    const createMessage = jest.fn(modelSaying({ verdict: 'review', chosen_value: null, confidence: 0.4, reasoning: 'coin flip' }));
    await arbitrateQuarantinedEmail({
      entry: ENTRY,
      callerContext: { v2_email: 'marty@gulfcoastshutterco.com' },
      deps: deps({ createMessage }),
    });
    const prompt = createMessage.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('v2_email');
    expect(prompt).toContain('INDEPENDENT EXTRACTOR AGREEMENT');
  });
});

describe('gmailCanonicalMailbox', () => {
  const { gmailCanonicalMailbox, dotSpokenInDictation } = require('../services/contact-quarantine-arbiter');

  test('collapses dots on gmail and googlemail only', () => {
    expect(gmailCanonicalMailbox('a.b.c@gmail.com')).toBe('abc@gmail.com');
    expect(gmailCanonicalMailbox('a.b@googlemail.com')).toBe('ab@gmail.com');
    expect(gmailCanonicalMailbox('a.b@yahoo.com')).toBeNull();
    expect(gmailCanonicalMailbox('')).toBeNull();
  });

  test('plus-tags are preserved — tags are deliberate, not mishears', () => {
    expect(gmailCanonicalMailbox('a.b+leads@gmail.com')).toBe('ab+leads@gmail.com');
  });

  test('dotSpokenInDictation matches the word, not punctuation', () => {
    expect(dotSpokenInDictation('Charles W. Robb at Gmail.')).toBe(false);
    expect(dotSpokenInDictation('charles w dot robb at gmail')).toBe(true);
    expect(dotSpokenInDictation('a period after the w')).toBe(true);
  });
});
