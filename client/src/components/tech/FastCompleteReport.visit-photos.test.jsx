// @vitest-environment jsdom
// useVisitPhotos outside the note's box: a failed read holds nothing (`failed` stays false), but it is no answer
// either. `read` false says so, so the one-tap report body leaves photoCaptionsSeen out instead of sending the empty
// list a saved photo description would refuse; that holds for a re-read that fails after a good one too.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useVisitPhotos } from './FastCompleteReport';

describe('useVisitPhotos: a read that answered, and one that did not', () => {
  test('a good read is an answer; a re-read that fails after it is not, and still holds nothing', async () => {
    let fail = false;
    const request = vi.fn(async () => {
      if (fail) throw new Error('Photos unavailable');
      return { photos: [{ id: 'photo-1', caption: 'Wasp nest under the eave' }] };
    });
    const { result, rerender } = renderHook(({ version }) => useVisitPhotos({ serviceId: 'svc-1', request, version }), { initialProps: { version: 0 } });
    await waitFor(() => expect(result.current.read).toBe(true));
    expect(result.current).toMatchObject({ loaded: true, failed: false });
    expect(result.current.photos).toHaveLength(1);

    fail = true;
    rerender({ version: 1 });
    await waitFor(() => expect(result.current.read).toBe(false));
    expect(result.current).toMatchObject({ loaded: true, failed: false, photos: [] });
  });

  test('a first read that fails is no answer either', async () => {
    const request = vi.fn(async () => { throw new Error('Photos unavailable'); });
    const { result } = renderHook(() => useVisitPhotos({ serviceId: 'svc-1', request, version: 0 }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toMatchObject({ read: false, failed: false, photos: [] });
  });
});
