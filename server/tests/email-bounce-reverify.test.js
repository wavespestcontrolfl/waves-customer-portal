// Bounce-triggered call-audio email re-verification (2026-07-11, owner use
// case via the Pitts bounce): apitz6958@yahoo.com hard-bounced; the caller
// had SPELLED his surname P-I-T-T-S on the same recording; three independent
// transcribers heard an /s/ ending. The lane re-runs the audio and cards
// ranked candidates for the owner's read-back — never writes, never sends.
jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn((s) => s); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Provider mocks so the orchestration test runs the real control flow with no
// transcription/decoder work.
jest.mock('../services/call-recording-processor', () => ({
  transcribeRecording: jest.fn(async () => ({
    transcription: 'the caller spells both email addresses on this recording',
    contactPassTranscript: 'A-P-I-T-T-S',
    provider: 'test-provider',
  })),
  isImplausibleTranscript: jest.fn(() => false),
}));
jest.mock('../services/contact-dictation', () => ({
  decodeDictatedContacts: jest.fn(async () => ({
    emails: [{ candidates: [{ value: 'apitts6958@yahoo.com', confidence: 0.9 }] }],
  })),
}));

const {
  nameAnchoredEmailCandidates,
  buildReadbackQuestion,
  mergeCandidates,
  filterDecoderCandidatesToBounced,
  emailBoundaryRegex,
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

describe('emailBoundaryRegex', () => {
  // The same ARE-compatible pattern Postgres evaluates; JS RegExp accepts it.
  const matches = (email, text) => new RegExp(emailBoundaryRegex(email)).test(text);

  test('exact-address boundaries: a longer address containing the bounced one never matches', () => {
    expect(matches('ann@example.com', '"email":"ann@example.com"')).toBe(true);
    expect(matches('ann@example.com', '"email":"joann@example.com"')).toBe(false);   // left overlap
    expect(matches('a@x.com', '"email":"a@x.company"')).toBe(false);                 // domain continues
    expect(matches('a@x.com', '"email":"a@x.com.au"')).toBe(false);                  // extra label
    expect(matches('first_last@x.com', 'wrote firstXlast@x.com today')).toBe(false); // no LIKE wildcards
  });

  test('free-text boundaries still match: start/end of text, quotes, sentence period', () => {
    expect(matches('a@x.com', 'a@x.com')).toBe(true);
    expect(matches('a@x.com', 'the email is a@x.com.')).toBe(true);
    expect(matches('a@x.com', 'reach me at a@x.com, thanks')).toBe(true);
  });
});

describe('reverifyBouncedEmailFromCall — annotated second address survives a no-candidate primary', () => {
  test('primary yields nothing → the annotated address is tried on the same decode; the card lives', async () => {
    const db = require('../models/db');
    const callRow = {
      id: 'call1',
      recording_url: 'https://recordings/x.mp3',
      recording_duration_seconds: 60,
      duration_seconds: 60,
      customer_id: null,
      ai_extraction: JSON.stringify({ first_name: 'Adam', last_name: 'Pitts' }),
    };
    // The card was claimed for an address that will decode to NOTHING; a
    // second bounce (the real Pitts address) was annotated while
    // transcription ran. Pre-fix, the no-candidate primary deleted the
    // shared mutex row and the annotated address was never processed.
    const cardPayload = {
      bounced_email: 'zzqqxx@yahoo.com',
      analyzing: true,
      additional_bounced_emails: ['apitz6958@yahoo.com'],
    };
    const updateSpy = jest.fn(() => Promise.resolve(1));
    const delSpy = jest.fn(() => Promise.resolve(1));
    const makeChain = (terminal) => {
      const chain = {};
      for (const m of ['whereNotNull', 'whereRaw', 'select', 'modify', 'where', 'whereIn', 'orderBy', 'orderByRaw', 'limit', 'onConflict', 'ignore', 'insert']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.first = jest.fn(() => Promise.resolve(terminal.first));
      chain.returning = jest.fn(() => Promise.resolve(terminal.returning));
      chain.update = updateSpy;
      chain.del = delSpy;
      chain.then = (res, rej) => Promise.resolve(terminal.rows || []).then(res, rej);
      return chain;
    };
    const queue = [
      makeChain({ rows: [callRow] }),                                  // findSourceCall
      makeChain({ returning: ['card1'] }),                             // claim insert (mutex won)
      makeChain({ first: { payload: JSON.stringify(cardPayload) } }),  // mid-read: annotated addresses
      makeChain({ first: { payload: JSON.stringify(cardPayload) } }),  // re-read before final write
      makeChain({}),                                                   // final card update
    ];
    db.mockImplementation(() => queue.shift());

    const res = await reverifyBouncedEmailFromCall({ bouncedEmail: 'zzqqxx@yahoo.com' });

    expect(delSpy).not.toHaveBeenCalled();
    expect(res.carded).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][0];
    const payload = JSON.parse(written.payload);
    expect(payload.bounced_email).toBe('apitz6958@yahoo.com');
    expect(payload.email_candidates[0].value).toBe('apitts6958@yahoo.com');
    // The no-candidate primary rides along — the office still sees it bounced.
    expect(payload.additional_bounced_emails).toEqual(['zzqqxx@yahoo.com']);
    expect(written.summary).toContain('apitz6958@yahoo.com');
  });
});

describe('reverifyBouncedEmailFromCall — CAS delete loses to a concurrent annotation', () => {
  test('annotation lands between the no-candidate read and the delete → delete no-ops, new address is processed', async () => {
    const db = require('../models/db');
    const callRow = {
      id: 'call1',
      recording_url: 'https://recordings/x.mp3',
      recording_duration_seconds: 60,
      duration_seconds: 60,
      customer_id: null,
      ai_extraction: JSON.stringify({ first_name: 'Adam', last_name: 'Pitts' }),
    };
    const bare = { bounced_email: 'zzqqxx@yahoo.com', analyzing: true };
    const withSecond = { ...bare, additional_bounced_emails: ['apitz6958@yahoo.com'] };
    const updateSpy = jest.fn(() => Promise.resolve(1));
    const makeChain = (terminal) => {
      const chain = {};
      for (const m of ['whereNotNull', 'whereRaw', 'select', 'modify', 'where', 'whereIn', 'orderBy', 'orderByRaw', 'limit', 'onConflict', 'ignore', 'insert']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.first = jest.fn(() => Promise.resolve(terminal.first));
      chain.returning = jest.fn(() => Promise.resolve(terminal.returning));
      chain.update = updateSpy;
      chain.del = jest.fn(() => Promise.resolve(terminal.del ?? 1));
      chain.then = (res, rej) => Promise.resolve(terminal.rows || []).then(res, rej);
      return chain;
    };
    const deleteChain = makeChain({ del: 0 });
    const queue = [
      makeChain({ rows: [callRow] }),                                              // findSourceCall
      makeChain({ returning: ['card1'] }),                                         // claim insert
      makeChain({ first: { payload: JSON.stringify(bare), updated_at: 't1' } }),   // read: primary only, no candidates
      makeChain({ first: { payload: JSON.stringify(bare), updated_at: 't1' } }),   // read: nothing pending → attempt delete
      deleteChain,                                                                 // CAS delete LOSES (0 rows — annotation won)
      makeChain({ first: { payload: JSON.stringify(withSecond), updated_at: 't2' } }), // re-read: annotation visible
      makeChain({ first: { payload: JSON.stringify(withSecond) } }),               // re-read before final write
      makeChain({}),                                                               // final card update
    ];
    db.mockImplementation(() => queue.shift());

    const res = await reverifyBouncedEmailFromCall({ bouncedEmail: 'zzqqxx@yahoo.com' });

    expect(deleteChain.del).toHaveBeenCalledTimes(1);
    expect(res.carded).toBe(true);
    const payload = JSON.parse(updateSpy.mock.calls[0][0].payload);
    expect(payload.bounced_email).toBe('apitz6958@yahoo.com');
    expect(payload.additional_bounced_emails).toEqual(['zzqqxx@yahoo.com']);
    expect(queue).toHaveLength(0); // exactly this sequence, no stray DB work
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
