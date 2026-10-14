// client/src/hooks/useVisitCloseout.js
//
// The long visit closeout form's state, split along its seams (VisitCloseoutSheet composes them):
//   useCloseoutLoad  the stop, its member rows and its saved draft, read once (and again on "Try again");
//   useCloseoutSend  sending the stop once, and everything a refused or lost send decides (the shared rules in
//                    lib/visit-closeout-packet.js), plus revoking the shared summary link.
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '../utils/admin-fetch';
import {
  clearTerminalDrafts, loadVisitCloseout, packetAfterSend, postVisitPacket, resolveSendFailure,
} from '../lib/visit-closeout-packet';

export function useCloseoutLoad(visitId, scope) {
  const [visit, setVisit] = useState(null);
  const [services, setServices] = useState([]);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    loadVisitCloseout(visitId, scope).then(({ detail, rows, draft: loaded }) => {
      if (!live) return;
      setVisit(detail);
      setServices(rows);
      setDraft(loaded);
    }).catch((err) => { if (live) setError(err.message || 'Could not load the visit.'); });
    return () => { live = false; };
  }, [visitId, reload, scope]);
  const retry = useCallback(() => setReload((value) => value + 1), []);
  return { visit, setVisit, services, setServices, draft, setDraft, error, setError, retry };
}

// `setEditing` closes a member's form when the member list refreshes.
export function useCloseoutSend({ visitId, scope, load, setEditing, onSaved }) {
  const { visit, services, draft, setVisit, setServices, setDraft, setError } = load;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const submitting = useRef(false);
  const packet = visit?.packet;
  const ready = services.length > 0 && services.every((service) => draft?.forms?.[service.id]?.body);

  const send = async (candidate) => {
    const response = await postVisitPacket({ visitId, packet, draft: candidate, services, scope });
    setResult(response);
    setVisit((current) => ({ ...current, canRevokeSummary: response.canRevokeSummary === true, packet: packetAfterSend(response) }));
    if (['done', 'office_required'].includes(response.state)) await clearTerminalDrafts(visitId, visit?.members || services, scope);
    onSaved();
  };

  // Applies what the shared rule decided. Returns the draft to send again (a confirmed prompt), or null.
  const failed = async (err, candidate) => {
    const outcome = await resolveSendFailure({ err, candidate, packet, visitId, scope });
    if (outcome.kind === 'resend') { setDraft(outcome.draft); return outcome.draft; }
    if (outcome.kind === 'reopened') { setDraft(outcome.draft); setError(outcome.message); }
    if (outcome.kind !== 'error') return null;
    setError(outcome.error);
    // The server was asked what it has (an HTTP timeout does not mean the transaction failed): its answer replaces the
    // earlier one, and a changed member list refreshes the forms.
    if (outcome.found) {
      setResult(null);
      if (outcome.found.refreshed) {
        setServices(outcome.found.refreshed.rows);
        setDraft(outcome.found.refreshed.draft);
        setEditing(null);
      }
      setVisit(outcome.found.detail);
      if (outcome.found.detail.packet) onSaved();
    }
    // A membership rejection must expose the reload control instead of a stale list.
    if (outcome.reload) setVisit(null);
    return null;
  };

  const submit = async (candidate = draft) => {
    if (submitting.current || (!packet && !ready)) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    let again = null;
    try { await send(candidate); } catch (err) { again = await failed(err, candidate); } finally {
      submitting.current = false;
      setBusy(false);
    }
    if (again) await submit(again);
  };

  const revokeSummary = async () => {
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/admin/visit-closeouts/${visitId}/revoke-summary`, { method: 'POST', body: '{}' });
      setVisit((current) => ({ ...current, canRevokeSummary: false, summaryRevoked: true }));
    } catch (err) { setError(err.message || 'Could not revoke the shared summary link.'); } finally { setBusy(false); }
  };

  return { busy, result, ready, submit, revokeSummary };
}
