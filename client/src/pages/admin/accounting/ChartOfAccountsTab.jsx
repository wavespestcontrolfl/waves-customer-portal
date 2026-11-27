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
import { getJson, postJson, formatCents, ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER } from "./api";

const EMPTY_FORM = {
  code: "",
  name: "",
  accountType: "expense",
  subType: "operating_expense",
  scheduleCLine: "",
  deductiblePct: "100",
  description: "",
};

export default function ChartOfAccountsTab({ onChanged }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  // Register drawer / panel state
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [register, setRegister] = useState(null);
  const [registerLoading, setRegisterLoading] = useState(false);

  // New account modal
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await getJson("/accounts?includeInactive=true");
      setAccounts(res.accounts || []);
    } catch (err) {
      setError(err.message || "Could not load Chart of Accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const openRegister = async (acct) => {
    setSelectedAccount(acct);
    setRegister(null);
    setRegisterLoading(true);
    try {
      const res = await getJson(`/accounts/${acct.id}/register?limit=150`);
      setRegister(res);
    } catch (err) {
      setError(err.message || "Could not load account register.");
    } finally {
      setRegisterLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      await postJson("/accounts", {
        code: form.code.trim(),
        name: form.name.trim(),
        accountType: form.accountType,
        subType: form.subType.trim() || "operating_expense",
        scheduleCLine: form.scheduleCLine.trim() || null,
        deductiblePct: Number(form.deductiblePct),
        description: form.description.trim() || null,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await loadAccounts();
      onChanged?.();
    } catch (err) {
      setSaveError(err.message || "Could not create account.");
    } finally {
      setSaving(false);
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = accounts.filter((a) => {
    if (typeFilter !== "all" && a.account_type !== typeFilter) return false;
    if (!q) return true;
    return `${a.code} ${a.name} ${a.sub_type} ${a.schedule_c_line || ""}`.toLowerCase().includes(q);
  });

  const grouped = ACCOUNT_TYPE_ORDER
    .map((type) => ({ type, items: filtered.filter((a) => a.account_type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder="Filter code, name, or IRS line..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-48">
              <option value="all">All Account Types</option>
              {ACCOUNT_TYPE_ORDER.map((t) => (
                <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>
              ))}
            </Select>
          </div>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>New Account</Button>
        </CardBody>
      </Card>

      {error ? <ActionFeedback error>{error}</ActionFeedback> : null}

      {selectedAccount ? (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              Account Register — {selectedAccount.code} {selectedAccount.name}
            </CardTitle>
            <div className="flex items-center gap-2">
              {register ? (
                <Badge tone="strong">Closing Balance: {formatCents(register.closing_balance_cents)}</Badge>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => setSelectedAccount(null)}>Close Register</Button>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {registerLoading ? (
              <div className="p-6 text-14 text-zinc-500">Loading register...</div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>JE #</TH>
                    <TH>Memo / Vendor</TH>
                    <TH>Status</TH>
                    <TH align="right">Debit</TH>
                    <TH align="right">Credit</TH>
                    <TH align="right">Balance</TH>
                  </TR>
                </THead>
                <TBody>
                  {!register?.transactions?.length ? (
                    <TR><TD colSpan={7} className="text-center text-zinc-500 py-6">No posted entries for this account yet.</TD></TR>
                  ) : register.transactions.map((t) => (
                    <TR key={t.id}>
                      <TD className="whitespace-nowrap">{t.entry_date}</TD>
                      <TD className="font-mono text-zinc-600">#{t.entry_number}</TD>
                      <TD>
                        <div className="text-zinc-900">{t.memo}</div>
                        {t.vendor_name ? <div className="text-14 text-zinc-500">{t.vendor_name}</div> : null}
                      </TD>
                      <TD>
                        {t.reconciled ? <Badge tone="strong">R</Badge> : t.cleared ? <Badge tone="neutral">C</Badge> : null}
                      </TD>
                      <TD className="text-right font-mono">{t.debit_cents ? formatCents(t.debit_cents) : ""}</TD>
                      <TD className="text-right font-mono">{t.credit_cents ? formatCents(t.credit_cents) : ""}</TD>
                      <TD className="text-right font-mono font-medium">{formatCents(t.running_balance_cents)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      ) : null}

      {loading ? (
        <div className="text-14 text-zinc-500 p-4">Loading Chart of Accounts...</div>
      ) : (
        grouped.map(({ type, items }) => (
          <Card key={type}>
            <CardHeader>
              <CardTitle>{ACCOUNT_TYPE_LABELS[type]} ({items.length})</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Code</TH>
                    <TH>Account Name</TH>
                    <TH>Schedule C</TH>
                    <TH align="right">Balance</TH>
                    <TH align="right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((a) => (
                    <TR key={a.id}>
                      <TD className="font-mono text-zinc-600">{a.code}</TD>
                      <TD>
                        <div className="font-medium text-zinc-900">{a.name}</div>
                        {a.description ? <div className="text-14 text-zinc-500">{a.description}</div> : null}
                      </TD>
                      <TD className="text-zinc-600">
                        {a.schedule_c_line ? `Line ${a.schedule_c_line}` : "—"}
                        {a.deductible_pct < 100 ? ` (${a.deductible_pct}%)` : ""}
                      </TD>
                      <TD className="text-right font-mono font-medium">{formatCents(a.balance_cents)}</TD>
                      <TD className="text-right">
                        <Button variant="secondary" size="sm" onClick={() => openRegister(a)}>
                          View Register
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        ))
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} size="md">
        <form onSubmit={handleCreate}>
          <DialogHeader>
            <DialogTitle>Add Account to Chart of Accounts</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {saveError ? <ActionFeedback error>{saveError}</ActionFeedback> : null}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="coa-code">Account Code</label>
                <Input id="coa-code" required placeholder="e.g. 6420" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="coa-type">Account Type</label>
                <Select id="coa-type" value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })}>
                  {ACCOUNT_TYPE_ORDER.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
                </Select>
              </div>
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="coa-name">Account Name</label>
              <Input id="coa-name" required placeholder="e.g. Storage Unit Rent" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="coa-line">Schedule C Line (Optional)</label>
                <Input id="coa-line" placeholder="e.g. 20b" value={form.scheduleCLine} onChange={(e) => setForm({ ...form, scheduleCLine: e.target.value })} />
              </div>
              <div>
                <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="coa-ded">Tax Deductible %</label>
                <Input id="coa-ded" type="number" min="0" max="100" value={form.deductiblePct} onChange={(e) => setForm({ ...form, deductiblePct: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="coa-desc">Description</label>
              <Input id="coa-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" loading={saving}>Create Account</Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
