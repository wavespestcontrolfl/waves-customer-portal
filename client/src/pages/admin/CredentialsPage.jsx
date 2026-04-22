// client/src/pages/admin/CredentialsPage.jsx
//
// Virginia's admin surface for the business_credentials single source of
// truth (spec §2). Gated behind the `credentials_v1` feature flag; when the
// flag is off we render a "Not available" placeholder so early access stays
// limited to the Waves account during rollout.
//
// Design language follows the monochrome-professional Tier-1 V2 pattern:
// components/ui primitives + Tailwind zinc ramp + hairline borders.
// Red is reserved for action-required states: expired, pending_renewal,
// and expiration within 60 days.

import React, { useState, useEffect, useCallback } from 'react';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { Badge, Button, Card, CardBody, Input, Textarea, Select, Checkbox, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, cn } from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then((r) => {
    if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `HTTP ${r.status}`); }).catch(() => { throw new Error(`HTTP ${r.status}`); });
    return r.json();
  });
}

const TYPE_LABELS = {
  license: 'License',
  insurance: 'Insurance',
  certification: 'Certification',
  registration: 'Registration',
};
const STATUS_LABELS = {
  active: 'Active',
  expired: 'Expired',
  pending_renewal: 'Pending Renewal',
  revoked: 'Revoked',
};

const EMPTY_FORM = {
  slug: '',
  displayName: '',
  credentialType: 'license',
  issuingAuthority: '',
  credentialNumber: '',
  holderName: '',
  issuedDate: '',
  expirationDate: '',
  status: 'active',
  jurisdictions: '',
  displayFormatShort: '',
  displayFormatLong: '',
  displayFormatLegal: '',
  isPublic: true,
  sortOrder: 100,
  notes: '',
};

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

function ExpirationBadge({ expirationDate, status }) {
  if (status === 'expired') return <Badge tone="alert">Expired</Badge>;
  if (status === 'pending_renewal') return <Badge tone="alert">Pending Renewal</Badge>;
  if (status === 'revoked') return <Badge tone="neutral">Revoked</Badge>;
  const days = daysUntil(expirationDate);
  if (days == null) return <Badge tone="strong">Active</Badge>;
  if (days < 0) return <Badge tone="alert">Expired</Badge>;
  if (days <= 60) return <Badge tone="alert">{`Expires in ${days}d`}</Badge>;
  return <Badge tone="strong">Active</Badge>;
}

function CredentialForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState(() => {
    if (!initial) return { ...EMPTY_FORM };
    return {
      ...EMPTY_FORM,
      ...initial,
      jurisdictions: (initial.jurisdictions || []).join(', '),
      issuedDate: initial.issuedDate ? String(initial.issuedDate).slice(0, 10) : '',
      expirationDate: initial.expirationDate ? String(initial.expirationDate).slice(0, 10) : '',
    };
  });
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const submit = () => {
    const payload = { ...form };
    payload.jurisdictions = form.jurisdictions
      ? form.jurisdictions.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    payload.sortOrder = Number(form.sortOrder) || 100;
    if (!payload.issuedDate) payload.issuedDate = null;
    if (!payload.expirationDate) payload.expirationDate = null;
    onSave(payload);
  };

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Slug *</label>
          <Input value={form.slug} onChange={(e) => set('slug', e.target.value)} placeholder="fdacs_pest_control" />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Display Name *</label>
          <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="FDACS Pest Control Operator License" />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Type *</label>
          <Select value={form.credentialType} onChange={(e) => set('credentialType', e.target.value)}>
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Status</label>
          <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Issuing Authority</label>
          <Input value={form.issuingAuthority} onChange={(e) => set('issuingAuthority', e.target.value)} />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Credential Number *</label>
          <Input value={form.credentialNumber} onChange={(e) => set('credentialNumber', e.target.value)} />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Holder Name</label>
          <Input value={form.holderName} onChange={(e) => set('holderName', e.target.value)} />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Jurisdictions</label>
          <Input value={form.jurisdictions} onChange={(e) => set('jurisdictions', e.target.value)} placeholder="FL, GA" />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Issued Date</label>
          <Input type="date" value={form.issuedDate} onChange={(e) => set('issuedDate', e.target.value)} />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Expiration Date</label>
          <Input type="date" value={form.expirationDate} onChange={(e) => set('expirationDate', e.target.value)} />
        </div>
        <div>
          <label className="u-label text-ink-tertiary block mb-1">Sort Order</label>
          <Input type="number" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
        </div>
        <div className="flex items-center gap-2 mt-5">
          <Checkbox checked={form.isPublic} onChange={(e) => set('isPublic', e.target.checked)} />
          <label className="text-13 text-ink-primary">Public (surfaces on customer-facing sites)</label>
        </div>
      </div>

      <div>
        <label className="u-label text-ink-tertiary block mb-1">Short Display Format</label>
        <Input value={form.displayFormatShort} onChange={(e) => set('displayFormatShort', e.target.value)} placeholder="License #JB351547" />
      </div>
      <div>
        <label className="u-label text-ink-tertiary block mb-1">Long Display Format</label>
        <Input value={form.displayFormatLong} onChange={(e) => set('displayFormatLong', e.target.value)} placeholder="FDACS Pest Control License #JB351547" />
      </div>
      <div>
        <label className="u-label text-ink-tertiary block mb-1">Legal Display Format (public-facing footers)</label>
        <Textarea rows={2} value={form.displayFormatLegal} onChange={(e) => set('displayFormatLegal', e.target.value)} placeholder="Licensed and regulated by the Florida Department of Agriculture and Consumer Services, License #JB351547" />
      </div>
      <div>
        <label className="u-label text-ink-tertiary block mb-1">Notes (admin-only)</label>
        <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div className="flex gap-2 justify-end mt-1">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : (initial ? 'Save changes' : 'Create credential')}
        </Button>
      </div>
    </div>
  );
}

