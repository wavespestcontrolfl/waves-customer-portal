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
import { getJson, postJson, patchJson, deleteJson, formatCents, parseDollarsToCents } from "./api";

const RECONCILABLE_SUB_TYPES = new Set([
  "checking", "savings", "stripe_clearing", "undeposited_funds", "credit_card", "loan_payable",
]);

export default function ReconcileTab({ onChanged }) {
  const today = etDateString(new Date());
  const [accounts, setAccounts] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Start form
  const [accountId, setAccountId] = useState("");
  const [endDate, setEndDate] = useState(today);
  const [endingBalance, setEndingBalance] = useState("");

  // Edit in-progress statement form
  const [editingStmt, setEditingStmt] = useState(false);
  const [editEndDate, setEditEndDate] = useState("");
  const [editEndingBalance, setEditEndingBalance] = useState("");

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [acctRes, recRes] = await Promise.all([
        getJson("/accounts"),
        getJson("/reconciliations"),
      ]);
      const reconcilable = (acctRes.accounts || []).filter((a) => RECONCILABLE_SUB_TYPES.has(a.sub_type));
      setAccounts(reconcilable);
      setReconciliations(recRes.reconciliations || []);
      if (!accountId && reconcilable.length) setAccountId(reconcilable[0].id);
    } catch (err) {
      setError(err.message || "Could not load reconciliations.");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openWorkspace = async (recId) => {
    setBusy(true);
    setError("");
    try {
      const ws = await getJson(`/reconciliations/${recId}`);
      setWorkspace(ws);
    } catch (err) {
      setError(err.message || "Could not open reconciliation.");
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const endingBalanceCents = parseDollarsToCents(endingBalance);
      if (endingBalanceCents === null) throw new Error("Enter a valid statement ending balance.");
      const ws = await postJson("/reconciliations", {
        accountId,
        statementEndDate: endDate,
        endingBalanceCents,
      });
      setWorkspace(ws);
      setEndingBalance("");
      await loadList();
    } catch (err) {
      setError(err.message || "Could not start reconciliation.");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleLine = async (lineId, nextCleared) => {
    if (!workspace) return;
    setBusy(true);
    setError("");
    try {
      const ws = await patchJson(`/reconciliations/${workspace.reconciliation.id}/lines`, {
        lineIds: [lineId],
        cleared: nextCleared,
      });
      setWorkspace(ws);
    } catch (err) {
      setError(err.message || "Could not update cleared status.");
    } finally {
      setBusy(false);
    }
  };

  const openEditStatement = () => {
    if (!workspace) return;
    setEditEndDate(workspace.reconciliation.statement_end_date || today);
    setEditEndingBalance((Number(workspace.reconciliation.ending_balance_cents || 0) / 100).toFixed(2));
    setEditingStmt(true);
    setError("");
  };

  const handleSaveStatement = async (e) => {
    e.preventDefault();
    if (!workspace) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const endingBalanceCents = parseDollarsToCents(editEndingBalance);
      if (endingBalanceCents === null) throw new Error("Enter a valid statement ending balance.");
      const ws = await patchJson(`/reconciliations/${workspace.reconciliation.id}`, {
        statementEndDate: editEndDate,
        endingBalanceCents,
      });
      setWorkspace(ws);
      setEditingStmt(false);
      setSuccess("Statement details updated.");
      await loadList();
    } catch (err) {
      setError(err.message || "Could not update statement details.");
    } finally {
      setBusy(false);
    }
  };

  const handleCancelSession = async () => {
    if (!workspace) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await deleteJson(`/reconciliations/${workspace.reconciliation.id}`, {
        reason: "Canceled unfinished reconciliation session",
      });
      setWorkspace(null);
      setEditingStmt(false);
      setSuccess("In-progress reconciliation canceled and cleared lines released.");
      await loadList();
    } catch (err) {
      setError(err.message || "Could not cancel reconciliation.");
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    if (!workspace) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const ws = await postJson(`/reconciliations/${workspace.reconciliation.id}/finish`, {});
      setWorkspace(ws);
      setSuccess("Statement reconciliation finalized and locked.");
      await loadList();
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not finalize reconciliation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error ? <ActionFeedback error>{error}</ActionFeedback> : null}
      {success ? <ActionFeedback>{success}</ActionFeedback> : null}

      {workspace ? (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>
                Reconcile: {workspace.account.code} {workspace.account.name} (Statement Ending {workspace.reconciliation.statement_end_date})
              </CardTitle>
              <div className="mt-1 flex flex-wrap gap-4 text-14 text-zinc-600">
                <span>Opening: <strong className="font-mono text-zinc-900">{formatCents(workspace.reconciliation.opening_balance_cents)}</strong></span>
                <span>Statement Ending: <strong className="font-mono text-zinc-900">{formatCents(workspace.reconciliation.ending_balance_cents)}</strong></span>
                <span>Cleared Balance: <strong className="font-mono text-zinc-900">{formatCents(workspace.reconciliation.cleared_balance_cents)}</strong></span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={workspace.reconciliation.difference_cents === 0 ? "strong" : "alert"}>
                Difference: {formatCents(workspace.reconciliation.difference_cents)}
              </Badge>
              {workspace.reconciliation.status === "in_progress" ? (
                <>
                  <Button
                    variant="primary"
                    disabled={workspace.reconciliation.difference_cents !== 0}
                    loading={busy}
                    onClick={handleFinish}
                  >
                    Finish Reconciliation
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={openEditStatement}>
                    Edit Statement
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={handleCancelSession}>
                    Cancel Session
                  </Button>
                </>
              ) : (
                <Badge tone="strong">Reconciled</Badge>
              )}
              <Button variant="secondary" onClick={() => { setWorkspace(null); setEditingStmt(false); }}>Back to List</Button>
            </div>
          </CardHeader>
          {editingStmt && workspace.reconciliation.status === "in_progress" ? (
            <div className="border-b border-hairline border-zinc-200 bg-zinc-50 px-5 py-3">
              <form onSubmit={handleSaveStatement} className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rec-edit-date">Statement Ending Date</label>
                  <Input id="rec-edit-date" type="date" required value={editEndDate} onChange={(e) => setEditEndDate(e.target.value)} />
                </div>
                <div>
                  <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rec-edit-end">Statement Ending Balance ($)</label>
                  <Input id="rec-edit-end" required value={editEndingBalance} onChange={(e) => setEditEndingBalance(e.target.value)} />
                </div>
                <Button variant="primary" type="submit" loading={busy}>Save Statement</Button>
                <Button variant="secondary" type="button" onClick={() => setEditingStmt(false)}>Cancel</Button>
              </form>
            </div>
          ) : null}
          <CardBody className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Cleared</TH>
                  <TH>Date</TH>
                  <TH>JE #</TH>
                  <TH>Memo</TH>
                  <TH align="right">Debit</TH>
                  <TH align="right">Credit</TH>
                </TR>
              </THead>
              <TBody>
                {workspace.lines.length === 0 ? (
                  <TR><TD colSpan={6} className="text-center text-zinc-500 py-6">No uncleared lines on or before {workspace.reconciliation.statement_end_date}.</TD></TR>
                ) : workspace.lines.map((line) => (
                  <TR key={line.id}>
                    <TD>
                      <Checkbox
                        aria-label={`Clear JE #${line.entry_number}`}
                        checked={line.cleared}
                        disabled={busy || workspace.reconciliation.status !== "in_progress"}
                        onChange={(e) => handleToggleLine(line.id, e.target.checked)}
                      />
                    </TD>
                    <TD className="whitespace-nowrap">{line.entry_date}</TD>
                    <TD className="font-mono text-zinc-600">#{line.entry_number}</TD>
                    <TD>{line.memo}</TD>
                    <TD className="text-right font-mono">{line.debit_cents ? formatCents(line.debit_cents) : ""}</TD>
                    <TD className="text-right font-mono">{line.credit_cents ? formatCents(line.credit_cents) : ""}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Start New Statement Reconciliation</CardTitle>
            </CardHeader>
            <CardBody>
              <form onSubmit={handleStart} className="flex flex-wrap items-end gap-3">
                <div className="min-w-[240px]">
                  <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rec-acct">Account</label>
                  <Select id="rec-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </Select>
                </div>
                <div>
                  <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rec-date">Statement Ending Date</label>
                  <Input id="rec-date" type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
                <div>
                  <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rec-end">Statement Ending Balance ($)</label>
                  <Input id="rec-end" required placeholder="0.00" value={endingBalance} onChange={(e) => setEndingBalance(e.target.value)} />
                </div>
                <Button variant="primary" type="submit" loading={busy}>Start Reconciling</Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reconciliation History</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              {loading ? (
                <div className="p-6 text-14 text-zinc-500">Loading reconciliations...</div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Account</TH>
                      <TH>Statement End</TH>
                      <TH>Status</TH>
                      <TH align="right">Ending Balance</TH>
                      <TH align="right">Difference</TH>
                      <TH align="right">Action</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {reconciliations.length === 0 ? (
                      <TR><TD colSpan={6} className="text-center text-zinc-500 py-6">No statement reconciliations recorded yet.</TD></TR>
                    ) : reconciliations.map((r) => (
                      <TR key={r.id}>
                        <TD><span className="font-mono text-zinc-500 mr-2">{r.account_code}</span>{r.account_name}</TD>
                        <TD className="whitespace-nowrap">{r.statement_end_date}</TD>
                        <TD>
                          <Badge tone={r.status === "reconciled" ? "strong" : "warn"}>
                            {r.status}
                          </Badge>
                        </TD>
                        <TD className="text-right font-mono">{formatCents(r.ending_balance_cents)}</TD>
                        <TD className="text-right font-mono">{formatCents(r.difference_cents)}</TD>
                        <TD className="text-right">
                          <Button variant="secondary" size="sm" onClick={() => openWorkspace(r.id)}>
                            {r.status === "in_progress" ? "Resume" : "View"}
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
