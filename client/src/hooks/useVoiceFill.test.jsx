// @vitest-environment jsdom
// The voice-fill request (hooks/useVoiceFill.js): what it asks, and how each
// outcome is told to the sheet. The 404 { enabled: false } of a dark gate is
// "unavailable", never an error.
import { describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useVoiceFill, { VOICE_FILL_ERROR } from './useVoiceFill';

const setup = (request) => renderHook(() => useVoiceFill({ request, serviceId: 'svc-1', sheet: 'pest_reservice' }));

describe('useVoiceFill', () => {
  test('posts the sheet and the words, and hands back the fill', async () => {
    const fill = { enabled: true, products: [], visit: {}, customerNote: '', officeNote: '', unclear: [] };
    const request = vi.fn(async () => fill);
    const { result } = setup(request);
    expect(result.current).toMatchObject({ status: 'idle', result: null, error: '', unavailable: false });

    let returned;
    await act(async () => { returned = await result.current.fill('  I sprayed the garage  '); });
    expect(request).toHaveBeenCalledWith('/admin/dispatch/svc-1/fast-complete/voice-fill', {
      method: 'POST',
      body: JSON.stringify({ sheet: 'pest_reservice', transcript: 'I sprayed the garage' }),
    });
    expect(returned).toBe(fill);
    expect(result.current).toMatchObject({ status: 'done', result: fill, error: '' });
    // The words are not kept anywhere on the hook.
    expect(JSON.stringify(Object.keys(result.current))).not.toContain('transcript');
    expect(JSON.stringify(result.current.result)).not.toContain('garage');
  });

  test('nothing said asks for nothing', async () => {
    const request = vi.fn();
    const { result } = setup(request);
    await act(async () => { await result.current.fill('   '); });
    expect(request).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  test('is filling while the request is out', async () => {
    let finish;
    const request = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = setup(request);
    let pending;
    act(() => { pending = result.current.fill('words'); });
    expect(result.current.status).toBe('filling');
    await act(async () => { finish({ enabled: true }); await pending; });
    expect(result.current.status).toBe('done');
  });

  test.each([
    ['a 404', Object.assign(new Error('Request failed (404)'), { status: 404 })],
  ])('%s is unavailable, with no error to show', async (_label, err) => {
    const { result } = setup(vi.fn(async () => { throw err; }));
    await act(async () => { await result.current.fill('words'); });
    expect(result.current).toMatchObject({ status: 'idle', error: '', unavailable: true });
  });

  test('an answer of { enabled: false } is unavailable too', async () => {
    const { result } = setup(vi.fn(async () => ({ enabled: false })));
    await act(async () => { await result.current.fill('words'); });
    expect(result.current).toMatchObject({ status: 'idle', error: '', unavailable: true, result: null });
  });

  test.each([
    ['a 502', Object.assign(new Error('Voice fill is unavailable right now. Keep typing.'), { status: 502 })],
    ['a 400', Object.assign(new Error('transcript must be 1-4000 characters'), { status: 400 })],
    ['a network error', new TypeError('Failed to fetch')],
  ])('%s shows the short message and nothing else', async (_label, err) => {
    const { result } = setup(vi.fn(async () => { throw err; }));
    let returned;
    await act(async () => { returned = await result.current.fill('words'); });
    expect(returned).toBeNull();
    expect(result.current).toMatchObject({ status: 'error', error: VOICE_FILL_ERROR, unavailable: false });
    expect(VOICE_FILL_ERROR).toBe("Couldn't fill from your words — tap the answers instead");
  });
});
