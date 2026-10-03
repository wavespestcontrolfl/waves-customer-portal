import { useCallback, useEffect, useRef, useState } from 'react';

// Thumbnails are fetched lazily, once, from GET /:id/visit-prep-photos —
// the SAME ownership-scoped endpoint the server pairs with this facts key
// (technicianCurrentVisitFilter + the reassignment recheck), so a fetch
// from a technician the stop was reassigned away from 404s exactly like
// the facts key itself would have been withheld. A fetch failure just
// leaves the placeholder boxes — never an error banner over a section
// that is otherwise informative (the note/topic/location still render).
// `photoSignature` (the current photo ids, joined) re-runs the fetch when a
// brief refresh brings a new submission, so its thumbnails load without
// reopening the panel (Codex #5239 r1 P2).
// The server signs these for one hour (visit-prep.js
// TECH_PHOTO_VIEW_TTL_SECONDS); the panel can stay open longer, so the links
// are re-fetched before they expire (Codex #5239 r4 P2).
export const VISIT_PREP_URL_REFRESH_MS = 50 * 60 * 1000;
const EMPTY_URLS = Object.freeze({});

// One short automatic retry after a failed fetch, for a caller that shows
// the failure (the admin job card); the Visit Brief keeps its placeholders.
const VISIT_PREP_RETRY_MS = 15 * 1000;

// { urls, failed, retry }: `urls` is the fresh id → url map (empty while
// stale), `failed` says the latest fetch failed, `retry` fetches again now.
export function useVisitPrepPhotoState(serviceId, active, request, photoSignature, { retryOnFailure = false } = {}) {
  const [links, setLinks] = useState({ byId: {}, fetchedAt: 0 });
  const [failed, setFailed] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchedAtRef = useRef(0);
  const autoRetriesRef = useRef(0);
  useEffect(() => {
    if (!active || !serviceId || typeof request !== 'function') return;
    let cancelled = false;
    let retryTimer = null;
    request(`/admin/schedule/${serviceId}/visit-prep-photos`)
      .then((data) => {
        if (cancelled) return;
        const next = {};
        for (const p of (data?.photos || [])) { if (p?.id) next[p.id] = p.url; }
        fetchedAtRef.current = Date.now();
        setLinks({ byId: next, fetchedAt: fetchedAtRef.current });
        setFailed(false);
        autoRetriesRef.current = 0;
      })
      // Links from an earlier fetch stay only while still fresh (below); a
      // failed refresh never keeps expired ones clickable.
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        if (retryOnFailure && autoRetriesRef.current < 1) {
          autoRetriesRef.current += 1;
          retryTimer = setTimeout(() => setRefreshTick((n) => n + 1), VISIT_PREP_RETRY_MS);
        }
      });
    const refresh = setTimeout(() => setRefreshTick((n) => n + 1), VISIT_PREP_URL_REFRESH_MS);
    return () => { cancelled = true; clearTimeout(refresh); clearTimeout(retryTimer); };
  }, [serviceId, active, request, photoSignature, refreshTick, retryOnFailure]);
  // A backgrounded tab or a locked phone can suspend the timer above past
  // the links' expiry. On resume, stale links are withheld at once (so a tap
  // never opens an expired url) and re-fetched (Codex #5239 r6 P2).
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const onResume = () => {
      if (document.visibilityState === 'hidden') return;
      const at = fetchedAtRef.current;
      if (!at || Date.now() - at < VISIT_PREP_URL_REFRESH_MS) return;
      fetchedAtRef.current = 0;
      setLinks({ byId: {}, fetchedAt: 0 });
      setRefreshTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
    };
  }, [active]);
  const fresh = links.fetchedAt && Date.now() - links.fetchedAt < VISIT_PREP_URL_REFRESH_MS;
  const retry = useCallback(() => setRefreshTick((n) => n + 1), []);
  return { urls: fresh ? links.byId : EMPTY_URLS, failed, retry };
}

// The Visit Brief's reader: just the fresh links.
export function useVisitPrepPhotoUrls(serviceId, active, request, photoSignature) {
  return useVisitPrepPhotoState(serviceId, active, request, photoSignature).urls;
}
