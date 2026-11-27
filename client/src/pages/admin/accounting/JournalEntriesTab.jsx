import React, { useState, useEffect, useCallback } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
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
import { getJson, postJson, formatCents, parseDollarsToCents } from "./api";

function blankLine() {
  return { accountId: "", debit: "", credit: "", memo: "" };
}

export default function JournalEntriesTab({ onChanged }) {
  const today = etDateString(new Date());
  const [entries, setEntries] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  // New JE dialog
  const [jeOpen, setJeOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(today);
  const [entryType, setEntryType] = useState("adjusting");
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState([blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Quick Transfer dialog
  const [xferOpen, setXferOpen] = useState(false);
  const [xferDate, setXferDate] = useState(today);
  const [xferFrom, setXferFrom] = useState("");
  const [xferTo, setXferTo] = useState("");
  const [xferAmount, setXferAmount] = useState("");
  const [xferMemo, setXferMemo] = useState("Internal bank / credit card transfer");

  // Reverse dialog
  const [reversing, setReversing] = useState(null);
  const [reverseDate, setReverseDate] = useState(today);
  const [reverseReason, setReverseReason] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      const [jeRes, acctRes] = await Promise.all([
        getJson(`/journal-entries${qs}`),
        getJson("/accounts"),
      ]);
      setEntries(jeRes.entries || []);
      setAccounts(acctRes.accounts || []);
    } catch (err) {
      setError(err.message || "Could not load journal entries.");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalDebitCents = lines.reduce((sum, l) => sum + (parseDollarsToCents(l.debit) || 0), 0);
  const totalCreditCents = lines.reduce((sum, l) => sum + (parseDollarsToCents(l.credit) || 0), 0);
  const diffCents = totalDebitCents - totalCreditCents;
  const balanced = totalDebitCents > 0 && diffCents === 0;

  const updateLine = (idx, patch) => {
    setLines((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const handlePostJe = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const payloadLines = lines
        .filter((l) => l.accountId && (parseDollarsToCents(l.debit) || parseDollarsToCents(l.credit)))
        .map((l) => ({
          accountId: l.accountId,
          debitCents: parseDollarsToCents(l.debit) || 0,
          creditCents: parseDollarsToCents(l.credit) || 0,
          memo: l.memo.trim() || null,
        }));
      await postJson("/journal-entries", {
        entryDate,
        entryType,
        memo: memo.trim(),
        reference: reference.trim() || null,
        lines: payloadLines,
      });
      setJeOpen(false);
      setMemo("");
      setReference("");
      setLines([blankLine(), blankLine()]);
      await loadData();
      onChanged?.();
    } catch (err) {
      setFormError(err.message || "Could not post journal entry.");
    } finally {
      setSaving(false);
    }
  };

  const handleQuickTransfer = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const amountCents = parseDollarsToCents(xferAmount);
      await postJson("/quick-transfer", {
        entryDate: xferDate,
        fromAccountId: xferFrom,
        toAccountId: xferTo,
        amountCents,
        memo: xferMemo.trim(),
      });
      setXferOpen(false);
      setXferAmount("");
      await loadData();
      onChanged?.();
    } catch (err) {
      setFormError(err.message || "Could not post transfer.");
    } finally {
      setSaving(false);
    }
  };

  const handleReverse = async (e) => {
    e.preventDefault();
    if (!reversing) return;
    setSaving(true);
    setFormError("");
    try {
      await postJson(`/journal-entries/${reversing.id}/reverse`, {
        reversalDate: reverseDate,
        reason: reverseReason.trim(),
      });
      setReversing(null);
      setReverseReason("");
      await loadData();
      onChanged?.();
    } catch (err) {
      setFormError(err.message || "Could not reverse entry.");
    } finally {
      setSaving(false);
    }
  };

  const bsAccounts = accounts.filter((a) => a.account_type === "asset" || a.account_type === "liability");

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <Input
            placeholder="Search memo or reference..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => { setFormError(""); setXferOpen(true); }}>
              Record Transfer / Card Payment
            </Button>
            <Button variant="primary" onClick={() => { setFormError(""); setJeOpen(true); }}>
              New Journal Entry
            </Button>
          </div>
        </CardBody>
      </Card>

      {error ? <ActionFeedback error>{error}</ActionFeedback> : null}

      <Card>
        <CardHeader>
          <CardTitle>General Journal ({entries.length})</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="p-6 text-14 text-zinc-500">Loading journal entries...</div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>JE #</TH>
                  <TH>Memo &amp; Split Lines</TH>
                  <TH>Type</TH>
                  <TH align="right">Total</TH>
                  <TH align="right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {entries.length === 0 ? (
                  <TR><TD colSpan={6} className="text-center text-zinc-500 py-8">No journal entries posted yet.</TD></TR>
                ) : entries.map((e) => (
                  <TR key={e.id}>
                    <TD className="whitespace-nowrap align-top">{e.entry_date}</TD>
                    <TD className="font-mono text-zinc-600 align-top">#{e.entry_number}</TD>
                    <TD className="align-top">
                      <div className="font-medium text-zinc-900">{e.memo}</div>
                      <div className="mt-1 space-y-0.5 text-14 text-zinc-600">
                        {(e.lines || []).map((l) => (
                          <div key={l.id} className="flex items-center justify-between gap-4">
                            <span>
                              <span className="font-mono text-zinc-500 mr-1.5">{l.account_code}</span>
                              {l.account_name}
                            </span>
                            <span className="font-mono whitespace-nowrap">
                              {l.debit_cents ? `DR ${formatCents(l.debit_cents)}` : `CR ${formatCents(l.credit_cents)}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </TD>
                    <TD className="align-top">
                      <Badge tone={e.reversed_by_entry_id ? "warn" : "neutral"}>
                        {e.reversed_by_entry_id ? "reversed" : e.entry_type}
                      </Badge>
                    </TD>
                    <TD className="text-right font-mono font-medium align-top whitespace-nowrap">
                      {formatCents(e.total_cents)}
                    </TD>
                    <TD className="text-right align-top">
                      {!e.reversed_by_entry_id && e.entry_type !== "reversal" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => { setFormError(""); setReversing(e); setReverseDate(today); }}
                        >
                          Reverse
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* New Balanced Journal Entry Dialog */}
      <Dialog open={jeOpen} onClose={() => setJeOpen(false)} size="lg">
        <form onSubmit={handlePostJe}>
          <DialogHeader>
            <DialogTitle>New Double-Entry Journal Entry</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {formError ? <ActionFeedback error>{formError}</ActionFeedback> : null}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="je-date">Entry Date (ET)</label>
                <Input id="je-date" type="date" required value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="je-type">Entry Type</label>
                <Select id="je-type" value={entryType} onChange={(e) => setEntryType(e.target.value)}>
                  <option value="adjusting">Adjusting Entry</option>
                  <option value="operational">Operational</option>
                  <option value="depreciation">Depreciation</option>
                  <option value="opening_balance">Opening Balance</option>
                  <option value="closing">Period Closing</option>
                </Select>
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="je-ref">Reference</label>
                <Input id="je-ref" placeholder="Optional ref #" value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="je-memo">Memo</label>
              <Input id="je-memo" required placeholder="Describe why this entry is being posted" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-14 font-medium text-zinc-800">Lines</span>
                <Button variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, blankLine()])}>
                  Add Line
                </Button>
              </div>
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                  <div className="sm:col-span-5">
                    <Select
                      aria-label={`Account line ${idx + 1}`}
                      value={line.accountId}
                      onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                    >
                      <option value="">Select account...</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                      ))}
                    </Select>
                  </div>
                  <div className="sm:col-span-3">
                    <Input
                      aria-label={`Debit line ${idx + 1}`}
                      placeholder="Debit $"
                      value={line.debit}
                      onChange={(e) => updateLine(idx, { debit: e.target.value, credit: e.target.value ? "" : line.credit })}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <Input
                      aria-label={`Credit line ${idx + 1}`}
                      placeholder="Credit $"
                      value={line.credit}
                      onChange={(e) => updateLine(idx, { credit: e.target.value, debit: e.target.value ? "" : line.debit })}
                    />
                  </div>
                  <div className="sm:col-span-1 text-right">
                    {lines.length > 2 ? (
                      <Button variant="ghost" size="sm" onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-hairline border-zinc-200 text-14">
              <span>Debits: <strong className="font-mono">{formatCents(totalDebitCents)}</strong></span>
              <span>Credits: <strong className="font-mono">{formatCents(totalCreditCents)}</strong></span>
              <Badge tone={balanced ? "strong" : "alert"}>
                {balanced ? "Balanced ($0.00)" : `Difference: ${formatCents(diffCents)}`}
              </Badge>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setJeOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!balanced} loading={saving}>Post Journal Entry</Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Quick Transfer / Card Payment Dialog */}
      <Dialog open={xferOpen} onClose={() => setXferOpen(false)} size="md">
        <form onSubmit={handleQuickTransfer}>
          <DialogHeader>
            <DialogTitle>Record Internal Transfer or Credit Card Payment</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {formError ? <ActionFeedback error>{formError}</ActionFeedback> : null}
            <p className="text-14 text-zinc-600">
              Moves cash between balance-sheet accounts (e.g., Capital One to Mercury or Credit Card payoff) with zero P&amp;L impact.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="xf-date">Date</label>
                <Input id="xf-date" type="date" required value={xferDate} onChange={(e) => setXferDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="xf-amt">Amount ($)</label>
                <Input id="xf-amt" required placeholder="0.00" value={xferAmount} onChange={(e) => setXferAmount(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="xf-from">From Account (Credit)</label>
              <Select id="xf-from" required value={xferFrom} onChange={(e) => setXferFrom(e.target.value)}>
                <option value="">Select source account...</option>
                {bsAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="xf-to">To Account / Card Paid (Debit)</label>
              <Select id="xf-to" required value={xferTo} onChange={(e) => setXferTo(e.target.value)}>
                <option value="">Select destination account...</option>
                {bsAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="xf-memo">Memo</label>
              <Input id="xf-memo" required value={xferMemo} onChange={(e) => setXferMemo(e.target.value)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setXferOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" loading={saving}>Post Transfer</Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Reversal Confirmation Dialog */}
      <Dialog open={Boolean(reversing)} onClose={() => setReversing(null)} size="sm">
        <form onSubmit={handleReverse}>
          <DialogHeader>
            <DialogTitle>Reverse Journal Entry #{reversing?.entry_number}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {formError ? <ActionFeedback error>{formError}</ActionFeedback> : null}
            <p className="text-14 text-zinc-600">
              Original entries are never deleted. This posts an exact mirror entry swapping debits and credits.
            </p>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rev-date">Reversal Date</label>
              <Input id="rev-date" type="date" required value={reverseDate} onChange={(e) => setReverseDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="rev-reason">Reason</label>
              <Input id="rev-reason" required placeholder="Why is this entry being reversed?" value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setReversing(null)}>Cancel</Button>
            <Button variant="danger" type="submit" loading={saving}>Post Reversal</Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
