import { useState } from 'react';
import { X, CheckCircle2, ClipboardList } from 'lucide-react';
import { Button, Sheet, SheetBody, SheetFooter, SheetHeader } from '../ui';
import { CompletionPanel } from '../../pages/admin/SchedulePage';
import { putVisitCompletionDraft } from '../../lib/completion-resume-store';
import { useCloseoutLoad, useCloseoutSend } from '../../hooks/useVisitCloseout';
import {
  isFinishedState, isOfficeReviewState, operatorScope, packetDisplayState, paymentLine,
} from '../../lib/visit-closeout-packet';

const OUTCOMES = {
  completed: 'Completed', incomplete: 'Incomplete — office follow-up',
  inspection_only: 'Inspection only', customer_declined: 'Customer declined',
  follow_up_needed: 'Follow-up needed', customer_concern: 'Customer concern',
};

// One member's card: its form's state, and the button that opens it.
function MemberCard({ service, form, packet, busy, onOpen }) {
  const photos = form?.body.completionPhotos?.length || 0;
  let status = 'Form needed';
  if (form) status = OUTCOMES[form.body.visitOutcome] || 'Form ready';
  else if (packet) status = 'Service record saved';
  return (
    <section className="rounded-sm border border-hairline border-zinc-200 p-4">
      <div className="flex items-start gap-3">
        {form || packet ? <CheckCircle2 size={22} className="shrink-0 text-zinc-700" /> : <ClipboardList size={22} className="shrink-0 text-zinc-500" />}
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-medium">{service.serviceType}</h3>
          <p className="mt-1 text-sm text-zinc-600">{status}</p>
          {photos > 0 && <p className="mt-1 text-sm text-zinc-600">{photos} {photos === 1 ? 'photo' : 'photos'} saved</p>}
          {!packet && <Button variant="secondary" className="mt-3 text-sm" disabled={busy} onClick={onOpen}>{form ? 'Edit form' : 'Open form'}</Button>}
        </div>
      </div>
    </section>
  );
}

// What the stop says about itself under the member cards.
function CloseoutNotes({ visit, packet, state, result, prepared, total, busy, onRevoke, children }) {
  const finished = isFinishedState(state);
  const officeReview = isOfficeReviewState(state);
  let intro = 'Review each service form, then close out the visit once. Only eligible completed work is included in the shared invoice.';
  if (officeReview) intro = 'The service records are saved. The office must review this closeout before the remaining work can finish.';
  else if (packet) intro = 'The service records are saved. Any remaining invoice, payment, or report delivery continues from this closeout.';
  return (
    <>
      <p className="text-zinc-600">{intro}</p>
      {children}
      {!packet && <p className="text-sm text-zinc-600" role="status">{prepared} of {total} forms ready. Saved forms and photos stay on this device until the visit is recorded.</p>}
      {packet && !finished && <p role="status" className="rounded-sm bg-zinc-100 p-4">Records saved. Closeout is still processing; you can safely resume it.</p>}
      {finished && <p role="status" className={`rounded-sm border p-4 ${officeReview ? 'border-alert-fg text-alert-fg' : 'border-zinc-200 bg-zinc-50'}`}>{officeReview ? 'Visit recorded. The office has an alert to review the service closeout, billing, or delivery.' : 'Visit closeout is complete.'}</p>}
      {paymentLine(result) && <p className="text-sm text-zinc-600">{paymentLine(result)}</p>}
      {visit.summaryRevoked && <p className="text-sm text-zinc-600">The shared summary link has been revoked.</p>}
      {visit.canRevokeSummary && <Button variant="secondary" className="text-sm" disabled={busy} onClick={onRevoke}>Revoke shared summary link</Button>}
    </>
  );
}

export default function VisitCloseoutSheet({ visitId, products, operatorId, onClose, onSaved }) {
  const scope = operatorScope(operatorId);
  const load = useCloseoutLoad(visitId, scope);
  const [editing, setEditing] = useState(null);
  const { visit, services, draft, error, setDraft, setError } = load;
  const send = useCloseoutSend({ visitId, scope, load, setEditing, onSaved });
  const packet = visit?.packet;
  const state = packetDisplayState({ result: send.result, detail: visit });
  const finished = isFinishedState(state);
  const formOf = (service) => (draft?.forms?.[service.id]?.body ? draft.forms[service.id] : null);

  async function prepare(serviceId, body, formDraft) {
    const next = { ...draft, forms: { ...draft.forms, [serviceId]: { body, draft: formDraft } } };
    if (!await putVisitCompletionDraft(visitId, next, scope)) {
      throw new Error('Could not save this form and its photos on this device. Free some storage and try again.');
    }
    setDraft(next);
    setEditing(null);
    setError('');
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
        {!visit && error && <Button className="text-sm" onClick={load.retry}>Try again</Button>}
        {visit && <>
          <CloseoutNotes visit={visit} packet={packet} state={state} result={send.result} prepared={services.filter(formOf).length} total={services.length} busy={send.busy} onRevoke={send.revokeSummary}>
            <div className="space-y-3">
              {services.map((service) => <MemberCard key={service.id} service={service} form={formOf(service)} packet={packet} busy={send.busy} onOpen={() => setEditing(service)} />)}
            </div>
          </CloseoutNotes>
        </>}
      </SheetBody>
      <SheetFooter>
        <Button variant="secondary" className="text-sm" onClick={onClose}>{finished ? 'Done' : 'Close'}</Button>
        {visit && !finished && <Button className="text-sm" disabled={send.busy || (!packet && !send.ready)} onClick={() => send.submit()}>{send.busy ? 'Saving visit…' : packet ? 'Resume closeout' : 'Complete visit'}</Button>}
      </SheetFooter>
    </Sheet>
  );
}
