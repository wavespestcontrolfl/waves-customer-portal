import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { getAdminUser } from "../../lib/adminAuth";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from "../ui";

const canEditPricing = () => getAdminUser()?.role === "admin";
const API_BASE = import.meta.env.VITE_API_URL || "/api";

const af = (p, o = {}) =>
  fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...o.headers,
    },
  }).then(async (r) => {
    // A 401/403/500 JSON body is not data — throw so a technician's 403 on
    // save is reported instead of reading as success (same as PricingLogicPage).
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });

const TABS = [
  { key: "global", label: "Global constants" },
  { key: "lawn", label: "Lawn care" },
  { key: "pest", label: "Pest control" },
  { key: "tree_shrub", label: "Tree & shrub" },
  { key: "palm", label: "Palm injection" },
  { key: "mosquito", label: "Mosquito" },
  { key: "termite", label: "Termite" },
  { key: "rodent", label: "Rodent" },
  { key: "one_time", label: "One-time" },
  { key: "waveguard", label: "WaveGuard" },
  { key: "products", label: "Products" },
  { key: "proposals", label: "Proposals" },
  { key: "changelog", label: "Changelog" },
];

const formatDate = (value, includeSeconds = false) => value ? new Date(value).toLocaleString(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  second: includeSeconds ? "2-digit" : undefined,
}) : "—";

