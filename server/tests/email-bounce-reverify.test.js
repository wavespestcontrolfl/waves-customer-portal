// Bounce-triggered call-audio email re-verification (2026-07-11, owner use
// case via the Pitts bounce): apitz6958@yahoo.com hard-bounced; the caller
// had SPELLED his surname P-I-T-T-S on the same recording; three independent
// transcribers heard an /s/ ending. The lane re-runs the audio and cards
// ranked candidates for the owner's read-back — never writes, never sends.
jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn((s) => s); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  nameAnchoredEmailCandidates,
  buildReadbackQuestion,
  mergeCandidates,
  filterDecoderCandidatesToBounced,
  escapeLike,
  reverifyBouncedEmailFromCall,
} = require('../services/email-bounce-reverify');

describe('nameAnchoredEmailCandidates — the deterministic Pitts resolver', () => {
  test('apitz + spelled surname Pitts → apitts (same digits, same domain)', () => {
    const out = nameAnchoredEmailCandidates({
      bouncedEmail: 'apitz6958@yahoo.com',
      firstName: 'Adam',
      lastName: 'Pitts',
    });
    const top = out[0];
    expect(top.value).toBe('apitts6958@yahoo.com');
    // Honest tiering: apitz→apitts is edit distance 2 (z→t + inserted s), so
    // the name anchor ALONE rates medium — decoder agreement is what lifts it
    // to high (asserted in the merge test). The anchor's job is generating
    // the right candidate, not overstating certainty.
    expect(top.confidence).toBe('medium');
    expect(top.edit_distance).toBe(2);
    expect(top.source).toBe('name_anchor');
  });

  test('a single-letter slip rates high on the anchor alone', () => {
    const out = nameAnchoredEmailCandidates({
      bouncedEmail: 'apits6958@yahoo.com',
      firstName: 'Adam',
      lastName: 'Pitts',
    });
    expect(out[0].value).toBe('apitts6958@yahoo.com');
    expect(out[0].confidence).toBe('high');
  });

  test('never proposes the bounced address itself, and gives up beyond edit distance 2', () => {
    const same = nameAnchoredEmailCandidates({ bouncedEmail: 'apitts6958@yahoo.com', firstName: 'Adam', lastName: 'Pitts' });
    expect(same.map((c) => c.value)).not.toContain('apitts6958@yahoo.com');
    const far = nameAnchoredEmailCandidates({ bouncedEmail: 'sunshine99@yahoo.com', firstName: 'Adam', lastName: 'Pitts' });
    expect(far).toHaveLength(0);
  });

  test('no name → no candidates (never guesses without an anchor)', () => {
    expect(nameAnchoredEmailCandidates({ bouncedEmail: 'apitz6958@yahoo.com' })).toHaveLength(0);
  });
});

describe('buildReadbackQuestion', () => {
  test('spells the local part and names the provider — the exact confirm script', () => {
    expect(buildReadbackQuestion('apitts6958@yahoo.com'))
      .toBe('A-P-I-T-T-S-6-9-5-8 at yahoo — is that right?');
    expect(buildReadbackQuestion('jane.smith@gmail.com'))
      .toBe('J-A-N-E-DOT-S-M-I-T-H at gmail — is that right?');
  });
});

describe('mergeCandidates', () => {
  test('decoder+name agreement outranks single-source; bounced address excluded; confidence numeric for the UI', () => {
    const merged = mergeCandidates({
      bouncedEmail: 'apitz6958@yahoo.com',
      decoderCandidates: [
        { value: 'apitts6958@yahoo.com', confidence: 0.9 },
        { value: 'apits6958@yahoo.com', confidence: 0.55 },
        { value: 'apitz6958@yahoo.com', confidence: 0.4 },
      ],
      nameCandidates: [{ value: 'apitts6958@yahoo.com', source: 'name_anchor', edit_distance: 2 }],
    });
    expect(merged[0].value).toBe('apitts6958@yahoo.com');
    expect(merged[0].sources.sort()).toEqual(['audio_decoder', 'name_anchor']);
    // Numeric (ConfirmEvidence renders `${value} (NN%)`), boosted by agreement.
    expect(merged[0].confidence).toBeCloseTo(0.98, 2);
    expect(typeof merged[1].confidence).toBe('number');
    expect(merged.map((c) => c.value)).not.toContain('apitz6958@yahoo.com');
  });
});

describe('triage lane', () => {
  test('email_bounce_reverify cards land in the name_review lane', () => {
    const { buildTriageItem } = require('../services/call-routing-gates');
    const item = buildTriageItem({
      callLogId: 'c1', flag: 'email_bounce_reverify', extraction: { meta: {} }, severity: 'advisory',
      extraPayload: { bounced_email: 'apitz6958@yahoo.com', candidates: [] },
    });
    expect(item.category).toBe('name_review');
    expect(JSON.parse(item.payload).bounced_email).toBe('apitz6958@yahoo.com');
  });
});

describe('filterDecoderCandidatesToBounced', () => {
  test('an unrelated address dictated on the same call never competes', () => {
    const kept = filterDecoderCandidatesToBounced([
      { value: 'apitts6958@yahoo.com', confidence: 0.9 },   // the correction
      { value: 'lferraro@hotmail.com', confidence: 0.95 },  // someone else's email, higher confidence
      { value: 'apitts6958@gmail.com', confidence: 0.9 },   // wrong domain
    ], 'apitz6958@yahoo.com');
    expect(kept.map((c) => c.value)).toEqual(['apitts6958@yahoo.com']);
  });
});

describe('filterDecoderCandidatesToBounced — short local parts', () => {
  test('the distance budget scales down: bob@ cannot compete when a@ bounced', () => {
    const kept = filterDecoderCandidatesToBounced([
      { value: 'bob@gmail.com', confidence: 0.9 },
    ], 'a@gmail.com');
    expect(kept).toHaveLength(0);
  });
});

describe('escapeLike', () => {
  test('underscores and percents are escaped (first_last@… must not match firstXlast@…)', () => {
    expect(escapeLike('first_last@example.com')).toBe('first\\_last@example.com');
    expect(escapeLike('100%@x.com')).toBe('100\\%@x.com');
    expect(escapeLike('plain@x.com')).toBe('plain@x.com');
  });
});

describe('reverifyBouncedEmailFromCall — gate', () => {
  const OLD = process.env.GATE_CALL_BOUNCE_REVERIFY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_CALL_BOUNCE_REVERIFY;
    else process.env.GATE_CALL_BOUNCE_REVERIFY = OLD;
  });

  test('kill switch: GATE_CALL_BOUNCE_REVERIFY=false → no-op, no DB or provider work', async () => {
    process.env.GATE_CALL_BOUNCE_REVERIFY = 'false';
    jest.resetModules();
    const { reverifyBouncedEmailFromCall: gated } = require('../services/email-bounce-reverify');
    const res = await gated({ bouncedEmail: 'apitz6958@yahoo.com' });
    expect(res).toEqual({ skipped: 'gated_off' });
  });
});
