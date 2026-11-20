/**
 * Quiz hand-off, end to end on real rows: the public routes themselves (the
 * lead webhook, the property lookup, the lead-prefill read-back, the price
 * calculation and its add-on step).
 *
 * A quiz page whose answers end on a price page asks the lead webhook to
 * continue there. The webhook gives an attach token for the lead it just
 * filed, and no draft estimate. With the token, the price page's lookup
 * updates that lead instead of filing a second one, and the price calculation
 * then prices the same lead: one visitor, one lead, one estimate. This suite
 * posts to the real routes and reads the rows back:
 *  - the webhook gives the hand-off (with its line in the lead's activity
 *    list, and no draft) only to a quiz page that asked, whose answers end on
 *    a price page, for a lead that same request inserted; every other
 *    submission gets the draft as before;
 *  - the lookup continues the lead the token names: one lead, its type and
 *    its quiz answers kept; the price calculation's draft is the only
 *    estimate;
 *  - the token continues only a lead that is still open, live and not
 *    commercial; a wrong or expired token attaches nothing; and an attach
 *    token never reads a lead back. That visitor files a quote_wizard lead as
 *    before;
 *  - the price calculation keeps the same rule on its own write, so a lead
 *    id sent straight to it cannot write a web-form lead the office closed,
 *    and the add-on step never writes a web-form lead;
 *  - every other lead type keeps its own rule;
 *  - the webhook's AI triage, answering late, writes nothing once a price
 *    page has continued the lead.
 * Outbound services (texts, email, alerts, the AI triage, the lead agent,
 * the property lookup's paid sources) are stubbed. The rows are this suite's own (synthetic names,
 * numbers in the unassigned area code 999) and are removed after. It refuses
 * any database but a private QA one or CI's.
 */
const mockTriage = jest.fn(async () => null);
// The routes' own request limits (5 lookups an hour for one address) are not
// under test here.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({})) }));
jest.mock('../services/owner-alerts', () => ({ recordOwnerAlert: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: false })) }));
jest.mock('../services/lead-auto-reply', () => ({
  sendLeadAutoReplyOnce: jest.fn(async () => ({ sent: false })),
  sendCurrentCustomerQuoteText: jest.fn(async () => ({ sent: false })),
}));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn(async () => ({ enrolled: false })) }));
jest.mock('../services/lead-triage', () => ({ aiTriageLead: (...args) => mockTriage(...args) }));
// Never a paid agent session from a test.
jest.mock('../services/lead-response-agent', () => ({ isLeadAgentConfigured: () => false, processLead: jest.fn(async () => ({})) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false), sendOne: jest.fn(async () => ({})), newsletterGroupId: () => null, serviceGroupId: () => null,
}));
jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn(async () => ({ action: 'noop' })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../routes/property-lookup-v2', () => ({
  ...jest.requireActual('../routes/property-lookup-v2'),
  performPropertyLookup: jest.fn(async () => ({ propertyRecord: null, enriched: null, meta: {} })),
}));