export default function CredentialsPage() {
  const flag = useFeatureFlag('credentials_v1');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminFetch('/admin/credentials');
      setRows(d.credentials || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (flag) load(); }, [flag, load]);

  if (!flag) {
    return (
      <div>
        <h1 className="text-28 font-normal tracking-h1 text-ink-primary mb-5">Credentials</h1>
        <Card>
          <CardBody>
            <div className="text-14 text-ink-primary mb-1">Not available</div>
            <div className="text-13 text-ink-tertiary">
              The credentials module is in limited rollout. Contact the admin to enable the <code>credentials_v1</code> flag for your account.
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  const onSave = async (payload) => {
    setSaving(true);
    try {
      if (editing) {
        await adminFetch(`/admin/credentials/${editing.id}`, {
          method: 'PATCH', body: JSON.stringify(payload),
        });
      } else {
        await adminFetch('/admin/credentials', {
          method: 'POST', body: JSON.stringify(payload),
        });
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const onArchive = async (row) => {
    if (!window.confirm(`Archive "${row.displayName}"? This is a soft delete — the record stays for audit.`)) return;
    try {
      await adminFetch(`/admin/credentials/${row.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      alert(`Archive failed: ${e.message}`);
    }
  };

  const active = rows.filter((r) => !r.archivedAt);
  const archived = rows.filter((r) => r.archivedAt);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h1 className="text-28 font-normal tracking-h1 text-ink-primary">Credentials</h1>
        <Button variant="primary" onClick={() => { setEditing(null); setShowForm(true); }}>
          + Add Credential
        </Button>
      </div>

      {error && (
        <Card className="mb-3">
          <CardBody>
            <div className="text-13 text-alert-fg">{error}</div>
          </CardBody>
        </Card>
      )}

      {loading ? (
        <div className="p-10 text-center text-13 text-ink-secondary">Loading…</div>
      ) : (
        <>
          <div className="flex flex-col gap-2 mb-6">
            {active.length === 0 ? (
              <Card>
                <CardBody>
                  <div className="text-14 text-ink-primary mb-1">No credentials yet</div>
                  <div className="text-13 text-ink-tertiary">Tap Add Credential to seed your first one.</div>
                </CardBody>
              </Card>
            ) : active.map((r) => (
              <div
                key={r.id}
                className={cn(
                  'flex items-center gap-3 bg-white border-hairline border-zinc-200 rounded-sm px-4 py-3',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-14 font-medium text-ink-primary">{r.displayName}</span>
                    <ExpirationBadge expirationDate={r.expirationDate} status={r.status} />
                    {!r.isPublic && <Badge tone="neutral">Internal</Badge>}
                  </div>
                  <div className="text-12 text-ink-tertiary mt-1 u-nums">
                    {TYPE_LABELS[r.credentialType] || r.credentialType} · {r.credentialNumber}
                    {r.expirationDate ? ` · Exp ${String(r.expirationDate).slice(0, 10)}` : ''}
                    {r.slug ? ` · ${r.slug}` : ''}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => { setEditing(r); setShowForm(true); }}>Edit</Button>
                <Button variant="ghost" onClick={() => onArchive(r)}>Archive</Button>
              </div>
            ))}
          </div>

          {archived.length > 0 && (
            <div className="mt-6">
              <div className="u-label text-ink-tertiary mb-2">Archived</div>
              <div className="flex flex-col gap-2">
                {archived.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 bg-zinc-50 border-hairline border-zinc-200 rounded-sm px-4 py-3 opacity-70"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-14 text-ink-primary">{r.displayName}</div>
                      <div className="text-12 text-ink-tertiary mt-0.5 u-nums">
                        {r.credentialNumber} · archived {String(r.archivedAt).slice(0, 10)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <Dialog open={showForm} onClose={() => { if (!saving) { setShowForm(false); setEditing(null); } }}>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit credential' : 'Add credential'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <CredentialForm
            initial={editing}
            onSave={onSave}
            onCancel={() => { setShowForm(false); setEditing(null); }}
            saving={saving}
          />
        </DialogBody>
        <DialogFooter />
      </Dialog>
    </div>
  );
}
