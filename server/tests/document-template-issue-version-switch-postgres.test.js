/**
 * Issuing a document template while its active version switches (Codex
 * #5463 P1 on 20260930213000_residential_agreements_rate_review_sentence).
 *
 * Both issuers — the admin issue route (POST /:key/contracts) and the bulk
 * guide send — resolve active_version_id with an UNLOCKED read, render, and
 * only then open the transaction that inserts the contract snapshot. A
 * publish, the version editor, or a content migration can commit between
 * those two steps. Until this fix only the termite branch of the issue
 * route re-locked the template row and re-checked the pointer, so a
 * residential agreement started during the rate-review rollout could be
 * inserted and sent as the OLD version — after the rollout, without the
 * disclosure. Now every key takes `lockActiveVersionForIssue` under the
 * same template-row lock the writers take, and refuses (409) when the
 * pointer or status moved.
 *
 * The first block is pure (always runs). The second drives the REAL route
 * handler and the REAL bulk insert against PostgreSQL in a scratch schema
 * (same harness and local-only safety as the sibling migration test,
 * residential-agreements-rate-review-migration.test.js):
 *   REPAIR_TEST_DATABASE_URL=postgresql://<local-owner>@localhost:5432/waves_test \
 *     npx jest --maxWorkers=2 tests/document-template-issue-version-switch-postgres.test.js
 */
const fs = require('fs');
const path = require('path');
const knexLib = require('knex');
const { randomUUID } = require('crypto');

