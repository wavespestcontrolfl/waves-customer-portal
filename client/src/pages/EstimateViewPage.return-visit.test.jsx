// @vitest-environment jsdom
// Returning-visitor strip — renders only from a server-composed `returnVisit`
// block, names exactly the changes the server named, and shares through the
// customer's own phone (never a Waves send).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReturnVisitStrip } from './EstimateViewPage';

afterEach(() => cleanup());

describe('ReturnVisitStrip', () => {
  it('renders nothing without a payload or on a first visit', () => {
    const { container } = render(<ReturnVisitStrip returnVisit={null} />);
    expect(container).toBeEmptyDOMElement();
    const second = render(<ReturnVisitStrip returnVisit={{ visitNumber: 1, lastVisitAt: null, changes: [] }} />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('names the server-provided changes since the previous visit', () => {
    render(<ReturnVisitStrip returnVisit={{
      visitNumber: 3,
      lastVisitAt: '2026-08-30T14:00:00.000Z',
      changes: [
        { kind: 'service_removed', label: 'You removed Mosquito; the price below reflects that.', at: '2026-08-31T10:00:00.000Z' },
        { kind: 'extension_granted', label: 'Your expiration date was extended.', at: '2026-08-31T11:00:00.000Z' },
      ],
    }} />);
    expect(screen.getByText(/what’s changed since August 30/)).toBeInTheDocument();
    expect(screen.getByText('You removed Mosquito; the price below reflects that.')).toBeInTheDocument();
    expect(screen.getByText('Your expiration date was extended.')).toBeInTheDocument();
  });

  it('never claims "nothing changed" when the server named no change (only two stamps are recognized)', () => {
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} />);
    expect(screen.getByText(/Back for another look since August 30 — the estimate below is current as of today\./)).toBeInTheDocument();
    expect(screen.queryByText(/same price|nothing has changed/i)).not.toBeInTheDocument();
  });

  it('shares through the customer’s own sms: draft when navigator.share is absent', () => {
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} />);
    const link = screen.getByRole('link', { name: 'Text this to someone' });
    expect(link.getAttribute('href')).toBe(`sms:?&body=${encodeURIComponent(window.location.href)}`);
  });

  it('prefers navigator.share when the device offers it', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} />);
    fireEvent.click(screen.getByRole('link', { name: 'Text this to someone' }));
    expect(share).toHaveBeenCalledWith({ title: 'My Waves estimate', url: window.location.href });
    vi.unstubAllGlobals();
  });

  it('drops the Ask action when the page renders no Ask bar (regulated certificate surfaces, review-before-booking)', () => {
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} showAsk={false} />);
    expect(screen.queryByRole('button', { name: 'Ask a question' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Text this to someone' })).toBeInTheDocument();
  });

  it('"Ask a question" hands off to the ask scroll', () => {
    const onAsk = vi.fn();
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} onAsk={onAsk} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask a question' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });
});
