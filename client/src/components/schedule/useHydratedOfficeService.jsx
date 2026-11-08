// GATE_DAY_ONLY_PROMISE part E: the office fields of a visit row (`customerAskedTime`, `told`, `reminder24hOn`).
// The day, week and list feeds stamp them on every row (server attachOfficeToldFields). A row from anywhere else (the month
// view, a customer page, any other payload) has none, and an editor that opened on such a row would start the "Customer asked
// for this time" box unchecked and send `customerAskedTime: false` over the customer's choice. This hook reads the fields for
// that one visit (GET /admin/schedule/:id/visit-summary, the read Edit appointment already makes on open) and hands back the
// row with them merged in. A read that stays UNKNOWN after one retry (failed, non-OK, no `office`, no stored choice) never opens
// an editor on a default: a failed-load panel with Try again opens instead. Gate off, or a row that already carries them: the row
// itself, no request.
import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { Button, Dialog, DialogBody, DialogFooter } from '../ui';

/** True when this row needs the read: gate on and no office fields on it (`customerAskedTime` is set on every stamped row). */
export function needsOfficeFields(service, enabled) {
  return enabled === true && !!service && !!service.id && service.customerAskedTime === undefined;
}

// One read of the visit's office fields, or null when the answer cannot be trusted. A real "no recorded choice" is an answer
// (`office.customerAskedTime === null`); a failed request, a non-OK reply, a reply without `office` and an `office` without the
// stored choice are all UNKNOWN. Tried twice: a transient failure should not close an editor.
const KNOWN_ATTEMPTS = 2;
async function readOfficeFields(id) {
  for (let attempt = 0; attempt < KNOWN_ATTEMPTS; attempt += 1) {
    try {
      const r = await adminFetch(`/admin/schedule/${id}/visit-summary`);
      const data = r.ok ? await r.json() : null;
      if (data && data.office && data.office.customerAskedTime !== undefined) return data.office;
    } catch { /* tried again, then unknown */ }
  }
  return null;
}

/**
 * The visit's office fields: { status, service, retry }. status 'ready' = the row (with the fields merged in when it had none),
 * 'loading' = the read is out, 'failed' = still UNKNOWN after the retry (the row without fields: a moving save from it would
 * send the box's default over the stored choice, so an editor must not open on it). Gate off, or a row that already carries
 * the fields: 'ready' with the row itself and no request.
 */
export function useOfficeFields(service, enabled) {
  const needs = needsOfficeFields(service, enabled);
  const id = service ? service.id : null;
  const [fetched, setFetched] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needs) return undefined;
    let cancelled = false;
    readOfficeFields(id).then((office) => { if (!cancelled) setFetched({ id, office, attempt }); });
    return () => { cancelled = true; };
  }, [needs, id, attempt]);
  const retry = () => { setFetched(null); setAttempt((n) => n + 1); };
  if (!needs) return { status: 'ready', service, retry };
  if (!fetched || fetched.id !== id || fetched.attempt !== attempt) return { status: 'loading', service, retry };
  if (!fetched.office) return { status: 'failed', service, retry };
  return { status: 'ready', service: { ...service, ...fetched.office }, retry };
}

/**
 * `block`: the editor must not open before the fields arrive (a moving save would otherwise send the box's default over the
 * stored choice), so the hook returns null until they do, and while they stay unknown. Without `block` (the read-only visit
 * sheet) the row shows at once and the fields merge in when they arrive; if they never do, it keeps showing without them.
 */
export function useHydratedOfficeService(service, { enabled, block }) {
  const { status, service: merged } = useOfficeFields(service, enabled);
  if (status === 'ready') return merged;
  return block ? null : service;
}

// The failed-load panel of an editor that would not open: the same words and the same "Try again" the reschedule window uses
// for its suggested dates ("Could not load suggested dates. You can try again..."). Nothing about a promise.
function OfficeFieldsFailed({ onRetry, onClose }) {
  return (
    <Dialog open onClose={onClose} layer={1000} aria-label="Appointment could not be loaded">
      <DialogBody>
        <div role="alert" className="space-y-2">
          <p className="text-ui-body">Could not load this appointment. You can try again.</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={onRetry}>Try again</Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Wraps an office editor or sheet so it opens on a row WITH the office fields: `withOfficeFields(Component, { block })`.
 * Gate off (flag `day_only_promise`), a technician's sheet (`adminActions === false`: the read is office-only) or a row that
 * already carries the fields: the component renders at once, untouched. An editor (`block`) whose read stays unknown after the
 * retry does not open: it shows OfficeFieldsFailed with Try again and Close.
 */
export function withOfficeFields(Component, { block }) {
  function WithOfficeFields({ service, ...rest }) {
    const flag = useFeatureFlag('day_only_promise');
    const { status, service: merged, retry } = useOfficeFields(service, flag && rest.adminActions !== false);
    if (status === 'ready') return <Component service={merged} {...rest} />;
    if (!block) return <Component service={service} {...rest} />;
    return status === 'failed' ? <OfficeFieldsFailed onRetry={retry} onClose={rest.onClose} /> : null;
  }
  return WithOfficeFields;
}

/**
 * The 24-hour-reminder answer the Edit appointment window's phone-script hint should use. `service.reminder24hOn` is the answer
 * for the visit's CURRENT property; when staff pick a different address (`selectedPropertyId`, empty = unchanged) the visit's
 * texts follow THAT property, so the answer comes from the customer's schedule-estimates reply, the same one the booking
 * window reads: that property's own answer while property texts are enforced, else the customer row's. Until the reply is in
 * (or if it fails) the answer is unknown (undefined), which the hint reads as "will not go out". Gate off, or no address
 * change: the row's own answer and no request.
 */
export function usePropertyReminderAnswer(service, selectedPropertyId, enabled) {
  const customerId = service ? service.customerId : null;
  const changed = enabled === true && !!selectedPropertyId && !!customerId && String(selectedPropertyId) !== String(service.propertyId || '');
  const [reply, setReply] = useState(null);
  useEffect(() => {
    if (!changed) return undefined;
    let cancelled = false;
    adminFetch(`/admin/customers/${customerId}/schedule-estimates`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setReply({ customerId, data }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [changed, customerId]);
  if (!changed) return service ? service.reminder24hOn : undefined;
  if (!reply || reply.customerId !== customerId) return undefined;
  const own = reply.data && reply.data.reminder24hByProperty ? reply.data.reminder24hByProperty[selectedPropertyId] : undefined;
  return own === undefined ? (reply.data ? reply.data.reminder24hOn : undefined) : own;
}
