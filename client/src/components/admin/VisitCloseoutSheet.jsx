import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle2, ClipboardList } from 'lucide-react';
import { Button, Sheet, SheetBody, SheetFooter, SheetHeader } from '../ui';
import { CompletionPanel, completionReconcilePrompt, createCompletionIdempotencyKey } from '../../pages/admin/SchedulePage';
import { adminFetch } from '../../utils/admin-fetch';
import { deleteCompletionDraft, deleteVisitCompletionDraft, getVisitCompletionDraft, putVisitCompletionDraft } from '../../lib/completion-resume-store';
import { completionDraftKey } from '../../lib/completion-drafts';
import { getAdminUser } from '../../lib/adminAuth';

// The server classifies retained history from canonical service records.
const liveMembers = (detail) => detail.members.filter((member) => member.requiresForm === true);

const OUTCOMES = {
  completed: 'Completed', incomplete: 'Incomplete — office follow-up',
  inspection_only: 'Inspection only', customer_declined: 'Customer declined',
  follow_up_needed: 'Follow-up needed', customer_concern: 'Customer concern',
};

function operatorScope() {
  const id = getAdminUser()?.id;
  return id ? String(id) : '';
}

function rowsForDetail(detail, day, visitId) {
  const rows = liveMembers(detail).map((member) => (day.services || []).find((service) => service.id === member.id));
  if (rows.some((row) => !row || row.visitId !== visitId)) {
    throw new Error('The service list changed. Refresh the schedule before closing this visit.');
  }
  return rows;
}

function draftForServices(stored, visitId, services) {
  const source = stored?.visitId === visitId
    ? stored
    : { visitId, key: createCompletionIdempotencyKey(visitId), forms: {} };
  const memberIds = new Set(services.map((service) => service.id));
  return {
    ...source,
    forms: Object.fromEntries(Object.entries(source.forms || {}).filter(([serviceId]) => memberIds.has(serviceId))),
  };
}

function removeCompletionMetadata(serviceId, scope) {
  try {
    const key = completionDraftKey(serviceId);
    const metadata = JSON.parse(localStorage.getItem(key) || 'null');
    if ((metadata?.owner || '') === scope) localStorage.removeItem(key);
  } catch { /* IndexedDB cleanup still removes the photo-bearing copy. */ }
}

async function clearTerminalDrafts(visitId, members, scope) {
  const serviceIds = [...new Set((members || []).map((member) => member?.id).filter(Boolean))];
  await Promise.all([
    deleteVisitCompletionDraft(visitId, scope),
    ...serviceIds.map((serviceId) => deleteCompletionDraft(serviceId, scope)),
  ]);
  serviceIds.forEach((serviceId) => removeCompletionMetadata(serviceId, scope));
}

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
    Promise.all([
      adminFetch(`/admin/visit-closeouts/${visitId}`),
      getVisitCompletionDraft(visitId, scope),
    ]).then(async ([detail, stored]) => {
      // A lost final response can leave a draft after the server finished.
      const terminal = ['done', 'failed'].includes(detail.packet?.status);
      if (terminal) await clearTerminalDrafts(visitId, detail.members, scope);
      const day = await adminFetch(`/admin/schedule?date=${encodeURIComponent(detail.serviceDate)}`);
      const rows = rowsForDetail(detail, day, visitId);
      if (!live) return;
      setVisit(detail);
      setServices(rows);
      setDraft(draftForServices(terminal ? null : stored, visitId, rows));
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
      if (!packet && !await putVisitCompletionDraft(visitId, candidate, scope)) throw new Error('Could not preserve these forms for retry. Please try again.');
      const response = await adminFetch(`/admin/visit-closeouts/${visitId}${packet ? '/resume' : ''}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': candidate.key },
        body: JSON.stringify(packet ? {} : { items: services.map((service) => ({ serviceId: service.id, body: candidate.forms[service.id].body })) }),
      });
      setResult(response);
      setVisit((current) => ({ ...current, canRevokeSummary: response.canRevokeSummary === true,
        packet: { id: response.packetId, status: response.state === 'done' || response.state === 'office_required' ? 'done' : 'processing' } }));
      if (['done', 'office_required'].includes(response.state)) {
        await clearTerminalDrafts(visitId, visit?.members || services, scope);
      }
      onSaved();
    } catch (err) {
      const form = candidate.forms[err.details?.serviceId];
      const prompt = completionReconcilePrompt(err);
      if (!packet && form && !form.body.reportReconcileConfirmed && prompt) {
        if (window.confirm(prompt)) {
          confirmedDraft = { ...candidate, forms: { ...candidate.forms, [err.details.serviceId]: {
            ...form, body: { ...form.body, reportReconcileConfirmed: true },
          } } };
          setDraft(confirmedDraft);
        }
      } else {
        setError(err.name === 'TypeError'
          ? 'Connection interrupted. Your forms are saved. Resume this closeout when you reconnect.'
          : err.message || 'Could not finish the closeout. Your forms are saved on this device.');
        // An HTTP timeout does not mean the transaction failed. Discover the
        // server-owned packet before offering another submit or editable form.
        try {
          const detail = await adminFetch(`/admin/visit-closeouts/${visitId}`);
          setResult(null);
          if (['done', 'failed'].includes(detail.packet?.status)) {
            await clearTerminalDrafts(visitId, detail.members, scope);
            setError('');
          }
          if (err.code === 'visit_members_changed' && !detail.packet) {
            const day = await adminFetch(`/admin/schedule?date=${encodeURIComponent(detail.serviceDate)}`);
            const rows = rowsForDetail(detail, day, visitId);
            const refreshedDraft = draftForServices(candidate, visitId, rows);
            await putVisitCompletionDraft(visitId, refreshedDraft, scope);
            setServices(rows);
            setDraft(refreshedDraft);
            setEditing(null);
            setError('The service list changed. Review the refreshed services before trying again.');
          }
          setVisit(detail);
          if (detail.packet) onSaved();
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
              const form = draft?.forms?.[service.id];
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
          {result?.payment && <p className="text-sm text-zinc-600">Payment: {{ paid: 'Paid', prepaid: 'Prepaid', no_charge: 'No charge', payment_needed: 'Invoice queued for delivery', payment_failed: 'Card declined; invoice queued for delivery', payment_pending: 'Awaiting confirmation', processing: 'Awaiting confirmation', office_required: 'Office review' }[result.payment.state] || 'Recorded'}.</p>}
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
