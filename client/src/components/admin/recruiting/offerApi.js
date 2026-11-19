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

export async function fetchOffer(applicationId) {
  try {
    return await offerRequest(`/admin/careers/${applicationId}/offer`);
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

export function sendOffer(applicationId, offerId) {
  return offerRequest(`/admin/careers/${applicationId}/offer/${offerId}/send`, { method: "POST" });
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
