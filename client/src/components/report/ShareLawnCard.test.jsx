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
import { canSaveNative, saveBlobNative } from '../../native/nativeFile';
vi.mock('../../native/nativeFile', () => ({
  canSaveNative: vi.fn(() => false),
  saveBlobNative: vi.fn(async () => true),
}));
import ShareLawnCard from './ShareLawnCard';

const props = { token: 'tok123', score: 88, assessmentId: 'as-1', apiBase: '/api' };

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
      photoUrl: '/api/reports/tok123/share-photo?assessment=as-1', logoUrl: '/waves-logo.png', score: 88, link: 'https://wavespestcontrol.com/r/ABC',
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
    // The built card is kept: the next tap shares it again without a rebuild.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an expired tap (NotAllowedError): keeps the built card, shows Share and the save link, and a new tap shares it without a rebuild', async () => {
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { name: 'NotAllowedError' }))
      .mockResolvedValueOnce(undefined);
    const onTap = vi.fn();
    render(<ShareLawnCard {...props} onTap={onTap} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    const again = await screen.findByRole('button', { name: 'Share' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: 'Save the picture' })).toBeInTheDocument();
    const firstFile = navigator.share.mock.calls[0][0].files[0];
    fireEvent.click(again);
    await screen.findByText('Thank you for sharing.');
    expect(buildLawnShareCard).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(navigator.share.mock.calls[1][0].files[0]).toBe(firstFile);
  });

  it.each([['DataError'], ['NotSupportedError'], ['TypeError'], [undefined]])('any other share failure (%s) keeps the built card: picture, save link and a fresh Share button', async (name) => {
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(async () => { const e = new Error('os failure'); if (name) e.name = name; throw e; });
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    expect(await screen.findByRole('button', { name: 'Share' })).toBeEnabled();
    expect(screen.getByAltText('Your lawn card')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Save the picture' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(buildLawnShareCard).toHaveBeenCalledTimes(1);
  });

  it('a second refusal keeps the card ready instead of looping or rebuilding', async () => {
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(async () => { throw Object.assign(new Error('expired'), { name: 'NotAllowedError' }); });
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Share' })).toBeEnabled();
    expect(buildLawnShareCard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Save the picture' })).toBeInTheDocument();
  });

  it('closing the sheet after a retry returns to the ready state', async () => {
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { name: 'NotAllowedError' }))
      .mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError' }));
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Share' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('in the app (canSaveNative): Save the picture hands the built blob to the native share sheet, not the blob link', async () => {
    canSaveNative.mockReturnValue(true);
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    const save = await screen.findByRole('link', { name: 'Save the picture' });
    const notPrevented = fireEvent.click(save);
    expect(notPrevented).toBe(false); // preventDefault: the dead blob download is skipped
    await waitFor(() => expect(saveBlobNative).toHaveBeenCalledTimes(1));
    const [blob, name] = saveBlobNative.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe('my-lawn-waves.jpg');
    canSaveNative.mockReturnValue(false);
  });

  it('in the app, a failed native save shows one fixed message', async () => {
    canSaveNative.mockReturnValue(true);
    saveBlobNative.mockRejectedValueOnce(new Error('disk'));
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Save the picture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not save the picture. Please try again.');
    canSaveNative.mockReturnValue(false);
  });

  it('on the web the link keeps its plain download (no native call)', async () => {
    render(<ShareLawnCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share your lawn' }));
    const save = await screen.findByRole('link', { name: 'Save the picture' });
    expect(fireEvent.click(save)).toBe(true);
    expect(saveBlobNative).not.toHaveBeenCalled();
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
