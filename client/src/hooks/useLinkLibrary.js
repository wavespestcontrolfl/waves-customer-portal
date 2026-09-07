import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "../utils/admin-fetch";

// Each composer loads the shared library on first open; filtering stays local.
export default function useLinkLibrary(open) {
  const [links, setLinks] = useState(null);
  const [receiptLinksEnabled, setReceiptLinksEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!open || links) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminFetch("/admin/communications/link-library")
      .then((data) => {
        if (!cancelled) {
          setLinks(Array.isArray(data.links) ? data.links : []);
          setReceiptLinksEnabled(data.receiptLinksEnabled === true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(`Couldn't load the link library: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, links, attempt]);

  return { links, loading, error, retry, receiptLinksEnabled };
}
