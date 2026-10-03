// Invoices — "Edit address" on one invoice (any status, paid included).
//
// Loads the address the invoice's documents currently display
// (GET /admin/invoices/:id/receipt-address) and saves a correction
// (PUT, same path). Presentation only: amounts, status, the customer
// profile and payer bill-to stay untouched, and nothing is re-sent — the
// operator uses Resend receipt afterwards if the customer needs a new copy.
//
// Tier 1 V2 surface: components/ui primitives + zinc ramp.
import { useEffect, useState } from "react";
import {
  ActionFeedback,
  Button,
  Dialog,
  DialogBody,
  DialogTitle,
  Field,
  Input,
} from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

const EMPTY = { address_line1: "", city: "", state: "", zip: "" };

export default function InvoiceAddressDialog({ invoice, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    adminFetch(`/admin/invoices/${encodeURIComponent(invoice.id)}/receipt-address`)
      .then((data) => {
        if (!alive) return;
        const a = data?.address || {};
        // Receipts print the street line only, so a unit stored on line 2
        // folds into it; the server clears line 2 on save.
        setForm({
          address_line1: [a.address_line1, a.address_line2].filter(Boolean).join(" "),
          city: a.city || "",
          state: a.state || "",
          zip: a.zip || "",
        });
      })
      .catch((err) => { if (alive) setError(err.message || "Could not load the invoice address"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [invoice.id]);

  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));
  const complete = ["address_line1", "city", "state", "zip"].every((f) => form[f].trim());

  const save = async () => {
    if (saving || loading || !complete) return;
    setSaving(true);
    setError("");
    try {
      await adminFetch(`/admin/invoices/${encodeURIComponent(invoice.id)}/receipt-address`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      onSaved();
    } catch (err) {
      setError(err.message || "Could not save the address");
      setSaving(false);
    }
  };

  return (
    <Dialog open={true} onClose={saving ? undefined : onClose} layer={400}>
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>Edit invoice address</DialogTitle>
        <div className="text-ui-body text-ink-secondary">
          Invoice #{invoice.invoice_number} · {invoice.first_name} {invoice.last_name}. Changes the
          address on this invoice and its receipt only — not the customer profile, amounts or
          status. Nothing is sent; use Resend receipt if the customer needs a corrected copy.
        </div>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        <Field label="Street (include any unit or suite)" className="min-w-0">
          <Input value={form.address_line1} onChange={set("address_line1")} disabled={loading || saving} autoComplete="off" />
        </Field>
        <div className="grid grid-cols-[1fr_5rem_7rem] gap-3">
          <Field label="City" className="min-w-0">
            <Input value={form.city} onChange={set("city")} disabled={loading || saving} autoComplete="off" />
          </Field>
          <Field label="State" className="min-w-0">
            <Input value={form.state} onChange={set("state")} maxLength={2} disabled={loading || saving} autoComplete="off" />
          </Field>
          <Field label="ZIP" className="min-w-0">
            <Input value={form.zip} onChange={set("zip")} maxLength={10} inputMode="numeric" disabled={loading || saving} autoComplete="off" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={loading || saving || !complete}>
            {saving ? "Saving…" : "Save address"}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}
