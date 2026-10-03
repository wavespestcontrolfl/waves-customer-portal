import { useEffect } from "react";
import {
  applyAdminBookmarkMeta,
  applyFieldBookmarkMeta,
  restoreBookmarkMeta,
  snapshotBookmarkMeta,
} from "../lib/adminBookmarkMeta";

/**
 * Keep Safari home-screen metadata on the admin identity for the whole
 * /admin/* tree, including /admin/login (which is outside AdminLayoutV2).
 *
 * While `active` is false this is a TRUE no-op: /tech owns its own
 * manifest/title and customer token pages set their own document.title —
 * writing customer defaults over them on every non-admin route was a bug.
 * Entering /admin snapshots the current identity first, so leaving via SPA
 * navigation puts back exactly what the destination-side route had (the
 * snapshot is null on a cold prod /admin load, where the server already
 * rendered admin meta + html.admin-app — restore then falls back to the
 * customer defaults).
 */
// `field` (the /admin/today subtree) swaps in the field PWA identity instead
// of the admin one while staying inside the admin tree; the snapshot is taken
// once on entering /admin and restored once on leaving it.
export default function useAdminBookmarkMeta(active, field = false) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const snapshot = snapshotBookmarkMeta();
    return () => {
      restoreBookmarkMeta(snapshot);
    };
  }, [active]);
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    if (field) applyFieldBookmarkMeta();
    else applyAdminBookmarkMeta();
  }, [active, field]);
}
