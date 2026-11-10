// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassStickyBookBar, GlassTechChip } from './GlassEstimateExtras';

afterEach(() => cleanup());

describe('GlassStickyBookBar', () => {
  it('renders the approve CTA whenever the selection is priced — no price shown', () => {
    // codex 2639 r1: multi-service plans stopped computing a combined total,
    // and the old priceLabel gate silently dropped the whole bar with it.
    // The gate is an explicit boolean now; the bar itself never shows a price.
    render(<GlassStickyBookBar show slotMeta={null} onApprove={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Approve my plan →' });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).not.toMatch(/\$/);
  });

  it('names the held slot on the CTA when one is selected', () => {
    render(<GlassStickyBookBar show slotMeta={{ dow: 'Tue', time: '9 AM' }} onApprove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve Tue 9 AM →' })).toBeInTheDocument();
  });

  it('adds the date for a slot more than 6 days out, like the main Approve button (owner 2026-11-06)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T15:00:00Z')); // Fri 10:00 ET
    try {
      render(<GlassStickyBookBar show slotMeta={{ dow: 'Mon', time: '9:00 AM', date: '2026-11-23' }} onApprove={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Approve Mon, Nov 23, 9:00 AM →' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing for unpriced selections (quote-required / ranged)', () => {
    const { container } = render(<GlassStickyBookBar show={false} slotMeta={null} onApprove={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('GlassTechChip', () => {
  it('names the slot\'s own technician from the availability payload', () => {
    const { container } = render(<GlassTechChip slotMeta={{ techFirstName: 'Sam', dow: 'Tue', time: '9 AM' }} />);
    expect(screen.getByText('Your technician: Sam — Tue 9 AM')).toBeInTheDocument();
    expect(container.querySelector('.gc-tc-avatar').textContent).toBe('S');
  });

  it('a slot with no technician attached names no one (no default name, no initial)', () => {
    const { container } = render(<GlassTechChip slotMeta={{ techFirstName: null, dow: 'Tue', time: '9 AM' }} />);
    expect(screen.getByText('Your technician — Tue 9 AM')).toBeInTheDocument();
    expect(container.querySelector('.gc-tc-avatar')).toBeNull();
    expect(container.textContent).not.toMatch(/Adam/);
  });

  it('renders nothing before a slot is picked', () => {
    const { container } = render(<GlassTechChip slotMeta={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
