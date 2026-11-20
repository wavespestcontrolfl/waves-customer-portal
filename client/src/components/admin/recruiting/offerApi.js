/**
 * Offer API for the Recruiting screens (server/routes/admin-careers.js,
 * /api/admin/careers/:id/offer...). GATE_JOB_OFFERS off: every call answers
 * 404 { enabled: false }; fetchOffer turns that into { enabled: false } so
 * the page keeps today's status-only Offer button.
 */
import { adminFetch } from "../../../lib/adminFetch";
import { isGateOffAnswer } from "./offerLogic";

// Every offer answer is JSON, and a call that uses its answer names what that answer must carry (`accepts`). A
// success whose body cannot be read, or does not carry it, says nothing sure about what the server did, so it throws
// with its status like a failure: a write takes its lost-answer path (isLostAnswer: re-read before it is offered
// again) and a read shows that it failed. It never passes as a success.
async function offerRequest(path, options = {}, accepts = () => true) {
  const r = await adminFetch(path, options);
  let body = null;
  let read = true;
  try {
    body = await r.json();
  } catch {
    read = false;
  }
  if (!r.ok || !read || !accepts(body)) {
    const err = new Error(r.ok ? "The answer could not be read. Try again." : body?.error || body?.message || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

// An open draft as a save or a Revise answers it.
const isDraft = (offer) => offer?.status === "draft" && Boolean(offer.id);

// Only a 404 whose body says enabled:false means the flow is off. Any other
// failure, or a 200 that is not { enabled: true }, throws.
export async function fetchOffer(applicationId) {
  try {
    const body = await offerRequest(`/admin/careers/${applicationId}/offer`);
    if (body?.enabled !== true) throw new Error("The offer screen sent an unexpected answer.");
    return body;
  } catch (err) {
    if (isGateOffAnswer(err)) return { enabled: false };
    throw err;
  }
}

// The answer is the draft this save wrote: open, with the hash a later write names it by, and the very draft the
// save named, when it named one.
export function saveOfferDraft(applicationId, fields) {
  return offerRequest(
    `/admin/careers/${applicationId}/offer`,
    { method: "POST", body: JSON.stringify(fields) },
    (b) => isDraft(b?.offer) && Boolean(b.offer.draftHash) && (!fields.draftId || b.offer.id === fields.draftId),
  );
}

// draftHash = the hash of the draft whose letter preview the owner read.
// expectedOut = that read's outStamp: the offers out then (an answer or a date
// request since then refuses the send with OFFERS_CHANGED).
// The answer is the offer this send sent, read after delivery (it can already be
// withdrawn or replaced, never still a draft), and what each channel did.
export function sendOffer(applicationId, offerId, draftHash, expectedOut) {
  return offerRequest(
    `/admin/careers/${applicationId}/offer/${offerId}/send`,
    { method: "POST", body: JSON.stringify({ draftHash, expectedOut }) },
    (b) => b?.offer?.id === offerId && typeof b.offer.status === "string" && b.offer.status !== "draft" && typeof b.comms === "object" && b.comms !== null,
  );
}

// Every write names the state the owner saw when the action started:
// withdraw { expectedStatus, draftHash? (a draft needs it) }, revise { expectedStatus, startDate? }.
export function withdrawOffer(applicationId, offerId, expected) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/withdraw`, {
    method: "POST",
    body: JSON.stringify(expected),
  });
}

// The answer is the new draft.
export function reviseOffer(applicationId, offerId, expectedStatus, startDate) {
  return offerRequest(
    `/admin/careers/${applicationId}/offer/${offerId}/revise`,
    { method: "POST", body: JSON.stringify(startDate ? { expectedStatus, startDate } : { expectedStatus }) },
    (b) => isDraft(b?.offer),
  );
}

export function fetchSignedCopy(applicationId, offerId) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/signed-copy`, {}, (b) => typeof b?.markdown === "string");
}
