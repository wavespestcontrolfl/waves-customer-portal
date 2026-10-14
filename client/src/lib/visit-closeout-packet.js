// client/src/lib/visit-closeout-packet.js
//
// The visit-closeout packet's client half, shared by the long closeout form (VisitCloseoutSheet) and the one-screen
// pest + lawn container (FastCompleteComboSheet): the load of a stop and its saved draft, the request that records the
// whole stop once (POST /admin/visit-closeouts/:visitId with { items: [{ serviceId, body }] } and an Idempotency-Key),
// the three confirm prompts a refused packet can ask for, and the re-read after a lost response. One copy, so the two
// surfaces cannot drift.
import { adminFetch } from '../utils/admin-fetch';
import { deleteCompletionDraft, deleteVisitCompletionDraft, getVisitCompletionDraft, putVisitCompletionDraft } from './completion-resume-store';
import { completionDraftKey } from './completion-drafts';
import { getAdminUser } from './adminAuth';
import { completionPromiseMarksPrompt, completionReconcilePrompt, completionReportRulesPrompt, createCompletionIdempotencyKey } from '../pages/admin/SchedulePage';

// The server classifies retained history from canonical service records.
export const liveMembers = (detail) => detail.members.filter((member) => member.requiresForm === true);

// The operator a visit's saved forms belong to: the verified operator the page passes, and only without one the cached
// profile. The ONE scope function: the long form, the one-screen container and the Fast Complete sheets' own drafts
// key on the same id, so a shared device never shows one technician another's unsent forms.
export function operatorScope(verifiedId) {
  if (verifiedId) return String(verifiedId);
  const id = getAdminUser()?.id;
  return id ? String(id) : '';
}

export function rowsForDetail(detail, day, visitId) {
  const rows = liveMembers(detail).map((member) => (day.services || []).find((service) => service.id === member.id));
  if (rows.some((row) => !row || row.visitId !== visitId)) {
    throw new Error('The service list changed. Refresh the schedule before closing this visit.');
  }
  return rows;
}

