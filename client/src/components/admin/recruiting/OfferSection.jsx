import React, { useState } from "react";
import { ActionFeedback, Button } from "../../ui";
import { fetchSignedCopy } from "./offerApi";
import OfferTimeline, { History, SignedCopyView } from "./OfferTimeline";
import { offerErrorMessage } from "./offerLogic";

// The offer part of the application detail. Nothing renders while the
// offer flow is off for this application (today's status-only behavior).
export default function OfferSection({ detail, offerFlow }) {
  const { enabled, data, openForm, reload } = offerFlow;
  const [signed, setSigned] = useState(null);
  const [error, setError] = useState(null);
  if (!enabled || !data) return null;
  const firstName = String(detail.contact_snapshot?.name || "the applicant").trim().split(/\s+/)[0];
  const history = Array.isArray(data.history) ? data.history : [];
  if (data.current) {
    return (
      <OfferTimeline
        applicationId={detail.id}
        firstName={firstName}
        offer={data.current}
        history={history}
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
  };
  return (
    <div className="mb-4">
      {detail.status === "offer" && detail.role === "technician" && (
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
