/**
 * Real PostgreSQL proof for the read-only termite annual-plan document
 * projection. Uses an isolated schema in the dedicated synthetic QA database;
 * no migrations, extensions, production rows, or durable writes outside that
 * schema.
 *
 * ANNUAL_PLAN_DOCUMENT_TEST_DATABASE_URL=postgresql://... \
 *   npx jest --runInBand server/tests/annual-plan-documents-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('node:crypto');

const TEST_URL = process.env.ANNUAL_PLAN_DOCUMENT_TEST_DATABASE_URL;
const postgres = TEST_URL ? describe : describe.skip;

jest.setTimeout(30000);

async function scratchDatabase() {
  const schema = `annual_doc_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({
    client: 'pg',
    connection: TEST_URL,
    searchPath: [schema],
    pool: { min: 0, max: 3 },
  });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE customers (
    id uuid PRIMARY KEY,
    address_line1 text, address_line2 text, city text, state text, zip text
  )`);
  await db.raw(`CREATE TABLE customer_properties (
    id uuid PRIMARY KEY, customer_id uuid NOT NULL,
    address_line1 text, address_line2 text, city text, state text, zip text
  )`);
  await db.raw(`CREATE TABLE estimates (
    id uuid PRIMARY KEY, customer_id uuid, property_id uuid, address text
  )`);
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY, status text, paid_at timestamptz,
    stripe_payment_intent_id text, stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY, status text, refund_status text,
    stripe_payment_intent_id text, stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY, customer_id uuid NOT NULL,
    source_estimate_id uuid, prepay_invoice_id uuid,
    term_start date NOT NULL, term_end date NOT NULL,
    prepay_amount numeric(10,2), status text NOT NULL,
    renewal_decision text, annual_plan_version text,
    renewed_from_term_id uuid, installation_anchored_at timestamptz,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  )`);
  return {
    db,
    async destroy() {
      await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await db.destroy();
    },
  };
}

postgres('annual plan document reader (real PostgreSQL)', () => {
  let fixture;
  let db;
  let Documents;

  beforeAll(async () => {
    fixture = await scratchDatabase();
    db = fixture.db;
    jest.resetModules();
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    Documents = require('../services/annual-plan-documents');
  });

  afterAll(async () => {
    jest.resetModules();
    if (fixture) await fixture.destroy();
  });

  const insert = async (table, row) => (await db(table).insert(row).returning('*'))[0];

  test('ownership and eligibility filters hold while provisional and ambiguous labels stay conservative', async () => {
    const customerA = randomUUID();
    const customerB = randomUUID();
    await db('customers').insert([
      { id: customerA, address_line1: '1 Synthetic Home', city: 'Bradenton', state: 'FL', zip: '34202' },
      { id: customerB, address_line1: '2 Synthetic Home', city: 'Sarasota', state: 'FL', zip: '34236' },
    ]);

    const propertyA = await insert('customer_properties', {
      id: randomUUID(), customer_id: customerA, address_line1: '10 Duplicate Way', city: 'Bradenton', state: 'FL', zip: '34202',
    });
    const estimateA = await insert('estimates', {
      id: randomUUID(), customer_id: customerA, property_id: propertyA.id,
      address: '10 Duplicate Way, Bradenton, FL 34202',
    });
    const estimateInstall = await insert('estimates', {
      id: randomUUID(), customer_id: customerA, address: '20 Pending Place, Parrish, FL 34219',
    });
    const estimateB = await insert('estimates', {
      id: randomUUID(), customer_id: customerB, address: '30 Other Owner Road, Sarasota, FL 34236',
    });

    const paidInvoice = await insert('invoices', {
      id: randomUUID(), status: 'paid', paid_at: new Date('2026-01-02T15:00:00Z'),
      stripe_payment_intent_id: 'pi_paid_synthetic',
    });
    const refundedInvoice = await insert('invoices', {
      id: randomUUID(), status: 'paid', paid_at: new Date('2026-01-02T15:00:00Z'),
      stripe_payment_intent_id: 'pi_refunded_synthetic',
    });
    await insert('payments', {
      id: randomUUID(), status: 'refunded', refund_status: 'full',
      stripe_payment_intent_id: 'pi_refunded_synthetic',
    });

    const base = {
      customer_id: customerA,
      term_start: '2026-10-26',
      term_end: '2027-10-25',
      prepay_amount: 450,
      status: 'active',
      annual_plan_version: 'v3',
      installation_anchored_at: new Date('2026-10-25T14:00:00Z'),
    };
    const duplicateA = await insert('annual_prepay_terms', { id: randomUUID(), ...base, source_estimate_id: estimateA.id });
    const duplicateB = await insert('annual_prepay_terms', { id: randomUUID(), ...base, source_estimate_id: estimateA.id });
    const missingLabel = await insert('annual_prepay_terms', { id: randomUUID(), ...base, source_estimate_id: null, prepay_amount: 475 });
    const awaiting = await insert('annual_prepay_terms', {
      id: randomUUID(), ...base, source_estimate_id: estimateInstall.id,
      term_start: '2024-01-01', term_end: '2025-01-01', prepay_amount: 399,
      status: 'payment_pending', renewal_decision: 'cancel', installation_anchored_at: null,
    });
    const declinedPaid = await insert('annual_prepay_terms', {
      id: randomUUID(), ...base, source_estimate_id: estimateA.id,
      prepay_invoice_id: paidInvoice.id, status: 'cancelled', renewal_decision: 'cancel', prepay_amount: 525,
    });
    const refunded = await insert('annual_prepay_terms', {
      id: randomUUID(), ...base, source_estimate_id: estimateA.id,
      prepay_invoice_id: refundedInvoice.id, status: 'cancelled', renewal_decision: 'cancel',
    });
    const terminal = await insert('annual_prepay_terms', {
      id: randomUUID(), ...base, source_estimate_id: estimateA.id, status: 'cancelled', renewal_decision: null,
    });
    const nonTermite = await insert('annual_prepay_terms', {
      id: randomUUID(), ...base, source_estimate_id: estimateA.id, annual_plan_version: null,
    });
    const foreign = await insert('annual_prepay_terms', {
      id: randomUUID(), ...base, customer_id: customerB, source_estimate_id: estimateB.id,
    });

    const documents = await Documents.listAnnualPlanDocumentsForCustomer(customerA, { conn: db, today: '2026-10-25' });
    const ids = new Set(documents.map((document) => document.id));
    const docId = (term) => `annual_plan_${term.id}`;
    expect(ids).toEqual(new Set([
      docId(duplicateA), docId(duplicateB), docId(missingLabel), docId(awaiting), docId(declinedPaid),
    ]));
    expect(ids.has(docId(refunded))).toBe(false);
    expect(ids.has(docId(terminal))).toBe(false);
    expect(ids.has(docId(nonTermite))).toBe(false);
    expect(ids.has(docId(foreign))).toBe(false);

    // The duplicate tied address + identical real end date cannot identify
    // either plan, and a profile fallback cannot identify one plan among
    // several. Neither leaks a misleading property label.
    expect(documents.find((d) => d.id === docId(duplicateA)).facts.propertyLabel).toBeNull();
    expect(documents.find((d) => d.id === docId(duplicateB)).facts.propertyLabel).toBeNull();
    expect(documents.find((d) => d.id === docId(missingLabel)).facts.propertyLabel).toBeNull();

    const provisional = documents.find((d) => d.id === docId(awaiting));
    expect(provisional.facts).toMatchObject({
      currentPlanAmount: 399, currentTermEnds: null, awaitsInstallation: true, declined: true, unpaid: true,
    });
    expect(provisional.fileName).toBe('Annual_Plan_Renewal_current.pdf');
    expect(documents.find((d) => d.id === docId(declinedPaid)).facts).toMatchObject({ declined: true, unpaid: false });

    const publicKeys = ['createdAt', 'description', 'documentType', 'downloadUrl', 'facts', 'fileName', 'id', 'isAutoGenerated', 'shareable', 'title', 'uploadedBy'];
    for (const document of documents) {
      expect(Object.keys(document).sort()).toEqual(publicKeys);
      expect(document).not.toHaveProperty('termId');
      expect(document).not.toHaveProperty('customerId');
      expect(document).not.toHaveProperty('canDecline');
      expect(document.facts).not.toHaveProperty('canDecline');
    }

    await expect(Documents.getAnnualPlanDocumentForCustomer(customerA, docId(foreign), { conn: db, today: '2026-10-25' })).resolves.toBeNull();
    await expect(Documents.getAnnualPlanDocumentForCustomer(customerB, docId(foreign), { conn: db, today: '2026-10-25' }))
      .resolves.toMatchObject({ id: docId(foreign), facts: { propertyLabel: '30 Other Owner Road, Sarasota, FL 34236' } });
  });
});
