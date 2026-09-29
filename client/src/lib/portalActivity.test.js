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

import { flushPendingPushOpen, reportPortalPageView, reportPushOpen, resetPortalActivityForTests } from './portalActivity';

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

  it('does not resend the same tab inside five minutes, but sends other tabs', () => {
    reportPortalPageView('visits', 1_000);
    reportPortalPageView('visits', 1_000 + 4 * 60_000);
    reportPortalPageView('billing', 1_000 + 4 * 60_000);
    reportPortalPageView('visits', 1_000 + 6 * 60_000);
    expect(beacon.mock.calls.map((c) => c[1].route)).toEqual(['visits', 'billing', 'visits']);
  });

  it('does not carry the same-tab memo across a logout / sign-in as another customer', () => {
    reportPortalPageView('visits', 1_000);
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-b', sessionId: 'fam-b' }));
    reportPortalPageView('visits', 1_000 + 60_000); // B inside A's 5-minute window
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
  it('sends the notification id, category and tag from the push data, capped', async () => {
    platform.value = 'android';
    reportPushOpen({ notificationId: 'n-1', category: 'billing', tag: 'push-routed:receipt', url: '/?tab=billing', extra: 'ignored' });
    await flush();
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', {
      platform: 'android', notificationId: 'n-1', category: 'billing', tag: 'push-routed:receipt',
    });
  });

  it('sends what it has when the push carried no ids', async () => {
    reportPushOpen(undefined);
    await flush();
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', {
      platform: 'web', notificationId: undefined, category: undefined, tag: undefined,
    });
  });
});

describe('push-open survives a page navigation', () => {
  const KEY = 'waves_pending_push_open';
  const pending = () => JSON.parse(localStorage.getItem(KEY) || 'null');

  it('parks the open in storage and clears it once the server answers', async () => {
    reportPushOpen({ notificationId: 'n-1' });
    expect(pending().body.notificationId).toBe('n-1');
    await flush();
    expect(pending()).toBeNull();
  });

  it('keeps it when the beacon fails or is refused, and a flush retries it', async () => {
    beacon.mockRejectedValueOnce(new Error('page unloaded'));
    reportPushOpen({ notificationId: 'n-2', category: 'billing' });
    await flush();
    expect(pending().body.notificationId).toBe('n-2');

    beacon.mockResolvedValueOnce(null); // non-OK answer (e.g. session refresh lost)
    flushPendingPushOpen();
    await flush();
    expect(pending()).not.toBeNull();

    flushPendingPushOpen();
    await flush();
    expect(beacon).toHaveBeenLastCalledWith('/customer/activity/push-open', expect.objectContaining({ notificationId: 'n-2', category: 'billing' }));
    expect(pending()).toBeNull();
  });

  it('never replays a pending open under a different sign-in', async () => {
    beacon.mockRejectedValueOnce(new Error('page unloaded'));
    reportPushOpen({ notificationId: 'n-a' });
    await flush();
    expect(pending().session).toBe('fam-a');

    // Customer A signs out, customer B signs in on the same device.
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-b', sessionId: 'fam-b' }));
    flushPendingPushOpen();
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(pending()).toBeNull();
  });

  it('an older open finishing late does not delete a newer parked open', async () => {
    let releaseFirst;
    beacon.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, enabled: true }); }));
    beacon.mockResolvedValueOnce(null); // the new open's own beacon is not answered -> stays parked
    reportPushOpen({ notificationId: 'n-old' });
    reportPushOpen({ notificationId: 'n-new' }); // parked over the old one
    releaseFirst();
    await flush();
    expect(pending().body.notificationId).toBe('n-new');
  });

  it('a request clears the parked entry when it is still its own', async () => {
    reportPushOpen({ notificationId: 'n-own' });
    const id = pending().id;
    expect(typeof id).toBe('string');
    await flush();
    expect(pending()).toBeNull();
  });

  it('keeps a pending open across token rotation and a same-account profile switch', async () => {
    beacon.mockRejectedValueOnce(new Error('page unloaded'));
    reportPushOpen({ notificationId: 'n-r' });
    await flush();
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-a2', sessionId: 'fam-a' }));
    flushPendingPushOpen();
    await flush();
    expect(beacon).toHaveBeenLastCalledWith('/customer/activity/push-open', expect.objectContaining({ notificationId: 'n-r' }));
  });

  it('sends but does not park an open when nobody is signed in', async () => {
    localStorage.removeItem('waves_token');
    reportPushOpen({ notificationId: 'n-x' });
    expect(pending()).toBeNull();
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('drops a stale pending open instead of sending it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ body: { platform: 'ios', notificationId: 'old' }, session: 'fam-a', at: Date.now() - 25 * 60 * 60 * 1000 }));
    flushPendingPushOpen();
    await flush();
    expect(beacon).not.toHaveBeenCalled();
    expect(pending()).toBeNull();
  });

  it('a flush with nothing pending, or garbage in storage, is a no-op', async () => {
    flushPendingPushOpen();
    localStorage.setItem(KEY, '{not json');
    flushPendingPushOpen();
    await flush();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('a dark gate clears the parked open on the first answer and blocks later ones', async () => {
    beacon.mockResolvedValue({ ok: true, enabled: false });
    reportPushOpen({ notificationId: 'n-3' });
    await flush();
    expect(pending()).toBeNull();
    reportPushOpen({ notificationId: 'n-4' });
    expect(pending()).toBeNull();
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});
