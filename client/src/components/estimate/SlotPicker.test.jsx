// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SlotPicker from './SlotPicker';
import { setGlassDefault } from '../../lib/estimate-glass-copy';

// A bare trigger for the date search: it hands the picker's onSearch a query.
vi.mock('../booking/WavesAIScheduleSearch', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ onSearch }) => createElement('button', { type: 'button', onClick: () => onSearch('next week').catch(() => {}) }, 'run-date-search'),
  };
});

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

describe('SlotPicker (glass stale-selection sweep)', () => {
  const setGlass = (on) => setGlassDefault(on);

  it('preserves a selected slot while the availability fetch is still pending', async () => {
    setGlass(true);
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const onSelect = vi.fn();
    const onSelectMeta = vi.fn();
    try {
      render(
        <SlotPicker
          token="tok"
          selectedSlotId="kept-slot"
          onSelect={onSelect}
          onSelectMeta={onSelectMeta}
          refreshSignal={0}
        />,
      );
      // Loading: the sweep must treat the empty list as "unknown", not
      // "gone" — a review-cancel remount preserves selectedSlotId on
      // purpose and the payment choices hang off it.
      expect(onSelect).not.toHaveBeenCalled();
      pending.resolve(jsonResponse({ primary: [slot('kept-slot', '2099-06-01')], expander: [] }));
      await screen.findByText(/Arrival window:/);
      expect(onSelect).not.toHaveBeenCalledWith(null);
    } finally {
      setGlass(false);
    }
  });

  it('keeps a held selection missing from the refetched list while its window is bookable', async () => {
    setGlass(true);
    // The customer's own review-cancel hold occupies the slot server-side,
    // so the refetched list does NOT include it — the fallback meta from
    // the page is what keeps the retry path alive.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ primary: [slot('other-slot', '2099-06-01')], expander: [] }),
    ));
    const onSelect = vi.fn();
    try {
      render(
        <SlotPicker
          token="tok"
          selectedSlotId="held-slot"
          selectedSlotFallbackMeta={{ slotId: 'held-slot', date: '2099-06-01', windowStart: '10:00', dow: 'Mon', time: '10:00 AM' }}
          onSelect={onSelect}
          refreshSignal={0}
        />,
      );
      await screen.findByText('Monday, June 1');
      expect(onSelect).not.toHaveBeenCalledWith(null);
      // The tech chip stays up for the held selection.
      expect(screen.getByText(/Your technician/)).toBeInTheDocument();
    } finally {
      setGlass(false);
    }
  });

  it('clears the selection once loaded slots no longer include it', async () => {
    setGlass(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ primary: [slot('other-slot', '2099-06-01')], expander: [] }),
    ));
    const onSelect = vi.fn();
    try {
      render(
        <SlotPicker
          token="tok"
          selectedSlotId="gone-slot"
          onSelect={onSelect}
          refreshSignal={0}
        />,
      );
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    } finally {
      setGlass(false);
    }
  });
});

