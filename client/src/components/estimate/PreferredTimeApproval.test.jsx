// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PreferredTimeApproval, { preferredTimeSummary } from './PreferredTimeApproval';

afterEach(cleanup);

describe('PreferredTimeApproval (GATE_ESTIMATE_APPROVE_PREFERRED_TIME)', () => {
  it('starts as one quiet link under the time picker', () => {
    render(<PreferredTimeApproval value={null} onApply={() => {}} onClear={() => {}} />);
    expect(screen.getByRole('button', { name: /None of these times work\? Approve now and tell us when suits you\./ })).toBeInTheDocument();
    expect(screen.queryByTestId('preferred-time-form')).toBeNull();
  });

  it('needs at least one day and a part of the day before it can be used, and sends sorted keys plus the note', () => {
    const onApply = vi.fn();
    render(<PreferredTimeApproval value={null} onApply={onApply} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    const use = screen.getByRole('button', { name: 'Use these days' });
    expect(use).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }));
    expect(use).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Afternoon' }));
    expect(use).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Dogs out until 9  ' } });
    fireEvent.click(use);
    expect(onApply).toHaveBeenCalledWith({ days: ['wed', 'mon'], window: 'afternoon', note: 'Dogs out until 9' });
  });

  it('offers only Mon to Sat, with no promise of a date', () => {
    render(<PreferredTimeApproval value={null} onApply={() => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => expect(screen.getByRole('button', { name: d })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Sun' })).toBeNull();
    expect(screen.getByTestId('preferred-time-form').textContent).not.toMatch(/\bwill be\b.*\b(on|at)\b/i);
  });

  it('a saved preference reads back, says the office confirms, and can be changed or dropped for a time', () => {
    const onClear = vi.fn();
    render(<PreferredTimeApproval value={{ days: ['mon', 'wed'], window: 'morning' }} onApply={() => {}} onClear={onClear} />);
    const summary = screen.getByTestId('preferred-time-summary');
    expect(summary).toHaveTextContent('Mon, Wed, mornings');
    expect(summary).toHaveTextContent('our office will contact you to confirm your first visit');
    fireEvent.click(screen.getByRole('button', { name: 'Pick a time instead' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('Back to times closes the form without saving', () => {
    const onApply = vi.fn();
    render(<PreferredTimeApproval value={null} onApply={onApply} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to times' }));
    expect(screen.queryByTestId('preferred-time-form')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('summary text helper', () => {
    expect(preferredTimeSummary({ days: ['sat'], window: 'either' })).toBe('Sat, mornings or afternoons');
    expect(preferredTimeSummary({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], window: 'morning' })).toBe('any day Mon to Sat, mornings');
    expect(preferredTimeSummary(null)).toBe('');
  });
});