let mockScratchDb = null;
// The issue route and the bulk-send service read the module-level `db`
// (`require('../models/db')`), which this process has no DATABASE_URL for:
// every call on it is routed to the scratch knex of the current test.
jest.mock('../models/db', () => new Proxy(function scratchDbProxy() {}, {
  apply: (_target, _thisArg, args) => mockScratchDb(...args),
  get: (_target, prop) => {
    const value = mockScratchDb[prop];
    return typeof value === 'function' ? value.bind(mockScratchDb) : value;
  },
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
// Delivery is outside this test (and would load the email/SMS graph).
jest.mock('../services/document-contract-delivery', () => ({ deliverDocumentRequestChannels: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const library = require('../models/migrations/20260601000009_document_template_library');
const lawnSeed = require('../models/migrations/20260623000006_seed_lawn_ornamental_agreement');
const migration = require('../models/migrations/20260930213000_residential_agreements_rate_review_sentence');
const { lockActiveVersionForIssue } = require('../services/document-template-library');
const { _internals: { createDocumentRequestForCustomer } } = require('../services/document-template-bulk-send');
const router = require('../routes/admin-document-templates');

const issueHandler = router.stack
  .find((layer) => layer.route?.path === '/:key/contracts' && layer.route.methods.post)
  .route.stack[0].handle;

const LAWN_KEY = 'service_agreement.lawn_ornamental';
const PEST_KEY = 'service_agreement.residential_pest';
const STALE_MESSAGE = 'Document template changed while issuing — reload and try again.';
const SENTENCE = migration.RATE_REVIEW_SENTENCE;

function fakeTrx(row) {
  const calls = [];
  const trx = (table) => {
    const query = {
      where(cond) { calls.push({ table, where: cond }); return query; },
      forUpdate() { calls.push({ table, forUpdate: true }); return query; },
      first: async (...columns) => { calls.push({ table, first: columns }); return row; },
    };
    return query;
  };
  trx.calls = calls;
  return trx;
}

describe('lockActiveVersionForIssue (pure)', () => {
  const loaded = { template: { id: 'tpl-1' }, activeVersion: { id: 'v1' } };

  test('locks the template row FOR UPDATE and passes when the active version and status still match', async () => {
    const trx = fakeTrx({ active_version_id: 'v1', status: 'active' });
    await expect(lockActiveVersionForIssue(trx, loaded)).resolves.toEqual({ active_version_id: 'v1', status: 'active' });
    expect(trx.calls).toEqual([
      { table: 'document_templates', where: { id: 'tpl-1' } },
      { table: 'document_templates', forUpdate: true },
      { table: 'document_templates', first: ['active_version_id', 'status'] },
    ]);
  });

  test.each([
    ['the pointer moved to another version', { active_version_id: 'v2', status: 'active' }],
    ['the template was paused', { active_version_id: 'v1', status: 'paused' }],
    ['the template row is gone', null],
  ])('refuses with a 409 when %s', async (_label, live) => {
    await expect(lockActiveVersionForIssue(fakeTrx(live), loaded)).rejects.toMatchObject({
      status: 409,
      code: 'DOCUMENT_TEMPLATE_CHANGED',
      message: STALE_MESSAGE,
    });
  });

  test('both issuers take the lock inside their transaction, before the contract insert, for every template key', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-document-templates.js'), 'utf8');
    const bulk = fs.readFileSync(path.join(__dirname, '..', 'services', 'document-template-bulk-send.js'), 'utf8');
    const CALL = 'await lockActiveVersionForIssue(trx, loaded);';
    const INSERT = "await trx('customer_contracts').insert(";

    const issueRoute = route.slice(route.indexOf("router.post('/:key/contracts'"));
    const routeLockAt = issueRoute.indexOf(CALL);
    expect(routeLockAt).toBeGreaterThan(issueRoute.indexOf('db.transaction(async (trx) =>'));
    expect(routeLockAt).toBeLessThan(issueRoute.indexOf(INSERT));
    expect(issueRoute.indexOf(CALL, routeLockAt + 1)).toBe(-1);
    // Outside the termite-only branch: after the program-agreement pre-locks
    // close and before the program-agreement supersession block reopens.
    const firstProgramBranch = issueRoute.indexOf('if (isProgramAgreement) {');
    const secondProgramBranch = issueRoute.indexOf('if (isProgramAgreement) {', firstProgramBranch + 1);
    expect(firstProgramBranch).toBeGreaterThan(-1);
    expect(secondProgramBranch).toBeGreaterThan(firstProgramBranch);
    expect(routeLockAt).toBeGreaterThan(firstProgramBranch);
    expect(routeLockAt).toBeLessThan(secondProgramBranch);

    const bulkLockAt = bulk.indexOf(CALL);
    expect(bulkLockAt).toBeGreaterThan(bulk.indexOf('await assertNoRecentBulkContract(trx, {'));
    expect(bulkLockAt).toBeLessThan(bulk.indexOf(INSERT));
    expect(bulk.indexOf(CALL, bulkLockAt + 1)).toBe(-1);
  });
});

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `issue_switch_${randomUUID().replace(/-/g, '')}`;
  // Pool: the holder transaction, the route's own transaction, the route's
  // unlocked pre-reads, and the lock-wait poll all need a connection at once.
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // The library tables as 20260601000009 creates them (minus the technicians
  // FKs), the customer columns the issue route reads, and the contract /
  // event / payment-method columns it writes or joins.
  await db.raw(`
    CREATE TABLE document_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key varchar(120) NOT NULL UNIQUE,
      name varchar(180) NOT NULL,
      category varchar(80) NOT NULL DEFAULT 'general',
      document_type varchar(80) NOT NULL DEFAULT 'other',
      status varchar(30) NOT NULL DEFAULT 'active',
      description text,
      requires_signature boolean NOT NULL DEFAULT true,
      audience varchar(60) NOT NULL DEFAULT 'customer',
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      active_version_id uuid,
      expire_after_days integer NOT NULL DEFAULT 14,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE document_template_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      title varchar(220) NOT NULL,
      body text NOT NULL,
      signer_disclosure text,
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by uuid,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id, version_number)
    );
    CREATE TABLE customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name text, last_name text, company_name text, email text, phone text,
      address_line1 text, address_line2 text, city text, state text, zip text,
      waveguard_tier text,
      active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE payment_methods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      method_type text, card_brand text, last_four text, bank_name text, bank_last_four text
    );
    CREATE TABLE customer_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL,
      created_by uuid,
      payment_method_id uuid,
      contract_type varchar(60) NOT NULL,
      title text,
      status varchar(30) NOT NULL,
      recipient_name text, recipient_email text, recipient_phone text, service_name text,
      esign_disclosure_snapshot text,
      contract_text_snapshot text,
      share_token_hash text, share_token_expires_at timestamptz, shared_at timestamptz,
      document_template_id uuid REFERENCES document_templates(id) ON DELETE SET NULL,
      document_template_version_id uuid REFERENCES document_template_versions(id) ON DELETE SET NULL,
      document_template_key varchar(120),
      requires_signature_snapshot boolean,
      document_variables_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      document_render_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      cancelled_at timestamptz, cancelled_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE customer_contract_events (
      id serial PRIMARY KEY,
      contract_id uuid NOT NULL,
      customer_id uuid NOT NULL,
      event_type varchar(60) NOT NULL,
      actor_type varchar(30), actor_id uuid, ip text, user_agent text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

const CONTEXT_VALUES = { service: { name: 'Lawn program' }, agreement: { start_date: '2026-10-01' } };

async function seedCustomer(db) {
  const [row] = await db('customers').insert({
    first_name: 'Stan', last_name: 'Sample', email: 'stan@example.com', phone: '9415550000',
    address_line1: '123 Perimeter Way', city: 'Bradenton', state: 'FL', zip: '34202',
  }).returning('*');
  return row;
}

async function versionsFor(db, key) {
  const template = await db('document_templates').where({ template_key: key }).first('id');
  return db('document_template_versions').where({ template_id: template.id }).orderBy('version_number', 'asc');
}

// The admin issue route, invoked as express would (fake req/res); resolves
// with the status + JSON body it answered, rejects if it fell through to next().
function invokeIssue(key, body) {
  const req = { params: { key }, body, technicianId: null, ip: '127.0.0.1', get: () => 'jest' };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    issueHandler(req, res, (err) => reject(err || new Error('next() called without an error')));
  });
}

async function countRows(db, table) {
  return Number((await db(table).count('* as n').first()).n);
}

// Polls until the in-flight issuer has either PARKED on a lock (a backend of
// this database waiting on a lock inside a query on the template or contract
// table) or INSERTED a contract. `onTemplateRead` tells WHERE it parked: on
// the revalidating `... from "document_templates" ... for update` read (the
// fix), or only on its insert's FK check of the held template row (the
// pre-fix route, which then inserts the stale render once the holder
// commits).
async function waitForIssuer(db) {
  let inserted = 0;
  for (let i = 0; i < 400; i++) {
    const { rows } = await db.raw(`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND (query ILIKE '%"document_templates"%' OR query ILIKE '%"customer_contracts"%')`);
    inserted = await countRows(db, 'customer_contracts');
    if (rows.length || inserted) {
      return {
        parked: rows.length > 0,
        onTemplateRead: rows.some((row) => /from "document_templates".*for update/is.test(row.query)),
        inserted,
      };
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return { parked: false, onTemplateRead: false, inserted };
}

jest.setTimeout(30000);

describeOrSkip('issuing while the active version switches — real Postgres', () => {
  let fixture; let db; let customer;
  beforeEach(async () => {
    fixture = await createScratchDb();
    db = fixture.db;
    mockScratchDb = db;
    await library.up(db); // residential_pest scaffold (+ wdo notice, bed bug prep)
    await lawnSeed.up(db);
    customer = await seedCustomer(db);
  });
  afterEach(async () => {
    mockScratchDb = null;
    if (fixture) await fixture.destroy();
  });

  test.each([LAWN_KEY, PEST_KEY])(
    '%s: an issue that loaded v1 and then waited behind the rollout is refused (409) and writes nothing; the reissue renders v2',
    async (key) => {
      const [v1] = await versionsFor(db, key);
      expect(v1.body).not.toContain(SENTENCE);

      // The rollout holds the template row FOR UPDATE (exactly how the
      // migration starts) while an admin starts issuing from the same key.
      const rollout = await db.transaction();
      let pending; let parked;
      try {
        await rollout('document_templates').where({ template_key: key }).forUpdate().first('id');
        pending = invokeIssue(key, { customerId: customer.id, values: CONTEXT_VALUES });
        // The request has read v1 (unlocked), rendered it, entered its
        // transaction and is parked — nothing inserted while the rollout is
        // in flight.
        parked = await waitForIssuer(db);
        expect(parked.inserted).toBe(0);
        // The rollout activates v2 and commits — the parked request wakes
        // holding a v1 render it must not insert.
        await migration.up(rollout);
        await rollout.commit();
      } catch (err) {
        await rollout.rollback();
        throw err;
      }

      // Pre-fix: 201 — the v1 snapshot was inserted and sent AFTER the
      // rollout, without the disclosure (the P1).
      const refused = await pending;
      expect(refused).toEqual({ status: 409, body: { error: STALE_MESSAGE } });
      expect(await countRows(db, 'customer_contracts')).toBe(0);
      expect(await countRows(db, 'customer_contract_events')).toBe(0);
      // Mechanism: it waited on the revalidating template-row read, not
      // merely on its insert's FK check of the held row.
      expect(parked).toEqual({ parked: true, onTemplateRead: true, inserted: 0 });

      // The operator reloads and reissues: the snapshot is the NEW version.
      const [, v2] = await versionsFor(db, key);
      expect(v2.body).toContain(SENTENCE);
      const reissued = await invokeIssue(key, { customerId: customer.id, values: CONTEXT_VALUES });
      expect(reissued.status).toBe(201);
      expect(reissued.body.contract.documentTemplateVersionId).toBe(v2.id);
      expect(reissued.body.contract.contractTextSnapshot).toContain(SENTENCE);
      expect(reissued.body.rendered.body).toContain(SENTENCE);
      const [stored] = await db('customer_contracts');
      expect(stored.document_template_version_id).toBe(v2.id);
      expect(stored.contract_text_snapshot).toContain(SENTENCE);
      expect(stored.status).toBe('sent');
    },
  );

  test('the wait alone never refuses: a holder that commits without moving the pointer lets the issue land on the version it rendered', async () => {
    const [v1] = await versionsFor(db, LAWN_KEY);
    const holder = await db.transaction();
    let pending;
    try {
      await holder('document_templates').where({ template_key: LAWN_KEY }).forUpdate().first('id');
      pending = invokeIssue(LAWN_KEY, { customerId: customer.id, values: CONTEXT_VALUES });
      expect(await waitForIssuer(db)).toEqual({ parked: true, onTemplateRead: true, inserted: 0 });
      await holder.commit();
    } catch (err) {
      await holder.rollback();
      throw err;
    }
    const issued = await pending;
    expect(issued.status).toBe(201);
    expect(issued.body.contract.documentTemplateVersionId).toBe(v1.id);
    expect(issued.body.contract.contractTextSnapshot).not.toContain(SENTENCE);
    expect(await countRows(db, 'customer_contracts')).toBe(1);
    expect(await db('customer_contract_events').orderBy('id').pluck('event_type')).toEqual(['created_from_document_template', 'share_link_created']);
  });

  test('bulk send: a campaign that resolved the template before the rollout is refused per customer once the pointer moved, and writes nothing', async () => {
    const template = await db('document_templates').where({ template_key: LAWN_KEY }).first();
    const [v1] = await versionsFor(db, LAWN_KEY);
    // What sendBulkDocument resolves ONCE, before its audience loop.
    const loaded = { template, activeVersion: v1 };
    const args = {
      loaded,
      customer,
      productGuide: { appendix: '', productCount: 0, serviceGroups: [] },
      options: { values: CONTEXT_VALUES, allowUnresolved: false, skipRecentDays: 0, guideType: 'all', channel: 'email' },
      req: { technicianId: null, ip: '127.0.0.1', get: () => 'jest' },
      campaignId: 'bulk-doc-test',
    };

    // The rollout lands mid-campaign.
    await migration.up(db);
    const [, v2] = await versionsFor(db, LAWN_KEY);
    expect((await db('document_templates').where({ id: template.id }).first()).active_version_id).toBe(v2.id);

    await expect(createDocumentRequestForCustomer(args)).rejects.toMatchObject({ status: 409, code: 'DOCUMENT_TEMPLATE_CHANGED', message: STALE_MESSAGE });
    expect(await countRows(db, 'customer_contracts')).toBe(0);
    expect(await countRows(db, 'customer_contract_events')).toBe(0);

    // A campaign started after the rollout snapshots v2.
    const fresh = await createDocumentRequestForCustomer({ ...args, loaded: { template, activeVersion: v2 } });
    expect(fresh.document_template_version_id).toBe(v2.id);
    expect(fresh.contract_text_snapshot).toContain(SENTENCE);
    expect(fresh.status).toBe('draft');
    expect(await countRows(db, 'customer_contracts')).toBe(1);
  });
});
