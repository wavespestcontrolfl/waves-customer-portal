// Guard logic for the Send-form phone lookup in EstimateToolViewV2.
//
// The lookup auto-fills customerName/customerEmail from a customer-record
// match on the typed phone number. These rules keep it from swapping the
// recipient out from under the operator:
//  - only a COMPLETE 10-digit number may fire a lookup (a 7-digit prefix
//    can match a same-exchange stranger, and the quote goes to their email);
//  - a field is only auto-filled while the operator does not "own" it — it
//    is empty or still holds exactly what the previous auto-fill wrote
//    (tracked in lastAutoFill). A prefilled lead email or a hand-edited
//    name is never clobbered;
//  - an owned field tracks the lookup result SYMMETRICALLY — fill, replace,
//    or clear. Pass match=null on a lookup miss: leaving the previous
//    match's name/email owned-in-place would pair them with the new number
//    (same for a new match with no email, or a company-only row with blank
//    names — the stale half must clear, not linger).

export function normalizePhoneDigits(value) {
  let raw = String(value || "").replace(/\D/g, "");
  if (raw.length === 11 && raw.startsWith("1")) raw = raw.slice(1);
  return raw.slice(0, 10);
}

export function mergePhoneLookupMatch(form, match, lastAutoFill = {}) {
  const matchName = `${match?.firstName || ""} ${match?.lastName || ""}`.trim();
  const matchEmail = String(match?.email || "").trim();
  const owned = (current, lastAuto) =>
    !String(current || "").trim() || current === lastAuto;

  const updates = {};
  const autoFill = { ...lastAutoFill };
  if (owned(form?.customerName, lastAutoFill.name)) {
    if ((form?.customerName || "") !== matchName) updates.customerName = matchName;
    autoFill.name = matchName;
  }
  if (owned(form?.customerEmail, lastAutoFill.email)) {
    if ((form?.customerEmail || "") !== matchEmail) updates.customerEmail = matchEmail;
    autoFill.email = matchEmail;
  }
  return { updates, autoFill, changed: Object.keys(updates).length > 0 };
}
