/**
 * Contracts for the bounce→transcript rescue. Fixtures are SYNTHETIC but
 * preserve the exact decoder shapes hand-verified in the 2026-08-05 prod
 * sweep (digit-tail letter run, hyphenated run, phonetic alphabet,
 * correction callback, freemail near-miss) — no customer PII in the repo.
 *
 * Safety contracts pinned here:
 *  - call-derived evidence (consensus/decode) NEVER auto-applies (AGENTS.md
 *    call-pipeline rule: owner read-back, never auto-correct), except the
 *    self-fix behind GATE_CALL_BOUNCE_SELF_FIX (owner 2026-11-17): one small
 *    fix, a customer's primary email, once per customer;
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
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn(() => Promise.resolve()) }));
// Same behavior as the real gate-off path (sendEmail() runs unchanged) —
// this only lets the admin-alerts-ring test below inspect the call's args.
const mockDeliverOpsDigest = jest.fn(async ({ sendEmail }) => sendEmail());
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: (...args) => mockDeliverOpsDigest(...args) }));
jest.mock('../services/customer-email-fanout', () => ({ propagateCustomerEmailChange: jest.fn(() => Promise.resolve({})) }));
jest.mock('dns', () => ({ promises: { resolveMx: jest.fn() } }));

const db = require('../models/db');
const dns = require('dns').promises;
const email = require('../services/email');
const { dispatchWithFallback } = require('../services/llm/call');
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
  delete process.env.GATE_CALL_BOUNCE_SELF_FIX;
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
    expect(dispatchWithFallback).not.toHaveBeenCalled(); // deterministic decode sufficed
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
    rescues.update = jest.fn(() => Promise.resolve(1)); // Postgres: one row matched (the 'applied' mark)
    db.transaction.mockImplementation(async (fn) => fn(db));
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') return rescues;
      if (name === 'customers') {
        const chain = customerChainByField({ id: 'c1', first_name: 'Sam', last_name: 'V', phone: null, email: 'svendor@corp-example.com' });
        chain.update = jest.fn(() => Promise.resolve(1));
        chain.forUpdate = jest.fn(() => chain);
        return chain;
      }
      if (name === 'emails') return makeChain({ rows: [{ from_address: 'svendors@corp-example.com' }] });
      if (name === 'call_log') { const c = makeChain(); c.select = jest.fn(() => Promise.resolve([])); return c; }
      if (name === 'customer_interactions') { const c = makeChain(); c.insert = jest.fn(() => Promise.resolve([1])); return c; }
      return makeChain();
    });
    db.raw = jest.fn(async () => ({})); // the destination key the apply takes
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    const r = await rescue.rescueBouncedAddress('svendor@corp-example.com');
    expect(r).toMatchObject({ status: 'applied', tier: 'inbound_ground_truth', candidate: 'svendors@corp-example.com' });
    // Ledger-first: the insert carried the pending 'applying' state, not 'applied'.
    expect(rescues.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'applying' }));
    expect(rescues.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied', applied_by: 'webhook' }));
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
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { candidate_email: 'samsamohatb@gmail.com', supporting_quote: 'this quote was invented' } });
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

// Admin-alerts-brevity scope (owner ruling 2026-09-28): the ACT-needs-a-
// human suggestion email's short bell copy — generic headline (no customer
// name), summary names the candidate when one exists.
describe('bounceSuggestionHeadlineAndSummary', () => {
  test('a candidate found: summary names it and asks to confirm', () => {
    expect(rescue.bounceSuggestionHeadlineAndSummary('jane@newdomain.com')).toEqual({
      headline: 'Email — bounce needs a fix',
      summary: 'Best guess is jane@newdomain.com. Confirm and apply it.',
    });
  });

  test('no confident candidate: summary asks for a new address', () => {
    expect(rescue.bounceSuggestionHeadlineAndSummary(null)).toEqual({
      headline: 'Email — bounce needs a fix',
      summary: 'No good replacement found. Ask for a new address.',
    });
  });
});

// admin-alerts-ring scope (2026-09-28): every call here is a DIFFERENT
// customer's bounce needing a human — count alone would go quiet after the
// first (they all share one alertClass), so newCount:1 says every one is
// new news and it always rings.
describe('sendSuggestionEmail — always rings (admin-alerts-ring scope)', () => {
  beforeEach(() => { mockDeliverOpsDigest.mockClear(); });

  test('passes count:1 and newCount:1 to deliverOpsDigest', async () => {
    await rescue.sendSuggestionEmail({
      rescueRowId: 'r1', bouncedEmail: 'first@bounced.example', candidate: null,
      owner: { lead: { first_name: 'A', last_name: 'One' } },
    });
    expect(mockDeliverOpsDigest).toHaveBeenCalledWith(expect.objectContaining({
      key: 'email-bounce-rescue', count: 1, newCount: 1,
    }));
  });

  test('a second, DIFFERENT address within 7 days also rings — not silenced by the first', async () => {
    await rescue.sendSuggestionEmail({
      rescueRowId: 'r1', bouncedEmail: 'first@bounced.example', candidate: null,
      owner: { lead: { first_name: 'A', last_name: 'One' } },
    });
    await rescue.sendSuggestionEmail({
      rescueRowId: 'r2', bouncedEmail: 'second@bounced.example', candidate: 'guess@bounced.example',
      owner: { lead: { first_name: 'B', last_name: 'Two' } },
    });
    expect(mockDeliverOpsDigest).toHaveBeenCalledTimes(2);
    for (const call of mockDeliverOpsDigest.mock.calls) {
      expect(call[0]).toMatchObject({ count: 1, newCount: 1 });
    }
  });
});

// Owner 2026-11-03: a hand-fixed email left this alert open with a stale guess. The alert now
// names what admin-alert-relevance.js (class email_bounce_fix) needs to close it once fixed.
describe('the alert names its bounced address, owner and field', () => {
  beforeEach(() => { mockDeliverOpsDigest.mockClear(); });

  test('a customer owner: its id and the field the address bounced from', async () => {
    await rescue.sendSuggestionEmail({
      rescueRowId: 'r1', bouncedEmail: 'm.sample@example.net', candidate: 'sample@example.net',
      owner: { customer: { id: 'c1', first_name: 'M', last_name: 'Sample' }, lead: null, field: 'service_contact_email' },
    });
    expect(mockDeliverOpsDigest).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { doneWhen: 'bounced_email_replaced', bouncedEmail: 'm.sample@example.net', customerId: 'c1', ownerField: 'service_contact_email' },
    }));
  });

  test('a lead owner by its id; an owner with no id names nothing, so the sweep never judges it', () => {
    expect(rescue.bounceAlertMetadata({ bouncedEmail: 'x@example.net', owner: { customer: null, lead: { id: 'l1' }, field: 'email' } }))
      .toEqual({ doneWhen: 'bounced_email_replaced', bouncedEmail: 'x@example.net', leadId: 'l1', ownerField: 'email' });
    expect(rescue.bounceAlertMetadata({ bouncedEmail: 'x@example.net', owner: { lead: { first_name: 'A' } } })).toEqual({});
  });

  test('the sweep repeats this alert\'s doneWhen and email fields (the two files each hold them)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/admin-alert-relevance'), 'utf8');
    expect(rescue.BOUNCE_ALERT_DONE_WHEN).toBe('bounced_email_replaced');
    expect(src).toContain(`const BOUNCE_DONE_WHEN = '${rescue.BOUNCE_ALERT_DONE_WHEN}';`);
    expect(src).toContain(`const BOUNCE_CUSTOMER_FIELDS = [${rescue.CUSTOMER_EMAIL_FIELDS.map((f) => `'${f}'`).join(', ')}];`);
  });
});

// ── self-fix (GATE_CALL_BOUNCE_SELF_FIX, owner 2026-11-17) ─────────────────
// Synthetic shapes of the prod ledger cases: one misheard letter (right),
// two dots the caller never said (right), "drop the 37" said on a later call,
// and the one wrong guess on record, which dropped a letter.

describe('self-fix change count', () => {
  it('counts the shapes from the prod ledger', () => {
    expect(rescue.selfFixCost('jkatanescu', 'jcatanescu')).toBe(1); // one misheard letter
    expect(rescue.selfFixCost('pat.e.lane', 'patelane')).toBe(2); // two dots the caller never said
    expect(rescue.selfFixCost('sanfran77737', 'sanfran777')).toBe(2); // "drop the 37"
    expect(rescue.selfFixCost('jonsmith', 'johnsmith')).toBe(1); // a letter the transcript lost
  });

  it('never counts a dropped letter as a small fix (the wrong guess on record)', () => {
    expect(rescue.selfFixCost('janeboedmer', 'janebodmer')).toBeGreaterThan(2);
    expect(rescue.isSmallFix('janeboedmer@gmail.com', 'janebodmer@gmail.com')).toBe(false);
  });

  it('keeps a change in its kind: a letter never turns into a digit or a dot', () => {
    expect(rescue.selfFixCost('bo1', 'b01')).toBeGreaterThan(2);
    expect(rescue.selfFixCost('ab.c', 'a..c')).toBeGreaterThan(2);
    expect(rescue.selfFixCost('ab3', 'ab4')).toBe(1); // digit to digit
  });

  it('needs the same domain, a different address and at most 2 changes', () => {
    expect(rescue.isSmallFix('lymzafi@yahoo.com', 'lynzafi@yahoo.com')).toBe(true);
    expect(rescue.isSmallFix('lymzafi@yahoo.com', 'lynzafi@gmail.com')).toBe(false);
    expect(rescue.isSmallFix('lymzafi@yahoo.com', 'LYMZAFI@yahoo.com')).toBe(false);
    expect(rescue.isSmallFix('abc123@yahoo.com', 'abc@yahoo.com')).toBe(false); // 3 digits
  });
});

describe('rescueBouncedAddress self-fix', () => {
  const RAE = { id: 'c1', first_name: 'Rae', last_name: 'W', phone: '+15550003333', email: 'lymzafi@yahoo.com' };
  const RAE_CALLS = [
    { id: 'call1', created_at: new Date('2026-07-14'), transcription: 'Agent: what email?\nCaller: lymzafi at yahoo dot com', ai_extraction: JSON.stringify({ email: 'lymzafi@yahoo.com' }) },
    { id: 'call2', created_at: new Date('2026-07-15'), transcription: 'Caller: correction, it is lynzafi@yahoo.com', ai_extraction: JSON.stringify({ email: 'lynzafi@yahoo.com' }) },
  ];

  // A table fake per db() call. The ledger answers the once-per-customer
  // probe (its whereRaw names self_fix) with `earlierSelfFix`, and the
  // bounced-before probe with `bouncedBefore`; every other ledger read finds
  // nothing. The do-not-email list holds `blockedBefore` as RELEASED rows: an
  // any-status read finds them, the active-only read does not. `ownerProbe`
  // picks which findOwner probe hits (1 = primary email, 2 = service contact).
  function world({
    customer = RAE, calls = RAE_CALLS, earlierSelfFix = false, bouncedBefore = [], blockedBefore = [],
    ownerProbe = 1, customerUpdates = 1, existingRow = null, claimRows = 1, blockedInTrx = [],
  } = {}) {
    const ledger = { inserts: [], updates: [], inTransaction: [] };
    let ledgerUpdateCount = 0;
    let inTrx = false;
    const notes = [];
    let customerProbes = 0;
    db.transaction.mockImplementation(async (fn) => {
      inTrx = true;
      try { return await fn(db); } finally { inTrx = false; }
    });
    db.raw = jest.fn(async () => ({}));
    db.mockImplementation((name) => {
      if (name === 'email_bounce_rescues') {
        const chain = makeChain({ returning: [{ id: 'r-self' }] });
        let selfFixProbe = false;
        let bouncedProbe = null;
        chain.whereRaw = jest.fn((sql, args) => {
          if (String(sql).includes('self_fix')) selfFixProbe = true;
          if (String(sql).includes('bounced_email')) [bouncedProbe] = args || [];
          return chain;
        });
        // knownBadAddress reads bounced_email through suppressionCoversEmail (a callback).
        chain.where = jest.fn((arg) => {
          if (typeof arg === 'function') {
            const ctx = {
              whereRaw: (sql, args) => { if (String(sql).includes('bounced_email')) [bouncedProbe] = args || []; return ctx; },
              orWhereRaw: () => ctx,
              orWhere: () => ctx,
            };
            arg.call(ctx, ctx); // knex passes the builder as `this` and as the argument
          }
          return chain;
        });
        chain.first = jest.fn(() => {
          if (selfFixProbe && earlierSelfFix) return Promise.resolve({ id: 'r-earlier' });
          if (existingRow && bouncedProbe === existingRow.bounced_email) return Promise.resolve(existingRow);
          if (bouncedProbe && bouncedBefore.includes(bouncedProbe)) return Promise.resolve({ id: 'r-bounced' });
          return Promise.resolve(null);
        });
        chain.insert = jest.fn((row) => { ledger.inserts.push(row); return chain; });
        // The first ledger update on a reusable row is the claim.
        chain.update = jest.fn((row) => {
          ledger.updates.push(row);
          if (inTrx) ledger.inTransaction.push(row);
          ledgerUpdateCount += 1;
          return Promise.resolve(existingRow && ledgerUpdateCount === 1 ? claimRows : 1);
        });
        return chain;
      }
      if (name === 'email_suppressions') {
        const chain = makeChain();
        let probe = null;
        let activeOnly = false;
        chain.where = jest.fn((arg) => {
          if (typeof arg === 'function') {
            const ctx = { whereRaw: (sql, args) => { [probe] = args || []; return ctx; }, orWhereRaw: () => ctx };
            arg.call(ctx);
          } else if (arg && arg.status === 'active') {
            activeOnly = true;
          }
          return chain;
        });
        chain.first = jest.fn(() => {
          // A block that lands after the first checks: only the save's re-read (inside its transaction) sees it.
          if (inTrx && blockedInTrx.includes(probe)) return Promise.resolve({ id: 's-late' });
          return Promise.resolve(!activeOnly && blockedBefore.includes(probe) ? { id: 's-released' } : null);
        });
        return chain;
      }
      if (name === 'customers') {
        const chain = makeChain();
        chain.first = jest.fn(() => {
          customerProbes += 1;
          return Promise.resolve(customerProbes >= ownerProbe ? customer : null);
        });
        chain.update = jest.fn(() => Promise.resolve(customerUpdates));
        chain.forUpdate = jest.fn(() => chain);
        return chain;
      }
      if (name === 'call_log') {
        const chain = makeChain();
        // A call has its processing verdict unless the case says otherwise.
        chain.select = jest.fn(() => Promise.resolve(calls.map((c) => ({ processing_status: 'processed', ...c }))));
        return chain;
      }
      if (name === 'customer_interactions') {
        const chain = makeChain();
        chain.insert = jest.fn((row) => { notes.push(row); return Promise.resolve([1]); });
        return chain;
      }
      return makeChain();
    });
    dns.resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }]);
    return { ledger, notes };
  }

  const NotificationService = require('../services/notification-service');
  const fanout = require('../services/customer-email-fanout');

  it('saves one small call fix for the primary email, with a note and one alert', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    const { ledger, notes } = world();
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'applied', tier: 'extractor_consensus', candidate: 'lynzafi@yahoo.com', selfFix: true });
    // Ledger-first, and the row is marked a self-fix (the once-per-customer key).
    expect(ledger.inserts[0]).toMatchObject({ status: 'applying' });
    expect(JSON.parse(ledger.inserts[0].evidence)).toMatchObject({ self_fix: true });
    expect(ledger.updates).toContainEqual(expect.objectContaining({ status: 'applied', applied_by: 'webhook' }));
    // ...in the same transaction as the email change, so a committed fix
    // always carries its 'applied' self-fix row.
    expect(ledger.inTransaction).toEqual([expect.objectContaining({ status: 'applied', applied_by: 'webhook' })]);
    // The primary-email fanout with the narrowed review scope, like every apply.
    expect(fanout.propagateCustomerEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ after: { id: 'c1', email: 'lynzafi@yahoo.com' }, reviewReasonCodes: ['customer_email_missing'] }),
      expect.anything(),
    );
    // The note keeps the old address.
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('lymzafi@yahoo.com');
    expect(notes[0].body).toContain('self-fix');
    expect(JSON.parse(notes[0].metadata)).toMatchObject({ bounced_email: 'lymzafi@yahoo.com', self_fix: true });
    // One office alert, and no suggestion email.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'system',
      'Bounced email auto-corrected from evidence on file',
      expect.stringMatching(/lymzafi@yahoo\.com bounced; email corrected to lynzafi@yahoo\.com/),
      expect.anything(),
    );
    expect(email.send).not.toHaveBeenCalled();
  });

  it('a save that loses a race goes to a person: the row is demoted and the suggestion email still goes', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    const { ledger, notes } = world({ customerUpdates: 0 }); // the address moved under the apply (STALE_OWNER)
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', reason: expect.stringMatching(/^apply failed/) });
    expect(ledger.updates).toContainEqual(expect.objectContaining({ status: 'suggested' }));
    expect(notes).toHaveLength(0);
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/^ACT: /) }));
  });

  it('stays a suggestion with the switch off (today, unchanged)', async () => {
    const { ledger } = world();
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', tier: 'extractor_consensus', candidate: 'lynzafi@yahoo.com' });
    expect(r.selfFix).toBeUndefined();
    expect(JSON.parse(ledger.inserts[0].evidence).self_fix).toBeUndefined();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('never saves a guess that drops a letter', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({
      customer: { id: 'c2', first_name: 'Jane', last_name: 'D', phone: '+15550001111', email: 'janeboedmer@gmail.com' },
      calls: [{ id: 'call1', created_at: new Date('2026-06-08'), transcription: 'Caller: It is J-A-N-E-B-O-D-M-E-R at gmail.com.', ai_extraction: null }],
    });
    const r = await rescue.rescueBouncedAddress('janeboedmer@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'janebodmer@gmail.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('leaves a second bounce for the same customer to a person (once per customer)', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({ earlierSelfFix: true });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/^ACT: /) }));
  });

  it('never moves back to an address that bounced before', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({ bouncedBefore: ['lynzafi@yahoo.com'] });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'lynzafi@yahoo.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  const JOHN = { id: 'c4', first_name: 'Jon', last_name: 'T', phone: '+15550005555', email: 'john123@gmail.com' };

  it('never saves a spelled-out guess that borrows the domain and digits of the bounced address', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({
      customer: JOHN,
      calls: [{ id: 'callj', created_at: new Date('2026-07-14'), transcription: 'Caller: My email is J-O-H-N-S at yahoo dot com', ai_extraction: null }],
    });
    const r = await rescue.rescueBouncedAddress('john123@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', tier: 'transcript_decode', candidate: 'johns123@gmail.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('leaves a fix to a person when a later call talks about email and does not name it', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({
      customer: JOHN,
      calls: [
        { id: 'callk', created_at: new Date('2026-07-14'), transcription: 'Caller: it is johns123@gmail.com', ai_extraction: JSON.stringify({ email: 'johns123@gmail.com' }) },
        { id: 'calll', created_at: new Date('2026-07-20'), transcription: 'Caller: About my email, there is no 3 at the end.', ai_extraction: null },
      ],
    });
    const r = await rescue.rescueBouncedAddress('john123@gmail.com');
    expect(r).toMatchObject({ status: 'suggested', tier: 'extractor_consensus', candidate: 'johns123@gmail.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('never saves a read-back the caller turned down: the newest email call must give the fix as its extracted email', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({
      calls: [
        RAE_CALLS[0],
        {
          id: 'call3', created_at: new Date('2026-07-16'), ai_extraction: JSON.stringify({ email: null }),
          transcription: 'Agent: so your email is lynzafi@yahoo.com?\nCaller: No, remove the final letter.',
        },
      ],
    });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'lynzafi@yahoo.com' });
    expect(r.selfFix).toBeUndefined();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('waits for a call still in processing: no self-fix while the newest email call has no verdict', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({ calls: [RAE_CALLS[0], { ...RAE_CALLS[1], processing_status: 'processing', processed_at: null }] });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'lynzafi@yahoo.com' });
    expect(r.selfFix).toBeUndefined();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('re-reads the destination under its lock: a block that lands after the checks stops the save', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    const { ledger, notes } = world({ blockedInTrx: ['lynzafi@yahoo.com'] });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'lynzafi@yahoo.com' });
    expect(r.reason).toMatch(/destination taken or blocked/);
    expect(ledger.inTransaction).toEqual([]);
    expect(notes).toEqual([]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  it('claims a re-examined row before it writes; a run that loses the claim writes and sends nothing', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    mockDeliverOpsDigest.mockClear();
    const row = { id: 'r-old', bounced_email: 'lymzafi@yahoo.com', status: 'no_candidate' };
    const lost = world({ existingRow: row, claimRows: 0 });
    expect(await rescue.rescueBouncedAddress('lymzafi@yahoo.com')).toEqual({ skipped: 'already_examined' });
    expect(lost.ledger.updates).toHaveLength(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockDeliverOpsDigest).not.toHaveBeenCalled();

    const won = world({ existingRow: row, claimRows: 1 });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'applied', selfFix: true, rescueId: 'r-old' });
    expect(won.ledger.updates[0]).toMatchObject({ status: 'applying', candidate_email: 'lynzafi@yahoo.com' });
  });

  it('never moves to an address that was on the do-not-email list, even after that block was released', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({ blockedBefore: ['lynzafi@yahoo.com'] });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'lynzafi@yahoo.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('leaves a small fix to a person when a later call names a different, bigger change', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({
      calls: [...RAE_CALLS, {
        id: 'call3', created_at: new Date('2026-07-20'),
        transcription: 'Caller: actually, use lynn.zafiro@yahoo.com', ai_extraction: JSON.stringify({ email: 'lynn.zafiro@yahoo.com' }),
      }],
    });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('leaves a near-miss address the customer emailed us from, which the calls do not name, to a person', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world();
    const inbound = makeChain({ rows: [{ from_address: 'lymzafy@yahoo.com' }] });
    const tables = db.getMockImplementation();
    db.mockImplementation((name) => (name === 'emails' ? inbound : tables(name)));
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('leaves two different small fixes to a person (the calls disagree)', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({
      calls: [
        ...RAE_CALLS,
        { id: 'call3', created_at: new Date('2026-07-16'), transcription: 'Caller: it is lymzafy@yahoo.com', ai_extraction: JSON.stringify({ email: 'lymzafy@yahoo.com' }) },
      ],
    });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('needs a verified mail server (DNS trouble stays a suggestion)', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world();
    dns.resolveMx.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', reason: 'MX could not be verified' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('only fixes the primary email (a service contact stays a suggestion)', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    world({ customer: { ...RAE, email: 'rae.primary@yahoo.com', service_contact_email: 'lymzafi@yahoo.com' }, ownerProbe: 2 });
    const r = await rescue.rescueBouncedAddress('lymzafi@yahoo.com');
    expect(r).toMatchObject({ status: 'suggested', candidate: 'lynzafi@yahoo.com' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  describe('a spoken correction ("there\'s not a 3-7 after the 777")', () => {
    const ANN = { id: 'c3', first_name: 'Ann', last_name: 'P', phone: '+15550004444', email: 'sanfran77737@gmail.com' };
    const ANN_CALLS = [{
      id: 'call9', created_at: new Date('2026-09-24'), ai_extraction: null,
      transcription: "Caller: There's one thing about my email. It's a sanfran email.\nAgent: Okay.\nCaller: It's 777, but there's not a 3-7 after the 777.",
    }];
    beforeEach(() => {
      dispatchWithFallback.mockResolvedValue({
        ok: true,
        json: { candidate_email: 'sanfran777@gmail.com', supporting_quote: "there's not a 3-7 after the 777" },
      });
    });

    it('is read and anchored to the quote with the switch on, and stays a suggestion (the AI rebuilt the address)', async () => {
      process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
      world({ customer: ANN, calls: ANN_CALLS });
      const r = await rescue.rescueBouncedAddress('sanfran77737@gmail.com');
      expect(dispatchWithFallback.mock.calls[0][1].system).toContain('knock off that 3-7');
      expect(dispatchWithFallback.mock.calls[0][1].text).toContain("there's not a 3-7 after the 777");
      expect(r).toMatchObject({ status: 'suggested', tier: 'transcript_decode', candidate: 'sanfran777@gmail.com' });
      expect(r.selfFix).toBeUndefined();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('is not asked for with the switch off (the prompt is unchanged)', async () => {
      world({ customer: ANN, calls: ANN_CALLS });
      const r = await rescue.rescueBouncedAddress('sanfran77737@gmail.com');
      expect(dispatchWithFallback.mock.calls[0][1].system).not.toContain('knock off');
      expect(r).toMatchObject({ status: 'suggested' });
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});

describe('relookAfterNewCalls (a later call looks again)', () => {
  function sweepWorld(rows) {
    const marks = [];
    db.raw = jest.fn(() => '1');
    db.mockImplementation((name) => {
      const chain = makeChain({ rows: name === 'email_bounce_rescues as r' ? rows : [] });
      chain.join = jest.fn(() => chain);
      chain.whereExists = jest.fn(() => chain);
      chain.update = jest.fn((row) => {
        marks.push({ where: chain.where.mock.calls.map((c) => c[0]), row });
        return Promise.resolve(1);
      });
      return chain;
    });
    return marks;
  }

  it('does nothing with the switch off (no query)', async () => {
    const rescueFn = jest.fn();
    expect(await rescue.relookAfterNewCalls({ rescueFn })).toEqual({ skipped: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
    expect(rescueFn).not.toHaveBeenCalled();
  });

  it('re-runs the rescue per row and marks each row looked, a failed look too', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    const marks = sweepWorld([{ id: 'r1', bounced_email: 'a1@yahoo.com' }, { id: 'r2', bounced_email: 'b2@yahoo.com' }]);
    const rescueFn = jest.fn()
      .mockResolvedValueOnce({ status: 'applied' })
      .mockRejectedValueOnce(new Error('db down'));
    const summary = await rescue.relookAfterNewCalls({ rescueFn });
    expect(summary).toEqual({ examined: 2, fixed: 1, suggested: 0, unchanged: 0, failed: 1 });
    expect(rescueFn).toHaveBeenNthCalledWith(1, 'a1@yahoo.com', { appliedBy: 'relook' });
    expect(rescueFn).toHaveBeenNthCalledWith(2, 'b2@yahoo.com', { appliedBy: 'relook' });
    // Only a row that is still no_candidate is marked (a saved fix keeps its row).
    expect(marks.map((m) => m.where[0])).toEqual([{ id: 'r1', status: 'no_candidate' }, { id: 'r2', status: 'no_candidate' }]);
  });

  it('marks a row with the time the look started, so a call that lands during the look still counts', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    const marks = sweepWorld([{ id: 'r1', bounced_email: 'a1@yahoo.com' }]);
    let startedAt = null;
    const rescueFn = jest.fn(async () => {
      startedAt = Date.now();
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      return { skipped: 'already_examined', status: 'no_candidate' };
    });
    await rescue.relookAfterNewCalls({ rescueFn });
    expect(marks).toHaveLength(1);
    expect(marks[0].row.updated_at.getTime()).toBeLessThanOrEqual(startedAt);
  });

  it('asks only for no-fix rows of a customer whose primary email is the bounced one', async () => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
    sweepWorld([]);
    await rescue.relookAfterNewCalls({ rescueFn: jest.fn() });
    const query = db.mock.results[0].value;
    expect(db).toHaveBeenCalledWith('email_bounce_rescues as r');
    expect(query.where).toHaveBeenCalledWith('r.status', 'no_candidate');
    expect(query.whereRaw).toHaveBeenCalledWith('LOWER(c.email) = LOWER(r.bounced_email)');
    // The later call: from the customer's phone, processed after the last look, talking about email.
    const sub = makeChain();
    sub.from = jest.fn(() => sub);
    query.whereExists.mock.calls[0][0].call(sub);
    expect(sub.whereRaw).toHaveBeenCalledWith('cl.processed_at > r.updated_at');
    expect(sub.whereRaw).toHaveBeenCalledWith('cl.transcription ~* ?', ['e-?mail|@|\\mdot\\M\\s*(com|net|org|edu)']);
  });
});
