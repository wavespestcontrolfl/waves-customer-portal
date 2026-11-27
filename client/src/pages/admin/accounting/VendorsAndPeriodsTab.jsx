import React, { useState, useEffect, useCallback } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Checkbox,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Input,
  Select,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../../../components/ui";
import { etDateString } from "../../../lib/timezone";
import { getJson, postJson, formatCents } from "./api";

const ENTITY_OPTIONS = [
  ["unknown", "Unknown"],
  ["individual", "Individual / Contractor"],
  ["sole_prop", "Sole Proprietorship"],
  ["single_member_llc", "Single-Member LLC"],
  ["partnership", "Partnership"],
  ["s_corp", "S-Corporation"],
  ["c_corp", "C-Corporation"],
  ["government", "Government Agency"],
];

const EMPTY_VENDOR = {
  displayName: "",
  legalName: "",
  entityType: "sole_prop",
  is1099Eligible: true,
  w9ReceivedAt: "",
  tin: "",
  email: "",
};

export default function VendorsAndPeriodsTab({ onChanged }) {
  const today = etDateString(new Date());
  const currentYear = today.slice(0, 4);

  const [vendors, setVendors] = useState([]);
  const [summary1099, setSummary1099] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Subledger sync controls
  const [syncFrom, setSyncFrom] = useState(`${currentYear}-01-01`);
  const [syncTo, setSyncTo] = useState(today);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // Period lock controls
  const [lockMonth, setLockMonth] = useState(today.slice(0, 7));
  const [lockNotes, setLockNotes] = useState("");
  const [periodBusy, setPeriodBusy] = useState(false);

  // Add vendor dialog
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vForm, setVForm] = useState(EMPTY_VENDOR);
  const [vSaving, setVSaving] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [vRes, repRes, pRes] = await Promise.all([
        getJson("/vendors"),
        getJson(`/reports/1099?year=${currentYear}`),
        getJson("/periods"),
      ]);
      setVendors(vRes.vendors || []);
      setSummary1099(repRes);
      setPeriods(pRes.periods || []);
    } catch (err) {
      setError(err.message || "Could not load vendors and accounting periods.");
    } finally {
      setLoading(false);
    }
  }, [currentYear]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSync = async (dryRun) => {
    setSyncBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await postJson("/sync", { fromDate: syncFrom, toDate: syncTo, dryRun });
      setSyncResult(res);
      if (!dryRun) {
        setNotice("Subledger sync completed.");
        await loadAll();
        onChanged?.();
      }
    } catch (err) {
      setError(err.message || "Subledger sync failed.");
    } finally {
      setSyncBusy(false);
    }
  };

  const handlePeriodAction = async (month, action, notes = "") => {
    setPeriodBusy(true);
    setError("");
    setNotice("");
    try {
      await postJson(`/periods/${encodeURIComponent(month)}/${action}`, { notes });
      setNotice(`Period ${month} updated (${action}).`);
      setLockNotes("");
      await loadAll();
      onChanged?.();
    } catch (err) {
      setError(err.message || `Could not ${action} period ${month}.`);
    } finally {
      setPeriodBusy(false);
    }
  };

  const handleCreateVendor = async (e) => {
    e.preventDefault();
    setVSaving(true);
    setError("");
    try {
      await postJson("/vendors", {
        displayName: vForm.displayName.trim(),
        legalName: vForm.legalName.trim() || null,
        entityType: vForm.entityType,
        is1099Eligible: vForm.is1099Eligible,
        w9ReceivedAt: vForm.w9ReceivedAt || null,
        tin: vForm.tin.trim() || null,
        email: vForm.email.trim() || null,
      });
      setVendorOpen(false);
      setVForm(EMPTY_VENDOR);
      setNotice("Vendor saved.");
      await loadAll();
    } catch (err) {
      setError(err.message || "Could not save vendor.");
    } finally {
      setVSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {error ? <ActionFeedback error>{error}</ActionFeedback> : null}
      {notice ? <ActionFeedback>{notice}</ActionFeedback> : null}

      {/* 1. Subledger -> GL Sync */}
      <Card>
        <CardHeader>
          <CardTitle>Subledger Sync to General Ledger (Idempotent)</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-14 text-zinc-600">
            Posts balanced journal entries from Waves invoices, payments, Stripe payouts, expenses, and finalized pay runs into the General Ledger. Re-running skips already-posted items safely.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="sync-from">From</label>
              <Input id="sync-from" type="date" value={syncFrom} onChange={(e) => setSyncFrom(e.target.value)} />
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="sync-to">To</label>
              <Input id="sync-to" type="date" value={syncTo} onChange={(e) => setSyncTo(e.target.value)} />
            </div>
            <Button variant="secondary" loading={syncBusy} onClick={() => handleSync(true)}>Preview Dry Run</Button>
            <Button variant="primary" loading={syncBusy} onClick={() => handleSync(false)}>Sync to GL</Button>
          </div>
          {syncResult ? (
            <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-14 text-zinc-800 space-y-1">
              <div className="font-medium">
                {syncResult.dry_run ? "Dry Run Preview" : "Sync Results"} ({syncResult.from} to {syncResult.to})
              </div>
              {["invoices", "payments", "stripe_payouts", "expenses", "payroll_runs"].map((k) => {
                const b = syncResult[k];
                if (!b) return null;
                return (
                  <div key={k} className="flex flex-wrap gap-3 font-mono text-zinc-700">
                    <span className="w-36 font-sans font-medium">{k.replace("_", " ")}:</span>
                    {syncResult.dry_run
                      ? <span>would post {b.would_post}</span>
                      : <span>posted {b.posted} · skipped {b.skipped} · errors {b.errors.length}</span>}
                  </div>
                );
              })}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* 2. Close & Lock Books */}
      <Card>
        <CardHeader>
          <CardTitle>Close &amp; Lock Accounting Periods</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="lock-month">Month (YYYY-MM)</label>
              <Input id="lock-month" placeholder="2026-10" value={lockMonth} onChange={(e) => setLockMonth(e.target.value)} className="w-40" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="lock-notes">Close / Lock Note</label>
              <Input id="lock-notes" placeholder="e.g. Oct 2026 bank & card statements reconciled" value={lockNotes} onChange={(e) => setLockNotes(e.target.value)} />
            </div>
            <Button variant="secondary" loading={periodBusy} onClick={() => handlePeriodAction(lockMonth, "close", lockNotes)}>
              Soft Close
            </Button>
            <Button variant="primary" loading={periodBusy} onClick={() => handlePeriodAction(lockMonth, "lock", lockNotes)}>
              Lock Period
            </Button>
          </div>

          <Table>
            <THead>
              <TR>
                <TH>Period</TH>
                <TH>Status</TH>
                <TH align="right">Posted JEs</TH>
                <TH>Notes</TH>
                <TH align="right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {periods.length === 0 ? (
                <TR><TD colSpan={5} className="text-center text-zinc-500 py-6">No accounting periods recorded yet.</TD></TR>
              ) : periods.map((p) => (
                <TR key={p.period_month}>
                  <TD className="font-mono font-medium">{p.period_month}</TD>
                  <TD>
                    <Badge tone={p.status === "locked" ? "strong" : p.status === "soft_closed" ? "warn" : "neutral"}>
                      {p.status}
                    </Badge>
                  </TD>
                  <TD className="text-right font-mono">{p.entry_count}</TD>
                  <TD className="text-zinc-600">{p.notes || "—"}</TD>
                  <TD className="text-right space-x-2">
                    {p.status !== "locked" ? (
                      <Button variant="secondary" size="sm" onClick={() => handlePeriodAction(p.period_month, "lock", "Locked via Close Books")}>
                        Lock
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => handlePeriodAction(p.period_month, "reopen", "Reopened for CPA adjustment")}>
                        Reopen
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {/* 3. Vendor Master & 1099-NEC Readiness */}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Vendor Master &amp; {currentYear} 1099-NEC Readiness</CardTitle>
          <div className="flex items-center gap-2">
            {summary1099 ? (
              <Badge tone={summary1099.missing_w9_count > 0 ? "alert" : "neutral"}>
                Threshold: {formatCents(summary1099.threshold_cents)} · Missing W-9s: {summary1099.missing_w9_count}
              </Badge>
            ) : null}
            <Button variant="primary" size="sm" onClick={() => setVendorOpen(true)}>Add Vendor</Button>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="p-6 text-14 text-zinc-500">Loading vendors...</div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Vendor</TH>
                  <TH>Entity Type</TH>
                  <TH>1099 Eligible</TH>
                  <TH>W-9 / TIN</TH>
                </TR>
              </THead>
              <TBody>
                {vendors.length === 0 ? (
                  <TR><TD colSpan={4} className="text-center text-zinc-500 py-6">No vendors added yet.</TD></TR>
                ) : vendors.map((v) => (
                  <TR key={v.id}>
                    <TD>
                      <div className="font-medium text-zinc-900">{v.display_name}</div>
                      {v.legal_name ? <div className="text-14 text-zinc-500">{v.legal_name}</div> : null}
                    </TD>
                    <TD className="text-zinc-600">{v.entity_type}</TD>
                    <TD>{v.is_1099_eligible ? <Badge tone="warn">1099-NEC</Badge> : <Badge tone="neutral">No</Badge>}</TD>
                    <TD className="text-zinc-700">
                      {v.w9_received_at ? `W-9 ${v.w9_received_at}` : "Missing W-9"}
                      {v.tin_last4 ? ` · ***-${v.tin_last4}` : ""}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Dialog open={vendorOpen} onClose={() => setVendorOpen(false)} size="md">
        <form onSubmit={handleCreateVendor}>
          <DialogHeader>
            <DialogTitle>Add Vendor (1099 &amp; W-9 Profile)</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="v-name">Display Name</label>
              <Input id="v-name" required value={vForm.displayName} onChange={(e) => setVForm({ ...vForm, displayName: e.target.value })} />
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="v-legal">Legal Name (per W-9)</label>
              <Input id="v-legal" value={vForm.legalName} onChange={(e) => setVForm({ ...vForm, legalName: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="v-entity">Entity Type</label>
                <Select id="v-entity" value={vForm.entityType} onChange={(e) => setVForm({ ...vForm, entityType: e.target.value })}>
                  {ENTITY_OPTIONS.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
                </Select>
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="v-w9">W-9 Received Date</label>
                <Input id="v-w9" type="date" value={vForm.w9ReceivedAt} onChange={(e) => setVForm({ ...vForm, w9ReceivedAt: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="v-tin">TIN / EIN (Encrypted, optional)</label>
                <Input id="v-tin" placeholder="9 digits" value={vForm.tin} onChange={(e) => setVForm({ ...vForm, tin: e.target.value })} />
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="v-email">Email</label>
                <Input id="v-email" type="email" value={vForm.email} onChange={(e) => setVForm({ ...vForm, email: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="v-1099"
                checked={vForm.is1099Eligible}
                onChange={(e) => setVForm({ ...vForm, is1099Eligible: e.target.checked })}
              />
              <label htmlFor="v-1099" className="text-14 text-zinc-800">Track for Form 1099-NEC reporting</label>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setVendorOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" loading={vSaving}>Save Vendor</Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
