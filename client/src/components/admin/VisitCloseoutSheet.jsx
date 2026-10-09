import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle2, ClipboardList } from 'lucide-react';
import { Button, Sheet, SheetBody, SheetFooter, SheetHeader } from '../ui';
import { CompletionPanel } from '../../pages/admin/SchedulePage';
import { adminFetch } from '../../utils/admin-fetch';
import { putVisitCompletionDraft } from '../../lib/completion-resume-store';
import {
  clearTerminalDrafts, loadVisitCloseout, operatorScope, packetConfirm, packetErrorMessage, paymentLine, postVisitPacket, rediscoverCloseout,
} from '../../lib/visit-closeout-packet';

const OUTCOMES = {
  completed: 'Completed', incomplete: 'Incomplete — office follow-up',
  inspection_only: 'Inspection only', customer_declined: 'Customer declined',
  follow_up_needed: 'Follow-up needed', customer_concern: 'Customer concern',
};

export default function VisitCloseoutSheet({ visitId, products, onClose, onSaved }) {
  const [visit, setVisit] = useState(null);
  const [services, setServices] = useState([]);
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [reload, setReload] = useState(0);
  const submitting = useRef(false);
  const scope = operatorScope();

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

  const packet = visit?.packet;
  const finished = result ? ['done', 'office_required'].includes(result.state) : ['done', 'failed'].includes(packet?.status);
  const officeReview = result ? result.state === 'office_required' : packet?.status === 'failed' || packet?.officeReview;
  const ready = services.length > 0 && services.every((service) => draft?.forms?.[service.id]?.body);
  const prepared = services.filter((service) => draft?.forms?.[service.id]?.body).length;

  async function prepare(serviceId, body, formDraft) {
    const next = { ...draft, forms: { ...draft.forms, [serviceId]: { body, draft: formDraft } } };
    if (!await putVisitCompletionDraft(visitId, next, scope)) {
      throw new Error('Could not save this form and its photos on this device. Free some storage and try again.');
    }
    setDraft(next);
    setEditing(null);
    setError('');
  }

  async function submit(candidate = draft) {
    if (submitting.current || (!packet && !ready)) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    let confirmedDraft;
    try {
      const response = await postVisitPacket({ visitId, packet, draft: candidate, services, scope });
      setResult(response);
      setVisit((current) => ({ ...current, canRevokeSummary: response.canRevokeSummary === true,
        packet: { id: response.packetId, status: response.state === 'done' || response.state === 'office_required' ? 'done' : 'processing' } }));
      if (['done', 'office_required'].includes(response.state)) {
        await clearTerminalDrafts(visitId, visit?.members || services, scope);
      }
      onSaved();
    } catch (err) {
      // The confirm prompts (a changed report, the edit heads-up, a promise changed after the report): OK sends that
      // member as is under the same key; Cancel on a promise puts its form back to be marked again.
      const confirm = await packetConfirm({ err, candidate, packet, visitId, scope });
      if (confirm?.resend) {
        confirmedDraft = confirm.resend;
        setDraft(confirmedDraft);
      } else if (confirm?.reopened) {
        setDraft(confirm.reopened);
        setError(confirm.message);
      } else if (!confirm) {
        setError(packetErrorMessage(err));
        // An HTTP timeout does not mean the transaction failed. Discover the
        // server-owned packet before offering another submit or editable form.
        try {
          const found = await rediscoverCloseout({ visitId, candidate, err, scope });
          setResult(null);
          if (found.finished) setError('');
          if (found.refreshed) {
            setServices(found.refreshed.rows);
            setDraft(found.refreshed.draft);
            setEditing(null);
            setError('The service list changed. Review the refreshed services before trying again.');
          }
          setVisit(found.detail);
          if (found.detail.packet) onSaved();
        } catch {
          // The same key/body remain durable for a later retry. A membership
          // rejection must expose the reload control instead of a stale list.
          if (err.code === 'visit_members_changed') setVisit(null);
        }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
    if (confirmedDraft) return submit(confirmedDraft);
  }

  async function revokeSummary() {
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/admin/visit-closeouts/${visitId}/revoke-summary`, { method: 'POST', body: '{}' });
      setVisit((current) => ({ ...current, canRevokeSummary: false, summaryRevoked: true }));
    } catch (err) { setError(err.message || 'Could not revoke the shared summary link.'); }
    finally { setBusy(false); }
  }

  if (editing) return (
    <CompletionPanel
      key={editing.id} service={editing} products={products}
      preparedDraft={draft.forms[editing.id]?.draft}
      onPrepared={prepare} onClose={() => setEditing(null)}
    />
  );

  return (
    <Sheet open onClose={onClose} width="lg" ariaLabel="Close out visit">
      <SheetHeader>
        <div>
          <h2 className="text-xl font-medium text-zinc-900">{finished ? 'Visit recorded' : 'Close out visit'}</h2>
          <p className="mt-1 text-sm text-zinc-600">{services[0]?.customerName || 'Combined service visit'}</p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close visit closeout"><X size={20} /></Button>
      </SheetHeader>
      <SheetBody className="space-y-5 text-base text-zinc-900">
        {!visit && !error && <p role="status">Loading the visit…</p>}
        {error && <div role="alert" className="rounded-sm border border-alert-fg p-4 text-alert-fg">{error}</div>}
        {!visit && error && <Button className="text-sm" onClick={() => setReload((value) => value + 1)}>Try again</Button>}
        {visit && <>
          <p className="text-zinc-600">{officeReview
            ? 'The service records are saved. The office must review this closeout before the remaining work can finish.'
            : packet
            ? 'The service records are saved. Any remaining invoice, payment, or report delivery continues from this closeout.'
            : 'Review each service form, then close out the visit once. Only eligible completed work is included in the shared invoice.'}</p>
          <div className="space-y-3">
            {services.map((service) => {
              // A form put back to be marked again keeps its saved inputs
              // (reopened through `preparedDraft`) but no prepared body.
              const form = draft?.forms?.[service.id]?.body ? draft.forms[service.id] : null;
              return <section key={service.id} className="rounded-sm border border-hairline border-zinc-200 p-4">
                <div className="flex items-start gap-3">
                  {form || packet ? <CheckCircle2 size={22} className="shrink-0 text-zinc-700" /> : <ClipboardList size={22} className="shrink-0 text-zinc-500" />}
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-medium">{service.serviceType}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{form ? OUTCOMES[form.body.visitOutcome] || 'Form ready' : packet ? 'Service record saved' : 'Form needed'}</p>
                    {form?.body.completionPhotos?.length > 0 && <p className="mt-1 text-sm text-zinc-600">{form.body.completionPhotos.length} {form.body.completionPhotos.length === 1 ? 'photo' : 'photos'} saved</p>}
                    {!packet && <Button variant="secondary" className="mt-3 text-sm" disabled={busy} onClick={() => setEditing(service)}>{form ? 'Edit form' : 'Open form'}</Button>}
                  </div>
                </div>
              </section>;
            })}
          </div>
          {!packet && <p className="text-sm text-zinc-600" role="status">{prepared} of {services.length} forms ready. Saved forms and photos stay on this device until the visit is recorded.</p>}
          {packet && !finished && <p role="status" className="rounded-sm bg-zinc-100 p-4">Records saved. Closeout is still processing; you can safely resume it.</p>}
          {finished && <p role="status" className={`rounded-sm border p-4 ${officeReview ? 'border-alert-fg text-alert-fg' : 'border-zinc-200 bg-zinc-50'}`}>{officeReview ? 'Visit recorded. The office has an alert to review the service closeout, billing, or delivery.' : 'Visit closeout is complete.'}</p>}
          {paymentLine(result) && <p className="text-sm text-zinc-600">{paymentLine(result)}</p>}
          {visit.summaryRevoked && <p className="text-sm text-zinc-600">The shared summary link has been revoked.</p>}
          {visit.canRevokeSummary && <Button variant="secondary" className="text-sm" disabled={busy} onClick={revokeSummary}>Revoke shared summary link</Button>}
        </>}
      </SheetBody>
      <SheetFooter>
        <Button variant="secondary" className="text-sm" onClick={onClose}>{finished ? 'Done' : 'Close'}</Button>
        {visit && !finished && <Button className="text-sm" disabled={busy || (!packet && !ready)} onClick={() => submit()}>{busy ? 'Saving visit…' : packet ? 'Resume closeout' : 'Complete visit'}</Button>}
      </SheetFooter>
    </Sheet>
  );
}
