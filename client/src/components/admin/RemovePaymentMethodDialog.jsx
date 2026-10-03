// Customer 360 — "Remove" on a saved card or bank (Billing → Cards on File).
//
// Commits once to DELETE /admin/customers/:id/payment-methods/:methodId —
// the same removal path the customer portal uses. The server refuses the
// method Auto Pay is using (409 autopay_method_in_use); this dialog only
// shows that refusal, it never decides it. Before the confirm it carries the
// portal's two removal disclosures: a verified bank's debit can take up to 3
// business days to stop, and a card holding a future secured visit (read
// from .../removal-preview, the portal's hold lookup) leaves that visit and
// its late-cancel fee in place.
//
// Tier 1 V2 surface: components/ui primitives + zinc ramp. Admin stays
// monochrome; alert-fg only for the refusal/error line.
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui";
import { adminFetch } from "../../utils/admin-fetch";
import { formatETDateTime } from "../../lib/timezone";

// Mirrors the server's isBankMethodType aliases (autopay-eligibility.js).
const BANK_METHOD_TYPES = new Set(["ach", "us_bank_account", "bank", "bank_account"]);

function paymentMethodLabel(method) {
  if (method.bank_name || method.bank_last_four) {
    return `${method.bank_name || "Bank account"} ending ${method.bank_last_four || method.last_four || "—"}`;
  }
  return `${method.card_brand || "Card"} ending ${method.last_four || "—"}`;
}

function HoldNotice({ hold }) {
  const when = formatETDateTime(hold.start, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fee = hold.feeAmount != null ? `$${Number(hold.feeAmount).toFixed(2)} ` : "";
  return (
    <p className="mt-2 text-ui-body text-zinc-900">
      This card holds the customer&rsquo;s {hold.serviceType || "service"} visit on {when}. Removing it does
      not cancel the visit or the {fee}late-cancel fee they agreed to, but that fee can no longer be
      charged to this card.
    </p>
  );
}

export default function RemovePaymentMethodDialog({ method, ...props }) {
  return method ? <RemoveConfirm key={method.id} method={method} {...props} /> : null;
}

function RemoveConfirm({ customer, method, onClose, onDone, layer }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const label = paymentMethodLabel(method);
  const customerId = encodeURIComponent(customer.id);
  const methodId = encodeURIComponent(method.id);
  const verifiedBank = BANK_METHOD_TYPES.has(String(method.method_type || "").toLowerCase()) && method.ach_status === "verified";

  useEffect(() => {
    let alive = true;
    adminFetch(`/admin/customers/${customerId}/payment-methods/${methodId}/removal-preview`)
      .then((data) => { if (alive) setPreview(data || { holdsAppointment: null, holdLookupFailed: false }); })
      .catch(() => { if (alive) setPreview({ holdsAppointment: null, holdLookupFailed: true }); });
    return () => { alive = false; };
  }, [customerId, methodId]);

  const hold = preview?.holdsAppointment || null;

  const commit = async () => {
    setRunning(true);
    setError("");
    try {
      await adminFetch(`/admin/customers/${customerId}/payment-methods/${methodId}`, { method: "DELETE" });
    } catch (e) {
      setError(e.message || "Could not remove the payment method.");
      setRunning(false);
      return;
    }
    try {
      await onDone?.();
    } catch (refreshError) {
      setError(`Removed, but the customer profile could not refresh: ${refreshError.message || "Refresh failed"}`);
      setRunning(false);
      return;
    }
    onClose();
  };

  return (
    <Dialog open onClose={() => !running && onClose()} size="sm" layer={layer}>
      <DialogHeader>
        <DialogTitle>{hold ? "This card holds an appointment" : `Remove ${label}?`}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-ui-body text-zinc-900">
          This detaches {label} from Stripe and deletes it from {customer.firstName || "the customer"}&rsquo;s
          account, so no new charges can be started on it.
        </p>
        {verifiedBank && (
          <p className="mt-2 text-ui-body text-zinc-900">
            Bank authorizations can take up to 3 business days to stop, so a debit already in progress
            may still go through.
          </p>
        )}
        {hold && <HoldNotice hold={hold} />}
        {preview?.holdLookupFailed && (
          <p className="mt-2 text-14 text-ink-secondary">
            Couldn&rsquo;t check whether this card holds an upcoming appointment.
          </p>
        )}
        <p className="mt-2 text-14 text-ink-secondary">
          Same as a removal from the customer portal, including its &ldquo;payment method removed&rdquo;
          email when those emails are on. A method Auto Pay is using can&rsquo;t be removed — switch or
          turn off Auto Pay first.
        </p>
        {error && (
          <div className="mt-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-14">{error}</div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={running}>
          Keep it
        </Button>
        <Button variant="danger" onClick={commit} disabled={running || !preview}>
          {running ? "Removing…" : hold ? "Remove anyway" : "Remove"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