const express = require('express');
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('quiz hand-off: the price page continues the lead an attach token names (live Postgres)', () => {
  let db;
  let server;
  let base;
  let mintLeadAttachToken;
  let mintLeadPrefillToken;
  let verifyLeadAttachToken;
  const phones = [];
  const prevSecret = process.env.LEAD_PREFILL_SECRET;
  const ADDRESS = '100 Synthetic Way, Bradenton, FL 34202';
  const QUIZ = { kind: 'pest', seeing: 'roaches', property: 'condo' };
  const INTAKE_STAGE = 'lead_webhook_received';
  const LAST_TEN = (column) => `RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;

  beforeAll((done) => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    process.env.LEAD_PREFILL_SECRET = 'quiz-handoff-suite-secret';
    db = require('../models/db');
    ({ mintLeadAttachToken, mintLeadPrefillToken, verifyLeadAttachToken } = require('../utils/lead-prefill-token'));
    const app = express();
    app.use(express.json());
    app.use('/api/leads', require('../routes/lead-webhook'));
    app.use('/api/public/estimator', require('../routes/public-property-lookup'));
    app.use('/api/public/quote', require('../routes/public-quote'));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
    else process.env.LEAD_PREFILL_SECRET = prevSecret;
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (!db || !phones.length) return;
    // This suite's rows, by its own phone numbers. A step that fails leaves
    // rows in a private or CI database, never a red suite.
    const customers = await db('customers').whereRaw(`${LAST_TEN('phone')} = ANY(?)`, [phones]).select('id', 'account_id');
    const customerIds = customers.map((row) => row.id);
    const leadIds = (await db('leads').whereRaw(`${LAST_TEN('phone')} = ANY(?)`, [phones]).select('id')).map((row) => row.id);
    const quietly = (query) => query.catch(() => {});
    await quietly(db('ad_service_attribution').whereIn('lead_id', leadIds).orWhereIn('customer_id', customerIds).del());
    await quietly(db('lead_activities').whereIn('lead_id', leadIds).del());
    for (const table of ['activity_log', 'customer_interactions', 'notification_prefs', 'property_preferences']) {
      await quietly(db(table).whereIn('customer_id', customerIds).del());
    }
    await quietly(db('estimates').whereIn('customer_id', customerIds).orWhereRaw(`${LAST_TEN('customer_phone')} = ANY(?)`, [phones]).del());
    await quietly(db('leads').whereIn('id', leadIds).del());
    await quietly(db('customers').whereIn('id', customerIds).del());
    await quietly(db('customer_accounts').whereIn('id', customers.map((row) => row.account_id).filter(Boolean)).del());
  });

  // Area code 999 is unassigned; the exchange never starts with 0 or 1.
  const syntheticPhone = () => {
    const phone = `999${200 + Math.floor(Math.random() * 800)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
    phones.push(phone);
    return phone;
  };

  const send = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const post = async (path, body) => {
    const res = await send(path, body);
    return { status: res.status, json: await res.json() };
  };
  // The same, with the reply's Cache-Control header (the webhook's hand-off).
  const postSeeingCache = async (path, body) => {
    const res = await send(path, body);
    return { status: res.status, json: await res.json(), cacheControl: res.headers.get('cache-control') };
  };
  const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  const leadsOnPhone = (phone) => db('leads').whereRaw(`${LAST_TEN('phone')} = ?`, [phone]).orderBy('created_at');
  const leadRow = (id) => db('leads').where({ id }).first();
  const stageOf = async (id) => parsed((await leadRow(id)).extracted_data).stage;
  const estimatesOnPhone = async (phone) => (await db('estimates').whereRaw(`${LAST_TEN('customer_phone')} = ?`, [phone]).orderBy('created_at'))
    .map((row) => [row.source, row.status]);

  // A lead as the lead webhook files it for a quiz hand-off, with the attach
  // token the webhook gives for it, for the cases that change the lead before
  // the price page sees it. No draft estimate: the webhook makes none for a
  // submission it hands off ("the lead webhook's hand-off" below posts to the
  // webhook itself).
  const quizLead = async (columns = {}) => {
    const contact = { phone: syntheticPhone(), email: `pat.${randomUUID().slice(0, 8)}@example.com` };
    const [row] = await db('leads').insert({
      first_name: 'Pat', last_name: 'Synthetic', phone: `+1${contact.phone}`, email: contact.email, address: ADDRESS,
      lead_type: 'form_submission', first_contact_channel: 'form', status: 'new', is_residential: true,
      service_interest: 'Cockroach Control',
      extracted_data: JSON.stringify({ stage: INTAKE_STAGE, quiz: QUIZ, timeline: 'this_week' }),
      ...columns,
    }).returning(['id']);
    return { ...contact, leadId: row.id, token: mintLeadAttachToken(row.id) };
  };
  // What the office can do to a lead inside the token's two hours.
  const CLOSED = [
    ['lost', { status: 'lost' }],
    ['converted', { converted_at: new Date() }],
    ['marked commercial', { is_commercial: true }],
  ];

  // The price page's requests, as its form sends them.
  const lookup = (contact, extra = {}) => post('/api/public/estimator/property-lookup', {
    firstName: 'Pat', lastName: 'Synthetic', email: contact.email, phone: contact.phone, address: ADDRESS, ...extra,
  });
  const calculate = (contact, leadId) => post('/api/public/quote/calculate', {
    leadId, firstName: 'Pat', lastName: 'Synthetic', email: contact.email, phone: contact.phone,
    address: ADDRESS, city: 'Bradenton', zip: '34202', homeSqFt: 1800, lotSqFt: 8000, stories: 1,
    services: { pest: { frequency: 'quarterly' } },
  });
  const upsell = (contact, leadId) => post('/api/public/quote/upsell', { leadId, email: contact.email, addOns: ['mosquito'] });
  // A quiz page's submission to the lead webhook.
  const quizSubmission = () => ({
    name: 'Pat Synthetic', phone: syntheticPhone(), email: `pat.${randomUUID().slice(0, 8)}@example.com`, address: ADDRESS,
    interest: 'pest', specific_service: 'cockroach_control', service_interest: 'Cockroach Control',
    timeline: 'this_week', quiz: QUIZ, source: 'astro-pest-quiz',
  });
  // The same, asking to continue on a price page.
  const priceAsk = (extra = {}) => ({ ...quizSubmission(), price_handoff: true, ...extra });
  const FORM_DRAFT = [['lead_webhook', 'draft']];
  const handoffNotes = (leadId) => db('lead_activities').where({ lead_id: leadId, activity_type: 'price_handoff' }).pluck('description');

  describe('the lead webhook\'s hand-off', () => {
    test('asked, with answers that end on a price page: a hand-off for the new lead, its activity line, and no draft', async () => {
      const body = priceAsk();
      const filed = await postSeeingCache('/api/leads', body);
      expect(filed.status).toBe(200);
      const leads = await leadsOnPhone(body.phone);
      expect(leads.map((row) => [row.lead_type, row.status, row.customer_id])).toEqual([['form_submission', 'new', filed.json.customerId]]);
      expect(parsed(leads[0].extracted_data)).toMatchObject({ stage: INTAKE_STAGE, quiz: QUIZ, timeline: 'this_week' });
      expect(filed.json.handoff).toEqual({ lead_id: leads[0].id, token: expect.any(String), expires_in: 7200 });
      expect(verifyLeadAttachToken(leads[0].id, filed.json.handoff.token)).toBe(true);
      // The reply carries a credential for the lead: it is never cached.
      expect(filed.cacheControl).toContain('no-store');
      expect(await estimatesOnPhone(body.phone)).toEqual([]);
      expect(await handoffNotes(leads[0].id)).toEqual([expect.stringContaining('this lead starts with no draft')]);
    }, 60000);

    test('not asked (every other form, a saved replay): the draft as before and no hand-off', async () => {
      for (const flag of [undefined, false, 'true', 1]) {
        const body = priceAsk({ price_handoff: flag });
        const filed = await postSeeingCache('/api/leads', body);
        expect(filed.status).toBe(200);
        expect(filed.json.handoff).toBeUndefined();
        expect(filed.cacheControl || '').not.toContain('no-store');
        const leads = await leadsOnPhone(body.phone);
        expect(leads).toHaveLength(1);
        expect(await estimatesOnPhone(body.phone)).toEqual(FORM_DRAFT);
        expect(await handoffNotes(leads[0].id)).toEqual([]);
      }
    }, 120000);

    test('asked, but the submission names a service key: no hand-off, and the draft step parks a key the catalog cannot confirm', async () => {
      const body = priceAsk({ service_key: 'no_such_service_key' });
      const filed = await post('/api/leads', body);
      expect(filed.status).toBe(200);
      expect(filed.json.handoff).toBeUndefined();
      const leads = await leadsOnPhone(body.phone);
      expect(leads.map((row) => row.service_key)).toEqual([null]);
      expect(await handoffNotes(leads[0].id)).toEqual([]);
      const drafts = await db('estimates').whereRaw(`${LAST_TEN('customer_phone')} = ?`, [body.phone]);
      expect(drafts.map((row) => [row.source, row.status])).toEqual(FORM_DRAFT);
      expect(JSON.stringify(parsed(drafts[0].estimate_data))).toContain('Submitted service key could not be verified against the catalog');
      // A value the webhook does not read as a key (malformed, or masked by a
      // blank alias) still names one: no hand-off, and the draft every form gets.
      for (const named of [{ serviceKey: 'not a key!' }, { serviceKey: '', service_key: 'no_such_service_key' }]) {
        const other = priceAsk(named);
        expect((await post('/api/leads', other)).json.handoff).toBeUndefined();
        expect(await estimatesOnPhone(other.phone)).toEqual(FORM_DRAFT);
      }
    }, 120000);

    test('asked, but the answers end on a call, a business call-back or an office review: the draft and no hand-off', async () => {
      const elsewhere = [
        { timeline: 'now' },
        { quiz: { ...QUIZ, seeing: 'unsure' } },
        { quiz: { ...QUIZ, property: 'business' } },
        { quiz: { kind: 'pest', seeing: 'roaches' } },
        { quiz: undefined },
      ];
      for (const answers of elsewhere) {
        const body = priceAsk(answers);
        const filed = await post('/api/leads', body);
        expect(filed.status).toBe(200);
        expect(filed.json.handoff).toBeUndefined();
        expect(await estimatesOnPhone(body.phone)).toEqual(FORM_DRAFT);
      }
    }, 120000);

    test('asked, but the submission joins an open call lead: no hand-off, and the draft is made after the lead step', async () => {
      const body = priceAsk();
      const callLeadId = randomUUID();
      await db('leads').insert({
        id: callLeadId, first_name: 'Pat', last_name: 'Synthetic', phone: `+1${body.phone}`, status: 'new',
        lead_type: 'voicemail', first_contact_channel: 'call',
      });
      const filed = await post('/api/leads', body);
      expect(filed.status).toBe(200);
      expect(filed.json.handoff).toBeUndefined();
      const leads = await leadsOnPhone(body.phone);
      expect(leads.map((row) => [row.id, row.lead_type])).toEqual([[callLeadId, 'voicemail']]);
      expect(parsed(leads[0].extracted_data).quiz).toEqual(QUIZ);
      expect(await estimatesOnPhone(body.phone)).toEqual(FORM_DRAFT);
      expect(await handoffNotes(callLeadId)).toEqual([]);
    }, 60000);

    test('the whole path: the price page continues the lead the webhook handed off, and its draft is the only estimate', async () => {
      const body = priceAsk();
      const { handoff } = (await post('/api/leads', body)).json;
      const looked = await lookup(body, { prefill_lead_id: handoff.lead_id, prefill_token: handoff.token });
      expect(looked).toMatchObject({ status: 200, json: { lead_id: handoff.lead_id } });
      const priced = await calculate(body, handoff.lead_id);
      expect(priced.status).toBe(200);
      expect(priced.json).toMatchObject({ lead_id: handoff.lead_id, estimate_id: expect.any(String) });
      const leads = await leadsOnPhone(body.phone);
      expect(leads.map((row) => [row.id, row.lead_type])).toEqual([[handoff.lead_id, 'form_submission']]);
      expect(parsed(leads[0].extracted_data)).toMatchObject({ stage: 'quote_calculated', quiz: QUIZ, timeline: 'this_week' });
      expect(await estimatesOnPhone(body.phone)).toEqual([['quote_wizard', 'draft']]);
    }, 120000);

    test('the form\'s draft is why: with it on the phone, the price page gets no draft of its own', async () => {
      const body = priceAsk({ price_handoff: undefined });
      await post('/api/leads', body);
      const looked = await lookup(body);
      const priced = await calculate(body, looked.json.lead_id);
      expect(priced.status).toBe(200);
      expect(priced.json.estimate_id).toBeUndefined();
      expect(await estimatesOnPhone(body.phone)).toEqual(FORM_DRAFT);
    }, 120000);
  });

  describe('the property lookup', () => {
    test('continues the lead the token names: one lead, its type and answers kept, and the price page\'s draft is the only estimate', async () => {
      const lead = await quizLead();

      const looked = await lookup(lead, { prefill_lead_id: lead.leadId, prefill_token: lead.token });
      expect(looked).toMatchObject({ status: 200, json: { lead_id: lead.leadId } });
      let rows = await leadsOnPhone(lead.phone);
      expect(rows.map((row) => [row.id, row.lead_type, row.status])).toEqual([[lead.leadId, 'form_submission', 'new']]);
      expect(parsed(rows[0].extracted_data)).toMatchObject({ stage: 'property_lookup_complete', quiz: QUIZ, timeline: 'this_week' });

      const priced = await calculate(lead, lead.leadId);
      expect(priced.status).toBe(200);
      expect(priced.json).toMatchObject({ lead_id: lead.leadId, estimate_id: expect.any(String) });
      rows = await leadsOnPhone(lead.phone);
      expect(rows.map((row) => [row.id, row.lead_type])).toEqual([[lead.leadId, 'form_submission']]);
      expect(parsed(rows[0].extracted_data)).toMatchObject({ stage: 'quote_calculated', quiz: QUIZ, timeline: 'this_week' });
      expect(await estimatesOnPhone(lead.phone)).toEqual([['quote_wizard', 'draft']]);
    }, 120000);

    test('a lookup that runs again never rewrites a keyed lead\'s label: the catalog name stays beside its key', async () => {
      // The price calculation writes the key and the catalog name together.
      // The visitor then goes back and sends the lookup again on the same token.
      const keyed = await quizLead({ service_key: 'pest_quarterly', service_interest: 'Quarterly Pest Control' });
      const again = await lookup(keyed, { prefill_lead_id: keyed.leadId, prefill_token: keyed.token, serviceInterest: 'ant-control' });
      expect(again).toMatchObject({ status: 200, json: { lead_id: keyed.leadId } });
      expect(await leadRow(keyed.leadId)).toMatchObject({ service_key: 'pest_quarterly', service_interest: 'Quarterly Pest Control' });
      // A lead with no key takes the price page's label, as before.
      const plain = await quizLead();
      await lookup(plain, { prefill_lead_id: plain.leadId, prefill_token: plain.token, serviceInterest: 'ant-control' });
      expect(await leadRow(plain.leadId)).toMatchObject({ service_key: null, service_interest: 'Ant Control' });
    }, 120000);

    test('continues only a lead that is still open, live and not commercial', async () => {
      for (const [, change] of [...CLOSED, ['deleted', { deleted_at: new Date() }]]) {
        const lead = await quizLead();
        await db('leads').where({ id: lead.leadId }).update(change);
        const looked = await lookup(lead, { prefill_lead_id: lead.leadId, prefill_token: lead.token });
        expect(looked.status).toBe(200);
        expect(looked.json.lead_id).not.toBe(lead.leadId);
        expect((await leadRow(looked.json.lead_id)).lead_type).toBe('quote_wizard');
        expect(await stageOf(lead.leadId)).toBe(INTAKE_STAGE);
      }
    }, 120000);

    test('a wrong or expired token attaches nothing, and an attach token never reads a lead back', async () => {
      const lead = await quizLead();
      const other = await quizLead();
      const expired = mintLeadAttachToken(lead.leadId, Math.floor(Date.now() / 1000) - 3 * 60 * 60);
      for (const bad of [other.token, expired, `${lead.token}x`, 'not-a-token']) {
        const looked = await lookup(lead, { prefill_lead_id: lead.leadId, prefill_token: bad });
        expect(looked.status).toBe(200);
        expect(looked.json.lead_id).not.toBe(lead.leadId);
      }
      expect(await stageOf(lead.leadId)).toBe(INTAKE_STAGE);

      const read = await post('/api/public/estimator/lead-prefill', { lead_id: lead.leadId, token: lead.token });
      expect(read).toEqual({ status: 404, json: { error: 'not_found' } });
      // The prefill token of the same lead still reads it (the voicemail link's path).
      const prefill = await post('/api/public/estimator/lead-prefill', { lead_id: lead.leadId, token: mintLeadPrefillToken(lead.leadId) });
      expect(prefill).toMatchObject({ status: 200, json: { lead_id: lead.leadId } });
    }, 120000);
  });

  describe('the price calculation and its add-on step, sent a lead id directly', () => {
    test('an open web-form lead is priced in place, and the add-on step never writes it', async () => {
      const lead = await quizLead();
      const priced = await calculate(lead, lead.leadId);
      expect(priced).toMatchObject({ status: 200, json: { lead_id: lead.leadId } });
      expect((await leadsOnPhone(lead.phone)).map((row) => row.id)).toEqual([lead.leadId]);

      const before = await leadRow(lead.leadId);
      const added = await upsell(lead, lead.leadId);
      expect(added).toEqual({ status: 404, json: { error: 'Lead not found.' } });
      const after = await leadRow(lead.leadId);
      expect([after.service_interest, after.updated_at]).toEqual([before.service_interest, before.updated_at]);
    }, 120000);

    test.each(CLOSED)('a web-form lead the office %s is left alone: the run files its own lead, and the add-on step answers 404', async (_label, change) => {
      const lead = await quizLead();
      await db('leads').where({ id: lead.leadId }).update(change);
      const before = await leadRow(lead.leadId);

      const priced = await calculate(lead, lead.leadId);
      expect(priced.status).toBe(200);
      expect(priced.json.lead_id).not.toBe(lead.leadId);
      expect((await leadRow(priced.json.lead_id)).lead_type).toBe('quote_wizard');

      const added = await upsell(lead, lead.leadId);
      expect(added).toEqual({ status: 404, json: { error: 'Lead not found.' } });

      const after = await leadRow(lead.leadId);
      expect([after.service_interest, after.updated_at, parsed(after.extracted_data)])
        .toEqual([before.service_interest, before.updated_at, parsed(before.extracted_data)]);
    }, 120000);

    test('every other lead type keeps its own rule: a closed quote_wizard lead is still written in place', async () => {
      const lead = await quizLead({ lead_type: 'quote_wizard', first_contact_channel: 'website_quote', status: 'lost' });
      const priced = await calculate(lead, lead.leadId);
      expect(priced).toMatchObject({ status: 200, json: { lead_id: lead.leadId } });
      expect(await stageOf(lead.leadId)).toBe('quote_calculated');

      const added = await upsell(lead, lead.leadId);
      expect(added).toMatchObject({ status: 200, json: { ok: true } });
      const row = await leadRow(lead.leadId);
      expect(row.service_interest).toContain('Mosquito');
      expect(row.status).toBe('lost');
    }, 120000);
  });

  describe('the lead webhook\'s AI triage, answering late', () => {
    afterEach(() => { mockTriage.mockImplementation(async () => null); });

    test('writes and records nothing once a price page has continued the lead; a lead still at intake takes it', async () => {
      const answers = [];
      mockTriage.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
      const continued = quizSubmission();
      const atIntake = quizSubmission();
      await post('/api/leads', continued);
      await post('/api/leads', atIntake);
      const [{ id: continuedId }] = await leadsOnPhone(continued.phone);
      const [{ id: intakeId }] = await leadsOnPhone(atIntake.phone);
      expect(answers).toHaveLength(2);

      const looked = await lookup(continued, { prefill_lead_id: continuedId, prefill_token: mintLeadAttachToken(continuedId) });
      expect(looked).toMatchObject({ status: 200, json: { lead_id: continuedId } });
      // Both triages answer now; the continued lead's write is issued first.
      for (const answer of answers) answer({ extractedData: { summary: 'late triage' } });
      const dataOf = async (id) => parsed((await leadRow(id)).extracted_data);
      const deadline = Date.now() + 10000;
      while ((await dataOf(intakeId)).summary !== 'late triage' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(await dataOf(intakeId)).toMatchObject({ summary: 'late triage', quiz: QUIZ });
      const kept = await dataOf(continuedId);
      expect(kept).toMatchObject({ stage: 'property_lookup_complete', quiz: QUIZ });
      expect(kept.summary).toBeUndefined();
      // The dropped answer is not recorded as the lead's current triage.
      const triaged = await db('lead_activities').where({ activity_type: 'ai_triage' }).whereIn('lead_id', [intakeId, continuedId]).pluck('lead_id');
      expect(triaged).toEqual([intakeId]);
    }, 120000);
  });
});
