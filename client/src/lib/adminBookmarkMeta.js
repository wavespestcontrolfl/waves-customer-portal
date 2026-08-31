/**
 * Safari home-screen / bookmark identity for the admin portal.
 *
 * `index.html` is the customer document (manifest, title, theme-color).
 * Without an early swap, Add to Home Screen from /admin/login installs
 * the customer app. The inline script in index.html applies this on first
 * paint; React re-applies it for SPA navigations onto /admin/*.
 *
 * Off /admin/* this module must stay hands-off: /tech installs its own
 * manifest + "Field Tools" title, and customer token pages (reports,
 * outlines) set their own document.title. Leaving /admin therefore
 * RESTORES the snapshot taken when admin meta was applied — never a
 * hardcoded rewrite of whatever the destination route owns.
 */

export const CUSTOMER_BOOKMARK_META = {
  manifest: "/manifest.json",
  appTitle: "Waves",
  description:
    "Your Waves service reports, billing, and account — view past visits, track action items, and schedule the next service.",
  documentTitle: "Waves Customer Portal",
  themeColor: "#111111",
};

export const ADMIN_BOOKMARK_META = {
  manifest: "/admin-manifest.json",
  appTitle: "Waves Admin",
  description:
    "Waves Pest Control admin portal — dispatch, customers, billing, and reports.",
  documentTitle: "Waves Admin",
  themeColor: "#18181B",
};

export function isAdminPath(pathname) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function getMeta(name) {
  return (
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ??
    null
  );
}

function setMeta(name, content) {
  if (typeof document === "undefined") return;
  const el = document.querySelector(`meta[name="${name}"]`);
  if (el) el.setAttribute("content", content);
}

/**
 * Capture the document's current bookmark identity so it can be restored
 * on SPA leave. Returns null on a document already carrying admin identity
 * (the index.html first-paint script runs before React on a cold /admin
 * load) — there is no pre-admin state to go back to, so restore falls
 * back to the customer defaults instead of "restoring" admin meta onto a
 * customer route.
 */
export function snapshotBookmarkMeta() {
  if (typeof document === "undefined") return null;
  if (document.documentElement.classList.contains("admin-app")) return null;
  const manifest = document.querySelector('link[rel="manifest"]');
  return {
    manifest:
      manifest?.getAttribute("href") ?? CUSTOMER_BOOKMARK_META.manifest,
    appTitle:
      getMeta("apple-mobile-web-app-title") ?? CUSTOMER_BOOKMARK_META.appTitle,
    description: getMeta("description") ?? CUSTOMER_BOOKMARK_META.description,
    themeColor: getMeta("theme-color") ?? CUSTOMER_BOOKMARK_META.themeColor,
    documentTitle: document.title,
  };
}

function applyBookmark(meta, { adminApp }) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (adminApp) root.classList.add("admin-app");
  else root.classList.remove("admin-app");

  const manifest = document.querySelector('link[rel="manifest"]');
  manifest?.setAttribute("href", meta.manifest);
  setMeta("apple-mobile-web-app-title", meta.appTitle);
  setMeta("description", meta.description);
  setMeta("theme-color", meta.themeColor);
  document.title = meta.documentTitle;
}

export function applyAdminBookmarkMeta() {
  applyBookmark(ADMIN_BOOKMARK_META, { adminApp: true });
}

export function restoreBookmarkMeta(snapshot) {
  applyBookmark(snapshot || CUSTOMER_BOOKMARK_META, { adminApp: false });
}
