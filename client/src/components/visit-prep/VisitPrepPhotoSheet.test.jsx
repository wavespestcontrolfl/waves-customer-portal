// @vitest-environment jsdom
// The app's "Send photos" sheet: renders nothing closed, wraps the shared
// VisitPrepPhotoForm when open, posts through api.sendVisitPrepPhotos for
// THIS visit, reports the fresh counts back, and closes from its button.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../utils/api', () => ({ default: { sendVisitPrepPhotos: (...args) => mockSend(...args) } }));
vi.mock('../../utils/imageCompression', () => ({
  encodeJpegFile: vi.fn(async (file) => new File(['jpeg'], file.name, { type: 'image/jpeg' })),
}));

import VisitPrepPhotoSheet from './VisitPrepPhotoSheet';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VisitPrepPhotoSheet', () => {
  it('renders nothing while closed', () => {
    render(<VisitPrepPhotoSheet open={false} onClose={vi.fn()} scheduledServiceId="svc-1" photosRemaining={6} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the shared form, sends for this visit, and reports the fresh counts', async () => {
    const counts = { eligible: true, photoCount: 1, photosRemaining: 5, photosAdded: 1 };
    mockSend.mockResolvedValue({ ok: true, prepPhotos: counts });
    const onSent = vi.fn();
    render(<VisitPrepPhotoSheet open onClose={vi.fn()} scheduledServiceId="svc-1" photosRemaining={6} onSent={onSent} />);

    expect(screen.getByRole('dialog', { name: 'Send photos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('visit-prep-library-input'), {
      target: { files: [new File(['x'], 'bug.jpg', { type: 'image/jpeg' })] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Got it.')).toBeInTheDocument());
    expect(mockSend).toHaveBeenCalledWith('svc-1', expect.any(FormData));
    expect(onSent).toHaveBeenCalledWith(counts);
  });

  it('closes, never re-targets, when the card\'s visit changes while it is open', () => {
    const onClose = vi.fn();
    const { rerender } = render(<VisitPrepPhotoSheet open onClose={onClose} scheduledServiceId="svc-1" photosRemaining={6} />);
    expect(onClose).not.toHaveBeenCalled();
    rerender(<VisitPrepPhotoSheet open onClose={onClose} scheduledServiceId="svc-2" photosRemaining={6} />);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from its 48px close button', () => {
    const onClose = vi.fn();
    render(<VisitPrepPhotoSheet open onClose={onClose} scheduledServiceId="svc-1" photosRemaining={6} />);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.style.width).toBe('48px');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });
});
