/**
 * Contracts for the bounce→transcript rescue. Fixtures are SYNTHETIC but
 * preserve the exact decoder shapes hand-verified in the 2026-08-05 prod
 * sweep (digit-tail letter run, hyphenated run, phonetic alphabet,
 * correction callback, freemail near-miss) — no customer PII in the repo.
 *
 * Safety contracts pinned here:
 *  - call-derived evidence (consensus/decode) NEVER auto-applies (AGENTS.md
 *    call-pipeline rule: owner read-back, never auto-correct);
 *  - freemail inbound near-miss NEVER auto-applies;
 *  - a candidate on ANY other sendable record (customer field, billing
 *    email, other lead) is a collision, and --apply re-checks collisions
 *    even though it excludes its own ledger row from prior-attempt.
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
jest.mock('../services/customer-email-fanout', () => ({ propagateCustomerEmailChange: jest.fn(() => Promise.resolve({})) }));
jest.mock('dns', () => ({ promises: { resolveMx: jest.fn() } }));

const db = require('../models/db');
const dns = require('dns').promises;
const email = require('../services/email');
const { callAnthropic } = require('../services/llm/call');
const rescue = require('../services/email-bounce-rescue');

function makeChain(overrides = {}) {
  const rows = 'rows' in overrides ? overrides.rows : [];
  const chain = {};
  const passthrough = ['where', 'whereRaw', 'whereIn', 'whereNull', 'whereNotNull', 'whereNot',
    'orWhere', 'orWhereRaw', 'distinct', 'limit', 'orderBy', 'select', 'insert', 'update'];
  for (const m of passthrough) chain[m] = jest.fn(() => chain);
  chain.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(chain); return chain; });
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
  it('measures the sweep near-miss shapes correctly', () => {
    expect(rescue.editDistance('marlek', 'marlak')).toBe(1);
    expect(rescue.editDistance('janeboedmer', 'janebodmer')).toBe(1);
    expect(rescue.editDistance('sender@corp.example.com', 'sendr@corp.example.com')).toBe(1);
    expect(rescue.editDistance('same', 'same')).toBe(0);
    expect(rescue.editDistance('abcdef', 'axcyef')).toBe(2);
  });
});

describe('decodeSpelledCandidates (deterministic)', () => {
  it('decodes a letter run with the bounced digit tail (digit-tail shape)', () => {
    const transcript = 'Caller: Email is M A R L A K 24@icloud.com.\nAgent: Okay.';
    const out = rescue.decodeSpelledCandidates(transcript, 'marlek24@icloud.com');
    expect(out.map((c) => c.email)).toContain('marlak24@icloud.com');
  });

  it('decodes a hyphenated letter run with no digits (dropped-letter shape)', () => {
    const transcript = 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.';
    const out = rescue.decodeSpelledCandidates(transcript, 'janeboedmer@gmail.com');
    expect(out.map((c) => c.email)).toContain('janebodmer@gmail.com');
  });

  it('decodes phonetic-alphabet spelling (missing-first-letter shape)', () => {
    const transcript = 'Caller: It is w like whiskey, c like charlie, w like whiskey, 63 at gmail.com.';
    const out = rescue.decodeSpelledCandidates(transcript, 'cw63@gmail.com');
    expect(out.map((c) => c.email)).toContain('wcw63@gmail.com');
  });

  it('proposes nothing when the run matches the stored local part', () => {
    const transcript = 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.';
    expect(rescue.decodeSpelledCandidates(transcript, 'janebodmer@gmail.com')).toEqual([]);
  });

  it('proposes nothing for far-off runs (no anchor to the bounced address)', () => {
    const transcript = 'Caller: B-F-I-S-H-E-R at yahoo.com.';
    expect(rescue.decodeSpelledCandidates(transcript, 'completelydifferent3872@gmail.com')).toEqual([]);
  });

  it('does not let a contraction donate a letter to the run', () => {
    // Real prod dry-run artifact shape: "it's K-A-R-A-N…" produced a leading "s".
    const transcript = "Caller: it's K-A-R-A-N-K-L-E-N-S. kc.rr.example";
    const out = rescue.decodeSpelledCandidates(transcript, 'karanklens@kc.rr.example');
    expect(out.map((c) => c.email)).not.toContain('skaranklens@kc.rr.example');
    expect(out).toEqual([]);
  });
});

describe('consensusCandidates', () => {
  const at = (day) => new Date(`2026-07-${day}T12:00:00Z`);

  it('qualifies a candidate seen on two calls', () => {
    const sightings = [
      { email: 'bfisher19@icloud.com', callId: 'c1', callAt: at(16), source: 'extraction' },
      { email: 'bfisher19@icloud.com', callId: 'c2', callAt: at(20), source: 'extraction' },
    ];
    const out = rescue.consensusCandidates(sightings, 'unrelatedstored3872@gmail.com');
    expect(out.map((c) => c.email)).toEqual(['bfisher19@icloud.com']);
  });

  it('qualifies a same-domain near-miss from a single call', () => {
    const sightings = [
      { email: 'marlak24@icloud.com', callId: 'c1', callAt: at(1), source: 'extraction' },
    ];
    const out = rescue.consensusCandidates(sightings, 'marlek24@icloud.com');
    expect(out.map((c) => c.email)).toEqual(['marlak24@icloud.com']);
  });

  it('qualifies a correction captured on a later call', () => {
    const sightings = [
      { email: 'lymzafi@yahoo.com', callId: 'c1', callAt: at(14), source: 'extraction' },
      { email: 'lynzafi@yahoo.com', callId: 'c2', callAt: at(15), source: 'extraction' },
    ];
    const out = rescue.consensusCandidates(sightings, 'lymzafi@yahoo.com');
    expect(out.map((c) => c.email)).toEqual(['lynzafi@yahoo.com']);
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

  it('flags a collision when the candidate is on ANOTHER customer (any sendable field)', async () => {
    mockTables({
      email_suppressions: makeChain(),
      email_bounce_rescues: makeChain(),
      customers: makeChain({ first: { id: 'other-customer' } }),
    });
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'me', ownerLeadId: null });
    expect(v).toMatchObject({ ok: false, reason: 'collision', collision: { kind: 'customer', id: 'other-customer' } });
  });

  it('flags a collision when the candidate is another party\'s billing email', async () => {
    mockTables({
      email_suppressions: makeChain(),
      email_bounce_rescues: makeChain(),
      customers: makeChain(),
      notification_prefs: makeChain({ first: { customer_id: 'other-customer' } }),
    });
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'me', ownerLeadId: null });
    expect(v).toMatchObject({ ok: false, reason: 'collision', collision: { kind: 'billing_prefs' } });
  });

  it('flags a collision when the candidate is another undeleted lead', async () => {
    mockTables({
      email_suppressions: makeChain(),
      email_bounce_rescues: makeChain(),
      customers: makeChain(),
      notification_prefs: makeChain(),
      leads: makeChain({ first: { id: 'other-lead', customer_id: null } }),
    });
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'me', ownerLeadId: 'my-lead' });
    expect(v).toMatchObject({ ok: false, reason: 'collision', collision: { kind: 'lead', id: 'other-lead' } });
  });

  it('accepts a lead match that belongs to the SAME owner customer', async () => {
    mockTables({
      email_suppressions: makeChain(),
      email_bounce_rescues: makeChain(),
      customers: makeChain(),
      notification_prefs: makeChain(),
      leads: makeChain({ first: { id: 'linked-lead', customer_id: 'me' } }),
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]);
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: 'me', ownerLeadId: null });
    expect(v).toMatchObject({ ok: true });
  });

  it('rejects a domain with no MX', async () => {
    mockTables({ email_suppressions: makeChain(), email_bounce_rescues: makeChain(), customers: makeChain(), notification_prefs: makeChain(), leads: makeChain() });
    dns.resolveMx.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    const v = await rescue.validateCandidate('x@doesnotexist.example', { bouncedEmail: 'y@gmail.com', ownerCustomerId: null, ownerLeadId: 'l1' });
    expect(v).toMatchObject({ ok: false, reason: 'no_mx' });
  });

  it('marks MX unknown (not a hard fail) on DNS infrastructure trouble', async () => {
    mockTables({ email_suppressions: makeChain(), email_bounce_rescues: makeChain(), customers: makeChain(), notification_prefs: makeChain(), leads: makeChain() });
    dns.resolveMx.mockRejectedValue(Object.assign(new Error('flaky'), { code: 'ETIMEOUT' }));
    const v = await rescue.validateCandidate('x@gmail.com', { bouncedEmail: 'y@gmail.com', ownerCustomerId: null, ownerLeadId: 'l1' });
    expect(v).toMatchObject({ ok: true, mxUnknown: true });
  });
});

describe('rescueBouncedAddress flow', () => {
  function customerChainByField(customer) {
    // findOwner probes each sendable field; only the primary-email probe hits.
    const chain = makeChain();
    let probe = 0;
    chain.first = jest.fn(() => {
      probe += 1;
      return Promise.resolve(probe === 1 ? customer : null);
    });
    return chain;
  }

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

  it('does NOT ledger a no-owner address (future evidence stays usable)', async () => {
    const rescues = makeChain({ first: null });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      return makeChain(); // every owner probe -> null
    });
    const r = await rescue.rescueBouncedAddress('gone@gmail.com');
    expect(r).toEqual({ skipped: 'no_owner' });
    expect(rescues.insert).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('dry run gathers and reports but never writes or emails', async () => {
    db.mockImplementation((name) => {
      if (name === 'customers') return customerChainByField({ id: 'c1', first_name: 'Jane', last_name: 'D', phone: '+15550001111', email: 'janeboedmer@gmail.com' });
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-08'),
          transcription: 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('janeboedmer@gmail.com', { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, status: 'suggested', candidate: 'janebodmer@gmail.com', tier: 'transcript_decode' });
    expect(email.send).not.toHaveBeenCalled();
    expect(callAnthropic).not.toHaveBeenCalled(); // deterministic decode sufficed
  });

  it('NEVER auto-applies a transcript decode — tier boundary', async () => {
    const rescues = makeChain({ first: null, returning: [{ id: 'r-decode' }] });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') return customerChainByField({ id: 'c1', first_name: 'Jane', last_name: 'D', phone: '+15550001111', email: 'janeboedmer@gmail.com' });
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-08'),
          transcription: 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('janeboedmer@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'janebodmer@gmail.com' });
    expect(db.transaction).not.toHaveBeenCalled(); // applyFix never ran
    expect(rescues.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'suggested' }));
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringMatching(/^ACT: /),
    }));
  });

  it('NEVER auto-applies extractor consensus — call-derived evidence is owner read-back (AGENTS.md)', async () => {
    const rescues = makeChain({ first: null, returning: [{ id: 'r-consensus' }] });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') return customerChainByField({ id: 'c1', first_name: 'Rae', last_name: 'W', phone: '+15550003333', email: 'lymzafi@yahoo.com' });
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([
          { id: 'call1', created_at: new Date('2026-07-14'), transcription: 'Agent: what email?\nCaller: lymzafi at yahoo dot com', ai_extraction: JSON.stringify({ email: 'lymzafi@yahoo.com' }) },
          { id: 'call2', created_at: new Date('2026-07-15'), transcription: 'Caller: correction, it is lynzafi@yahoo.com', ai_extraction: JSON.stringify({ email: 'lynzafi@yahoo.com' }) },
        ]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', tier: 'extractor_consensus', candidate: 'lynzafi@yahoo.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('NEVER auto-applies a freemail inbound near-miss', async () => {
    const rescues = makeChain({ first: null, returning: [{ id: 'r-freemail' }] });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') return customerChainByField({ id: 'c1', first_name: 'Pat', last_name: 'Q', phone: null, email: 'patq1234@gmail.com' });
      if (name === 'emails') return makeChain({ rows: [{ from_address: 'patq1243@gmail.com' }] });
      if (name === 'call_log') { const c = makeChain(); c.select = jest.fn(() => Promise.resolve([])); return c; }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('patq1234@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', tier: 'inbound_ground_truth', candidate: 'patq1243@gmail.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('auto-applies a NON-freemail inbound near-miss through the ledger-first path', async () => {
    const rescues = makeChain({ first: null, returning: [{ id: 'r-corp' }] });
    db.transaction.mockImplementation(async (fn) => fn(db));
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') {
        const chain = customerChainByField({ id: 'c1', first_name: 'Sam', last_name: 'V', phone: null, email: 'svendor@corp-example.com' });
        chain.update = jest.fn(() => Promise.resolve(1));
        return chain;
      }
      if (name === 'emails') return makeChain({ rows: [{ from_address: 'svendors@corp-example.com' }] });
      if (name === 'call_log') { const c = makeChain(); c.select = jest.fn(() => Promise.resolve([])); return c; }
      if (name === 'customer_interactions') { const c = makeChain(); c.insert = jest.fn(() => Promise.resolve([1])); return c; }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('svendor@corp-example.com');
    expect(r).toMatchObject({ status: 'applied', tier: 'inbound_ground_truth', candidate: 'svendors@corp-example.com' });
    // Ledger-first: the insert carried the pending 'applying' state, not 'applied'.
    expect(rescues.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'applying' }));
    // The primary-email fanout ran with the narrowed call-path review scope.
    const fanout = require('../services/customer-email-fanout');
    expect(fanout.propagateCustomerEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ reviewReasonCodes: ['customer_email_missing'] }),
      expect.anything(),
    );
  });
});

describe('rescueBouncedAddress domain repair (mechanical tier)', () => {
  it('repairs a truncated TLD-less domain and treats it as auto-apply eligible', async () => {
    db.mockImplementation((name) => {
      if (name === 'customers') {
        const chain = makeChain();
        let probe = 0;
        chain.first = jest.fn(() => { probe += 1; return Promise.resolve(probe === 1 ? { id: 'c1', first_name: 'Bee', last_name: 'P', phone: null, email: 'bee.p00@gmail' } : null); });
        return chain;
      }
      if (name === 'call_log') { const c = makeChain(); c.select = jest.fn(() => Promise.resolve([])); return c; }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('bee.p00@gmail', { dryRun: true });
    expect(r).toMatchObject({ status: 'applied', tier: 'domain_repair', candidate: 'bee.p00@gmail.com' });
  });
});

describe('codex r2 contracts', () => {
  it('excludes the OWNER in SQL when checking customer collisions', async () => {
    const customers = makeChain();
    db.mockImplementation((name) => {
      if (name === 'customers') return customers;
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    await rescue.validateCandidate('x@corp-example.com', { bouncedEmail: 'y@corp-example.com', ownerCustomerId: 'me', ownerLeadId: null });
    expect(customers.whereNot).toHaveBeenCalledWith('id', 'me');
  });

  it('falls back to an admin bell when the suggestion email cannot send', async () => {
    const NotificationService = require('../services/notification-service');
    email.send.mockResolvedValue({ ok: false, error: 'Email not configured' });
    const rescues = makeChain({ first: null, returning: [{ id: 'r-fallback' }] });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') {
        const chain = makeChain();
        let probe = 0;
        chain.first = jest.fn(() => { probe += 1; return Promise.resolve(probe === 1 ? { id: 'c1', first_name: 'Jane', last_name: 'D', phone: '+15550001111', email: 'janeboedmer@gmail.com' } : null); });
        return chain;
      }
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-08'),
          transcription: 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('janeboedmer@gmail.com');
    expect(r).toMatchObject({ status: 'suggested' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('could not be emailed'),
      expect.stringContaining('--apply=r-fallback'),
      expect.anything(),
    );
    email.send.mockResolvedValue({ ok: true });
  });

  it('re-examines a no_candidate row when evidence has since landed', async () => {
    const existingRow = { id: 'r-old', status: 'no_candidate', updated_at: new Date('2026-08-01') };
    // First .first() = the entry-guard lookup (returns the stale row);
    // later .first() calls are validateCandidate's prior-attempt check and
    // must return null or every candidate reads as already_tried.
    const rescues = makeChain();
    let rescueProbe = 0;
    rescues.first = jest.fn(() => { rescueProbe += 1; return Promise.resolve(rescueProbe === 1 ? existingRow : null); });
    email.send.mockResolvedValue({ ok: true });
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') {
        const chain = makeChain();
        let probe = 0;
        chain.first = jest.fn(() => { probe += 1; return Promise.resolve(probe === 1 ? { id: 'c1', first_name: 'Jane', last_name: 'D', phone: '+15550001111', email: 'janeboedmer@gmail.com' } : null); });
        return chain;
      }
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-08'),
          transcription: 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('janeboedmer@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'janebodmer@gmail.com', rescueId: 'r-old' });
    expect(rescues.insert).not.toHaveBeenCalled(); // same ledger row, updated in place
    expect(rescues.update).toHaveBeenCalled();
  });

  it('keeps a suggested row terminal (no re-send spam on redelivery)', async () => {
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return makeChain({ first: { id: 'r1', status: 'suggested', updated_at: new Date() } });
      return makeChain();
    });
    const r = await rescue.rescueBouncedAddress('janeboedmer@gmail.com');
    expect(r).toMatchObject({ skipped: 'already_examined', status: 'suggested' });
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('llm decode anchoring', () => {
  it('drops an LLM candidate whose supporting quote is not verbatim in the transcript', async () => {
    callAnthropic.mockResolvedValue({ ok: true, json: { candidate_email: 'samsamohatb@gmail.com', supporting_quote: 'this quote was invented' } });
    db.mockImplementation((name) => {
      if (name === 'customers') {
        const chain = makeChain();
        let probe = 0;
        chain.first = jest.fn(() => { probe += 1; return Promise.resolve(probe === 1 ? { id: 'c1', first_name: 'Sam', last_name: 'A', phone: '+15550002222', email: 'samsamohabb@gmail.com' } : null); });
        return chain;
      }
      if (name === 'call_log') {
        const chain = makeChain();
        chain.select = jest.fn(() => Promise.resolve([{
          id: 'call1', created_at: new Date('2026-06-15'),
          transcription: 'Caller: My email address is samsam and then o-h-a-t-b abbreviation for our house at the beach at gmail.com.',
          ai_extraction: null,
        }]));
        return chain;
      }
      return makeChain();
    });
    const OLD_KEY = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      const r = await rescue.rescueBouncedAddress('samsamohabb@gmail.com', { dryRun: true });
      if (r.candidate) expect(r.evidence.quote).not.toBe('this quote was invented');
    } finally {
      if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = OLD_KEY;
    }
  });
});
