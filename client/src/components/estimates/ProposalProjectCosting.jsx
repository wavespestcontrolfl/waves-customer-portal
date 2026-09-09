import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Card, CardHeader, CardTitle, CardBody, UiSurface } from '../ui';
import { PROPOSAL_UNITS, COST_CATEGORIES, computeProjectCosts, roundCents } from '@proposal-bid';

const dollars = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export default function ProposalProjectCosting({ value, onChange, totals, disabled }) {
  const costing = value || { revenueYears: 1, rows: [] };
  const summary = computeProjectCosts(costing, totals);
  const update = (index, patch) => onChange({ ...costing, rows: costing.rows.map((row, i) => i === index ? { ...row, ...patch } : row) });
  return <UiSurface as={Card}>
    <CardHeader><CardTitle>Project cost sheet · private</CardTitle></CardHeader>
    <CardBody className="space-y-4 text-14">
      <p className="text-zinc-600">Enter costs for every phase, trip, inspection, and warranty obligation. Labor uses total crew hours. These costs stay in the builder and do not change your quoted prices.</p>
      {costing.rows.map((row, index) => <div key={index} className="space-y-2 border-b border-hairline border-zinc-200 pb-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label>Category<Select aria-label="Cost category" value={row.category} disabled={disabled} onChange={(e) => update(index, { category: e.target.value })}>
            {Object.entries(COST_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select></label>
          <label>Building / phase<Input value={row.phase} maxLength={120} disabled={disabled} onChange={(e) => update(index, { phase: e.target.value })} /></label>
        </div>
        <label className="block">Cost description<Input value={row.description} maxLength={200} disabled={disabled} onChange={(e) => update(index, { description: e.target.value })} /></label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label>Cost quantity<Input type="number" min="0.0001" step="0.0001" value={row.quantity} disabled={disabled} onChange={(e) => update(index, { quantity: e.target.value })} /></label>
          <label>Cost unit<Select aria-label="Cost unit" value={row.unit} disabled={disabled} onChange={(e) => update(index, { unit: e.target.value })}>
            {Object.entries(PROPOSAL_UNITS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </Select></label>
          <label>Cost per unit<Input type="number" min="0" step="0.0001" value={row.unitCost} disabled={disabled} onChange={(e) => update(index, { unitCost: e.target.value })} /></label>
          <label>Occurrences<Input type="number" min="1" max="1000" step="1" value={row.occurrences} disabled={disabled} onChange={(e) => update(index, { occurrences: e.target.value })} /></label>
        </div>
        <div className="flex justify-between items-center gap-2">
          <span className="tabular-nums">Extended cost: {dollars(roundCents(Number(row.quantity) * Number(row.unitCost) * Number(row.occurrences)))}</span>
          {!disabled && <Button variant="ghost" size="sm" onClick={() => onChange({ ...costing, rows: costing.rows.filter((_, i) => i !== index) })}><Trash2 size={14} /> Remove cost</Button>}
        </div>
      </div>)}
      {!disabled && <Button variant="secondary" size="sm" disabled={costing.rows.length >= 100} onClick={() => onChange({ ...costing, rows: [...costing.rows, { category: 'other', phase: '', description: '', quantity: '', unit: 'each', unitCost: '', occurrences: 1 }] })}><Plus size={14} /> Add project cost</Button>}
      <label className="block max-w-xs">Years of recurring revenue to compare<Input type="number" min="1" max="30" step="1" disabled={disabled} value={costing.revenueYears} onChange={(e) => onChange({ ...costing, revenueYears: e.target.value })} /></label>
      <p className="text-zinc-600">Comparison includes one-time revenue plus this many years of recurring revenue, before sales tax. Enter all matching costs and any longer warranty costs above.</p>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
        {[['Revenue', dollars(summary.revenue)], ['Entered costs', dollars(summary.cost)], ['Estimated gross profit', summary.profit == null ? '—' : dollars(summary.profit)], ['Estimated margin', summary.marginPercent == null ? '—' : `${summary.marginPercent}%`]].map(([label, amount]) => <div key={label}><dt className="text-zinc-600">{label}</dt><dd className="font-medium">{amount}</dd></div>)}
      </dl>
      {!summary.costsComplete && <p className="text-zinc-600">Complete the cost rows to see estimated profit and margin.</p>}
    </CardBody>
  </UiSurface>;
}
