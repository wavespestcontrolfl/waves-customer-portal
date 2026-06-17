/**
 * Payers (Bill-To accounts) management.
 *
 * A payer is a reusable third-party Bill-To: a builder/GC, property manager,
 * realtor, HOA, etc. who pays for a customer's service. Assign a payer as a
 * customer's default (Customer 360) or per-job (Edit appointment). Invoices
 * then route to the payer's AP inbox with a proper bill-to block.
 *
 * Tier 1 V2 surface — components/ui + Tailwind zinc.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Button,
  Input,
  Select,
  Textarea,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";

const TERMS = [
  { value: "due_on_receipt", label: "Due on receipt" },
  { value: "net15", label: "Net 15" },
  { value: "net30", label: "Net 30" },
];

const EMPTY = {
  display_name: "",
  company_name: "",
  ap_email: "",
  ap_phone: "",
  billing_address_line1: "",
  billing_city: "",
  billing_state: "",
  billing_zip: "",
  payment_terms: "due_on_receipt",
  requires_po: false,
  tax_exempt: false,
  tax_exempt_cert: "",
  notes: "",
  active: true,
};

function termLabel(value) {
  return TERMS.find((t) => t.value === value)?.label || value || "—";
}

export default function PayersPage() {
  const [payers, setPayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState(null); // payer object, {} for new, or null
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (includeInactive) params.set("includeInactive", "true");
      const r = await adminFetch(`/admin/payers?${params.toString()}`);
      const data = await r.json();
      setPayers(Array.isArray(data?.payers) ? data.payers : []);
    } catch {
      setPayers([]);
    } finally {
      setLoading(false);
    }
  }, [search, includeInactive]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  function openNew() {
    setForm(EMPTY);
    setEditing({});
    setError("");
  }

  function openEdit(p) {
    setForm({ ...EMPTY, ...p });
    setEditing(p);
    setError("");
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    if (!form.display_name.trim()) {
      setError("Payer name is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const isNew = !editing?.id;
      const r = await adminFetch(
        isNew ? "/admin/payers" : `/admin/payers/${editing.id}`,
        { method: isNew ? "POST" : "PUT", body: form },
      );
      const data = await r.json();
      if (!r.ok) {
        setError(data?.error || "Could not save payer.");
        return;
      }
      setEditing(null);
      await load();
    } catch {
      setError("Could not save payer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-20 font-medium text-zinc-900">Payers</h1>
          <p className="text-13 text-zinc-500 mt-0.5">
            Third-party Bill-To accounts — builders, property managers,
            realtors, HOAs. Assign one to a customer or a single job to route
            that invoice to them.
          </p>
        </div>
        <Button onClick={openNew}>New payer</Button>
      </div>

      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <Input
          placeholder="Search name, company, or AP email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-13 text-zinc-600 cursor-pointer">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      <Card>
        <CardBody className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>AP email</TH>
                <TH>Terms</TH>
                <TH>PO</TH>
                <TH>Status</TH>
                <TH className="text-right">Edit</TH>
              </TR>
            </THead>
            <TBody>
              {loading ? (
                <TR>
                  <TD colSpan={6} className="text-center text-zinc-400 py-6">
                    Loading…
                  </TD>
                </TR>
              ) : payers.length === 0 ? (
                <TR>
                  <TD colSpan={6} className="text-center text-zinc-400 py-6">
                    No payers yet. Create one to bill a third party.
                  </TD>
                </TR>
              ) : (
                payers.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <div className="font-medium text-zinc-900">
                        {p.display_name}
                      </div>
                      {p.company_name && p.company_name !== p.display_name && (
                        <div className="text-12 text-zinc-500">
                          {p.company_name}
                        </div>
                      )}
                    </TD>
                    <TD className="text-zinc-600">{p.ap_email || "—"}</TD>
                    <TD className="text-zinc-600">
                      {termLabel(p.payment_terms)}
                    </TD>
                    <TD>{p.requires_po ? "Required" : "—"}</TD>
                    <TD>
                      {p.active ? (
                        <Badge tone="strong">Active</Badge>
                      ) : (
                        <Badge tone="neutral">Inactive</Badge>
                      )}
                    </TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(p)}
                      >
                        Edit
                      </Button>
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {editing && (
        <Dialog open onClose={() => setEditing(null)}>
          <DialogHeader>
            <DialogTitle>{editing.id ? "Edit payer" : "New payer"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Field label="Payer name *">
              <Input
                value={form.display_name}
                onChange={(e) => set("display_name", e.target.value)}
                placeholder="e.g. Homes by West Bay"
              />
            </Field>
            <Field label="Company name (shown as Bill-To on the invoice)">
              <Input
                value={form.company_name || ""}
                onChange={(e) => set("company_name", e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="AP email (where invoices go)">
                <Input
                  type="email"
                  value={form.ap_email || ""}
                  onChange={(e) => set("ap_email", e.target.value)}
                  placeholder="ap@example.com"
                />
              </Field>
              <Field label="AP phone">
                <Input
                  value={form.ap_phone || ""}
                  onChange={(e) => set("ap_phone", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Billing address">
              <Input
                value={form.billing_address_line1 || ""}
                onChange={(e) => set("billing_address_line1", e.target.value)}
                placeholder="Street"
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="City">
                <Input
                  value={form.billing_city || ""}
                  onChange={(e) => set("billing_city", e.target.value)}
                />
              </Field>
              <Field label="State">
                <Input
                  value={form.billing_state || ""}
                  onChange={(e) => set("billing_state", e.target.value)}
                  maxLength={2}
                />
              </Field>
              <Field label="ZIP">
                <Input
                  value={form.billing_zip || ""}
                  onChange={(e) => set("billing_zip", e.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Payment terms">
                <Select
                  value={form.payment_terms}
                  onChange={(e) => set("payment_terms", e.target.value)}
                >
                  {TERMS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tax-exempt certificate #">
                <Input
                  value={form.tax_exempt_cert || ""}
                  onChange={(e) => set("tax_exempt_cert", e.target.value)}
                  disabled={!form.tax_exempt}
                />
              </Field>
            </div>
            {form.payment_terms !== "due_on_receipt" && (
              <p className="text-12 text-zinc-500">
                Net terms (consolidated monthly statements) are coming in Phase
                2. For now every payer is invoiced per visit.
              </p>
            )}
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 text-13 text-zinc-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!form.requires_po}
                  onChange={(e) => set("requires_po", e.target.checked)}
                />
                Require a PO number on each job
              </label>
              <label className="flex items-center gap-2 text-13 text-zinc-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!form.tax_exempt}
                  onChange={(e) => set("tax_exempt", e.target.checked)}
                />
                Tax-exempt
              </label>
              <label className="flex items-center gap-2 text-13 text-zinc-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!form.active}
                  onChange={(e) => set("active", e.target.checked)}
                />
                Active
              </label>
            </div>
            <Field label="Notes">
              <Textarea
                rows={2}
                value={form.notes || ""}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
            {error && <p className="text-13 text-alert-fg">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save payer"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-12 text-zinc-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
