// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TechServicePhotosModal from './TechServicePhotosModal';

const recovery = vi.hoisted(() => ({
  hook: vi.fn(),
  value: null,
  identity: { staffId: 'tech-a', token: 'token-a' },
  ensureIdentity: vi.fn(),
  getPhotos: vi.fn(),
}));
vi.mock('../../hooks/useServicePhotoRecovery', () => ({
  default: recovery.hook,
  createServicePhotoDeviceIdentity: () => recovery.identity,
}));
vi.mock('../../lib/service-photo-recovery', () => ({
  ensureCurrentDeviceIdentity: recovery.ensureIdentity,
  getServicePhotos: recovery.getPhotos,
}));

const visit = { customerId: 'customer-a', revision: 'revision-a', status: 'pending' };
const controllerValue = (overrides = {}) => ({
  pendingPhoto: null,
  deviceSaveState: 'idle',
  restoring: false,
  discarding: false,
  restoredPending: false,
  uploading: false,
  errorMsg: '',
  setErrorMsg: vi.fn(),
  selectPhoto: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
  uploadInFlight: { current: false },
  closeNeedsConfirmation: false,
  ...overrides,
});
const latestHookProps = () => recovery.hook.mock.calls.at(-1)[0];

beforeEach(() => {
  recovery.value = controllerValue();
  recovery.hook.mockReset().mockImplementation(() => recovery.value);
  recovery.ensureIdentity.mockReset();
  recovery.getPhotos.mockReset().mockResolvedValue({ photos: [], visit });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async url => ({
    ok: true,
    json: async () => url.endsWith('/photo-marks')
      ? { supported: false }
      : { photos: [], visit },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('passes the verified visit and selected fields into the recovery controller', async () => {
  const { rerender } = render(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  const input = await screen.findByLabelText('Choose service photo');
  await waitFor(() => expect(input).toBeEnabled());

  expect(latestHookProps()).toMatchObject({
    serviceId: 'visit-a', deviceIdentity: recovery.identity,
    visitSnapshot: visit, visitReadReady: true,
  });
  expect(recovery.ensureIdentity).toHaveBeenCalledWith('tech-a');
  expect(recovery.getPhotos).toHaveBeenCalledWith('visit-a', 'token-a');
  fireEvent.click(screen.getByRole('button', { name: 'before', exact: true }));
  fireEvent.change(screen.getByPlaceholderText(/Front yard before treatment/), {
    target: { value: '  Front lawn  ' },
  });
  const file = new File(['photo'], 'lawn.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });

  expect(recovery.value.selectPhoto).toHaveBeenCalledWith(file, {
    photoType: 'before', caption: '  Front lawn  ',
  });
  recovery.value.discarding = true;
  rerender(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  expect(input).toBeDisabled();
});

it('applies controller callbacks to the list, readiness, and success feedback', async () => {
  render(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  const input = await screen.findByLabelText('Choose service photo');
  await waitFor(() => expect(input).toBeEnabled());

  act(() => latestHookProps().onUploadFailed(new Error('offline')));
  expect(input).toBeDisabled();

  const nextVisit = { ...visit, revision: 'revision-b' };
  act(() => latestHookProps().onFreshPhotos({
    photos: [{ id: 'photo-a', url: '/yard.jpg', photo_type: 'after' }],
    visit: nextVisit,
  }));
  expect(await screen.findByText('Attached (1)')).toBeInTheDocument();
  expect(input).toBeEnabled();
  expect(latestHookProps()).toMatchObject({ visitSnapshot: nextVisit, visitReadReady: true });

  act(() => latestHookProps().onUploaded({ photo: { id: 'photo-b', staged: true } }));
  expect(screen.getByText(/Photo saved — it will attach/)).toBeInTheDocument();
});

it('uses receipt-aware recovery notices and close protection', async () => {
  const close = vi.fn();
  const discard = vi.fn();
  const photo = {
    serviceId: 'visit-a',
    file: new File(['photo'], 'yard.jpg'),
    photoType: 'issue',
    caption: 'East wall',
    stage: 'reconciliation_handed_off',
  };
  recovery.value = controllerValue({
    pendingPhoto: photo,
    deviceSaveState: 'saved',
    restoredPending: true,
    discard,
    closeNeedsConfirmation: false,
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { rerender } = render(<TechServicePhotosModal serviceId="visit-a" onClose={close} />);

  expect(await screen.findByText('Photo attached. Report updates were handed to the office.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'issue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByDisplayValue('East wall')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss saved notice' }));
  expect(discard).toHaveBeenCalledTimes(1);
  rerender(<TechServicePhotosModal serviceId="visit-b" onClose={close} />);
  expect(screen.getByText(/notice belongs to another visit/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Dismiss saved notice' })).not.toBeInTheDocument();

  recovery.value = controllerValue({
    pendingPhoto: photo,
    deviceSaveState: 'unavailable',
    restoredPending: true,
    discard,
    closeNeedsConfirmation: false,
  });
  rerender(<TechServicePhotosModal serviceId="visit-a" onClose={close} />);
  expect(screen.getByText(/handed-off notice could not be saved on this device/i)).toBeInTheDocument();
  const closeButton = screen.getByRole('button', { name: 'Close service photos' });
  fireEvent.click(closeButton);
  expect(close).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();

  recovery.value = controllerValue({
    pendingPhoto: {
      ...photo,
      stage: 'reconciliation_pending',
      uploadReceipt: { photo: { id: 'photo-a' } },
    },
    deviceSaveState: 'unavailable',
    closeNeedsConfirmation: true,
  });
  rerender(<TechServicePhotosModal serviceId="visit-a" onClose={close} />);
  expect(screen.getByText(/pending report update notice is not saved on this device/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Discard/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry upload' })).toBeInTheDocument();
  fireEvent.click(closeButton);
  expect(close).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/pending report update notice is not saved/i));

  confirm.mockReturnValueOnce(true);
  fireEvent.click(closeButton);
  expect(close).toHaveBeenCalledTimes(2);

  recovery.value = controllerValue({
    pendingPhoto: { ...photo, stage: 'uploading', uploadReceipt: undefined },
    deviceSaveState: 'unavailable',
    closeNeedsConfirmation: true,
  });
  rerender(<TechServicePhotosModal serviceId="visit-a" onClose={close} />);
  fireEvent.click(closeButton);
  expect(confirm).toHaveBeenLastCalledWith(
    'This photo is not saved on this device. Close and discard the selected photo?',
  );
  expect(close).toHaveBeenCalledTimes(2);
});

it.each([
  ['reconciliation_handed_off', 'Dismiss saved notice'],
  ['upload_failed', 'Discard saved photo'],
])('clears restored metadata only after successful %s dismissal', async (stage, buttonName) => {
  const discard = vi.fn().mockResolvedValue(false);
  recovery.value = controllerValue({
    pendingPhoto: {
      serviceId: 'visit-a', file: new File(['old'], 'old.jpg'),
      photoType: 'issue', caption: 'Old east wall damage', stage,
    },
    deviceSaveState: 'saved', restoredPending: true, discard,
  });
  render(<TechServicePhotosModal serviceId="visit-a" onClose={vi.fn()} />);
  const caption = await screen.findByDisplayValue('Old east wall damage');
  const dismiss = screen.getByRole('button', { name: buttonName });
  await act(async () => fireEvent.click(dismiss));
  expect(caption).toHaveValue('Old east wall damage');
  expect(screen.getByRole('button', { name: 'issue', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const selectPhoto = vi.fn();
  discard.mockImplementationOnce(async () => {
    recovery.value = controllerValue({ selectPhoto });
    return true;
  });
  await act(async () => fireEvent.click(dismiss));
  expect(caption).toHaveValue('');
  expect(screen.getByRole('button', { name: 'after', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const input = screen.getByLabelText('Choose service photo');
  await waitFor(() => expect(input).toBeEnabled());
  const file = new File(['new'], 'new.jpg');
  fireEvent.change(input, { target: { files: [file] } });
  expect(selectPhoto).toHaveBeenCalledWith(file, { photoType: 'after', caption: '' });
});
