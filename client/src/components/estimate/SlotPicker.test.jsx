// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SlotPicker from './SlotPicker';

vi.mock('../booking/WavesAIScheduleSearch', () => ({
  default: () => null,
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

function slot(slotId, date) {
  return {
    slotId,
    date,
    windowStart: '10:00',
    windowEnd: '12:00',
    routeOptimal: true,
    techFirstName: 'Sam',
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SlotPicker', () => {
  it('ignores stale picked-date availability responses', async () => {
    const firstDateFetch = deferred();
    const secondDateFetch = deferred();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2026-06-01')], expander: [] }))
      .mockReturnValueOnce(firstDateFetch.promise)
      .mockReturnValueOnce(secondDateFetch.promise);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SlotPicker
        token="estimate-token"
        selectedSlotId={null}
        onSelect={vi.fn()}
        refreshSignal={0}
        serviceMode="recurring"
        selectedFrequency="quarterly"
      />,
    );

    const input = await screen.findByLabelText(/pick one that works for you/i);
    fireEvent.change(input, { target: { value: '2026-06-10' } });
    fireEvent.change(input, { target: { value: '2026-06-11' } });

    await act(async () => {
      secondDateFetch.resolve(jsonResponse({ primary: [slot('new-date', '2026-06-11')], expander: [] }));
    });
    await screen.findByText('Thursday, June 11');

    await act(async () => {
      firstDateFetch.resolve(jsonResponse({ primary: [slot('old-date', '2026-06-10')], expander: [] }));
    });

    await waitFor(() => {
      expect(screen.getByText('Thursday, June 11')).toBeInTheDocument();
      expect(screen.queryByText('Wednesday, June 10')).not.toBeInTheDocument();
    });
  });
});
