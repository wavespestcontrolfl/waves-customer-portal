/**
 * Offer API for the Recruiting screens (server/routes/admin-careers.js,
 * /api/admin/careers/:id/offer...). GATE_JOB_OFFERS off: every call answers
 * 404 { enabled: false }; fetchOffer turns that into { enabled: false } so
 * the page keeps today's status-only Offer button.
 */
import { adminFetch } from "../../../lib/adminFetch";

async function offerRequest(path, options = {}) {
  const r = await adminFetch(path, options);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* noop */
  }
  if (!r.ok) {
    const err = new Error(body?.error || body?.message || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Only a 404 whose body says enabled:false means the flow is off. Any other
// failure, or a 200 that is not { enabled: true }, throws.
export async function fetchOffer(applicationId) {
  try {
    const body = await offerRequest(`/admin/careers/${applicationId}/offer`);
    if (body?.enabled !== true) throw new Error("The offer screen sent an unexpected answer.");
    return body;
  } catch (err) {
    if (err.status === 404 && err.body?.enabled === false) return { enabled: false };
    throw err;
  }
}

export function saveOfferDraft(applicationId, fields) {
  return offerRequest(`/admin/careers/${applicationId}/offer`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

// draftHash = the hash of the draft whose letter preview the owner read.
export function sendOffer(applicationId, offerId, draftHash) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/send`, {
    method: "POST",
    body: JSON.stringify({ draftHash }),
  });
}

export function withdrawOffer(applicationId, offerId) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/withdraw`, { method: "POST" });
}

export function reviseOffer(applicationId, offerId, startDate) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/revise`, {
    method: "POST",
    body: JSON.stringify(startDate ? { startDate } : {}),
  });
}

export function fetchSignedCopy(applicationId, offerId) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/signed-copy`);
}
