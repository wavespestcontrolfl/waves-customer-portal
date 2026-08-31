// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminToastHost, showAdminToast } from './Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('AdminToastHost', () => {
  it('renders a neutral toast and auto-dismisses after 4000ms', () => {
    render(<AdminToastHost />);
    act(() => showAdminToast('Preferences saved'));
    expect(screen.getByText('Preferences saved')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3900));
    expect(screen.getByText('Preferences saved')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('Preferences saved')).not.toBeInTheDocument();
  });

  it('keeps an alert-tier toast with undo for 8000ms and fires undo on click', () => {
    const undo = vi.fn();
    render(<AdminToastHost />);
    act(() => showAdminToast('Visit deleted', { tier: 'alert', undo }));

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByText('Visit deleted')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Visit deleted')).not.toBeInTheDocument();
  });

  it('caps a tier at 3 visible toasts and collapses older ones into +N MORE', () => {
    render(<AdminToastHost />);
    act(() => {
      showAdminToast('one');
      showAdminToast('two');
      showAdminToast('three');
      showAdminToast('four');
      showAdminToast('five');
    });
    expect(screen.queryByText('one')).not.toBeInTheDocument();
    expect(screen.queryByText('two')).not.toBeInTheDocument();
    expect(screen.getByText('three')).toBeInTheDocument();
    expect(screen.getByText('four')).toBeInTheDocument();
    expect(screen.getByText('five')).toBeInTheDocument();
    expect(screen.getByText('+2 MORE')).toBeInTheDocument();
  });

  it('renders the two tiers into separate stacks', () => {
    render(<AdminToastHost />);
    act(() => {
      showAdminToast('Saved');
      showAdminToast('Something failed', { tier: 'alert' });
    });
    const stacks = screen.getAllByRole('status');
    expect(stacks).toHaveLength(2);
    expect(stacks[0]).toHaveTextContent('Saved');
    expect(stacks[1]).toHaveTextContent('Something failed');
  });

  it('is a safe no-op when no host is mounted', () => {
    expect(() => showAdminToast('nobody listening')).not.toThrow();
  });
});
