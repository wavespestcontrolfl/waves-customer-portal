// @vitest-environment jsdom
import React from 'react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import TechServicePhotosModal from './TechServicePhotosModal';
import {
  getServicePhotoDraft,
  putServicePhotoDraft,
} from '../../lib/completion-resume-store';

const VISIT_ID = 'visit-device-recovery';
const TECH_ID = 'tech-device-recovery';
const VISIT = {
  customerId: 'customer-device-recovery',
  propertyId: 'property-device-recovery',
  technicianId: TECH_ID,
  scheduledDate: '2026-10-02',
  status: 'on_site',
  revision: 'visit-revision-1',
};

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function installPhotoFetch(post) {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/photo-marks')) return response({ supported: false });
    if (options?.method === 'POST') return post(options.body);
    return response({ photos: [], visit: VISIT });
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: TECH_ID, role: 'technician' }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('restores the exact failed file, tag, caption, and upload stage, then clears it after Retry succeeds', async () => {
  const writes = [];
  let attempt = 0;
  vi.stubGlobal('fetch', installPhotoFetch(async (body) => {
    writes.push(body);
    attempt += 1;
    if (attempt === 1) throw new Error('Signal dropped');
    return response({ photo: { id: 'photo-1', staged: true } });
  }));

  const first = render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  const before = screen.getByRole('button', { name: 'before', exact: true });
  await waitFor(() => expect(before).toBeEnabled());
  fireEvent.click(before);
  fireEvent.change(screen.getByPlaceholderText(/Front yard before treatment/), { target: { value: 'North wall entry' } });
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['same-photo-bytes'], 'north-wall.jpg', { type: 'image/jpeg', lastModified: 1234567890 })] },
  });

  expect(await screen.findByText(/Signal dropped/)).toBeInTheDocument();
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({
    serviceId: VISIT_ID,
    technicianId: TECH_ID,
    stage: 'unconfirmed',
    fileName: 'north-wall.jpg',
    photoType: 'before',
    caption: 'North wall entry',
    capturedAt: new Date(1234567890).toISOString(),
    expectedVisit: VISIT,
  });

  first.unmount();
  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  expect(await screen.findByText('Recovered a photo saved on this device.')).toBeInTheDocument();
  expect(screen.getByText('north-wall.jpg')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload', exact: true }));

  expect(await screen.findByText(/Photo saved — it will attach/)).toBeInTheDocument();
  await waitFor(() => expect(getServicePhotoDraft(VISIT_ID, TECH_ID)).resolves.toBeNull());
  expect(writes).toHaveLength(2);
  for (const body of writes) {
    expect(body.get('photo').name).toBe('north-wall.jpg');
    expect(body.get('photoType')).toBe('before');
    expect(body.get('caption')).toBe('North wall entry');
    expect(body.get('capturedAt')).toBe(new Date(1234567890).toISOString());
    expect(JSON.parse(body.get('expectedVisit'))).toEqual(VISIT);
  }
});

it('restores an upload that was in flight when the component disappeared without starting it again', async () => {
  const neverFinishes = new Promise(() => {});
  const fetchMock = installPhotoFetch(() => neverFinishes);
  vi.stubGlobal('fetch', fetchMock);

  const first = render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['in-flight'], 'in-flight.jpg', { type: 'image/jpeg' })] },
  });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1));
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({ stage: 'uploading' });
  first.unmount();

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  expect(await screen.findByText('Recovered a photo saved on this device.')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Retry upload', exact: true })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Discard saved photo', exact: true })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved photo', exact: true }));
  await waitFor(async () => expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toBeNull());
  expect(screen.queryByText('in-flight.jpg')).not.toBeInTheDocument();
});

it('never restores one technician’s saved photo for another login', async () => {
  const file = new File(['private-photo'], 'private.jpg', { type: 'image/jpeg' });
  await putServicePhotoDraft(VISIT_ID, {
    version: 1,
    draftId: 'private-draft',
    serviceId: VISIT_ID,
    technicianId: 'tech-a',
    stage: 'failed',
    message: 'Saved for tech A',
    file,
    fileName: file.name,
    fileType: file.type,
    fileLastModified: file.lastModified,
    photoType: 'after',
    caption: '',
    capturedAt: new Date().toISOString(),
  }, 'tech-a');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-b', role: 'technician' }));
  vi.stubGlobal('fetch', installPhotoFetch(async () => response({ photo: { id: 'unexpected' } })));

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  expect(screen.queryByText('private.jpg')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry upload', exact: true })).not.toBeInTheDocument();
  expect(await getServicePhotoDraft(VISIT_ID, 'tech-a')).not.toBeNull();
});

it('says plainly when the selected photo cannot be saved on the device', async () => {
  globalThis.indexedDB = undefined;
  vi.stubGlobal('fetch', installPhotoFetch(async () => { throw new Error('Offline'); }));

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['not-durable'], 'not-durable.jpg', { type: 'image/jpeg' })] },
  });

  expect(await screen.findByText(/This photo is not saved on this device/)).toBeInTheDocument();
  expect(screen.getByText(/Offline/)).toBeInTheDocument();
});

