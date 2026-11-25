// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RouteShiftNotice from './RouteShiftNotice';

// GATE_TECH_SHIFT_HOURS (D4): the line a Quick Move sheet shows when a "rest of route" move
// would land later stops outside the technician's shift.
const upper = (value) => `<${value}>`;
const late = { windowStart: '17:00', windowEnd: '18:00' };
const later = { windowStart: '20:00', windowEnd: '21:00' };
afterEach(cleanup);

describe('RouteShiftNotice', () => {
  it('shows nothing with no row', () => {
    const { container } = render(<RouteShiftNotice rows={[]} formatTime={upper} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the office: one stop, its window, and the move is still allowed', () => {
    render(<RouteShiftNotice rows={[late]} formatTime={upper} />);
    expect(screen.getByText("⚠️ With the rest of the route, 1 stop lands outside the technician's shift hours (<17:00>-<18:00>). The move is still allowed.")).toBeInTheDocument();
  });

  it('the office: several stops are counted and the first window is named', () => {
    render(<RouteShiftNotice rows={[late, later, later]} formatTime={upper} />);
    expect(screen.getByText("⚠️ With the rest of the route, 3 stops land outside the technician's shift hours (first: <17:00>-<18:00>). The move is still allowed.")).toBeInTheDocument();
  });

  it('the technician: the stop will not move', () => {
    render(<RouteShiftNotice own rows={[late]} formatTime={upper} />);
    expect(screen.getByText('⚠️ With the rest of the route, 1 stop lands outside your shift hours (<17:00>-<18:00>) — that stop will not move. Pick a different time.')).toBeInTheDocument();
  });

  it('the technician: several stops will not move', () => {
    render(<RouteShiftNotice own rows={[late, later]} formatTime={upper} />);
    expect(screen.getByText('⚠️ With the rest of the route, 2 stops land outside your shift hours (first: <17:00>-<18:00>) — those stops will not move. Pick a different time.')).toBeInTheDocument();
  });

  it('a stop with no stored end: the start alone, and no end is formatted', () => {
    const noEnd = { windowStart: '10:45', windowEnd: null };
    const strict = (value) => { if (value == null) throw new Error('no time to format'); return upper(value); };
    render(<RouteShiftNotice rows={[noEnd]} formatTime={strict} />);
    expect(screen.getByText("⚠️ With the rest of the route, 1 stop lands outside the technician's shift hours (from <10:45>). The move is still allowed.")).toBeInTheDocument();
    cleanup();
    render(<RouteShiftNotice own rows={[noEnd, late]} formatTime={strict} />);
    expect(screen.getByText('⚠️ With the rest of the route, 2 stops land outside your shift hours (first: from <10:45>) — those stops will not move. Pick a different time.')).toBeInTheDocument();
  });

  it('a stored 24:00 is midnight, at a start and at an end', () => {
    render(<RouteShiftNotice own rows={[{ windowStart: '24:00', windowEnd: null }]} formatTime={upper} />);
    expect(screen.getByText(/\(from <00:00>\)/)).toBeInTheDocument();
    cleanup();
    render(<RouteShiftNotice rows={[{ windowStart: '23:00', windowEnd: '24:00' }]} formatTime={upper} />);
    expect(screen.getByText(/\(<23:00>-<00:00>\)/)).toBeInTheDocument();
  });

  it('takes the style it is given', () => {
    render(<RouteShiftNotice rows={[late]} formatTime={upper} style={{ marginBottom: 18 }} />);
    expect(screen.getByText(/1 stop lands/)).toHaveStyle({ marginBottom: '18px' });
  });
});
