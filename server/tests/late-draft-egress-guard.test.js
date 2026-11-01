/**
 * The late-draft egress guard (services/late-draft-egress-guard.js): inside a guarded scope the
 * global fetch refuses every host that is not a model provider or loopback, counts the refusals by
 * host, and never touches a request made outside the scope.
 */
const realFetch = jest.fn(async () => ({ ok: true }));
globalThis.fetch = realFetch;

const { runWithoutPaidCalls, guardActive, hostAllowed } = require('../services/late-draft-egress-guard');

beforeEach(() => { realFetch.mockClear(); delete process.env.ANTHROPIC_BASE_URL; });

describe('late-draft egress guard', () => {
  test('refuses Google Maps, Twilio and Stripe hosts, rejects with a coded error and counts them by host', async () => {
    const { value, blocked } = await runWithoutPaidCalls(async () => {
      const seen = [];
      for (const url of [
        'https://maps.googleapis.com/maps/api/geocode/json?address=1+Main+St&key=SECRET',
        'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
        'https://api.twilio.com/2010-04-01/Accounts',
        'https://maps.googleapis.com/maps/api/geocode/json?address=2+Main+St',
      ]) {
        seen.push(await fetch(url).then(() => 'sent', (err) => err.code));
      }
      return seen;
    });
    expect(value).toEqual(['LATE_DRAFT_EGRESS_BLOCKED', 'LATE_DRAFT_EGRESS_BLOCKED', 'LATE_DRAFT_EGRESS_BLOCKED', 'LATE_DRAFT_EGRESS_BLOCKED']);
    expect(blocked).toEqual({ 'maps.googleapis.com': 2, 'routes.googleapis.com': 1, 'api.twilio.com': 1 });
    expect(realFetch).not.toHaveBeenCalled();
  });

  test('the report carries host names only, never a URL or its key', async () => {
    const { blocked } = await runWithoutPaidCalls(async () => {
      await fetch('https://maps.googleapis.com/maps/api/geocode/json?key=SECRET-KEY').catch(() => {});
    });
    expect(JSON.stringify(blocked)).not.toMatch(/SECRET|geocode|https/);
  });

  test('lets model providers and loopback through', async () => {
    const { blocked } = await runWithoutPaidCalls(async () => {
      await fetch('https://api.anthropic.com/v1/messages');
      await fetch('https://api.openai.com/v1/responses');
      await fetch('http://localhost:3000/health');
    });
    expect(blocked).toEqual({});
    expect(realFetch).toHaveBeenCalledTimes(3);
  });

  test('allows the host of ANTHROPIC_BASE_URL (a local proxy) and nothing else', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://claude-proxy.example.test:8443/base';
    expect(hostAllowed('claude-proxy.example.test')).toBe(true);
    expect(hostAllowed('other.example.test')).toBe(false);
  });

  test('an unparseable target is refused; a Request-like object is read by its url', async () => {
    const { blocked } = await runWithoutPaidCalls(async () => {
      await fetch('not a url').catch(() => {});
      await fetch({ url: 'https://maps.googleapis.com/x' }).catch(() => {});
    });
    expect(blocked).toEqual({ unknown: 1, 'maps.googleapis.com': 1 });
  });

  test('outside a scope the wrapper is a pass-through, even right after a guarded run', async () => {
    await runWithoutPaidCalls(async () => {});
    expect(guardActive()).toBe(false);
    await fetch('https://maps.googleapis.com/maps/api/geocode/json');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  test('a call that starts inside a scope but resolves later is still counted in that scope', async () => {
    const { blocked } = await runWithoutPaidCalls(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      await fetch('https://maps.googleapis.com/x').catch(() => {});
    });
    expect(blocked).toEqual({ 'maps.googleapis.com': 1 });
  });
});
