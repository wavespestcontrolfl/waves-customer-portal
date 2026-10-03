// Customer 360 — "Remove" on a saved card or bank (Billing → Cards on File).
//
// Commits once to DELETE /admin/customers/:id/payment-methods/:methodId —
// the same removal path the customer portal uses. The server refuses the
// method Auto Pay is using (409 autopay_method_in_use); this dialog only
// shows that refusal, it never decides it.
//
// Tier 1 V2 surface: components/ui primitives + zinc ramp. Admin stays
// monochrome; alert-fg only for the refusal/error line.
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

function paymentMethodLabel(method) {
  if (method.bank_name || method.bank_last_four) {
    return `${method.bank_name || "Bank account"} ending ${method.bank_last_four || method.last_four || "—"}`;
  }
  return `${method.card_brand || "Card"} ending ${method.last_four || "—"}`;
}

export default function RemovePaymentMethodDialog({ method, ...props }) {
  return method ? <RemoveConfirm key={method.id} method={method} {...props} /> : null;
}

function RemoveConfirm({ customer, method, onClose, onDone, layer }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const label = paymentMethodLabel(method);

  const commit = async () => {
    setRunning(true);
    setError("");
    try {
      await adminFetch(
        `/admin/customers/${encodeURIComponent(customer.id)}/payment-methods/${encodeURIComponent(method.id)}`,
        { method: "DELETE" },
      );
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
        <DialogTitle>Remove {label}?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-ui-body text-zinc-900">
          This detaches it from Stripe and deletes it from {customer.firstName || "the customer"}&rsquo;s
          account. It can&rsquo;t be charged again unless the customer adds it back.
        </p>
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
        <Button variant="danger" onClick={commit} disabled={running}>
          {running ? "Removing…" : "Remove"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
