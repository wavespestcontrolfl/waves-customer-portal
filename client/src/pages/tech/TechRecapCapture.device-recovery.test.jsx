// @vitest-environment jsdom
// Unfinished recap clips survive the app closing: each case unmounts the
// capture (the app closed) and mounts a fresh one with no in-memory recovery
// (the app reopened), reading only what the device kept in IndexedDB.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TechRecapCapture from './TechRecapCapture';
import { getRecapClipDraft } from '../../lib/completion-resume-store';

const SERVICE = { id: 'service-one' };
const isListRequest = (path, options) => path.endsWith('/recap-media') && !options;

let staffId = 'tech-fixture';
function signIn(id) {
  staffId = id;
}

async function captureClip(name = 'perimeter.jpg') {
  // Capture opens once the saved-clip lookup for the visit has settled.
  await waitFor(() => expect(screen.getByRole('button', { name: '+ Capture recap clip' })).toBeEnabled());
  const input = document.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File(['fixture'], name, { type: 'image/jpeg' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Spray — perimeter' }));
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  signIn('tech-fixture');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('brings a clip that failed with no signal back after the app is reopened, and Retry finishes it', async () => {
  let online = false;
  const request = vi.fn(async (path, options) => {
    if (isListRequest(path, options)) return { items: [] };
    if (!online) throw new TypeError('Failed to fetch');
    if (path.endsWith('/presign')) return { mediaId: 'media-one', uploadUrl: 'https://upload.test/media-one' };
    if (path.endsWith('/media-one/confirm')) return { ok: true };
    throw new Error(`Unexpected request: ${path}`);
  });

  const first = render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  await captureClip('dead-zone.jpg');
  expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  await waitFor(async () => expect(await getRecapClipDraft('service-one', 'tech-fixture')).not.toBeNull());
  first.unmount();

  online = true;
  render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('dead-zone.jpg · Spray — perimeter');
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));

  await waitFor(() => expect(request.mock.calls.some(([path]) => path.endsWith('/media-one/confirm'))).toBe(true));
  await waitFor(async () => expect(await getRecapClipDraft('service-one', 'tech-fixture')).toBeNull());
});

it('keeps a clip whose upload was still running when the app closed', async () => {
  const request = vi.fn(async (path, options) => {
    if (isListRequest(path, options)) return { items: [] };
    if (path.endsWith('/presign')) return new Promise(() => {});
    throw new Error(`Unexpected request: ${path}`);
  });

  const first = render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  await captureClip('mid-upload.jpg');
  await waitFor(async () => expect(await getRecapClipDraft('service-one', 'tech-fixture')).not.toBeNull());
  first.unmount();

  render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('didn’t finish uploading');
  expect(screen.getByRole('alert')).toHaveTextContent('mid-upload.jpg · Spray — perimeter');
});

it('removes a restored clip from the device when the tech discards it', async () => {
  const request = vi.fn(async (path, options) => {
    if (isListRequest(path, options)) return { items: [] };
    throw new TypeError('Failed to fetch');
  });

  const first = render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  await captureClip('unwanted.jpg');
  await screen.findByRole('alert');
  await waitFor(async () => expect(await getRecapClipDraft('service-one', 'tech-fixture')).not.toBeNull());
  first.unmount();

  render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  await waitFor(async () => expect(await getRecapClipDraft('service-one', 'tech-fixture')).toBeNull());
});

it('never offers one technician\'s saved clip to another login on the same phone', async () => {
  const request = vi.fn(async (path, options) => {
    if (isListRequest(path, options)) return { items: [] };
    throw new TypeError('Failed to fetch');
  });

  const first = render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  await captureClip('private.jpg');
  await screen.findByRole('alert');
  await waitFor(async () => expect(await getRecapClipDraft('service-one', 'tech-fixture')).not.toBeNull());
  first.unmount();

  signIn('other-tech');
  render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  const listCalls = () => request.mock.calls.filter(([path, options]) => isListRequest(path, options)).length;
  await waitFor(() => expect(listCalls()).toBe(2));
  // The other login's lookup has settled (store reads are ordered per key)
  // and found nothing; the first tech's clip is still on the device for them.
  expect(await getRecapClipDraft('service-one', 'other-tech')).toBeNull();
  expect(await getRecapClipDraft('service-one', 'tech-fixture')).not.toBeNull();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps nothing on the device without a verified technician id', async () => {
  signIn(null);
  const request = vi.fn(async (path, options) => {
    if (isListRequest(path, options)) return { items: [] };
    throw new TypeError('Failed to fetch');
  });

  render(<TechRecapCapture service={SERVICE} request={request} staffId={null} />);
  await captureClip('no-scope.jpg');
  await screen.findByRole('alert');
  expect(await getRecapClipDraft('service-one', '')).toBeNull();
  expect(await getRecapClipDraft('service-one', null)).toBeNull();
});

it('holds capture until the saved-clip lookup for the visit has settled', async () => {
  const request = vi.fn(async (path, options) => {
    if (isListRequest(path, options)) return { items: [] };
    throw new TypeError('Failed to fetch');
  });

  render(<TechRecapCapture service={SERVICE} request={request} staffId={staffId} />);
  const capture = screen.getByRole('button', { name: '+ Capture recap clip' });
  expect(capture).toBeDisabled();
  await waitFor(() => expect(capture).toBeEnabled());
});
