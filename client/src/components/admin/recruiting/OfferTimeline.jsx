/**
 * The offer card on an application's detail: where the offer stands, a
 * timeline of what happened (times in Eastern) and the owner's actions.
 * Rows stack on a phone; time sits beside the label from the sm width up.
 */
import React, { useState } from "react";
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
import SafeMarkdown from "./SafeMarkdown";
import { fetchSignedCopy, reviseOffer, withdrawOffer } from "./offerApi";
import { formatDay, formatTimelineTime, money, offerErrorMessage } from "./offerLogic";

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
          <span className="text-14 text-zinc-400 sm:ml-auto sm:shrink-0">{formatTimelineTime(e.at)}</span>
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
              <div className="text-zinc-400 break-all">Signature hash {copy.signatureHash}</div>
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

function WithdrawDialog({ firstName, busy, error, onCancel, onConfirm }) {
  return (
    <Dialog open onClose={busy ? undefined : onCancel} size="sm" layer={130}>
      <DialogHeader>
        <DialogTitle>Withdraw offer</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-14 text-zinc-800">
          Withdraw this offer for {firstName}? Their link stops working. Nothing is sent.
        </p>
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
          {busy ? "Withdrawing…" : "Withdraw"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DateRequestNote({ offer, busy, onUpdate }) {
  if (offer.status !== "date_requested" || !offer.requestedStartDate) return null;
  return (
    <div className="border-hairline border rounded p-3 mb-3">
      <div className="text-14 text-zinc-800 mb-1">
        Asked to start {formatDay(offer.requestedStartDate)}.
        {offer.dateRequestNote ? ` Note: ${offer.dateRequestNote}` : ""}
      </div>
      <Button size="sm" onClick={() => onUpdate(offer.requestedStartDate)} disabled={busy}>
        Make an updated offer for {formatDay(offer.requestedStartDate)}
      </Button>
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
          <div key={h.id} className="border-hairline border rounded p-3">
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

export default function OfferTimeline({ applicationId, firstName, offer, history, onChanged, onOpenDraft, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [signed, setSigned] = useState(null);

  const act = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(offerErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const revise = (startDate) =>
    act(async () => {
      const { offer: draft } = await reviseOffer(applicationId, offer.id, startDate);
      await onChanged();
      onOpenDraft(draft);
    });

  const withdraw = async () => {
    const ok = await act(async () => {
      await withdrawOffer(applicationId, offer.id);
      await onChanged();
    });
    if (ok) setWithdrawing(false);
  };

  const viewSigned = (target) =>
    act(async () => {
      setSigned(await fetchSignedCopy(applicationId, target.id));
    });

  return (
    <div className="border-hairline border rounded p-3 mb-4" data-testid="offer-card">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-14 font-medium text-zinc-900">Offer</span>
        <Badge>{STATUS_LABEL[offer.status] || offer.status}</Badge>
      </div>
      <Terms offer={offer} />
      <Timeline entries={offer.timeline} />
      <DateRequestNote offer={offer} busy={busy} onUpdate={revise} />
      {error && !withdrawing && (
        <ActionFeedback error className="mb-3">
          {error}
        </ActionFeedback>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {offer.status === "draft" && (
          <Button size="sm" onClick={onEdit} disabled={busy}>
            Open the draft
          </Button>
        )}
        {offer.signedAt && (
          <Button size="sm" variant="secondary" onClick={() => viewSigned(offer)} disabled={busy}>
            View signed copy
          </Button>
        )}
        {CAN_REVISE.includes(offer.status) && (
          <Button size="sm" variant="secondary" onClick={() => revise()} disabled={busy}>
            Revise
          </Button>
        )}
        {CAN_WITHDRAW.includes(offer.status) && (
          <Button size="sm" variant="secondary" onClick={() => setWithdrawing(true)} disabled={busy}>
            Withdraw
          </Button>
        )}
      </div>
      <History history={history} onViewSigned={viewSigned} />
      <SignedCopyView copy={signed} onClose={() => setSigned(null)} />
      {withdrawing && (
        <WithdrawDialog
          firstName={firstName}
          busy={busy}
          error={error}
          onCancel={() => {
            setWithdrawing(false);
            setError(null);
          }}
          onConfirm={withdraw}
        />
      )}
    </div>
  );
}
