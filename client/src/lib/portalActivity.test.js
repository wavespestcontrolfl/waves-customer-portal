// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const beacon = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ value: 'web' }));
const jwtFor = (payload) => {
  const enc = (v) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
};
vi.mock('../utils/api', async () => {
  const { tokenSessionIdentity } = await vi.importActual('../utils/api');
  return { default: { sendActivityBeacon: beacon }, tokenSessionIdentity };
});
vi.mock('../native/platform', () => ({ nativePlatform: () => platform.value }));

import {
  reportPortalHeartbeat, reportPortalPageView, reportPushOpen, resetPortalActivityForTests, RESEND_SAME_ROUTE_MS,
} from './portalActivity';

beforeEach(() => {
  beacon.mockReset();
  beacon.mockResolvedValue({ ok: true, enabled: true });
  platform.value = 'web';
  localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-a', sessionId: 'fam-a' }));
  resetPortalActivityForTests();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('portal page-view beacon', () => {
  it('posts only the tab id and the platform hint', async () => {
    platform.value = 'ios';
    reportPortalPageView('visits');
    await flush();
    expect(beacon).toHaveBeenCalledWith('/customer/activity/page-view', { route: 'visits', platform: 'ios' });
  });

  it('reports an unknown Capacitor platform as web', async () => {
    platform.value = 'electron';
    reportPortalPageView('plan');
    await flush();
    expect(beacon.mock.calls[0][1].platform).toBe('web');
  });

  it('does not resend the same tab inside the server dedupe window (10 minutes), but sends other tabs', () => {
    // Pinned to the server's DEDUPE_MINUTES (customer-page-views.js): a shorter memo
    // sends beacons the server discards; a longer one loses a revisit.
    expect(RESEND_SAME_ROUTE_MS).toBe(10 * 60 * 1000);
    reportPortalPageView('visits', 1_000);
    reportPortalPageView('visits', 1_000 + 4 * 60_000);
    reportPortalPageView('billing', 1_000 + 4 * 60_000);
    reportPortalPageView('visits', 1_000 + 6 * 60_000);
    reportPortalPageView('visits', 1_000 + 10 * 60_000 - 1);
    expect(beacon.mock.calls.map((c) => c[1].route)).toEqual(['visits', 'billing']);
    // the first moment the server would record it again, the client sends it
    reportPortalPageView('visits', 1_000 + 10 * 60_000);
    expect(beacon.mock.calls.map((c) => c[1].route)).toEqual(['visits', 'billing', 'visits']);
  });

  it('does not carry the same-tab memo across a logout / sign-in as another customer', () => {
    reportPortalPageView('visits', 1_000);
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-b', sessionId: 'fam-b' }));
    reportPortalPageView('visits', 1_000 + 60_000); // B inside A's window
    reportPortalPageView('visits', 1_000 + 2 * 60_000); // B again: still deduped for B
    expect(beacon).toHaveBeenCalledTimes(2);
    // Same customer, new session family (logout + login) also starts fresh.
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-b', sessionId: 'fam-b2' }));
    reportPortalPageView('visits', 1_000 + 3 * 60_000);
    expect(beacon).toHaveBeenCalledTimes(3);
    // Signed-out then A back: A's old memo is not what decides for B, and A is deduped by A's own key.
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-a', sessionId: 'fam-a' }));
    reportPortalPageView('visits', 1_000 + 4 * 60_000);
    expect(beacon).toHaveBeenCalledTimes(3);
  });

  it('stops beaconing for the session once the server says the gate is off', async () => {
    beacon.mockResolvedValue({ ok: true, enabled: false });
    reportPortalPageView('visits');
    await flush();
    reportPortalPageView('billing');
    reportPushOpen({ notificationId: 'x' });
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing beacon', async () => {
    beacon.mockRejectedValue(new Error('offline'));
    expect(() => reportPortalPageView('visits')).not.toThrow();
    await flush();
    reportPortalPageView('billing', Date.now());
    await flush();
    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty or non-string route', () => {
    reportPortalPageView('');
    reportPortalPageView(null);
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe('push-open beacon', () => {
  it('sends only the notification id and the platform hint (capped), never a tap id, tag or category', async () => {
    platform.value = 'android';
    reportPushOpen({ notificationId: 'n-1', category: 'billing', tag: 'push-routed:receipt', url: '/?tab=billing', extra: 'ignored' });
    await flush();
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', { platform: 'android', notificationId: 'n-1' });
    reportPushOpen({ notificationId: 'x'.repeat(200) });
    await flush();
    expect(beacon.mock.calls[1][1].notificationId).toHaveLength(80);
  });

  it('a bare push (no notification id) still POSTs once: the server decides whether it counts', async () => {
    reportPushOpen({ tag: 'push-routed:receipt', category: 'appointment' });
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', { platform: 'web', notificationId: undefined });
    reportPushOpen(undefined);
    await flush();
    expect(beacon).toHaveBeenCalledTimes(2);
  });
});

describe('push-open: one fire-and-forget beacon, nothing parked or replayed', () => {
  const tapFor = (target) => ({ notificationId: 'n-t', url: `/?tab=visits&notificationProperty=${target}` });

  it('a tap with no target profile sends exactly one POST and stores nothing', async () => {
    reportPushOpen({ notificationId: 'n-1', url: '/?tab=billing' });
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', expect.objectContaining({ notificationId: 'n-1' }));
    expect(localStorage.getItem('waves_pending_push_open')).toBeNull();
  });

  it('a tap that targets another profile records nothing at all', async () => {
    reportPushOpen(tapFor('cust-b'));
    await flush();
    expect(beacon).not.toHaveBeenCalled();
    expect(localStorage.getItem('waves_pending_push_open')).toBeNull();
  });

  it('a tap that targets the active profile sends exactly one POST', async () => {
    reportPushOpen(tapFor('cust-a'));
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('a failed or refused beacon is not retried or kept (an uncounted open)', async () => {
    beacon.mockRejectedValueOnce(new Error('page unloaded'));
    reportPushOpen({ notificationId: 'n-2' });
    await flush();
    beacon.mockResolvedValueOnce(null);
    reportPushOpen({ notificationId: 'n-3' });
    await flush();
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('waves_pending_push_open')).toBeNull();
  });

  it('a dark gate answer blocks later opens for the session', async () => {
    beacon.mockResolvedValueOnce({ enabled: false });
    reportPushOpen({ notificationId: 'n-4' });
    await flush();
    reportPushOpen({ notificationId: 'n-5' });
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});

describe('foreground heartbeat', () => {
  it('probes every minute and leaves the write throttle to the server', () => {
    // A probe the server throttled must not defer the next one (#5335): after
    // a stamp at T0 the T+1..T+4 probes are no-ops server-side, and the T+5
    // probe is the one that writes.
    for (let m = 0; m <= 5; m += 1) reportPortalHeartbeat(1_000 + m * 60_000);
    expect(beacon).toHaveBeenCalledTimes(6);
    expect(new Set(beacon.mock.calls.map((c) => c[0]))).toEqual(new Set(['/customer/activity/heartbeat']));
  });

  it('only guards against a burst', () => {
    reportPortalHeartbeat(1_000);
    reportPortalHeartbeat(1_000 + 10_000);
    reportPortalHeartbeat(1_000 + 30_000);
    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it('a page view never defers the heartbeat, and a heartbeat never posts a page view', () => {
    reportPortalPageView('visits', 1_000);
    reportPortalHeartbeat(1_000 + 60_000);
    expect(beacon.mock.calls.map((c) => c[0])).toEqual(['/customer/activity/page-view', '/customer/activity/heartbeat']);
  });

  it('stops for the session when the gate is dark', async () => {
    beacon.mockResolvedValue({ ok: true, enabled: false });
    reportPortalHeartbeat(1_000);
    await flush();
    reportPortalHeartbeat(1_000 + 10 * 60_000);
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});
