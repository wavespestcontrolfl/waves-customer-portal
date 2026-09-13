// Virginia's admin surface for the business_credentials single source of truth.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Checkbox, Dialog, DialogBody,
  DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, Textarea, UiSurface,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  }).then((response) => {
    if (!response.ok) {
      return response.json().then((body) => {
        throw new Error(body.error || `HTTP ${response.status}`);
      }).catch(() => { throw new Error(`HTTP ${response.status}`); });
    }
    return response.json();
  });
}

const TYPE_LABELS = {
  license: "License",
  insurance: "Insurance",
  certification: "Certification",
  registration: "Registration",
};
const STATUS_LABELS = {
  active: "Active",
  expired: "Expired",
  pending_renewal: "Pending Renewal",
  revoked: "Revoked",
};
const EMPTY_FORM = {
  slug: "", displayName: "", credentialType: "license", issuingAuthority: "",
  credentialNumber: "", holderName: "", issuedDate: "", expirationDate: "",
  status: "active", jurisdictions: "", displayFormatShort: "", displayFormatLong: "",
  displayFormatLegal: "", isPublic: true, sortOrder: 100, notes: "",
};

function daysUntil(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((date.getTime() - Date.now()) / 86400000);
}

function ExpirationBadge({ expirationDate, status }) {
  if (status === "expired") return <Badge tone="alert">Expired</Badge>;
  if (status === "pending_renewal") return <Badge tone="alert">Pending Renewal</Badge>;
  if (status === "revoked") return <Badge tone="neutral">Revoked</Badge>;
  const days = daysUntil(expirationDate);
  if (days == null) return <Badge tone="strong">Active</Badge>;
  if (days < 0) return <Badge tone="alert">Expired</Badge>;
  if (days <= 60) return <Badge tone="alert">{`Expires in ${days}d`}</Badge>;
  return <Badge tone="strong">Active</Badge>;
}

function CredentialForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState(() => {
    if (!initial) return { ...EMPTY_FORM };
    return {
      ...EMPTY_FORM,
      ...initial,
      jurisdictions: (initial.jurisdictions || []).join(", "),
      issuedDate: initial.issuedDate ? String(initial.issuedDate).slice(0, 10) : "",
      expirationDate: initial.expirationDate ? String(initial.expirationDate).slice(0, 10) : "",
    };
  });
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    const payload = { ...form };
    payload.jurisdictions = form.jurisdictions
      ? form.jurisdictions.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
    payload.sortOrder = Number(form.sortOrder) || 100;
    if (!payload.issuedDate) payload.issuedDate = null;
    if (!payload.expirationDate) payload.expirationDate = null;
    onSave(payload);
  };

  return <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
    <DialogBody className="flex-1 space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Slug" required><Input value={form.slug} onChange={(event) => set("slug", event.target.value)} placeholder="fdacs_pest_control" /></Field>
        <Field label="Display Name" required><Input value={form.displayName} onChange={(event) => set("displayName", event.target.value)} placeholder="FDACS Pest Control Operator License" /></Field>
        <Field label="Type" required><Select value={form.credentialType} onChange={(event) => set("credentialType", event.target.value)}>
          {Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select></Field>
        <Field label="Status"><Select value={form.status} onChange={(event) => set("status", event.target.value)}>
          {Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select></Field>
        <Field label="Issuing Authority"><Input value={form.issuingAuthority} onChange={(event) => set("issuingAuthority", event.target.value)} /></Field>
        <Field label="Credential Number" required><Input value={form.credentialNumber} onChange={(event) => set("credentialNumber", event.target.value)} /></Field>
        <Field label="Holder Name"><Input value={form.holderName} onChange={(event) => set("holderName", event.target.value)} /></Field>
        <Field label="Jurisdictions"><Input value={form.jurisdictions} onChange={(event) => set("jurisdictions", event.target.value)} placeholder="FL, GA" /></Field>
        <Field label="Issued Date"><Input type="date" value={form.issuedDate} onChange={(event) => set("issuedDate", event.target.value)} /></Field>
        <Field label="Expiration Date"><Input type="date" value={form.expirationDate} onChange={(event) => set("expirationDate", event.target.value)} /></Field>
        <Field label="Sort Order"><Input type="number" value={form.sortOrder} onChange={(event) => set("sortOrder", event.target.value)} /></Field>
        <div className="flex items-end"><Checkbox id="credential-public" label="Public (surfaces on customer-facing sites)" checked={form.isPublic} onChange={(event) => set("isPublic", event.target.checked)} /></div>
      </div>
      <Field label="Short Display Format"><Input value={form.displayFormatShort} onChange={(event) => set("displayFormatShort", event.target.value)} placeholder="License #JB351547" /></Field>
      <Field label="Long Display Format"><Input value={form.displayFormatLong} onChange={(event) => set("displayFormatLong", event.target.value)} placeholder="FDACS Pest Control License #JB351547" /></Field>
      <Field label="Legal Display Format (public-facing footers)"><Textarea rows={2} value={form.displayFormatLegal} onChange={(event) => set("displayFormatLegal", event.target.value)} placeholder="Licensed and regulated by the Florida Department of Agriculture and Consumer Services, License #JB351547" /></Field>
      <Field label="Notes (admin-only)"><Textarea rows={2} value={form.notes} onChange={(event) => set("notes", event.target.value)} /></Field>
      {error && <ActionFeedback error>{error}</ActionFeedback>}
    </DialogBody>
    <DialogFooter>
      <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      <Button type="submit" loading={saving}>{initial ? "Save changes" : "Create credential"}</Button>
    </DialogFooter>
  </form>;
}

export default function CredentialsPage({ embedded = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const savePending = useRef(false);
  const archivePending = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch("/admin/credentials");
      setRows(data.credentials || []);
      setError(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openForm = (event, row = null) => {
    event.currentTarget.focus({ preventScroll: true });
    setActionError(null);
    setEditing(row);
    setShowForm(true);
  };

  const closeForm = () => {
    if (savePending.current) return;
    setShowForm(false);
    setEditing(null);
    setActionError(null);
  };

  const onSave = async (payload) => {
    if (savePending.current) return;
    savePending.current = true;
    setSaving(true);
    setActionError(null);
    try {
      if (editing) {
        await adminFetch(`/admin/credentials/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await adminFetch("/admin/credentials", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (requestError) {
      setActionError(`Save failed: ${requestError.message}`);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  const openArchive = (event, row) => {
    event.currentTarget.focus({ preventScroll: true });
    setActionError(null);
    setArchiveTarget(row);
  };

  const closeArchive = () => {
    if (archivePending.current) return;
    setArchiveTarget(null);
    setActionError(null);
  };

  const onArchive = async () => {
    if (!archiveTarget || archivePending.current) return;
    const row = archiveTarget;
    archivePending.current = true;
    setSaving(true);
    setActionError(null);
    try {
      await adminFetch(`/admin/credentials/${row.id}`, { method: "DELETE" });
      setArchiveTarget(null);
      await load();
    } catch (requestError) {
      setActionError(`Archive failed: ${requestError.message}`);
    } finally {
      archivePending.current = false;
      setSaving(false);
    }
  };

  const active = rows.filter((row) => !row.archivedAt);
  const archived = rows.filter((row) => row.archivedAt);

  return <UiSurface density="comfortable" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className={embedded ? "text-18 font-medium text-zinc-900" : "text-16 font-medium text-zinc-900"}>Credentials</h2>
      <Button onClick={(event) => openForm(event)}>+ Add Credential</Button>
    </div>
    {error && <div className="flex flex-wrap items-center gap-3"><ActionFeedback error>{error}</ActionFeedback><Button variant="secondary" onClick={load}>Retry</Button></div>}
    {actionError && !showForm && archiveTarget === null && <ActionFeedback error>{actionError}</ActionFeedback>}
    {loading ? <ActionFeedback className="min-h-20">Loading…</ActionFeedback> : <>
      <div className="flex flex-col gap-3">
        {active.length === 0 ? <Card><CardBody>
          <div className="text-ui-body font-medium text-zinc-900">No credentials yet</div>
          <div className="mt-1 text-ui-caption text-ink-secondary">Tap Add Credential to seed your first one.</div>
        </CardBody></Card> : active.map((row) => <Card key={row.id}><CardBody className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex flex-wrap items-center gap-2"><span className="text-ui-body font-medium text-zinc-900">{row.displayName}</span><ExpirationBadge expirationDate={row.expirationDate} status={row.status} />{!row.isPublic && <Badge tone="neutral">Internal</Badge>}</div>
            <div className="mt-1 break-words text-ui-caption text-ink-secondary u-nums">
              {TYPE_LABELS[row.credentialType] || row.credentialType} · {row.credentialNumber}
              {row.expirationDate ? ` · Exp ${String(row.expirationDate).slice(0, 10)}` : ""}
              {row.slug ? ` · ${row.slug}` : ""}
            </div>
          </div>
          <div className="ui-record-actions"><Button variant="secondary" onClick={(event) => openForm(event, row)}>Edit</Button><Button variant="ghost" onClick={(event) => openArchive(event, row)}>Archive</Button></div>
        </CardBody></Card>)}
      </div>
      {archived.length > 0 && <section className="space-y-3" aria-labelledby="archived-credentials-title">
        <h3 id="archived-credentials-title" className="text-14 font-medium text-zinc-900">Archived</h3>
        <div className="flex flex-col gap-3">{archived.map((row) => <Card key={row.id} className="bg-zinc-50"><CardBody>
          <div className="text-ui-body text-zinc-900">{row.displayName}</div>
          <div className="mt-1 break-words text-ui-caption text-ink-secondary u-nums">{row.credentialNumber} · archived {String(row.archivedAt).slice(0, 10)}</div>
        </CardBody></Card>)}</div>
      </section>}
    </>}

    <Dialog open={showForm} onClose={closeForm} size="lg">
      <DialogHeader><DialogTitle>{editing ? "Edit credential" : "Add credential"}</DialogTitle></DialogHeader>
      <CredentialForm key={editing?.id || "new"} initial={editing} onSave={onSave} onCancel={closeForm} saving={saving} error={actionError} />
    </Dialog>

    <Dialog open={archiveTarget !== null} onClose={closeArchive} size="sm">
      <DialogHeader><DialogTitle>Archive credential</DialogTitle></DialogHeader>
      <DialogBody>
        <p className="text-ui-body text-zinc-900">Archive "{archiveTarget?.displayName}"? This is a soft delete — the record stays for audit.</p>
        {actionError && <ActionFeedback error className="mt-4">{actionError}</ActionFeedback>}
      </DialogBody>
      <DialogFooter><Button variant="secondary" onClick={closeArchive} disabled={saving}>Cancel</Button><Button variant="danger" loading={saving} onClick={onArchive}>Archive</Button></DialogFooter>
    </Dialog>
  </UiSurface>;
}
