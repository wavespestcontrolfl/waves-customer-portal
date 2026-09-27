// The Billing tab's annual-prepay renewal line (Codex #4940 r2 P1).
// billing_mode stays 'annual_prepay' after the customer declines renewal, so
// the "your saved method is used at renewal" copy must give way to the
// nonrenewal line whenever /me's annualPrepay.renewalDeclined is set. A term
// still awaiting its station installation has no real end date to quote.
// Shared by the Billing tab status block and the Auto Pay card so the two
// can never disagree. `customer` is the /me customer (may be absent);
// `renewsCopy` is the caller's own undeclined wording.
export function annualPrepayRenewalLine(customer, formatEnd, renewsCopy) {
  const annualPrepay = customer?.annualPrepay;
  if (annualPrepay?.renewalDeclined !== true) return renewsCopy;
  if (annualPrepay.awaitsInstallation === true) {
    return 'Your plan won’t renew; coverage runs 12 months from your station installation.';
  }
  if (!annualPrepay.termEnd) return 'Your plan won’t renew; coverage continues through the end of your current term.';
  return `Your plan won’t renew; coverage continues through ${formatEnd(annualPrepay.termEnd)}.`;
}
