'use strict';

// The Lock Screen visit card's whole life on real migrated PostgreSQL (services/visit-live-activity.js,
// GATE_VISIT_LIVE_ACTIVITY). The tracker's own state derivation, the push device scope, the notice
// preference and the service label builder all run for real; only the four Apple requests are scripted, so
// no request leaves the test. Synthetic records, rolled back after every test. Runs in the DB-gated CI step.
//
// The unit suite (visit-live-activity.test.js) pins the pure rules. This suite is the proof of what they
// cannot show: the one-live-card-per-stop claim, the order of a card's updates, and that a card is never
// left on a Lock Screen with nothing behind it.
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
  broadcast: jest.fn(),
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
    apple.broadcast.mockReset().mockResolvedValue({ ok: true });
    apple.deleteChannel.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    delete process.env.GATE_VISIT_LIVE_ACTIVITY;
    delete process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST;
    delete process.env.GATE_APP_PROPERTY_SCOPE;
    delete process.env.GATE_APP_PROPERTY_TEXTS;
    jest.restoreAllMocks();
    require('../models/db').connection = database;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  // One customer with a saved address, a technician, and one iPhone that registered for the card.
  async function seedStop({ device = {}, prefs = {}, withProperty = true, property = {} } = {}) {
    const ids = { customer: randomUUID(), property: withProperty ? randomUUID() : null, tech: randomUUID() };
    await trx('customers').insert({ id: ids.customer, first_name: 'Synthetic', last_name: 'Fixture', phone: '+19415550142', email: `${ids.customer}@example.invalid` });
    await trx('notification_prefs').insert({ customer_id: ids.customer, ...prefs }).onConflict('customer_id').merge();
    if (withProperty) {
      await trx('customer_properties').insert({ id: ids.property, customer_id: ids.customer, is_primary: true, address_line1: '12 Example Way', city: 'Bradenton', state: 'FL', zip: '34209', ...property });
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
  const complete = (id, minutes = 0) => setVisit(id, { status: 'completed', track_state: 'complete', completed_at: at(minutes) });
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

    // The same visit, read again: nothing more is sent.
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'current' });
    expect(apple.start).toHaveBeenCalledTimes(1);
    expect(apple.broadcast).not.toHaveBeenCalled();
  });

  test('arrived, then complete: one broadcast each, in order, and the card ends 15 minutes after', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    await card.syncVisit(visitId, { now: NOW });

    await arrive(visitId);
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'updated', reason: 'on_property' });
    expect(apple.broadcast.mock.calls[0][0].channelId).toBe('channel-1');
    expect(aps(apple.broadcast)).toEqual({
      timestamp: seconds(NOW) + 1,
      event: 'update',
      'content-state': { phase: 'on_property', title: 'Sam B. has arrived', detail: 'Pest Control', step: 2 },
      'stale-date': seconds(at(-1 + 120)),
    });

    await complete(visitId);
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'ended', reason: 'complete' });
    expect(aps(apple.broadcast, 1)).toEqual({
      // Each update carries a strictly later Apple timestamp, even inside one second.
      timestamp: seconds(NOW) + 2,
      event: 'end',
      'content-state': { phase: 'complete', title: 'Service complete', detail: 'Pest Control', step: 3 },
      'dismissal-date': seconds(at(15)),
    });
    const [row] = await sessions(ids.customer);
    expect(row).toMatchObject({ phase: 'complete', end_reason: 'complete', channel_deleted_at: null });
    expect(row.ended_at).not.toBeNull();

    // A finished visit never gets a second card.
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'visit_not_live' });
    expect(apple.createChannel).toHaveBeenCalledTimes(1);
  });

  test('a completed status ends the card before the tracker stamps the completion time', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    await card.syncVisit(visitId, { now: NOW });
    await setVisit(visitId, { status: 'completed' });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'ended', reason: 'complete' });
    expect(aps(apple.broadcast)['content-state'].phase).toBe('complete');
  });

  test('a rewound visit takes the card down at once, and going out again starts a new card', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    await card.syncVisit(visitId, { now: NOW });

    await setVisit(visitId, { status: 'confirmed', track_state: 'scheduled', en_route_at: null });
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'ended', reason: 'visit_not_live' });
    expect(aps(apple.broadcast)).toMatchObject({ event: 'end', 'dismissal-date': seconds(NOW) });
    // The same step again changes nothing: the card it had is the only one for it.
    await setVisit(visitId, { status: 'en_route', track_state: 'en_route', en_route_at: at(-2) });
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'none', reason: 'already_had_a_card' });

    const later = at(10);
    await setVisit(visitId, { en_route_at: at(9) });
    expect(await card.syncVisit(visitId, { now: later })).toEqual({ action: 'started', devices: 1 });
    const rows = await sessions(ids.customer);
    expect(rows.map((r) => r.channel_id)).toEqual(['channel-1', 'channel-2']);
    expect(rows.map((r) => r.end_reason)).toEqual(['visit_not_live', null]);
  });

  test('a cancelled or no-show visit takes the card down at once', async () => {
    for (const status of ['cancelled', 'no_show']) {
      const ids = await seedStop();
      const visitId = await addVisit(ids);
      await card.syncVisit(visitId, { now: NOW });
      await setVisit(visitId, { status });
      expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'ended', reason: 'visit_not_live' });
    }
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

  test('the customer\'s own switches turn the card off: app notifications, the on-the-way notice, or notices to the account holder', async () => {
    const pushOff = await seedStop({ prefs: { push_enabled: false } });
    expect(await card.syncVisit(await addVisit(pushOff), { now: NOW })).toEqual({ action: 'none', reason: 'no_device' });
    const noticeOff = await seedStop({ prefs: { tech_en_route: false } });
    expect(await card.syncVisit(await addVisit(noticeOff), { now: NOW })).toEqual({ action: 'none', reason: 'notice_off' });
    // On-the-way notices still go to the service contacts, but the holder asked not to get them: the card
    // goes only to the holder's own iPhones, so there is none.
    const holderOut = await seedStop({ prefs: { appointment_notify_primary: false } });
    expect(await card.syncVisit(await addVisit(holderOut), { now: NOW })).toEqual({ action: 'none', reason: 'notice_off' });
    expect(apple.createChannel).not.toHaveBeenCalled();
  });

  test('a saved address other than the primary one follows its own choices where those are enforced', async () => {
    const rental = { is_primary: false, relationship: 'rental_owned' };
    const family = { is_primary: false, relationship: 'family_home' };
    // Not enforced: the customer's own choices decide, whatever the address says.
    const before = await seedStop({ property: rental });
    expect(await card.syncVisit(await addVisit(before), { now: NOW })).toEqual({ action: 'started', devices: 1 });

    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    process.env.GATE_APP_PROPERTY_TEXTS = 'true';
    // A rental starts quiet until its owner turns a notice on: no card.
    const quiet = await seedStop({ property: rental });
    expect(await card.syncVisit(await addVisit(quiet), { now: NOW })).toEqual({ action: 'none', reason: 'notice_off' });
    // A family home takes the customer's choices, and its own "not to me" turns the card off.
    const inherits = await seedStop({ property: family });
    expect(await card.syncVisit(await addVisit(inherits), { now: NOW })).toEqual({ action: 'started', devices: 1 });
    const notToMe = await seedStop({ property: family });
    await trx('property_notification_prefs').insert({ property_id: notToMe.property, customer_id: notToMe.customer, appointment_notify_primary: false });
    expect(await card.syncVisit(await addVisit(notToMe), { now: NOW })).toEqual({ action: 'none', reason: 'notice_off' });
    const noticeOff = await seedStop({ property: family });
    await trx('property_notification_prefs').insert({ property_id: noticeOff.property, customer_id: noticeOff.customer, tech_en_route: false });
    expect(await card.syncVisit(await addVisit(noticeOff), { now: NOW })).toEqual({ action: 'none', reason: 'notice_off' });
    expect(apple.createChannel).toHaveBeenCalledTimes(2);
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

  test('a start with no answer may be on the phone: the row stays live and keeps its channel', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    apple.start.mockResolvedValue({ ok: false, reason: 'apns_timeout', retryable: true, uncertain: true });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'started', devices: 0, unsure: 1 });
    expect(apple.deleteChannel).not.toHaveBeenCalled();
    const [row] = await sessions(ids.customer);
    expect(row).toMatchObject({
      channel_id: 'channel-1', phase: 'en_route', devices_started: 0, ended_at: null, channel_deleted_at: null,
      start_results: [{ device: ids.device, ok: false, reason: 'apns_timeout' }],
    });
    expect(row.started_at).not.toBeNull();
    await arrive(visitId);
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'updated', reason: 'on_property' });
    expect(apple.broadcast.mock.calls[0][0].channelId).toBe('channel-1');
    // An answer from Apple that is a fault (5xx) is not "unsure": the start did not happen.
    const other = await seedStop();
    apple.start.mockResolvedValue({ ok: false, reason: 'ServiceUnavailable', retryable: true });
    expect(await card.syncVisit(await addVisit(other), { now: NOW })).toEqual({ action: 'none', reason: 'no_device_started' });
    expect(apple.deleteChannel).toHaveBeenCalledWith({ channelId: 'channel-2' });
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
    expect(await card.syncVisit(lawn, { now: NOW })).toEqual({ action: 'none', reason: 'current' });
    expect(apple.createChannel).toHaveBeenCalledTimes(1);
    expect(aps(apple.start)['content-state'].detail).toBe('Pest Control & Lawn Care');
    expect((await sessions(ids.customer))[0].member_ids.sort()).toEqual([pest, lawn].sort());

    // The first service is finished and the second was never marked arrived: the technician is at the address.
    await arrive(pest);
    await card.syncVisit(pest, { now: NOW });
    await complete(pest);
    expect(await card.syncVisit(pest, { now: NOW })).toEqual({ action: 'none', reason: 'current' });
    expect(aps(apple.broadcast)['content-state']).toMatchObject({ phase: 'on_property', title: 'Sam B. has arrived' });

    await complete(lawn);
    expect(await card.syncVisit(lawn, { now: NOW })).toEqual({ action: 'ended', reason: 'complete' });
    expect(aps(apple.broadcast, 1)['content-state']).toMatchObject({ phase: 'complete', detail: 'Pest Control & Lawn Care' });
    expect(await sessions(ids.customer)).toHaveLength(1);
  });

  test('a visit with no saved address is its own stop', async () => {
    const ids = await seedStop({ withProperty: false });
    const first = await addVisit(ids);
    const second = await addVisit(ids, { service_type: 'Lawn Care' });
    await card.syncVisit(first, { now: NOW });
    await card.syncVisit(second, { now: NOW });
    expect((await sessions(ids.customer)).map((r) => r.stop_key).sort()).toEqual([`visit:${first}`, `visit:${second}`].sort());
  });

  test('a start in progress elsewhere is left alone; one that died before it got a channel is closed', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    const stopKey = `stop:${ids.customer}:${ids.property}:${TODAY}:${ids.tech}`;
    const [claim] = await trx('live_activity_sessions').insert({
      stop_key: stopKey, customer_id: ids.customer, property_id: ids.property, technician_id: ids.tech, service_day: TODAY,
      scheduled_service_id: visitId, member_ids: JSON.stringify([visitId]), created_at: NOW, updated_at: NOW,
    }).returning('id');

    expect(await card.syncVisit(visitId, { now: at(0.5) })).toEqual({ action: 'none', reason: 'starting' });
    expect(apple.createChannel).not.toHaveBeenCalled();

    expect(await card.syncVisit(visitId, { now: at(2) })).toEqual({ action: 'ended', reason: 'start_abandoned' });
    expect(apple.broadcast).not.toHaveBeenCalled();
    expect(await trx('live_activity_sessions').where({ id: claim.id }).first()).toMatchObject({ end_reason: 'start_abandoned' });
    // The stop is free again, but this step already had its one card.
    expect(await card.syncVisit(visitId, { now: at(2) })).toEqual({ action: 'none', reason: 'already_had_a_card' });
  });

  test('a start that died after its channel is taken over: the card is brought up to date and ended with the visit', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    await trx('live_activity_sessions').insert({
      stop_key: `stop:${ids.customer}:${ids.property}:${TODAY}:${ids.tech}`, customer_id: ids.customer, property_id: ids.property,
      technician_id: ids.tech, service_day: TODAY, scheduled_service_id: visitId, member_ids: JSON.stringify([visitId]),
      channel_id: 'channel-orphan', created_at: NOW, updated_at: NOW,
    });

    expect(await card.syncVisit(visitId, { now: at(2) })).toEqual({ action: 'updated', reason: 'en_route' });
    expect(apple.broadcast.mock.calls[0][0].channelId).toBe('channel-orphan');
    await complete(visitId, 3);
    expect(await card.syncVisit(visitId, { now: at(3) })).toEqual({ action: 'ended', reason: 'complete' });
  });

  test('a failed update is sent again by the next pass; only Apple\'s refusal of the channel closes the card', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    await card.syncVisit(visitId, { now: NOW });
    await arrive(visitId);

    apple.broadcast.mockResolvedValueOnce({ ok: false, reason: 'apns_timeout', retryable: true });
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'failed', reason: 'apns_timeout' });
    expect((await sessions(ids.customer))[0]).toMatchObject({ phase: 'en_route', ended_at: null });

    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'updated', reason: 'on_property' });
    // The second try carries a later Apple timestamp than the first, so the phone keeps the newest.
    expect(aps(apple.broadcast, 1).timestamp).toBeGreaterThan(aps(apple.broadcast, 0).timestamp);

    // A refusal that is not about the channel (a bad key, a refused payload) can be fixed, and the card is
    // still on the phone: the row stays live and the end is sent by a later pass.
    await complete(visitId);
    apple.broadcast.mockResolvedValueOnce({ ok: false, reason: 'InvalidProviderToken' });
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'failed', reason: 'InvalidProviderToken' });
    expect((await sessions(ids.customer))[0]).toMatchObject({ phase: 'on_property', ended_at: null });
    expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'ended', reason: 'complete' });
    expect(aps(apple.broadcast, 3)).toMatchObject({ event: 'end', 'content-state': { phase: 'complete' } });

    // Apple refuses the channel itself: no update can reach the card, so its row is closed.
    const gone = await seedStop();
    const goneVisit = await addVisit(gone);
    await card.syncVisit(goneVisit, { now: NOW });
    await arrive(goneVisit);
    apple.broadcast.mockResolvedValueOnce({ ok: false, reason: 'BadChannelId' });
    expect(await card.syncVisit(goneVisit, { now: NOW })).toEqual({ action: 'ended', reason: 'refused' });
    expect((await sessions(gone.customer))[0].end_reason).toBe('refused:BadChannelId');
  });

  test('an update loses its turn to a newer one: it sends nothing and reads again', async () => {
    const ids = await seedStop();
    const visitId = await addVisit(ids);
    await card.syncVisit(visitId, { now: NOW });
    await arrive(visitId);
    // Another process takes the next place between this pass's read of the card and its claim (the label
    // lookup runs between the two).
    const reminders = require('../services/appointment-reminders');
    const realLabel = reminders.buildServiceLabel;
    let stolen = false;
    const spy = jest.spyOn(reminders, 'buildServiceLabel').mockImplementation(async (...args) => {
      if (!stolen) {
        stolen = true;
        await trx.raw('UPDATE live_activity_sessions SET seq = seq + 1, push_ts = push_ts + 5 WHERE customer_id = ?', [ids.customer]);
      }
      return realLabel(...args);
    });
    try {
      expect(await card.syncVisit(visitId, { now: NOW })).toEqual({ action: 'updated', reason: 'on_property' });
    } finally {
      spy.mockRestore();
    }
    // One broadcast only (the pass that lost its turn sent nothing), stamped after the other sender's.
    expect(apple.broadcast).toHaveBeenCalledTimes(1);
    expect(aps(apple.broadcast).timestamp).toBe(seconds(NOW) + 6);
  });

  describe('the 2-minute sweep', () => {
    test('a step past its time limit: the card is taken down at once', async () => {
      const ids = await seedStop();
      const visitId = await addVisit(ids);
      await card.syncVisit(visitId, { now: NOW });

      expect(await card.sweep({ now: at(60) })).toMatchObject({ cards: 1, ended: 0, updated: 0 });
      expect(await card.sweep({ now: at(88) })).toMatchObject({ cards: 1, ended: 1 });
      expect(aps(apple.broadcast)).toMatchObject({ event: 'end', 'dismissal-date': seconds(at(88)) });
      expect((await sessions(ids.customer))[0].end_reason).toBe('time_limit');
    });

    test('a step the poke missed is sent, and a live visit with no card gets one', async () => {
      const withCard = await seedStop();
      const first = await addVisit(withCard);
      await card.syncVisit(first, { now: NOW });
      await arrive(first);
      const noCard = await seedStop();
      await addVisit(noCard);
      const tooOld = await seedStop();
      await addVisit(tooOld, { en_route_at: at(-40) });

      expect(await card.sweep({ now: NOW })).toMatchObject({ cards: 1, updated: 1, started: 1, failed: 0 });
      expect(await sessions(noCard.customer)).toHaveLength(1);
      expect(await sessions(tooOld.customer)).toHaveLength(0);
    });

    test('gate off: every live card is taken down and nothing starts', async () => {
      const ids = await seedStop();
      const visitId = await addVisit(ids);
      await card.syncVisit(visitId, { now: NOW });
      const other = await seedStop();
      await addVisit(other);

      delete process.env.GATE_VISIT_LIVE_ACTIVITY;
      expect(await card.sweep({ now: NOW })).toMatchObject({ cards: 1, ended: 1, started: 0 });
      expect(aps(apple.broadcast)).toMatchObject({ event: 'end', 'dismissal-date': seconds(NOW) });
      expect((await sessions(ids.customer))[0].end_reason).toBe('gate_off');
      expect(await sessions(other.customer)).toHaveLength(0);
    });

    test('a customer taken off the allowlist loses the card', async () => {
      const ids = await seedStop();
      const visitId = await addVisit(ids);
      await card.syncVisit(visitId, { now: NOW });
      process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST = randomUUID();
      expect(await card.sweep({ now: NOW })).toMatchObject({ ended: 1 });
      expect((await sessions(ids.customer))[0].end_reason).toBe('not_on_the_list');
    });

    test('a channel is removed 9 hours after its card ended, not before', async () => {
      const ids = await seedStop();
      const visitId = await addVisit(ids);
      await card.syncVisit(visitId, { now: NOW });
      await complete(visitId);
      await card.syncVisit(visitId, { now: NOW });

      expect(await card.sweep({ now: at(8 * 60) })).toMatchObject({ channelsRemoved: 0 });
      expect(apple.deleteChannel).not.toHaveBeenCalled();

      // A failure that is not about the channel (a timeout, a bad key) is tried again by the next sweep.
      apple.deleteChannel.mockResolvedValueOnce({ ok: false, reason: 'apns_timeout', retryable: true });
      expect(await card.sweep({ now: at(9 * 60 + 1) })).toMatchObject({ channelsRemoved: 0 });
      apple.deleteChannel.mockResolvedValueOnce({ ok: false, reason: 'InvalidProviderToken' });
      expect(await card.sweep({ now: at(9 * 60 + 3) })).toMatchObject({ channelsRemoved: 0 });
      expect((await sessions(ids.customer))[0].channel_deleted_at).toBeNull();
      expect(await card.sweep({ now: at(9 * 60 + 5) })).toMatchObject({ channelsRemoved: 1 });
      expect(apple.deleteChannel).toHaveBeenLastCalledWith({ channelId: 'channel-1' });
      expect((await sessions(ids.customer))[0].channel_deleted_at).not.toBeNull();
      expect(await card.sweep({ now: at(9 * 60 + 7) })).toMatchObject({ channelsRemoved: 0 });
      expect(apple.deleteChannel).toHaveBeenCalledTimes(3);
    });

    test('a channel Apple no longer knows counts as removed; one that will not go is left after a day of tries', async () => {
      const refused = await seedStop();
      const refusedVisit = await addVisit(refused);
      await card.syncVisit(refusedVisit, { now: NOW });
      await complete(refusedVisit);
      await card.syncVisit(refusedVisit, { now: NOW });
      apple.deleteChannel.mockResolvedValueOnce({ ok: false, reason: 'BadChannelId' });
      expect(await card.sweep({ now: at(9 * 60 + 1) })).toMatchObject({ channelsRemoved: 1 });

      const stuck = await seedStop();
      const stuckVisit = await addVisit(stuck);
      await card.syncVisit(stuckVisit, { now: NOW });
      await complete(stuckVisit);
      await card.syncVisit(stuckVisit, { now: NOW });
      apple.deleteChannel.mockReset().mockResolvedValue({ ok: false, reason: 'InvalidProviderToken' });
      expect(await card.sweep({ now: at(33 * 60 - 1) })).toMatchObject({ channelsRemoved: 0 });
      expect(apple.deleteChannel).toHaveBeenCalledTimes(1);
      // A day after its 9 hours were up, the sweep stops asking.
      expect(await card.sweep({ now: at(33 * 60 + 1) })).toMatchObject({ channelsRemoved: 0 });
      expect(apple.deleteChannel).toHaveBeenCalledTimes(1);
    });

    test('every live card, every new live visit and every old channel is met, however many pages they fill', async () => {
      const cards = [];
      for (let i = 0; i < 3; i += 1) {
        const ids = await seedStop();
        const visitId = await addVisit(ids);
        await card.syncVisit(visitId, { now: NOW });
        await arrive(visitId);
        cards.push({ ids, visitId });
      }
      const fresh = [await seedStop(), await seedStop(), await seedStop()];
      for (const ids of fresh) await addVisit(ids);

      // One row to a page: nothing is left for a later sweep.
      expect(await card.sweep({ now: NOW, pageSize: 1 })).toMatchObject({ cards: 3, updated: 3, started: 3, failed: 0 });

      for (const { visitId } of cards) {
        await complete(visitId);
        await card.syncVisit(visitId, { now: NOW });
      }
      expect(await card.sweep({ now: at(9 * 60 + 1), pageSize: 1 })).toMatchObject({ channelsRemoved: 3 });
    });

    test('one failing stop does not stop the sweep', async () => {
      const bad = await seedStop();
      const badVisit = await addVisit(bad);
      await card.syncVisit(badVisit, { now: NOW });
      const good = await seedStop();
      const goodVisit = await addVisit(good);
      await card.syncVisit(goodVisit, { now: NOW });
      await arrive(badVisit);
      await arrive(goodVisit);
      apple.broadcast.mockRejectedValueOnce(new Error('socket closed'));

      expect(await card.sweep({ now: NOW })).toMatchObject({ cards: 2, failed: 1, updated: 1 });
    });
  });
});
