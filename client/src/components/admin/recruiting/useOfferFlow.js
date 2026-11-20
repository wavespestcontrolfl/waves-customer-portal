import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOffer } from "./offerApi";
import { offerErrorMessage } from "./offerLogic";

const IDLE = { id: null, status: "idle", data: null, error: null };
// A timer waits at most 2^31 - 1 ms (about 24.8 days); a longer wait fires early and arms again.
const MAX_TIMER_MS = 2 ** 31 - 1;
const sentExpiry = (offer) => (offer?.status === "sent" ? offer.expiresAt : null);

/**
 * Renders the caller again once a sent offer it shows passes its expiry: the offer read's current offer, and the offer
 * in a send's answer (`sent`, the form's result) while that result is open. From then on a sent offer reads as closed
 * unsigned by the page's clock (shownOffer), so a card or a form left open changes with no other read. The send's
 * answer counts on its own: when the read after the send failed, that read still holds the draft.
 */
export function useRenderAtExpiry(data, sent = null) {
  const [tick, setTick] = useState(0);
  // The next expiry by this render's clock, the one that showed the offer as sent (NaN: none still ahead).
  const now = Date.now();
  const ahead = [sentExpiry(data?.current), sentExpiry(sent?.offer)].map((at) => Date.parse(at)).filter((at) => at >= now);
  const next = ahead.length ? Math.min(...ahead) : NaN;
  useEffect(() => {
    if (Number.isNaN(next)) return undefined;
    // An expiry that passed after the render, before this effect ran, renders again at once.
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(Math.max(next - Date.now() + 1, 0), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [next, tick]);
}

/**
 * Reads the open application's offer state. Three outcomes stay distinct:
 *  - off:   the server answered 404 { enabled: false } (gate off). Only then
 *           does the old status-only Offer move apply.
 *  - error: any other failure. The page shows the error with a Retry and
 *           offers no Offer move. A failed refresh keeps the data already
 *           on screen (refreshError) so an open dialog never goes blank.
 *  - ready: { enabled: true, ... } for THIS application.
 */
export default function useOfferFlow(applicationId, applicationStatus) {
  const [state, setState] = useState(IDLE);
  const [form, setForm] = useState(null); // null = closed, else { draft, key, seenOut }
  const seq = useRef(0);
  const formSeq = useRef(0); // each opened form gets its own key, so a close can name the form it is for
  // The application the page has open now. Every async result carries the id
  // it was started for and is dropped when that is no longer this one.
  const openId = useRef(null);
  openId.current = applicationId || null;

  const reload = useCallback(async (id) => {
    if (id !== openId.current) return null;
    const mine = ++seq.current;
    try {
      const data = await fetchOffer(id);
      // A newer read replaced this one: its answer, not this one, is what the page shows, so
      // this caller gets null (as for a failed read) and never acts on data the page dropped.
      if (mine !== seq.current) return null;
      const on = data.enabled === true;
      setState({ id, status: on ? "ready" : "off", data, error: null });
      // The gate went off: close the form, so the application is back on the status-only Offer move.
      if (!on) setForm(null);
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

  // A stage change on the open application (Interview -> Offer, Hired...) changes
  // what the offer card may offer, so re-read it. The result is still dropped if
  // another applicant is on screen by then (reload checks the id).
  const seen = useRef({ id: null, status: null });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { id: applicationId || null, status: applicationStatus };
    if (applicationId && prev.id === applicationId && prev.status !== applicationStatus) reload(applicationId);
  }, [applicationId, applicationStatus, reload]);

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
    // seenOut: the offers out the owner saw before the action that opens the form, when a write and a read come
    // between (Revise); the form starts from it instead of the read it opens on.
    openForm: (draft = null, forId = openId.current, seenOut = null) => {
      if (forId === openId.current) setForm({ draft, key: ++formSeq.current, seenOut });
    },
    // Closes the form only while it is the one `key` names. An action that finishes after the owner opened another
    // form (for another applicant, or again for this one) leaves that form and its edits alone.
    closeForm: (key) => setForm((open) => (open && open.key === key ? null : open)),
    reload: () => (applicationId ? reload(applicationId) : null),
    // An explicit open of an application (a list click, a bell link) re-reads its offer even when the id and the stage
    // stay the same: a date request or an answer changes the offer, not the stage. Stable. For an id that is not the
    // open one it does nothing (the effect above reads a newly opened application itself).
    reloadFor: reload,
    retry,
  };
}
