jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Chainable recorder: every builder method returns the builder; `first()`
// resolves `firstResult`, awaiting the builder itself resolves `rows`.
function makeBuilder({ firstResult, rows = [], calls = [] } = {}) {
  const builder = {};
  for (const method of [
    'leftJoin', 'select', 'where', 'whereIn', 'whereNot', 'whereNull',
    'whereNotNull', 'whereRaw', 'orWhere', 'orWhereRaw', 'orWhereNotNull',
    'orderBy', 'limit',
  ]) {
    builder[method] = jest.fn((...args) => {
      calls.push([method, ...args]);
      return builder;
    });
  }
  builder.first = jest.fn(async () => firstResult);
  builder.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return builder;
}

const LEAD = {
  id: 'lead-1',
  phone: '+12155848892',
  twilio_call_sid: 'CA' + 'a'.repeat(32),
  deleted_at: null,
};

// db('leads') is hit twice on this route: the lead fetch, then the shared-line
// guard (another live lead on the same last-10 suppresses the phone fallback).
function makeLeadsTable({ lead = LEAD, sharedLead = undefined } = {}) {
  let hits = 0;
  return () => {
    hits += 1;
    return makeBuilder({ firstResult: hits === 1 ? lead : sharedLead });
  };
}

describe('GET /admin/leads/:id — call reference (recording + transcript)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql) => `raw(${sql})`);
  });

  test('returns recent calls with transcription and recording sid, never the raw recording_url', async () => {
    const callLogCalls = [];
    const callRow = {
      id: 'call-1',
      direction: 'inbound',
      duration_seconds: 245,
      recording_sid: 'RE' + 'b'.repeat(32),
      recording_url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/REbbb',
      transcription: 'Caller: I have German roaches in the kitchen...',
      transcription_status: 'completed',
      created_at: '2026-07-14T20:09:19.000Z',
    };
    const leadsTable = makeLeadsTable();
    db.mockImplementation((table) => {
      if (table === 'leads') return leadsTable();
      if (table === 'lead_activities') return makeBuilder({ rows: [] });
      if (table === 'call_log') return makeBuilder({ rows: [callRow], calls: callLogCalls });
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.calls).toHaveLength(1);
      expect(body.calls[0]).toEqual({
        id: 'call-1',
        direction: 'inbound',
        duration_seconds: 245,
        recording_sid: callRow.recording_sid,
        has_recording: true,
        transcription: callRow.transcription,
        transcription_status: 'completed',
        created_at: callRow.created_at,
      });
      // The Twilio recording_url (contains the account SID) stays server-side.
      expect(body.calls[0].recording_url).toBeUndefined();
    });

    // Newest-first, bounded — the expanded card is a reference, not a call log.
    expect(callLogCalls).toContainEqual(['orderBy', 'created_at', 'desc']);
    expect(callLogCalls).toContainEqual(['limit', 3]);
  });

  test('matches calls by call SID and by 10-digit phone on either leg', async () => {
    const leadsTable = makeLeadsTable();
    db.mockImplementation((table) => {
      if (table === 'leads') return leadsTable();
      if (table === 'lead_activities') return makeBuilder({ rows: [] });
      if (table === 'call_log') return makeBuilder({ rows: [] });
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`);
      expect(res.status).toBe(200);
    });

    // Replay the grouped where-callback the route built against a recorder to
    // verify the match predicate: lead SID OR RIGHT-10 phone on from/to.
    const callLogWhereFns = db.mock.calls
      .map((_, i) => db.mock.results[i])
      .filter((r) => r.type === 'return')
      .flatMap((r) => (r.value?.where?.mock ? r.value.where.mock.calls : []))
      .map((args) => args[0])
      .filter((arg) => typeof arg === 'function');
    expect(callLogWhereFns.length).toBeGreaterThanOrEqual(1);

    const recorded = [];
    const group = {
      orWhere: (...args) => { recorded.push(['orWhere', ...args]); return group; },
      orWhereRaw: (...args) => { recorded.push(['orWhereRaw', ...args]); return group; },
      whereNotNull: (...args) => { recorded.push(['whereNotNull', ...args]); return group; },
      orWhereNotNull: (...args) => { recorded.push(['orWhereNotNull', ...args]); return group; },
    };
    callLogWhereFns.forEach((fn) => fn.call(group));

    expect(recorded).toContainEqual(['orWhere', 'twilio_call_sid', LEAD.twilio_call_sid]);
    const rawMatches = recorded.filter(
      (c) => c[0] === 'orWhereRaw' && String(c[2]) === '2155848892',
    );
    expect(rawMatches.length).toBe(2); // from_phone + to_phone legs
    expect(recorded).toContainEqual(['whereNotNull', 'transcription']);
    expect(recorded).toContainEqual(['orWhereNotNull', 'recording_url']);
  });

  test('shared line: another live lead on the same number suppresses the phone fallback', async () => {
    // Different callers on one number are split into separate leads on
    // purpose (name-conflict path) — a phone match here would surface the
    // OTHER person's transcript/recording on this card. SID linkage only.
    const leadsTable = makeLeadsTable({ sharedLead: { id: 'lead-other' } });
    db.mockImplementation((table) => {
      if (table === 'leads') return leadsTable();
      if (table === 'lead_activities') return makeBuilder({ rows: [] });
      if (table === 'call_log') return makeBuilder({ rows: [] });
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`);
      expect(res.status).toBe(200);
    });

    const callLogWhereFns = db.mock.calls
      .map((_, i) => db.mock.results[i])
      .filter((r) => r.type === 'return')
      .flatMap((r) => (r.value?.where?.mock ? r.value.where.mock.calls : []))
      .map((args) => args[0])
      .filter((arg) => typeof arg === 'function');

    const recorded = [];
    const group = {
      orWhere: (...args) => { recorded.push(['orWhere', ...args]); return group; },
      orWhereRaw: (...args) => { recorded.push(['orWhereRaw', ...args]); return group; },
      whereNotNull: (...args) => { recorded.push(['whereNotNull', ...args]); return group; },
      orWhereNotNull: (...args) => { recorded.push(['orWhereNotNull', ...args]); return group; },
    };
    callLogWhereFns.forEach((fn) => fn.call(group));

    // The SID linkage stays; no phone-leg predicates were added.
    expect(recorded).toContainEqual(['orWhere', 'twilio_call_sid', LEAD.twilio_call_sid]);
    expect(recorded.filter((c) => c[0] === 'orWhereRaw' && String(c[2]) === '2155848892')).toEqual([]);
  });

  // Extract the where-group predicates the call_log query was built with.
  const recordedCallLogPredicates = () => {
    const callLogWhereFns = db.mock.calls
      .map((_, i) => db.mock.results[i])
      .filter((r) => r.type === 'return')
      .flatMap((r) => (r.value?.where?.mock ? r.value.where.mock.calls : []))
      .map((args) => args[0])
      .filter((arg) => typeof arg === 'function');
    const recorded = [];
    const group = {
      orWhere: (...args) => {
        // A grouped arm (the settled-stamp arm wraps the metadata predicate
        // with whereNull(processing_token)) — run the callback against a
        // sub-recorder so its inner predicates are captured as
        // 'orWhere>...' entries.
        if (typeof args[0] === 'function') {
          const sub = {
            whereRaw: (...a) => { recorded.push(['orWhere>whereRaw', ...a]); return sub; },
            whereNull: (...a) => { recorded.push(['orWhere>whereNull', ...a]); return sub; },
          };
          args[0].call(sub);
          return group;
        }
        recorded.push(['orWhere', ...args]);
        return group;
      },
      orWhereRaw: (...args) => { recorded.push(['orWhereRaw', ...args]); return group; },
      whereNotNull: (...args) => { recorded.push(['whereNotNull', ...args]); return group; },
      orWhereNotNull: (...args) => { recorded.push(['orWhereNotNull', ...args]); return group; },
    };
    callLogWhereFns.forEach((fn) => fn.call(group));
    return recorded;
  };

  test('shared line without a call SID: call_log still queries via the metadata stamp — no phone legs, no sid arm', async () => {
    // A SID-less lead reused by a phone-less call links ONLY through
    // call_log.metadata.lead_id — skipping the lookup hid its transcript
    // and recording from the card (codex P1, PR #3275). The shared-line
    // safety survives: no phone-leg predicates are added.
    const leadsTable = makeLeadsTable({
      lead: { id: 'lead-1', phone: '+12155848892', twilio_call_sid: null },
      sharedLead: { id: 'lead-other' },
    });
    db.mockImplementation((table) => {
      if (table === 'leads') return leadsTable();
      if (table === 'lead_activities') return makeBuilder({ rows: [] });
      if (table === 'call_log') return makeBuilder({ rows: [] });
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.calls).toEqual([]);
    });

    const recorded = recordedCallLogPredicates();
    expect(recorded).toContainEqual(['orWhere>whereRaw', "metadata->>'lead_id' = ?", ['lead-1']]);
    // SETTLED stamps only — the arm requires processing_token IS NULL so a
    // mid-flight pass's provisional stamp never surfaces another caller's
    // transcript on the wrong card (pre-push P1).
    expect(recorded).toContainEqual(['orWhere>whereNull', 'processing_token']);
    expect(recorded.filter((c) => c[0] === 'orWhere')).toEqual([]);
    expect(recorded.filter((c) => c[0] === 'orWhereRaw' && String(c[2]) === '2155848892')).toEqual([]);
  });

  test('lead with no phone and no call SID still queries stamped calls — metadata arm only', async () => {
    db.mockImplementation((table) => {
      if (table === 'leads') {
        return makeBuilder({ firstResult: { id: 'lead-2', phone: null, twilio_call_sid: null } });
      }
      if (table === 'lead_activities') return makeBuilder({ rows: [] });
      if (table === 'call_log') return makeBuilder({ rows: [] });
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-2`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.calls).toEqual([]);
    });

    const recorded = recordedCallLogPredicates();
    expect(recorded).toContainEqual(['orWhere>whereRaw', "metadata->>'lead_id' = ?", ['lead-2']]);
    expect(recorded).toContainEqual(['orWhere>whereNull', 'processing_token']);
    expect(recorded.filter((c) => c[0] === 'orWhere')).toEqual([]);
  });

  test('call_log failure is non-blocking — lead + activities still return', async () => {
    const leadsTable = makeLeadsTable();
    db.mockImplementation((table) => {
      if (table === 'leads') return leadsTable();
      if (table === 'lead_activities') return makeBuilder({ rows: [{ id: 1 }] });
      if (table === 'call_log') throw new Error('relation "call_log" does not exist');
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.lead.id).toBe('lead-1');
      expect(body.activities).toHaveLength(1);
      expect(body.calls).toEqual([]);
    });
  });
});
