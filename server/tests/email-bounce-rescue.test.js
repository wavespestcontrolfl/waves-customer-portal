/**
 * Contracts for the bounce→transcript rescue. Fixtures are the REAL decode
 * cases from the 2026-08-05 manual sweep (anonymized where needed) — each
 * one shipped as a hand-verified prod fix, so the decoders must keep
 * reproducing them. The tier boundary (decode NEVER auto-applies; collision
 * never applies) is the safety contract.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/llm/call', () => ({ callAnthropic: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn(() => Promise.resolve()) }));
jest.mock('dns', () => ({ promises: { resolveMx: jest.fn() } }));

const db = require('../models/db');
const dns = require('dns').promises;
const email = require('../services/email');
const { callAnthropic } = require('../services/llm/call');
const rescue = require('../services/email-bounce-rescue');

function makeChain(overrides = {}) {
  const rows = 'rows' in overrides ? overrides.rows : [];
  const chain = {};
  const passthrough = ['where', 'whereRaw', 'whereIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereRaw', 'distinct', 'limit', 'orderBy', 'select', 'insert', 'update'];
  for (const m of passthrough) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(() => Promise.resolve('first' in overrides ? overrides.first : null));
  chain.returning = jest.fn(() => Promise.resolve('returning' in overrides ? overrides.returning : []));
  // Awaiting the bare chain (knex builders are thenables) resolves to `rows`.
  chain.then = (onRes, onRej) => Promise.resolve(rows).then(onRes, onRej);
  chain.catch = (fn) => Promise.resolve(rows).catch(fn);
  return chain;
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.EMAIL_BOUNCE_TRANSCRIPT_RESCUE;
});

describe('editDistance', () => {
  it('measures the sweep near-misses correctly', () => {
    expect(rescue.editDistance('tryles', 'tryals')).toBe(2);
    expect(rescue.editDistance('judyboedmer', 'judybodmer')).toBe(1);
    expect(rescue.editDistance('lymraythai', 'lynraythai')).toBe(1);
    expect(rescue.editDistance('ronnier@alum.mit.edu', 'ronnir@alum.mit.edu')).toBe(1);
    expect(rescue.editDistance('same', 'same')).toBe(0);
  });
});

describe('decodeSpelledCandidates (deterministic)', () => {
  it('decodes a letter run with the bounced digit tail (Trent fixture)', () => {
    const transcript = 'Caller: Email is T R Y A L S 24@icloud.com.\nAgent: Okay.';
    const out = rescue.decodeSpelledCandidates(transcript, 'tryles24@icloud.com');
    expect(out.map((c) => c.email)).toContain('tryals24@icloud.com');
  });

  it('decodes a hyphenated letter run with no digits (Judy fixture)', () => {
    const transcript = 'Caller: It is J-U-D-Y-B-O-D-M-E-R at gmail.com.';
    const out = rescue.decodeSpelledCandidates(transcript, 'judyboedmer@gmail.com');
    expect(out.map((c) => c.email)).toContain('judybodmer@gmail.com');
  });

  it('decodes phonetic-alphabet spelling (Jimenez fixture)', () => {
    const transcript = 'Caller: It is w like whiskey, c like charlie, w like whiskey, 63 at gmail.com.';
    const out = rescue.decodeSpelledCandidates(transcript, 'cw63@gmail.com');
    expect(out.map((c) => c.email)).toContain('wcw63@gmail.com');
  });

  it('proposes nothing when the run matches the stored local part', () => {
    const transcript = 'Caller: It is J-U-D-Y-B-O-D-M-E-R at gmail.com.';
    expect(rescue.decodeSpelledCandidates(transcript, 'judybodmer@gmail.com')).toEqual([]);
  });

  it('proposes nothing for far-off runs (no anchor to the bounced address)', () => {
    const transcript = 'Caller: B-L-U-S-C-H-E-R at yahoo.com.';
    expect(rescue.decodeSpelledCandidates(transcript, 'ashtonsusantaylor3872@gmail.com')).toEqual([]);
  });

  it('does not let a contraction donate a letter to the run (Karen artifact)', () => {
    // Real prod dry-run artifact: "it's K-A-R-R-E-N…" produced a leading "s".
    const transcript = "Caller: it's K-A-R-R-E-N K-L-L-E-N-S. kc.rr.com";
    const out = rescue.decodeSpelledCandidates(transcript, 'karrenkllens@kc.rr.com');
    expect(out.map((c) => c.email)).not.toContain('skarrenkllens@kc.rr.com');
    // The clean run equals the stored local part, so nothing is proposed.
    expect(out).toEqual([]);
  });
});

describe('rescueBouncedAddress domain repair (mechanical tier)', () => {
  it('repairs a truncated TLD-less domain and treats it as auto-apply eligible', async () => {
    db.mockImplementation((name) => {
      if (name === 'customers') return makeChain({ first: { id: 'c1', first_name: 'Brandon', last_name: 'Post', phone: null, email: 'brandon.post00@gmail' } });
      if (name === 'call_log') { const c = makeChain(); c.select = jest.fn(() => Promise.resolve([])); return c; }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('brandon.post00@gmail', { dryRun: true });
    expect(r).toMatchObject({ status: 'applied', tier: 'domain_repair', candidate: 'brandon.post00@gmail.com' });
  });
});

describe('consensusCandidates', () => {
  const at = (day) => new Date(`2026-07-${day}T12:00:00Z`);

  it('qualifies a candidate seen on two calls (Susan Taylor fixture)', () => {
    const sightings = [
      { email: 'bluscher19@icloud.com', callId: 'c1', callAt: at(16), source: 'extraction' },
      { email: 'bluscher19@icloud.com', callId: 'c2', callAt: at(20), source: 'extraction' },
    ];
    const out = rescue.consensusCandidates(sightings, 'ashtonsusantaylor3872@gmail.com');
    expect(out.map((c) => c.email)).toEqual(['bluscher19@icloud.com']);
  });

  it('qualifies a same-domain near-miss from a single call (Trent fixture)', () => {
    const sightings = [
      { email: 'tryals24@icloud.com', callId: 'c1', callAt: at(1), source: 'extraction' },
    ];
    const out = rescue.consensusCandidates(sightings, 'tryles24@icloud.com');
    expect(out.map((c) => c.email)).toEqual(['tryals24@icloud.com']);
  });

  it('qualifies a correction captured on a later call (Whitesell fixture)', () => {
    const sightings = [
      { email: 'lymraythai@yahoo.com', callId: 'c1', callAt: at(14), source: 'extraction' },
      { email: 'lynraythai@yahoo.com', callId: 'c2', callAt: at(15), source: 'extraction' },
    ];
    const out = rescue.consensusCandidates(sightings, 'lymraythai@yahoo.com');
    expect(out.map((c) => c.email)).toEqual(['lynraythai@yahoo.com']);
  });

  it('rejects a one-call far-off sighting (no consensus, no anchor)', () => {
    const sightings = [
      { email: 'randomother@gmail.com', callId: 'c1', callAt: at(1), source: 'transcript' },
    ];
    expect(rescue.consensusCandidates(sightings, 'someone@yahoo.com')).toEqual([]);
  });
});

describe('validateCandidate', () => {
  function mockTables(tables) {
    db.mockImplementation((name) => tables[name] || makeChain());
  }

  it('rejects a suppressed candidate', async () => {
    mockTables({ email_suppressions: makeChain({ first: { id: 's1' } }) });
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'c1', ownerLeadId: null });
    expect(v).toMatchObject({ ok: false, reason: 'candidate_suppressed' });
  });

  it('flags a collision when the candidate lives on ANOTHER customer', async () => {
    mockTables({
      email_suppressions: makeChain(),
      email_bounce_rescues: makeChain(),
      customers: makeChain({ first: { id: 'other-customer' } }),
    });
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'me', ownerLeadId: null });
    expect(v).toMatchObject({ ok: false, reason: 'collision', collisionCustomerId: 'other-customer' });
  });

  it('accepts the candidate on the SAME owner (already-fixed elsewhere case)', async () => {
    mockTables({
      email_suppressions: makeChain(),
      email_bounce_rescues: makeChain(),
      customers: makeChain({ first: { id: 'me' } }),
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]);
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'me', ownerLeadId: null });
    expect(v).toMatchObject({ ok: true });
  });

  it('rejects a domain with no MX', async () => {
    mockTables({ email_suppressions: makeChain(), email_bounce_rescues: makeChain(), customers: makeChain() });
    dns.resolveMx.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    const v = await rescue.validateCandidate('x@doesnotexist.example', { bouncedEmail: 'y@gmail.com', ownerCustomerId: null, ownerLeadId: 'l1' });
    expect(v).toMatchObject({ ok: false, reason: 'no_mx' });
  });

  it('marks MX unknown (not a hard fail) on DNS infrastructure trouble', async () => {
    mockTables({ email_suppressions: makeChain(), email_bounce_rescues: makeChain(), customers: makeChain() });
    dns.resolveMx.mockRejectedValue(Object.assign(new Error('flaky'), { code: 'ETIMEOUT' }));
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: null, ownerLeadId: 'l1' });
    expect(v).toMatchObject({ ok: true, mxUnknown: true });
  });
});

describe('rescueBouncedAddress flow', () => {
  it('is a no-op when the kill switch is off', async () => {
    process.env.EMAIL_BOUNCE_TRANSCRIPT_RESCUE = 'off';
    expect(await rescue.rescueBouncedAddress('x@gmail.com')).toEqual({ skipped: 'disabled' });
    expect(db).not.toHaveBeenCalled();
  });

  it('skips an already-examined address (loop guard)', async () => {
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return makeChain({ first: { status: 'applied' } });
      return makeChain();
    });
    const r = await rescue.rescueBouncedAddress('x@gmail.com');
    expect(r).toMatchObject({ skipped: 'already_examined' });
  });

  it('records skipped_no_owner for a stale suppression and sends nothing', async () => {
    const rescues = makeChain({ first: null, returning: [{ id: 'r1', status: 'skipped_no_owner' }] });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      return makeChain(); // customers/leads .first() -> null
    });
    const r = await rescue.rescueBouncedAddress('gone@gmail.com');
    expect(r).toEqual({ skipped: 'no_owner' });
    expect(rescues.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped_no_owner' }));
    expect(email.send).not.toHaveBeenCalled();
  });

  it('dry run gathers and reports but never writes or emails', async () => {
    db.mockImplementation((name) => {
      if (name === 'customers') return makeChain({ first: { id: 'c1', first_name: 'Judy', last_name: 'B', phone: '+15550001111', email: 'judyboedmer@gmail.com' } });
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-08'),
          transcription: 'Caller: It is J-U-D-Y-B-O-D-M-E-R at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('judyboedmer@gmail.com', { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, status: 'suggested', candidate: 'judybodmer@gmail.com', tier: 'transcript_decode' });
    expect(email.send).not.toHaveBeenCalled();
    expect(callAnthropic).not.toHaveBeenCalled(); // deterministic decode sufficed
  });

  it('NEVER auto-applies a transcript decode — tier boundary', async () => {
    // Same fixture as above but not a dry run: the decode candidate must
    // land as 'suggested' with an ACT email, not as an applied fix.
    const rescues = makeChain({ first: null, returning: [{ id: 'r-judy' }] });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') return makeChain({ first: { id: 'c1', first_name: 'Judy', last_name: 'B', phone: '+15550001111', email: 'judyboedmer@gmail.com' } });
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-08'),
          transcription: 'Caller: It is J-U-D-Y-B-O-D-M-E-R at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('judyboedmer@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'judybodmer@gmail.com' });
    expect(db.transaction).not.toHaveBeenCalled(); // applyFix never ran
    expect(rescues.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'suggested' }));
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringMatching(/^ACT: /),
    }));
  });
});

describe('llm decode anchoring', () => {
  it('drops an LLM candidate whose supporting quote is not verbatim in the transcript', async () => {
    callAnthropic.mockResolvedValue({ ok: true, json: { candidate_email: 'gusgusohatb@gmail.com', supporting_quote: 'this quote was invented' } });
    db.mockImplementation((name) => {
      if (name === 'customers') return makeChain({ first: { id: 'c1', first_name: 'Gus', last_name: 'A', phone: '+15550002222', email: 'gusgusohabb@gmail.com' } });
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-15'),
          transcription: 'Caller: My email address is gusgus and then o-h-a-t-b abbreviation for our house at the beach at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    const OLD_KEY = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      const r = await rescue.rescueBouncedAddress('gusgusohabb@gmail.com', { dryRun: true });
      // The deterministic decode also finds ohatb here (letter run) — accept
      // either a deterministic suggestion or no candidate, but never one
      // justified by the invented quote.
      if (r.candidate) expect(r.evidence.quote).not.toBe('this quote was invented');
    } finally {
      if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = OLD_KEY;
    }
  });
});
