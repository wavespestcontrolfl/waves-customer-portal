/**
 * GATE_CALL_ADDRESS_FAMILY_CARD (owner 2026-10-24, "yes build"). A caller on a number no account carries
 * who states the service address a live customer already has gets ONE suggest-only
 * `family_account_candidates` card (basis stated_address_on_account) instead of a new customer record, with
 * two admin actions: Attach as contact (first free service-contact slot + relink) and New customer (close the
 * card, reprocess, mint the old way).
 *
 * Audited case (synthetic here): a daughter called from her own number for her mother; the names came through
 * spelled differently, so no name basis fired and the pass minted a third record for one house.
 *
 * Matching and the two routes run against real Postgres when DATABASE_URL is set (CI), inside a rolled-back
 * transaction. processRecording cannot run end to end in a test, so the processor's no-mint hold is pinned
 * structurally here and its inputs (report.filed) are proven behaviorally. Synthetic names, numbers and
 * addresses only.
 */
jest.setTimeout(30000);
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(async () => ({})) }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const fs = require('fs');
const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const {
  matchStatedAddressAccounts, fileFamilyAccountCard, operatorClosedCard, ATTACH_ROLES,
} = require('../services/call-family-name-link');

const GATE = 'GATE_CALL_ADDRESS_FAMILY_CARD';
const processorSource = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

describe('GATE_CALL_ADDRESS_FAMILY_CARD reader', () => {
  const saved = process.env[GATE];
  afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });
  test('strict true only: unset, 1, TRUE and yes are all off', () => {
    delete process.env[GATE];
    expect(gates.callAddressFamilyCardLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'on', '']) { process.env[GATE] = v; expect(gates.callAddressFamilyCardLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(gates.callAddressFamilyCardLive()).toBe(true);
  });
  test('gate off: the matcher returns before any query', async () => {
    delete process.env[GATE];
    const conn = jest.fn(() => { throw new Error('queried'); });
    await expect(matchStatedAddressAccounts({
      call: { id: 'c', from_phone: '+19415550101' }, extracted: { first_name: 'Dana' },
      statedAddress: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' }, conn,
    })).resolves.toBeNull();
    expect(conn).not.toHaveBeenCalled();
  });
});

describe('which cards offer the two actions (the server decides; the screen holds no copy)', () => {
  const { stampFamilyCardActions } = require('../routes/admin-triage').__private;
  const saved = process.env[GATE];
  afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });
  const card = (payload) => ({ reason_code: 'family_account_candidates', payload });
  const address = card({ match_basis: 'stated_address_on_account', caller_first_name: 'Dana', contact_phone: '+19415550101' });
  test('gate off: no card is stamped', () => {
    delete process.env[GATE];
    const items = [address];
    stampFamilyCardActions(items);
    expect(items[0].can_attach_contact).toBeUndefined();
    expect(items[0].can_new_customer).toBeUndefined();
  });
  test('gate on: Attach only on an address card that carries the caller; New customer on every basis but the callback voicemail one', () => {
    process.env[GATE] = 'true';
    const items = [address, card({ match_basis: 'caller_full_name' }), card({ match_basis: 'callback_spoken_number' }), card(JSON.stringify({ match_basis: 'stated_address_on_account' })), { reason_code: 'ambiguous_scheduling', payload: {} }];
    stampFamilyCardActions(items);
    expect(items.map((i) => i.can_attach_contact)).toEqual([true, false, false, false, undefined]);
    expect(items.map((i) => i.can_new_customer)).toEqual([true, true, false, true, undefined]);
  });
});

