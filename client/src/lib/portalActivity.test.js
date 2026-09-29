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

import { flushPendingPushOpen, reportPortalHeartbeat, reportPortalPageView, reportPushOpen, resetPortalActivityForTests } from './portalActivity';

beforeEach(() => {
  beacon.mockReset();
  beacon.mockResolvedValue({ ok: true, enabled: true });
  platform.value = 'web';
  localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-a', sessionId: 'fam-a' }));
  resetPortalActivityForTests();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
      platform: 'android', notificationId: 'n-1', tapId: expect.stringMatching(UUID), category: 'billing', tag: 'push-routed:receipt',
    });
  });

  it('sends what it has when the push carried no ids', async () => {
    reportPushOpen(undefined);
    await flush();
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', {
      platform: 'web', notificationId: undefined, tapId: expect.stringMatching(UUID), category: undefined, tag: undefined,
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

describe('per-tap id', () => {
  const pending = () => JSON.parse(localStorage.getItem('waves_pending_push_open') || 'null');

  it('each tap gets its own id; a retry of the same tap reuses it', async () => {
    beacon.mockRejectedValueOnce(new Error('page unloaded'));
    reportPushOpen({ tag: 'push-routed:receipt' });
    await flush();
    const first = beacon.mock.calls[0][1].tapId;
    expect(pending().body.tapId).toBe(first);
    flushPendingPushOpen(); // the retry
    await flush();
    expect(beacon.mock.calls[1][1].tapId).toBe(first);
    reportPushOpen({ tag: 'push-routed:receipt' }); // a second, separate tap
    await flush();
    expect(beacon.mock.calls[2][1].tapId).not.toBe(first);
  });
});

describe('push-open for another profile of the account', () => {
  const KEY = 'waves_pending_push_open';
  const pending = () => JSON.parse(localStorage.getItem(KEY) || 'null');
  const tapFor = (target) => ({ notificationId: 'n-t', url: `/?tab=visits&notificationProperty=${target}` });

  it('is only parked when the link targets a different profile: nothing is sent with the wrong token', async () => {
    reportPushOpen(tapFor('cust-b'));
    await flush();
    expect(beacon).not.toHaveBeenCalled();
    expect(pending().targetCustomerId).toBe('cust-b');
  });

  it('is sent once, with the target profile token, after the switch (flush on portal mount)', async () => {
    reportPushOpen(tapFor('cust-b'));
    flushPendingPushOpen(); // still profile A: keeps waiting
    await flush();
    expect(beacon).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();

    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-b', sessionId: 'fam-a' })); // switched, same family
    flushPendingPushOpen();
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith('/customer/activity/push-open', expect.objectContaining({ notificationId: 'n-t' }));
    expect(pending()).toBeNull();
    flushPendingPushOpen(); // a later mount does not send it again
    await flush();
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('a tap for the profile already signed in (or a link naming none) sends immediately', async () => {
    reportPushOpen(tapFor('cust-a'));
    reportPushOpen({ notificationId: 'n-u', url: '/?tab=billing' });
    await flush();
    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it('a targeted open that is stale is dropped even when the session now matches the target', async () => {
    reportPushOpen(tapFor('cust-b'));
    const at = pending().at;
    localStorage.setItem('waves_token', jwtFor({ customerId: 'cust-b', sessionId: 'fam-a' })); // manual switch, much later
    flushPendingPushOpen(at + 3 * 60 * 60_000);
    await flush();
    expect(beacon).not.toHaveBeenCalled();
    expect(pending()).toBeNull();
  });

  it('a switch that never happens is dropped after ten minutes, never sent', async () => {
    reportPushOpen(tapFor('cust-b'));
    const at = pending().at;
    flushPendingPushOpen(at + 9 * 60_000);
    expect(pending()).not.toBeNull();
    flushPendingPushOpen(at + 11 * 60_000);
    expect(pending()).toBeNull();
    await flush();
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe('foreground heartbeat', () => {
  it('posts to the lightweight endpoint and holds a five-minute floor', () => {
    reportPortalHeartbeat(1_000);
    reportPortalHeartbeat(1_000 + 4 * 60_000);
    reportPortalHeartbeat(1_000 + 5 * 60_000 + 1);
    expect(beacon.mock.calls.map((c) => c[0])).toEqual(['/customer/activity/heartbeat', '/customer/activity/heartbeat']);
  });

  it('a page-view send counts as a heartbeat, and a heartbeat never posts a page view', () => {
    reportPortalPageView('visits', 1_000);
    reportPortalHeartbeat(1_000 + 60_000); // page-view just stamped last_seen
    expect(beacon).toHaveBeenCalledTimes(1);
    reportPortalHeartbeat(1_000 + 6 * 60_000);
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
