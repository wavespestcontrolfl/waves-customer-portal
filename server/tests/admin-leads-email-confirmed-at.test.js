/**
 * Codex round-4 P1 on the V1/V2 email-disagreement hold (PR #4802,
 * admin-triage.js's emailDisagreementConfirmed): for a customer-less
 * voicemail lead, "the lead's updated_at is later than the card's
 * created_at" was generic row provenance — this route bumps updated_at on
 * ANY allowed field (status, notes, assignment, ...), so an unrelated edit
 * after a fresh disagreement card would falsely confirm it. PUT /:id now
 * stamps a NEW, email-specific column (leads.email_confirmed_at) — and
 * ONLY when the email field itself actually changes.
 *
 * Harness mirrors admin-leads-builder-warranty.test.js's primeUpdate
 * pattern. Fixtures use synthetic example.com addresses, never a real
 * customer's.
 */
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
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

// db stub for the update path (mirrors admin-leads-builder-warranty.test.js):
// the existence check resolves `existing`, then update(...).returning('*')
// captures the patch.
function primeUpdate(captured, existing = { id: 'lead-1', status: 'new', email: 'original@example.com' }) {
  db.mockImplementation((table) => {
    if (table === 'leads') {
      const q = {};
      q.where = jest.fn(() => q);
      q.whereNull = jest.fn(() => q);
      q.first = jest.fn(async () => existing);
      q.forUpdate = jest.fn(() => q);
      q.update = jest.fn((patch) => {
        captured.update = patch;
        return { returning: jest.fn(async () => [{ ...existing, ...patch }]) };
      });
      return q;
    }
    if (table === 'lead_activities') {
      return { insert: jest.fn(async () => [1]) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction = jest.fn(async (work) => work(db));
});

async function putLead(baseUrl, body) {
  return fetch(`${baseUrl}/admin/leads/lead-1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PUT /admin/leads/:id stamps email_confirmed_at only on a real email change', () => {
  test('the email field actually changing stamps email_confirmed_at', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'original@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { email: 'corrected@example.com' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.email).toBe('corrected@example.com');
    expect(captured.update.email_confirmed_at).toBeInstanceOf(Date);
  });

  test('sending the SAME email value (no actual change) does not stamp it', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'same@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { email: 'same@example.com' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.email_confirmed_at).toBeUndefined();
  });

  test('a legacy mixed-case stored address re-saved unchanged does not stamp it (normalized compare)', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: ' Same@Example.com ' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { email: 'same@example.com' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.email_confirmed_at).toBeUndefined();
  });

  test('an unrelated field edit (status/notes) never stamps it — the whole point of the fix', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'original@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { notes: 'Called back, left voicemail.' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.notes).toBe('Called back, left voicemail.');
    // updated_at is still bumped (generic row provenance)...
    expect(captured.update.updated_at).toBeInstanceOf(Date);
    // ...but email_confirmed_at is NOT — this is the whole fix.
    expect(captured.update.email_confirmed_at).toBeUndefined();
  });

  test('a status change alone never stamps it either', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'original@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { status: 'contacted' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.status).toBe('contacted');
    expect(captured.update.email_confirmed_at).toBeUndefined();
  });

  test('clearing the email to blank is a real change and still stamps it', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'original@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { email: '' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.email_confirmed_at).toBeInstanceOf(Date);
  });

  // Codex round-6 P2: email_confirmed_at is the sole provenance signal a
  // customer-less voicemail card's confirmation reads — it must never
  // stamp on an unvalidated value ('not-an-email' would otherwise satisfy
  // admin-triage.js's emailDisagreementConfirmed guard).
  test('an invalid email format refuses with 400 and writes nothing', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'original@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { email: 'not-an-email' });
      expect(res.status).toBe(400);
    });
    expect(captured.update).toBeUndefined();
  });

  test('a typo-shaped but syntactically valid address still normalizes (trim + lowercase) before stamping', async () => {
    const captured = {};
    primeUpdate(captured, { id: 'lead-1', status: 'new', email: 'original@example.com' });
    await withServer(async (baseUrl) => {
      const res = await putLead(baseUrl, { email: '  Jane.Doe@Example.com  ' });
      expect(res.status).toBe(200);
    });
    expect(captured.update.email).toBe('jane.doe@example.com');
    expect(captured.update.email_confirmed_at).toBeInstanceOf(Date);
  });
});
