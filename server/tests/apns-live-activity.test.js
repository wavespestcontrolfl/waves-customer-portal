'use strict';

// Apple requests for the Lock Screen visit card (services/apns-live-activity.js). Apple's servers decide
// whether a card starts, so the wire shape is the contract: the paths, the headers and the payload keys
// are pinned here against Apple's documents ("Starting and updating Live Activities with ActivityKit push
// notifications", "Sending broadcast push notification requests to APNs", "Sending channel management
// requests to APNs"). No request leaves the test: each sender takes the function that sends.

const mockApnsStatus = { configured: true, production: true, bundleId: 'com.wavespestcontrol.portal' };
jest.mock('../services/apns', () => ({
  status: () => mockApnsStatus,
  providerToken: () => 'provider-token',
  APNS_REQUEST_TIMEOUT_MS: 8000,
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const la = require('../services/apns-live-activity');

const NOW = '2026-11-12T15:00:00.000Z';
const NOW_S = Date.parse(NOW) / 1000;
const state = { phase: 'en_route', title: 'Sam is on the way', detail: 'Pest Control', step: 1 };

beforeEach(() => { mockApnsStatus.production = true; mockApnsStatus.configured = true; });

describe('payloads', () => {
  test('a start carries every key Apple requires, the channel the card listens on, and no sound', () => {
    const payload = la.buildPayload({
      event: 'start', now: NOW, contentState: state, attributes: { visitRef: 'session-1' },
      alert: { title: 'Waves', body: 'Sam is on the way.' }, channelId: 'Y2hhbm5lbA==', staleAt: '2026-11-12T16:15:00.000Z',
    });
    expect(payload).toEqual({
      aps: {
        timestamp: NOW_S,
        event: 'start',
        'content-state': state,
        'attributes-type': 'WavesVisitAttributes',
        attributes: { visitRef: 'session-1' },
        'input-push-channel': 'Y2hhbm5lbA==',
        alert: { title: 'Waves', body: 'Sam is on the way.' },
        'stale-date': NOW_S + 75 * 60,
      },
    });
  });

  test('an update carries only the new state and its stale time', () => {
    const payload = la.buildPayload({ event: 'update', now: NOW, contentState: { ...state, phase: 'on_property', step: 2 }, staleAt: '2026-11-12T16:30:00.000Z' });
    expect(payload).toEqual({
      aps: { timestamp: NOW_S, event: 'update', 'content-state': { ...state, phase: 'on_property', step: 2 }, 'stale-date': NOW_S + 90 * 60 },
    });
  });

  test('an end carries the final state and when the card leaves the Lock Screen, and never a stale time', () => {
    const payload = la.buildPayload({
      event: 'end', now: NOW, contentState: { ...state, phase: 'complete', step: 3 },
      staleAt: '2026-11-12T16:30:00.000Z', dismissAt: '2026-11-12T15:15:00.000Z',
    });
    expect(payload).toEqual({
      aps: { timestamp: NOW_S, event: 'end', 'content-state': { ...state, phase: 'complete', step: 3 }, 'dismissal-date': NOW_S + 15 * 60 },
    });
  });
});

describe('requests', () => {
  test('a start goes to the phone\'s own token on the push host, on the live-activity topic', () => {
    const req = la.startRequest({ startToken: 'abc123', payload: { aps: {} }, expiresAt: '2026-11-12T15:20:00.000Z' });
    expect(req).toEqual({
      origin: 'https://api.push.apple.com',
      method: 'POST',
      path: '/3/device/abc123',
      headers: {
        'apns-topic': 'com.wavespestcontrol.portal.push-type.liveactivity',
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
        'apns-expiration': String(NOW_S + 20 * 60),
      },
      body: { aps: {} },
    });
  });

  test('a broadcast goes to the app\'s broadcast path and names its channel', () => {
    const req = la.broadcastRequest({ channelId: 'Y2hhbm5lbA==', payload: { aps: {} }, expiresAt: '2026-11-12T18:00:00.000Z' });
    expect(req.origin).toBe('https://api.push.apple.com');
    expect(req.path).toBe('/4/broadcasts/apps/com.wavespestcontrol.portal');
    expect(req.headers).toEqual({
      'apns-channel-id': 'Y2hhbm5lbA==',
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': String(NOW_S + 3 * 3600),
    });
  });

  test('channels are made and removed on the manage host, which differs by environment', () => {
    expect(la.createChannelRequest()).toEqual({
      origin: 'https://api-manage-broadcast.push.apple.com:2196',
      method: 'POST',
      path: '/1/apps/com.wavespestcontrol.portal/channels',
      headers: {},
      body: { 'message-storage-policy': 1, 'push-type': 'LiveActivity' },
    });
    mockApnsStatus.production = false;
    expect(la.createChannelRequest().origin).toBe('https://api-manage-broadcast.sandbox.push.apple.com:2195');
    expect(la.startRequest({ startToken: 'abc', payload: {}, expiresAt: NOW }).origin).toBe('https://api.sandbox.push.apple.com');
    expect(la.deleteChannelRequest({ channelId: 'Y2hhbm5lbA==' })).toEqual({
      origin: 'https://api-manage-broadcast.sandbox.push.apple.com:2195',
      method: 'DELETE',
      path: '/1/apps/com.wavespestcontrol.portal/channels',
      headers: { 'apns-channel-id': 'Y2hhbm5lbA==' },
      body: null,
    });
  });
});

describe('results', () => {
  const sends = (result) => jest.fn(async () => result);

  test('a start Apple accepts is ok', async () => {
    expect(await la.start({ startToken: 'abc', payload: {}, expiresAt: NOW }, sends({ ok: true, status: 200 }))).toEqual({ ok: true });
  });

  test('only a 410 marks the start token dead; a 400 BadDeviceToken does not (it is also a wrong-host answer)', async () => {
    const dead = await la.start({ startToken: 'abc', payload: {}, expiresAt: NOW }, sends({ ok: false, status: 410, reason: 'Unregistered' }));
    expect(dead).toEqual({ ok: false, reason: 'Unregistered', expired: true });
    const mismatch = await la.start({ startToken: 'abc', payload: {}, expiresAt: NOW }, sends({ ok: false, status: 400, reason: 'BadDeviceToken' }));
    expect(mismatch).toEqual({ ok: false, reason: 'BadDeviceToken' });
  });

  test('a new channel\'s id comes from the response header; a success without one is a failure', async () => {
    const made = await la.createChannel(sends({ ok: true, status: 201, headers: { 'apns-channel-id': 'Y2hhbm5lbA==' } }));
    expect(made).toEqual({ ok: true, channelId: 'Y2hhbm5lbA==' });
    expect(await la.createChannel(sends({ ok: true, status: 201, headers: {} }))).toEqual({ ok: false, reason: 'no_channel_id' });
    // Broadcast Capability off on the app id is a refusal here, not a crash.
    expect(await la.createChannel(sends({ ok: false, status: 403, reason: 'FeatureNotEnabled' }))).toEqual({ ok: false, reason: 'FeatureNotEnabled' });
  });

  test('a channel that is already gone counts as removed', async () => {
    expect(await la.deleteChannel({ channelId: 'x' }, sends({ ok: false, status: 404, reason: 'NotFound' }))).toEqual({ ok: true });
    expect(await la.deleteChannel({ channelId: 'x' }, sends({ ok: true, status: 204 }))).toEqual({ ok: true });
  });

  test('a broadcast failure keeps the retry hint, and an unconfigured server is a skip', async () => {
    const timeout = await la.broadcast({ channelId: 'x', payload: {}, expiresAt: NOW }, sends({ ok: false, retryable: true, reason: 'apns_timeout' }));
    expect(timeout).toEqual({ ok: false, reason: 'apns_timeout', retryable: true });
    const skipped = await la.broadcast({ channelId: 'x', payload: {}, expiresAt: NOW }, sends({ ok: false, skipped: true, reason: 'apns_not_configured' }));
    expect(skipped).toEqual({ ok: false, reason: 'apns_not_configured', skipped: true });
  });

  test('with APNs not configured the real sender answers a skip and opens no connection', async () => {
    mockApnsStatus.configured = false;
    expect(await la.broadcast({ channelId: 'x', payload: {}, expiresAt: NOW })).toEqual({ ok: false, reason: 'apns_not_configured', skipped: true });
  });
});
