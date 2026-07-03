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

function slot(slotId, date, overrides = {}) {
  return {
    slotId,
    date,
    windowStart: '10:00',
    windowEnd: '12:00',
    routeOptimal: true,
    techFirstName: 'Sam',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SlotPicker', () => {
  it('renders the date finder inside the booking card, above the slot list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2026-06-01')], expander: [] }));
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

    const firstSlot = await screen.findByText('Monday, June 1');
    const heading = screen.getByText('Find a date & time that works for you');
    const finderLabel = screen.getByText(/pick one that works for you/i);

    // Order: heading → finder → slot windows (matches the SSR booking card).
    expect(heading.compareDocumentPosition(finderLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(finderLabel.compareDocumentPosition(firstSlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

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

  it('clears picked-date loading when frequency changes during a date request', async () => {
    const pickedDateFetch = deferred();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2026-06-01')], expander: [] }))
      .mockReturnValueOnce(pickedDateFetch.promise)
      .mockResolvedValueOnce(jsonResponse({ primary: [slot('changed', '2026-06-02')], expander: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
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
    expect(await screen.findByText(/Loading times/)).toBeInTheDocument();

    rerender(
      <SlotPicker
        token="estimate-token"
        selectedSlotId={null}
        onSelect={vi.fn()}
        refreshSignal={0}
        serviceMode="recurring"
        selectedFrequency="monthly"
      />,
    );

    await screen.findByText('Tuesday, June 2');
    expect(screen.queryByText(/Loading times/)).not.toBeInTheDocument();

    await act(async () => {
      pickedDateFetch.resolve(jsonResponse({ primary: [slot('old-date', '2026-06-10')], expander: [] }));
    });

    expect(screen.queryByText('Wednesday, June 10')).not.toBeInTheDocument();
  });

  it('ignores stale same-date responses from an older request context', async () => {
    const oldDateFetch = deferred();
    const newDateFetch = deferred();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2026-06-01')], expander: [] }))
      .mockReturnValueOnce(oldDateFetch.promise)
      .mockResolvedValueOnce(jsonResponse({ primary: [slot('changed', '2026-06-02')], expander: [] }))
      .mockReturnValueOnce(newDateFetch.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
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

    rerender(
      <SlotPicker
        token="estimate-token"
        selectedSlotId={null}
        onSelect={vi.fn()}
        refreshSignal={0}
        serviceMode="recurring"
        selectedFrequency="monthly"
      />,
    );

    const nextInput = await screen.findByLabelText(/pick one that works for you/i);
    fireEvent.change(nextInput, { target: { value: '2026-06-10' } });

    await act(async () => {
      newDateFetch.resolve(jsonResponse({ primary: [slot('monthly-date', '2026-06-10', { windowStart: '11:00', windowEnd: '13:00' })], expander: [] }));
    });
    await screen.findByText('Wednesday, June 10');
    expect(screen.getByText('11:00 AM')).toBeInTheDocument();

    await act(async () => {
      oldDateFetch.resolve(jsonResponse({ primary: [slot('quarterly-date', '2026-06-10', { windowStart: '9:00', windowEnd: '11:00' })], expander: [] }));
    });

    await waitFor(() => {
      expect(screen.getByText('11:00 AM')).toBeInTheDocument();
      expect(screen.queryByText('9:00 AM')).not.toBeInTheDocument();
    });
  });
});
