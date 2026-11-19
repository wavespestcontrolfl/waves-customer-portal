import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOffer } from "./offerApi";
import { offerErrorMessage } from "./offerLogic";

const IDLE = { id: null, status: "idle", data: null, error: null };

/**
 * Reads the open application's offer state. Three outcomes stay distinct:
 *  - off:   the server answered 404 { enabled: false } (gate off). Only then
 *           does the old status-only Offer move apply.
 *  - error: any other failure. The page shows the error with a Retry and
 *           offers no Offer move. A failed refresh keeps the data already
 *           on screen (refreshError) so an open dialog never goes blank.
 *  - ready: { enabled: true, ... } for THIS application.
 */
export default function useOfferFlow(applicationId) {
  const [state, setState] = useState(IDLE);
  const [form, setForm] = useState(null); // null = closed, else { draft }
  const seq = useRef(0);
  // The application the page has open now. Every async result carries the id
  // it was started for and is dropped when that is no longer this one.
  const openId = useRef(null);
  openId.current = applicationId || null;

  const reload = useCallback(async (id) => {
    if (id !== openId.current) return null;
    const mine = ++seq.current;
    try {
      const data = await fetchOffer(id);
      if (mine === seq.current) {
        setState({ id, status: data.enabled === true ? "ready" : "off", data, error: null });
      }
      return data;
    } catch (err) {
      if (mine === seq.current) {
        const error = offerErrorMessage(err);
        setState((prev) =>
          prev.id === id && prev.status === "ready"
            ? { ...prev, refreshError: error }
            : { id, status: "error", data: null, error },
        );
      }
      return null;
    }
  }, []);

  useEffect(() => {
    setForm(null);
    if (!applicationId) {
      seq.current += 1;
      setState(IDLE);
      return;
    }
    setState({ id: applicationId, status: "loading", data: null, error: null });
    reload(applicationId);
  }, [applicationId, reload]);

  const mine = applicationId && state.id === applicationId ? state : IDLE;
  const status = applicationId && mine.status === "idle" ? "loading" : mine.status;
  // A failed first read blanks to "loading" on retry; a failed refresh keeps
  // the data on screen while it re-reads.
  const retry = () => {
    if (!applicationId) return null;
    if (status !== "ready") setState({ id: applicationId, status: "loading", data: null, error: null });
    return reload(applicationId);
  };
  return {
    status,
    enabled: status === "ready" && mine.data?.enabled === true,
    off: status === "off",
    loading: status === "loading",
    error: status === "error" ? mine.error : null,
    data: mine.data,
    // Set when the last re-read after an action failed: the data shown may be stale.
    refreshError: status === "ready" ? mine.refreshError || null : null,
    ownerActions: status === "ready" && mine.data?.viewer?.ownerActions === true,
    form,
    openForm: (draft = null, forId = openId.current) => {
      if (forId === openId.current) setForm({ draft });
    },
    closeForm: () => setForm(null),
    reload: () => (applicationId ? reload(applicationId) : null),
    retry,
  };
}
