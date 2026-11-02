/**
 * Moving flow against live Postgres (owner 2026-11-02, GATE_MOVING_FLOW): the
 * customer_moves service and the public routes through the real tables.
 *
 * Only the paid Google check, the short-link service and the admin alert
 * writer are stubbed (the alert stub still runs the REAL composeAdminAlert, so a
 * copy-rule break fails here). Everything else is real: the token, the daily
 * check cap claimed in SQL, the 24 h reuse, the office item (service_requests)
 * and its reopen, the activity row, and the rule that a move touches no
 * property or visit. It refuses any database but a private QA one or CI's.
 */
const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/address-validation', () => {
  const actual = jest.requireActual('../services/address-validation');
  return { ...actual, validateAddress: jest.fn() };
});
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async (category, spec) => { actual.composeAdminAlert(spec); return { id: 'n1' }; }) };
});

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

// The repo has no supertest: a tiny stand-in with the same get/post/send chain
// that listens on a free port and uses fetch.
async function call(app, method, path, { body } = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined || /^(get|head)$/i.test(method) ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, headers: Object.fromEntries(res.headers.entries()) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(app) {
  const make = (method, path) => {
    const state = { body: undefined };
    const chain = {
      send(b) { state.body = b; return chain; },
      then(resolve, reject) { return call(app, method, path, state).then(resolve, reject); },
    };
    return chain;
  };
  return { get: (path) => make('get', path), post: (path) => make('post', path) };
}

// Service calls take this fixed clock so the fixed dates below never age out
// of the 60-days-back / 400-days-ahead window.
const NOW = new Date('2026-11-02T15:00:00Z');

maybeDescribe('moving flow (live Postgres)', () => {
  let db;
  let Moves;
  let validateAddress;
  let STATUSES;
  let raiseAdminAlert;
  let shortenOrPassthrough;
  let express;
  let customerId;
  let propertyId;

  const inArea = (over = {}) => ({
    status: STATUSES.VALIDATED_ACCEPT, inServiceArea: true,
    normalized: { street_line_1: '12 Example Way', city: 'Parrish', state: 'FL', postal_code: '34219' }, ...over,
  });

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    process.env.GATE_MOVING_FLOW = 'true';
    db = require('../models/db');
    ({ validateAddress, STATUSES } = require('../services/address-validation'));
    ({ raiseAdminAlert } = require('../services/admin-alert-compose'));
    ({ shortenOrPassthrough } = require('../services/short-url'));
    Moves = require('../services/customer-moves');
    express = require('express');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_MOVING_FLOW = 'true';
    const [customer] = await db('customers').insert({
      first_name: 'Pat', last_name: 'Synthetic', phone: `+1941555${String(Math.floor(1000 + Math.random() * 8999))}`,
    }).returning('id');
    customerId = customer.id;
    const [prop] = await db('customer_properties').insert({
      customer_id: customerId, is_primary: true, active: true, address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
    }).returning('id');
    propertyId = prop.id;
    const visit = (service_type, extra = {}) => ({ customer_id: customerId, scheduled_date: '2026-12-01', service_type, ...extra });
    await db('scheduled_services').insert([
      visit('Monthly Pest Control Service', { recurring_ongoing: true, is_recurring: true }),
      visit('Monthly Pest Control Service', { recurring_ongoing: true, is_recurring: true }),
      visit('Lawn Care Service', { recurring_ongoing: true, is_recurring: true }),
      visit('One Time Mosquito Service'),
      visit('Re-service Callback', { recurring_ongoing: true, is_callback: true }),
    ]);
  });

  afterEach(async () => {
    await db('activity_log').where({ customer_id: customerId }).del();
    await db('customer_moves').where({ customer_id: customerId }).del();
    await db('service_requests').where({ customer_id: customerId }).del();
    await db('scheduled_services').where({ customer_id: customerId }).del();
    await db('customer_properties').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
  });

  const counts = async () => ({
    properties: Number((await db('customer_properties').where({ customer_id: customerId }).count('* as n').first()).n),
    visits: Number((await db('scheduled_services').where({ customer_id: customerId }).count('* as n').first()).n),
    primary: (await db('customer_properties').where({ customer_id: customerId, is_primary: true }).pluck('id')),
  });

  test('openMoveForCustomer reuses the live move and records the primary property', async () => {
    const first = await Moves.openMoveForCustomer(customerId, { actorId: null });
    const again = await Moves.openMoveForCustomer(customerId, { actorId: null });
    expect(again.id).toBe(first.id);
    expect(first.token).toMatch(/^[a-f0-9]{48}$/);
    expect(first.status).toBe('open');
    expect(first.from_property_id).toBe(propertyId);
    const [a, b] = await Promise.all([Moves.openMoveForCustomer(customerId), Moves.openMoveForCustomer(customerId)]);
    expect(a.id).toBe(b.id);
    expect(await db('customer_moves').where({ customer_id: customerId }).count('* as n').first()).toEqual({ n: '1' });
  });

  test('movingLinkFor shortens the portal URL with the moving kind and never expires it', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    const url = await Moves.movingLinkFor(move);
    expect(url).toBe(`https://portal.wavespestcontrol.com/moving/${move.token}`);
    expect(shortenOrPassthrough).toHaveBeenCalledWith(url, {
      kind: 'moving', entityType: 'customer_moves', entityId: move.id, customerId, expiresAt: null,
    });
    shortenOrPassthrough.mockRejectedValueOnce(new Error('shortener down'));
    expect(await Moves.movingLinkFor(move)).toBe(url);
  });

  test('the public view has only the allowed fields and the plan service names', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    const view = await Moves.publicMoveView(move);
    expect(Object.keys(view).sort()).toEqual(['addressOnFile', 'firstName', 'moveInDate', 'moveOutDate', 'newCity', 'services', 'status', 'verdict']);
    expect(view.firstName).toBe('Pat');
    expect(view.services).toEqual(['Lawn Care Service', 'Monthly Pest Control Service']);
    expect(JSON.stringify(view)).not.toMatch(/Old Street|Bradenton|555|@|\$/);
  });

  test('check: one paid call per typed text per 24 hours, the verdict mapping, and a failed answer is not kept', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    validateAddress.mockResolvedValueOnce(inArea());
    const first = await Moves.checkMoveAddress(move, '12 Example Way, Parrish FL');
    expect(first).toMatchObject({ typed: '12 Example Way, Parrish FL', verdict: 'in_area', reused: false });
    expect(first.normalized).toEqual({ line1: '12 Example Way', line2: null, city: 'Parrish', state: 'FL', zip: '34219' });
    const same = await Moves.checkMoveAddress(move, '  12 example   way, parrish fl ');
    expect(same).toMatchObject({ verdict: 'in_area', reused: true });
    expect(validateAddress).toHaveBeenCalledTimes(1);

    validateAddress.mockResolvedValueOnce(inArea({ status: STATUSES.OUT_OF_SERVICE_AREA, inServiceArea: false }));
    expect((await Moves.checkMoveAddress(move, '9 Far Away Rd, Atlanta GA')).verdict).toBe('out_of_area');
    validateAddress.mockResolvedValueOnce(inArea({ status: STATUSES.CONFIRM_NEEDED, inServiceArea: null }));
    expect((await Moves.checkMoveAddress(move, '77 Maybe St, Parrish FL')).verdict).toBe('unverified');

    validateAddress.mockResolvedValueOnce({ status: STATUSES.API_UNAVAILABLE, inServiceArea: null, normalized: null });
    expect((await Moves.checkMoveAddress(move, '5 Outage Ln, Parrish FL')).verdict).toBe('unverified');
    validateAddress.mockResolvedValueOnce(inArea());
    await Moves.checkMoveAddress(move, '5 Outage Ln, Parrish FL');
    expect(validateAddress).toHaveBeenCalledTimes(5);
  });

  test('check: keeps the unit the customer typed when Google drops it', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    validateAddress.mockResolvedValueOnce(inArea());
    const result = await Moves.checkMoveAddress(move, '12 Example Way, Apt 4B, Parrish FL');
    expect(result.normalized.line2).toBe('Apt 4B');
  });

  test('check: an old stored answer is asked again after 24 hours', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    validateAddress.mockResolvedValue(inArea());
    await Moves.checkMoveAddress(move, '12 Example Way, Parrish FL', { now: new Date('2026-11-02T12:00:00Z') });
    await Moves.checkMoveAddress(move, '12 Example Way, Parrish FL', { now: new Date('2026-11-03T11:59:00Z') });
    expect(validateAddress).toHaveBeenCalledTimes(1);
    await Moves.checkMoveAddress(move, '12 Example Way, Parrish FL', { now: new Date('2026-11-03T12:01:00Z') });
    expect(validateAddress).toHaveBeenCalledTimes(2);
  });

  test('check: the daily cap is 10 per link and holds under a burst', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    validateAddress.mockResolvedValue(inArea());
    const results = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => Moves.checkMoveAddress(move, `${100 + i} Burst Street, Parrish FL`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(4);
    expect(refused.every((r) => r.reason.code === 'check_cap' && r.reason.status === 429)).toBe(true);
    expect(validateAddress).toHaveBeenCalledTimes(10);
    // The row keeps the LAST checked text; checking that text again is answered
    // from the row even with the cap reached (no paid call).
    const { last_check: stored } = await db('customer_moves').where({ id: move.id }).first('last_check');
    const lastTyped = stored.result.typed;
    validateAddress.mockClear();
    expect((await Moves.checkMoveAddress(move, lastTyped)).reused).toBe(true);
    expect(validateAddress).not.toHaveBeenCalled();
    // A new Eastern day starts a new count.
    const tomorrow = new Date(Date.now() + 36 * 3600 * 1000);
    validateAddress.mockClear();
    await Moves.checkMoveAddress(move, '999 Next Day Street, Parrish FL', { now: tomorrow });
    expect(validateAddress).toHaveBeenCalledTimes(1);
  });

  test('submit needs a checked address or a move-out date, and uses only the server-checked address', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    await expect(Moves.submitMove(move, {})).rejects.toMatchObject({ code: 'need_something' });
    await expect(Moves.submitMove(move, { checkId: 'abcdef0123456789' })).rejects.toMatchObject({ code: 'no_checked_address' });
    // A verdict or address the browser sends is never read.
    await expect(Moves.submitMove(move, { address: '1 Forged St', verdict: 'in_area', moveInDate: '2026-12-20' }, { now: NOW }))
      .rejects.toMatchObject({ code: 'need_something' });
    expect(await db('service_requests').where({ customer_id: customerId }).count('* as n').first()).toEqual({ n: '0' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('submit: date bounds', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    const now = new Date('2026-11-02T15:00:00Z');
    const bad = (moveOutDate, moveInDate) => expect(Moves.submitMove(move, { moveOutDate, moveInDate }, { now })).rejects.toMatchObject({ code: 'bad_date' });
    await bad('2026-13-40');
    await bad('11/15/2026');
    await bad('2026-08-01');
    await bad('2028-01-01');
    await bad('2026-11-15', '2030-01-01');
    await expect(Moves.submitMove(move, { moveOutDate: '2026-09-03' }, { now })).resolves.toBeDefined();
    await expect(Moves.submitMove(move, { moveOutDate: '2027-12-07', moveInDate: '' }, { now })).resolves.toBeDefined();
    await expect(Moves.submitMove(move, { moveOutDate: '2027-12-08' }, { now })).rejects.toMatchObject({ code: 'bad_date' });
  });

  test('submit makes one office item and one alert, and a resubmit updates both', async () => {
    const before = await counts();
    const move = await Moves.openMoveForCustomer(customerId);
    validateAddress.mockResolvedValueOnce(inArea());
    const checked = await Moves.checkMoveAddress(move, '12 Example Way, Parrish FL');
    const first = await Moves.submitMove(move, { checkId: checked.checkId, moveOutDate: '2026-11-15', moveInDate: '' }, { now: NOW });

    const requests = await db('service_requests').where({ customer_id: customerId });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ category: 'moving', source: 'moving_page', urgency: 'routine', status: 'new', subject: 'Moving: Parrish' });
    expect(requests[0].description).toContain('New address as typed: 12 Example Way, Parrish FL.');
    expect(requests[0].description).toContain('The address is inside our service area.');
    expect(requests[0].description).toContain('Move-out date: Nov 15, 2026.');
    expect(requests[0].description).toContain('Move-in date: not known yet.');
    expect(requests[0].description).toContain('Current plan: Lawn Care Service, Monthly Pest Control Service.');
    expect(first.move).toMatchObject({ status: 'submitted', address_verdict: 'in_area', typed_address: '12 Example Way, Parrish FL', service_request_id: requests[0].id });
    expect(first.view).toMatchObject({ newCity: 'Parrish', verdict: 'in_area', addressOnFile: true, moveOutDate: '2026-11-15', moveInDate: null });

    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('service');
    expect(spec).toMatchObject({ area: 'Customers', severity: 'needs-you', doneWhen: 'request_answered', subject: { type: 'customer', id: customerId }, contact: true });
    expect(opts).toMatchObject({ dedupeKey: `moving:${move.id}`, refreshOnDedupe: true });
    expect(opts.metadata).toMatchObject({ requestId: requests[0].id, customerId, moveId: move.id });
    expect(await db('activity_log').where({ customer_id: customerId, action: 'moving_submitted' }).count('* as n').first()).toEqual({ n: '1' });

    // The office closes it, then the customer adds a move-in date and a new address.
    await db('service_requests').where({ id: requests[0].id }).update({ status: 'resolved', resolved_at: new Date() });
    validateAddress.mockResolvedValueOnce(inArea({ normalized: { street_line_1: '40 Other Rd', city: 'Palmetto', state: 'FL', postal_code: '34221' } }));
    const rechecked = await Moves.checkMoveAddress(first.move, '40 Other Rd, Palmetto FL');
    await Moves.submitMove(first.move, { checkId: rechecked.checkId, moveOutDate: '2026-11-15', moveInDate: '2026-11-20' }, { now: NOW });
    const after = await db('service_requests').where({ customer_id: customerId });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: requests[0].id, status: 'new', subject: 'Moving: Palmetto', resolved_at: null, status_version: 1 });
    expect(after[0].description).toContain('Move-in date: Nov 20, 2026.');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
    expect(raiseAdminAlert.mock.calls[1][2]).toMatchObject({ dedupeKey: `moving:${move.id}`, refreshOnDedupe: true });
    expect(raiseAdminAlert.mock.calls[1][2].metadata.requestId).toBe(requests[0].id);

    // Dates-only resubmit keeps the stored address.
    const dated = await Moves.submitMove(after && (await db('customer_moves').where({ id: move.id }).first()), { moveOutDate: '2026-11-18' }, { now: NOW });
    expect(dated.view).toMatchObject({ newCity: 'Palmetto', moveOutDate: '2026-11-18' });

    // A move changes no property, visit or primary.
    expect(await counts()).toEqual(before);
  });

  test('submit with dates only works and says the address is not known yet', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    const saved = await Moves.submitMove(move, { moveOutDate: '2026-11-15' }, { now: NOW });
    const [item] = await db('service_requests').where({ customer_id: customerId });
    expect(item.subject).toBe('Moving: address not known yet');
    expect(item.description).toContain('New address: not known yet.');
    expect(Moves.receiptFor(saved.view)).toEqual(['Thanks, Pat. We have your move dates. When you know your new address, open this same link and add it.']);
  });

  test('a closed move and a closed link answer nothing', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    await db('customer_moves').where({ id: move.id }).update({ status: 'closed', closed_at: new Date() });
    expect(await Moves.loadMoveByToken(move.token)).toBeNull();
    await expect(Moves.submitMove(move, { moveOutDate: '2026-11-15' }, { now: NOW })).rejects.toMatchObject({ status: 404 });
    // A closed move leaves room for the next one.
    const next = await Moves.openMoveForCustomer(customerId);
    expect(next.id).not.toBe(move.id);
  });

  test('the public routes, end to end', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/moving', require('../routes/moving-public'));
    const move = await Moves.openMoveForCustomer(customerId);

    const view = await request(app).get(`/api/public/moving/${move.token}`);
    expect(view.status).toBe(200);
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.body).toMatchObject({ firstName: 'Pat', status: 'open', addressOnFile: false });

    expect((await request(app).get(`/api/public/moving/${'f'.repeat(48)}`)).status).toBe(404);
    expect((await request(app).get('/api/public/moving/not-a-token')).status).toBe(404);

    validateAddress.mockResolvedValueOnce(inArea());
    const check = await request(app).post(`/api/public/moving/${move.token}/check`).send({ address: '12 Example Way, Parrish FL' });
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ typed: '12 Example Way, Parrish FL', normalized: { line1: '12 Example Way', line2: null, city: 'Parrish', state: 'FL', zip: '34219' }, verdict: 'in_area', checkId: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect((await request(app).post(`/api/public/moving/${move.token}/check`).send({ address: 'x' })).status).toBe(400);

    const soon = etDateString(addETDays(new Date(), 13));
    const submit = await request(app).post(`/api/public/moving/${move.token}/submit`).send({ checkId: check.body.checkId, moveOutDate: soon, moveInDate: '' });
    expect(submit.status).toBe(200);
    expect(submit.body.receipt).toEqual(['Thanks, Pat. We have your move. We will price your new home and send it to you to review. Nothing changes until you approve it.']);
    expect(JSON.stringify(submit.body)).not.toMatch(/Old Street|Bradenton|555|\$/);

    process.env.GATE_MOVING_FLOW = 'false';
    expect((await request(app).get(`/api/public/moving/${move.token}`)).status).toBe(404);
    expect((await request(app).post(`/api/public/moving/${move.token}/submit`).send({ moveOutDate: etDateString(addETDays(new Date(), 14)) })).status).toBe(404);
  });

  test('move dates keep their calendar day: a UTC-midnight DATE (Railway) and a page round trip', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    await Moves.submitMove(move, { moveOutDate: '2026-11-15', moveInDate: '2026-11-20' }, { now: NOW });
    const row = await db('customer_moves').where({ id: move.id }).first();
    // pg returns a DATE as midnight in the process zone, and Railway runs in
    // UTC: the row pg hands back there. (Jest sandboxes process.env, so TZ
    // cannot be switched inside the suite.)
    const railwayRow = { ...row, move_out_date: new Date('2026-11-15T00:00:00Z'), move_in_date: new Date('2026-11-20T00:00:00Z') };
    const view = await Moves.publicMoveView(railwayRow);
    expect(view).toMatchObject({ moveOutDate: '2026-11-15', moveInDate: '2026-11-20' });
    // "Add or change details" resubmits the dates the page shows: they stay put.
    await Moves.submitMove(row, { moveOutDate: view.moveOutDate, moveInDate: view.moveInDate }, { now: NOW });
    const again = await db('customer_moves').where({ id: move.id }).first();
    expect(await Moves.publicMoveView(again)).toMatchObject({ moveOutDate: '2026-11-15', moveInDate: '2026-11-20' });
    const [listed] = await Moves.recentMoves(customerId, 1);
    expect(listed).toMatchObject({ move_out_date: '2026-11-15', move_in_date: '2026-11-20' });
  });

  test('a submit names the check it confirmed: a check replaced in another window is refused, never swapped in', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    validateAddress.mockResolvedValueOnce(inArea());
    const tabA = await Moves.checkMoveAddress(move, '12 Example Way, Parrish FL');
    validateAddress.mockResolvedValueOnce(inArea({ normalized: { street_line_1: '40 Other Rd', city: 'Palmetto', state: 'FL', postal_code: '34221' } }));
    const tabB = await Moves.checkMoveAddress(move, '40 Other Rd, Palmetto FL');
    expect(tabA.checkId).not.toBe(tabB.checkId);
    await expect(Moves.submitMove(move, { checkId: tabA.checkId, moveOutDate: '2026-11-15' }, { now: NOW }))
      .rejects.toMatchObject({ code: 'stale_check', status: 409 });
    expect(await db('service_requests').where({ customer_id: customerId }).count('* as n').first()).toEqual({ n: '0' });
    const saved = await Moves.submitMove(move, { checkId: tabB.checkId, moveOutDate: '2026-11-15' }, { now: NOW });
    expect(saved.move).toMatchObject({ typed_address: '40 Other Rd, Palmetto FL' });
    // The same text again inside 24 hours is the same check, with the same id.
    expect((await Moves.checkMoveAddress(move, '40 Other Rd, Palmetto FL'))).toMatchObject({ reused: true, checkId: tabB.checkId });
  });

  test('each submit moves the alert\'s close boundary with the request, so an answer resolves both', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    const first = await Moves.submitMove(move, { moveOutDate: '2026-11-15' }, { now: NOW });
    const firstOpts = raiseAdminAlert.mock.calls[0][2];
    expect(firstOpts).toMatchObject({ dedupeVersion: NOW.toISOString(), metadata: expect.objectContaining({ askedAt: NOW.toISOString() }) });
    const later = new Date('2026-11-03T15:00:00Z');
    await Moves.submitMove(first.move, { moveOutDate: '2026-11-15', moveInDate: '2026-11-20' }, { now: later });
    const secondOpts = raiseAdminAlert.mock.calls[1][2];
    expect(secondOpts).toMatchObject({ dedupeVersion: later.toISOString(), metadata: expect.objectContaining({ askedAt: later.toISOString() }) });
    const { resolveRequestQuietly } = require('../services/portal-inbox');
    // The first boundary no longer covers the resubmitted request; the new one does.
    expect(await resolveRequestQuietly(first.request.id, customerId, 'Answered', { notAfter: firstOpts.metadata.askedAt })).toBe(0);
    expect(await resolveRequestQuietly(first.request.id, customerId, 'Answered', { notAfter: secondOpts.metadata.askedAt })).toBe(1);
  });

  test('a resubmit makes the one office item fresh for the Portal inbox', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    const first = await Moves.submitMove(move, { moveOutDate: '2026-11-15' }, { now: NOW });
    // Weeks later the item is old work: the inbox ages and bulk-closes by created_at.
    await db('service_requests').where({ id: first.request.id }).update({ created_at: new Date('2026-10-01T12:00:00Z') });
    const later = new Date('2026-11-03T15:00:00Z');
    const second = await Moves.submitMove(first.move, { moveOutDate: '2026-11-15', moveInDate: '2026-11-20' }, { now: later });
    expect(second.request.id).toBe(first.request.id);
    const row = await db('service_requests').where({ id: first.request.id }).first();
    expect(new Date(row.created_at).toISOString()).toBe(later.toISOString());
    expect(await db('service_requests').where({ customer_id: customerId }).count('* as n').first()).toEqual({ n: '1' });
  });

  test('markLinkSent records the channel and who sent it, and leaves a closed move alone', async () => {
    const move = await Moves.openMoveForCustomer(customerId);
    expect(await Moves.markLinkSent([move.id, move.id], { channel: 'sms', actorId: null, now: NOW })).toBe(1);
    const [listed] = await Moves.recentMoves(customerId, 1);
    expect(listed).toMatchObject({ link_channel: 'sms' });
    expect(new Date(listed.link_sent_at).toISOString()).toBe(NOW.toISOString());
    await db('customer_moves').where({ id: move.id }).update({ status: 'closed' });
    expect(await Moves.markLinkSent([move.id], { channel: 'email', now: NOW })).toBe(0);
  });

  test('the card learns where "Text moving link" opens', async () => {
    expect(await Moves.textTarget(customerId)).toMatchObject({ hasTexts: false });
  });

  test('the token is 24 random bytes in hex', () => {
    expect(crypto.randomBytes(24).toString('hex')).toMatch(Moves.TOKEN_RE);
  });
});