it('keeps a malformed 200 response unconfirmed instead of deleting the saved retry', async () => {
  vi.stubGlobal('fetch', installPhotoFetch(async () => response({ ok: true })));

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['missing-receipt'], 'missing-receipt.jpg', { type: 'image/jpeg' })] },
  });

  expect(await screen.findByText(/did not include a photo receipt/)).toBeInTheDocument();
  expect(screen.queryByText('Photo uploaded')).not.toBeInTheDocument();
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({
    fileName: 'missing-receipt.jpg',
    stage: 'unconfirmed',
  });
  expect(screen.getByRole('button', { name: 'Retry upload', exact: true })).toBeEnabled();
});

it('silently clears a confirmed recovery row instead of offering a duplicate retry', async () => {
  const file = new File(['confirmed-photo'], 'confirmed.jpg', { type: 'image/jpeg' });
  await putServicePhotoDraft(VISIT_ID, {
    version: 1,
    draftId: 'confirmed-draft',
    serviceId: VISIT_ID,
    technicianId: TECH_ID,
    stage: 'confirmed',
    message: '',
    file,
    fileName: file.name,
    fileType: file.type,
    fileLastModified: file.lastModified,
    photoType: 'after',
    caption: '',
    capturedAt: new Date().toISOString(),
  }, TECH_ID);
  const fetchMock = installPhotoFetch(async () => response({ photo: { id: 'unexpected' } }));
  vi.stubGlobal('fetch', fetchMock);

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  await waitFor(async () => expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toBeNull());
  expect(screen.queryByText('confirmed.jpg')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry upload', exact: true })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});

it.each(['success', 'failure'])('a delayed %s from discarded photo A cannot replace or delete newer photo B', async (result) => {
  let finishA;
  const uploadA = new Promise((resolve, reject) => { finishA = result === 'success' ? resolve : reject; });
  const uploadB = new Promise(() => {});
  let postCount = 0;
  const fetchMock = installPhotoFetch(() => {
    postCount += 1;
    return postCount === 1 ? uploadA : uploadB;
  });
  vi.stubGlobal('fetch', fetchMock);

  const first = render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['photo-a'], 'photo-a.jpg', { type: 'image/jpeg' })] },
  });
  await waitFor(() => expect(postCount).toBe(1));
  const draftA = await getServicePhotoDraft(VISIT_ID, TECH_ID);
  expect(draftA).toMatchObject({ fileName: 'photo-a.jpg', stage: 'uploading' });
  first.unmount();

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  expect(await screen.findByText('Recovered a photo saved on this device.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved photo', exact: true }));
  await waitFor(async () => expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toBeNull());
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['photo-b'], 'photo-b.jpg', { type: 'image/jpeg' })] },
  });
  await waitFor(() => expect(postCount).toBe(2));
  const draftB = await getServicePhotoDraft(VISIT_ID, TECH_ID);
  expect(draftB).toMatchObject({ fileName: 'photo-b.jpg', stage: 'uploading' });
  expect(draftB.draftId).not.toBe(draftA.draftId);

  await act(async () => {
    if (result === 'success') finishA(response({ photo: { id: 'photo-a' } }));
    else finishA(new Error('Late A failure'));
    await Promise.resolve();
  });
  await waitFor(async () => expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({
    draftId: draftB.draftId,
    fileName: 'photo-b.jpg',
    stage: 'uploading',
  }));
});

it('blocks Retry if the signed-in technician changes before the POST', async () => {
  const file = new File(['old-tech-photo'], 'old-tech.jpg', { type: 'image/jpeg' });
  await putServicePhotoDraft(VISIT_ID, {
    version: 1,
    draftId: 'old-tech-draft',
    serviceId: VISIT_ID,
    technicianId: TECH_ID,
    stage: 'failed',
    message: 'Retry this photo',
    file,
    fileName: file.name,
    fileType: file.type,
    fileLastModified: file.lastModified,
    photoType: 'after',
    caption: '',
    capturedAt: new Date().toISOString(),
  }, TECH_ID);
  const fetchMock = installPhotoFetch(async () => response({ photo: { id: 'unexpected' } }));
  vi.stubGlobal('fetch', fetchMock);

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  expect(await screen.findByText('Recovered a photo saved on this device.')).toBeInTheDocument();
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'different-tech', role: 'technician' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload', exact: true }));

  expect(await screen.findByText(/Signed-in technician changed/)).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({
    draftId: 'old-tech-draft',
    technicianId: TECH_ID,
  });
});

