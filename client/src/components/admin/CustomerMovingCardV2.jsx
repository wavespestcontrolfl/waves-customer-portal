// client/src/components/admin/CustomerMovingCardV2.jsx
// Customer 360 "Moving" card (owner 2026-11-02, dark behind GATE_MOVING_FLOW).
//
// Shows where the customer's move stands in plain words and gives the office
// three ways to send the moving link: email it, copy it, or text it from the
// Communications composer. Sending is always this click; nothing here sends
// by itself. While the gate is dark the server answers { enabled: false } and
// the card renders nothing, so the page looks exactly as it did before.
//
// Moving PR B2 (GATE_MOVING_APPLY): "Apply move" opens a preview of what will
// change, and only the office's confirm applies it (new home primary, old
// house's plans stopped after move-out with no customer text and no fee).
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonStyles } from "../ui";
import { adminFetch } from "../../lib/adminFetch";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Nov 3" from an ISO date or timestamp, on the Eastern calendar.
function shortDate(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).formatToParts(dt);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = parts.find((p) => p.type === "day")?.value;
  return `${MONTHS[month - 1]} ${day}`;
}

// A DATE column arrives as "2026-11-15": read it without a time-zone hop.
function dayOnly(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}

const VERDICT_WORDS = {
  in_area: "in our area",
  out_of_area: "outside our area",
  unverified: "address not confirmed",
};

