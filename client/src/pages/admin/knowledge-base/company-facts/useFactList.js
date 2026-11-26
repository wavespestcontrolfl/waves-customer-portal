import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "../../../../utils/admin-fetch";
import { errorMessage } from "./factCopy";

const PAGE_SIZE = 25;
const listPath = (status, cursor) => `/admin/company-facts?status=${status}&limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
const EMPTY = { facts: [], nextCursor: null, ownerActions: false };

// Reads `pages` pages of one status, following nextCursor. Returns everything read, the cursor after it and the viewer flag.
async function readPages(status, pages) {
  const facts = [];
  let cursor = null;
  let ownerActions = false;
  for (let read = 0; read < pages; read += 1) {
    const body = await adminFetch(listPath(status, cursor));
    facts.push(...(body.facts || []));
    ownerActions = body.viewer?.ownerActions === true;
    cursor = body.nextCursor || null;
    if (!cursor) break;
  }
  return { facts, nextCursor: cursor, ownerActions };
}

// One status of the bank, a page at a time. Switching status starts a fresh read; an answer for a status the page has left is ignored.
// A quiet refresh (after a change) re-reads every page already loaded and keeps what an admin may be typing into:
// a card whose edit form is open (`isEditing(id)`) is kept even if it left this status, and a failed quiet refresh keeps the list.
export default function useFactList(status, isEditing = () => false) {
  const [page, setPage] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const token = useRef(0);
  const pagesLoaded = useRef(1);
  // The status the page shows now. A reload or page read started for another status (a save that finished after the admin
  // switched tabs) is dropped, so it can never fill this status with another status's facts.
  const shown = useRef(status);
  shown.current = status;
  const editing = useRef(isEditing);
  editing.current = isEditing;

  // quiet: a refresh after a change keeps the cards on screen instead of flashing "Loading".
  const reload = useCallback(async (quiet = false) => {
    if (shown.current !== status) return;
    const mine = ++token.current;
    const isQuiet = quiet === true;
    if (!isQuiet) {
      pagesLoaded.current = 1;
      setLoading(true);
    }
    setError("");
    try {
      const fresh = await readPages(status, isQuiet ? pagesLoaded.current : 1);
      if (mine !== token.current) return;
      setPage((prev) => {
        if (!isQuiet) return fresh;
        const freshIds = new Set(fresh.facts.map((fact) => fact.id));
        const kept = prev.facts.filter((fact) => !freshIds.has(fact.id) && editing.current(fact.id));
        return { ...fresh, facts: [...fresh.facts, ...kept] };
      });
    } catch (requestError) {
      if (mine !== token.current) return;
      if (!isQuiet) setPage(EMPTY);
      setError(errorMessage(requestError, "The facts could not be loaded."));
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [status]);

  useEffect(() => { reload(); }, [reload]);

  const loadMore = async () => {
    if (!page.nextCursor || loadingMore || shown.current !== status) return;
    const mine = token.current;
    setLoadingMore(true);
    setError("");
    try {
      const body = await adminFetch(listPath(status, page.nextCursor));
      if (mine === token.current) {
        pagesLoaded.current += 1;
        setPage((prev) => ({ ...prev, facts: [...prev.facts, ...(body.facts || [])], nextCursor: body.nextCursor || null }));
      }
    } catch (requestError) {
      if (mine === token.current) setError(errorMessage(requestError, "More facts could not be loaded."));
    } finally {
      setLoadingMore(false);
    }
  };

  return { ...page, loading, loadingMore, error, reload, loadMore };
}