it('reads the visit again before Retry and keeps the file when its property changed', async () => {
  let liveVisit = VISIT;
  let uploads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/photo-marks')) return response({ supported: false });
    if (options?.method === 'POST') {
      uploads += 1;
      throw new Error('Signal dropped');
    }
    return response({ photos: [], visit: liveVisit });
  }));

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['property-photo'], 'property.jpg', { type: 'image/jpeg' })] },
  });
  await screen.findByText(/Signal dropped/);
  liveVisit = { ...VISIT, propertyId: 'property-moved', revision: 'visit-revision-2' };
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload', exact: true }));

  expect(await screen.findByText(/Discard the saved photo, review the current visit/)).toBeInTheDocument();
  expect(uploads).toBe(1);
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({
    fileName: 'property.jpg',
    expectedVisit: VISIT,
  });
});

it('recovers a completed upload receipt and retries reconciliation after a later visit edit', async () => {
  let liveVisit = VISIT;
  let uploads = 0;
  let reconciles = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.endsWith('/photo-marks')) return response({ supported: false });
    if (url.endsWith('/photos/reconcile')) {
      reconciles += 1;
      if (reconciles === 1) return response({ error: 'Reconciliation unavailable' }, { ok: false, status: 503 });
      return response({ ok: true });
    }
    if (options?.method === 'POST') {
      uploads += 1;
      if (uploads === 1) throw new Error('Signal dropped');
      return response({ photo: { id: 'photo-completed' }, reconcileRequired: true });
    }
    return response({ photos: [], visit: liveVisit });
  }));

  const first = render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('No photos yet.');
  fireEvent.change(screen.getByLabelText('Choose service photo'), {
    target: { files: [new File(['completed-photo'], 'completed.jpg', { type: 'image/jpeg' })] },
  });
  await screen.findByText(/Signal dropped/);
  liveVisit = { ...VISIT, status: 'completed' };
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload', exact: true }));

  await screen.findByText(/Reconciliation unavailable/);
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toMatchObject({
    stage: 'reconciliation_failed', uploadReceipt: { photo: { id: 'photo-completed' }, reconcileRequired: true },
  });
  first.unmount();
  liveVisit = { ...liveVisit, propertyId: 'property-now-edited', revision: 'new-revision' };
  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('Recovered a photo saved on this device.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload', exact: true }));
  expect(await screen.findByText('Photo uploaded')).toBeInTheDocument();
  expect(uploads).toBe(2);
  expect(reconciles).toBe(2);
  await waitFor(() => expect(getServicePhotoDraft(VISIT_ID, TECH_ID)).resolves.toBeNull());
});

it('does not post a newly selected file while the initial visit read is still pending', async () => {
  let finishRead;
  const pendingRead = new Promise(resolve => { finishRead = resolve; });
  const fetchMock = vi.fn(async (url, options) => {
    if (url.endsWith('/photo-marks')) return response({ supported: false });
    if (options?.method === 'POST') return response({ photo: { id: 'unexpected' } });
    return pendingRead;
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  const input = screen.getByLabelText('Choose service photo');
  expect(input).toBeDisabled();
  fireEvent.change(input, {
    target: { files: [new File(['too-early'], 'too-early.jpg', { type: 'image/jpeg' })] },
  });
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);

  finishRead(response({ photos: [], visit: VISIT }));
  await screen.findByText('No photos yet.');
  expect(input).toBeEnabled();
});

it('does not post a newly selected file after the visit read failed', async () => {
  const fetchMock = vi.fn(async (url, options) => {
    if (url.endsWith('/photo-marks')) return response({ supported: false });
    if (options?.method === 'POST') return response({ photo: { id: 'unexpected' } });
    return response({ error: 'Visit unavailable' }, { ok: false, status: 503 });
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<TechServicePhotosModal serviceId={VISIT_ID} onClose={vi.fn()} />);
  await screen.findByText('Visit unavailable');
  const input = screen.getByLabelText('Choose service photo');
  expect(input).toBeDisabled();
  fireEvent.change(input, {
    target: { files: [new File(['unverified'], 'unverified.jpg', { type: 'image/jpeg' })] },
  });
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  expect(await getServicePhotoDraft(VISIT_ID, TECH_ID)).toBeNull();
});
