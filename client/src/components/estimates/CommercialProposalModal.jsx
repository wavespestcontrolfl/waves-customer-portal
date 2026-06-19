import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  Button, Input, Select, Switch, Textarea, Badge,
} from '../ui';
import { Plus, Trash2, Download, Building2, Loader2 } from 'lucide-react';

// Commercial proposal builder — authors the multi-building, per-line-item
// view of an estimate (e.g. two towers + N lake houses) that renders the
// branded proposal PDF and rides along as the delivery-email attachment.
//
// Tier 1 surface: components/ui primitives + Tailwind zinc ramp only.

const FREQUENCY_OPTIONS = [
  { value: 'monthly', label: 'Monthly', perYear: 12 },
  { value: 'bimonthly', label: 'Every 2 months', perYear: 6 },
  { value: 'quarterly', label: 'Quarterly', perYear: 4 },
  { value: 'annual', label: 'Annual', perYear: 1 },
  { value: 'one_time', label: 'One-time', perYear: 0 },
];
const PER_YEAR = Object.fromEntries(FREQUENCY_OPTIONS.map((f) => [f.value, f.perYear]));

const money = (n) =>
  `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const emptyLine = () => ({
  description: '', quantity: 1, unitPrice: 0, frequency: 'monthly', taxable: false,
});
const emptyBuilding = (i) => ({ name: `Building ${i + 1}`, note: '', lineItems: [emptyLine()] });

// Mirrors server computeProposalTotals so totals update live as you type.
function computeTotals(buildings, taxRate) {
  let annualRecurring = 0, oneTime = 0, taxableAnnual = 0, taxableOneTime = 0;
  for (const b of buildings) {
    for (const li of b.lineItems) {
      const amount = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
      if (li.frequency === 'one_time') {
        oneTime += amount;
        if (li.taxable) taxableOneTime += amount;
      } else {
        const annual = amount * (PER_YEAR[li.frequency] || 0);
        annualRecurring += annual;
        if (li.taxable) taxableAnnual += annual;
      }
    }
  }
  const totalTax = (taxableAnnual + taxableOneTime) * (Number(taxRate) || 0);
  return {
    annualRecurring,
    monthlyEquivalent: annualRecurring / 12,
    oneTime,
    totalTax,
    firstYearTotal: annualRecurring + oneTime + totalTax,
  };
}

export default function CommercialProposalModal({ estimate, adminFetch, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [savedOnce, setSavedOnce] = useState(false);

  const [title, setTitle] = useState('Commercial Service Proposal');
  const [preparedFor, setPreparedFor] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [taxRatePct, setTaxRatePct] = useState('0');
  const [terms, setTerms] = useState('');
  const [buildings, setBuildings] = useState([emptyBuilding(0)]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    adminFetch(`/admin/estimates/${estimate.id}/proposal`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        const p = data.proposal || {};
        setTitle(p.title || 'Commercial Service Proposal');
        setPreparedFor(p.preparedFor || estimate.customerName || '');
        setPropertyAddress(p.propertyAddress || estimate.address || '');
        setTaxRatePct(String(((Number(p.taxRate) || 0) * 100)));
        setTerms(p.terms || '');
        setBuildings(
          Array.isArray(p.buildings) && p.buildings.length
            ? p.buildings.map((b) => ({
                name: b.name || '',
                note: b.note || '',
                lineItems: (b.lineItems || []).map((li) => ({
                  description: li.description || '',
                  quantity: li.quantity ?? 1,
                  unitPrice: li.unitPrice ?? 0,
                  frequency: li.frequency || 'monthly',
                  taxable: li.taxable === true,
                })),
              }))
            : [emptyBuilding(0)],
        );
        // An already-authored proposal means the download is meaningful now.
        setSavedOnce(p.enabled === true);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [estimate.id, estimate.customerName, estimate.address, adminFetch]);

  const taxRate = (Number(taxRatePct) || 0) / 100;
  const totals = useMemo(() => computeTotals(buildings, taxRate), [buildings, taxRate]);

  const mutateBuilding = useCallback((bi, fn) => {
    setBuildings((prev) => prev.map((b, i) => (i === bi ? fn(b) : b)));
  }, []);

  const updateLine = (bi, li, patch) =>
    mutateBuilding(bi, (b) => ({
      ...b,
      lineItems: b.lineItems.map((l, i) => (i === li ? { ...l, ...patch } : l)),
    }));

  const addLine = (bi) => mutateBuilding(bi, (b) => ({ ...b, lineItems: [...b.lineItems, emptyLine()] }));
  const removeLine = (bi, li) =>
    mutateBuilding(bi, (b) => ({ ...b, lineItems: b.lineItems.filter((_, i) => i !== li) }));
  const addBuilding = () => setBuildings((prev) => [...prev, emptyBuilding(prev.length)]);
  const removeBuilding = (bi) => setBuildings((prev) => prev.filter((_, i) => i !== bi));

  const buildPayload = () => ({
    proposal: {
      title: title.trim() || 'Commercial Service Proposal',
      preparedFor: preparedFor.trim(),
      propertyAddress: propertyAddress.trim(),
      taxRate,
      terms: terms.trim() || null,
      buildings: buildings.map((b) => ({
        name: b.name.trim() || 'Building',
        note: b.note.trim() || null,
        lineItems: b.lineItems
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description.trim(),
            quantity: Math.max(1, Math.round(Number(l.quantity) || 1)),
            unitPrice: Number(l.unitPrice) || 0,
            frequency: l.frequency,
            taxable: l.taxable === true,
          })),
      })).filter((b) => b.lineItems.length > 0),
    },
  });

  const save = async () => {
    const payload = buildPayload();
    if (payload.proposal.buildings.length === 0) {
      setError('Add at least one building with a described line item.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await adminFetch(`/admin/estimates/${estimate.id}/proposal`, {
        method: 'PUT',
        body: payload,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `Save failed (${r.status})`);
      }
      setSavedOnce(true);
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const downloadPdf = async () => {
    setDownloading(true);
    setError(null);
    try {
      const r = await adminFetch(`/admin/estimates/${estimate.id}/proposal.pdf`);
      if (!r.ok) throw new Error(`Could not generate PDF (${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open onClose={onClose} size="lg">
      <DialogHeader>
        <DialogTitle>Commercial proposal — {estimate.customerName || 'Estimate'}</DialogTitle>
        <p className="mt-1 text-12 text-zinc-500">
          Per-building line items. Saving recomputes the estimate total and attaches the PDF to its delivery email.
        </p>
      </DialogHeader>

      <DialogBody className="max-h-[65vh] overflow-y-auto space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-13 text-zinc-500 py-8 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading proposal…
          </div>
        ) : (
          <>
            {error && (
              <div className="text-13 text-alert-fg bg-alert-bg border border-hairline border-alert-fg/30 rounded px-3 py-2">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-11 uppercase tracking-label text-zinc-500">Proposal title</span>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
              </label>
              <label className="block">
                <span className="text-11 uppercase tracking-label text-zinc-500">Prepared for</span>
                <Input value={preparedFor} onChange={(e) => setPreparedFor(e.target.value)} className="mt-1" />
              </label>
              <label className="block">
                <span className="text-11 uppercase tracking-label text-zinc-500">Property address</span>
                <Input value={propertyAddress} onChange={(e) => setPropertyAddress(e.target.value)} className="mt-1" />
              </label>
              <label className="block">
                <span className="text-11 uppercase tracking-label text-zinc-500">Tax rate (%) — taxable lines only</span>
                <Input
                  type="number" min="0" step="0.01" value={taxRatePct}
                  onChange={(e) => setTaxRatePct(e.target.value)} className="mt-1"
                />
              </label>
            </div>

            {buildings.map((b, bi) => (
              <div key={bi} className="border border-hairline border-zinc-200 rounded-md">
                <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border-b border-hairline border-zinc-200">
                  <Building2 size={15} className="text-zinc-400" />
                  <Input
                    value={b.name}
                    onChange={(e) => mutateBuilding(bi, (x) => ({ ...x, name: e.target.value }))}
                    className="flex-1" size="sm" placeholder="Building / group name"
                  />
                  {buildings.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => removeBuilding(bi)} title="Remove building">
                      <Trash2 size={15} />
                    </Button>
                  )}
                </div>

                <div className="p-3 space-y-2">
                  {b.lineItems.map((li, lii) => (
                    <div key={lii} className="grid grid-cols-12 gap-2 items-center">
                      <Input
                        className="col-span-5" size="sm" placeholder="Service description"
                        value={li.description}
                        onChange={(e) => updateLine(bi, lii, { description: e.target.value })}
                      />
                      <Input
                        className="col-span-1" size="sm" type="number" min="1" title="Quantity"
                        value={li.quantity}
                        onChange={(e) => updateLine(bi, lii, { quantity: e.target.value })}
                      />
                      <Input
                        className="col-span-2" size="sm" type="number" min="0" step="0.01" title="Unit price"
                        value={li.unitPrice}
                        onChange={(e) => updateLine(bi, lii, { unitPrice: e.target.value })}
                      />
                      <Select
                        className="col-span-2" size="sm" value={li.frequency}
                        onChange={(e) => updateLine(bi, lii, { frequency: e.target.value })}
                      >
                        {FREQUENCY_OPTIONS.map((f) => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </Select>
                      <div className="col-span-1 flex justify-center" title="Taxable line">
                        <Switch
                          checked={li.taxable}
                          onChange={(v) => updateLine(bi, lii, { taxable: v })}
                        />
                      </div>
                      <div className="col-span-1 flex justify-end">
                        {b.lineItems.length > 1 && (
                          <Button variant="ghost" size="sm" onClick={() => removeLine(bi, lii)} title="Remove line">
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => addLine(bi)}>
                    <Plus size={14} /> Add line item
                  </Button>
                </div>
              </div>
            ))}

            <Button variant="secondary" size="sm" onClick={addBuilding}>
              <Plus size={15} /> Add building
            </Button>

            <label className="block">
              <span className="text-11 uppercase tracking-label text-zinc-500">Additional terms (optional)</span>
              <Textarea
                rows={2} value={terms} className="mt-1"
                placeholder="e.g. Net-30 billing to the management company; annual term with 30-day cancellation."
                onChange={(e) => setTerms(e.target.value)}
              />
            </label>

            <div className="rounded-md bg-zinc-50 border border-hairline border-zinc-200 px-4 py-3">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div>
                  <div className="text-11 uppercase tracking-label text-zinc-500">Monthly equiv.</div>
                  <div className="text-16 tabular-nums text-zinc-900">{money(totals.monthlyEquivalent)}</div>
                </div>
                <div>
                  <div className="text-11 uppercase tracking-label text-zinc-500">Annual recurring</div>
                  <div className="text-16 tabular-nums text-zinc-900">{money(totals.annualRecurring)}</div>
                </div>
                <div>
                  <div className="text-11 uppercase tracking-label text-zinc-500">One-time</div>
                  <div className="text-16 tabular-nums text-zinc-900">{money(totals.oneTime)}</div>
                </div>
                <div>
                  <div className="text-11 uppercase tracking-label text-zinc-500">First-year total</div>
                  <div className="text-16 tabular-nums font-medium text-zinc-900">{money(totals.firstYearTotal)}</div>
                </div>
              </div>
              {totals.totalTax > 0 && (
                <div className="mt-2 text-center text-12 text-zinc-500">
                  Includes {money(totals.totalTax)} tax on taxable lines
                </div>
              )}
            </div>
          </>
        )}
      </DialogBody>

      <DialogFooter>
        {savedOnce && (
          <Badge tone="neutral" className="mr-auto self-center">Saved · attaches to email</Badge>
        )}
        <Button variant="ghost" onClick={onClose} disabled={saving}>Close</Button>
        <Button variant="secondary" onClick={downloadPdf} disabled={loading || downloading}>
          {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download PDF
        </Button>
        <Button variant="primary" onClick={save} disabled={loading || saving}>
          {saving ? 'Saving…' : 'Save proposal'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
