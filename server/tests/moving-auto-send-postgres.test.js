// The app-sent new-home estimate against real PostgreSQL (one rolled-back transaction per test), dark
// behind GATE_MOVING_AUTO_SEND (owner 2026-11-04, option A): the draft the app made for a move goes out
// once through the office's own estimate send (the real sendEstimateNow): by email and the moving text
// from 8 AM to 8 PM ET; at night by email, with the text from 8 AM unless the customer opened it; a
// draft the office changed, one made before the job, a send that reached no one, or a send that stopped
// part way rings the office instead. The text and email providers, the property lookup and the admin
// bell writer are stubs (no network, no spend, nothing sent). All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geocoder', () => ({ geocodeAddressWithStatus: jest.fn(async () => ({ location: { lat: 27.1, lng: -82.4 } })) }));
jest.mock('../routes/property-lookup-v2', () => ({ ...jest.requireActual('../routes/property-lookup-v2'), performPropertyLookup: jest.fn() }));
jest.mock('../services/notification-service', () => {
  const actual = jest.requireActual('../services/notification-service');
  return { ...actual, notifyAdmin: jest.fn(async () => ({ id: 'n-auto-send' })) };
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ ...jest.requireActual('../services/sendgrid-mail'), isConfigured: jest.fn(() => true) }));
jest.mock('../services/email-template-library', () => ({ ...jest.requireActual('../services/email-template-library'), sendTemplate: jest.fn() }));
jest.mock('../services/automation-runner', () => ({ ...jest.requireActual('../services/automation-runner'), enrollCustomer: jest.fn(async () => null) }));
jest.mock('../services/address-validation', () => ({ ...jest.requireActual('../services/address-validation'), validateAddress: jest.fn() }));
jest.mock('../services/short-url', () => ({ ...jest.requireActual('../services/short-url'), shortenOrPassthrough: jest.fn(async (url) => url) }));

