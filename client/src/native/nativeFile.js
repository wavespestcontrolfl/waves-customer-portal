/**
 * Native (iOS + Android) file save/share for the Capacitor shell.
 *
 * The webview has no download pipeline: a programmatic <a download> click on
 * a blob: URL is a silent no-op in WKWebView and Android WebView, a bare
 * <a href> to a PDF replaces the SPA with no back control on iOS, and
 * window.print() does nothing (portal audit F-017/F-046). On native we
 * instead write the file into the app cache via @capacitor/filesystem and
 * hand it to the OS share sheet via @capacitor/share — which carries Save to
 * Files, AirDrop, Mail, and (on iOS) Print. Web builds never load the
 * plugins: both imports are dynamic behind isNativeApp().
 */
import { isNativeApp } from './platform';

export { isNativeApp };

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

// Dismissing the OS share sheet rejects the Share.share() promise — that's
// the customer choosing not to share, not a failure.
function isShareCancel(err) {
  return /cancel/i.test(String(err?.message || err || ''));
}

// Filesystem.writeFile treats the path literally — strip separators and
// other reserved characters from server-provided file names.
export function safeFileName(name, fallback = 'Waves_Document.pdf') {
  const cleaned = String(name || '').replace(/[/\\:*?"<>|]+/g, '_').trim();
  return cleaned || fallback;
}

/**
 * Save a Blob into the app cache and open the OS share sheet on it.
 * Returns false on web (caller keeps its browser path), true once the
 * share sheet has been offered (including when the customer dismisses it).
 */
export async function saveBlobNative(blob, fileName) {
  if (!isNativeApp()) return false;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const path = safeFileName(fileName);
  const data = await blobToBase64(blob);
  const written = await Filesystem.writeFile({ path, data, directory: Directory.Cache });
  try {
    await Share.share({ title: path, url: written.uri });
  } catch (err) {
    if (!isShareCancel(err)) throw err;
  }
  return true;
}

/**
 * Fetch a PDF URL (attaching the customer JWT when present — harmless on
 * public token routes, required on Bearer-only ones) and route the bytes
 * through the share sheet. Replacement for in-app <a download> anchors.
 * Returns false on web.
 */
export async function saveUrlNative(url, fileName) {
  if (!isNativeApp()) return false;
  let abs = url;
  try { abs = new URL(url, window.location.origin).toString(); } catch { /* keep as-is */ }
  let token = '';
  try { token = localStorage.getItem('waves_token') || ''; } catch { /* storage unavailable */ }
  const r = await fetch(abs, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return saveBlobNative(await r.blob(), fileName);
}
