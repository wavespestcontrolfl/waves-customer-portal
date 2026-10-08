/**
 * POST /api/admin/triage/:id/save-contact-note files the people a
 * secondary_contact_captured card names as dated lines in the customer's
 * internal_notes and resolves the card. It is a pure internal note: no
 * service-contact slot, phone/email or consent column is written.
 * Drives the REAL route against an in-memory fake db (same harness as
 * admin-triage-confirm-email.test.js). Fixtures are synthetic.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    // Defaults to admin; a test overrides via the `x-test-role` header
    // (Codex round-7 P1: confirm-email is now admin-only, mirroring
    // apply-property-roles).
    const role = req.headers['x-test-role'] || 'admin';
    req.technician = { id: 'tech-1', role };
    req.technicianId = 'tech-1';
    req.techRole = role;
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const triageRouter = require('../routes/admin-triage');

// Same generic in-memory table simulator as admin-triage-email-disagreement-resolve.test.js.
function makeFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ensure = (name) => tables[name] || (tables[name] = []);

  function builder(tableName) {
    const rows = ensure(tableName);
    const eq = {};
    const whereInClauses = [];
    const whereNotInClauses = [];
    const rawPredicates = [];
    const orPredicates = [];
    const applyEq = (a, b) => { if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b; };
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && whereInClauses.every(({ col, vals }) => vals.includes(row[col]))
      && whereNotInClauses.every(({ col, vals }) => !vals.includes(row[col]))
      && rawPredicates.every((fn) => fn(row))
      && (orPredicates.length === 0 || orPredicates.some((fn) => fn(row)));
    const filtered = () => rows.filter(matches);
    const api = {
      where(a, b) {
        if (typeof a === 'function') {
          a({
            whereNull: (col) => { orPredicates.push((row) => row[col] == null); return api; },
            orWhere: (col, val) => { orPredicates.push((row) => row[col] === val); return api; },
          });
        } else applyEq(a, b);
        return api;
      },
      whereIn(col, vals) { whereInClauses.push({ col, vals }); return api; },
      whereNotIn(col, vals) { whereNotInClauses.push({ col, vals }); return api; },
      // SQL semantics: an absent column reads as NULL (fixture rows omit
      // deleted_at), so match == null rather than strict === null.
      whereNull(col) { rawPredicates.push((row) => row[col] == null); return api; },
      whereNot(obj) {
        for (const [k, v] of Object.entries(obj)) rawPredicates.push((row) => row[k] !== v);
        return api;
      },
      // Only the one raw shape the canonical email writer's conflict check
      // uses (`LOWER(<col>) = ?`); anything else is ignored.
      whereRaw(sql, bindings = []) {
        const m = /LOWER\((\w+)\) = \?/.exec(String(sql));
        if (m) rawPredicates.push((row) => String(row[m[1]] ?? '').toLowerCase() === bindings[0]);
        return api;
      },
      forUpdate() { return api; },
      forShare() { return api; },
      orderBy() { return api; },
      limit() { return api; },
      join() { return api; },
      leftJoin() { return api; },
      modify(fn) { fn(api); return api; },
      // A snapshot copy, not a live reference — matches real knex/pg (a row
      // read here must not silently mutate when a LATER .update() call
      // touches the same table, the way a shared object reference would).
      first: async () => { const r = filtered()[0]; return r ? { ...r } : null; },
      pluck: async (col) => filtered().map((r) => r[col]),
      select: async () => filtered(),
      count: () => ({ first: async () => ({ n: filtered().length }) }),
      update: async (patch, returning) => {
        const found = filtered();
        for (const row of found) Object.assign(row, patch);
        if (returning) return found.map((row) => Object.fromEntries(returning.map((col) => [col, row[col]])));
        return found.length;
      },
      insert(data) {
        const row = { ...data };
        rows.push(row);
        return {
          then: (resolve) => resolve([row]),
          onConflict: (col) => {
            // ON CONFLICT DO NOTHING: drop the new row when one with the same
            // conflict key already existed, and report no inserted rows.
            const dup = typeof col === 'string' && rows.some((r) => r !== row && r[col] === row[col]);
            if (dup) rows.splice(rows.indexOf(row), 1);
            const ignored = dup ? [] : [row];
            return {
              ignore: () => ({ then: (resolve) => resolve(ignored.length), returning: async () => ignored }),
              merge: async () => 1,
            };
          },
          returning: async () => [row],
        };
      },
    };
    return api;
  }
  const conn = (table) => builder(String(table).split(' ')[0]);
  // The fake runs everything on one "connection" that is also the
  // transaction handle — the canonical email writer refuses a
  // non-transactional handle, so mark it as one.
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  conn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  conn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return { conn, tables };
}

function wireDb(dbMock, { conn }) {
  dbMock.mockImplementation(conn);
  dbMock.transaction = conn.transaction;
  dbMock.schema = conn.schema;
  dbMock.raw = conn.raw;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/triage', triageRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, path, body = {}, headers = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

const CALL_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const CALL_CREATED_AT = '2026-10-07T15:30:00.000Z';

const CONTACT_PAYLOAD = {
  flag: 'secondary_contact_captured',
  secondary_contact: {
    name_full: 'Pat Sample', phone_e164: '+19415550123', email: 'pat.sample@example.com',
    role: 'property_owner', notes: 'Do not call him.', wants_notifications: false,
  },
};

function fixture({ payload = CONTACT_PAYLOAD, reason = 'secondary_contact_captured', callCustomer = CUSTOMER_ID, internalNotes = null } = {}) {
  return makeFakeDb({
    triage_items: [{
      id: CARD_ID, call_log_id: CALL_ID, reason_code: reason, status: 'open',
      category: 'lead_intake', severity: 'advisory', payload,
      created_at: CALL_CREATED_AT, updated_at: CALL_CREATED_AT,
    }],
    call_log: [{ id: CALL_ID, review_status: 'open', customer_id: callCustomer, created_at: CALL_CREATED_AT }],
    customers: [{
      id: CUSTOMER_ID, internal_notes: internalNotes, phone: '+19415550100', email: 'owner@example.com',
      service_contact_phone: null, service_contact_email: null, secondary_phone: null,
    }],
  });
}

const EXPECTED_LINE = 'Contact named on call (not a message recipient): Pat Sample (property owner) · +19415550123 · pat.sample@example.com. Do not call him.';

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
});

describe('POST /admin/triage/:id/save-contact-note', () => {
  it('tags the note with the call\'s Eastern day, not the UTC day', async () => {
    // 9:30 PM Eastern on October 7 is already October 8 in UTC.
    const fake = fixture();
    fake.tables.call_log[0].created_at = '2026-10-08T01:30:00.000Z';
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/save-contact-note`);
      expect(res.status).toBe(200);
    });
    expect(fake.tables.customers[0].internal_notes).toBe(`[call 2026-10-07] ${EXPECTED_LINE}`);
  });

  it('appends one dated line, resolves the card, and writes only internal_notes', async () => {
    const fake = fixture();
    // Record every customers update the route (and its transaction) issues.
    const updates = [];
    const tracked = (table) => {
      const api = fake.conn(table);
      if (String(table).split(' ')[0] === 'customers') {
        const u = api.update;
        api.update = async (patch, ...rest) => { updates.push(patch); return u(patch, ...rest); };
      }
      return api;
    };
    tracked.transaction = async (fn) => fn(tracked);
    tracked.raw = fake.conn.raw;
    tracked.schema = fake.conn.schema;
    wireDb(db, { conn: tracked });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/save-contact-note`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, saved: 1, already_present: 0 });
    });
    const customer = fake.tables.customers[0];
    expect(customer.internal_notes).toBe(`[call 2026-10-07] ${EXPECTED_LINE}`);
    // Nothing but the notes (and the touch stamp) is in the customer update.
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]).sort()).toEqual(['internal_notes', 'updated_at']);
    expect(customer).toMatchObject({
      phone: '+19415550100', email: 'owner@example.com',
      service_contact_phone: null, service_contact_email: null, secondary_phone: null,
    });
    const card = fake.tables.triage_items[0];
    expect(card).toMatchObject({ status: 'resolved', resolution_source: 'human', resolution_note: 'contact saved to customer notes', assigned_to: 'tech-1' });
    expect(fake.tables.call_log[0].review_status).toBe('resolved');
  });

  it('keeps existing notes and does not add the line twice on a second click', async () => {
    const fake = fixture({ internalNotes: 'Prefers mornings.' });
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, `/${CARD_ID}/save-contact-note`)).status).toBe(200);
      // Reopen the card (a reprocess or a second tab) and click again.
      Object.assign(fake.tables.triage_items[0], { status: 'open', resolved_at: null });
      const again = await post(baseUrl, `/${CARD_ID}/save-contact-note`);
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ saved: 0, already_present: 1 });
    });
    expect(fake.tables.customers[0].internal_notes).toBe(`Prefers mornings.\n[call 2026-10-07] ${EXPECTED_LINE}`);
  });

  it('409s a card that is already resolved', async () => {
    const fake = fixture();
    fake.tables.triage_items[0].status = 'resolved';
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, `/${CARD_ID}/save-contact-note`)).status).toBe(409);
    });
    expect(fake.tables.customers[0].internal_notes).toBeNull();
  });

  it('404s a missing card and 403s a non-admin', async () => {
    wireDb(db, fixture());
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, '/44444444-4444-4444-8444-444444444444/save-contact-note')).status).toBe(404);
      expect((await post(baseUrl, `/${CARD_ID}/save-contact-note`, {}, { 'x-test-role': 'technician' })).status).toBe(403);
    });
  });

  it('400s a card with another reason code and writes nothing', async () => {
    const fake = fixture({ reason: 'missing_last_name' });
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, `/${CARD_ID}/save-contact-note`)).status).toBe(400);
    });
    expect(fake.tables.customers[0].internal_notes).toBeNull();
    expect(fake.tables.triage_items[0].status).toBe('open');
  });

  it('400s a second-contact card whose contact has a name but no phone or email', async () => {
    const fake = fixture({ payload: { flag: 'secondary_contact_captured', secondary_contact: { name_full: 'Pat Sample', role: 'unknown' } } });
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, `/${CARD_ID}/save-contact-note`)).status).toBe(400);
    });
    expect(fake.tables.customers[0].internal_notes).toBeNull();
  });

  it('409s when the call has no linked customer and leaves the card open', async () => {
    const fake = fixture({ callCustomer: null });
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/save-contact-note`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/no linked customer/);
    });
    expect(fake.tables.triage_items[0].status).toBe('open');
  });

  it('409s when the linked customer is soft-deleted', async () => {
    const fake = fixture();
    fake.tables.customers[0].deleted_at = '2026-10-01T00:00:00.000Z';
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, `/${CARD_ID}/save-contact-note`)).status).toBe(409);
    });
    expect(fake.tables.triage_items[0].status).toBe('open');
  });

  it('writes one line per distinct contact, drops the mirrored duplicate, omits an unknown role, and caps each line at 500 chars', async () => {
    const singleton = { first_name: 'Pat', last_name: 'Sample', phone: '9415550123', email: null, role: 'unknown' };
    const fake = fixture({
      payload: {
        flag: 'secondary_contact_captured',
        secondary_contact: singleton,
        secondary_contacts: [
          { name_full: 'Pat Sample', phone_e164: '+19415550123', role: 'unknown' },
          { name_full: 'Robin Example', email: 'robin@example.com', role: 'tenant', notes: `Line one\nline two ${'x'.repeat(600)}` },
        ],
      },
    });
    wireDb(db, fake);
    await withServer(async (baseUrl) => {
      expect(await (await post(baseUrl, `/${CARD_ID}/save-contact-note`)).json()).toMatchObject({ saved: 2 });
    });
    const lines = fake.tables.customers[0].internal_notes.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[call 2026-10-07] Contact named on call (not a message recipient): Pat Sample · 9415550123.');
    expect(lines[1]).toMatch(/^\[call 2026-10-07\] Contact named on call \(not a message recipient\): Robin Example \(tenant\) · robin@example.com\. Line one line two x+$/);
    expect(lines[1].replace('[call 2026-10-07] ', '').length).toBe(500);
  });

  it('does not log the contact\'s name, phone or email', async () => {
    const logger = require('../services/logger');
    wireDb(db, fixture());
    await withServer(async (baseUrl) => {
      await post(baseUrl, `/${CARD_ID}/save-contact-note`);
    });
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toMatch(/Pat Sample|555|example\.com/);
  });
});