const crypto = require('crypto');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const NEW_HOUSE = { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' };
const NEW_ADDRESS = '40 Sample Road, Venice, FL 34285';
const day = (n) => etDateString(addETDays(new Date(), n));
// An ET wall-clock time, n days from today.
const at = (time, n = 0) => parseETDateTime(`${day(n)}T${time}:00`);
const GATES = ['GATE_MOVING_FLOW', 'GATE_MOVING_ESTIMATE', 'GATE_MOVING_AUTO_ESTIMATE', 'GATE_MOVING_AUTO_SEND'];

postgres('moving: the app-sent new-home estimate (live Postgres)', () => {
  // The draft's save loads the estimate, pricing and lookup modules; the send loads the send path.
  jest.setTimeout(60000);
  let database;
  let trx;
  let Auto;
  let Send;
  let Lookup;
  let Notifications;
  let Sms;
  let Email;
  let Followup;
  let customerId;
  const OLD_ENV = {};

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    for (const key of GATES) OLD_ENV[key] = process.env[key];
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    Auto = require('../services/moving-auto-estimate');
    Send = require('../services/moving-auto-send');
    Lookup = require('../routes/property-lookup-v2');
    Notifications = require('../services/notification-service');
    Sms = require('../services/messaging/send-customer-message');
    Email = require('../services/email-template-library');
    Followup = require('../services/automation-runner');
  });

  // The county record of a single-family home (the lead draft suite's own shape).
  const countyLookup = () => ({
    propertyRecord: {
      propertyType: 'Single Family', squareFootage: 1850, stories: 1, yearBuilt: 1998, _source: 'county',
      _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'SINGLE FAMILY DETACHED' },
      _fieldEvidence: { squareFootage: { sourceType: 'county' } },
    },
    enriched: {},
  });

  // A pest-only customer billed per visit (an older "Pest Control" label on a monthly plan) who sent
  // a move to 40 Sample Road, and the new-home estimate the app made for it.
  async function draftFor({ customer = {} } = {}) {
    customerId = crypto.randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550188', email: 'pat@example.invalid',
      address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205', billing_mode: 'per_application', ...customer,
    });
    const [{ id: oldHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: true, active: true, address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
    }).returning('id');
    await trx('estimates').insert({
      id: crypto.randomUUID(), customer_id: customerId, customer_name: 'Pat Sample', status: 'accepted', address: '1 Old Street, Bradenton, FL 34205',
      property_id: oldHouseId, accepted_at: new Date('2026-01-10T15:00:00Z'),
      estimate_data: JSON.stringify({
        inputs: { svcPest: true, pestFreq: '12', manualDiscountType: 'NONE' },
        engineRequest: { profile: { homeSqFt: 1600, lotSqFt: 8000, stories: 1, propertyType: 'single_family' }, selectedServices: ['PEST'], options: { pestFreq: 12, roachType: 'REGULAR' } },
      }),
    });
    await trx('scheduled_services').insert({
      customer_id: customerId, status: 'completed', service_type: 'Pest Control', scheduled_date: day(-30),
      is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true, property_id: oldHouseId, estimated_price: 80,
    });
    const [{ id: requestId }] = await trx('service_requests').insert({
      customer_id: customerId, category: 'moving', source: 'moving_page', subject: 'Moving: Venice', status: 'new',
    }).returning('id');
    const [move] = await trx('customer_moves').insert({
      customer_id: customerId, token: crypto.randomBytes(24).toString('hex'), status: 'submitted', from_property_id: oldHouseId,
      typed_address: NEW_ADDRESS, normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area',
      move_out_date: day(16), move_in_date: day(21), service_request_id: requestId, submitted_at: new Date(),
    }).returning('*');
    expect(await Auto.runMoveAutoEstimateJob()).toMatchObject({ drafted: 1 });
    const drafted = await trx('customer_moves').where({ id: move.id }).first();
    return { move: drafted, estimateId: drafted.estimate_id };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of GATES) process.env[key] = 'true';
    Lookup.performPropertyLookup.mockResolvedValue(countyLookup());
    Sms.sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-synthetic-accepted' });
    Email.sendTemplate.mockResolvedValue({ sent: true, providerAttempted: true, providerAccepted: true, message: { provider_message_id: 'sg-synthetic' } });
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
    await trx.rollback();
    for (const [key, value] of Object.entries(OLD_ENV)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  afterAll(async () => { if (database) await database.destroy(); });

  const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  const estimate = async (id) => trx('estimates').where({ id }).first();
  const state = async (id) => parsed((await estimate(id)).estimate_data).automation.moveAutoSend || null;
  const officeItems = () => Notifications.notifyAdmin.mock.calls.filter(([, , , opts]) => opts?.metadata?.kind === 'moving_auto_send_office');
  const texts = () => Sms.sendCustomerMessage.mock.calls.map(([input]) => input);

  test('off unless GATE_MOVING_AUTO_SEND and GATE_MOVING_AUTO_ESTIMATE are both on', async () => {
    const { estimateId } = await draftFor();
    delete process.env.GATE_MOVING_AUTO_SEND;
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toEqual({ skipped: true });
    process.env.GATE_MOVING_AUTO_SEND = 'true';
    delete process.env.GATE_MOVING_AUTO_ESTIMATE;
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toEqual({ skipped: true });
    expect((await estimate(estimateId)).status).toBe('draft');
    expect(texts()).toHaveLength(0);
  });

  test('in the day the draft goes once, by email and the moving text, through the office send', async () => {
    const { estimateId } = await draftFor();
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toMatchObject({ sent: 1, office: 0, failed: 0 });
    const row = await estimate(estimateId);
    expect(row.status).toBe('sent');
    expect(await state(estimateId)).toMatchObject({ result: 'sent', textOwed: false });
    expect([...(await state(estimateId)).sentChannels].sort()).toEqual(['email', 'sms']);
    // The moving text, with the plan's catalog name, on the fenced entry point.
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatchObject({ entryPoint: 'moving_auto_send', customerId, estimateId });
    expect(texts()[0].body).toBe(`Hi Pat, it's Waves. Your price at your new home is ready. Your Monthly Pest Control Service comes with you, with no setup fee.\n\nSee it and pick your first visit: portal.wavespestcontrol.com/estimate/${row.token}`);
    expect(Email.sendTemplate).toHaveBeenCalledTimes(1);
    expect(Email.sendTemplate.mock.calls[0][0]).toMatchObject({ templateKey: 'estimate.delivery', to: 'pat@example.invalid' });
    // The estimate's usual follow-up, as an office send starts it.
    expect(Followup.enrollCustomer).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'estimate_sent', context: { estimateId } }));
    const line = await trx('activity_log').where({ customer_id: customerId, action: 'moving_auto_estimate_sent' }).first();
    expect(line.description).toMatch(/^The app sent the new-home estimate by (text and email|email and text)\.$/);
    expect(await Send.runMoveAutoSendJob({ now: at('10:15') })).toMatchObject({ sent: 0, texted: 0 });
    expect(texts()).toHaveLength(1);
    expect(Email.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('at night the email goes at once and the text from 8 AM, once', async () => {
    const { estimateId } = await draftFor();
    expect(await Send.runMoveAutoSendJob({ now: at('22:00') })).toMatchObject({ sent: 1 });
    expect((await estimate(estimateId)).status).toBe('sent');
    expect(await state(estimateId)).toMatchObject({ result: 'sent', sentChannels: ['email'], textOwed: true });
    expect(texts()).toHaveLength(0);
    expect((await trx('activity_log').where({ customer_id: customerId, action: 'moving_auto_estimate_sent' }).first()).description)
      .toBe('The app sent the new-home estimate by email; the text follows from 8 AM unless the customer opens it first.');
    expect(await Send.runMoveAutoSendJob({ now: at('07:30', 1) })).toMatchObject({ texted: 0 });
    expect(texts()).toHaveLength(0);
    expect(await Send.runMoveAutoSendJob({ now: at('08:08', 1) })).toMatchObject({ texted: 1 });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatchObject({ entryPoint: 'moving_auto_send' });
    expect(texts()[0].body).toContain('Your Monthly Pest Control Service comes with you');
    expect(await state(estimateId)).toMatchObject({ textResult: 'sent' });
    expect((await estimate(estimateId)).status).toBe('sent');
    expect(Email.sendTemplate).toHaveBeenCalledTimes(1);
    expect(await Send.runMoveAutoSendJob({ now: at('08:23', 1) })).toMatchObject({ texted: 0 });
    expect(texts()).toHaveLength(1);
  });

  test('a customer who opened the estimate before 8 AM gets no text', async () => {
    const { estimateId } = await draftFor();
    await Send.runMoveAutoSendJob({ now: at('22:00') });
    await trx('estimates').where({ id: estimateId }).update({ status: 'viewed', viewed_at: at('23:00') });
    expect(await Send.runMoveAutoSendJob({ now: at('08:08', 1) })).toMatchObject({ texted: 0 });
    expect(texts()).toHaveLength(0);
  });

  test('a customer with a phone and no email waits for 8 AM, then gets the text', async () => {
    const { estimateId } = await draftFor({ customer: { email: null } });
    // At night it never takes a place in the batch.
    expect(await Send.runMoveAutoSendJob({ now: at('22:00') })).toEqual({ sent: 0, texted: 0, office: 0, restored: 0, waiting: 0, skipped: 0, failed: 0 });
    expect((await estimate(estimateId)).status).toBe('draft');
    expect(await Send.runMoveAutoSendJob({ now: at('08:08', 1) })).toMatchObject({ sent: 1 });
    expect(texts()).toHaveLength(1);
    expect(Email.sendTemplate).not.toHaveBeenCalled();
    expect(await state(estimateId)).toMatchObject({ sentChannels: ['sms'], textOwed: false });
  });

  test.each([
    ['the office changed the price', 'changed', (data) => ({ ...data, engineResult: { ...data.engineResult, lineItems: [{ ...data.engineResult.lineItems[0], officeEdited: true }] } })],
    ['the draft was made before the auto-send', 'old_draft', (data) => {
      const { engineResultDigest: _digest, ...stamp } = data.automation.moveAutoEstimate;
      return { ...data, automation: { ...data.automation, moveAutoEstimate: stamp } };
    }],
  ])('%s: not sent, one office item', async (_name, reason, edit) => {
    const { estimateId } = await draftFor();
    const data = parsed((await estimate(estimateId)).estimate_data);
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: JSON.stringify(edit(data)) });
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toMatchObject({ office: 1, sent: 0 });
    expect((await estimate(estimateId)).status).toBe('draft');
    expect(await state(estimateId)).toMatchObject({ blockedReason: reason });
    expect(texts()).toHaveLength(0);
    expect(Email.sendTemplate).not.toHaveBeenCalled();
    expect(officeItems()).toHaveLength(1);
    const [, title, , opts] = officeItems()[0];
    expect(title).toBe("Customers — send Pat Sample's new-home estimate by hand");
    expect(opts).toMatchObject({ bell: true, dedupeKey: `moving_auto_send_office:${estimateId}:send`, metadata: { reason, estimateId } });
    expect(opts.detail).toContain(Send._private.NOTES[reason]);
    expect(await Send.runMoveAutoSendJob({ now: at('10:15') })).toMatchObject({ office: 0 });
    expect(officeItems()).toHaveLength(1);
  });

  test.each([
    ['an address check', { addressUnverified: true }],
    ['a re-price', { estimatorEngine: { reprice_pending_at: new Date().toISOString() } }],
  ])('a draft under %s waits outside the batch, and goes once the hold clears', async (_name, hold) => {
    const { estimateId: heldId } = await draftFor();
    const data = parsed((await estimate(heldId)).estimate_data);
    await trx('estimates').where({ id: heldId }).update({ estimate_data: JSON.stringify({ ...data, ...hold }) });
    const { estimateId: nextId } = await draftFor({ customer: { phone: '+19415550199', email: 'lee@example.invalid' } });
    // Never read, so never "skipped": a held draft cannot fill the batch ahead of the next one.
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toMatchObject({ sent: 1, skipped: 0, office: 0 });
    expect((await estimate(nextId)).status).toBe('sent');
    expect((await estimate(heldId)).status).toBe('draft');
    expect(await state(heldId)).toBeNull();
    await trx('estimates').where({ id: heldId }).update({ estimate_data: JSON.stringify(data) });
    expect(await Send.runMoveAutoSendJob({ now: at('10:15') })).toMatchObject({ sent: 1 });
    expect((await estimate(heldId)).status).toBe('sent');
  });

  test('a move the customer changed or closed is not sent and rings no one', async () => {
    const { move, estimateId } = await draftFor();
    await trx('customer_moves').where({ id: move.id }).update({ auto_estimate_state: null, auto_estimate_at: null });
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toMatchObject({ sent: 0, office: 0 });
    await trx('customer_moves').where({ id: move.id }).update({ auto_estimate_state: 'drafted', status: 'closed' });
    expect(await Send.runMoveAutoSendJob({ now: at('10:15') })).toMatchObject({ sent: 0, office: 0 });
    expect((await estimate(estimateId)).status).toBe('draft');
    expect(await state(estimateId)).toBeNull();
    expect(texts()).toHaveLength(0);
    expect(officeItems()).toHaveLength(0);
  });

  test('a send that reached no one goes back to draft with one office item, and is not retried', async () => {
    const { estimateId } = await draftFor();
    Email.sendTemplate.mockResolvedValue({ sent: false, providerAttempted: false });
    Sms.sendCustomerMessage.mockResolvedValue({ sent: false, code: 'CONSENT_BLOCKED', reason: 'The customer turned texts off' });
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toMatchObject({ office: 1, sent: 0 });
    const row = await estimate(estimateId);
    expect(row.status).toBe('draft');
    expect(row.send_method).toBeNull();
    expect(await state(estimateId)).toMatchObject({ result: 'not_sent' });
    expect(officeItems()).toHaveLength(1);
    expect(officeItems()[0][3].detail).toContain('Text: The customer turned texts off.');
    expect(await Send.runMoveAutoSendJob({ now: at('10:15') })).toMatchObject({ sent: 0, office: 0 });
    expect(texts()).toHaveLength(1);
  });

  test('a send that throws is never called "reached no one": back to draft, one item to check the send history', async () => {
    const { estimateId } = await draftFor();
    const sendEstimateNow = jest.fn(async () => { throw new Error('The status write failed after the handoff.'); });
    expect(await Send.runMoveAutoSendJob({ now: at('10:00'), sendEstimateNow })).toMatchObject({ office: 1, sent: 0 });
    expect(sendEstimateNow).toHaveBeenCalledWith(expect.objectContaining({ id: estimateId, status: 'sending' }), 'both', expect.objectContaining({ movingAutoSend: true, callerPreClaimed: true }));
    expect((await estimate(estimateId)).status).toBe('draft');
    expect(await state(estimateId)).toMatchObject({ result: 'uncertain', error: 'The status write failed after the handoff.' });
    expect(officeItems()[0][3].detail).toContain("so the app cannot tell what went out. Check the estimate's send history first.");
    expect(await Send.runMoveAutoSendJob({ now: at('10:15'), sendEstimateNow })).toMatchObject({ office: 0 });
    expect(sendEstimateNow).toHaveBeenCalledTimes(1);
  });

  test('a send that parks the estimate itself (send_failed at its last check) still rings the office', async () => {
    const { estimateId } = await draftFor();
    const sendEstimateNow = jest.fn(async (row) => {
      await trx('estimates').where({ id: row.id, status: 'sending' }).update({ status: 'send_failed', last_send_error: 'reprice_pending' });
      throw Object.assign(new Error('This estimate is being re-priced. Nothing was sent.'), { statusCode: 409 });
    });
    expect(await Send.runMoveAutoSendJob({ now: at('10:00'), sendEstimateNow })).toMatchObject({ office: 1, sent: 0 });
    expect((await estimate(estimateId)).status).toBe('send_failed');
    expect(await state(estimateId)).toMatchObject({ result: 'uncertain' });
    expect(officeItems()).toHaveLength(1);
    expect(officeItems()[0][3].detail).toContain('This estimate is being re-priced. Nothing was sent.');
  });

  test.each([
    ['a plain restart gives the customer the emailed estimate back, with no item', {}, { status: 'sent', items: 0, restored: 1 }],
    ['a hold the send set keeps the estimate parked and rings the office', { reprice_pending_at: new Date().toISOString() }, { status: 'send_failed', items: 1, restored: 0 }],
  ])('a morning text that stopped part way: %s', async (_name, engine, expected) => {
    const { estimateId } = await draftFor();
    await Send.runMoveAutoSendJob({ now: at('22:00') });
    expect(await state(estimateId)).toMatchObject({ textOwed: true });
    // The text claim, then a restart: the estimate sweep parks the row as send_failed.
    await trx('estimates').where({ id: estimateId }).update({
      status: 'send_failed',
      last_send_error: 'Immediate estimate send was interrupted',
      estimate_data: trx.raw("jsonb_set(jsonb_set(estimate_data, '{automation,moveAutoSend,textClaimedAt}', to_jsonb(?::text)), '{estimatorEngine}', COALESCE(estimate_data->'estimatorEngine', '{}'::jsonb) || ?::jsonb)",
        [at('08:08', 1).toISOString(), JSON.stringify(engine)]),
    });
    expect(await Send.runMoveAutoSendJob({ now: at('09:00', 1) })).toMatchObject({ restored: expected.restored, office: expected.items, texted: 0 });
    const row = await estimate(estimateId);
    expect(row.status).toBe(expected.status);
    if (expected.restored) expect(row.last_send_error).toBeNull();
    expect(await state(estimateId)).toMatchObject({ textResult: 'stale' });
    expect(officeItems()).toHaveLength(expected.items);
    if (expected.items) expect(officeItems()[0][3]).toMatchObject({ dedupeKey: `moving_auto_send_office:${estimateId}:text`, metadata: { reason: 'text_blocked' } });
    expect(texts()).toHaveLength(0);
    expect(await Send.runMoveAutoSendJob({ now: at('09:15', 1) })).toMatchObject({ restored: 0, office: 0, texted: 0 });
  });

  test('a send that stopped part way rings the office once and never goes again', async () => {
    const { estimateId } = await draftFor();
    await trx('estimates').where({ id: estimateId }).update({
      status: 'sending',
      estimate_data: trx.raw("jsonb_set(estimate_data, '{automation,moveAutoSend}', ?::jsonb)", [JSON.stringify({ claimedAt: at('08:30').toISOString(), sendMethod: 'both' })]),
    });
    expect(await Send.runMoveAutoSendJob({ now: at('10:00') })).toMatchObject({ office: 1, sent: 0 });
    expect(await state(estimateId)).toMatchObject({ result: 'stale' });
    expect(officeItems()).toHaveLength(1);
    expect(officeItems()[0][3].detail).toContain("Check the estimate's send history first.");
    expect(await Send.runMoveAutoSendJob({ now: at('10:15') })).toMatchObject({ office: 0 });
    expect(officeItems()).toHaveLength(1);
    expect(texts()).toHaveLength(0);
    expect(Email.sendTemplate).not.toHaveBeenCalled();
  });
});
