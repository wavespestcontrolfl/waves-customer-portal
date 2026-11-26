// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import SlotConflictNotice from './SlotConflictNotice';

afterEach(cleanup);

// GATE_TECH_SHIFT_HOURS (D4): the pickers show the shift line the save would state (useSlotConflicts).
const LINE = "Synthetic Tech's shift is 8:00 AM to 5:00 PM. This visit is outside those hours.";
const booked = { customerName: 'Fixture Customer', serviceType: 'Pest Control', windowStart: '16:00', windowEnd: '17:00' };

it('shows nothing with no overlap and no line', () => {
  const { container } = render(<SlotConflictNotice conflicts={[]} />);
  expect(container).toBeEmptyDOMElement();
  cleanup();
  expect(render(<SlotConflictNotice conflicts={[]} shiftWarning={null} />).container).toBeEmptyDOMElement();
});

it('the line alone: its own card, with the site\'s style, and it does not say double-book', () => {
  render(<SlotConflictNotice conflicts={[]} shiftWarning={LINE} style={{ marginTop: 10 }} />);
  const card = screen.getByTestId('slot-shift-warning');
  expect(card).toHaveTextContent(LINE);
  expect(card).toHaveTextContent('Shift hours do not block saving.');
  expect(card).toHaveStyle({ marginTop: '10px' });
  expect(screen.queryByText(/double-book/)).not.toBeInTheDocument();
});

it('an overlap alone is as before: no shift card', () => {
  render(<SlotConflictNotice conflicts={[booked]} style={{ marginTop: 10 }} />);
  expect(screen.getByText('Fixture Customer (pest control) is already booked 4:00 PM–5:00 PM on this date.')).toBeInTheDocument();
  expect(screen.getByText('Saving will double-book this time slot.')).toBeInTheDocument();
  expect(screen.queryByTestId('slot-shift-warning')).not.toBeInTheDocument();
});

it('both: the overlap card first, then the shift card, each said once', () => {
  const { container } = render(<SlotConflictNotice conflicts={[booked]} shiftWarning={LINE} style={{ marginTop: 10, marginBottom: 14 }} />);
  expect(screen.getAllByText('Saving will double-book this time slot.')).toHaveLength(1);
  const shift = screen.getByTestId('slot-shift-warning');
  expect(screen.getAllByText(LINE)).toHaveLength(1);
  const cards = [...container.children];
  expect(cards).toHaveLength(2);
  expect(cards[1]).toBe(shift);
  // The pair keeps the site's outer margins, with a small gap between the cards.
  expect(cards[0]).toHaveStyle({ marginTop: '10px', marginBottom: '8px' });
  expect(shift).toHaveStyle({ marginTop: '0px', marginBottom: '14px' });
});
