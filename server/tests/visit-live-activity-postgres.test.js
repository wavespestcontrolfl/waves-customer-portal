'use strict';

// How a Lock Screen visit card starts, on real migrated PostgreSQL (services/visit-live-activity.js,
// GATE_VISIT_LIVE_ACTIVITY). The tracker's own state derivation, the push device scope, the notice
// preference and the service label builder all run for real; only the Apple requests are scripted, so no
// request leaves the test. Synthetic records, rolled back after every test. Runs in the DB-gated CI step.
//
// The unit suite (visit-live-activity.test.js) pins the pure rules. This suite is the proof of what they
// cannot show: who gets a card, the one-live-card-per-stop claim, and one chance per step.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(120000);

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Apple: the payload builder is real, the four senders are scripted.
jest.mock('../services/apns-live-activity', () => ({
  ...jest.requireActual('../services/apns-live-activity'),
  createChannel: jest.fn(),
  start: jest.fn(),
  deleteChannel: jest.fn(),
}));

const { randomUUID } = require('node:crypto');
const { etDateString } = require('../utils/datetime-et');
const apns = require('../services/apns');
const apple = require('../services/apns-live-activity');
const card = require('../services/visit-live-activity');

postgres('Lock Screen visit card against migrated PostgreSQL', () => {
  let database;
  let trx;
  let channels;
  const NOW = new Date();
  const TODAY = etDateString(NOW);
  const at = (minutesFromNow) => new Date(NOW.getTime() + minutesFromNow * 60 * 1000);
  const seconds = (date) => Math.floor(date.getTime() / 1000);
  const START_TOKEN = 'a1b2c3d4'.repeat(8);

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    process.env.GATE_VISIT_LIVE_ACTIVITY = 'true';
    delete process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST;
    channels = 0;
    // The test server has no Apple key. The card only asks whether one is configured.
    jest.spyOn(apns, 'status').mockReturnValue({ configured: true, production: true, bundleId: 'com.wavespestcontrol.portal' });
    apple.createChannel.mockReset().mockImplementation(async () => { channels += 1; return { ok: true, channelId: `channel-${channels}` }; });
    apple.start.mockReset().mockResolvedValue({ ok: true });
    apple.deleteChannel.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    delete process.env.GATE_VISIT_LIVE_ACTIVITY;
    delete process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST;
    jest.restoreAllMocks();
    require('../models/db').connection = database;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  // One customer with a saved address, a technician, and one iPhone that registered for the card.
  async function seedStop({ device = {}, prefs = {}, withProperty = true } = {}) {
    const ids = { customer: randomUUID(), property: withProperty ? randomUUID() : null, tech: randomUUID() };
    await trx('customers').insert({ id: ids.customer, first_name: 'Synthetic', last_name: 'Fixture', phone: '+19415550142', email: `${ids.customer}@example.invalid` });
    await trx('notification_prefs').insert({ customer_id: ids.customer, ...prefs }).onConflict('customer_id').merge();
    if (withProperty) {
      await trx('customer_properties').insert({ id: ids.property, customer_id: ids.customer, is_primary: true, address_line1: '12 Example Way', city: 'Bradenton', state: 'FL', zip: '34209' });
    }
    await trx('technicians').insert({ id: ids.tech, name: 'Sam Brook' });
    if (device !== null) ids.device = await addPhone(ids.customer, device);
    return ids;
  }

  async function addPhone(customerId, over = {}) {
    const id = randomUUID();
    await trx('push_subscriptions').insert({
      id, customer_id: customerId, role: 'customer', platform: 'ios', device_token: `device-${id}`, subscription_data: '{}', active: true,
      live_activity_start_token: START_TOKEN, live_activity_os_major: 18, ...over,
    });
    return id;
  }

  async function addVisit(ids, over = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: ids.customer, property_id: ids.property, technician_id: ids.tech, scheduled_date: TODAY,
      service_type: 'Pest Control', status: 'en_route', track_state: 'en_route', en_route_at: at(-2), ...over,
    });
    return id;
  }

  const setVisit = (id, patch) => trx('scheduled_services').where({ id }).update(patch);
  const arrive = (id, minutes = -1) => setVisit(id, { status: 'on_site', track_state: 'on_property', arrived_at: at(minutes) });
  const sessions = (customerId) => trx('live_activity_sessions').where({ customer_id: customerId }).orderBy('created_at', 'asc');
  const aps = (mock, call = 0) => mock.mock.calls[call][0].payload.aps;

  test('on the way: one channel, one start push to the registered iPhone, and the card\'s row', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'started', devices: 1 });

    const [row] = await sessions(ids.customer);
    expect(apple.createChannel).toHaveBeenCalledTimes(1);
    expect(apple.start).toHaveBeenCalledTimes(1);
    const sent = apple.start.mock.calls[0][0];
    expect(sent.startToken).toBe(START_TOKEN);
    expect(seconds(sent.expiresAt)).toBe(seconds(at(20)));
    expect(sent.payload.aps).toEqual({
      timestamp: seconds(NOW),
      event: 'start',
      'content-state': { phase: 'en_route', title: 'Sam B. is on the way', detail: 'Pest Control', step: 1 },
      'attributes-type': 'WavesVisitAttributes',
      attributes: { visitRef: row.id },
      'input-push-channel': 'channel-1',
      alert: { title: 'Waves', body: 'Sam B. is on the way.' },
      'stale-date': seconds(at(-2 + 45)),
    });
    expect(row).toMatchObject({
      stop_key: `stop:${ids.customer}:${ids.property}:${TODAY}:${ids.tech}`,
      channel_id: 'channel-1', phase: 'en_route', devices_started: 1, member_ids: [visitId], ended_at: null,
    });

    // The same visit, read again: the stop has its card, so nothing more is sent.
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'card_live' });
    expect(apple.createChannel).toHaveBeenCalledTimes(1);
    expect(apple.start).toHaveBeenCalledTimes(1);
  });

  test('who gets a card: only an active account-holder iPhone on iOS 18 that registered, and no channel is made for anyone else', async () => {
    const cases = [
      ['no app device', null],
      ['no start token', { live_activity_start_token: null }],
      ['iOS 17', { live_activity_os_major: 17 }],
      ['no iOS version reported', { live_activity_os_major: null }],
      ['signed out', { active: false }],
      ['an Android phone', { platform: 'android' }],
      ['a contact\'s phone', { contact_phone_key: '9415550199' }],
    ];
    for (const [label, device] of cases) {
      const ids = await seedStop({ device });
      const visitId = await addVisit(ids);
      expect([label, await card.syncVisit(visitId, { now: NOW })]).toEqual([label, { action: 'none', reason: 'no_device' }]);
    }
    expect(apple.createChannel).not.toHaveBeenCalled();
    expect(await trx('live_activity_sessions').count('* as n').first()).toEqual({ n: '0' });
  });

  test('the customer\'s own switches turn the card off: app notifications off, or the on-the-way notice off', async () => {
    const pushOff = await seedStop({ prefs: { push_enabled: false } });
    expect(await card.syncVisit(await addVisit(pushOff), { now: NOW })).toEqual({ action: 'none', reason: 'no_device' });
    const noticeOff = await seedStop({ prefs: { tech_en_route: false } });
    expect(await card.syncVisit(await addVisit(noticeOff), { now: NOW })).toEqual({ action: 'none', reason: 'notice_off' });
    expect(apple.createChannel).not.toHaveBeenCalled();
  });

  test('the allowlist narrows the gate to its customers, and a late or gated-off visit starts nothing', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST = randomUUID();
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'not_on_the_list' });
    process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST = `${randomUUID()}, ${ids.customer}`;
    expect(await card.syncVisit(visitId, { now: at(19) })).toEqual({ action: 'none', reason: 'too_late' });
    delete process.env.GATE_VISIT_LIVE_ACTIVITY;
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'gate_off' });
    expect(apple.createChannel).not.toHaveBeenCalled();
    process.env.GATE_VISIT_LIVE_ACTIVITY = 'true';
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'started', devices: 1 });
  });

  test('two iPhones on the account: one channel, a start on each; a dead start token is cleared', async () => {
    const ids = await seedStop();
    const second = await addPhone(ids.customer, { live_activity_start_token: 'ffee'.repeat(16) });
    const visitId = await addVisit(ids);
    apple.start.mockImplementation(async ({ startToken }) => (startToken === START_TOKEN
      ? { ok: true }
      : { ok: false, reason: 'Unregistered', expired: true }));

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'started', devices: 1 });
    expect(apple.createChannel).toHaveBeenCalledTimes(1);
    expect(apple.start).toHaveBeenCalledTimes(2);
    const phones = await trx('push_subscriptions').whereIn('id', [ids.device, second]).select('id', 'live_activity_start_token', 'active');
    expect(phones.find((p) => p.id === ids.device)).toMatchObject({ live_activity_start_token: START_TOKEN, active: true });
    // Only the card's token is cleared: the phone still gets its notifications.
    expect(phones.find((p) => p.id === second)).toMatchObject({ live_activity_start_token: null, active: true });
    // Apple's answer for each phone is kept on the card's row.
    const [row] = await sessions(ids.customer);
    expect([...row.start_results].sort((a, b) => Number(b.ok) - Number(a.ok))).toEqual([
      { device: ids.device, ok: true, reason: null },
      { device: second, ok: false, reason: 'Unregistered' },
    ]);
  });

  test('no iPhone took the start: the channel is removed and the same step is not tried again', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    apple.start.mockResolvedValue({ ok: false, reason: 'BadDeviceToken' });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'no_device_started' });
    expect(apple.deleteChannel).toHaveBeenCalledWith({ channelId: 'channel-1' });
    const [row] = await sessions(ids.customer);
    expect(row.end_reason).toBe('no_device_started:BadDeviceToken');
    expect(row.channel_deleted_at).not.toBeNull();
    // A 400 is not proof the token is dead (it is also a wrong-host answer), so it stays.
    expect((await trx('push_subscriptions').where({ id: ids.device }).first()).live_activity_start_token).toBe(START_TOKEN);

    apple.start.mockResolvedValue({ ok: true });
    expect(await card.syncVisit(visitId, { now: at(1) })).toEqual({ action: 'none', reason: 'already_had_a_card' });
    // The next step is a new chance.
    await arrive(visitId, 2);
    expect(await card.syncVisit(visitId, { now: at(3) })).toEqual({ action: 'started', devices: 1 });
    expect(aps(apple.start, 1)['content-state']).toMatchObject({ phase: 'on_property', title: 'Sam B. has arrived' });
  });

  test('Apple refuses the channel (Broadcast Capability off): no start push, the row says why', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    apple.createChannel.mockResolvedValue({ ok: false, reason: 'FeatureNotEnabled' });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'no_channel' });
    expect(apple.start).not.toHaveBeenCalled();
    const [row] = await sessions(ids.customer);
    expect(row).toMatchObject({ end_reason: 'no_channel:FeatureNotEnabled', channel_id: null });
  });

  test('a server with no Apple key writes no row and asks Apple nothing', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    apns.status.mockReturnValue({ configured: false });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'apns_not_configured' });
    expect(apple.createChannel).not.toHaveBeenCalled();
    expect(await sessions(ids.customer)).toHaveLength(0);
  });

  test('two passes start the same stop at once: the second gets no row and sends nothing', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    // The other pass claims the stop after this one saw no card (the device read runs between the two).
    const push = require('../services/push-notifications');
    const realContext = push.customerPushContext;
    jest.spyOn(push, 'customerPushContext').mockImplementation(async (...args) => {
      await trx('live_activity_sessions').insert({
        stop_key: `stop:${ids.customer}:${ids.property}:${TODAY}:${ids.tech}`, customer_id: ids.customer, property_id: ids.property,
        technician_id: ids.tech, service_day: TODAY, scheduled_service_id: visitId, created_at: NOW, updated_at: NOW,
      });
      return realContext(...args);
    });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'starting' });
    expect(apple.createChannel).not.toHaveBeenCalled();
    expect(apple.start).not.toHaveBeenCalled();
    expect(await sessions(ids.customer)).toHaveLength(1);
  });

  test('two services at one address, one technician, one day: ONE card that names both', async () => {
    const ids = await seedStop();
    const pest = await addVisit(ids, { window_start: '09:00' });
    const lawn = await addVisit(ids, { service_type: 'Lawn Care', window_start: '09:30' });

    expect(await card.syncVisit(pest, { now: NOW })).toEqual({ action: 'started', devices: 1 });
    expect(await card.syncVisit(lawn, { now: NOW })).toEqual({ action: 'none', reason: 'card_live' });
    expect(apple.createChannel).toHaveBeenCalledTimes(1);
    expect(aps(apple.start)['content-state'].detail).toBe('Pest Control & Lawn Care');
    expect((await sessions(ids.customer))[0].member_ids.sort()).toEqual([pest, lawn].sort());
  });

  test('a visit with no saved address is its own stop', async () => {
    const ids = await seedStop({ withProperty: false });
    const first = await addVisit(ids);
    const second = await addVisit(ids, { service_type: 'Lawn Care' });
    await card.syncVisit(first, { now: NOW });
    await card.syncVisit(second, { now: NOW });
    expect((await sessions(ids.customer)).map((r) => r.stop_key).sort()).toEqual([`visit:${first}`, `visit:${second}`].sort());
  });
});
