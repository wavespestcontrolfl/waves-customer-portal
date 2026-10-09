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

export function operatorScope() {
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

export async function clearTerminalDrafts(visitId, members, scope) {
  const serviceIds = [...new Set((members || []).map((member) => member?.id).filter(Boolean))];
  await Promise.all([
    deleteVisitCompletionDraft(visitId, scope),
    ...serviceIds.map((serviceId) => deleteCompletionDraft(serviceId, scope)),
  ]);
  serviceIds.forEach((serviceId) => removeCompletionMetadata(serviceId, scope));
}

// A stop and its saved draft: { detail, rows, draft, terminal }. A packet already finished clears the old draft.
export async function loadVisitCloseout(visitId, scope) {
  const [detail, stored] = await Promise.all([
    adminFetch(`/admin/visit-closeouts/${visitId}`),
    getVisitCompletionDraft(visitId, scope),
  ]);
  // A lost final response can leave a draft after the server finished.
  const terminal = ['done', 'failed'].includes(detail.packet?.status);
  if (terminal) await clearTerminalDrafts(visitId, detail.members, scope);
  const day = await adminFetch(`/admin/schedule?date=${encodeURIComponent(detail.serviceDate)}`);
  const rows = rowsForDetail(detail, day, visitId);
  return { detail, rows, draft: draftForServices(terminal ? null : stored, visitId, rows) };
}

// Saves the draft (first send only) and records the stop: the same request, the same key, every time.
export async function postVisitPacket({ visitId, packet, draft, services, scope }) {
  if (!packet && !await putVisitCompletionDraft(visitId, draft, scope)) throw new Error('Could not preserve these forms for retry. Please try again.');
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
export async function packetConfirm({ err, candidate, packet, visitId, scope, ask = (text) => window.confirm(text) }) {
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
    await putVisitCompletionDraft(visitId, reopened, scope);
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
export async function rediscoverCloseout({ visitId, candidate, err, scope }) {
  const detail = await adminFetch(`/admin/visit-closeouts/${visitId}`);
  const finished = ['done', 'failed'].includes(detail.packet?.status);
  if (finished) await clearTerminalDrafts(visitId, detail.members, scope);
  let refreshed = null;
  if (err.code === 'visit_members_changed' && !detail.packet) {
    const day = await adminFetch(`/admin/schedule?date=${encodeURIComponent(detail.serviceDate)}`);
    const rows = rowsForDetail(detail, day, visitId);
    const draft = draftForServices(candidate, visitId, rows);
    await putVisitCompletionDraft(visitId, draft, scope);
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

// The tech-facing words for a failed send that is not a prompt.
export function packetErrorMessage(err) {
  return err.name === 'TypeError'
    ? 'Connection interrupted. Your forms are saved. Resume this closeout when you reconnect.'
    : err.message || 'Could not finish the closeout. Your forms are saved on this device.';
}
