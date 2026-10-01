// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ isNativeApp: () => true }));
const getPhoto = vi.hoisted(() => vi.fn());
vi.mock('@capacitor/camera', () => ({
  Camera: { getPhoto },
  CameraResultType: { DataUrl: 'dataUrl' },
  CameraSource: { Prompt: 'PROMPT' },
}));

import { captureCameraPhoto, NATIVE_PICKER_EVENT } from './camera';

const seen = [];
const record = (e) => seen.push(e.detail.open);
document.addEventListener(NATIVE_PICKER_EVENT, record);
afterEach(() => { seen.length = 0; getPhoto.mockReset(); });

it('announces the native camera sheet opening and closing around a capture', async () => {
  getPhoto.mockImplementation(async () => {
    expect(seen).toEqual([true]); // announced before the sheet shows
    return { dataUrl: 'data:image/jpeg;base64,AA', format: 'jpeg' };
  });
  const result = await captureCameraPhoto();
  expect(result.photo).toBeTruthy();
  expect(seen).toEqual([true, false]);
});

it('announces the close when the capture is cancelled', async () => {
  getPhoto.mockRejectedValue(new Error('User cancelled photos app'));
  expect(await captureCameraPhoto()).toEqual({ cancelled: true });
  expect(seen).toEqual([true, false]);
});
