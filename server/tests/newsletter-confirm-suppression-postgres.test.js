/**
 * B13 on real PostgreSQL: the veto SQL (Gmail-spelling suppression coverage,
 * global-vs-group scoping, any-owner do-not-contact) against the REAL schema.
 *
 * Every case runs in a transaction that is always rolled back, on the real
 * tables (no temp copies): a column that does not exist (the original bug
 * queried customers.billing_email, which lives on notification_prefs) fails
 * here with 42703 instead of being masked by a hand-made table.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('newsletter confirmation vetoes on PostgreSQL (B13)', () => {
  let db;
  let assertConfirmationAllowed;
  let n = 0;

  beforeAll(() => {
    db = require('../models/db');
    ({ assertConfirmationAllowed } = require('../services/newsletter-confirm'));
  });
  afterAll(async () => { await db.destroy(); });

  const uniq = () => `b13-${Date.now()}-${++n}`;

  async function inRolledBackTx(fn) {
    const rollback = new Error('rollback');
    try {
      await db.transaction(async (trx) => { await fn(trx); throw rollback; });
    } catch (e) { if (e !== rollback) throw e; }
  }
  const sup = (trx, row) => trx('email_suppressions').insert({ status: 'active', group_key: null, ...row });
  async function customer(trx, fields = {}) {
    const [row] = await trx('customers').insert({ first_name: 'Test', phone: `+1555${String(Math.random()).slice(2, 9)}`, ...fields }).returning('id');
    return row.id || row;
  }
  const dncCall = (trx, customerId) => trx('call_log').insert({
    customer_id: customerId,
    ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }),
  });
  const sub = (email, over = {}) => ({ id: 's1', email, customer_id: null, ...over });
  const addr = (local = uniq(), domain = 'example.com') => `${local}@${domain}`;

  test('no matching rows: allowed', async () => {
    await inRolledBackTx(async (trx) => {
      await expect(assertConfirmationAllowed(sub(addr()), trx)).resolves.toBeUndefined();
    });
  });

  test.each(['do_not_email', 'bounce', 'spam_complaint'])('active %s (any group) blocks, any casing of the address', async (type) => {
    await inRolledBackTx(async (trx) => {
      const local = uniq();
      await sup(trx, { email: `${local.toUpperCase()}@example.com`, suppression_type: type, group_key: 'service_operational' });
      await expect(assertConfirmationAllowed(sub(addr(local)), trx)).rejects.toMatchObject({ reason: 'address_suppressed' });
    });
  });

  test('an ungrouped suppression blocks', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      await sup(trx, { email, suppression_type: 'unsubscribe' });
      await expect(assertConfirmationAllowed(sub(email), trx)).rejects.toMatchObject({ reason: 'address_suppressed' });
    });
  });

  test('a newsletter-group unsubscribe does NOT block a deliberate re-signup confirmation', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      await sup(trx, { email, suppression_type: 'unsubscribe', group_key: 'marketing_newsletter' });
      await expect(assertConfirmationAllowed(sub(email), trx)).resolves.toBeUndefined();
    });
  });

  test('a lifted suppression, or one on another mailbox, does not block', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      await sup(trx, { email, suppression_type: 'do_not_email', status: 'lifted' });
      await sup(trx, { email: addr(), suppression_type: 'do_not_email' });
      await expect(assertConfirmationAllowed(sub(email), trx)).resolves.toBeUndefined();
    });
  });

  test('a suppression on another spelling of the same Gmail inbox blocks', async () => {
    await inRolledBackTx(async (trx) => {
      const box = uniq().replace(/-/g, '');
      await sup(trx, { email: `${box.slice(0, 3)}.${box.slice(3)}@gmail.com`, suppression_type: 'do_not_email' });
      await expect(assertConfirmationAllowed(sub(`${box}+news@gmail.com`), trx)).rejects.toMatchObject({ reason: 'address_suppressed' });
    });
  });

  test('do-not-contact on the linked customer blocks', async () => {
    await inRolledBackTx(async (trx) => {
      const id = await customer(trx);
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(addr(), { customer_id: id }), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });

  test.each(['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email'])(
    'do-not-contact on an UNLINKED customer whose %s carries the mailbox blocks (trimmed, any casing)',
    async (column) => {
      await inRolledBackTx(async (trx) => {
        const email = addr();
        const id = await customer(trx, { [column]: `  ${email.toUpperCase()} ` });
        await dncCall(trx, id);
        await expect(assertConfirmationAllowed(sub(email), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
      });
    },
  );

  test('do-not-contact on a customer whose notification_prefs.billing_email carries the mailbox blocks (real-schema path)', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      const id = await customer(trx);
      await trx('notification_prefs').insert({ customer_id: id, billing_email: ` ${email.toUpperCase()}` });
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(email), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });

  test('a Gmail-spelling match on a customers column or billing_email blocks', async () => {
    await inRolledBackTx(async (trx) => {
      const box = uniq().replace(/-/g, '');
      const id = await customer(trx, { email: `${box.slice(0, 3)}.${box.slice(3)}@gmail.com` });
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(`${box}+x@gmail.com`), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
    await inRolledBackTx(async (trx) => {
      const box = uniq().replace(/-/g, '');
      const id = await customer(trx);
      await trx('notification_prefs').insert({ customer_id: id, billing_email: `${box}@googlemail.com` });
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(`${box.slice(0, 2)}.${box.slice(2)}@gmail.com`), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });


  test('a LEGACY-only do-not-contact record (ai_extraction text, no V2 enriched blob) blocks', async () => {
    await inRolledBackTx(async (trx) => {
      const id = await customer(trx);
      await trx('call_log').insert({ customer_id: id, v2_extraction_status: 'failed', ai_extraction: JSON.stringify({ consent: {}, do_not_contact_request: true }) });
      await expect(assertConfirmationAllowed(sub(addr(), { customer_id: id }), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
    await inRolledBackTx(async (trx) => {
      const id = await customer(trx);
      await trx('call_log').insert({ customer_id: id, ai_extraction: '{"do_not_contact_request" :  true}' });
      await expect(assertConfirmationAllowed(sub(addr(), { customer_id: id }), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });

  test('a legacy record that says false, or no extraction at all, does not block', async () => {
    await inRolledBackTx(async (trx) => {
      const id = await customer(trx);
      await trx('call_log').insert([
        { customer_id: id, ai_extraction: JSON.stringify({ do_not_contact_request: false }) },
        { customer_id: id },
      ]);
      await expect(assertConfirmationAllowed(sub(addr(), { customer_id: id }), trx)).resolves.toBeUndefined();
    });
  });

  test('do-not-contact on a customer linked through a LEAD email or an ESTIMATE customer_email blocks (real schema)', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      const id = await customer(trx);
      await trx('leads').insert({ first_name: 'Test', email: ` ${email.toUpperCase()}`, customer_id: id });
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(email), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
    await inRolledBackTx(async (trx) => {
      const email = addr();
      const id = await customer(trx);
      await trx('estimates').insert({ customer_id: id, customer_email: email });
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(email), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
    // Gmail spelling through a lead
    await inRolledBackTx(async (trx) => {
      const box = uniq().replace(/-/g, '');
      const id = await customer(trx);
      await trx('leads').insert({ first_name: 'Test', email: `${box.slice(0, 3)}.${box.slice(3)}@gmail.com`, customer_id: id });
      await dncCall(trx, id);
      await expect(assertConfirmationAllowed(sub(`${box}+x@gmail.com`), trx)).rejects.toMatchObject({ reason: 'do_not_contact' });
    });
  });

  test('a lead or estimate with NO customer link, or a linked one without a request, does not block', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      await trx('leads').insert({ first_name: 'Test', email });
      const id = await customer(trx);
      await trx('estimates').insert({ customer_id: id, customer_email: email });
      await expect(assertConfirmationAllowed(sub(email), trx)).resolves.toBeUndefined();
    });
  });

  test('owners without a do-not-contact request, or a request on someone else, allow', async () => {
    await inRolledBackTx(async (trx) => {
      const email = addr();
      await customer(trx, { email });
      const other = await customer(trx, { email: addr() });
      await dncCall(trx, other);
      await expect(assertConfirmationAllowed(sub(email), trx)).resolves.toBeUndefined();
    });
  });

  test('refuses outside a transaction (advisory locks would fence nothing)', async () => {
    await expect(assertConfirmationAllowed(sub(addr()), db)).rejects.toMatchObject({ reason: 'veto_unverifiable' });
  });

  // A concurrent ownership writer holds the shared ownership lock (what the
  // assignment trigger takes) on its own connection until `release()`.
  async function withOwnershipWriter(email, fn) {
    const key = `email-ownership:customer-email:${email}`;
    const rollback = new Error('rollback');
    let release;
    const held = new Promise((r) => { release = r; });
    let ready;
    const isHeld = new Promise((r) => { ready = r; });
    const writer = db.transaction(async (w) => {
      await w.raw('SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))', [key]);
      ready();
      await held;
      throw rollback;
    }).catch((e) => { if (e !== rollback) throw e; });
    await isHeld;
    try { await fn(release); } finally { release(); await writer; }
  }

  test('a writer that outlasts the bounded wait refuses the send (busy) and lock_timeout is restored', async () => {
    const email = addr();
    await withOwnershipWriter(email, async () => {
      await inRolledBackTx(async (trx) => {
        const before = (await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout;
        const started = Date.now();
        await expect(assertConfirmationAllowed(sub(email), trx, { ownershipWaitMs: 300 })).rejects.toMatchObject({ reason: 'ownership_busy' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        // The savepoint rolled back with the timeout: the caller's transaction is still usable.
        expect((await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout).toBe(before);
        await expect(trx.raw('SELECT 1 AS ok')).resolves.toBeTruthy();
      });
    });
  });

  test('a writer that finishes within the wait just delays the send (no refusal)', async () => {
    const email = addr();
    await withOwnershipWriter(email, async (release) => {
      await inRolledBackTx(async (trx) => {
        setTimeout(release, 300);
        const started = Date.now();
        await expect(assertConfirmationAllowed(sub(email), trx, { ownershipWaitMs: 5000 })).resolves.toBeUndefined();
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        expect((await trx.raw('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
      });
    });
  });
});
