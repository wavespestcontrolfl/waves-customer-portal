// client/src/components/admin/CustomerMovingCardV2.jsx
// Customer 360 "Moving" card (owner 2026-11-02, dark behind GATE_MOVING_FLOW).
//
// Shows where the customer's move stands in plain words and gives the office
// three ways to send the moving link: email it, copy it, or text it from the
// Communications composer. Sending is always this click; nothing here sends
// by itself. While the gate is dark the server answers { enabled: false } and
// the card renders nothing, so the page looks exactly as it did before.
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
  return "Link made, not sent yet";
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

export default function CustomerMovingCardV2({ customerId }) {
  const [enabled, setEnabled] = useState(false);
  const [moves, setMoves] = useState([]);
  const [text, setText] = useState(null);
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
    } catch {
      // The card is optional: a failed read leaves it hidden.
    }
  }, [customerId]);

  useEffect(() => {
    if (!customerId) return undefined;
    setEnabled(false);
    setMoves([]);
    setText(null);
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

  return (
    <div className="mt-5" data-testid="customer-moving-card">
      <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1.5">Moving</div>
      <div className="border-hairline border-zinc-200 rounded-sm px-3 py-2 text-13">
        <div className="text-zinc-900" data-testid="moving-status">{moveStatusText(moves[0])}</div>
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
