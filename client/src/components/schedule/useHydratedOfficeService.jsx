// GATE_DAY_ONLY_PROMISE part E: the office fields of a visit row (`customerAskedTime`, `told`, `reminder24hOn`).
// The day, week and list feeds stamp them on every row (server attachOfficeToldFields). A row from anywhere else (the month
// view, a customer page, any other payload) has none, and an editor that opened on such a row would start the "Customer asked
// for this time" box unchecked and send `customerAskedTime: false` over the customer's choice. This hook reads the fields for
// that one visit (GET /admin/schedule/:id/visit-summary, the read Edit appointment already makes on open) and hands back the
// row with them merged in. Gate off, or a row that already carries them: the row itself, no request.
import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

/** True when this row needs the read: gate on and no office fields on it (`customerAskedTime` is set on every stamped row). */
export function needsOfficeFields(service, enabled) {
  return enabled === true && !!service && !!service.id && service.customerAskedTime === undefined;
}

/**
 * `block`: the editor must not open before the fields arrive (a moving save would otherwise send the box's default over the
 * stored choice), so the hook returns null until they do. Without `block` (the read-only visit sheet) the row shows at once
 * and the fields merge in when they arrive. A failed read counts as arrived with the choice unknown (box unchecked, hint
 * "Tell the customer this time.", no badge): the same fallback a row from a feed with a failed read gets.
 */
export function useHydratedOfficeService(service, { enabled, block }) {
  const needs = needsOfficeFields(service, enabled);
  const id = service ? service.id : null;
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (!needs) return undefined;
    let cancelled = false;
    const done = (office) => { if (!cancelled) setFetched({ id, office }); };
    adminFetch(`/admin/schedule/${id}/visit-summary`)
      .then((r) => r.json())
      .then((data) => done({ customerAskedTime: null, ...(data && data.office) }))
      .catch(() => done({ customerAskedTime: null }));
    return () => { cancelled = true; };
  }, [needs, id]);
  if (!needs) return service;
  if (fetched && fetched.id === id) return { ...service, ...fetched.office };
  return block ? null : service;
}

/**
 * Wraps an office editor or sheet so it opens on a row WITH the office fields: `withOfficeFields(Component, { block })`.
 * Gate off (flag `day_only_promise`), a technician's sheet (`adminActions === false`: the read is office-only) or a row that
 * already carries the fields: the component renders at once, untouched.
 */
export function withOfficeFields(Component, { block }) {
  function WithOfficeFields({ service, ...rest }) {
    const flag = useFeatureFlag('day_only_promise');
    const hydrated = useHydratedOfficeService(service, { enabled: flag && rest.adminActions !== false, block });
    return hydrated ? <Component service={hydrated} {...rest} /> : null;
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
