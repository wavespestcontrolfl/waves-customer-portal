// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FindTimePanel from './FindTimePanel';
import { resetSummaryAvailability } from './useBestTimes';
import { etDateString } from '../../lib/timezone';

// A stand-in for the Google-backed field: typing changes the text, the button picks a suggestion.
vi.mock('../AddressAutocomplete', () => ({
  default: ({ id, value, onChange, onSelect }) => (
    <div>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      <button
        type="button"
        onClick={() => onSelect({
          formatted: '100 Example Way, Bradenton, FL 34200, USA',
          line1: '100 Example Way',
          city: 'Bradenton',
          state: 'FL',
          zip: '34200',
          lat: 27.5,
          lng: -82.5,
        })}
      >
        pick suggestion
      </button>
    </div>
  ),
}));

const slot = (date, start, over = {}) => ({
  date,
  start_time: start,
  end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  detour_minutes: 12,
  drive_in_minutes: 7,
  rain_chance: 20,
  technician: { id: 'tech-1', name: 'Example Tech' },
  ...over,
});

function answer(today) {
  return {
    ok: true,
    slots: [],
    summary: {
      days: [{ date: today, status: 'open', hours: [slot(today, '10:00')] }],
      best: {
        day: [slot(today, '10:00'), slot(today, '13:00', { technician: { id: 'tech-2', name: 'Other Tech' } })],
        week: [slot('2035-01-02', '09:00')],
        week_covered: true,
      },
    },
  };
}

function stubFetch(body) {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

beforeEach(() => { resetSummaryAvailability(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
});

const openAndPick = async () => {
  fireEvent.click(screen.getByTestId('find-time-open'));
  fireEvent.click(screen.getByText('pick suggestion'));
};

describe('FindTimePanel', () => {
  it('renders nothing with the gate off', () => {
    const fetcher = stubFetch({});
    const { container } = render(<FindTimePanel enabled={false} onBook={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('find-time-open')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('searches on the address alone: no customer, no visit, hint + summary + best rows', async () => {
    const today = etDateString();
    const fetcher = stubFetch(answer(today));
    render(<FindTimePanel enabled onBook={vi.fn()} />);
    fireEvent.click(screen.getByTestId('find-time-open'));
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('pick suggestion'));
    await screen.findByTestId('find-time-results');
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({
      hint: true, summary: true, bestRows: true, durationMinutes: 60,
      address: '100 Example Way, Bradenton, FL 34200, USA', lat: 27.5, lng: -82.5, slotStepMinutes: 60,
    });
    expect(body.customerId).toBeUndefined();
    expect(body.serviceId).toBeUndefined();
    expect(fetcher.mock.calls[0][0]).toMatch(/\/admin\/schedule\/find-time$/);
    expect(body.dateFrom).toBe(today);
    // Chips carry the hour, the drive here, the added drive, rain and the tech.
    const chips = screen.getAllByTestId('availability-hour');
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toContain('10 AM');
    expect(chips[0].textContent).toContain('7 min here');
    expect(chips[0].textContent).toContain('20% rain');
    expect(chips[0].textContent).toContain('Example Tech');
  });

  it('does not search on half-typed text', () => {
    const fetcher = stubFetch(answer(etDateString()));
    render(<FindTimePanel enabled onBook={vi.fn()} />);
    fireEvent.click(screen.getByTestId('find-time-open'));
    fireEvent.change(document.getElementById('find-time-address'), { target: { value: '100 Exam' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText(/Pick the address from the list/)).toBeTruthy();
  });

  it('Book hands the chip date, hour, technician and the address to the booking form', async () => {
    const today = etDateString();
    stubFetch(answer(today));
    const onBook = vi.fn();
    render(<FindTimePanel enabled onBook={onBook} />);
    await openAndPick();
    await screen.findByTestId('find-time-results');
    const book = screen.getByTestId('find-time-book');
    expect(book.disabled).toBe(true);
    // The second chip on the day row: 1 PM on the other technician's route.
    fireEvent.click(screen.getAllByTestId('availability-hour')[1]);
    expect(book.disabled).toBe(false);
    expect(book.textContent).toMatch(/^Book .* · 1 PM$/);
    fireEvent.click(book);
    expect(onBook).toHaveBeenCalledTimes(1);
    expect(onBook).toHaveBeenCalledWith({
      date: today,
      windowStart: '13:00',
      techId: 'tech-2',
      durationMinutes: 60,
      quickAddAddress: { address: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200' },
    });
  });

  it('while a new length re-checks, the old chips take no pick and Book is off', async () => {
    const today = etDateString();
    let release;
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer(today) }));
    vi.stubGlobal('fetch', fetcher);
    const onBook = vi.fn();
    render(<FindTimePanel enabled onBook={onBook} />);
    await openAndPick();
    await screen.findByTestId('find-time-results');
    fireEvent.click(screen.getAllByTestId('availability-hour')[0]);
    // The next answer hangs, so the rows on screen are the 60-minute ones.
    fetcher.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    fireEvent.change(screen.getByLabelText('Visit length'), { target: { value: '120' } });
    await waitFor(() => expect(screen.getByTestId('find-time-results').style.opacity).toBe('0.6'));
    const chips = screen.getAllByTestId('availability-hour');
    expect(chips.every((chip) => chip.disabled)).toBe(true);
    const book = screen.getByTestId('find-time-book');
    expect(book.disabled).toBe(true);
    fireEvent.click(book);
    expect(onBook).not.toHaveBeenCalled();
    release?.({ ok: true, status: 200, json: async () => answer(today) });
  });

  it('a week-row chip books its own date', async () => {
    stubFetch(answer(etDateString()));
    const onBook = vi.fn();
    render(<FindTimePanel enabled onBook={onBook} />);
    await openAndPick();
    await screen.findByTestId('find-time-results');
    fireEvent.click(screen.getAllByTestId('availability-hour')[2]);
    fireEvent.click(screen.getByTestId('find-time-book'));
    expect(onBook.mock.calls[0][0]).toMatchObject({ date: '2035-01-02', windowStart: '09:00', techId: 'tech-1' });
  });

  it('says best times are off when the server answers gated', async () => {
    stubFetch({ ok: true, gated: true, slots: [] });
    render(<FindTimePanel enabled onBook={vi.fn()} />);
    await openAndPick();
    await waitFor(() => expect(screen.getByTestId('find-time-off').textContent).toBe('Best times are off.'));
    expect(screen.queryByTestId('find-time-book')).toBeNull();
  });
});
