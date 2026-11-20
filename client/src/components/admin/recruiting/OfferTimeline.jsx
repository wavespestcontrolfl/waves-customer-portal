/**
 * The offer card on an application's detail: where the offer stands, a
 * timeline of what happened (times in Eastern) and the owner's actions.
 * Rows stack on a phone; time sits beside the label from the sm width up.
 */
import React, { useEffect, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui";
import SafeMarkdown from "../../SafeMarkdown";
import { fetchSignedCopy, reviseOffer, withdrawOffer } from "./offerApi";
import {
  formatDay,
  formatTimelineTime,
  isGateOffAnswer,
  isLostAnswer,
  isStaleWrite,
  LOST_ANSWER_TEXT,
  money,
  offerErrorMessage,
} from "./offerLogic";

const STATUS_LABEL = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Signed",
  declined: "Declined",
  date_requested: "Asked for another date",
  expired: "Closed unsigned",
  withdrawn: "Withdrawn",
  superseded: "Replaced",
};

const CAN_REVISE = ["sent", "date_requested"];
const CAN_WITHDRAW = ["draft", "sent", "date_requested"];

function Timeline({ entries }) {
  if (!entries?.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 mb-3">
      {entries.map((e, i) => (
        <li key={`${e.kind}-${e.at}-${i}`} className="flex flex-col gap-0 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="text-14 text-zinc-800 min-w-0 break-words">{e.label}</span>
          <span className="text-14 text-zinc-500 sm:ml-auto sm:shrink-0">{formatTimelineTime(e.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Terms({ offer }) {
  const pay = [
    offer.hourlyRate != null && `${money(offer.hourlyRate)} an hour`,
    offer.stepRate != null && offer.stepEffectiveOn && `${money(offer.stepRate)} from ${formatDay(offer.stepEffectiveOn)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="text-14 text-zinc-600 mb-3">
      {offer.jobTitle} · start {formatDay(offer.startDate)}
      {pay ? ` · ${pay}` : ""}
    </div>
  );
}

export function SignedCopyView({ copy, onClose }) {
  return (
    <Dialog open={Boolean(copy)} onClose={onClose} layer={130} size="lg">
      <DialogHeader>
        <DialogTitle>Signed copy</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {copy && (
          <>
            <div className="text-14 text-zinc-600 mb-3 break-words">
              Signed by {copy.signedName} · {formatTimelineTime(copy.signedAt)} ET
              {copy.signedIp ? ` · IP ${copy.signedIp}` : ""}
              <div className="text-zinc-500 break-all">Signature hash {copy.signatureHash}</div>
            </div>
            <SafeMarkdown markdown={copy.markdown} />
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function CloseOfferDialog({ copy, busy, error, onCancel, onConfirm }) {
  return (
    <Dialog open onClose={busy ? undefined : onCancel} size="sm" layer={130}>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-14 text-zinc-800">{copy.message}</p>
        {error && (
          <ActionFeedback error className="mt-3">
            {error}
          </ActionFeedback>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : copy.confirm}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// What the owner saw when they pressed Withdraw or Discard: the status, and for
// a draft its hash, so the server can refuse if either has moved on.
function expectedState(target) {
  return target.status === "draft" ? { expectedStatus: "draft", draftHash: target.draftHash } : { expectedStatus: target.status };
}

// Words for closing one offer record. A draft is never sent, so discarding it
// must not promise anything about the link of an offer that is already out.
function closeCopy(target, firstName, liveOffer) {
  if (target.status === "draft") {
    return {
      title: "Discard draft",
      message: liveOffer
        ? `Discard this draft? The offer you sent to ${firstName} stays open and their link keeps working.`
        : "Discard this draft? Nothing was sent.",
      confirm: "Discard draft",
    };
  }
  return {
    title: "Withdraw offer",
    message: `Withdraw this offer for ${firstName}? Their link stops working. Nothing is sent.`,
    confirm: "Withdraw",
  };
}

function DateRequestNote({ offer, busy, canAct, onUpdate }) {
  if (offer.status !== "date_requested" || !offer.requestedStartDate) return null;
  return (
    <div className="border-hairline border border-zinc-200 rounded p-3 mb-3">
      <div className="text-14 text-zinc-800 mb-1">
        Asked to start {formatDay(offer.requestedStartDate)}.
        {offer.dateRequestNote ? ` Note: ${offer.dateRequestNote}` : ""}
      </div>
      {canAct && (
        <Button size="sm" onClick={() => onUpdate(offer.requestedStartDate)} disabled={busy}>
          Make an updated offer for {formatDay(offer.requestedStartDate)}
        </Button>
      )}
    </div>
  );
}

export function History({ history, onViewSigned }) {
  if (!history?.length) return null;
  return (
    <details className="mt-3">
      <summary className="text-14 text-zinc-600 cursor-pointer min-h-11 flex items-center">
        Earlier offers ({history.length})
      </summary>
      <div className="flex flex-col gap-3 mt-1">
        {history.map((h) => (
          <div key={h.id} className="border-hairline border border-zinc-200 rounded p-3">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <Badge>{STATUS_LABEL[h.status] || h.status}</Badge>
              <span className="text-14 text-zinc-500">{formatTimelineTime(h.sentAt || h.createdAt)}</span>
            </div>
            <Terms offer={h} />
            <Timeline entries={h.timeline} />
            {h.signedAt && (
              <Button size="sm" variant="secondary" onClick={() => onViewSigned(h)}>
                View signed copy
              </Button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function DraftBlock({ draft, busy, canAct, onOpen, onDiscard }) {
  return (
    <div className="border-hairline border border-zinc-200 rounded p-3 mb-3">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="text-14 font-medium text-zinc-900">Updated draft</span>
        <Badge>Not sent</Badge>
      </div>
      <Terms offer={draft} />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button size="sm" onClick={onOpen} disabled={busy}>
          Open the updated draft
        </Button>
        {canAct && (
          <Button size="sm" variant="secondary" onClick={onDiscard} disabled={busy}>
            Discard this draft — the offer you sent stays open
          </Button>
        )}
      </div>
    </div>
  );
}

function OfferActions({ offer, draft, busy, stale, canAct, canMakeOffer, onMakeOffer, onEdit, onViewSigned, onRevise, onClose }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {canMakeOffer && (
        <Button size="sm" onClick={onMakeOffer} disabled={busy || stale}>
          Make an offer
        </Button>
      )}
      {offer.status === "draft" && (
        <Button size="sm" onClick={onEdit} disabled={busy || stale}>
          Open the draft
        </Button>
      )}
      {offer.signedAt && (
        <Button size="sm" variant="secondary" onClick={onViewSigned} disabled={busy}>
          View signed copy
        </Button>
      )}
      {canAct && CAN_REVISE.includes(offer.status) && !draft && (
        <Button size="sm" variant="secondary" onClick={onRevise} disabled={busy}>
          Revise
        </Button>
      )}
      {canAct && CAN_WITHDRAW.includes(offer.status) && (
        <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
          {offer.status === "draft" ? "Discard this draft" : "Withdraw offer"}
        </Button>
      )}
    </div>
  );
}

// The Withdraw or Discard question stays valid only while the owner may act on a read that
// worked, and the record it was opened for is still on screen as it was (the same status
// and, for a draft, the same hash): the write carries what the owner saw.
function closeStillValid(target, { offer, draft, canAct }) {
  const now = [draft, offer].find((o) => o?.id === target.id);
  return canAct && Boolean(now) && now.status === target.status && (target.status !== "draft" || now.draftHash === target.draftHash);
}

export default function OfferTimeline({ applicationId, firstName, offer, draft, history, canMakeOffer, ownerActions, refreshError, onMakeOffer, onChanged, onOpenDraft, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(null); // the offer record being withdrawn or discarded
  const [signed, setSigned] = useState(null);
  // Owner-only actions (send, revise, withdraw, discard) need the server's
  // viewer.ownerActions; none run on data that a failed re-read left stale.
  const stale = Boolean(refreshError);
  const canAct = ownerActions === true && !stale;

  // A failed write re-reads so the card shows what is true now: a stale refusal
  // changed nothing, a lost answer (no reply, a 5xx) may have gone through, and a
  // gate-off answer means offers are off. If that read fails, the section's Try
  // again stays and the write actions stay off (refreshError). Reads (the signed
  // copy) pass write: false and only show their error.
  const act = async (work, { write = true } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return "ok";
    } catch (err) {
      const lost = write && isLostAnswer(err);
      setError(lost ? LOST_ANSWER_TEXT.card : offerErrorMessage(err));
      if (!write || !(lost || isStaleWrite(err) || isGateOffAnswer(err))) return "failed";
      await onChanged();
      return "settled";
    } finally {
      setBusy(false);
    }
  };

  const revise = (startDate) =>
    act(async () => {
      const { offer: draft } = await reviseOffer(applicationId, offer.id, offer.status, startDate);
      // Open the new draft only after a read that holds it; on a failed read the
      // section's Try again stays on screen.
      const next = await onChanged();
      if (next && [next.draft, next.current].some((o) => o?.id === draft.id)) onOpenDraft(draft);
      else if (next) setError("The new draft could not be loaded. Try again.");
    });

  const closeTarget = async () => {
    const outcome = await act(async () => {
      await withdrawOffer(applicationId, closing.id, expectedState(closing));
      await onChanged();
    });
    // A refused or unanswered write also closes the confirm: the card now shows the truth.
    if (outcome !== "failed") setClosing(null);
  };

  // A read that changes the record, fails, or takes away the owner's access while the question
  // is open closes the question; its final click writes only while it is still valid.
  const closeReady = Boolean(closing) && closeStillValid(closing, { offer, draft, canAct });
  useEffect(() => {
    if (closing && !busy && !closeReady) setClosing(null);
  }, [closing, busy, closeReady]);

  const viewSigned = (target) =>
    act(
      async () => {
        setSigned(await fetchSignedCopy(applicationId, target.id));
      },
      { write: false },
    );

  return (
    <div className="border-hairline border border-zinc-200 rounded p-3 mb-4" data-testid="offer-card">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-14 font-medium text-zinc-900">Offer</span>
        <Badge>{STATUS_LABEL[offer.status] || offer.status}</Badge>
      </div>
      <Terms offer={offer} />
      <Timeline entries={offer.timeline} />
      <DateRequestNote offer={offer} busy={busy || Boolean(draft)} canAct={canAct} onUpdate={revise} />
      {error && !closing && (
        <ActionFeedback error className="mb-3">
          {error}
        </ActionFeedback>
      )}
      {draft && (
        <DraftBlock draft={draft} busy={busy || stale} canAct={canAct} onOpen={() => onOpenDraft(draft)} onDiscard={() => setClosing(draft)} />
      )}
      <OfferActions
        offer={offer}
        draft={draft}
        busy={busy}
        stale={stale}
        canAct={canAct}
        canMakeOffer={canMakeOffer}
        onMakeOffer={onMakeOffer}
        onEdit={onEdit}
        onViewSigned={() => viewSigned(offer)}
        onRevise={() => revise()}
        onClose={() => setClosing(offer)}
      />
      <History history={history} onViewSigned={viewSigned} />
      <SignedCopyView copy={signed} onClose={() => setSigned(null)} />
      {closing && (
        <CloseOfferDialog
          copy={closeCopy(closing, firstName, closing.status === "draft" && offer.status !== "draft" ? offer : null)}
          busy={busy}
          error={error}
          onCancel={() => {
            setClosing(null);
            setError(null);
          }}
          onConfirm={() => (closeReady ? closeTarget() : setClosing(null))}
        />
      )}
    </div>
  );
}
