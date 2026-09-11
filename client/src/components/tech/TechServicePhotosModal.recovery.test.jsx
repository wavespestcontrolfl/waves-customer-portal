// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TechServicePhotosModal from './TechServicePhotosModal';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([false, true])('ignores an older photo refresh after the next upload (old error: %s)', async (oldError) => {
  let reads = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = { id: 'photo-a', caption: 'First photo', url: 'data:image/png;base64,eA==' };
  const second = { id: 'photo-b', caption: 'Second photo', url: 'data:image/png;base64,eA==' };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('photo-marks')) return { ok: true, json: async () => ({ supported: false }) };
    if (options?.method === 'POST') return { ok: true, json: async () => ({ photo: first }) };
    const read = ++reads;
    if (read === 2) {
      await pending;
      return { ok: !oldError, json: async () => oldError ? { error: 'Stale photo error' } : { photos: [first] } };
    }
    return { ok: true, json: async () => ({ photos: read === 1 ? [] : [first, second] }) };
  }));
  render(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  const input = screen.getByLabelText('Choose service photo');
  const pick = () => fireEvent.change(input, { target: { files: [new File(['example'], 'example.png', { type: 'image/png' })] } });
  pick();
  await waitFor(() => expect(reads).toBe(2));
  await waitFor(() => expect(input).toBeEnabled());
  pick();
  await screen.findByText('Attached (2)');
  await act(async () => { release(); });
  expect(screen.getByText('Attached (2)')).toBeInTheDocument();
  expect(screen.queryByText('Stale photo error')).not.toBeInTheDocument();
});

it('allows closing after upload succeeds while the photo refresh is still pending', async () => {
  const close = vi.fn();
  let reads = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('photo-marks')) return { ok: true, json: async () => ({ supported: false }) };
    if (options?.method === 'POST') return { ok: true, json: async () => ({ photo: { id: 'photo-a' } }) };
    if (++reads > 1) await pending;
    return { ok: true, json: async () => ({ photos: [] }) };
  }));
  render(<TechServicePhotosModal serviceId="visit-a" onClose={close} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), { target: { files: [new File(['example'], 'example.png', { type: 'image/png' })] } });
  await screen.findByText('Photo uploaded');
  const dismiss = screen.getByRole('button', { name: /Close|×/ });
  await waitFor(() => expect(dismiss).toBeEnabled());
  fireEvent.click(dismiss);
  expect(close).toHaveBeenCalledTimes(1);
  release();
  await screen.findByText('No photos yet.');
});

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
  render(<TechServicePhotosModal serviceId="visit-a" customerName="Avery Example" onClose={close} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByPlaceholderText(/Front yard before treatment/), { target: { value: 'Example caption' } });
  fireEvent.click(screen.getByRole('button', { name: 'before', exact: true }));
  const file = new File(['example'], 'example.png', { type: 'image/png', lastModified: 1234567890 });
  fireEvent.change(screen.getByLabelText('Choose service photo'), { target: { files: [file] } });
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

it('does not report an empty photo list after a load failure and can retry the read', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('photo-marks')) return { ok: true, json: async () => ({ supported: false }) };
    reads += 1;
    return reads === 1
      ? { ok: false, json: async () => ({ error: 'Example photo list unavailable.' }) }
      : { ok: true, json: async () => ({ photos: [{ id: 'photo-a', url: '/example.jpg', photo_type: 'before', caption: 'Existing example photo' }] }) };
  }));
  render(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  await screen.findByText('Example photo list unavailable.');
  expect(screen.queryByText('No photos yet.')).not.toBeInTheDocument();
  expect(screen.queryByText('Attached (0)')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry photos', exact: true }));
  await screen.findByText('Attached (1)');
  expect(screen.getByText('Existing example photo')).toBeInTheDocument();
});

it('keeps successful upload feedback when its photo-list refresh fails', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('photo-marks')) return { ok: true, json: async () => ({ supported: false }) };
    if (options?.method === 'POST') return { ok: true, json: async () => ({ photo: { id: 'photo-a', staged: true } }) };
    if (++reads === 1) return { ok: true, json: async () => ({ photos: [] }) };
    return { ok: false, json: async () => ({ error: 'Refresh unavailable.' }) };
  }));
  render(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), { target: { files: [new File(['example'], 'example.png', { type: 'image/png' })] } });
  await screen.findByText('Refresh unavailable.');
  expect(screen.getByText(/Photo saved — it will attach/)).toBeInTheDocument();
  expect(screen.queryByText('No photos yet.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Close|×/ })).toBeEnabled();
});

it('keeps nested photo marking focus and Escape inside the photo manager', async () => {
  const close = vi.fn();
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => url.endsWith('photo-marks')
    ? { supported: true, kinds: [{ kind: 'foam_injection', label: 'Drilled & foamed' }], marksByS3Key: {} }
    : { photos: [{ id: 'photo-a', s3_key: 'example.jpg', url: '/example.jpg', photo_type: 'after' }] },
  })));
  render(<TechServicePhotosModal serviceId="visit-a" onClose={close} />);
  const opener = await screen.findByRole('button', { name: 'Mark spots', exact: true });
  fireEvent.click(opener);
  const nested = await screen.findByRole('dialog', { name: 'Mark treated spots', exact: true });
  await screen.findByRole('button', { name: 'Drilled & foamed', exact: true });
  expect(nested.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Mark treated spots', exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Service Photos', exact: true })).toBeInTheDocument();
  expect(opener).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
});
