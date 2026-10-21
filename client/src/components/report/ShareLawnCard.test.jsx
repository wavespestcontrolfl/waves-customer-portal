// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/lawnShareCard', async () => ({
  ...(await vi.importActual('../../lib/lawnShareCard')),
  buildLawnShareCard: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
}));
import { buildLawnShareCard } from '../../lib/lawnShareCard';
import ShareLawnCard from './ShareLawnCard';

const props = { token: 'tok123', score: 88, apiBase: '/api' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 'ABC', link: 'https://wavespestcontrol.com/r/ABC' }) })));
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete navigator.canShare;
  delete navigator.share;
});

describe('ShareLawnCard', () => {
  it('shows the button and does nothing until the customer taps it', () => {
    render(<ShareLawnCard {...props} />);
    expect(screen.getByRole('button', { name: 'Share your lawn' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(buildLawnShareCard).not.toHaveBeenCalled();
  });

  it('tap: fetches the referral link, builds the card from the same-origin photo and shares the file', async () => {
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(async () => {});
    const onTap = vi.fn();
    render(<ShareLawnCard {...props} onTap={onTap} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    await screen.findByText('Thank you for sharing.');
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/reports/tok123/referral-link', { method: 'POST' });
    expect(buildLawnShareCard).toHaveBeenCalledWith({
      photoUrl: '/api/reports/tok123/share-photo', logoUrl: '/waves-logo.png', score: 88, link: 'https://wavespestcontrol.com/r/ABC',
    });
    const shared = navigator.share.mock.calls[0][0];
    expect(shared.files[0].type).toBe('image/jpeg');
    expect(shared.text).toContain('wavespestcontrol.com/r/ABC');
  });

  it('closing the share sheet is not an error', async () => {
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(async () => { const e = new Error('closed'); e.name = 'AbortError'; throw e; });
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share your lawn' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no file sharing: shows the picture with a save link', async () => {
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    const save = await screen.findByRole('link', { name: 'Save the picture' });
    expect(save.getAttribute('download')).toBe('my-lawn-waves.jpg');
    expect(screen.getByAltText('Your lawn card')).toBeInTheDocument();
  });

  it('a failed link or card shows one fixed message and lets the customer try again', async () => {
    buildLawnShareCard.mockRejectedValueOnce(new Error('x'));
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not make your card. Please try again.');
    expect(screen.getByRole('button', { name: 'Share your lawn' })).toBeEnabled();
  });

  it('staff view never enrolls a referral link', async () => {
    render(<ShareLawnCard {...props} staffView />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    await screen.findByRole('link', { name: 'Save the picture' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
