const { assembleEmailReplyContext, LIMITS } = require('../services/email/email-reply-context');

const MAILBOX = 'contact@wavespestcontrol.com';
const CUSTOMER = {
  id: 'customer-1', first_name: 'Casey', last_name: 'Example', email: 'customer@example.test',
  active: true, deleted_at: null, updated_at: '2026-09-01T12:00:00Z',
};
const EMAIL = {
  id: 'email-current', gmail_thread_id: 'thread-1', from_address: CUSTOMER.email,
  to_address: `Waves <${MAILBOX}>`, subject: 'Service question', body_text: 'Can you confirm my visit?',
  label_ids: ['INBOX'], received_at: '2026-09-10T16:00:00Z', customer_id: CUSTOMER.id,
  authentication_results: 'mx.google.com; dkim=pass header.d=example.test',
};

function queryFor(rows) {
  let result = rows.slice();
  let columns = null;
  const query = {
    where(arg, operator, value) {
      if (typeof arg === 'object') {
        result = result.filter((row) => Object.entries(arg).every(([key, expected]) => row[key] === expected));
      } else if (operator === '<=') {
        result = result.filter((row) => new Date(row[arg]) <= new Date(value));
      }
      return query;
    },
    whereNull(column) { result = result.filter((row) => row[column] == null); return query; },
    whereRaw(sql, bindings = []) {
      if (/LOWER\(TRIM\(email\)\)/.test(sql)) {
        result = result.filter((row) => String(row.email || '').trim().toLowerCase() === bindings[0]);
      }
      if (/COALESCE\(label_ids/.test(sql)) {
        result = result.filter((row) => !(row.label_ids || []).includes('DRAFT'));
      }
      if (/customer_id IS NULL/.test(sql)) {
        result = result.filter((row) => row.customer_id == null || String(row.customer_id) === String(bindings[0]));
      }
      if (/LOWER\(TRIM\(from_address\)\)/.test(sql)) {
        const [sender, mailboxPattern, mailbox, senderPattern] = bindings;
        const includes = (value, pattern) => String(value || '').toLowerCase().includes(String(pattern).replaceAll('%', ''));
        result = result.filter((row) => (
          String(row.from_address || '').toLowerCase() === sender && includes(row.to_address, mailboxPattern)
        ) || (
          String(row.from_address || '').toLowerCase() === mailbox && includes(row.to_address, senderPattern)
        ));
      }
      return query;
    },
    orderBy(column, direction = 'asc') {
      result.sort((a, b) => {
        const order = new Date(a[column]) - new Date(b[column]);
        return direction === 'desc' ? -order : order;
      });
      return query;
    },
    limit(limit) { result = result.slice(0, limit); return query; },
    select(...selected) { columns = selected.length === 1 && selected[0] === '*' ? null : selected; return query; },
    then(resolve, reject) {
      const shaped = columns ? result.map((row) => Object.fromEntries(columns.map((key) => [key, row[key]]))) : result;
      return Promise.resolve(shaped).then(resolve, reject);
    },
  };
  return query;
}

function fakeDatabase({ customers = [CUSTOMER], properties = [{ id: 'property-1', customer_id: CUSTOMER.id, active: true }], emails = [EMAIL], failEmails = false } = {}) {
  return jest.fn((table) => {
    if (table === 'customers') return queryFor(customers);
    if (table === 'customer_properties') return queryFor(properties);
    if (table === 'emails') {
      if (failEmails) throw new Error('thread unavailable');
      return queryFor(emails);
    }
    throw new Error(`unexpected table ${table}`);
  });
}

function aggregatorContext(overrides = {}) {
  return {
    known: true,
    customer: {
      billingLane: {
        resolvedMode: 'monthly_membership', mode: 'monthly_membership', explicit: true, monthlyBilled: true,
        label: 'Monthly membership authority', monthlyDues: { base: 98, surcharge: 2.84, total: 100.84, surcharged: true, basis: 'credit_card_surcharge' },
      },
    },
    billing: {
      unavailable: false, outstandingBalance: 75,
      openInvoice: { title: 'Quarterly service', status: 'sent', amountDue: 75, dueDate: '2026-09-15' },
      payerBilledInvoice: true,
      recentPayments: [{ amount: 50, status: 'paid', payment_date: '2026-09-01T14:00:00Z', processor_secret: 'omit-me' }],
      cardOnFile: { last4: '1234' },
    },
    upcomingServices: [{ type: 'Pest control', date: '2026-09-15', window: '9–11 AM', status: 'confirmed', tech: 'Technician' }],
    lastService: { type: 'Pest control', date: '2026-08-15', notes: 'Gate code 4545. WHAT WE DID.' },
    pendingEstimate: { status: 'sent', tier: 'Silver', monthlyTotal: 999, sentAt: '2026-09-02T14:00:00Z' },
    smsHistory: [], recentCalls: [], sourceHealth: { recentCalls: 'ok' },
    ...overrides,
  };
}

describe('assembleEmailReplyContext', () => {
  test.each([
    ['shared address', [CUSTOMER, { ...CUSTOMER, id: 'customer-2' }], null, 'identity_ambiguous'],
    ['deleted customer', [{ ...CUSTOMER, deleted_at: '2026-09-01T00:00:00Z' }], null, 'identity_unavailable'],
    ['inactive customer', [{ ...CUSTOMER, active: false }], null, 'identity_unavailable'],
    ['conflicting linked id', [CUSTOMER], { ...EMAIL, customer_id: 'customer-2' }, 'identity_conflict'],
  ])('fails closed for %s before aggregation', async (name, customers, emailOverride, reason) => {
    const aggregator = { getContextForCustomer: jest.fn() };
    const result = await assembleEmailReplyContext(emailOverride || EMAIL, {
      database: fakeDatabase({ customers }), aggregator, mailboxAddress: MAILBOX,
    });
    expect(result).toMatchObject({ ok: false, reason });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('rejects non-mailbox inbound and historical replay before customer reads', async () => {
    const database = fakeDatabase();
    const aggregator = { getContextForCustomer: jest.fn() };
    await expect(assembleEmailReplyContext({ ...EMAIL, to_address: 'elsewhere@example.test' }, {
      database, aggregator, mailboxAddress: MAILBOX,
    })).resolves.toMatchObject({ ok: false, reason: 'not_inbound' });
    await expect(assembleEmailReplyContext(EMAIL, {
      database, aggregator, mailboxAddress: MAILBOX, mode: 'replay',
    })).resolves.toMatchObject({ ok: false, reason: 'historical_context_unavailable' });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test.each([
    null,
    'mx.google.com; dkim=fail header.d=example.test',
    'mx.google.com; dkim=pass header.d=attacker.test',
  ])('rejects unverified sender auth before reads: %p', async (authenticationResults) => {
    const database = fakeDatabase();
    const aggregator = { getContextForCustomer: jest.fn() };
    const result = await assembleEmailReplyContext({ ...EMAIL, authentication_results: authenticationResults }, {
      database, aggregator, mailboxAddress: MAILBOX,
    });
    expect(result).toMatchObject({ ok: false, reason: 'sender_auth_unverified' });
    expect(database).not.toHaveBeenCalled();
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('ignores archived duplicates when exactly one live customer matches', async () => {
    const aggregator = { getContextForCustomer: jest.fn(async () => aggregatorContext()) };
    const result = await assembleEmailReplyContext(EMAIL, {
      database: fakeDatabase({ customers: [CUSTOMER, { ...CUSTOMER, id: 'archived', active: false, deleted_at: '2026-09-01T00:00:00Z' }] }),
      aggregator, mailboxAddress: MAILBOX,
    });
    expect(result).toMatchObject({ ok: true, identity: { customerId: CUSTOMER.id } });
    expect(aggregator.getContextForCustomer).toHaveBeenCalledTimes(1);
  });

  test('refuses a missing or oversized triggering body before any lookup', async () => {
    const database = fakeDatabase();
    const aggregator = { getContextForCustomer: jest.fn() };
    const options = { database, aggregator, mailboxAddress: MAILBOX };
    await expect(assembleEmailReplyContext({ ...EMAIL, body_text: null, body_html: null, snippet: 'partial' }, options))
      .resolves.toMatchObject({ ok: false, reason: 'inbound_body_unavailable' });
    await expect(assembleEmailReplyContext({ ...EMAIL, body_text: 'x'.repeat(2401) }, options))
      .resolves.toMatchObject({ ok: false, reason: 'inbound_too_large' });
    await expect(assembleEmailReplyContext({ ...EMAIL, body_text: 'On Tue, someone wrote:\n> old question' }, options))
      .resolves.toMatchObject({ ok: false, reason: 'inbound_body_unavailable' });
    expect(database).not.toHaveBeenCalled();
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('withholds context when active property ownership is ambiguous', async () => {
    const aggregator = { getContextForCustomer: jest.fn() };
    const result = await assembleEmailReplyContext(EMAIL, {
      database: fakeDatabase({ properties: [
        { id: 'property-1', customer_id: CUSTOMER.id, active: true },
        { id: 'property-2', customer_id: CUSTOMER.id, active: true },
      ] }),
      aggregator,
      mailboxAddress: MAILBOX,
    });
    expect(result).toMatchObject({ ok: false, reason: 'property_ambiguous' });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('uses HTML-only bodies without flattening quoted history', async () => {
    const htmlEmail = { ...EMAIL, body_text: null, body_html: '<p>Can you confirm the date?</p><blockquote>Old quoted text</blockquote>' };
    const result = await assembleEmailReplyContext(htmlEmail, {
      database: fakeDatabase({ emails: [htmlEmail] }),
      aggregator: { getContextForCustomer: jest.fn(async () => aggregatorContext()) },
      mailboxAddress: MAILBOX,
    });
    expect(result.factsBlock).toContain('Can you confirm the date?');
    expect(result.factsBlock).not.toContain('Old quoted text');
    expect(result.untrusted.emailThread.messages[0].bodyStatus).toBe('present');
  });

  test('projects redacted allowlisted facts and bounded untrusted history', async () => {
    const emails = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...EMAIL, id: `email-${index}`, body_text: `Message ${index}; door code BLUE`,
        received_at: `2026-09-${String(index + 1).padStart(2, '0')}T16:00:00Z`,
      })),
      { ...EMAIL, id: 'draft', label_ids: ['DRAFT'], body_text: 'draft leak' },
      { ...EMAIL, id: 'later', received_at: '2026-09-11T16:00:00Z', body_text: 'later leak' },
      { ...EMAIL, id: 'other-sender', from_address: 'other@example.test', body_text: 'cross customer leak' },
      { ...EMAIL, id: 'other-customer', customer_id: 'customer-2', body_text: 'linked customer leak' },
      { ...EMAIL, id: 'other-thread', gmail_thread_id: 'thread-2', body_text: 'other thread leak' },
      EMAIL,
    ];
    const smsHistory = Array.from({ length: 12 }, (_, index) => ({
      direction: index % 2 ? 'outbound' : 'inbound', body: `SMS ${index} gate code 9876`, date: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    }));
    const recentCalls = Array.from({ length: 5 }, (_, index) => ({
      direction: 'inbound', summary: `Call ${index} lockbox 2468`, transcript: 'raw transcript leak',
      outcome: 'follow_up', date: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    }));
    const aggregator = { getContextForCustomer: jest.fn(async () => aggregatorContext({ smsHistory, recentCalls })) };
    const result = await assembleEmailReplyContext(EMAIL, {
      customer: CUSTOMER, database: fakeDatabase({ emails }), aggregator, mailboxAddress: MAILBOX,
      now: '2026-09-10T17:00:00Z',
    });

    expect(result.ok).toBe(true);
    expect(aggregator.getContextForCustomer).toHaveBeenCalledTimes(1);
    expect(result.untrusted.emailThread.messages).toHaveLength(LIMITS.email);
    expect(result.untrusted.emailThread).toMatchObject({ omitted: 1, omittedIsLowerBound: true });
    expect(result.untrusted.sms.messages).toHaveLength(LIMITS.sms);
    expect(result.untrusted.callSummaries.items).toHaveLength(LIMITS.calls);
    expect(result.timeline.length).toBeLessThanOrEqual(LIMITS.timeline);
    expect(result.factsBlock.length).toBeLessThanOrEqual(LIMITS.totalPromptChars);
    expect(result.factsBlock).toContain('USER-CHANNEL DATA ONLY');
    expect(result.factsBlock).toContain('[redacted]');
    expect(result.factsBlock).not.toMatch(/4545|9876|2468|raw transcript leak|cross customer leak|linked customer leak|other thread leak|later leak|draft leak|processor_secret|monthlyTotal|cardOnFile/);
    expect(result.facts.find((item) => item.key === 'open_invoice')).toMatchObject({ status: 'present', value: { amountDue: 75 } });
    expect(result.facts.find((item) => item.key === 'payer_billed_invoice')).toMatchObject({ status: 'present', value: true });
    expect(result.facts.find((item) => item.key === 'billing_lane').value.monthlyDues.basis).toBe('credit_card_surcharge');
    expect(result.limits.truncated).toBe(true);
  });

  test('anchors database calendar dates at ET midnight and timelines only genuine event times', async () => {
    const receivedAt = '2026-01-21T04:30:00.000Z'; // Jan 20 at 11:30 PM ET.
    const email = { ...EMAIL, received_at: receivedAt };
    const context = aggregatorContext({
      billing: {
        unavailable: false, outstandingBalance: 75,
        openInvoice: { title: 'Quarterly service', status: 'sent', amountDue: 75, dueDate: new Date(2026, 0, 22) },
        payerBilledInvoice: false,
        recentPayments: [{ amount: 50, status: 'paid', payment_date: new Date(2026, 0, 20) }],
      },
      upcomingServices: [{ type: 'Pest control', date: new Date(2026, 0, 21), status: 'confirmed' }],
      lastService: { type: 'Pest control', date: new Date(2026, 0, 19), notes: null },
      pendingEstimate: { status: 'draft', tier: 'Silver', sentAt: null },
    });
    const result = await assembleEmailReplyContext(email, {
      database: fakeDatabase({ emails: [email] }),
      aggregator: { getContextForCustomer: jest.fn(async () => context) },
      mailboxAddress: MAILBOX,
      now: '2026-01-21T12:00:00.000Z',
    });

    const factByKey = (key) => result.facts.find((item) => item.key === key);
    expect(factByKey('recent_payment')).toMatchObject({
      value: { paymentDate: '2026-01-20' },
      source: { observedAt: '2026-01-21T12:00:00.000Z', eventAt: '2026-01-20T05:00:00.000Z' },
    });
    expect(factByKey('upcoming_visit')).toMatchObject({
      value: { date: '2026-01-21' }, source: { eventAt: '2026-01-21T05:00:00.000Z' },
    });
    expect(factByKey('open_invoice')).toMatchObject({ value: { dueDate: '2026-01-22' } });
    expect(factByKey('open_invoice').source).not.toHaveProperty('eventAt');
    expect(factByKey('pending_estimate').source).not.toHaveProperty('eventAt');
    expect(result.timeline.map((item) => item.type)).not.toEqual(expect.arrayContaining(['open_invoice', 'pending_estimate']));
    expect(result.timeline.findIndex((item) => item.type === 'email'))
      .toBeLessThan(result.timeline.findIndex((item) => item.type === 'upcoming_visit'));
  });

  test('distinguishes unavailable lookups from absent facts and retains current inbound on thread failure', async () => {
    const aggregator = { getContextForCustomer: jest.fn(async () => aggregatorContext({
      billing: undefined, upcomingServices: [], lastService: null, pendingEstimate: null,
      sourceHealth: {}, recentCalls: [],
    })) };
    const result = await assembleEmailReplyContext(EMAIL, {
      database: fakeDatabase({ failEmails: true }), aggregator, mailboxAddress: MAILBOX,
    });
    expect(result.untrusted.emailThread).toMatchObject({ status: 'unavailable', messages: [{ currentInbound: true }] });
    expect(result.untrusted.callSummaries.status).toBe('unavailable');
    expect(result.facts.find((item) => item.key === 'billing').status).toBe('unavailable');
    expect(result.facts.find((item) => item.key === 'upcoming_visits').status).toBe('absent');
    expect(result.facts.find((item) => item.key === 'last_completed_visit').status).toBe('absent');
    expect(result.facts.find((item) => item.key === 'pending_estimate').status).toBe('absent');
    expect(result.factsBlock).toContain('Can you confirm my visit?');
  });

  test('bounds the rendered block while preserving the complete triggering question', async () => {
    const currentQuestion = `${'x'.repeat(2390)} question?`;
    const current = { ...EMAIL, body_text: currentQuestion };
    const emails = [current, ...Array.from({ length: 7 }, (_, index) => ({
      ...EMAIL, id: `past-${index}`, body_text: `past-${index} ${'e'.repeat(900)}`,
      received_at: `2026-09-0${index + 1}T16:00:00Z`,
    }))];
    const context = aggregatorContext({
      smsHistory: Array.from({ length: 10 }, (_, index) => ({ direction: 'inbound', body: `sms-${index} ${'s'.repeat(500)}`, date: `2026-08-${index + 10}T12:00:00Z` })),
      recentCalls: Array.from({ length: 3 }, (_, index) => ({ direction: 'inbound', summary: `call-${index} ${'c'.repeat(500)}`, date: `2026-07-${index + 10}T12:00:00Z` })),
    });
    const result = await assembleEmailReplyContext(current, {
      database: fakeDatabase({ emails }), aggregator: { getContextForCustomer: jest.fn(async () => context) }, mailboxAddress: MAILBOX,
    });
    expect(result.factsBlock.length).toBeLessThanOrEqual(LIMITS.totalPromptChars);
    expect(result.untrusted.emailThread.messages.find((item) => item.currentInbound).text).toBe(currentQuestion);
    expect(result.limits).toMatchObject({ truncated: true });
    expect(result.limits.omitted).toBeGreaterThan(0);
  });
});
