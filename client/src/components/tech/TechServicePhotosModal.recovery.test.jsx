// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TechServicePhotosModal from './TechServicePhotosModal';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('retries the same failed photo with its original caption and type, and protects it while pending', async () => {
  const writes = [], close = vi.fn();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options?.method === 'POST') {
      writes.push(options.body);
      if (writes.length === 1) { await pending; return { ok: false, json: async () => ({ error: 'Example upload failed.' }) }; }
      return { ok: true, json: async () => ({ photo: { id: 'photo-a', staged: true } }) };
    }
    return { ok: true, json: async () => url.endsWith('photo-marks') ? { supported: false } : { photos: [] } };
  }));
  const { container } = render(<TechServicePhotosModal serviceId="visit-a" customerName="Avery Example" onClose={close} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByPlaceholderText(/Front yard before treatment/), { target: { value: 'Example caption' } });
  fireEvent.click(screen.getByRole('button', { name: 'before', exact: true }));
  const file = new File(['example'], 'example.png', { type: 'image/png', lastModified: 1234567890 });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: /Close|×/ }));
  expect(close).not.toHaveBeenCalled();
  release();
  await screen.findByText('Example upload failed.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload', exact: true }));
  await screen.findByText(/Photo saved — it will attach/);
  await waitFor(() => expect(writes).toHaveLength(2));
  for (const body of writes) {
    expect(body.get('photo').name).toBe('example.png');
    expect(body.get('caption')).toBe('Example caption');
    expect(body.get('photoType')).toBe('before');
    expect(body.get('capturedAt')).toBe(new Date(1234567890).toISOString());
  }
});