const formatValue = (value) => {
  if (value == null) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

const prettyJson = (value) => {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
};

function StatusBadge({ status }) {
  // Main: pending amber, approved green, rejected red. The kit has no success
  // tone, so approved keeps the emphasis tone and pending gets its amber back.
  const tone = status === "pending" ? "warn" : status === "approved" ? "strong" : status === "rejected" ? "alert" : "neutral";
  return <Badge tone={tone}>{status || "Unknown"}</Badge>;
}

// Main coloured a changelog category by what it means: bug red, leak amber,
// everything else plain ink.
const CATEGORY_TONES = { bug: "alert", leak: "warn" };

function PercentBadge({ value }) {
  if (value == null) return null;
  const number = Number(value);
  // A 10%+ proposed change is a "look at this" threshold, not a failure — main
  // painted it amber, and alert red is reserved for genuine alerts.
  return <Badge tone={Math.abs(number) >= 10 ? "warn" : "neutral"}>{number > 0 ? "+" : ""}{number.toFixed(1)}%</Badge>;
}

function ChangelogTab() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    setLoading(true);
    const qs = filter === "all" ? "" : `?category=${encodeURIComponent(filter)}`;
    af(`/admin/pricing-config/changelog${qs}`)
      .then((data) => setEntries(data.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [filter]);

  const filterOptions = ["all", "bug", "leak", "rule", "cost", "architecture", "documentation", "infrastructure"];
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-end justify-between gap-3">
        <CardTitle className="text-16">Pricing changelog</CardTitle>
        <Field label="Filter"><Select value={filter} onChange={(event) => setFilter(event.target.value)}>{filterOptions.map((option) => <option key={option} value={option}>{option === "all" ? "All categories" : option}</option>)}</Select></Field>
      </CardHeader>
      <CardBody>
        {loading ? <ActionFeedback>Loading changelog...</ActionFeedback> : entries.length === 0 ? (
          <p className="py-8 text-center text-ink-secondary">No changelog entries{filter !== "all" ? ` for category “${filter}”` : ""} yet.</p>
        ) : (
          <Table className="min-w-[820px]" aria-label="Pricing changelog">
            <THead><TR><TH>Changed at</TH><TH>Version</TH><TH>Category</TH><TH>Summary</TH><TH>Changed by</TH></TR></THead>
            <TBody>{entries.map((entry) => {
              const open = expandedId === entry.id;
              return <React.Fragment key={entry.id}>
                <TR className="cursor-pointer" onClick={() => setExpandedId(open ? null : entry.id)} aria-expanded={open}>
                  <TD nums>{formatDate(entry.changed_at)}</TD><TD nums>{entry.version_from}{entry.version_from !== entry.version_to ? ` → ${entry.version_to}` : ""}</TD><TD><Badge tone={CATEGORY_TONES[entry.category] || "neutral"}>{entry.category}</Badge></TD><TD className="font-medium">{entry.summary}</TD><TD>{entry.changed_by}</TD>
                </TR>
                {open && <TR><TD colSpan="5" className="bg-zinc-50 p-4">
                  <div className="space-y-4">
                    <div><div className="font-medium text-zinc-900">Rationale</div><p className="mt-1 text-ui-body text-zinc-700">{entry.rationale || "—"}</p></div>
                    {Array.isArray(entry.affected_services) && entry.affected_services.length > 0 && <div><div className="font-medium text-zinc-900">Affected services</div><p className="mt-1 text-ui-body text-zinc-700">{entry.affected_services.join(", ")}</p></div>}
                    {(entry.before_value != null || entry.after_value != null) && <div className="grid gap-3 md:grid-cols-2"><JsonBlock title="Before" value={entry.before_value} /><JsonBlock title="After" value={entry.after_value} /></div>}
                  </div>
                </TD></TR>}
              </React.Fragment>;
            })}</TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

function JsonBlock({ title, value }) {
  return <div><div className="mb-1 font-medium text-zinc-900">{title}</div><pre className="max-h-48 overflow-auto rounded-md border-hairline border-zinc-200 bg-white p-3 text-ui-body text-zinc-700 u-nums">{value == null ? "—" : prettyJson(value)}</pre></div>;
}

function ProposalsTab() {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [selected, setSelected] = useState(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const loadProposals = useCallback(() => {
    setLoading(true);
    af(
      `/admin/pricing-proposals?status=${encodeURIComponent(statusFilter)}&limit=50`,
    )
      .then((data) => setProposals(data.proposals || []))
      .catch(() => setProposals([]))
      .finally(() => setLoading(false));
  }, [statusFilter]);
  useEffect(() => { loadProposals(); }, [loadProposals]);

  const openProposal = (proposal) => { setSelected(proposal); setReviewNotes(proposal.review_notes || ""); };
  const submitAction = async (action) => {
    if (!selected) return;
    setSubmitting(true);
    try {
      const response = await af(
        `/admin/pricing-proposals/${selected.id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ review_notes: reviewNotes || null }),
        },
      );
      if (!response?.success) throw new Error(response?.error || "Action failed");
      setFeedback({ error: false, message: action === "approve" ? `Proposal ${selected.id} approved. Changelog id=${response.changelog_id}. Engine caches busted.` : `Proposal ${selected.id} rejected.` });
      setSelected(null); setReviewNotes(""); loadProposals();
    } catch (error) { setFeedback({ error: true, message: error.message || "Action failed" }); }
    finally { setSubmitting(false); setTimeout(() => setFeedback(null), 5000); }
  };

  const statusOptions = ["pending", "approved", "rejected", "all"];
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-16">Pricing proposals</CardTitle>
        <div className="flex flex-wrap gap-2" aria-label="Proposal status">{statusOptions.map((status) => <Button key={status} variant={statusFilter === status ? "primary" : "secondary"} aria-pressed={statusFilter === status} onClick={() => setStatusFilter(status)}>{status[0].toUpperCase() + status.slice(1)}</Button>)}</div>
      </CardHeader>
      <CardBody className="space-y-4">
        {feedback && <ActionFeedback error={feedback.error}>{feedback.message}</ActionFeedback>}
        {loading ? <ActionFeedback>Loading proposals...</ActionFeedback> : proposals.length === 0 ? <p className="py-8 text-center text-ink-secondary">No {statusFilter === "all" ? "" : `${statusFilter} `}proposals.</p> : (
          <Table className="min-w-[900px]" aria-label="Pricing proposals">
            <THead><TR><TH>Config key</TH><TH>Change</TH><TH align="center">% change</TH><TH>Source</TH><TH>Status</TH><TH>Created</TH><TH align="right">Actions</TH></TR></THead>
            <TBody>{proposals.map((proposal) => <TR key={proposal.id} className="cursor-pointer" onClick={() => openProposal(proposal)}>
              <TD nums className="font-medium">{proposal.config_key}</TD><TD nums><span className="text-ink-secondary">{formatValue(proposal.current_value)}</span> → <span className="font-medium">{formatValue(proposal.proposed_value)}</span></TD><TD align="center"><PercentBadge value={proposal.pct_change} /></TD><TD>{proposal.trigger_source || "—"}</TD><TD><StatusBadge status={proposal.status} /></TD><TD nums>{formatDate(proposal.created_at)}</TD><TD align="right">{proposal.status === "pending" && <Button size="sm" onClick={(event) => { event.stopPropagation(); openProposal(proposal); }}>Review</Button>}</TD>
            </TR>)}</TBody>
          </Table>
        )}
      </CardBody>
      <Dialog open={Boolean(selected)} onClose={submitting ? undefined : () => setSelected(null)} size="md">
        {selected && <>
          <DialogHeader><DialogTitle>Proposal #{selected.id}</DialogTitle><StatusBadge status={selected.status} /></DialogHeader>
          <DialogBody className="space-y-4">
            <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui-body">
              <dt className="text-ink-secondary">Config key</dt><dd className="break-words u-nums">{selected.config_key}</dd>
              <dt className="text-ink-secondary">Current</dt><dd className="break-words u-nums">{formatValue(selected.current_value)}</dd>
              <dt className="text-ink-secondary">Proposed</dt><dd className="break-words font-medium u-nums">{formatValue(selected.proposed_value)}</dd>
              <dt className="text-ink-secondary">% change</dt><dd><PercentBadge value={selected.pct_change} />{selected.pct_change == null && "—"}</dd>
              <dt className="text-ink-secondary">Source</dt><dd>{selected.trigger_source || "—"}</dd>
              <dt className="text-ink-secondary">Created</dt><dd className="u-nums">{formatDate(selected.created_at)}</dd>
              {selected.reviewed_at && <><dt className="text-ink-secondary">Reviewed</dt><dd>{formatDate(selected.reviewed_at)} by tech {selected.reviewed_by}</dd></>}
            </dl>
            {selected.evidence && <JsonBlock title="Evidence" value={selected.evidence} />}
            {selected.price_impact && <JsonBlock title="Price impact" value={selected.price_impact} />}
            <Textarea aria-label="Review notes" value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} disabled={selected.status !== "pending" || submitting} placeholder="Optional notes captured with approval/rejection (included in changelog rationale on approve)" rows={4} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setSelected(null)} disabled={submitting}>Close</Button>
            {selected.status === "pending" && canEditPricing() && <>
              <Button variant="danger" loading={submitting} onClick={() => { if (window.confirm(`Reject proposal #${selected.id}? This cannot be undone.`)) submitAction("reject"); }}>Reject</Button>
              <Button loading={submitting} onClick={() => { if (window.confirm(`Approve proposal #${selected.id}?\n\nThis will:\n• UPDATE pricing_config (${selected.config_key})\n• INSERT pricing_changelog entry\n• Bust engine caches (takes effect immediately)`)) submitAction("approve"); }}>{submitting ? "Working..." : "Approve"}</Button>
            </>}
          </DialogFooter>
        </>}
      </Dialog>
    </Card>
  );
}

function EditCell({ value, onSave, type = "number" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const editable = canEditPricing();
  const finish = () => { onSave(type === "number" ? Number(draft) : draft); setEditing(false); };
  if (editing) return <Input autoFocus type={type} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={finish} onKeyDown={(event) => { if (event.key === "Enter") finish(); if (event.key === "Escape") setEditing(false); }} className="min-w-20 text-right u-nums" />;
  return <button type="button" disabled={!editable} onClick={() => { setDraft(value); setEditing(true); }} className="min-h-11 min-w-20 rounded-sm px-2 text-right text-ui-body text-zinc-900 u-focus-ring u-nums enabled:hover:bg-zinc-100 disabled:cursor-default" title={editable ? "Click to edit" : "Read-only — pricing edits are admin-only"}>{typeof value === "number" ? (value < 1 && value > 0 ? `${(value * 100).toFixed(1)}%` : value.toLocaleString(undefined, { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 4 })) : String(value)}</button>;
}

function ConfigCard({ config, onUpdate }) {
  const data = config.data;
  const [expanded, setExpanded] = useState(false);
  const [rawEdit, setRawEdit] = useState(false);
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setAtPath = (object, path, value) => {
    if (!path.length) return value;
    const [head, ...rest] = path;
    const base = Array.isArray(object) ? [...object] : { ...(object || {}) };
    base[head] = setAtPath(base[head], rest, value);
    return base;
  };
  const saveData = async (updated) => {
    setSaving(true); setError("");
    try {
      await af(`/admin/pricing-config/${config.config_key}`, { method: "PUT", body: JSON.stringify({ data: updated }) });
      onUpdate(config.config_key, updated);
      return true;
    } catch (nextError) {
      setError(`Save failed: ${nextError.message}`);
      return false;
    }
    finally { setSaving(false); }
  };
  const handlePathUpdate = (path, value) => saveData(setAtPath(data, path, value));
  const handleRawSave = async () => {
    try { const parsed = JSON.parse(rawText); if (await saveData(parsed)) setRawEdit(false); }
    catch (nextError) { setError(`Save failed: ${nextError.message}`); }
  };

  const renderArray = (array, parentPath = null) => {
    if (array.length === 0) return <p className="text-ink-secondary">Empty</p>;
    const parentKey = Array.isArray(parentPath) && parentPath.length > 0 ? parentPath : null;
    const first = array[0];
    if (typeof first !== "object" || Array.isArray(first)) return <pre className="overflow-auto rounded-md bg-zinc-50 p-3 text-ui-body text-zinc-700 u-nums">{JSON.stringify(array, null, 2)}</pre>;
    const columns = Object.keys(first);
    const updateCell = (rowIndex, column, value) => { if (parentKey) handlePathUpdate(parentKey, array.map((row, index) => index === rowIndex ? { ...row, [column]: value } : row)); };
    const deleteRow = (rowIndex) => { if (parentKey) handlePathUpdate(parentKey, array.filter((_, index) => index !== rowIndex)); };
    const addRow = () => { if (parentKey) handlePathUpdate(parentKey, [...array, Object.fromEntries(columns.map((column) => [column, typeof first[column] === "number" ? 0 : ""]))]); };
    return <div className="space-y-2"><Table className="min-w-[580px]"><THead><TR>{columns.map((column) => <TH key={column}>{column.replace(/_/g, " ")}</TH>)}{parentKey && canEditPricing() && <TH aria-label="Actions" />}</TR></THead><TBody>{array.map((row, rowIndex) => <TR key={`row-${rowIndex}`}>{columns.map((column) => <TD key={column}>{parentKey ? <EditCell value={row[column]} onSave={(value) => updateCell(rowIndex, column, value)} type={typeof row[column] === "number" ? "number" : "text"} /> : formatValue(row[column])}</TD>)}{parentKey && canEditPricing() && <TD align="right"><Button variant="ghost" size="sm" aria-label={`Delete row ${rowIndex + 1}`} onClick={() => deleteRow(rowIndex)}><Trash2 size={16} aria-hidden /></Button></TD>}</TR>)}</TBody></Table>{parentKey && canEditPricing() && <Button variant="secondary" size="sm" onClick={addRow}><Plus size={16} aria-hidden /> Add row</Button>}</div>;
  };

  const renderValue = (key, value, parentPath = []) => {
    const path = [...parentPath, key];
    if (Array.isArray(value)) return <div key={key} className="mb-3 border-l-2 border-zinc-200 pl-3"><div className="mb-2 font-medium capitalize text-zinc-900">{key.replace(/_/g, " ")}</div>{renderArray(value, path)}</div>;
    if (typeof value === "object" && value !== null) return <div key={key} className="mb-3 border-l-2 border-zinc-200 pl-3"><div className="mb-2 font-medium capitalize text-zinc-900">{key.replace(/_/g, " ")}</div>{Object.entries(value).map(([nestedKey, nestedValue]) => renderValue(nestedKey, nestedValue, path))}</div>;
    return <div key={key} className="flex min-h-11 items-center justify-between gap-3 border-b border-zinc-100 py-1"><span className="capitalize text-ink-secondary">{key.replace(/_/g, " ")}</span>{typeof value === "boolean" ? <Switch checked={value} disabled={!canEditPricing()} aria-label={key.replace(/_/g, " ")} onChange={(checked) => handlePathUpdate(path, checked)} /> : <EditCell value={value} onSave={(nextValue) => handlePathUpdate(path, nextValue)} type={typeof value === "number" ? "number" : "text"} />}</div>;
  };

  const isObject = typeof data === "object" && data !== null && !Array.isArray(data);
  return <Card>
    <CardHeader className="flex flex-wrap items-center justify-between gap-3">
      <button type="button" onClick={() => setExpanded(!expanded)} className="flex min-h-11 flex-1 items-center gap-2 text-left text-ui-body font-medium text-zinc-900 u-focus-ring" aria-expanded={expanded}>{expanded ? <ChevronDown size={17} aria-hidden /> : <ChevronRight size={17} aria-hidden />}{config.name}</button>
      <div className="flex items-center gap-2">{saving && <Badge tone="strong">Saving...</Badge>}{expanded && canEditPricing() && <Button variant="secondary" size="sm" onClick={() => { setRawEdit(!rawEdit); if (!rawEdit) setRawText(JSON.stringify(data, null, 2)); }}>{rawEdit ? "Structured" : "Raw JSON"}</Button>}</div>
    </CardHeader>
    {expanded && <CardBody className="space-y-3">{error && <ActionFeedback error>{error}</ActionFeedback>}{rawEdit ? <><Textarea aria-label="Configuration JSON" value={rawText} onChange={(event) => setRawText(event.target.value)} rows={Math.min(20, rawText.split("\n").length + 1)} className="u-nums" /><div className="flex gap-2"><Button onClick={handleRawSave} loading={saving}>Save</Button><Button variant="secondary" onClick={() => setRawEdit(false)}>Cancel</Button></div></> : isObject ? <div>{Object.entries(data).map(([key, value]) => renderValue(key, value))}</div> : Array.isArray(data) ? renderArray(data) : <pre className="overflow-auto rounded-md bg-zinc-50 p-3 text-ui-body text-zinc-700 u-nums">{JSON.stringify(data, null, 2)}</pre>}</CardBody>}
  </Card>;
}

function LawnBracketsTab() {
  const [tracks, setTracks] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeTrack, setActiveTrack] = useState("st_augustine");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const tiers = ["standard", "enhanced", "premium"];
  const trackLabels = { st_augustine: "St. Augustine", bermuda: "Bermuda", zoysia: "Zoysia", bahia: "Bahia" };
  useEffect(() => { af("/admin/pricing-config/lawn-brackets").then((data) => setTracks(data.tracks || {})).catch(() => {}).finally(() => setLoading(false)); }, []);
  const handleCellUpdate = async (sqft, tier, newPrice) => {
    const updated = (tracks[activeTrack] || []).map((row) => row.sqft_bracket === sqft && row.tier === tier ? { ...row, monthly_price: newPrice } : row);
    setTracks((previous) => ({ ...previous, [activeTrack]: updated })); setSaving(true); setError("");
    try { await af(`/admin/pricing-config/lawn-brackets/${activeTrack}`, {
        method: "PUT",
        body: JSON.stringify({
          brackets: [{ sqft_bracket: sqft, tier, monthly_price: newPrice }],
        }),
      }); }
    catch (nextError) { setError(`Save failed: ${nextError.message}`); }
    finally { setSaving(false); }
  };
  if (loading) return <ActionFeedback>Loading brackets...</ActionFeedback>;
  const trackKeys = Object.keys(tracks);
  if (trackKeys.length === 0) return <ActionFeedback>No bracket data found. Run the pricing_config migration first.</ActionFeedback>;
  const trackData = tracks[activeTrack] || [];
  const squareFootBrackets = [...new Set(trackData.map((row) => row.sqft_bracket))].sort((a, b) => a - b);
  return <Card><CardHeader className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-16">Monthly price brackets</CardTitle>{saving && <Badge tone="strong">Saving...</Badge>}</CardHeader><CardBody className="space-y-4">
    {error && <ActionFeedback error>{error}</ActionFeedback>}
    <div className="flex flex-wrap gap-2" aria-label="Lawn type">{trackKeys.map((track) => <Button key={track} variant={activeTrack === track ? "primary" : "secondary"} aria-pressed={activeTrack === track} onClick={() => setActiveTrack(track)}>{trackLabels[track] || track}</Button>)}</div>
    <Table className="min-w-[650px]" aria-label="Monthly lawn price brackets"><THead><TR><TH>Lawn SqFt</TH>{tiers.map((tier) => <TH key={tier} align="right">{tier === "standard" ? "6 applications / yr" : tier === "enhanced" ? "9 applications / yr" : "12 applications / yr"}</TH>)}</TR></THead><TBody>{squareFootBrackets.map((squareFeet) => <TR key={squareFeet}><TD nums>{squareFeet.toLocaleString()}</TD>{tiers.map((tier) => { const row = trackData.find((item) => item.sqft_bracket === squareFeet && item.tier === tier); return <TD key={tier} align="right"><span className="mr-1 text-ink-secondary">$</span><EditCell value={row ? Number(row.monthly_price) : 0} onSave={(value) => handleCellUpdate(squareFeet, tier, value)} /></TD>; })}</TR>)}</TBody></Table>
  </CardBody></Card>;
}

function DiscountRulesTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { af("/admin/pricing-config/discount-rules").then((data) => setRules(data.rules || [])).catch(() => {}).finally(() => setLoading(false)); }, []);
  const handleUpdate = async (serviceKey, field, value) => {
    setRules((previous) => previous.map((rule) => rule.service_key === serviceKey ? { ...rule, [field]: value } : rule)); setError("");
    try { await af(`/admin/pricing-config/discount-rules/${serviceKey}`, {
        method: "PUT",
        body: JSON.stringify({ [field]: value }),
      }); }
    catch (nextError) { setError(`Save failed: ${nextError.message}`); }
  };
  if (loading) return <ActionFeedback>Loading discount rules...</ActionFeedback>;
  if (rules.length === 0) return <ActionFeedback>No discount rules found. Run the pricing_config migration.</ActionFeedback>;
  return <Card><CardHeader><CardTitle className="text-16">Service discount rules</CardTitle></CardHeader><CardBody className="space-y-3">{error && <ActionFeedback error>{error}</ActionFeedback>}<Table className="min-w-[900px]" aria-label="Service discount rules"><THead><TR><TH>Service</TH><TH align="center">Tier qualifier</TH><TH align="center">Max discount</TH><TH align="center">Exclude %</TH><TH align="center">Flat credit</TH><TH align="center">Min tier</TH><TH>Notes</TH></TR></THead><TBody>{rules.map((rule) => <TR key={rule.service_key}><TD className="font-medium capitalize">{rule.service_key.replace(/_/g, " ")}</TD><TD align="center"><Switch checked={rule.tier_qualifier} disabled={!canEditPricing()} aria-label={`${rule.service_key} tier qualifier`} onChange={(value) => handleUpdate(rule.service_key, "tier_qualifier", value)} /></TD><TD align="center">{rule.max_discount_pct != null ? <EditCell value={Number(rule.max_discount_pct)} onSave={(value) => handleUpdate(rule.service_key, "max_discount_pct", value)} /> : "—"}</TD><TD align="center"><Switch checked={rule.exclude_from_pct_discount} disabled={!canEditPricing()} aria-label={`${rule.service_key} exclude from percent discount`} onChange={(value) => handleUpdate(rule.service_key, "exclude_from_pct_discount", value)} /></TD><TD align="center">{rule.flat_credit ? <EditCell value={Number(rule.flat_credit)} onSave={(value) => handleUpdate(rule.service_key, "flat_credit", value)} /> : "—"}</TD><TD align="center" className="capitalize">{rule.flat_credit_min_tier || "—"}</TD><TD className="max-w-[240px] truncate text-ink-secondary" title={rule.notes || ""}>{rule.notes || "—"}</TD></TR>)}</TBody></Table></CardBody></Card>;
}

function ProductsTab() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { af("/admin/inventory?limit=200").then((data) => setProducts(data.products || [])).catch(() => {}).finally(() => setLoading(false)); }, []);
  if (loading) return <ActionFeedback>Loading products...</ActionFeedback>;
  const pricedProducts = products.filter((product) => product.best_price > 0).sort((a, b) => (a.category || "").localeCompare(b.category || ""));
  return <Card><CardHeader><CardTitle className="text-16">Product cost reference</CardTitle><p className="mt-1 text-ui-body text-ink-secondary">{products.length} products loaded. Full catalog available under Inventory tab.</p></CardHeader><CardBody><Table className="min-w-[760px]" aria-label="Product cost reference"><THead><TR><TH>Product</TH><TH>Category</TH><TH>Active ingredient</TH><TH align="right">Best price</TH><TH align="right">Unit price</TH></TR></THead><TBody>{pricedProducts.map((product) => <TR key={product.id}><TD className="font-medium">{product.product_name || product.name}</TD><TD>{product.category}</TD><TD className="max-w-[220px] truncate text-ink-secondary" title={product.active_ingredient || ""}>{product.active_ingredient || "—"}</TD><TD align="right" nums>${Number(product.best_price || 0).toFixed(2)}</TD><TD align="right" nums>{product.unit_price ? `$${Number(product.unit_price).toFixed(4)}` : "—"}</TD></TR>)}</TBody></Table></CardBody></Card>;
}

function AuditLog() {
  const [logs, setLogs] = useState([]);
  useEffect(() => { af("/admin/pricing-config/audit-log?limit=30").then((data) => setLogs(data.logs || [])).catch(() => {}); }, []);
  if (logs.length === 0) return null;
  return <Card><CardHeader><CardTitle className="text-16">Recent changes</CardTitle></CardHeader><CardBody className="divide-y divide-zinc-200">{logs.map((log, index) => <div key={`${log.config_key}-${log.changed_at}-${index}`} className="py-2 text-ui-body text-ink-secondary"><span className="font-medium text-zinc-900 u-nums">{log.config_key}</span> changed by <span className="text-zinc-900">{log.changed_by || "admin"}</span> — <span className="u-nums">{formatDate(log.changed_at, true)}</span>{log.reason && <span> ({log.reason})</span>}</div>)}</CardBody></Card>;
}

export default function PricingLogicPanel() {
  const [activeTab, setActiveTab] = useState("global");
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { af("/admin/pricing-config").then((data) => setConfigs(data.configs || [])).catch(() => {}).finally(() => setLoading(false)); }, []);
  const handleConfigUpdate = useCallback((key, data) => setConfigs((previous) => previous.map((config) => config.config_key === key ? { ...config, data } : config)), []);
  const filteredConfigs = configs.filter((config) => config.category === activeTab);
  const specialTab = ["products", "proposals", "changelog"].includes(activeTab);
  const sectionLabel = TABS.find((tab) => tab.key === activeTab)?.label || activeTab;
  return <div className="space-y-5 text-ui-body text-ink-primary">
    <div className="flex flex-wrap gap-2" aria-label="Pricing configuration category">{TABS.map((tab) => <Button key={tab.key} variant={activeTab === tab.key ? "primary" : "secondary"} aria-pressed={activeTab === tab.key} onClick={() => setActiveTab(tab.key)}>{tab.label}</Button>)}</div>
    {loading ? <ActionFeedback className="min-h-20">Loading pricing configuration...</ActionFeedback> : <>
      {activeTab === "lawn" && <LawnBracketsTab />}
      {activeTab === "waveguard" && <DiscountRulesTab />}
      {activeTab === "products" && <ProductsTab />}
      {activeTab === "proposals" && <ProposalsTab />}
      {activeTab === "changelog" && <ChangelogTab />}
      {!specialTab && filteredConfigs.length > 0 && <div className="space-y-3"><h2 className="text-18 font-medium text-zinc-900">{activeTab === "waveguard" ? "Tier configuration" : activeTab === "lawn" ? "Lawn pricing config" : `${sectionLabel} configuration`}</h2>{filteredConfigs.map((config) => <ConfigCard key={config.config_key} config={config} onUpdate={handleConfigUpdate} />)}</div>}
      {!specialTab && filteredConfigs.length === 0 && activeTab !== "lawn" && activeTab !== "waveguard" && <ActionFeedback>No configuration data for this category yet. Run the pricing_config migration to seed data.</ActionFeedback>}
      {["global", "waveguard", "lawn"].includes(activeTab) && <AuditLog />}
    </>}
  </div>;
}
