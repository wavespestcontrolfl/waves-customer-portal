// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminFetch } from '../../utils/admin-fetch';
import HeldLinesPanel, { HeldLinesChip, groupHeldLines, heldLineItem, useHeldLines } from './HeldLinesPanel';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const line = { hold_id: 'h1', phone_e164: '+19415550100', held_at: '2026-10-01T15:00:00.000Z', source_call_log_id: 'call-9',
  call_created_at: '2026-10-01T14:50:00.000Z', first_name: 'Relay', last_name: 'Caller', card_id: 'tn-old', card_status: 'resolved',
  card_updated_at: '2026-10-02T10:00:00.000Z', blocked_by_ownership_card: false };

// The page's wiring in miniature: the chip, the panel, and the callbacks the page passes.
function Harness({ onRelease = () => {}, onError = () => {}, actioning = null }) {
  const held = useHeldLines({ onError });
  return (
    <>
      <HeldLinesChip held={held} />
      <HeldLinesPanel held={held} triageMode actioning={actioning} onRelease={onRelease} />
    </>
  );
}
const open = async () => { fireEvent.click(screen.getByRole('button', { name: /held lines/i })); };

describe('useHeldLines + HeldLinesPanel', () => {
  it('loads nothing until the chip is opened, then lists one row per line (number, since, call, card state)', async () => {
    adminFetch.mockResolvedValue({ lines: [line, { ...line, hold_id: 'h2', source_call_log_id: 'call-10', card_id: 'tn-2', held_at: '2026-10-05T15:00:00.000Z' }] });
    render(<Harness />);
    expect(adminFetch).not.toHaveBeenCalled();
    await open();
    const row = await screen.findByTestId('held-line');
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/held-lines');
    expect(screen.getAllByTestId('held-line')).toHaveLength(1);
    expect(row.textContent).toContain('+19415550100');
    expect(row.textContent).toContain('Held since Oct 1, 2026');
    expect(row.textContent).toContain('Relay Caller');
    expect(row.textContent).toContain('Card resolved');
    expect(row.textContent).toContain('1 more call hold this line');
  });

  it('shows nothing when closed or outside triage mode, and the empty state when no line is held', async () => {
    adminFetch.mockResolvedValue({ lines: [] });
    const { rerender } = render(<HeldLinesPanel held={{ open: true, lines: [], loading: false }} triageMode={false} onRelease={() => {}} />);
    expect(screen.queryByText('Held lines')).toBeNull();
    rerender(<HeldLinesPanel held={{ open: false, lines: [], loading: false }} triageMode onRelease={() => {}} />);
    expect(screen.queryByText('Held lines')).toBeNull();
    rerender(<HeldLinesPanel held={{ open: true, lines: [], loading: false }} triageMode onRelease={() => {}} />);
    expect(screen.getByText('No held lines.')).toBeInTheDocument();
  });

  it('the row button hands the page a pseudo card that names the line', async () => {
    adminFetch.mockResolvedValue({ lines: [line] });
    const onRelease = vi.fn();
    render(<Harness onRelease={onRelease} />);
    await open();
    fireEvent.click(within(await screen.findByTestId('held-line')).getByRole('button', { name: /line can get texts/i }));
    expect(onRelease).toHaveBeenCalledWith(expect.objectContaining({ held: true, id: 'tn-old', line_e164: '+19415550100', status: 'resolved', updated_at: line.card_updated_at }));
    expect(heldLineItem(line).payload).toEqual({ ani_phone: '+19415550100' });
  });

  it('a failed load tells the page', async () => {
    adminFetch.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    render(<Harness onError={onError} />);
    await open();
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to load held lines.'));
  });

  it('shows the ownership warning when ANY call on the line is blocked, even if the card used for the release is not', async () => {
    const free = { ...line, hold_id: 'h5', card_id: 'tn-free', held_at: '2026-10-05T15:00:00.000Z' };
    adminFetch.mockResolvedValue({ lines: [free, { ...line, hold_id: 'h6', card_id: 'tn-blocked', blocked_by_ownership_card: true }] });
    render(<Harness />);
    await open();
    expect((await screen.findByTestId('held-line')).textContent).toContain('open "not my number" card');
  });

  it('shows no ownership warning when no call on the line is blocked', async () => {
    adminFetch.mockResolvedValue({ lines: [line, { ...line, hold_id: 'h7', card_id: 'tn-2' }] });
    render(<Harness />);
    await open();
    expect((await screen.findByTestId('held-line')).textContent).not.toContain('not my number');
  });

  it('prefers a call whose release is not blocked as the row\'s card', () => {
    const blocked = { ...line, blocked_by_ownership_card: true, card_id: 'blocked' };
    const free = { ...line, hold_id: 'h3', card_id: 'free' };
    expect(groupHeldLines([blocked, free])[0].primary.card_id).toBe('free');
    expect(groupHeldLines([blocked, free])[0].blocked).toBe(true);
  });

  it('the panel text is at least 14px: no text-11/12/13 class in the chip or the panel', async () => {
    adminFetch.mockResolvedValue({ lines: [{ ...line, blocked_by_ownership_card: true }] });
    render(<Harness />);
    const chip = screen.getByRole('button', { name: /held lines/i });
    fireEvent.click(chip);
    const row = await screen.findByTestId('held-line');
    const panel = row.closest('.divide-y').parentElement;
    for (const el of [chip, chip.querySelector('span'), ...panel.querySelectorAll('div, p, span')].filter(Boolean)) {
      expect(el.className).not.toMatch(/\btext-(11|12|13)\b/);
    }
  });
});
