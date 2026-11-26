import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "../../../../utils/admin-fetch";
import { errorMessage } from "./factCopy";

const PAGE_SIZE = 25;
const listPath = (status, cursor) => `/admin/company-facts?status=${status}&limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
const EMPTY = { facts: [], nextCursor: null, ownerActions: false };

// One status of the bank, a page at a time. Switching status starts a fresh read; an answer for a status the page has left is ignored.
export default function useFactList(status) {
  const [page, setPage] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const token = useRef(0);
  // The status the page shows now. A reload or page read started for another status (a save that finished after the admin
  // switched tabs) is dropped, so it can never fill this status with another status's facts.
  const shown = useRef(status);
  shown.current = status;

  // quiet: a refresh after a change keeps the cards on screen instead of flashing "Loading".
  const reload = useCallback(async (quiet = false) => {
    if (shown.current !== status) return;
    const mine = ++token.current;
    if (quiet !== true) setLoading(true);
    setError("");
    try {
      const body = await adminFetch(listPath(status));
      if (mine === token.current) setPage({ facts: body.facts || [], nextCursor: body.nextCursor || null, ownerActions: body.viewer?.ownerActions === true });
    } catch (requestError) {
      if (mine === token.current) {
        setPage(EMPTY);
        setError(errorMessage(requestError, "The facts could not be loaded."));
      }
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
      if (mine === token.current) setPage((prev) => ({ ...prev, facts: [...prev.facts, ...(body.facts || [])], nextCursor: body.nextCursor || null }));
    } catch (requestError) {
      if (mine === token.current) setError(errorMessage(requestError, "More facts could not be loaded."));
    } finally {
      setLoadingMore(false);
    }
  };

  return { ...page, loading, loadingMore, error, reload, loadMore };
}
