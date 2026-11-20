import React, { useState } from "react";
import { ActionFeedback, Button } from "../../ui";
import { fetchSignedCopy } from "./offerApi";
import OfferTimeline, { History, SignedCopyView } from "./OfferTimeline";
import { firstNameOf, offerErrorMessage, shownOffer } from "./offerLogic";
import { useRenderAtExpiry } from "./useOfferFlow";

// The offer part of the application detail. Renders nothing while the flow is
// off (today's status-only behavior); a failed read shows an error with Retry
// and no Offer move. onChanged re-reads the offer and the application after
// any card action, a refused one included: a signature or a close moves the stage.
// Statuses that leave something to act on: a draft to finish, or an offer that is out.
const LIVE_STATES = ["draft", "sent", "date_requested"];

export default function OfferSection({ detail, offerFlow, onChanged, detailStale = false }) {
  const { enabled, data, openForm, error: readError, refreshError, ownerActions } = offerFlow;
  const [signed, setSigned] = useState(null);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(false); // a signed copy is loading: one read at a time (History)
  // A card left open past the offer's expiry shows it closed unsigned, and offers Make an offer, with no other read.
  useRenderAtExpiry(data);
  if (detail.role !== "technician") return null;
  // A failed first read is retried with the combined re-read too (the offer, then the application): an offer signed
  // meanwhile moves the application, and the stage must follow it.
  if (readError) {
    return (
      <ActionFeedback error className="mb-4" onRetry={onChanged}>
        {readError}
      </ActionFeedback>
    );
  }
  if (!enabled || !data) return null;
  const firstName = firstNameOf(detail.contact_snapshot?.name);
  const history = Array.isArray(data.history) ? data.history : [];
  // A new offer is allowed while the application is in Offer and nothing is out
  // or in draft: no offer yet, or the last one was withdrawn, closed unsigned,
  // declined, or signed before the application was moved back to Offer.
  const current = shownOffer(data.current);
  // The offer read returns the stage it read with the offers (applicationStatus). The application is read on its own,
  // so a signature between the two reads shows the card ahead of the stage: the page re-reads the application then,
  // and until both reads agree, a new offer waits.
  const stillInOffer = detail.status === "offer" && (data.applicationStatus ?? detail.status) === detail.status;
  // The page's last read of the offer, or of the application (detailStale: its stage
  // may be out of date), failed: every owner action waits for a read that works.
  const readFailed = Boolean(refreshError) || detailStale;
  const canMakeOffer = stillInOffer && !readFailed && !data.draft && !(current && LIVE_STATES.includes(current.status));
  // A failed re-read after an action is retried with the same combined re-read (the
  // offer, then the application), so the stage and its actions follow the offer: an
  // offer signed meanwhile moves the application too.
  const stale = refreshError ? (
    <ActionFeedback error className="mb-3" onRetry={onChanged}>
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
        stale={readFailed}
        firstName={firstName}
        offer={current}
        draft={data.draft || null}
        history={history}
        outStamp={data.outStamp}
        canMakeOffer={canMakeOffer}
        onMakeOffer={() => openForm(null, detail.id)}
        onChanged={onChanged}
        onOpenDraft={(draft, seenOut) => openForm(draft, detail.id, seenOut)}
        onEdit={() => openForm(data.current, detail.id)}
      />
      </>
    );
  }
  const viewSigned = async (offer) => {
    setReading(true);
    try {
      setError(null);
      setSigned(await fetchSignedCopy(detail.id, offer.id));
    } catch (err) {
      setError(offerErrorMessage(err));
    } finally {
      setReading(false);
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
      <History history={history} busy={reading} onViewSigned={viewSigned} />
      <SignedCopyView copy={signed} onClose={() => setSigned(null)} />
    </div>
  );
}
