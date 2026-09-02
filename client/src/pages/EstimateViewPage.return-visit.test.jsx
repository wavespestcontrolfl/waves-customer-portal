// @vitest-environment jsdom
// Returning-visitor strip — renders only from a server-composed `returnVisit`
// block, names exactly the changes the server named, and shares through the
// customer's own phone (never a Waves send).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const nativeShare = { can: false, native: false, share: vi.fn(async () => true) };
vi.mock('../native/nativeFile', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, canShareNative: () => nativeShare.can, shareUrlNative: (...a) => nativeShare.share(...a) };
});
// The page reads the shell flag from native/platform, not nativeFile.
vi.mock('../native/platform', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isNativeApp: () => nativeShare.native };
});
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
        { kind: 'service_removed', label: 'Mosquito was removed from this estimate; the price below reflects that.', at: '2026-08-31T10:00:00.000Z' },
        { kind: 'extension_granted', label: 'The expiration date was extended.', at: '2026-08-31T11:00:00.000Z' },
      ],
    }} />);
    expect(screen.getByText(/This is visit 3 to this estimate — here’s what’s changed on it since August 30/)).toBeInTheDocument();
    expect(screen.getByText('Mosquito was removed from this estimate; the price below reflects that.')).toBeInTheDocument();
    expect(screen.getByText('The expiration date was extended.')).toBeInTheDocument();
    // Estimate-level wording only — never claims the current reader did it.
    expect(screen.queryByText(/\byou\b/i)).not.toBeInTheDocument();
  });

  it('never claims "nothing changed" when the server named no change (only two stamps are recognized)', () => {
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} />);
    expect(screen.getByText(/This is visit 2 to this estimate \(the last one was August 30\) — the estimate below is current as of today\./)).toBeInTheDocument();
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

  it('in the Capacitor shell the native share sheet runs before any Web Share or sms fallback (GH codex r3 P1)', () => {
    nativeShare.can = true;
    const webShare = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, share: webShare });
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} />);
    fireEvent.click(screen.getByRole('link', { name: 'Text this to someone' }));
    expect(nativeShare.share).toHaveBeenCalledWith(window.location.href, 'My Waves estimate');
    expect(webShare).not.toHaveBeenCalled();
    nativeShare.can = false;
    vi.unstubAllGlobals();
  });

  it('an installed native binary WITHOUT the Share plugin leaves the sms: link untouched (GH codex r4 P1)', () => {
    nativeShare.native = true;
    nativeShare.can = false;
    const webShare = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, share: webShare });
    render(<ReturnVisitStrip returnVisit={{ visitNumber: 2, lastVisitAt: '2026-08-30T14:00:00.000Z', changes: [] }} />);
    const link = screen.getByRole('link', { name: 'Text this to someone' });
    const evt = fireEvent.click(link);
    expect(webShare).not.toHaveBeenCalled();
    expect(evt).toBe(true); // default sms: navigation not prevented
    nativeShare.native = false;
    vi.unstubAllGlobals();
  });
});
