// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import PublicStateCard from './PublicStateCard';

afterEach(() => cleanup());

// The point of this primitive is that a page CANNOT reintroduce the drift
// G-02 measured, so the tests assert the invariants rather than the pixels.

describe('PublicStateCard', () => {
  it('renders the title as an h1 on every state (G-07: h1Count was 0 on ten states)', () => {
    for (const state of ['not-found', 'expired', 'error']) {
      const { unmount } = render(<PublicStateCard state={state} title={`t-${state}`} />);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`t-${state}`);
      unmount();
    }
  });

  it('authors no font-size on the h1 — the glass sheet sizes it !important', () => {
    render(<PublicStateCard state="error" title="Sized by the sheet" />);
    expect(screen.getByRole('heading', { level: 1 }).style.fontSize).toBe('');
  });

  it('is an alert region so the state is announced', () => {
    render(<PublicStateCard state="not-found" title="Gone" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('defaults not-found and expired to the contact pair, with Call as the one primary', () => {
    render(<PublicStateCard state="not-found" title="Gone" />);
    const text = screen.getByRole('link', { name: 'Text Waves' });
    const call = screen.getByRole('link', { name: 'Call Waves' });
    expect(text).toHaveAttribute('href', 'sms:+19412975749');
    expect(call).toHaveAttribute('href', 'tel:+19412975749');
    // One primary per card: Call claims the 48 tier, Text is the 44 chip.
    expect(call).toHaveAttribute('data-glass-size', 'primary');
    expect(text).not.toHaveAttribute('data-glass-size');
  });

  it('defaults error to a retry and no contact pair', () => {
    render(<PublicStateCard state="error" title="Temporary" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Text Waves' })).toBeNull();
  });

  it('gives the retry the primary tier and demotes Call when both are present', () => {
    render(<PublicStateCard state="not-found" title="Gone" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute('data-glass-size', 'primary');
    expect(screen.getByRole('link', { name: 'Call Waves' })).not.toHaveAttribute('data-glass-size');
  });

  it('calls onRetry when the retry is pressed', () => {
    const onRetry = vi.fn();
    render(<PublicStateCard state="error" title="Temporary" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('contact="call" renders the number itself, from the shared constant', () => {
    render(<PublicStateCard state="not-found" title="Gone" contact="call" />);
    expect(screen.getByRole('link', { name: 'Call (941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.queryByRole('link', { name: 'Text Waves' })).toBeNull();
  });

  it('contact="call" with no retry makes that lone CTA the primary', () => {
    // Regression: gating this on mode === 'row' left the only action on the
    // card as the 44 chip on every contact="call" page.
    render(<PublicStateCard state="not-found" title="Gone" contact="call" />);
    const call = screen.getByRole('link', { name: 'Call (941) 297-5749' });
    expect(call).toHaveAttribute('data-glass-size', 'primary');
    expect(call).toHaveAttribute('data-glass-accent');
  });

  it('contact="call" alongside a retry demotes Call to the chip', () => {
    render(<PublicStateCard state="error" title="T" contact="call" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute('data-glass-size', 'primary');
    expect(screen.getByRole('link', { name: 'Call (941) 297-5749' })).not.toHaveAttribute('data-glass-size');
  });

  it('contact="none" renders no actions at all', () => {
    render(<PublicStateCard state="expired" title="Expired" contact="none" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders body copy when given and omits the block when not', () => {
    const { unmount } = render(<PublicStateCard state="error" title="T">Body copy here</PublicStateCard>);
    expect(screen.getByText('Body copy here')).toBeInTheDocument();
    unmount();
    render(<PublicStateCard state="error" title="T" />);
    expect(screen.queryByText('Body copy here')).toBeNull();
  });

  it('tone="light" drops the gold accent for the dark card scene', () => {
    render(<PublicStateCard state="error" title="T" tone="light" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Try again' })).not.toHaveAttribute('data-glass-accent');
  });

  it('exposes no width or padding knob — one card grammar is the finding', () => {
    // The pages this replaces authored padding 20 / 24 / 32 and widths
    // 440 / 480 / 560. A prop for either would let all of them back.
    render(<PublicStateCard state="error" title="T" />);
    const card = screen.getByRole('alert');
    expect(card.style.maxWidth).toBe('560px');
    expect(card.style.padding).not.toBe('');
  });

  it('tags secondary actions as glass chips so the sheet can style them', () => {
    render(<PublicStateCard state="not-found" title="Gone" />);
    expect(screen.getByRole('link', { name: 'Text Waves' })).toHaveAttribute('data-glass', 'chip');
    // The primary must NOT be a chip.
    expect(screen.getByRole('link', { name: 'Call Waves' })).not.toHaveAttribute('data-glass');
  });

  it('demoted Call becomes a chip when a retry owns the primary tier', () => {
    render(<PublicStateCard state="not-found" title="Gone" onRetry={() => {}} />);
    expect(screen.getByRole('link', { name: 'Call Waves' })).toHaveAttribute('data-glass', 'chip');
  });

  it('tone="light" authors the frosted material rather than delegating to the sheet', () => {
    // /card never calls useGlassSurface, so data-glass is inert there and the
    // blur has to be on the element.
    render(<PublicStateCard state="error" title="T" tone="light" />);
    const card = screen.getByRole('alert');
    expect(card.style.backdropFilter).toContain('blur');
    expect(card.style.boxShadow).toContain('inset');
  });

  it('ignores caller attempts to restore per-page geometry', () => {
    // BrandCard reads maxWidth and padding as props, so without stripping them
    // the advertised one-card invariant was documentation, not enforcement.
    render(
      <PublicStateCard state="error" title="T" maxWidth={440} padding={20} style={{ maxWidth: 300, padding: 4 }} />
    );
    const card = screen.getByRole('alert');
    expect(card.style.maxWidth).toBe('560px');
    expect(card.style.padding).toBe('clamp(20px, 4vw, 32px)');
  });

  it('still forwards other props and styles', () => {
    render(<PublicStateCard state="error" title="T" data-testid="psc" style={{ marginTop: 12 }} />);
    const card = screen.getByTestId('psc');
    expect(card.style.marginTop).toBe('12px');
  });
});
