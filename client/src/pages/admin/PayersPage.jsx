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

import { useState, useEffect, useCallback, useRef } from "react";
import { Building2 } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Button,
  Input,
  Select,
  Textarea,
  Badge,
  Card,
  CardBody,
  ActionFeedback,
  Checkbox,
  Field,
  UiSurface,
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
import PayerDetailSheet from "./PayerDetailSheet";
import PayerArAgingDialog from "./PayerArAgingDialog";

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
  const [loadError, setLoadError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState(null); // payer object, {} for new, or null
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const loadVersion = useRef(0);
  const [error, setError] = useState("");
  const [detailPayer, setDetailPayer] = useState(null); // open the statements/AR sheet
  const [arOpen, setArOpen] = useState(false); // cross-payer AR aging dialog
  const arTriggerRef = useRef(null);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (includeInactive) params.set("includeInactive", "true");
      const r = await adminFetch(`/admin/payers?${params.toString()}`);
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Could not load payers.");
      if (version !== loadVersion.current) return;
      setPayers(Array.isArray(data?.payers) ? data.payers : []);
    } catch (err) {
      if (version === loadVersion.current) setLoadError(err.message || "Could not load payers.");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [search, includeInactive]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => {
      clearTimeout(t);
      loadVersion.current += 1;
    };
  }, [load]);

  function openNew(event) {
    event.currentTarget.focus({ preventScroll: true });
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

  // Open a payer's statements/AR sheet from the AR worklist (which only has an
  // id). Use the loaded row if present; otherwise fetch it (it may be filtered
  // out of the current list, e.g. inactive).
  async function openDetailById(id) {
    setDetailError("");
    setArOpen(false);
    const found = payers.find((p) => p.id === id);
    if (found) {
      // The selected worklist button is about to unmount. The sheet returns
      // focus to the directory's persistent AR opener after this handoff.
      arTriggerRef.current?.focus({ preventScroll: true });
      setDetailPayer(found);
      return;
    }
    try {
      const r = await adminFetch(`/admin/payers/${id}`);
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.payer) throw new Error("Could not open payer details. Try selecting the payer again.");
      arTriggerRef.current?.focus({ preventScroll: true });
      setDetailPayer(d.payer);
    } catch {
      setDetailError("Could not open payer details. Try selecting the payer again.");
    }
  }

  async function save() {
    if (savingRef.current) return;
    if (!form.display_name.trim()) {
      setError("Payer name is required.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const isNew = !editing?.id;
      const r = await adminFetch(
        isNew ? "/admin/payers" : `/admin/payers/${editing.id}`,
        { method: isNew ? "POST" : "PUT", body: form },
      );
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(data?.error || "Could not save payer.");
        return;
      }
      setEditing(null);
      await load();
    } catch {
      setError("Could not save payer.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const closeEditor = () => { if (!savingRef.current) setEditing(null); };

  return (
    <UiSurface density="comfortable" className="max-w-[1300px] mx-auto">
      <AdminCommandHeader
        title="Payers"
        icon={Building2}
        variant="workspace"
        actions={[
          { key: "ar", label: "AR aging", size: "sm", variant: "ghost", onClick: (event) => {
            arTriggerRef.current = event.currentTarget;
            event.currentTarget.focus({ preventScroll: true });
            setArOpen(true);
          } },
          { key: "new", label: "New payer", size: "sm", onClick: openNew },
        ]}
      />
      <p className="text-ui-body text-ink-secondary mb-5">
        Third-party Bill-To accounts — builders, property managers,
        realtors, HOAs. Assign one to a customer or a single job to route
        that invoice to them.
      </p>

      <div className="flex items-end gap-3 mb-5 flex-wrap">
        <Field label="Search payers" className="w-full sm:max-w-sm">
        <Input
          placeholder="Search name, company, or AP email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        </Field>
          <Checkbox
            label="Show inactive"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
      </div>
      {detailError && <ActionFeedback error className="mb-5">{detailError}</ActionFeedback>}
      {loading && payers.length > 0 && <ActionFeedback className="mb-3">Refreshing payers…</ActionFeedback>}

      <Card>
        <CardBody className="p-0">
          <Table layout="records" aria-label="Payers">
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
              {loading && payers.length === 0 ? (
                <TR>
                  <TD colSpan={6} className="text-center text-ink-secondary py-6">
                    <div role="status" className="min-h-[160px]">Loading…</div>
                  </TD>
                </TR>
              ) : loadError ? (
                <TR><TD colSpan={6}><ActionFeedback error onRetry={load}>{loadError}</ActionFeedback></TD></TR>
              ) : payers.length === 0 ? (
                <TR>
                  <TD colSpan={6} className="text-center text-ink-secondary py-6">
                    {search.trim() ? "No payers match this search. Clear the search to see all payers." : "No payers yet. Create one to bill a third party."}
                    {search.trim() && <Button variant="secondary" className="mt-3" onClick={() => setSearch("")}>Clear search</Button>}
                  </TD>
                </TR>
              ) : (
                payers.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <Button
                        variant="ghost"
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          setDetailError("");
                          setDetailPayer(p);
                        }}
                        className="text-left justify-start max-w-full"
                      >
                        {p.display_name}
                      </Button>
                      {p.company_name && p.company_name !== p.display_name && (
                        <div className="text-ui-caption text-ink-secondary">
                          {p.company_name}
                        </div>
                      )}
                    </TD>
                    <TD data-label="AP email" className="text-zinc-600">{p.ap_email || "—"}</TD>
                    <TD data-label="Terms" className="text-zinc-600">
                      {termLabel(p.payment_terms)}
                    </TD>
                    <TD data-label="PO">{p.requires_po ? "Required" : "—"}</TD>
                    <TD data-label="Status">
                      <span>
                      {p.active ? (
                        <Badge tone="strong">Active</Badge>
                      ) : (
                        <Badge tone="neutral">Inactive</Badge>
                      )}
                      </span>
                    </TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${p.display_name}`}
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          openEdit(p);
                        }}
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
        <Dialog open onClose={closeEditor}>
          <DialogHeader>
            <DialogTitle>{editing.id ? "Edit payer" : "New payer"}</DialogTitle>
          </DialogHeader>
          <DialogBody>
          <fieldset disabled={saving} className="min-w-0 m-0 p-0 border-0 space-y-3">
            <Field label="Payer name" required>
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <Field label="Tax-exempt certificate #" help={!form.tax_exempt ? "Select Tax-exempt to enter a certificate." : undefined}>
                <Input
                  value={form.tax_exempt_cert || ""}
                  onChange={(e) => set("tax_exempt_cert", e.target.value)}
                  disabled={!form.tax_exempt}
                />
              </Field>
            </div>
            {form.payment_terms !== "due_on_receipt" && (
              <p className="text-ui-caption text-ink-secondary">
                Net terms consolidate this payer&rsquo;s visits onto a monthly
                statement billed to the AP inbox. Open the payer to close, send,
                reconcile, and track AR on its statements.
              </p>
            )}
            <div className="flex flex-col gap-2 pt-1">
                <Checkbox
                  label="Usually needs a PO (advisory — staff are reminded, not blocked)"
                  checked={!!form.requires_po}
                  onChange={(e) => set("requires_po", e.target.checked)}
                />
                <Checkbox
                  label="Tax-exempt (zeroes tax on this payer’s invoices)"
                  checked={!!form.tax_exempt}
                  onChange={(e) => set("tax_exempt", e.target.checked)}
                />
                <Checkbox
                  label="Active"
                  checked={!!form.active}
                  onChange={(e) => set("active", e.target.checked)}
                />
            </div>
            <Field label="Notes">
              <Textarea
                rows={2}
                value={form.notes || ""}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </fieldset>
            {error && <ActionFeedback error className="mt-3">{error}</ActionFeedback>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={closeEditor}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Save payer
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {detailPayer && (
        <PayerDetailSheet
          key={detailPayer.id}
          payer={detailPayer}
          onClose={() => setDetailPayer(null)}
          onChanged={load}
        />
      )}

      {arOpen && (
        <PayerArAgingDialog
          onClose={() => setArOpen(false)}
          onSelectPayer={openDetailById}
        />
      )}
    </UiSurface>
  );
}
