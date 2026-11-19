import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOffer } from "./offerApi";

/**
 * Reads the open application's offer state. `enabled` is true only when the
 * server answered { enabled: true } for THIS application; a gate-off 404, a
 * failed read or a slow answer for a previous applicant all leave it false,
 * so the Offer button keeps today's status-only behavior.
 */
export default function useOfferFlow(applicationId) {
  const [state, setState] = useState({ id: null, loading: false, data: null });
  const [form, setForm] = useState(null); // null = closed, else { draft }
  const seq = useRef(0);

  const reload = useCallback(async (id) => {
    const mine = ++seq.current;
    try {
      const data = await fetchOffer(id);
      if (mine === seq.current) setState({ id, loading: false, data });
      return data;
    } catch {
      if (mine === seq.current) setState({ id, loading: false, data: null });
      return null;
    }
  }, []);

  useEffect(() => {
    setForm(null);
    if (!applicationId) {
      seq.current += 1;
      setState({ id: null, loading: false, data: null });
      return;
    }
    setState({ id: applicationId, loading: true, data: null });
    reload(applicationId);
  }, [applicationId, reload]);

  const current = state.id === applicationId ? state : { id: null, loading: false, data: null };
  return {
    enabled: current.data?.enabled === true,
    loading: Boolean(applicationId) && (current.loading || state.id !== applicationId),
    data: current.data,
    form,
    openForm: (draft = null) => setForm({ draft }),
    closeForm: () => setForm(null),
    reload: () => (applicationId ? reload(applicationId) : null),
  };
}
