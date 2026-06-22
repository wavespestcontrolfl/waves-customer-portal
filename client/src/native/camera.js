import { isNativeApp } from './platform';

/**
 * Native camera/photo capture (native only). Dynamic-imports @capacitor/camera
 * so the web build stays inert — on the web the existing
 * <input type="file" capture> handles photos.
 *
 * Returns a photo in the same shape PortalPage's web upload uses
 * ({ preview, data, name } with a data: URL), or null if the user cancels.
 */
export async function captureCameraPhoto() {
  if (!isNativeApp()) return null;
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      quality: 70,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt, // let the user choose Camera or Photo Library
      saveToGallery: false,
      correctOrientation: true,
    });
    if (!photo?.dataUrl) return null;
    const ext = photo.format ? `.${photo.format}` : '.jpg';
    return { preview: photo.dataUrl, data: photo.dataUrl, name: `photo${ext}` };
  } catch {
    // User cancelled or capture failed.
    return null;
  }
}
