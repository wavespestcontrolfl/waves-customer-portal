// @vitest-environment jsdom
// The voice-fill request (hooks/useVoiceFill.js): the recording goes to the clip
// route, and each outcome is told to the sheet. The 404 { enabled: false } of a
// dark gate is "unavailable", never an error.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useVoiceFill, { VOICE_FILL_ERROR, VOICE_FILL_NOTHING_HEARD } from './useVoiceFill';

const setup = () => renderHook(() => useVoiceFill({ serviceId: 'svc-1', sheet: 'pest_reservice' }));

describe('useVoiceFill.fillFromClip', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
  const clip = () => new Blob(['clip'], { type: 'audio/mp4' });
  const answer = (status, body) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));

  test('sends the recording (never words) to the clip route and hands back the fill', async () => {
    localStorage.setItem('waves_admin_token', 'staff-jwt');
    const fill = { enabled: true, products: [], visit: {}, customerNote: '', officeNote: '', unclear: [] };
    answer(200, fill);
    const { result } = setup();
    let returned;
    await act(async () => { returned = await result.current.fillFromClip(clip(), 6.4); });
    expect(returned).toEqual(fill);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/admin/dispatch/svc-1/fast-complete/voice-fill/clip');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer staff-jwt');
    expect(options.body.get('sheet')).toBe('pest_reservice');
    expect(options.body.get('duration_seconds')).toBe('6');
    expect(options.body.get('audio').name).toBe('voice-fill.mp4');
    expect(options.body.has('transcript')).toBe(false);
    expect(result.current).toMatchObject({ status: 'done', result: fill, error: '' });
    // no words are kept on the hook
    expect(Object.keys(result.current)).not.toContain('transcript');
  });

  test('a dark gate (404) is unavailable, not an error', async () => {
    answer(404, { enabled: false });
    const { result } = setup();
    await act(async () => { expect(await result.current.fillFromClip(clip(), 3)).toBeNull(); });
    expect(result.current).toMatchObject({ unavailable: true, error: '' });
  });

  test('a failed fill shows the short message', async () => {
    answer(502, { error: 'Voice fill is unavailable right now. Keep typing.' });
    const { result } = setup();
    await act(async () => { expect(await result.current.fillFromClip(clip(), 3)).toBeNull(); });
    expect(result.current).toMatchObject({ status: 'error', error: VOICE_FILL_ERROR, unavailable: false });
  });

  test('nothing heard asks the tech to try again and applies nothing', async () => {
    answer(200, { enabled: true, heardNothing: true, products: [], visit: null, customerNote: '', officeNote: '', unclear: [] });
    const { result } = setup();
    await act(async () => { expect(await result.current.fillFromClip(clip(), 3)).toBeNull(); });
    expect(result.current.error).toBe(VOICE_FILL_NOTHING_HEARD);
  });

  test('an empty recording asks for nothing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { result } = setup();
    await act(async () => { expect(await result.current.fillFromClip(new Blob([]), 0)).toBeNull(); });
    expect(fetch).not.toHaveBeenCalled();
  });
});

test('is filling while the clip is out', async () => {
  let finish;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  const { result } = setup();
  let pending;
  act(() => { pending = result.current.fillFromClip(new Blob(['clip'], { type: 'audio/webm' }), 3); });
  expect(result.current.status).toBe('filling');
  await act(async () => { finish({ ok: true, status: 200, json: async () => ({ enabled: true, products: [] }) }); await pending; });
  expect(result.current.status).toBe('done');
  vi.unstubAllGlobals();
});
