import { useState } from 'react';

/**
 * The customer-facing "add a service" card — one card for every public
 * surface that offers it (service report, invoice receipt, tracker; owner
 * 2026-11-21). The offer is composed server-side
 * (services/service-report/cross-sell.js): pest or lawn, priced for the
 * customer's own home at the WaveGuard tier they would land on.
 *
 * A PRICED offer shows its per-application price (AGENTS.md: "per
 * application" is the only unit; never a monthly or plan total). A
 * quote_cta offer (the engine could not stand behind a number) shows no
 * price and asks for an estimate.
 *
 * The tap posts the exact payload the customer saw; the server recomputes
 * and rejects any drift with a 409, which this card turns into a refresh
 * prompt. A response carrying estimateUrl (GATE_REPORT_CLICK_TO_ESTIMATE)
 * navigates into that estimate — same origin only.
 *
 * The service report's card stays price-free (owner 2026-10-05, headline
 * and button only): it passes showPrice={false} and renders its original
 * copy.
 *
 * Props:
 *   offer      — the payload's crossSell object; null → renders nothing
 *   showPrice  — false keeps the report's price-free copy
 *   submit     — async (metadata) => { ok, status, body }; the caller owns
 *                the endpoint (and any analytics beacon)
 *   className  — outer section class hook (the report passes its
 *                report-card classes)
 *   style / styles — inline overrides { heading, copy, price, button } for
 *                surfaces without the report stylesheet
 */
export function crossSellPriceLine(offer) {
  const perVisit = Number(offer?.option?.perVisit);
  if (offer?.mode !== 'priced' || !Number.isFinite(perVisit) || perVisit <= 0) return null;
  const amount = Number.isInteger(perVisit) ? String(perVisit) : perVisit.toFixed(2);
  return `$${amount} per application`;
}

export default function CrossSellOfferCard({ offer, submit, showPrice = true, className = '', dataSection = 'cross-sell', style = null, styles = {} }) {
  // idle → sending → sent | stale | failed (failed keeps the button for a
  // retry — the UI may only confirm after the server recorded the request).
  const [requestState, setRequestState] = useState('idle');
  if (!offer?.serviceKey) return null;
  const option = offer.option || {};
  const priceLine = showPrice ? crossSellPriceLine(offer) : null;
  const label = String(offer.label || '').toLowerCase();
  const handleRequest = async () => {
    if (requestState === 'sending' || requestState === 'sent') return;
    setRequestState('sending');
    const result = await submit({
      serviceKey: offer.serviceKey,
      serviceLabel: offer.label,
      optionId: option.id || null,
      perApplication: option.perVisit || null,
      offerMode: offer.mode,
      // Server-issued digest of everything this card rendered — the click
      // path rejects any drift from what the customer actually saw.
      fingerprint: offer.fingerprint || null,
    });
    // 409 = the server-recomputed offer no longer matches this render —
    // retrying the same stale payload can never succeed, so prompt a
    // refresh instead of a dead retry loop (codex #3367 PR r5).
    setRequestState(result?.ok ? 'sent' : result?.status === 409 ? 'stale' : 'failed');
    // The 'sent' confirmation stays rendered behind the navigation, so a
    // blocked redirect still shows the recorded-request copy. SAME-ORIGIN
    // only: the pages are one SPA, so a legitimate link always shares this
    // page's origin, and anything cross-origin or unparsable never navigates.
    const estimateUrl = result?.ok ? result.body?.estimateUrl : null;
    if (typeof estimateUrl === 'string' && estimateUrl) {
      try {
        const parsed = new URL(estimateUrl, window.location.origin);
        if (parsed.origin === window.location.origin) {
          window.location.assign(parsed.href);
        }
      } catch { /* unparsable URL: keep the confirmation, never navigate */ }
    }
  };
  return (
    <section data-glass="card" className={className} data-section={dataSection} style={style || undefined}>
      <h2 style={styles.heading || undefined}>
        {priceLine ? `Add ${label} to your plan` : `Want a quote for ${label}?`}
      </h2>
      {priceLine && (
        <p className="cross-sell-price" style={styles.price || undefined}>
          {`${priceLine}, priced for your home`}
        </p>
      )}
      <p className="map-context-copy" style={styles.copy || undefined}>
        {priceLine
          ? 'Tap below for your estimate. Nothing is booked or charged until you accept it.'
          : "Tap below and we'll follow up with the details. Nothing is booked or charged."}
      </p>
      <div className="cross-sell-cta-row">
        {requestState === 'sent' ? (
          <p className="cross-sell-confirm" style={styles.copy || undefined}>
            Request received — we&apos;ll confirm the details with you before anything is scheduled.
          </p>
        ) : requestState === 'stale' ? (
          <button
            type="button"
            data-glass-accent=""
            className="review-cta cross-sell-cta"
            style={styles.button || undefined}
            onClick={() => window.location.reload()}
          >
            Offer updated — refresh to see the latest
          </button>
        ) : (
          <button
            type="button"
            data-glass-accent=""
            className="review-cta cross-sell-cta"
            style={styles.button || undefined}
            disabled={requestState === 'sending'}
            onClick={handleRequest}
          >
            {requestState === 'sending' ? 'Sending…' : priceLine ? 'Get my estimate' : 'Request an Estimate'}
          </button>
        )}
      </div>
      {requestState === 'failed' && (
        <p className="cross-sell-fine cross-sell-error" style={styles.copy || undefined}>
          That didn&apos;t go through — please try again, or call (941) 297-5749.
        </p>
      )}
    </section>
  );
}
