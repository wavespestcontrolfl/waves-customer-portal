import { useState } from "react";
import {
  ActionFeedback,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// vendor_orders.adapter → the name the office knows.
const VENDOR_NAMES = { siteone: "SiteOne", stickermule: "Sticker Mule" };

// The Restock tab's "Record vendor cancellation", for an automatic order that
// is out (dispatched, not received, not revoked). Recording it closes the
// request and lets the next low-stock check order again, so it comes only
// after the vendor has cancelled the order, and the operator confirms that
// here. It sends the order the tab showed (id + version): the server refuses
// an order that changed since (409) and the dialog shows its message.
async function recordVendorCancellation(requestId, payload) {
  const res = await fetch(
    `${API_BASE}/admin/inventory/restock-requests/${encodeURIComponent(requestId)}/vendor-cancellation`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export default function VendorCancellationDialog({ request, onClose, onRecorded }) {
  const order = request.order;
  const vendor = VENDOR_NAMES[order.adapter] || null;
  const which = order.externalOrderNumber ? `order #${order.externalOrderNumber}` : "this order";
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function record() {
    setSaving(true);
    setError("");
    try {
      const result = await recordVendorCancellation(request.id, {
        orderId: order.id,
        version: order.version,
        cancelledWithVendor: true,
      });
      onRecorded(result);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} layer={400} aria-label="Record vendor cancellation">
      <DialogHeader>
        <DialogTitle>Record vendor cancellation</DialogTitle>
        <div className="text-ui-body text-ink-secondary">{request.productName}</div>
      </DialogHeader>
      <DialogBody className="space-y-3 text-ui-body text-zinc-900">
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        <p className="m-0">
          Do this only after {vendor || "the vendor"} confirms that {which} is cancelled.
          Nothing is sent to the vendor.
        </p>
        <p className="m-0">
          {request.status === "received"
            ? "The request stays received."
            : "The request is cancelled."}{" "}
          If stock is still low, the next low-stock check raises a new request and can order again.
        </p>
        <Checkbox
          label={`${vendor || "The vendor"} confirmed that ${which} is cancelled`}
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={saving}
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          Keep order
        </Button>
        <Button type="button" variant="danger" onClick={record} disabled={!confirmed || saving}>
          {saving ? "Recording..." : "Record cancellation"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
