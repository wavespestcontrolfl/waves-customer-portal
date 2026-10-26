/**
 * "Email the SiteOne order" (GATE_SITEONE_EMAIL_ORDER) against live Postgres:
 * every refusal, the package conversion (300 lb of a 50 lb pack is 6), and the
 * claim -> stamp -> send -> finalize steps that keep a transport failure from
 * ever causing a second email to SiteOne. SendGrid is a mock; nothing is sent.
 * Fixtures are synthetic. The text and the routes: vendor-order-email.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');

maybeDescribe('vendor-order-email (live Postgres)', () => {
  let db;
  let svc;
  let vendor;
  let priorAccount;
  const made = { vendor_order_emails: [], vendor_orders: [], product_restock_requests: [], vendor_pricing: [], products_catalog: [] };
  const ENV = { SITEONE_ORDER_EMAIL: 'orders@siteone.example', SENDGRID_FROM_EMAIL: 'contact@wavespestcontrol.com' };

  const mailer = (impl) => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn(impl || (async () => ({ messageId: 'sg-msg-1' }))) });
  const send = (id, m, extra = {}) => svc.sendOrderEmail(id, { actor: 'Test Admin', actorId: null }, { sendgrid: m, env: ENV, ...extra });
  const preview = (id, env = ENV) => svc.previewOrderEmail(id, { env });
  const reject = async (promise) => promise.then(() => { throw new Error('expected a refusal'); }, (e) => e);

  // A product with an approved SiteOne price row (50 lb pack) and an open request for 300 lb.
  async function fixture({ pricing = {}, request = {}, product = {}, skipPricing = false } = {}) {
    const id = crypto.randomUUID();
    const [prod] = await db('products_catalog').insert({
      id, name: `Fixture Fertilizer ${id.slice(0, 8)}`, category: 'fertilizer', inventory_unit: 'lb', inventory_on_hand: 20, ...product,
    }).returning('*');
    made.products_catalog.push(prod.id);
    if (!skipPricing) {
      const [row] = await db('vendor_pricing').insert({
        product_id: prod.id, vendor_id: vendor.id, price: 24.5, price_amount: 24.5, quantity: '50 lb', vendor_sku: '098604',
        is_active: true, approval_status: 'approved', is_best_price: true, ...pricing,
      }).returning('*');
      made.vendor_pricing.push(row.id);
    }
    const [req] = await db('product_restock_requests').insert({
      id: crypto.randomUUID(), product_id: prod.id, status: 'open', priority: 'normal', requested_quantity: 300, unit: 'lb', source: 'test_fixture', ...request,
    }).returning('*');
    made.product_restock_requests.push(req.id);
    return { product: prod, request: req };
  }
  const emailRow = (requestId) => db('vendor_order_emails').where({ restock_request_id: requestId }).first();
  const requestRow = (requestId) => db('product_restock_requests').where({ id: requestId }).first();

  beforeAll(async () => {
    db = require('../models/db');
    svc = require('../services/procurement/vendor-order-email');
    vendor = await db('vendors').where({ code: 1 }).first();
    if (!vendor) [vendor] = await db('vendors').insert({ name: 'SiteOne', code: 1, type: 'online' }).returning('*');
    priorAccount = vendor.account_number;
    await db('vendors').where({ id: vendor.id }).update({ account_number: '123456', active: true });
  });
  beforeEach(() => { process.env.GATE_SITEONE_EMAIL_ORDER = 'true'; });
  afterEach(async () => {
    delete process.env.GATE_SITEONE_EMAIL_ORDER;
    await db.raw('DROP TRIGGER IF EXISTS fixture_block_stamp ON vendor_order_emails');
  });
  afterAll(async () => {
    await db.raw('DROP FUNCTION IF EXISTS fixture_block_stamp()');
    const requests = made.product_restock_requests;
    if (requests.length) {
      await db('vendor_order_emails').whereIn('restock_request_id', requests).del();
      await db('vendor_orders').whereIn('restock_request_id', requests).del();
      await db('product_restock_requests').whereIn('id', requests).del();
    }
    if (made.vendor_pricing.length) await db('vendor_pricing').whereIn('id', made.vendor_pricing).del();
    if (made.products_catalog.length) await db('products_catalog').whereIn('id', made.products_catalog).del();
    if (vendor) await db('vendors').where({ id: vendor.id }).update({ account_number: priorAccount });
    await db.destroy();
  }, 120000);

  describe('preview', () => {
    test('300 lb of a 50 lb pack is 6 packages; the estimate is before tax and not in the email', async () => {
      const { request } = await fixture();
      const out = await preview(request.id);
      expect(out).toMatchObject({
        requestId: request.id, to: 'orders@siteone.example', packages: 6, itemNumber: '098604', packSize: '50 lb',
        po: `WAVES-${request.id.slice(0, 8).toUpperCase()}`, estimateCents: 14700,
      });
      expect(out.subject).toBe(`Pickup order: Waves Pest Control, account 123456, PO ${out.po}`);
      expect(out.text).toContain(`6 x 098604 ${out.productName} (50 lb)`);
      expect(out.text).toContain('We will pay at pickup.');
      expect(await emailRow(request.id)).toBeUndefined();
    });

    test('packages round up', async () => {
      const { request } = await fixture({ request: { requested_quantity: 301 } });
      expect((await preview(request.id)).packages).toBe(7);
    });

    test('gate off refuses 409 gate_off', async () => {
      const { request } = await fixture();
      delete process.env.GATE_SITEONE_EMAIL_ORDER;
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'gate_off' });
    });

    test.each(['ordered', 'received', 'cancelled'])('a %s request refuses request_not_open', async (status) => {
      const { request } = await fixture({ request: { status } });
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'request_not_open' });
    });

    test('an unknown request is a 404', async () => {
      expect(await reject(preview(crypto.randomUUID()))).toMatchObject({ statusCode: 404, code: 'request_not_found' });
      expect(await reject(preview('not-a-uuid'))).toMatchObject({ statusCode: 404, code: 'request_not_found' });
    });

    test('no SITEONE_ORDER_EMAIL refuses no_recipient', async () => {
      const { request } = await fixture();
      expect(await reject(preview(request.id, {}))).toMatchObject({ statusCode: 409, code: 'no_recipient' });
      expect(await reject(preview(request.id, { SITEONE_ORDER_EMAIL: 'not an address' }))).toMatchObject({ code: 'recipient_invalid' });
    });

    test('no SiteOne price row refuses no_price_row, also for pending, inactive and zero-priced rows', async () => {
      const none = await fixture({ skipPricing: true });
      expect(await reject(preview(none.request.id))).toMatchObject({ statusCode: 409, code: 'no_price_row' });
      for (const pricing of [{ approval_status: 'pending' }, { is_active: false }, { price: 0, price_amount: 0 }]) {
        const { request } = await fixture({ pricing });
        expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'no_price_row' });
      }
    });

    test('a price row without an item number refuses no_vendor_sku', async () => {
      const { request } = await fixture({ pricing: { vendor_sku: '' } });
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'no_vendor_sku' });
    });

    test('a pack the converter cannot read refuses', async () => {
      const { request } = await fixture({ pricing: { quantity: 'case' } });
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'no_pack_size' });
    });

    test('a request with no quantity refuses', async () => {
      const { request } = await fixture({ request: { requested_quantity: null } });
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'no_quantity' });
    });

    test('a bot claim still placing refuses auto_order_placing', async () => {
      const { request } = await fixture();
      const [claim] = await db('vendor_orders').insert({ restock_request_id: request.id, vendor_id: vendor.id, adapter: 'siteone', status: 'placing' }).returning('id');
      made.vendor_orders.push(claim.id);
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'auto_order_placing' });
    });

    test('an automatic order already out for the product refuses auto_order_live', async () => {
      const { request } = await fixture();
      const [claim] = await db('vendor_orders').insert({ restock_request_id: request.id, vendor_id: vendor.id, adapter: 'siteone', status: 'needs_review', placed_at: new Date() }).returning('id');
      made.vendor_orders.push(claim.id);
      expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'auto_order_live' });
    });

    test('a parked bot claim that never submitted does not block the email', async () => {
      const { request } = await fixture();
      const [claim] = await db('vendor_orders').insert({ restock_request_id: request.id, vendor_id: vendor.id, adapter: 'siteone', status: 'failed' }).returning('id');
      made.vendor_orders.push(claim.id);
      expect((await preview(request.id)).packages).toBe(6);
    });

    test('the vendor row without an account number refuses', async () => {
      const { request } = await fixture();
      await db('vendors').where({ id: vendor.id }).update({ account_number: null });
      try {
        expect(await reject(preview(request.id))).toMatchObject({ statusCode: 409, code: 'no_account_number' });
      } finally {
        await db('vendors').where({ id: vendor.id }).update({ account_number: '123456' });
      }
    });
  });

  describe('send', () => {
    test('sends once, marks the request ordered through the Restock path, and never sends again', async () => {
      const { request } = await fixture();
      const m = mailer();
      const out = await send(request.id, m, {});
      expect(out).toMatchObject({ ok: true, messageId: 'sg-msg-1', requestMarked: true, email: { packages: 6, itemNumber: '098604', to: 'orders@siteone.example' } });
      expect(m.sendOne).toHaveBeenCalledTimes(1);
      expect(m.sendOne.mock.calls[0][0]).toMatchObject({
        to: 'orders@siteone.example', fromEmail: 'contact@wavespestcontrol.com', categories: ['vendor-order'],
        subject: `Pickup order: Waves Pest Control, account 123456, PO WAVES-${request.id.slice(0, 8).toUpperCase()}`,
      });
      expect(m.sendOne.mock.calls[0][0].cc).toBeUndefined();

      const row = await emailRow(request.id);
      expect(row).toMatchObject({ status: 'sent', provider_message_id: 'sg-msg-1', sent_by: 'Test Admin', packages: 6, estimate_cents: 14700 });
      expect(row.send_attempted_at).not.toBeNull();
      expect(row.sent_at).not.toBeNull();

      const after = await requestRow(request.id);
      expect(after.status).toBe('ordered');
      expect(after.metadata.emailOrder).toMatchObject({ emailId: row.id, po: row.po, packages: 6, itemNumber: '098604', to: 'orders@siteone.example' });
      expect(after.metadata.lastManualAction).toMatchObject({ action: 'mark_ordered' });

      // a second send, and a preview, both refuse; no second email
      expect(await reject(send(request.id, m, {}))).toMatchObject({ statusCode: 409, code: 'request_not_open' });
      expect(m.sendOne).toHaveBeenCalledTimes(1);
    });

    test('a sent email on a still-open request refuses email_already_sent and never resends', async () => {
      const { request } = await fixture();
      const m = mailer();
      await send(request.id, m, {});
      await db('product_restock_requests').where({ id: request.id }).update({ status: 'open' });
      expect(await reject(send(request.id, m, {}))).toMatchObject({ statusCode: 409, code: 'email_already_sent' });
      expect(await reject(preview(request.id))).toMatchObject({ code: 'email_already_sent' });
      expect(m.sendOne).toHaveBeenCalledTimes(1);
    });

    test('cc goes through when SITEONE_ORDER_CC is set', async () => {
      const { request } = await fixture();
      const m = mailer();
      await send(request.id, m, { env: { ...ENV, SITEONE_ORDER_CC: 'a@siteone.example, b@siteone.example' } });
      expect(m.sendOne.mock.calls[0][0].cc).toEqual(['a@siteone.example', 'b@siteone.example']);
    });

    test('card_on_file without a 4-digit last4 refuses before anything is claimed', async () => {
      const { request } = await fixture();
      const m = mailer();
      const err = await reject(send(request.id, m, { env: { ...ENV, SITEONE_ORDER_PAYMENT: 'card_on_file' } }));
      expect(err).toMatchObject({ statusCode: 409, code: 'card_last4_required' });
      expect(m.sendOne).not.toHaveBeenCalled();
      expect(await emailRow(request.id)).toBeUndefined();
      expect((await requestRow(request.id)).status).toBe('open');
    });

    test('every refusal sends nothing and leaves the request open', async () => {
      const m = mailer();
      const off = await fixture();
      delete process.env.GATE_SITEONE_EMAIL_ORDER;
      expect(await reject(send(off.request.id, m, {}))).toMatchObject({ code: 'gate_off' });
      process.env.GATE_SITEONE_EMAIL_ORDER = 'true';
      const noRecipient = await fixture();
      expect(await reject(send(noRecipient.request.id, m, { env: {} }))).toMatchObject({ code: 'no_recipient' });
      const noPrice = await fixture({ skipPricing: true });
      expect(await reject(send(noPrice.request.id, m, {}))).toMatchObject({ code: 'no_price_row' });
      const ordered = await fixture({ request: { status: 'ordered' } });
      expect(await reject(send(ordered.request.id, m, {}))).toMatchObject({ code: 'request_not_open' });
      const placing = await fixture();
      const [claim] = await db('vendor_orders').insert({ restock_request_id: placing.request.id, vendor_id: vendor.id, adapter: 'siteone', status: 'placing' }).returning('id');
      made.vendor_orders.push(claim.id);
      expect(await reject(send(placing.request.id, m, {}))).toMatchObject({ code: 'auto_order_placing' });
      expect(m.sendOne).not.toHaveBeenCalled();
      for (const r of [off, noRecipient, noPrice, placing]) {
        expect(await emailRow(r.request.id)).toBeUndefined();
        expect((await requestRow(r.request.id)).status).toBe('open');
      }
    });

    test('SendGrid not configured sends nothing and claims nothing', async () => {
      const { request } = await fixture();
      const m = mailer();
      m.isConfigured.mockReturnValue(false);
      expect(await reject(send(request.id, m, {}))).toMatchObject({ statusCode: 409, code: 'not_configured' });
      expect(m.sendOne).not.toHaveBeenCalled();
      expect(await emailRow(request.id)).toBeUndefined();
    });

    test('two clicks at once send one email', async () => {
      const { request } = await fixture();
      const m = mailer(async () => { await new Promise((r) => setTimeout(r, 150)); return { messageId: 'sg-msg-2' }; });
      const results = await Promise.allSettled([send(request.id, m, {}), send(request.id, m, {})]);
      expect(m.sendOne).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect(lost.reason.statusCode).toBe(409);
      expect((await requestRow(request.id)).status).toBe('ordered');
    });
  });

  describe('claim semantics', () => {
    test('a failure recording the attempt sends nothing and leaves the request open and retryable', async () => {
      const { request } = await fixture();
      await db.raw(`CREATE OR REPLACE FUNCTION fixture_block_stamp() RETURNS trigger AS $$
        BEGIN IF NEW.send_attempted_at IS NOT NULL THEN RAISE EXCEPTION 'fixture: stamp blocked'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await db.raw('CREATE TRIGGER fixture_block_stamp BEFORE UPDATE ON vendor_order_emails FOR EACH ROW EXECUTE FUNCTION fixture_block_stamp()');
      const m = mailer();
      expect(await reject(send(request.id, m, {}))).toMatchObject({ code: 'send_attempt_unrecorded' });
      expect(m.sendOne).not.toHaveBeenCalled();
      expect((await requestRow(request.id)).status).toBe('open');
      expect(await emailRow(request.id)).toMatchObject({ status: 'failed', send_attempted_at: null });

      await db.raw('DROP TRIGGER fixture_block_stamp ON vendor_order_emails');
      expect(await send(request.id, m, {})).toMatchObject({ ok: true });
      expect(m.sendOne).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['HTTP 503', () => Object.assign(new Error('SendGrid 503: unavailable'), { status: 503 })],
      ['a network error', () => new Error('fetch failed')],
      ['a timeout', () => Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })],
    ])('an ambiguous failure after the stamp (%s) stays sending, the request stays open, and nothing resends', async (_label, makeError) => {
      const { request } = await fixture();
      const m = mailer(async () => { throw makeError(); });
      expect(await reject(send(request.id, m, {}))).toMatchObject({ statusCode: 502, code: 'send_unconfirmed' });
      const row = await emailRow(request.id);
      expect(row.status).toBe('sending');
      expect(row.send_attempted_at).not.toBeNull();
      expect((await requestRow(request.id)).status).toBe('open');

      // a later click, even a day later, is refused before any send; only a person can clear it
      const again = mailer();
      expect(await reject(send(request.id, again, { now: Date.now() + 24 * 3600 * 1000 }))).toMatchObject({ statusCode: 409, code: 'email_sending' });
      expect(await reject(preview(request.id))).toMatchObject({ code: 'email_sending' });
      expect(again.sendOne).not.toHaveBeenCalled();
      expect(m.sendOne).toHaveBeenCalledTimes(1);

      // a person checks SendGrid, finds nothing went out, and dismisses the row: now a retry is allowed
      await db('vendor_order_emails').where({ restock_request_id: request.id }).update({ status: 'dismissed' });
      expect(await send(request.id, again, {})).toMatchObject({ ok: true });
      expect(again.sendOne).toHaveBeenCalledTimes(1);
    });

    test('a definite rejection (HTTP 4xx) reopens the row for a retry', async () => {
      const { request } = await fixture();
      const bad = mailer(async () => { throw Object.assign(new Error('SendGrid 400: bad sender'), { status: 400 }); });
      expect(await reject(send(request.id, bad, {}))).toMatchObject({ statusCode: 502, code: 'rejected' });
      expect(await emailRow(request.id)).toMatchObject({ status: 'failed', send_attempted_at: null });
      expect((await requestRow(request.id)).status).toBe('open');
      const good = mailer();
      expect(await send(request.id, good, {})).toMatchObject({ ok: true });
      expect(good.sendOne).toHaveBeenCalledTimes(1);
      expect(await emailRow(request.id)).toMatchObject({ status: 'sent' });
    });

    test('a claim that crashed before the stamp is taken over once stale, never while fresh', async () => {
      const { request } = await fixture();
      const out = await preview(request.id);
      const base = {
        restock_request_id: request.id, vendor_id: vendor.id, recipient: 'orders@siteone.example', subject: out.subject, text_body: out.text,
        html: out.html, status: 'sending', claim_token: 'old-token', po: out.po, packages: 6, item_number: '098604', send_attempted_at: null,
      };
      await db('vendor_order_emails').insert({ ...base, claimed_at: new Date() });
      const m = mailer();
      expect(await reject(send(request.id, m, {}))).toMatchObject({ code: 'email_sending' });
      expect(m.sendOne).not.toHaveBeenCalled();
      await db('vendor_order_emails').where({ restock_request_id: request.id }).update({ claimed_at: new Date(Date.now() - 3600 * 1000) });
      expect(await send(request.id, m, {})).toMatchObject({ ok: true });
      expect(m.sendOne).toHaveBeenCalledTimes(1);
    });

    test('a request that cannot be marked ordered after the send still reports the send and never resends', async () => {
      const { request } = await fixture();
      const m = mailer(async () => {
        // the request is closed by someone else while the email is in flight
        await db('product_restock_requests').where({ id: request.id }).update({ status: 'cancelled' });
        return { messageId: 'sg-msg-3' };
      });
      const out = await send(request.id, m, {});
      expect(out).toMatchObject({ ok: true, messageId: 'sg-msg-3', requestMarked: false });
      expect(await emailRow(request.id)).toMatchObject({ status: 'sent' });
      expect(m.sendOne).toHaveBeenCalledTimes(1);
    });
  });
});
