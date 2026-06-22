import { isNativeApp } from './platform';

/**
 * Native camera/photo capture (native only). Dynamic-imports @capacitor/camera.
 *
 * Returns a discriminated result so the caller can fall back correctly:
 *   { photo: { preview, data, name } } — captured (data: URL, same shape as the
 *                                        web <input type=file> path)
 *   { cancelled: true }               — user cancelled/denied → do nothing
 *   { unavailable: true }             — not native, or the Camera plugin isn't
 *                                        in this build → caller should fall back
 *                                        to the web file input
 *
 * The unavailable case matters because the shell loads the LIVE portal: this JS
 * can run inside an older installed binary that predates the Camera plugin, so
 * Camera.getPhoto() throws UNIMPLEMENTED even though isNativeApp() is true.
 */
export async function captureCameraPhoto() {
  if (!isNativeApp()) return { unavailable: true };

  let mod;
  try {
    mod = await import('@capacitor/camera');
  } catch {
    return { unavailable: true };
  }

  const { Camera, CameraResultType, CameraSource } = mod;
  try {
    const photo = await Camera.getPhoto({
      quality: 70,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt, // let the user choose Camera or Photo Library
      saveToGallery: false,
      correctOrientation: true,
    });
    if (!photo?.dataUrl) return { cancelled: true };
    const ext = photo.format ? `.${photo.format}` : '.jpg';
    return { photo: { preview: photo.dataUrl, data: photo.dataUrl, name: `photo${ext}` } };
  } catch (err) {
    const sig = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
    // Plugin missing / method not compiled into this build → fall back to web.
    if (sig.includes('unimplemented') || sig.includes('not implemented') || sig.includes('unavailable') || sig.includes('not available')) {
      return { unavailable: true };
    }
    // User cancelled or denied permission — a no-op (don't re-pop a picker).
    return { cancelled: true };
  }
}
