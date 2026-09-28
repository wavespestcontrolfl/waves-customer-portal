// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitPrepPhotoForm from './VisitPrepPhotoForm';

const photoFile = (name = 'bug.jpg') => new File(['photo'], name, { type: 'image/jpeg' });

function fileInput() {
  return document.querySelector('input[type="file"]');
}

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
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 1, photosRemaining: 5 } });
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('Pest'));
    fireEvent.click(screen.getByText('Back yard'));
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
    expect(formData.get('topic')).toBe('pest');
    expect(formData.get('locationOnProperty')).toBe('back_yard');
  });

  it('caps the picker at min(3, photosRemaining)', async () => {
    render(<VisitPrepPhotoForm photosRemaining={2} onSubmit={vi.fn()} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile('a.jpg'), photoFile('b.jpg'), photoFile('c.jpg')] } });

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Remove photo/ })).toHaveLength(2));
    // Room is used up — the Add photos button drops off.
    expect(screen.queryByText('Add photos')).not.toBeInTheDocument();
  });

  it('shows the acknowledgment with a count of the photos just sent, never the photos themselves', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, prepPhotos: { eligible: true, photoCount: 2, photosRemaining: 4 } });
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

  it('a 409 cap-reached error shows the server line and stays on the form', async () => {
    const err = Object.assign(new Error("You've reached the photo limit for this visit."), { status: 409, code: 'PREP_CAP_REACHED' });
    const onSubmit = vi.fn().mockRejectedValue(err);
    render(<VisitPrepPhotoForm photosRemaining={6} onSubmit={onSubmit} />);

    fireEvent.change(fileInput(), { target: { files: [photoFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("You've reached the photo limit for this visit.");
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
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
});