function parseAddress(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

// One plain sentence for the newest move.
export function moveStatusText(move) {
  if (!move) return "No move yet";
  if (move.status === "closed" && move.closed_reason === "applied") {
    return `Move applied${move.applied_at ? ` ${shortDate(move.applied_at)}` : ""}`;
  }
  if (move.status === "closed" && move.closed_reason === "pause_expired") {
    return `Pause ended${move.closed_at ? ` ${shortDate(move.closed_at)}` : ""}: no new address in 60 days`;
  }
  if (move.status === "submitted") {
    const normalized = parseAddress(move.normalized_address);
    const where = move.typed_address
      ? `new home${normalized?.city ? ` in ${normalized.city}` : ""}${VERDICT_WORDS[move.address_verdict] ? `, ${VERDICT_WORDS[move.address_verdict]}` : ""}`
      : "new address not known yet";
    const out = move.move_out_date ? `move-out ${dayOnly(move.move_out_date)}` : "move-out not known yet";
    const into = move.move_in_date ? `move-in ${dayOnly(move.move_in_date)}` : "move-in not known yet";
    return `Submitted ${shortDate(move.submitted_at)}: ${where}, ${out}, ${into}`;
  }
  if (move.link_sent_at) {
    return `Link sent ${shortDate(move.link_sent_at)} by ${move.link_channel === "sms" ? "text" : (move.link_channel || "email")}`;
  }
  // A copied link may have gone out some other way: never claim "not sent".
  return "Link made";
}

// The move pause (GATE_MOVING_PAUSE, owner Q4) for a submitted move: the
// reminder text and the pause, or null when neither has happened.
export function movePauseText(move) {
  if (!move || move.status !== "submitted") return null;
  const parts = [];
  if (move.pause_reminder_at) {
    const day = shortDate(move.pause_reminder_at);
    if (move.pause_reminder_sent === true) parts.push(`Reminder text sent ${day}`);
    else if (move.pause_reminder_sent === false) parts.push(`Reminder text not sent (${day})`);
    else parts.push(`Reminder text tried ${day}, result unknown`);
  }
  if (move.pause_state === "paused") {
    parts.push(`Visits paused after ${dayOnly(move.move_out_date)}, held until ${dayOnly(move.pause_ends_on)}`);
  } else if (move.pause_state === "office") {
    parts.push(`Pause left to the office: ${move.pause_note || "pause the visits by hand"}`);
  }
  return parts.length ? parts.join(". ") : null;
}

// "Text moving link": the customer's SMS thread when one exists, else a new
// text to their phone (PortalInboxTabV2 replyHref picks the same way). The
// composer's Quick Links "Moving link" row then makes the link.
export function textHref(customerId, text) {
  if (customerId && text?.hasTexts) return `/admin/communications?thread=${encodeURIComponent(customerId)}#tab=sms`;
  if (text?.phone) return `/admin/communications?phone=${encodeURIComponent(text.phone)}&action=sms#tab=sms`;
  return null;
}

const EMAIL_REASONS = {
  missing_email: "There is no email address on file.",
  email_opted_out: "This customer turned email off.",
  prefs_unavailable: "Email settings could not be read. Try again.",
};

// The new-home estimate action the server picked for one move.
function NewHomeAction({ move, customerId }) {
  const { action, estimateId, reason } = move.new_home;
  if (action === "start") {
    const href = `/admin/estimates?tab=new&moveId=${encodeURIComponent(move.id)}&customerId=${encodeURIComponent(customerId)}`;
    return (
      <div className="mt-2" data-testid="new-home-action">
        <a className={buttonStyles({ variant: "secondary", size: "sm" })} href={href}>Estimate for new home</a>
      </div>
    );
  }
  if (action === "open" && estimateId) {
    return (
      <div className="mt-2" data-testid="new-home-action">
        <a className={buttonStyles({ variant: "secondary", size: "sm" })} href={`/admin/estimates?editEstimateId=${encodeURIComponent(estimateId)}`}>Open new-home estimate</a>
      </div>
    );
  }
  if (action === "blocked" && reason) {
    return <div className="text-14 text-ink-secondary mt-2" data-testid="new-home-action">{reason}</div>;
  }
  return null;
}

// One plan in plain words: "Quarterly Pest Control Service (quarterly)".
function planLine(item) {
  return item.frequency ? `${item.name} (${item.frequency})` : item.name;
}

// What "Apply move" will do, in plain words, from the server's preview.
export function applyPreviewLines(preview) {
  if (!preview) return [];
  const lines = [];
  lines.push(preview.primaryChange
    ? `The new home becomes the primary address: ${preview.toAddress}.`
    : `The new home is already the primary address: ${preview.toAddress}.`);
  if (preview.newPlan?.length) lines.push(`New-home plan: ${preview.newPlan.map(planLine).join(", ")}.`);
  for (const stop of preview.stops || []) {
    const keep = stop.keepCount ? ` ${stop.keepCount} before move-out stay.` : "";
    lines.push(stop.cancelCount
      ? `${planLine(stop)} at the old house stops after ${dayOnly(preview.moveOutDate)}: ${stop.cancelCount} visit${stop.cancelCount === 1 ? "" : "s"} from ${dayOnly(stop.firstCancelDate)} cancelled.${keep}`
      : `${planLine(stop)} at the old house stops after ${dayOnly(preview.moveOutDate)}. No visit after move-out is booked.${keep}`);
  }
  for (const other of preview.others || []) lines.push(`${planLine(other)} at another property does not change.`);
  if (preview.oneOffs?.length) {
    lines.push(`One-time visits at the old house after move-out stay booked: ${preview.oneOffs.map((v) => `${v.name} ${dayOnly(v.date)}`).join(", ")}. Cancel them by hand if needed.`);
  }
  if (preview.pastOpen?.length) {
    lines.push(`Open visits at the old house dated after move-out but before today stay as they are: ${preview.pastOpen.map((v) => `${v.name} ${dayOnly(v.date)}`).join(", ")}. Complete or cancel them by hand.`);
  }
  if (preview.stations) {
    lines.push(preview.stations.count
      ? `A task opens to pick up ${preview.stations.count} rented termite station${preview.stations.count === 1 ? "" : "s"} after move-out.`
      : "A task opens to confirm and pick up the rented termite stations after move-out.");
  }
  lines.push("No text or email goes to the customer. No late-cancel fee.");
  return lines;
}

// The Apply move control for one move: the button, its preview and confirm.
// onDone(message) reloads the card and shows the message on the card itself,
// because an applied move no longer renders this control.
function ApplyMoveAction({ move, customerId, onDone }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const { action, reason } = move.apply;

  const review = async () => {
    setBusy("preview"); setNote("");
    try {
      const res = await adminFetch(`/admin/customers/${encodeURIComponent(customerId)}/moves/${encodeURIComponent(move.id)}/apply-preview`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPreview(data);
    } catch (e) {
      setNote(e?.message || "Could not read what Apply move would do.");
    } finally {
      setBusy("");
    }
  };

  const confirm = async () => {
    setBusy("apply"); setNote("");
    try {
      const res = await adminFetch(`/admin/customers/${encodeURIComponent(customerId)}/moves/${encodeURIComponent(move.id)}/apply`, {
        method: "POST",
        body: JSON.stringify({ version: preview.version }),
      });
      const data = await res.json().catch(() => ({}));
      setPreview(null);
      if (!res.ok) {
        // Part of the move already happened: reload so the card shows what is left.
        if (data.progress) await onDone(data.error || `HTTP ${res.status}`);
        else setNote(data.error || `HTTP ${res.status}`);
        return;
      }
      await onDone(`Move applied. ${data.summary || ""}`.trim());
    } catch (e) {
      setNote(e?.message || "Apply move did not finish. Refresh the card before you try again.");
    } finally {
      setBusy("");
    }
  };

  if (action === "blocked" && reason) {
    return <div className="text-14 text-ink-secondary mt-2" data-testid="apply-move-action">{reason}</div>;
  }
  if (action !== "review") return note ? <div className="text-14 text-ink-secondary mt-2" role="status">{note}</div> : null;
  return (
    <div className="mt-2" data-testid="apply-move-action">
      {!preview && (
        <Button variant="secondary" size="sm" onClick={review} disabled={!!busy}>
          {busy === "preview" ? "Loading" : "Apply move"}
        </Button>
      )}
      {preview && (
        <div className="border-hairline border-zinc-200 rounded-sm px-3 py-2 mt-1" data-testid="apply-move-preview">
          <div className="text-14 font-medium text-zinc-900">Apply move</div>
          <ul className="list-disc pl-5 mt-1 text-14 text-zinc-900">
            {applyPreviewLines(preview).map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <Button variant="primary" size="sm" onClick={confirm} disabled={!!busy}>
              {busy === "apply" ? "Applying" : "Confirm Apply move"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPreview(null)} disabled={!!busy}>Cancel</Button>
          </div>
        </div>
      )}
      {note && <div className="text-14 text-ink-secondary mt-1.5" role="status">{note}</div>}
    </div>
  );
}

export default function CustomerMovingCardV2({ customerId }) {
  const [enabled, setEnabled] = useState(false);
  const [moves, setMoves] = useState([]);
  const [text, setText] = useState(null);
  const [estimateEnabled, setEstimateEnabled] = useState(false);
  const [applyEnabled, setApplyEnabled] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const manualRef = useRef(null);

  const load = useCallback(async (signal) => {
    try {
      const res = await adminFetch(`/admin/customers/${encodeURIComponent(customerId)}/moves`, { signal });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (signal?.aborted) return;
      setEnabled(data.enabled === true);
      setMoves(Array.isArray(data.moves) ? data.moves : []);
      setText(data.text || null);
      setEstimateEnabled(data.estimateEnabled === true);
      setApplyEnabled(data.applyEnabled === true);
    } catch {
      // The card is optional: a failed read leaves it hidden.
    }
  }, [customerId]);

  useEffect(() => {
    if (!customerId) return undefined;
    setEnabled(false);
    setMoves([]);
    setText(null);
    setEstimateEnabled(false);
    setApplyEnabled(false);
    setNote("");
    setManualUrl("");
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [customerId, load]);

  useEffect(() => {
    if (manualUrl && manualRef.current) manualRef.current.select();
  }, [manualUrl]);

  const emailLink = async () => {
    setBusy("email"); setNote(""); setManualUrl("");
    try {
      const res = await adminFetch(`/admin/customers/${encodeURIComponent(customerId)}/moving-email`, { method: "POST", body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNote(data.sent ? "Moving link emailed." : `Email not sent. ${EMAIL_REASONS[data.reason] || "It could not be sent."}`);
      await load();
    } catch (e) {
      setNote(e?.message || "Could not send the email.");
    } finally {
      setBusy("");
    }
  };

  const copyLink = async () => {
    setBusy("copy"); setNote(""); setManualUrl("");
    try {
      const res = await adminFetch(`/admin/customers/${encodeURIComponent(customerId)}/moving-link`, { method: "POST", body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      try {
        await navigator.clipboard.writeText(data.url);
        setNote("Moving link copied.");
      } catch {
        setManualUrl(data.url);
        setNote("Copy the link below.");
      }
      await load();
    } catch (e) {
      setNote(e?.message || "Could not make the link.");
    } finally {
      setBusy("");
    }
  };

  if (!enabled) return null;
  const textLink = textHref(customerId, text);
  // New-home estimate (GATE_MOVING_ESTIMATE): only moves the server marked.
  const newHomeMoves = estimateEnabled ? moves.filter((m) => m?.new_home) : [];
  // Apply move (GATE_MOVING_APPLY): only moves the server marked for review or blocked.
  const applyMoves = applyEnabled ? moves.filter((m) => m?.apply && m.apply.action !== "applied") : [];

  return (
    <div className="mt-5" data-testid="customer-moving-card">
      <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1.5">Moving</div>
      <div className="border-hairline border-zinc-200 rounded-sm px-3 py-2 text-13">
        <div className="text-zinc-900" data-testid="moving-status">{moveStatusText(moves[0])}</div>
        {movePauseText(moves[0]) && <div className="text-14 text-ink-secondary mt-1" data-testid="moving-pause">{movePauseText(moves[0])}</div>}
        <div className="flex flex-wrap gap-1.5 mt-2">
          <Button variant="secondary" size="sm" onClick={emailLink} disabled={!!busy}>
            {busy === "email" ? "Sending" : "Email moving link"}
          </Button>
          <Button variant="secondary" size="sm" onClick={copyLink} disabled={!!busy}>
            {busy === "copy" ? "Making link" : "Copy moving link"}
          </Button>
          {textLink ? (
            <a className={buttonStyles({ variant: "secondary", size: "sm" })} href={textLink}>
              Text moving link
            </a>
          ) : (
            <Button variant="secondary" size="sm" disabled title="No phone on file">
              Text moving link
            </Button>
          )}
        </div>
        {newHomeMoves.map((move) => (
          <NewHomeAction key={move.id} move={move} customerId={customerId} />
        ))}
        {applyMoves.map((move) => (
          <ApplyMoveAction
            key={move.id}
            move={move}
            customerId={customerId}
            onDone={async (message) => { setNote(message || ""); setManualUrl(""); await load(); }}
          />
        ))}
        {note && <div className="text-12 text-ink-secondary mt-1.5" role="status">{note}</div>}
        {manualUrl && (
          <input
            ref={manualRef}
            readOnly
            aria-label="Moving link"
            value={manualUrl}
            className="mt-1.5 w-full border-hairline border-zinc-300 rounded-sm px-2 py-1 text-12"
            onFocus={(e) => e.target.select()}
          />
        )}
      </div>
    </div>
  );
}
