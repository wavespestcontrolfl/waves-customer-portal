// fetchMrmsDailyRain accepts an optional caller AbortSignal (P30: the live
// close-out's own short deadline cancels the in-flight request). Without it the
// helper behaves as before. fetch is mocked; no network.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { fetchMrmsDailyRain } = require('../services/mrms-qpe');

const ARGS = { latitude: 27.5, longitude: -82.5, start: '2026-10-07', end: '2026-10-07' };
const OK_BODY = { data: [{ date: '2026-10-07', mrms_precip_in: 0.4 }] };

describe('fetchMrmsDailyRain caller cancellation', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('aborting the caller signal aborts the in-flight request and resolves null', async () => {
    let requestSignal;
    global.fetch = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const caller = new AbortController();
    const pending = fetchMrmsDailyRain({ ...ARGS, signal: caller.signal });
    expect(requestSignal.aborted).toBe(false);
    caller.abort();
    expect(await pending).toBeNull();
    expect(requestSignal.aborted).toBe(true);
  });

  test('an already-aborted signal never starts a live request', async () => {
    global.fetch = jest.fn((_url, { signal }) => (signal.aborted
      ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      : Promise.resolve({ ok: true, json: async () => OK_BODY })));
    const caller = new AbortController();
    caller.abort();
    expect(await fetchMrmsDailyRain({ ...ARGS, signal: caller.signal })).toBeNull();
  });

  test('no signal: unchanged behavior; a signal that is never aborted changes nothing', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => OK_BODY }));
    const plain = await fetchMrmsDailyRain(ARGS);
    expect(plain).toEqual({ days: [{ date: '2026-10-07', inches: 0.4 }], complete: true });
    const withSignal = await fetchMrmsDailyRain({ ...ARGS, signal: new AbortController().signal });
    expect(withSignal).toEqual(plain);
  });
});
