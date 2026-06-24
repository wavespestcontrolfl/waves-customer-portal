// DEV-ONLY web shim for @capacitor/camera (CAP_SHIM=1). Native-only at runtime.
export const Camera = {
  getPhoto: async () => { throw new Error('web-shim: camera unavailable'); },
  requestPermissions: async () => ({ camera: 'denied', photos: 'denied' }),
};
export const CameraResultType = { Uri: 'uri', Base64: 'base64', DataUrl: 'dataUrl' };
export const CameraSource = { Prompt: 'PROMPT', Camera: 'CAMERA', Photos: 'PHOTOS' };
export default { Camera, CameraResultType, CameraSource };
