import React, { useState } from "react";
import { ActionFeedback, Button } from "../../ui";
import { fetchSignedCopy } from "./offerApi";
import OfferTimeline, { History, SignedCopyView } from "./OfferTimeline";
import { offerErrorMessage } from "./offerLogic";

// The offer part of the application detail. Nothing renders while the
// offer flow is off for this application (today's status-only behavior).
// The offer part of the application detail. Renders nothing while the flow is
// off (today's status-only behavior); a failed read shows an error with Retry
// and no Offer move.
const REOFFER_STATES = ["withdrawn", "expired"];

export default function OfferSection({ detail, offerFlow }) {
  const { enabled, data, openForm, reload, error: readError, retry } = offerFlow;
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
  // A new offer is allowed while the application is in Offer and there is no
  // offer to act on: none yet, or the last one was withdrawn or closed unsigned.
  const stillInOffer = detail.status === "offer";
  const canMakeOffer = stillInOffer && (!data.current || REOFFER_STATES.includes(data.current.status));
  if (data.current) {
    return (
      <OfferTimeline
        applicationId={detail.id}
        firstName={firstName}
        offer={data.current}
        draft={data.draft || null}
        history={history}
        canMakeOffer={canMakeOffer}
        onMakeOffer={() => openForm()}
        onChanged={reload}
        onOpenDraft={(draft) => openForm(draft)}
        onEdit={() => openForm(data.current)}
      />
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
      {canMakeOffer && (
        <Button size="sm" variant="secondary" onClick={() => openForm()}>
          Make an offer
        </Button>
      )}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <History history={history} onViewSigned={viewSigned} />
      <SignedCopyView copy={signed} onClose={() => setSigned(null)} />
    </div>
  );
}
