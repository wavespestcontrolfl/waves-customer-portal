import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "../utils/admin-fetch";

const empty = { items: [], meta: {}, loaded: false, loading: false, error: "", failedCursor: null };

// Shared by the customer message thread and activity feed. A new customer,
// filter, or refresh starts a new cursor chain; late pages cannot join it.
export default function useCustomerHistory({ customerId, kind, enabled, query = "", revision = 0 }) {
  const key = `${customerId}/${kind}?${query}#${revision}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const requestRef = useRef({ sequence: 0, controller: null, pending: false });
  const [state, setState] = useState({ ...empty, key });

  const request = useCallback(async (cursor = null) => {
    if (!enabled) return;
    const tracker = requestRef.current;
    if (cursor && tracker.pending) return;
    tracker.controller?.abort();
    const controller = new AbortController();
    const sequence = ++tracker.sequence;
    tracker.controller = controller;
    tracker.pending = true;
    const current = () => !controller.signal.aborted && sequence === tracker.sequence && currentKey.current === key;
    setState((previous) => ({ ...(cursor && previous.key === key ? previous : empty), key, loading: true }));
    const params = new URLSearchParams(query);
    params.set("limit", "50");
    if (cursor) params.set("cursor", cursor);
    try {
      const result = await adminFetch(`/admin/customers/${customerId}/${kind}?${params}`, { signal: controller.signal });
      if (!current()) return;
      setState((previous) => {
        const incoming = Array.isArray(result[kind]) ? result[kind] : [];
        const existing = cursor ? previous.items : [];
        const ids = new Set(existing.map((item) => item.id).filter(Boolean));
        return { key, items: [...existing, ...incoming.filter((item) => !item.id || !ids.has(item.id))],
          meta: { ...result, readScope: cursor ? previous.meta.readScope : result.readScope },
          loaded: true, loading: false, error: "", failedCursor: null };
      });
    } catch (error) {
      if (current()) setState((previous) => ({ ...previous, loaded: true, loading: false,
        error: error.message || "Could not load customer history.", failedCursor: cursor }));
    } finally {
      if (sequence === tracker.sequence) tracker.pending = false;
    }
  }, [customerId, enabled, key, kind, query]);

  useEffect(() => {
    setState({ ...empty, key });
    void request();
    return () => { requestRef.current.controller?.abort(); requestRef.current.pending = false; };
  }, [key, request]);

  const visible = state.key === key && enabled ? state : empty;
  return {
    ...visible,
    loading: visible.loading || (enabled && !visible.loaded),
    hasMore: Boolean(visible.meta.hasMore && visible.meta.nextCursor),
    reload: () => request(),
    retry: () => request(visible.failedCursor),
    loadOlder: () => visible.meta.nextCursor && request(visible.meta.nextCursor),
  };
}
