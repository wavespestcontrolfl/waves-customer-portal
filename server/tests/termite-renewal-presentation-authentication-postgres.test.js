// Termite renewal grace lapse treats a provider-backed charge as presentation,
// but an off-session authentication challenge is still payment in motion until
// the exact PaymentIntent cancellation is recorded. Exercise the production
// SQL predicate against PostgreSQL so the scan and per-term check cannot drift.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `termite_auth_present_${randomUUID().replaceAll('-', '')}`;

jest.setTimeout(20000);

postgres('termite renewal presentation authentication fence (PostgreSQL)', () => {
  let admin;
  let app;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await app.schema.createTable('stripe_invoice_charge_attempts', (table) => {
      table.uuid('id').primary();
      table.uuid('invoice_id').notNullable();
      table.string('status').notNullable();
      table.string('stripe_payment_intent_id');
      table.string('decline_code');
      table.string('authentication_canceled_intent_id');
      table.timestamp('stripe_payment_intent_bound_at');
      table.string('worker_payment_intent_id');
      table.timestamp('submitted_at');
      table.timestamp('resolved_at');
    });
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('an unresolved authentication_required PI is not presentation; exact cancellation restores ordinary PI evidence', async () => {
    const invoiceId = randomUUID();
    const unresolvedId = randomUUID();
    const ordinaryProviderFailureId = randomUUID();
    const legacyNullDeclineId = randomUUID();
    const submittedOnlyId = randomUUID();
    const unresolvedIntentId = `pi_${unresolvedId.replaceAll('-', '')}`;

    await app('stripe_invoice_charge_attempts').insert([
      {
        id: unresolvedId,
        invoice_id: invoiceId,
        status: 'failed',
        decline_code: 'authentication_required',
        stripe_payment_intent_id: unresolvedIntentId,
        worker_payment_intent_id: unresolvedIntentId,
        stripe_payment_intent_bound_at: new Date(),
        submitted_at: new Date(),
        resolved_at: new Date(),
      },
      {
        id: ordinaryProviderFailureId,
        invoice_id: invoiceId,
        status: 'failed',
        decline_code: 'card_declined',
        stripe_payment_intent_id: `pi_${ordinaryProviderFailureId.replaceAll('-', '')}`,
        submitted_at: new Date(),
        resolved_at: new Date(),
      },
      {
        // Historical saved-card failures can have a bound provider PI but no
        // decline_code. They remain ordinary presentation evidence; SQL NULL
        // must not be mistaken for authentication_required.
        id: legacyNullDeclineId,
        invoice_id: invoiceId,
        status: 'failed',
        decline_code: null,
        stripe_payment_intent_id: `pi_${legacyNullDeclineId.replaceAll('-', '')}`,
        submitted_at: new Date(),
        resolved_at: new Date(),
      },
      {
        id: submittedOnlyId,
        invoice_id: invoiceId,
        status: 'ambiguous',
        submitted_at: new Date(),
      },
    ]);

    const { whereAttemptPresented } = require('../services/termite-annual-renewal-charge')._private;
    const presentedIds = async () => whereAttemptPresented(
      app('stripe_invoice_charge_attempts as a').where('a.invoice_id', invoiceId),
    ).orderBy('a.id').pluck('a.id');

    const ordinaryEvidence = [ordinaryProviderFailureId, legacyNullDeclineId].sort();
    await expect(presentedIds()).resolves.toEqual(ordinaryEvidence);

    await app('stripe_invoice_charge_attempts').where({ id: unresolvedId }).update({
      authentication_canceled_intent_id: 'pi_different_authentication',
    });
    await expect(presentedIds()).resolves.toEqual(ordinaryEvidence);

    await app('stripe_invoice_charge_attempts').where({ id: unresolvedId }).update({
      authentication_canceled_intent_id: unresolvedIntentId,
    });
    await expect(presentedIds()).resolves.toEqual(
      [ordinaryProviderFailureId, legacyNullDeclineId, unresolvedId].sort(),
    );
  });
});
