/**
 * Owner ruling 2026-09-30 (the chokepoint rule): the DIRECT invoice sender
 * (InvoiceService.sendViaSMS / sendViaSMSAndEmail) checks the live collections
 * dispute hold DEFAULT-ON. A self-pay invoice whose customer has an active dispute
 * hold - or whose hold cannot be verified (fail closed) - is refused with the coded,
 * retryable COLLECTION_HOLD_DEFER before any claim, credit draw or provider contact.
 * Payer-billed is exempt; only operator-initiated and customer-initiated callers
 * pass holdExempt.
 *
 * Real Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's
 * REPAIR_TEST_DATABASE_URL; skipped without either). Synthetic names only; the
 * provider boundary is a recording stub.
 */
const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;

jest.mock('../models/db', () => require('knex')({
  client: 'pg', connection: process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 4 },
}));
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/messaging/send-window', () => ({
  ...jest.requireActual('../services/messaging/send-window'),
  isWithinSendWindowET: jest.fn(() => true),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
// The branded-email leg needs a configured provider; the template send below is a recording stub.
jest.mock('../services/sendgrid-mail', () => ({ ...jest.requireActual('../services/sendgrid-mail'), isConfigured: jest.fn(() => true) }));

const { randomUUID } = require('crypto');

const run = connection ? describe : describe.skip;
const DISPUTE_REASON = 'dispute on call: synthetic billing question';

