// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassStickyBookBar } from './GlassEstimateExtras';

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

  it('renders nothing for unpriced selections (quote-required / ranged)', () => {
    const { container } = render(<GlassStickyBookBar show={false} slotMeta={null} onApprove={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
