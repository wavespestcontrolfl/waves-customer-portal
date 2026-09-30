// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The actual canvas/decode pipeline lives in imageCompression.js and has
// its own test suite; mocking it at the module boundary here lets these
// tests prove what THIS component does with the result (sequential calls,
// mime recovery, the decode-failure fallback, the processing-state guard)
// without fighting jsdom's missing canvas/Image/createImageBitmap support.
vi.mock('../../utils/imageCompression', () => ({
  encodeJpegFile: vi.fn(),
}));

import { encodeJpegFile } from '../../utils/imageCompression';
import VisitPrepPhotoForm from './VisitPrepPhotoForm';

const photoFile = (name = 'bug.jpg') => new File(['photo'], name, { type: 'image/jpeg' });

// Default: every encode "succeeds" immediately with a small JPEG File, so
// tests that don't care about the resize pipeline itself can pick and send
// without extra setup.
function jpegOf(file) {
  return new File(['jpeg-bytes'], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

function fileInput() {
  return screen.getByTestId('visit-prep-library-input');
}

beforeEach(() => {
  encodeJpegFile.mockReset();
  encodeJpegFile.mockImplementation(async (file) => jpegOf(file));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VisitPrepPhotoForm', () => {
  it('disables Send until at least one photo is attached', async () => {
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
  });

  it('sends multipart form data with the right field names on submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 1, photosRemaining: 5, photosAdded: 1 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('A short note (optional)'), { target: { value: 'Ants by the pool' } });
    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const formData = onSubmit.mock.calls[0][0];
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.getAll('photos')).toHaveLength(1);
    expect(formData.get('photos').name).toBe('bug.jpg');
    expect(formData.get('note')).toBe('Ants by the pool');
    // No topic/location choices on this form (owner 2026-09-28): note + photos only.
    expect(formData.get('topic')).toBeNull();
    expect(formData.get('locationOnProperty')).toBeNull();
  });

  it('the instruction names the real remaining limit, and there are no topic or location choices', () => {
    render(<VisitPrepPhotoForm photosRemaining={1} onSubmit={vi.fn()} />);
    expect(screen.getByText('Add up to 1 photo and a short note.')).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByText('Pest')).not.toBeInTheDocument();
  });

  it('offers both Take a photo (camera) and Upload a photo (library), feeding the same picker', async () => {
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);
    const camera = screen.getByTestId('visit-prep-camera-input');
    const library = screen.getByTestId('visit-prep-library-input');
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(library.hasAttribute('capture')).toBe(false);
    expect(library.multiple).toBe(true);

    const clickCamera = vi.spyOn(camera, 'click');
    const clickLibrary = vi.spyOn(library, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Take a photo' }));
    expect(clickCamera).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Upload a photo' }));
    expect(clickLibrary).toHaveBeenCalledTimes(1);

    fireEvent.change(camera, { target: { files: [photoFile('cam.jpg')] } });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Remove photo/ })).toHaveLength(1));
    fireEvent.change(library, { target: { files: [photoFile('lib.jpg')] } });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Remove photo/ })).toHaveLength(2));
  });

  it('meets the customer-surface floors: 48 px touch targets and 16 px text on every control', () => {
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);
    for (const name of ['Take a photo', 'Upload a photo', 'Send']) {
      const control = screen.getByRole('button', { name });
      expect(control.style.minHeight).toBe('48px');
      expect(control.style.fontSize).toBe('16px');
    }
    expect(screen.getByLabelText('A short note (optional)').style.fontSize).toBe('16px');
    // The glass theme's accent rule forces 44px unless the primary size tag is set.
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('data-glass-size')).toBe('primary');
  });

  it('caps the picker at min(3, photosRemaining)', async () => {
    render(<VisitPrepPhotoForm photosRemaining={2} onSubmit={vi.fn()} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg'), photoFile('c.jpg')] } });

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Remove photo/ })).toHaveLength(2));
    // Room is used up — both picker buttons drop off.
    expect(screen.queryByText('Take a photo')).not.toBeInTheDocument();
    expect(screen.queryByText('Upload a photo')).not.toBeInTheDocument();
  });

  it('shows the acknowledgment with a count of the photos just sent, never the photos themselves', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 2, photosRemaining: 4, photosAdded: 2 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg')] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Got it.')).toBeInTheDocument();
    expect(screen.getByText('This is attached to your visit so your technician sees it before starting.')).toBeInTheDocument();
    expect(screen.getByText('2 photos sent')).toBeInTheDocument();
    // The submitted photos are never redisplayed (decision 8: count only).
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('a 404 on submit switches to the gone state with one neutral line', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    const onSubmit = vi.fn().mockRejectedValue(err);
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByTestId('visit-prep-gone')).toHaveTextContent('Photos can no longer be added to this visit.');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('a 409 cap-reached error retires the form to the terminal full state, never back to an editable Send', async () => {
    const err = Object.assign(new Error("You've reached the photo limit for this visit."), { status: 409, code: 'PREP_CAP_REACHED' });
    const onSubmit = vi.fn().mockRejectedValue(err);
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Same terminal state as a visit with no room to begin with — not a
    // retryable form error banner, since tapping Send again would just
    // 409 again.
    expect(await screen.findByTestId('visit-prep-full')).toHaveTextContent('This visit already has the most photos it can take.');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 503 error shows a short retry line, never the raw server message', async () => {
    const err = Object.assign(new Error('Our photo converter is busy — please try again in a moment.'), { status: 503, code: 'PREP_CONVERTER_BUSY' });
    const onSubmit = vi.fn().mockRejectedValue(err);
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again in a moment.');
  });

  it('a visit with no photo room left renders one neutral line instead of a dead-end form', () => {
    render(<VisitPrepPhotoForm photosRemaining={0} onSubmit={vi.fn()} />);
    expect(screen.getByTestId('visit-prep-full')).toHaveTextContent('This visit already has the most photos it can take.');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('encodes picked photos ONE AT A TIME, never concurrently (a full-res decode+canvas per file is too much live memory for Promise.all)', async () => {
    const resolvers = [];
    encodeJpegFile.mockImplementation((file) => new Promise((resolve) => {
      resolvers.push(() => resolve(jpegOf(file)));
    }));

    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg')] } });

    // Only the FIRST file's encode has started — the second must wait for
    // it, not run alongside it.
    await waitFor(() => expect(encodeJpegFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /Remove photo/ })).not.toBeInTheDocument();

    resolvers[0]();
    await waitFor(() => expect(encodeJpegFile).toHaveBeenCalledTimes(2));
    // The second call only happened after the first resolved — proof the
    // loop is sequential, not fired together.
    expect(screen.queryAllByRole('button', { name: /Remove photo/ })).toHaveLength(0);

    resolvers[1]();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Remove photo/ })).toHaveLength(2));
  });

  it('Send stays disabled while a pick is still processing, so a tap can never omit the new photo', async () => {
    let releaseEncode;
    encodeJpegFile.mockImplementation((file) => new Promise((resolve) => {
      releaseEncode = () => resolve(jpegOf(file));
    }));

    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });

    await waitFor(() => expect(encodeJpegFile).toHaveBeenCalledTimes(1));
    // Still processing — Send must stay disabled and say nothing is picked.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Adding photos…');
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload a photo' })).toBeDisabled();

    releaseEncode();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
  });

  it('an empty-type .heic file (some browsers report this, or application/octet-stream) is accepted, sent as image/heic, and shows a placeholder tile — never a broken preview', async () => {
    // The browser can't decode HEIC into a canvas at all (the common case
    // outside Safari) — the picker falls back to the original bytes, but
    // must still recover the mime from the filename extension so the
    // multipart part declares image/heic, not application/octet-stream,
    // AND must not try to preview bytes the browser just proved it can't
    // render.
    encodeJpegFile.mockResolvedValue(null);

    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 1, photosRemaining: 5 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    const heic = new File(['heicbytes'], 'iphone-photo.heic', { type: 'application/octet-stream' });
    fireEvent.change(fileInput(), { target: { files: [heic] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('photo-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0].get('photos');
    expect(sent.name).toBe('iphone-photo.heic');
    expect(sent.type).toBe('image/heic');
  });

  it('an oversized image is downscaled to a JPEG under the cap and sent, never silently dropped', async () => {
    // >5 MB original — the earlier (byte-size-first) filter would have
    // dropped this before the resize ever ran.
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'camera-roll.jpg', { type: 'image/jpeg' });
    encodeJpegFile.mockResolvedValue(new File(['small'], 'camera-roll.jpg', { type: 'image/jpeg' }));

    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 1, photosRemaining: 5 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [oversized] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0].get('photos');
    expect(sent.type).toBe('image/jpeg');
    expect(sent.size).toBeLessThan(5 * 1024 * 1024);
  });

  it('an unsupported file is rejected with one short line, never silently dropped, and never reaches the encoder', async () => {
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);

    const pdf = new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput(), { target: { files: [pdf] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Photos must be JPEG, PNG, WebP, or HEIC, 5 MB or smaller.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(encodeJpegFile).not.toHaveBeenCalled();
  });

  it('picking more than the remaining room shows a count line instead of silently trimming', async () => {
    render(<VisitPrepPhotoForm photosRemaining={2} onSubmit={vi.fn()} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg'), photoFile('c.jpg')] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('You can add up to 2 photos.');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Remove photo/ })).toHaveLength(2));
  });

  it('a pick that is both over the room and has an unsupported file names BOTH reasons', async () => {
    render(<VisitPrepPhotoForm photosRemaining={2} onSubmit={vi.fn()} />);
    const pdf = new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' });

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), pdf, photoFile('c.jpg')] } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Photos must be JPEG, PNG, WebP, or HEIC, 5 MB or smaller.');
    expect(alert).toHaveTextContent('You can add up to 2 photos.');
  });

  it('the count line uses the singular for a one-photo limit', async () => {
    render(<VisitPrepPhotoForm photosRemaining={1} onSubmit={vi.fn()} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg')] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('You can add up to 1 photo.');
  });

  it('the sent count is the server\'s photosAdded for THIS request, not the files attached or a stop-wide difference', async () => {
    // Two files attached; the server stored ONE new photo (the other was
    // already on the visit), while another holder's upload landed at the
    // same time, so the stop-wide remaining count moved by three.
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 3, photosRemaining: 3, photosAdded: 1 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg')] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('1 photo sent')).toBeInTheDocument();
  });

  it('an all-duplicate resubmit (accepted count of zero) shows a truthful line instead of "0 photos sent"', async () => {
    // photosRemaining unchanged — every attached photo already existed on
    // the visit (the server's idempotent 200 case).
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 2, photosRemaining: 4, photosAdded: 0 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Got it.')).toBeInTheDocument();
    // Heading and body copy are unchanged — only the count line differs.
    expect(screen.getByText('This is attached to your visit so your technician sees it before starting.')).toBeInTheDocument();
    expect(screen.getByText('Those photos are already attached to this visit.')).toBeInTheDocument();
    expect(screen.queryByText(/photo.*sent/)).not.toBeInTheDocument();
  });

  it('freezes every control while a submit is in flight, so the visible form can never diverge from the FormData already posted', async () => {
    let resolveSubmit;
    const onSubmit = vi.fn(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg')] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // The button's own label flips to "Sending…" while in flight.
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByLabelText('A short note (optional)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload a photo' })).toBeDisabled();
    screen.getAllByRole('button', { name: /Remove photo/ }).forEach((btn) => expect(btn).toBeDisabled());

    resolveSubmit({ ok: true, prepPhotos: { eligible: true, photoCount: 2, photosRemaining: 4 } });
    await waitFor(() => expect(screen.getByText('Got it.')).toBeInTheDocument());
  });

  it('the remove control has at least a 48x48 hit area (customer-surface touch-target spec)', async () => {
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={vi.fn()} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    const removeButton = await screen.findByRole('button', { name: 'Remove photo 1' });

    expect(removeButton).toHaveStyle({ width: '48px', height: '48px' });
  });
});