run('the direct invoice sender checks the dispute hold default-on (postgres)', () => {
  let db;
  let Invoices;
  let Hold;
  let sendCustomerMessage;
  const customers = [];

  async function newCustomer() {
    const [row] = await db('customers').insert({ first_name: 'Synthetic', last_name: 'Directsend', phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` }).returning('id');
    customers.push(row.id);
    return row.id;
  }
  async function newInvoice(customerId, patch = {}) {
    const [row] = await db('invoices').insert({
      token: randomUUID().replace(/-/g, '').slice(0, 24), invoice_number: `DS-${randomUUID().slice(0, 8)}`,
      customer_id: customerId, status: 'draft', total: 100, subtotal: 100, ...patch,
    }).returning('id');
    return row.id;
  }
  const invoice = (id) => db('invoices').where({ id }).first();
  const placeHold = async (customerId, reason = DISPUTE_REASON) => (await db('collections_flags')
    .insert({ customer_id: customerId, flag: 'collection_hold', reason, created_by: 'test' }).returning('id'))[0].id;
  const release = (id) => db('collections_flags').where({ id }).update({ released_at: db.fn.now() });
  const expectRefusal = (result) => expect(result).toMatchObject({
    code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true, deliveryOutcome: 'not_sent',
  });
  // The refusal happens before any claim or provider contact.
  const untouched = async (id) => {
    expect(await invoice(id)).toMatchObject({ status: 'draft', send_claim_token: null, sent_at: null, sms_sent_at: null });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  };

  beforeAll(() => {
    db = require('../models/db');
    Invoices = require('../services/invoice');
    Hold = require('../services/collections/collection-hold');
    ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
  });
  beforeEach(() => {
    jest.clearAllMocks();
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', channel: 'sms', providerMessageId: 'SM1', channelResults: { sms: { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1' } } });
  });
  afterAll(async () => {
    if (customers.length) {
      // The exempt sends write their own audit trail; the customers FK needs it gone first.
      await db('activity_log').whereIn('customer_id', customers).del().catch(() => {});
      await db('sms_log').whereIn('customer_id', customers).del();
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('invoices').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  test('an automated caller is refused during a hold: sendViaSMSAndEmail and sendViaSMS, retryable, nothing claimed or sent', async () => {
    const c = await newCustomer();
    await placeHold(c);
    const inv = await newInvoice(c);
    const wrapper = await Invoices.sendViaSMSAndEmail(inv);
    expect(wrapper).toMatchObject({ ok: false, sms: { ok: false, code: 'COLLECTION_HOLD_DEFER' }, email: { ok: false, code: 'COLLECTION_HOLD_DEFER' } });
    expectRefusal(wrapper);
    const direct = await Invoices.sendViaSMS(inv, {});
    expect(direct).toMatchObject({ sent: false, blocked: true });
    expectRefusal(direct);
    await untouched(inv);
  });

  test('a lookup failure refuses the same way (fail closed, retryable)', async () => {
    const c = await newCustomer();
    const inv = await newInvoice(c);
    const lookup = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockResolvedValue({ held: true, reason: 'lookup_failed', error: new Error('db down') });
    try {
      expectRefusal(await Invoices.sendViaSMSAndEmail(inv));
      expectRefusal(await Invoices.sendViaSMS(inv, {}));
    } finally { lookup.mockRestore(); }
    await untouched(inv);
  });

  test.each(['operator', 'customer'])('holdExempt %s still sends during a hold', async (who) => {
    const c = await newCustomer();
    await placeHold(c);
    const inv = await newInvoice(c);
    const out = await Invoices.sendViaSMS(inv, { operatorInitiated: who === 'operator', holdExempt: who });
    expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('the wrapper honors holdExempt too (operator and customer)', async () => {
    for (const who of ['operator', 'customer']) {
      const c = await newCustomer();
      await placeHold(c);
      const inv = await newInvoice(c);
      const out = await Invoices.sendViaSMSAndEmail(inv, { operatorInitiated: who === 'operator', holdExempt: who });
      expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
    }
  });

  test('a payer-billed invoice is exempt from the hold check (never a hold refusal)', async () => {
    const c = await newCustomer();
    await placeHold(c);
    const [{ id: payerId }] = await db('payers').insert({ display_name: 'Synthetic Payer' }).returning('id');
    try {
      const inv = await newInvoice(c, { payer_id: payerId });
      const wrapper = await Invoices.sendViaSMSAndEmail(inv).catch((err) => ({ threw: err }));
      expect(wrapper.code).not.toBe('COLLECTION_HOLD_DEFER');
      const direct = await Invoices.sendViaSMS(inv, {}).catch((err) => ({ threw: err }));
      expect(direct.code).not.toBe('COLLECTION_HOLD_DEFER');
    } finally {
      await db('invoices').where({ customer_id: c }).del();
      await db('payers').where({ id: payerId }).del();
    }
  });

  test('after the release the same automated call sends; a non-dispute hold never refused it', async () => {
    const c = await newCustomer();
    const holdId = await placeHold(c);
    const inv = await newInvoice(c);
    expectRefusal(await Invoices.sendViaSMS(inv, {}));
    await release(holdId);
    const out = await Invoices.sendViaSMS(inv, {});
    expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
    expect(sendCustomerMessage).toHaveBeenCalled();
    const other = await newCustomer();
    await placeHold(other, 'wrong-number report on billing follow-up call; wrong_number flag write failed');
    const inv2 = await newInvoice(other);
    expect((await Invoices.sendViaSMS(inv2, {})).code).not.toBe('COLLECTION_HOLD_DEFER');
  });

  describe('a hold that lands AFTER the up-front check is caught at the provider boundary', () => {
    // First lookup (the sender's up-front check) answers "clear"; every later one (the boundary
    // re-read on the locked handle) answers "held" - the dispute lands during claiming/preparation.
    // The real sendCustomerMessage runs the invoice's provider-handoff hook (the locked boundary
    // check) around the provider request; mimic that contract: a blocked handoff maps to a blocked
    // outcome and the provider is never reached.
    let providerReached;
    beforeEach(() => {
      providerReached = jest.fn();
      sendCustomerMessage.mockImplementation(async (input) => {
        const outcome = await input.withProviderHandoff(async () => {
          providerReached();
          return { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1', channel: 'sms' };
        });
        if (outcome.blocked) {
          return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: outcome.code, reason: outcome.error || outcome.reason,
            ...(outcome.retryable ? { retryable: true } : {}), ...(outcome.deferred ? { deferred: true } : {}),
            ...(outcome.nextAllowedAt ? { nextAllowedAt: outcome.nextAllowedAt } : {}) };
        }
        return { sent: true, deliveryOutcome: 'accepted', channel: 'sms', providerMessageId: 'SM1',
          channelResults: { sms: { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1' } } };
      });
    });
    const raceHold = () => {
      const real = Hold.dueInvoiceHeldByDisputeHold;
      return jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold')
        .mockImplementationOnce(real)
        .mockImplementation(async () => ({ held: true, reason: 'hold' }));
    };

    test('sendViaSMS: nothing goes to the provider; the claim is given back; the refusal is the retryable hold', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const spy = raceHold();
      let out;
      try { out = await Invoices.sendViaSMS(inv, {}).catch((err) => ({ threw: err })); } finally { spy.mockRestore(); }
      const refusal = out.threw || out;
      expect(refusal.code).toBe('COLLECTION_HOLD_DEFER');
      expect(refusal.deferred).toBe(true);
      expect(providerReached).not.toHaveBeenCalled();
      const row = await invoice(inv);
      expect(row.send_claim_token).toBeNull();
      expect(row.sent_at).toBeNull();
      // a hold deferral always leaves the invoice SCHEDULED (never a draft nothing sends after the release)
      expect(row.status).toBe('scheduled');
      expect(row.scheduled_send_at).not.toBeNull();
    });

    test('sendViaSMSAndEmail: same - no provider contact, claim released, retryable', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const spy = raceHold();
      let out;
      try { out = await Invoices.sendViaSMSAndEmail(inv).catch((err) => ({ threw: err })); } finally { spy.mockRestore(); }
      expect(providerReached).not.toHaveBeenCalled();
      // the AGGREGATE result carries the hold (callers read result.code, not the legs)
      expect(out).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true, deliveryOutcome: 'not_sent' });
      const row = await invoice(inv);
      expect(row.send_claim_token).toBeNull();
      expect(row.status).toBe('scheduled');
    });

    test('the scheduled worker path (allowClaimed): the boundary defers it without spending an attempt', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000) });
      const real = Hold.dueInvoiceHeldByDisputeHold;
      // let the due query + the worker's own delivery-boundary check clear; the sender's boundary re-read holds
      let calls = 0;
      const spy = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockImplementation(async (...args) => {
        calls += 1;
        return calls <= 1 ? real(...args) : { held: true, reason: 'hold' };
      });
      try { await Invoices.processScheduledSends(); } finally { spy.mockRestore(); }
      expect(providerReached).not.toHaveBeenCalled();
      const row = await invoice(inv);
      expect(row.status).toBe('scheduled');
      expect(row.scheduled_send_attempts || 0).toBe(0);
      expect(row.send_claim_token).toBeNull();
    });

    test('the separate branded invoice EMAIL leg re-reads the hold at its own provider boundary (retryable, never terminal)', async () => {
      const InvoiceEmail = require('../services/invoice-email');
      const c = await newCustomer();
      await db('customers').where({ id: c }).update({ email: `${c}@example.invalid` });
      const token = randomUUID();
      const inv = await newInvoice(c, { status: 'sending', send_claim_token: token });
      // The real template send runs the invoice's provider-handoff hook around the provider request.
      const emailReached = jest.fn();
      const templates = jest.spyOn(require('../services/email-template-library'), 'sendTemplate').mockImplementation(async (opts) => {
        const verdict = await opts.withProviderHandoff(async () => { emailReached(); });
        return verdict.ok ? { sent: true, message: { provider_message_id: 'm1' } } : { sent: false, blocked: true, reason: verdict.reason };
      });
      // the dispute lands while the email is prepared: the boundary lookup answers "held"
      const spy = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockResolvedValue({ held: true, reason: 'hold' });
      let out;
      try { out = await InvoiceEmail.sendInvoiceEmail(inv, { claimToken: token }); } finally { spy.mockRestore(); }
      expect(emailReached).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: false, code: 'COLLECTION_HOLD_DEFER', retryable: true, deliveryOutcome: 'not_sent' });
      // exemptions and payer-billed skip it (the lookup is never consulted for them)
      const skipped = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockResolvedValue({ held: true, reason: 'hold' });
      try {
        const exempt = await InvoiceEmail.sendInvoiceEmail(inv, { claimToken: token, holdExempt: 'operator' });
        expect(exempt.code).not.toBe('COLLECTION_HOLD_DEFER');
        expect(emailReached).toHaveBeenCalledTimes(1);
      } finally { skipped.mockRestore(); templates.mockRestore(); }
    });

    test('a hold that lands before the branded EMAIL leg defers the scheduled invoice WITHOUT spending an attempt (Text cannot deliver)', async () => {
      const c = await newCustomer();
      // no phone: the Text leg cannot deliver; only the branded email leg is left
      await db('customers').where({ id: c }).update({ phone: '', email: `${c}@example.invalid` });
      const inv = await newInvoice(c, { status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000), scheduled_send_attempts: 4 });
      const emailReached = jest.fn();
      const templates = jest.spyOn(require('../services/email-template-library'), 'sendTemplate').mockImplementation(async (opts) => {
        const verdict = await opts.withProviderHandoff(async () => { emailReached(); });
        return verdict.ok ? { sent: true, message: { provider_message_id: 'm1' } } : { sent: false, blocked: true, reason: verdict.reason };
      });
      const real = Hold.dueInvoiceHeldByDisputeHold;
      let calls = 0;
      const spy = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockImplementation(async (...args) => {
        calls += 1;
        return calls <= 1 ? real(...args) : { held: true, reason: 'hold' };
      });
      try { await Invoices.processScheduledSends(); } finally { spy.mockRestore(); templates.mockRestore(); }
      expect(emailReached).not.toHaveBeenCalled();
      const row = await invoice(inv);
      // the LAST allowed attempt (4 spent, cap 5) was not burned: still 4, still queued, claim released, pushed out
      expect(row).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 4, send_claim_token: null });
      expect(row.scheduled_send_at.getTime()).toBeGreaterThan(Date.now());
    });

    test('an operator/customer exemption is not stopped at the boundary either', async () => {
      const c = await newCustomer();
      const inv = await newInvoice(c);
      const spy = jest.spyOn(Hold, 'dueInvoiceHeldByDisputeHold').mockImplementation(async () => ({ held: true, reason: 'hold' }));
      try {
        const out = await Invoices.sendViaSMS(inv, { operatorInitiated: true, holdExempt: 'operator' });
        expect(out.code).not.toBe('COLLECTION_HOLD_DEFER');
      } finally { spy.mockRestore(); }
      expect(providerReached).toHaveBeenCalled();
    });
  });

  test('a pre-claimed send (the worker) is not re-checked by the sender - processScheduledSends owns that check', async () => {
    const c = await newCustomer();
    await placeHold(c);
    const inv = await newInvoice(c, { status: 'sending', send_claim_token: randomUUID(), scheduled_send_at: new Date() });
    const row = await invoice(inv);
    const out = await Invoices.sendViaSMS(inv, { allowClaimed: true, claimToken: row.send_claim_token }).catch((err) => ({ threw: err }));
    expect(out?.code).not.toBe('COLLECTION_HOLD_DEFER');
  });
});
