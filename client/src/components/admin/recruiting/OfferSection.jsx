import React, { useState } from "react";
import { ActionFeedback, Button } from "../../ui";
import { fetchSignedCopy } from "./offerApi";
import OfferTimeline, { History, SignedCopyView } from "./OfferTimeline";
import { offerErrorMessage, shownOffer } from "./offerLogic";

// The offer part of the application detail. Renders nothing while the flow is
// off (today's status-only behavior); a failed read shows an error with Retry
// and no Offer move. onChanged re-reads the offer and the application after
// any card action, a refused one included: a signature or a close moves the stage.
// Statuses that leave something to act on: a draft to finish, or an offer that is out.
const LIVE_STATES = ["draft", "sent", "date_requested"];

export default function OfferSection({ detail, offerFlow, onChanged }) {
  const { enabled, data, openForm, error: readError, refreshError, ownerActions, retry } = offerFlow;
  const [signed, setSigned] = useState(null);
  const [error, setError] = useState(null);
  if (detail.role !== "technician") return null;
  if (readError) {
    return (
      <ActionFeedback error className="mb-4" onRetry={retry}>
        {readError}
      </ActionFeedback>
    );
  }
  if (!enabled || !data) return null;
  const firstName = String(detail.contact_snapshot?.name || "the applicant").trim().split(/\s+/)[0];
  const history = Array.isArray(data.history) ? data.history : [];
  // A new offer is allowed while the application is in Offer and nothing is out
  // or in draft: no offer yet, or the last one was withdrawn, closed unsigned,
  // declined, or signed before the application was moved back to Offer.
  const current = shownOffer(data.current);
  const stillInOffer = detail.status === "offer";
  const canMakeOffer = stillInOffer && !refreshError && !data.draft && !(current && LIVE_STATES.includes(current.status));
  const stale = refreshError ? (
    <ActionFeedback error className="mb-3" onRetry={retry}>
      {refreshError}
    </ActionFeedback>
  ) : null;
  if (current) {
    return (
      <>
        {stale}
      <OfferTimeline
        key={detail.id}
        applicationId={detail.id}
        ownerActions={ownerActions}
        refreshError={refreshError}
        firstName={firstName}
        offer={current}
        draft={data.draft || null}
        history={history}
        canMakeOffer={canMakeOffer}
        onMakeOffer={() => openForm(null, detail.id)}
        onChanged={onChanged}
        onOpenDraft={(draft) => openForm(draft, detail.id)}
        onEdit={() => openForm(data.current, detail.id)}
      />
      </>
    );
  }
  const viewSigned = async (offer) => {
    try {
      setError(null);
      setSigned(await fetchSignedCopy(detail.id, offer.id));
    } catch (err) {
      setError(offerErrorMessage(err));
    }
  }
  return (
    <div className="mb-4">
      {stale}
      {canMakeOffer && (
        <Button size="sm" variant="secondary" onClick={() => openForm(null, detail.id)}>
          Make an offer
        </Button>
      )}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <History history={history} onViewSigned={viewSigned} />
      <SignedCopyView copy={signed} onClose={() => setSigned(null)} />
    </div>
  );
}
