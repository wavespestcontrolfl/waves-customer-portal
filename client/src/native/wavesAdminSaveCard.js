// Tap to Pay card save for a customer at the table ("Book at the Table"), the staff half.
// The Waves Admin app (ios/WavesPay) shows the secure card page to the customer in a
// separate web view that holds no staff sign-in. When the customer chooses to tap their
// card there, the app asks THIS staff page to mint the one-time save-card link under the
// staff sign-in, by calling window.wavesAdminSaveCardHandoff(args) (CustomerHandoff.swift).
//
// args: { secureToken, consentTextVersion, agreed, feeDisclosedAmount, disclosureVersion }
// Answers { deep_link } (a wavespay://save-card link the app opens), or { message } on a
// failure: the app shows that text to the customer, so it is short and plain.

import { adminFetch } from '../lib/adminFetch';
import { isWavesAdminApp } from './platform';

const PLAIN_FAILURE = 'Something went wrong. Hand the phone back and try again.';
const NOT_ON_MESSAGE = 'Saving a card with a tap is not turned on yet. Hand the phone back.';

// A server refusal text is safe to show only for the statuses the mint answers with its own
// plain text (400 consent, 409 refusals, 503 completion); anything else gets the plain line.
const SERVER_TEXT_STATUSES = new Set([400, 409, 503]);

async function mintSaveCardLink(args) {
  const { secureToken, consentTextVersion, agreed, feeDisclosedAmount, disclosureVersion } = args || {};
  let response;
  try {
    response = await adminFetch('/stripe/terminal/save-card-handoff', {
      method: 'POST',
      body: {
        secure_token: secureToken,
        consent_text_version: consentTextVersion,
        agreed: agreed === true,
        // null (nothing shown / nothing to echo) is omitted, as the typed save sends none.
        fee_disclosed_amount: feeDisclosedAmount ?? undefined,
        disclosure_version: disclosureVersion ?? undefined,
      },
    });
  } catch {
    return { message: PLAIN_FAILURE };
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    return typeof body?.deep_link === 'string' && body.deep_link ? { deep_link: body.deep_link } : { message: PLAIN_FAILURE };
  }
  if (response.status === 404) return { message: NOT_ON_MESSAGE };
  if (SERVER_TEXT_STATUSES.has(response.status) && typeof body?.error === 'string' && body.error) {
    return { message: body.error };
  }
  return { message: PLAIN_FAILURE };
}

// Defines the relay for the signed-in staff page. Returns a cleanup for sign-out and
// account switches. A no-op outside the Waves Admin app.
export function registerSaveCardRelay() {
  if (!isWavesAdminApp()) return () => {};
  window.wavesAdminSaveCardHandoff = mintSaveCardLink;
  return () => {
    // Only remove our own definition (a newer mount may have replaced it).
    if (window.wavesAdminSaveCardHandoff === mintSaveCardLink) delete window.wavesAdminSaveCardHandoff;
  };
}