describe('SlotPicker', () => {
  it('renders the search above the shared picker and the 90-day date finder below it', async () => {
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
    const heading = screen.getByText('Search by date or time \u2014 no calling, no hold music, no back-and-forth');
    const finderLabel = screen.getByText(/pick one that works for you/i);

    // Order: heading → picker (day title) → date finder (same order as /book).
    expect(heading.compareDocumentPosition(firstSlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firstSlot.compareDocumentPosition(finderLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a 2-hour arrival window from the slot start, not the job block', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        // windowEnd is the 1-hour JOB block — the customer-facing arrival
        // window is always start + 2h.
        primary: [slot('initial', '2026-06-01', { windowStart: '09:00', windowEnd: '10:00' })],
        expander: [],
      }));
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

    expect(await screen.findByText(/Arrival window: 9:00 AM–11:00 AM/)).toBeInTheDocument();
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

describe('SlotPicker best times and the rain tier (GATE_CUSTOMER_RAIN_RANK)', () => {
  it('a wet nearby slot the server moved back stays behind the dry ones in the strip', async () => {
    // Server order: the soonest card, a dry non-nearby slot, then a wet
    // NEARBY slot carrying display_tier. Without the tier the strip's
    // nearby-first sort would lift the wet slot to the front.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      primary: [
        slot('soonest', '2026-06-01', { windowStart: '09:00', windowEnd: '11:00', routeOptimal: false }),
        slot('dry', '2026-06-02', { windowStart: '10:00', windowEnd: '12:00', routeOptimal: false }),
        slot('wet-nearby', '2026-06-03', { windowStart: '14:00', windowEnd: '16:00', routeOptimal: true, display_tier: 2 }),
      ],
      expander: [],
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <SlotPicker token="estimate-token" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} serviceMode="recurring" selectedFrequency="quarterly" />,
    );
    await screen.findByText('Monday, June 1');
    const chips = screen.getAllByRole('button', { name: /Pick/ }).map((b) => b.textContent);
    expect(chips).toHaveLength(3);
    expect(chips[2]).toMatch(/2:00 PM/);
    expect(chips[0]).not.toMatch(/2:00 PM/);
  });
});

// A YYYY-MM-DD date `days` from today, in the browser's own calendar (what the date box compares).
function ymdFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('date past the booking limit', () => {
  it('names the last day and never calls the slots API for a date beyond the box limit', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2099-06-01')], expander: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<SlotPicker token="synthetic-token" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} />);
    const box = await screen.findByLabelText(/pick one that works for you/i);
    const lastDay = new Date(`${box.getAttribute('max')}T12:00:00Z`)
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    fireEvent.change(box, { target: { value: ymdFromToday(200) } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`We book up to 90 days ahead. Pick a date on or before ${lastDay}.`);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the limit the server sends when its 400 says the date is too far out', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2099-06-01')], expander: [] }));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'date is beyond the booking horizon', lastBookableDate: '2027-02-03', horizonDays: 90 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SlotPicker token="synthetic-token" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} />);
    fireEvent.change(await screen.findByLabelText(/pick one that works for you/i), { target: { value: ymdFromToday(80) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('We book up to 90 days ahead. Pick a date on or before Wed, Feb 3.');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('date availability failures', () => {
  it.each(['http', 'network'])('shows a retryable error instead of an empty day on %s failure', async (failure) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ primary: [slot('initial', '2099-06-01')], expander: [] }));
    if (failure === 'http') fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    else fetchMock.mockRejectedValueOnce(new Error('Connection lost'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ primary: [slot('retried', '2099-06-11')], expander: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<SlotPicker token="synthetic-token" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} />);
    const pickedYmd = ymdFromToday(10);
    fireEvent.change(await screen.findByLabelText(/pick one that works for you/i), { target: { value: pickedYmd } });
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load times for that day');
    expect(screen.queryByText(/No open times then/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await screen.findByText(/Arrival window:/);
    expect(fetchMock.mock.calls[2][0]).toContain(`date=${pickedYmd}`);
  });
});

describe('SlotPicker (B18: an estimate parked for the office)', () => {
  const REVIEW_BODY = { primary: [], expander: [], availableSlots: [], summary: null, reviewBeforeBooking: true, reason: 'contact_review', message: 'parked' };

  it('hands the review shape to the page (onContactReview) instead of rendering it as an empty slot list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(REVIEW_BODY)));
    const onContactReview = vi.fn();
    render(<SlotPicker token="tok" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} onContactReview={onContactReview} />);
    await waitFor(() => expect(onContactReview).toHaveBeenCalledTimes(1));
    expect(onContactReview).toHaveBeenCalledWith(expect.objectContaining({ reason: 'contact_review' }));
  });

  it('the trenching-style review shape (another reason) is NOT treated as a park', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...REVIEW_BODY, reason: undefined })));
    const onContactReview = vi.fn();
    render(<SlotPicker token="tok" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} onContactReview={onContactReview} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(onContactReview).not.toHaveBeenCalled();
  });

  it('a rejecting page transition never surfaces as an unhandled rejection from the slot read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(REVIEW_BODY)));
    const onContactReview = vi.fn(() => Promise.reject(new Error('refetch failed')));
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      render(<SlotPicker token="tok" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} onContactReview={onContactReview} />);
      await waitFor(() => expect(onContactReview).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ── Look-ahead past the 14-day window ──────────────────────────────────────
// A 4-service first visit needs one 240-minute block; the calendar can have
// none for 14 days. The page used to dead-end ("No open slots…"), and so did
// the date search and a picked date. Ids and dates here are synthetic (the
// 2099 calendar matches 2026's weekdays).
describe('SlotPicker look-ahead (the next 2 weeks are full)', () => {
  // The fixtures live in 2099; the date box only takes days inside its booking
  // limit, so pin the page's clock (Date only) near them.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-10-01T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  const OPEN = (slotId, date, windowStart = '09:00') => slot(slotId, date, { windowStart, windowEnd: '13:00', routeOptimal: false });
  const SLOT_NOV21 = OPEN('s-nov21', '2099-11-21');
  const SLOT_NOV22 = OPEN('s-nov22', '2099-11-22', '11:00');
  const SLOT_DEC06 = OPEN('s-dec06', '2099-12-06');
  const SLOT_DEC13 = OPEN('s-dec13', '2099-12-13');
  const SLOT_DEC20 = OPEN('s-dec20', '2099-12-20');
  const EMPTY_14 = { primary: [], expander: [], nearby: false, metadata: { firstDayAvailability: null, windowDays: 14 } };
  const NORMAL = { primary: [slot('s-now', '2099-06-01')], expander: [] };
  const calls = (fetchMock, test) => fetchMock.mock.calls.filter(([url, init]) => test(String(url), init?.method || 'GET'));
  const wideCalls = (fetchMock) => calls(fetchMock, (u, m) => m === 'GET' && u.includes('windowDays=90'));
  const dateCalls = (fetchMock) => calls(fetchMock, (u, m) => m === 'GET' && u.includes('date='));
  const postCalls = (fetchMock) => calls(fetchMock, (u, m) => m === 'POST' && u.includes('/find-slots'));

  // Routes by request: the 14-day list, the 90-day read, ?date= reads, find-slots.
  function stubFetch({ list = EMPTY_14, wide, byDate = {}, find } = {}) {
    const fetchMock = vi.fn(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST') return jsonResponse(find);
      if (u.includes('windowDays=90')) {
        if (wide instanceof Error) return { ok: false, status: 500 };
        return jsonResponse(wide);
      }
      if (u.includes('windowDays=14')) return jsonResponse(list);
      const date = new URLSearchParams(u.split('?')[1]).get('date');
      return jsonResponse(byDate[date] || { primary: [], expander: [], metadata: { firstDayAvailability: null } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const renderPicker = (props = {}) => render(
    <SlotPicker token="synthetic-token" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} serviceMode="recurring" selectedFrequency="quarterly" {...props} />,
  );
  const pickChips = () => screen.getAllByRole('button', { name: /Pick/ }).map((b) => b.textContent);

  it('an empty 14-day list reads the 90-day horizon once and shows the 3 earliest openings in date order', async () => {
    // Route-optimal order, not date order: the earliest day is not first.
    const fetchMock = stubFetch({
      wide: {
        primary: [SLOT_DEC06, SLOT_NOV22, SLOT_NOV21],
        expander: [SLOT_DEC20, SLOT_DEC13],
        metadata: { firstDayAvailability: { date: '2099-11-21', openCount: 1 } },
      },
    });
    renderPicker();
    expect(await screen.findByText('The next 2 weeks are full. Here are open times after that:')).toBeInTheDocument();
    const chips = pickChips();
    expect(chips).toHaveLength(3);
    expect(chips[0]).toMatch(/Saturday, November 21 · 9:00 AM/);
    expect(chips[1]).toMatch(/Sunday, November 22 · 11:00 AM/);
    expect(chips[2]).toMatch(/Sunday, December 6 · 9:00 AM/);
    expect(screen.queryByText(/No open slots in the next 14 days/)).not.toBeInTheDocument();
    // The soonest times, not route picks: the strip drops its route-fit copy.
    expect(screen.queryByText('Our best times for you')).not.toBeInTheDocument();
    expect(screen.queryByText(/fit our route near you best/)).not.toBeInTheDocument();
    const wide = wideCalls(fetchMock);
    expect(wide).toHaveLength(1);
    expect(wide[0][0]).toContain('serviceMode=recurring');
    expect(wide[0][0]).toContain('selectedFrequency=quarterly');
    expect(dateCalls(fetchMock)).toHaveLength(0);
    // The date search and the specific-date control stay under the list.
    expect(screen.getByText(/pick one that works for you/i)).toBeInTheDocument();
  });

  it('the day grid marks every day the 90-day read opened, while the list stays at 3', async () => {
    stubFetch({
      wide: {
        primary: [SLOT_NOV21, SLOT_NOV22, SLOT_DEC06],
        expander: [SLOT_DEC13, SLOT_DEC20],
        metadata: { firstDayAvailability: { date: '2099-11-21', openCount: 1 } },
      },
    });
    renderPicker();
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    expect(pickChips()).toHaveLength(3);
    // Days beyond the 3 listed times still have openings in the grid.
    expect(screen.getByRole('option', { name: /Sunday, December 13, 1 opening/ })).toBeEnabled();
    expect(screen.getByRole('option', { name: /Sunday, December 20, 1 opening/ })).toBeEnabled();
    expect(screen.queryByRole('option', { name: /Sunday, December 13, no open times/ })).not.toBeInTheDocument();
  });

  it('says "Looking further ahead…" while the 90-day read runs', async () => {
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn((url) => (String(url).includes('windowDays=90') ? pending.promise : Promise.resolve(jsonResponse(EMPTY_14)))));
    renderPicker();
    expect(await screen.findByText('Looking further ahead…')).toBeInTheDocument();
    await act(async () => { pending.resolve(jsonResponse({ primary: [SLOT_NOV21], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } })); });
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    expect(screen.queryByText('Looking further ahead…')).not.toBeInTheDocument();
  });

  it('adds the true first open day (one ?date= read) when the capped list misses it', async () => {
    const fetchMock = stubFetch({
      wide: {
        primary: [SLOT_NOV22, SLOT_DEC06],
        expander: [SLOT_DEC13],
        metadata: { firstDayAvailability: { date: '2099-11-21', openCount: 1 } },
      },
      byDate: { '2099-11-21': { primary: [SLOT_NOV21], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } } },
    });
    renderPicker();
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    const chips = pickChips();
    expect(chips[0]).toMatch(/Saturday, November 21 · 9:00 AM/);
    expect(chips[1]).toMatch(/November 22/);
    expect(chips[2]).toMatch(/December 6/);
    expect(dateCalls(fetchMock)).toHaveLength(1);
    expect(dateCalls(fetchMock)[0][0]).toContain('date=2099-11-21');
    expect(wideCalls(fetchMock)).toHaveLength(1);
  });

  it('picking a look-ahead slot goes through the same selection callbacks as a normal slot', async () => {
    stubFetch({
      wide: { primary: [SLOT_NOV21, SLOT_NOV22], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } },
    });
    const onSelect = vi.fn();
    const onSelectMeta = vi.fn();
    renderPicker({ onSelect, onSelectMeta });
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    fireEvent.click(screen.getAllByRole('button', { name: /Pick/ })[1]);
    expect(onSelect).toHaveBeenLastCalledWith('s-nov22');
    expect(onSelectMeta).toHaveBeenLastCalledWith(expect.objectContaining({ slotId: 's-nov22', date: '2099-11-22' }));
    // The day's own time button picks the same way.
    fireEvent.click(screen.getByRole('button', { name: /Choose 11:00 AM on Sunday, November 22/ }));
    expect(onSelect).toHaveBeenLastCalledWith('s-nov22');
  });

  it('keeps a picked look-ahead slot selected (it is a visible slot, not dropped as unknown)', async () => {
    setGlassDefault(true);
    try {
      stubFetch({
        wide: { primary: [OPEN('s-far', '2099-11-21')], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } },
      });
      const onSelect = vi.fn();
      renderPicker({ selectedSlotId: 's-far', onSelect });
      await screen.findByText('The next 2 weeks are full. Here are open times after that:');
      expect(onSelect).not.toHaveBeenCalledWith(null);
    } finally {
      setGlassDefault(false);
    }
  });

  it.each([
    ['a 90-day answer with no slots', { wide: { primary: [], expander: [], metadata: { firstDayAvailability: null } } }],
    ['a failed 90-day read', { wide: new Error('boom') }],
  ])('keeps the old empty text for %s', async (_name, stub) => {
    const fetchMock = stubFetch(stub);
    renderPicker();
    expect(await screen.findByText(/No open slots in the next 14 days/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call (941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.queryByText(/The next 2 weeks are full/)).not.toBeInTheDocument();
    expect(wideCalls(fetchMock)).toHaveLength(1);
  });

  it.each([
    ['a parked estimate', { primary: [], expander: [], availableSlots: [], summary: null, reviewBeforeBooking: true, reason: 'contact_review' }],
    ['another review state', { primary: [], expander: [], availableSlots: [], summary: null, reviewBeforeBooking: true, reason: 'termite_trenching_review' }],
    ['a commercial estimate', { primary: [], expander: [], availableSlots: [], summary: null, commercialManualScheduling: true }],
    ['an invoice-only renewal', { primary: [], expander: [], availableSlots: [], summary: null, invoiceOnlyAcceptance: true }],
  ])('does not look ahead for %s', async (_name, body) => {
    const fetchMock = stubFetch({ list: body, wide: { primary: [SLOT_NOV21], expander: [] } });
    renderPicker({ onContactReview: vi.fn() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wideCalls(fetchMock)).toHaveLength(0);
    expect(screen.queryByText(/The next 2 weeks are full/)).not.toBeInTheDocument();
  });

  it('an empty date search before the first open day names that opening, with no second 90-day read or find-slots call', async () => {
    const fetchMock = stubFetch({
      wide: { primary: [SLOT_NOV22, SLOT_NOV21], expander: [SLOT_DEC06], metadata: { firstDayAvailability: { date: '2099-11-21' } } },
      find: { summary: 'Nothing that week.', primary: [], expander: [], nearby: false, window: { date_from: '2099-11-17', date_to: '2099-11-19' } },
    });
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    fireEvent.click(screen.getByRole('button', { name: 'run-date-search' }));
    expect(await screen.findByText('Nothing is open then. The first open time after that is Sat, Nov 21 at 9:00 AM.')).toBeInTheDocument();
    expect(postCalls(fetchMock)).toHaveLength(1);
    expect(wideCalls(fetchMock)).toHaveLength(1);
    const button = screen.getByRole('button', { name: /Choose 9:00 AM on Saturday, November 21/ });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenLastCalledWith('s-nov21');
    // Searching again reuses the cached read.
    fireEvent.click(screen.getByRole('button', { name: 'run-date-search' }));
    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(2));
    expect(wideCalls(fetchMock)).toHaveLength(1);
  });

  it('names no opening for an empty date search that ends on or after the first open day (the capped list can skip openings)', async () => {
    const fetchMock = stubFetch({
      wide: { primary: [SLOT_NOV21, SLOT_DEC20], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } },
      find: { summary: 'Nothing those days.', primary: [], expander: [], window: { date_from: '2099-11-25', date_to: '2099-11-30' } },
    });
    renderPicker();
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    fireEvent.click(screen.getByRole('button', { name: 'run-date-search' }));
    expect(await screen.findByText(/No open times then/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is open then/)).not.toBeInTheDocument();
    expect(screen.queryByText(/December 20/)).not.toBeInTheDocument();
    expect(postCalls(fetchMock)).toHaveLength(1);
  });

  it('an empty specific date before the first open day names that opening as a slot button', async () => {
    const fetchMock = stubFetch({
      wide: { primary: [SLOT_NOV22, SLOT_NOV21], expander: [SLOT_DEC06], metadata: { firstDayAvailability: { date: '2099-11-21' } } },
    });
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    fireEvent.change(screen.getByLabelText(/pick one that works for you/i), { target: { value: '2099-11-17' } });
    expect(await screen.findByText('Nothing is open on Tue, Nov 17. The next open time is Sat, Nov 21 at 9:00 AM.')).toBeInTheDocument();
    expect(wideCalls(fetchMock)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Choose 9:00 AM on Saturday, November 21/ }));
    expect(onSelect).toHaveBeenLastCalledWith('s-nov21');
  });

  it('keeps the old text for an empty specific date on or after the first open day (the capped list can skip openings)', async () => {
    stubFetch({
      wide: { primary: [OPEN('s-earlier', '2099-11-10'), SLOT_NOV21], expander: [], metadata: { firstDayAvailability: { date: '2099-11-10' } } },
    });
    renderPicker();
    await screen.findByText('The next 2 weeks are full. Here are open times after that:');
    fireEvent.change(screen.getByLabelText(/pick one that works for you/i), { target: { value: '2099-11-17' } });
    expect(await screen.findByText(/No open times then/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is open on/)).not.toBeInTheDocument();
  });

  it('reads nothing past 14 days when the 14-day list has times, even for an empty picked date', async () => {
    const fetchMock = stubFetch({ list: NORMAL, wide: { primary: [SLOT_NOV21], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } } });
    renderPicker();
    await screen.findByText('Monday, June 1');
    fireEvent.change(screen.getByLabelText(/pick one that works for you/i), { target: { value: '2099-06-20' } });
    expect(await screen.findByText(/No open times then/)).toBeInTheDocument();
    expect(wideCalls(fetchMock)).toHaveLength(0);
  });

  it('reads again for new params and ignores the answer for the old ones', async () => {
    const oldRead = deferred();
    const fetchMock = vi.fn((url) => {
      const u = String(url);
      if (u.includes('windowDays=90')) {
        return u.includes('selectedFrequency=quarterly') ? oldRead.promise : Promise.resolve(jsonResponse({ primary: [SLOT_DEC06], expander: [], metadata: { firstDayAvailability: { date: '2099-12-06' } } }));
      }
      return Promise.resolve(jsonResponse(EMPTY_14));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = renderPicker();
    await screen.findByText('Looking further ahead…');
    rerender(<SlotPicker token="synthetic-token" selectedSlotId={null} onSelect={vi.fn()} refreshSignal={0} serviceMode="recurring" selectedFrequency="monthly" />);
    await waitFor(() => expect(screen.getAllByText(/Sunday, December 6/).length).toBeGreaterThan(0));
    await act(async () => { oldRead.resolve(jsonResponse({ primary: [SLOT_NOV21], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } })); });
    expect(screen.queryByText(/November 21/)).not.toBeInTheDocument();
    expect(wideCalls(fetchMock)).toHaveLength(2);
  });

  // Clock is 2099-10-01 ET, so the 7-day horizon ends 2099-10-08 (inclusive).
  describe('text-or-call line when nothing is open in 7 days', () => {
    const NOTE = 'no-time-soon-note';
    const LINE = /Nothing is open in the next 7 days\. If you need a sooner visit, text or call the office/;

    it('shows the line with text and call links when every time on screen is past day 7', async () => {
      stubFetch({ list: { primary: [OPEN('late', '2099-10-12')], expander: [], metadata: { firstDayAvailability: { date: '2099-10-12' } } } });
      renderPicker();
      await screen.findAllByText(/Arrival window|Pick/);
      expect(screen.getByTestId(NOTE).textContent).toMatch(LINE);
      expect(screen.getByRole('link', { name: 'Text (941) 297-5749' })).toHaveAttribute('href', 'sms:+19412975749');
      expect(screen.getAllByRole('link', { name: 'Call (941) 297-5749' })[0]).toHaveAttribute('href', 'tel:+19412975749');
    });

    it('shows the line on the look-ahead list (14-day list empty, first opening after Nov 21)', async () => {
      stubFetch({ wide: { primary: [SLOT_NOV21], expander: [], metadata: { firstDayAvailability: { date: '2099-11-21' } } } });
      renderPicker();
      await screen.findByText('The next 2 weeks are full. Here are open times after that:');
      expect(screen.getByTestId(NOTE).textContent).toMatch(LINE);
    });

    it('stays away when a time on screen is on day 7 (inclusive)', async () => {
      stubFetch({ list: { primary: [OPEN('edge', '2099-10-08'), OPEN('later', '2099-10-12')], expander: [], metadata: { firstDayAvailability: { date: '2099-10-08' } } } });
      renderPicker();
      await screen.findAllByText(/Arrival window|Pick/);
      expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument();
    });

    it('stays away when firstDayAvailability names an open day inside 7 days that the capped list left out', async () => {
      stubFetch({ list: { primary: [OPEN('late', '2099-10-12')], expander: [], metadata: { firstDayAvailability: { date: '2099-10-03' } } } });
      renderPicker();
      await screen.findAllByText(/Arrival window|Pick/);
      expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument();
    });

    it('stays away when nothing is on screen (the empty text already gives a call link)', async () => {
      stubFetch({ wide: { primary: [], expander: [], metadata: { firstDayAvailability: null } } });
      renderPicker();
      await screen.findByText(/No open slots in the next 14 days/);
      expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument();
    });

    it('stays away for an office-review answer and after a date pick', async () => {
      stubFetch({ list: { primary: [OPEN('late', '2099-10-12')], expander: [], reviewBeforeBooking: true, reason: 'other', metadata: {} } });
      const view = renderPicker();
      await screen.findAllByText(/Arrival window|Pick/);
      expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument();
      view.unmount();
      stubFetch({
        list: { primary: [OPEN('late', '2099-10-12')], expander: [], metadata: { firstDayAvailability: { date: '2099-10-12' } } },
        byDate: { '2099-10-20': { primary: [OPEN('d20', '2099-10-20')], expander: [], metadata: {} } },
      });
      renderPicker();
      await screen.findByTestId(NOTE);
      fireEvent.change(screen.getByLabelText(/pick one that works for you/i), { target: { value: '2099-10-20' } });
      await waitFor(() => expect(screen.queryByTestId(NOTE)).not.toBeInTheDocument());
    });
  });
});
