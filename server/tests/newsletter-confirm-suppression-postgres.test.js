/**
 * B13 on real PostgreSQL: the veto SQL (Gmail-spelling suppression coverage,
 * global-vs-group scoping, any-profile do-not-contact) that the mocked-db
 * suite cannot prove. Runs inside a transaction against TEMP tables that
 * shadow the real ones, so it needs no schema knowledge and leaves nothing.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('newsletter confirmation vetoes on PostgreSQL (B13)', () => {
  let db;
  let assertConfirmationAllowed;

  beforeAll(() => {
    db = require('../models/db');
    ({ assertConfirmationAllowed } = require('../services/newsletter-confirm'));
  });
  afterAll(async () => { await db.destroy(); });

  // Runs fn(trx) against fresh temp tables, always rolled back.
  async function withTables(setup, fn) {
    const rollback = new Error('rollback');
    try {
      await db.transaction(async (trx) => {
        await trx.raw(`CREATE TEMP TABLE email_suppressions (id serial, email text, status text, suppression_type text, group_key text) ON COMMIT DROP`);
        await trx.raw(`CREATE TEMP TABLE customers (id text, email text, service_contact_email text, service_contact2_email text, service_contact3_email text, billing_email text) ON COMMIT DROP`);
        await trx.raw(`CREATE TEMP TABLE call_log (id serial, customer_id text, ai_extraction_enriched jsonb) ON COMMIT DROP`);
        await setup(trx);
        await fn(trx);
        throw rollback;
      });
    } catch (e) { if (e !== rollback) throw e; }
  }
  const sup = (trx, row) => trx('email_suppressions').insert({ status: 'active', group_key: null, ...row });
  const sub = (over = {}) => ({ id: 's1', email: 'pat@example.com', customer_id: null, ...over });

  test('no rows: allowed', async () => {
    await withTables(async () => {}, async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).resolves.toBeUndefined();
    });
  });

  test.each(['do_not_email', 'bounce', 'spam_complaint'])('active %s (any group) blocks, any casing of the address', async (type) => {
    await withTables((trx) => sup(trx, { email: 'PAT@example.com', suppression_type: type, group_key: 'service_operational' }), async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).rejects.toMatchObject({ reason: 'address_suppressed' });
    });
  });

  test('an ungrouped suppression blocks', async () => {
    await withTables((trx) => sup(trx, { email: 'pat@example.com', suppression_type: 'unsubscribe' }), async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).rejects.toMatchObject({ reason: 'address_suppressed' });
    });
  });

  test('a newsletter-group unsubscribe does NOT block a deliberate re-signup confirmation', async () => {
    await withTables((trx) => sup(trx, { email: 'pat@example.com', suppression_type: 'unsubscribe', group_key: 'marketing_newsletter' }), async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).resolves.toBeUndefined();
    });
  });

  test('a lifted (non-active) suppression does not block', async () => {
    await withTables((trx) => sup(trx, { email: 'pat@example.com', suppression_type: 'do_not_email', status: 'lifted' }), async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).resolves.toBeUndefined();
    });
  });

  test('another mailbox is unaffected', async () => {
    await withTables((trx) => sup(trx, { email: 'someone.else@example.com', suppression_type: 'do_not_email' }), async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).resolves.toBeUndefined();
    });
  });

  test('a suppression on another spelling of the same Gmail inbox blocks', async () => {
    await withTables((trx) => sup(trx, { email: 'john.doe@gmail.com', suppression_type: 'do_not_email' }), async (trx) => {
      await expect(assertConfirmationAllowed(sub({ email: 'johndoe+news@gmail.com' }), trx)).rejects.toMatchObject({ reason: 'address_suppressed' });
    });
  });

  test('do-not-contact on the linked customer blocks', async () => {
    await withTables((trx) => trx('call_log').insert({ customer_id: 'c1', ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }) }), async (trx) => {
      await expect(assertConfirmationAllowed(sub({ customer_id: 'c1' }), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });

  test('do-not-contact on an unlinked profile carrying the mailbox (billing_email / Gmail spelling) blocks', async () => {
    await withTables(async (trx) => {
      await trx('customers').insert([
        { id: 'c2', billing_email: 'Pat@Example.com' },
        { id: 'c3', email: 'a.b@gmail.com' },
      ]);
      await trx('call_log').insert([
        { customer_id: 'c2', ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }) },
      ]);
    }, async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
    await withTables(async (trx) => {
      await trx('customers').insert({ id: 'c3', email: 'a.b@gmail.com' });
      await trx('call_log').insert({ customer_id: 'c3', ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }) });
    }, async (trx) => {
      await expect(assertConfirmationAllowed(sub({ email: 'ab+x@gmail.com' }), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });

  test('a profile without a do-not-contact request, or a request on someone else, allows', async () => {
    await withTables(async (trx) => {
      await trx('customers').insert([{ id: 'c4', email: 'pat@example.com' }, { id: 'c5', email: 'other@example.com' }]);
      await trx('call_log').insert({ customer_id: 'c5', ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }) });
    }, async (trx) => {
      await expect(assertConfirmationAllowed(sub(), trx)).resolves.toBeUndefined();
    });
  });
});