export function draftForServices(stored, visitId, services) {
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

// The one-screen container saves its forms under its own key, so it never reads or overwrites the long form's draft of
// the same stop (and the long form never restores the container's).
export const comboDraftId = (visitId) => `combo:${visitId}`;

// (The delete calls resolve false on a failed delete instead of rejecting; a finished stop's leftover draft is cleared
// again by the next load, so a failure here is left for that.)
export async function clearTerminalDrafts(visitId, members, scope) {
  const serviceIds = [...new Set((members || []).map((member) => member?.id).filter(Boolean))];
  await Promise.all([
    deleteVisitCompletionDraft(visitId, scope),
    deleteVisitCompletionDraft(comboDraftId(visitId), scope),
    ...serviceIds.map((serviceId) => deleteCompletionDraft(serviceId, scope)),
  ]);
  serviceIds.forEach((serviceId) => removeCompletionMetadata(serviceId, scope));
}

// A stop and its saved draft: { detail, rows, draft, terminal }. A packet already finished clears the old draft.
export async function loadVisitCloseout(visitId, scope, draftId = visitId) {
  const [detail, stored] = await Promise.all([
    adminFetch(`/admin/visit-closeouts/${visitId}`),
    getVisitCompletionDraft(draftId, scope),
  ]);
  // A lost final response can leave a draft after the server finished.
  const terminal = ['done', 'failed'].includes(detail.packet?.status);
  if (terminal) await clearTerminalDrafts(visitId, detail.members, scope);
  const day = await adminFetch(`/admin/schedule?date=${encodeURIComponent(detail.serviceDate)}`);
  const rows = rowsForDetail(detail, day, visitId);
  return { detail, rows, draft: draftForServices(terminal ? null : stored, visitId, rows) };
}

// Saves the draft (first send only) and records the stop: the same request, the same key, every time.
export async function postVisitPacket({ visitId, packet, draft, services, scope, draftId = visitId }) {
  if (!packet && !await putVisitCompletionDraft(draftId, draft, scope)) throw new Error('Could not preserve these forms for retry. Please try again.');
  return adminFetch(`/admin/visit-closeouts/${visitId}${packet ? '/resume' : ''}`, {
    method: 'POST',
    headers: { 'Idempotency-Key': draft.key },
    body: JSON.stringify(packet ? {} : { items: services.map((service) => ({ serviceId: service.id, body: draft.forms[service.id].body })) }),
  });
}

// The confirm flag each refusal asks for, and the prompt text that goes with it.
// (Read when needed, never at import: pages that mock the schedule page keep importing this module.)
const confirms = () => [
  { flag: 'reportReconcileConfirmed', prompt: completionReconcilePrompt },
  { flag: 'reportRulesConfirmed', prompt: completionReportRulesPrompt },
  { flag: 'promiseMarksConfirmed', prompt: completionPromiseMarksPrompt },
];

/**
 * What a refused first send may do before it is an error: the three confirm prompts. Returns
 *   { resend: draft }     the tech confirmed: send again with that member's confirm flag set (same key),
 *   { reopened, message } the tech declined a changed promise: that member's form is put back to be marked again,
 *   { declined: true }    the tech declined another prompt: nothing is sent and nothing is shown (the form stays as it is),
 *   null                  not a prompt (or already confirmed): the caller shows the error.
 * `ask` (window.confirm) is injectable for tests.
 */
export async function packetConfirm({ err, candidate, packet, visitId, scope, draftId = visitId, ask = (text) => window.confirm(text) }) {
  const form = candidate.forms[err.details?.serviceId];
  if (packet || !form) return null;
  const withFlag = (flag) => ({ ...candidate, forms: { ...candidate.forms, [err.details.serviceId]: {
    ...form, body: { ...form.body, [flag]: true },
  } } });
  for (const { flag, prompt } of confirms()) {
    const text = !form.body[flag] ? prompt(err) : null;
    if (!text) continue;
    if (ask(text)) return { resend: withFlag(flag) };
    // A promise changed after the report was written: declining puts that form back to be marked again.
    if (flag !== 'promiseMarksConfirmed') return { declined: true };
    const reopened = { ...candidate, forms: { ...candidate.forms, [err.details.serviceId]: { ...form, body: null } } };
    // (Resolves false on a failed write: the caller's own state is authoritative and writes the draft again.)
    await putVisitCompletionDraft(draftId, reopened, scope);
    return { reopened, message: 'A promise changed. Open that service again to mark it, then complete the visit.' };
  }
  return null;
}

/**
 * After a send that did not return: an HTTP timeout does not mean the transaction failed, so ask the server what it
 * has. Clears the draft when the packet is finished; when the stop's members changed before any packet, re-reads the
 * day and refreshes the draft. Returns { detail, finished, refreshed } (refreshed = { rows, draft } or null). Throws
 * when the server cannot be read: the caller keeps the same key and body for a later retry.
 */
export async function rediscoverCloseout({ visitId, candidate, err, scope, draftId = visitId }) {
  const detail = await adminFetch(`/admin/visit-closeouts/${visitId}`);
  const finished = ['done', 'failed'].includes(detail.packet?.status);
  if (finished) await clearTerminalDrafts(visitId, detail.members, scope);
  let refreshed = null;
  if (err.code === 'visit_members_changed' && !detail.packet) {
    const day = await adminFetch(`/admin/schedule?date=${encodeURIComponent(detail.serviceDate)}`);
    const rows = rowsForDetail(detail, day, visitId);
    const draft = draftForServices(candidate, visitId, rows);
    // A write that fails (it resolves false) is as good as a failed read: the caller keeps the same key and bodies.
    if (!await putVisitCompletionDraft(draftId, draft, scope)) throw new Error('Could not save the refreshed forms on this device.');
    refreshed = { rows, draft };
  }
  return { detail, finished, refreshed };
}

// The payment line under a recorded stop (null before the packet answers with one).
const PAYMENT_LABELS = {
  paid: 'Paid', prepaid: 'Prepaid', no_charge: 'No charge', payment_needed: 'Invoice queued for delivery',
  payment_failed: 'Card declined; invoice queued for delivery', payment_pending: 'Awaiting confirmation',
  processing: 'Awaiting confirmation', office_required: 'Office review',
};
export const paymentLine = (result) => (result?.payment ? `Payment: ${PAYMENT_LABELS[result.payment.state] || 'Recorded'}.` : null);

// What the stop is doing, from the last send's answer and the server's packet. One rule for the long form and the
// one-screen container. Precedence: a send's own answer, else the packet the server reports (a rediscovered finished
// packet clears the earlier answer, see resolveSendFailure's `found`); a finished packet is done, office review (a closed
// stop held for billing or delivery review, `packet.officeReview`) or failed; otherwise busy, else a started packet is
// pending its resume, else idle.
export function packetDisplayState({ result, detail, busy = false }) {
  const packet = detail?.packet;
  if (result?.state === 'done') return 'done';
  if (result?.state === 'office_required') return 'office_review';
  if (!result && packet?.status === 'failed') return 'failed';
  if (!result && packet?.status === 'done') return packet.officeReview ? 'office_review' : 'done';
  if (busy) return 'busy';
  return result || packet ? 'pending_resume' : 'idle';
}
export const isFinishedState = (state) => ['done', 'office_review', 'failed'].includes(state);
export const isOfficeReviewState = (state) => ['office_review', 'failed'].includes(state);

// The packet the stop holds after a send answered: the long form's own record of it.
export const packetAfterSend = (response) => ({
  id: response.packetId,
  status: ['done', 'office_required'].includes(response.state) ? 'done' : 'processing',
});

/**
 * Everything a refused or lost first send decides, for both sheets to apply the same way (the prompts, a lost response,
 * a changed member list). Returns
 *   { kind: 'resend', draft }              send again with the confirm flag (same key),
 *   { kind: 'reopened', draft, message }   a declined promise: that member's form is put back,
 *   { kind: 'declined' }                   a declined prompt: nothing changes,
 *   { kind: 'error', error, found, reload } the words to show; `found` ({ detail, finished, refreshed }) when the server
 *                                           was re-read (the earlier answer is then void: clear it); `reload` when the
 *                                           member list changed and could not be re-read.
 */
export async function resolveSendFailure({ err, candidate, packet, visitId, scope, draftId = visitId }) {
  const confirm = await packetConfirm({ err, candidate, packet, visitId, scope, draftId });
  if (confirm?.resend) return { kind: 'resend', draft: confirm.resend };
  if (confirm?.reopened) return { kind: 'reopened', draft: confirm.reopened, message: confirm.message };
  if (confirm) return { kind: 'declined' };
  let found = null;
  try { found = await rediscoverCloseout({ visitId, candidate, err, scope, draftId }); } catch { /* the same key and bodies stay saved for a later retry */ }
  let error = packetErrorMessage(err);
  if (found?.finished) error = '';
  if (found?.refreshed) error = 'The service list changed. Review the refreshed services before trying again.';
  return { kind: 'error', error, found, reload: !found && err.code === 'visit_members_changed' };
}

// The tech-facing words for a failed send that is not a prompt.
export function packetErrorMessage(err) {
  return err.name === 'TypeError'
    ? 'Connection interrupted. Your forms are saved. Resume this closeout when you reconnect.'
    : err.message || 'Could not finish the closeout. Your forms are saved on this device.';
}