describe('processor wiring (processRecording cannot run end to end in a test)', () => {
  test('a filed card holds the customer create, only with the gate on and for a pass that would have created one', () => {
    const covers = processorSource.indexOf('const familyCardCovers = !!familyCardReport.filed');
    const hold = processorSource.indexOf('} else if (familyCardCovers && (extracted.first_name || firstNameAdvisoryCreate) && phone && !extracted.is_voicemail && !v2NonCustomerCallNature) {');
    const mint = processorSource.indexOf('} else if ((extracted.first_name || firstNameAdvisoryCreate) && phone && !extracted.is_voicemail && !v2NonCustomerCallNature) {');
    expect(covers).toBeGreaterThan(0);
    // The card is filed first; the hold sits after every normal match and before the create branch.
    expect(processorSource.indexOf("require('./call-family-name-link').fileFamilyAccountCard({")).toBeLessThan(covers);
    expect(hold).toBeGreaterThan(processorSource.indexOf('} else if (spokenNumberSuggested) {'));
    expect(hold).toBeLessThan(mint);
    expect(processorSource.slice(covers, covers + 400)).toContain('callAddressFamilyCardLive()');
    expect(processorSource.slice(covers, covers + 400)).toContain("!== 'callback_spoken_number'");
  });
  test('the held call is not a creation failure and its lead stays unclaimed, like the shared-phone case', () => {
    expect(processorSource).toContain('!explicitUnlink && !spokenNumberSuggested && !familyCardHold);');
    expect(processorSource).toContain('unclaimedOnly: !!(sharedPhoneAmbiguity.candidates || spokenNumberSuggested || familyCardHold),');
  });
});

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('stated address family card on PostgreSQL', () => {
  let database; let trx; let server; let base;
  const savedGate = process.env[GATE];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const router = require('../routes/admin-triage');
    const app = express();
    app.use(express.json());
    app.use('/admin/triage', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env[GATE] = 'true';
    trx = await database.transaction();
    mockConn = trx;
  });
  afterEach(async () => { await trx.rollback(); });

  let phoneSeq = 0;
  const phone = () => `+1941555${String(2000 + (phoneSeq += 1))}`;
  async function customer(over = {}) {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Angelina', last_name: 'Testerson', phone: phone(), city: 'Parrish', address_line1: '100 Example Loop', zip: '34219',
      pipeline_stage: 'active_customer', active: true, ...over,
    });
    return id;
  }
  async function call(over = {}) {
    const id = randomUUID();
    await trx('call_log').insert({ id, customer_id: null, metadata: {}, twilio_call_sid: `CA${id.replace(/-/g, '')}`, from_phone: '+19415550101', ...over });
    return id;
  }
  const input = (callLogId, over = {}) => ({
    call: { id: callLogId, from_phone: '+19415550101', customer_id: null },
    // The names came through spelled differently from the account: no name basis can fire.
    extracted: { first_name: 'Dana', last_name: 'Bronner', is_voicemail: false },
    v2CanonicalExtraction: { caller: { relationship_to_property: 'family_member' }, call_nature: 'new_lead', meta: { call_summary: 'x' } },
    statedAddress: { street_line_1: '100 Example Loop', city: 'Parrish', postal_code: '34219' },
    phone: '+19415550101',
    isOutbound: false,
    conn: trx,
    ...over,
  });
  const cardsFor = (callLogId) => trx('triage_items').where({ call_log_id: callLogId });

  describe('matching', () => {
    test('an address match files ONE suggest-only card with what Attach needs, and reports it filed (the processor then mints nobody)', async () => {
      const mom = await customer();
      const callLogId = await call();
      const report = {};
      const before = await trx('customers').where({ id: mom }).first();
      await fileFamilyAccountCard({ ...input(callLogId), report });
      expect(report.filed).toBe('stated_address_on_account');
      const cards = await cardsFor(callLogId);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ reason_code: 'family_account_candidates', severity: 'advisory', status: 'open' });
      expect(cards[0].payload).toMatchObject({
        match_basis: 'stated_address_on_account', caller_name: 'Dana Bronner', caller_first_name: 'Dana', caller_last_name: 'Bronner',
        caller_role: 'family_member', contact_phone: '+19415550101', customer_ids: [String(mom)],
      });
      expect(cards[0].payload.holder_candidates).toEqual([{ id: String(mom), name: 'Angelina Testerson', city: 'Parrish', address_matches: true }]);
      // Read-only: the account, the call and the contact slots are untouched.
      expect(await trx('customers').where({ id: mom }).first()).toEqual(before);
      expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
    });

    test('a different house number, street or unit is no match: no card, so the old create path runs', async () => {
      await customer({ address_line1: '102 Example Loop' });
      await customer({ address_line1: '100 Other Street' });
      await customer({ address_line1: '100 Example Loop', address_line2: 'Apt 4B' });
      const callLogId = await call();
      const report = {};
      // The caller states a DIFFERENT unit than the only account at that house number and street.
      await fileFamilyAccountCard({ ...input(callLogId, { statedAddress: { street_line_1: '100 Example Loop', street_line_2: 'Apt 9', city: 'Parrish', postal_code: '34219' } }), report });
      expect(report.filed).toBeUndefined();
      expect(await cardsFor(callLogId)).toHaveLength(0);
    });

    test('the same unit still matches, and no stated city or ZIP agreeing with the account is no match', async () => {
      const condo = await customer({ address_line2: 'Apt 4B' });
      const ok = await matchStatedAddressAccounts({ ...input(await call(), { statedAddress: { street_line_1: '100 Example Loop', street_line_2: '#4b', city: 'Parrish' } }) });
      expect(ok.candidates.map((c) => c.id)).toEqual([String(condo)]);
      const bare = await matchStatedAddressAccounts({ ...input(await call(), { statedAddress: { street_line_1: '100 Example Loop' } }) });
      expect(bare).toBeNull();
      const otherCity = await matchStatedAddressAccounts({ ...input(await call(), { statedAddress: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' } }) });
      expect(otherCity).toBeNull();
    });

    test('a merged-away, soft-deleted or lead-stage record never matches; the call\'s own customer never matches itself', async () => {
      await customer({ deleted_at: new Date() });
      await customer({ active: false });
      await customer({ pipeline_stage: 'new_lead' });
      const own = await customer();
      expect(await matchStatedAddressAccounts(input(await call(), { call: { id: randomUUID(), from_phone: '+19415550101', customer_id: null, metadata: { created_customer_id: own } } }))).toBeNull();
      const callLogId = await call();
      expect(await matchStatedAddressAccounts(input(callLogId, { call: { id: callLogId, from_phone: '+19415550101', customer_id: own } }))).toBeNull();
    });

    test('more than three accounts at one address is not evidence; a vendor, an applicant and a voicemail get no card', async () => {
      for (let i = 0; i < 4; i += 1) await customer({ first_name: `Unit${i}` });
      expect(await matchStatedAddressAccounts(input(await call()))).toBeNull();
      await trx('customers').where({ first_name: 'Unit3' }).del();
      expect(await matchStatedAddressAccounts(input(await call()))).not.toBeNull();
      for (const nature of ['vendor_or_partner', 'job_applicant']) {
        expect(await matchStatedAddressAccounts(input(await call(), { v2CanonicalExtraction: { call_nature: nature } }))).toBeNull();
      }
      expect(await matchStatedAddressAccounts(input(await call(), { extracted: { first_name: 'Dana', is_voicemail: true } }))).toBeNull();
    });

    test('the role comes from the call\'s relationship; one outside the Attach list files as other', async () => {
      await customer();
      const spouse = await matchStatedAddressAccounts(input(await call(), { v2CanonicalExtraction: { caller: { relationship_to_property: 'spouse_partner' } } }));
      expect(spouse.attach.caller_role).toBe('spouse_partner');
      const owner = await matchStatedAddressAccounts(input(await call(), { v2CanonicalExtraction: { caller: { relationship_to_property: 'owner' } } }));
      expect(owner.attach.caller_role).toBe('other');
    });

    test('a number some account already carries files no new card (the normal lookup links that call)', async () => {
      await customer();
      const known = '+19415550177';
      await customer({ first_name: 'Dana', last_name: 'Bronner', phone: known, address_line1: '7 Elsewhere Way', city: 'Sarasota', zip: '34240' });
      const callLogId = await call({ from_phone: known });
      const report = {};
      await fileFamilyAccountCard({ ...input(callLogId, { call: { id: callLogId, from_phone: known, customer_id: null }, phone: known }), report });
      expect(report.filed).toBeUndefined();
    });

    test('gate off: the same call files nothing and reports nothing filed (byte-identical to before)', async () => {
      await customer();
      delete process.env[GATE];
      const callLogId = await call();
      const report = {};
      await fileFamilyAccountCard({ ...input(callLogId), report });
      expect(report.filed).toBeUndefined();
      expect(await cardsFor(callLogId)).toHaveLength(0);
    });

    test('a filed card of the older bases is reported too, so the processor holds the create for them as well', async () => {
      const mom = await customer();
      const callLogId = await call();
      const report = {};
      await fileFamilyAccountCard({
        ...input(callLogId, {
          extracted: { first_name: 'Dana', last_name: 'Lee', is_voicemail: false },
          v2CanonicalExtraction: { caller: { relationship_to_property: 'family_member' }, secondary_contact: { first_name: 'Angelina', last_name: 'Testerson', role: 'family_member' }, meta: { call_summary: 'x' } },
        }),
        report,
      });
      expect(report.filed).toBe('family');
      expect((await cardsFor(callLogId))[0].payload.customer_ids).toEqual([String(mom)]);
    });
  });

  describe('card actions', () => {
    async function post(path, body, headers = {}) {
      const res = await fetch(`${base}/admin/triage/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }
    async function filed(over = {}) {
      const mom = await customer(over);
      const callLogId = await call();
      await fileFamilyAccountCard(input(callLogId));
      const [card] = await cardsFor(callLogId);
      return { mom, callLogId, card };
    }

    test('Attach fills the FIRST FREE slot with name, number and role, relinks the call and resolves the card; nothing is sent', async () => {
      const { mom, callLogId, card } = await filed({ service_contact_name: 'Existing Person', service_contact_phone: '+19415550166', service_contact_role: 'spouse_partner' });
      const out = await post(`${card.id}/attach-contact`, { customer_id: mom, expected_updated_at: card.updated_at });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, status: 'resolved', slot: 'filed' });
      const row = await trx('customers').where({ id: mom }).first();
      // Slot 1 is untouched; slot 2 holds the caller.
      expect(row).toMatchObject({ service_contact_name: 'Existing Person', service_contact_phone: '+19415550166', service_contact_role: 'spouse_partner' });
      expect(row).toMatchObject({ service_contact2_name: 'Dana Bronner', service_contact2_phone: '+19415550101', service_contact2_role: 'family_member', service_contact3_name: null });
      // The number is held out of every text until that person's own YES, and no opt-in or message exists.
      expect(row.service_preferences.unconsented_slot_phone_keys).toContain('9415550101');
      expect(await trx('recipient_optin').where({ customer_id: mom })).toHaveLength(0);
      // The call is relinked with the operator override, and the card is a person's resolution.
      const callRow = await trx('call_log').where({ id: callLogId }).first();
      expect(callRow.customer_id).toBe(mom);
      expect(callRow.metadata.customer_link_override).toMatchObject({ customer_id: mom, previous_customer_id: null });
      const [done] = await cardsFor(callLogId);
      expect(done).toMatchObject({ status: 'resolved', resolution_source: 'human' });
      expect(await operatorClosedCard(trx, callLogId)).toBe(true);
    });

    test('Attach takes the role chosen on the card and refuses an unknown role', async () => {
      const { mom, card } = await filed();
      expect((await post(`${card.id}/attach-contact`, { customer_id: mom, role: 'emperor', expected_updated_at: card.updated_at })).status).toBe(400);
      expect((await post(`${card.id}/attach-contact`, { customer_id: mom, role: 'tenant', expected_updated_at: card.updated_at })).status).toBe(200);
      expect((await trx('customers').where({ id: mom }).first()).service_contact_role).toBe('tenant');
      expect(ATTACH_ROLES).toContain('other');
    });

    test('Attach with all three slots full is a 409: nothing is overwritten, the call stays unlinked, the card stays open', async () => {
      const { mom, callLogId, card } = await filed({
        service_contact_name: 'One', service_contact_phone: '+19415550161',
        service_contact2_name: 'Two', service_contact2_phone: '+19415550162',
        service_contact3_name: 'Three', service_contact3_phone: '+19415550163',
      });
      const before = await trx('customers').where({ id: mom }).first();
      const out = await post(`${card.id}/attach-contact`, { customer_id: mom, expected_updated_at: card.updated_at });
      expect(out.status).toBe(409);
      expect(out.body.code).toBe('skipped_slots_full');
      expect(await trx('customers').where({ id: mom }).first()).toEqual(before);
      expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
      expect((await cardsFor(callLogId))[0].status).toBe('open');
    });

    test('Attach is atomic: a relink that fails after the slot write rolls the slot back, and the card stays open', async () => {
      const { mom, callLogId, card } = await filed();
      const relink = require('../services/call-customer-relink');
      const spy = jest.spyOn(relink, 'relinkCallCustomerTx').mockRejectedValueOnce(new Error('relink failed'));
      const out = await post(`${card.id}/attach-contact`, { customer_id: mom, expected_updated_at: card.updated_at });
      spy.mockRestore();
      expect(out.status).toBe(500);
      const row = await trx('customers').where({ id: mom }).first();
      expect(row.service_contact_name).toBeNull();
      expect(row.service_contact_phone).toBeNull();
      expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
      expect((await cardsFor(callLogId))[0].status).toBe('open');
    });

    test('Attach refuses a stale card, an account the card does not list, a non-admin, and a gate that is off', async () => {
      const { mom, card } = await filed();
      const other = await customer({ address_line1: '9 Somewhere Ct' });
      expect((await post(`${card.id}/attach-contact`, { customer_id: mom, expected_updated_at: '2020-01-01T00:00:00Z' })).status).toBe(409);
      expect((await post(`${card.id}/attach-contact`, { customer_id: other, expected_updated_at: card.updated_at })).status).toBe(400);
      expect((await post(`${card.id}/attach-contact`, { customer_id: mom, expected_updated_at: card.updated_at }, { 'x-test-role': 'tech' })).status).toBe(403);
      delete process.env[GATE];
      expect((await post(`${card.id}/attach-contact`, { customer_id: mom, expected_updated_at: card.updated_at })).status).toBe(404);
      expect((await post(`${card.id}/new-customer`, { expected_updated_at: card.updated_at })).status).toBe(404);
      expect((await trx('customers').where({ id: mom }).first()).service_contact_name).toBeNull();
    });

    test('New customer closes the card as a person\'s decision and reprocesses the call, so the pass creates the customer the old way', async () => {
      const { callLogId, card } = await filed();
      const processor = require('../services/call-recording-processor');
      const spy = jest.spyOn(processor, 'processRecording').mockResolvedValue({ success: true });
      const out = await post(`${card.id}/new-customer`, { expected_updated_at: card.updated_at });
      expect(out.status).toBe(200);
      expect(out.body.reprocess.started).toBe(true);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^CA/), { force: true, operator: true });
      spy.mockRestore();
      const [done] = await cardsFor(callLogId);
      expect(done).toMatchObject({ status: 'resolved', resolution_source: 'human' });
      // The reprocess meets a closed card: nothing is filed again, so the pass's hold is off and it creates the customer.
      const report = {};
      await fileFamilyAccountCard({ ...input(callLogId), report });
      expect(report.filed).toBeUndefined();
      expect(await cardsFor(callLogId)).toHaveLength(1);
    });

    test('New customer reports a pass that failed or skipped as not started, so the screen can say no customer was created', async () => {
      const processor = require('../services/call-recording-processor');
      for (const outcome of [{ success: false, error: 'extraction failed' }, { skipped: true, reason: 'already_processing' }]) {
        const { card } = await filed();
        const spy = jest.spyOn(processor, 'processRecording').mockResolvedValueOnce(outcome);
        const out = await post(`${card.id}/new-customer`, { expected_updated_at: card.updated_at });
        spy.mockRestore();
        expect(out.status).toBe(200);
        expect(out.body.reprocess.started).toBe(false);
        expect(out.body.reprocess.reason).toBeTruthy();
      }
    });

    test('New customer on a call that already has a customer, or a busy pass, changes nothing', async () => {
      const { mom, callLogId, card } = await filed();
      await trx('call_log').where({ id: callLogId }).update({ customer_id: mom });
      expect((await post(`${card.id}/new-customer`, { expected_updated_at: card.updated_at })).status).toBe(409);
      await trx('call_log').where({ id: callLogId }).update({ customer_id: null, processing_status: 'processing' });
      expect((await post(`${card.id}/new-customer`, { expected_updated_at: card.updated_at })).status).toBe(409);
      expect((await cardsFor(callLogId))[0].status).toBe('open');
    });
  });
});
