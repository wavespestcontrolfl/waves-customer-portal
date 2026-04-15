import React, { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

/**
 * JobCostCard — compact per-job profitability + form + timeline.
 *
 * Props:
 *   scheduledServiceId — UUID (required)
 *   dark               — default true
 */
export default function JobCostCard({ scheduledServiceId, dark = true }) {
  const P = dark
    ? { bg: '#1e293b', border: '#334155', text: '#e2e8f0', muted: '#94a3b8', accent: '#0ea5e9', green: '#10b981', red: '#ef4444', amber: '#f59e0b' }
    : { bg: '#fff', border: '#cbd5e1', text: '#0f172a', muted: '#64748b', accent: '#0A7EC2', green: '#16A34A', red: '#C0392B', amber: '#F0A500' };

  const [cost, setCost] = useState(null);
  const [submission, setSubmission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recalcing, setRecalcing] = useState(false);

  useEffect(() => {
    if (!scheduledServiceId) return;
    load();
  }, [scheduledServiceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    try {
      const [cRes, sRes] = await Promise.all([
        adminFetch(`/admin/job-costs?scheduled_service_id=${scheduledServiceId}&limit=1`).then(r => r.json()).catch(() => ({})),
        adminFetch(`/admin/job-forms/submissions?scheduled_service_id=${scheduledServiceId}`).then(r => r.json()).catch(() => ({})),
      ]);
      setCost(cRes.job_costs?.[0] || null);
      setSubmission(sRes.submissions?.[0] || null);
    } finally {
      setLoading(false);
    }
  }

  async function recalc() {
    setRecalcing(true);
    try {
      await adminFetch(`/admin/job-costs/recalc/${scheduledServiceId}`, { method: 'POST' });
      await load();
    } finally {
      setRecalcing(false);
    }
  }

  if (loading) return <div style={{ fontSize: 12, color: P.muted }}>Loading job detail…</div>;

  const fmt = n => n == null ? '—' : `$${Number(n).toFixed(2)}`;
  const marginColor = cost?.margin_pct == null ? P.muted : cost.margin_pct >= 40 ? P.green : cost.margin_pct >= 20 ? P.amber : P.red;

  return (
    <div style={{
      background: P.bg, border: `1px solid ${P.border}`, borderRadius: 10, padding: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: P.text }}>Job Profitability</div>
        <button onClick={recalc} disabled={recalcing} style={{
          background: 'transparent', color: P.accent, border: `1px solid ${P.accent}44`,
          padding: '4px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
        }}>{recalcing ? 'Recalculating…' : 'Recalc'}</button>
      </div>

      {!cost ? (
        <div style={{ fontSize: 12, color: P.muted }}>No cost data yet. Click Recalc.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Stat P={P} label="Revenue" value={fmt(cost.revenue)} />
          <Stat P={P} label="Cost" value={fmt(cost.total_cost)} />
          <Stat P={P} label="Profit" value={fmt(cost.gross_profit)} color={(cost.gross_profit || 0) >= 0 ? P.green : P.red} />
          <Stat P={P} label="Margin" value={cost.margin_pct == null ? '—' : `${Number(cost.margin_pct).toFixed(1)}%`} color={marginColor} />
        </div>
      )}

      {cost && (
        <div style={{ marginTop: 10, fontSize: 11, color: P.muted, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>Labor: {fmt(cost.labor_cost)}</span>
          <span>Products: {fmt(cost.products_cost)}</span>
          {cost.drive_cost > 0 && <span>Drive: {fmt(cost.drive_cost)}</span>}
          {cost.equipment_cost > 0 && <span>Equipment: {fmt(cost.equipment_cost)}</span>}
        </div>
      )}

      {submission && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${P.border}` }}>
          <div style={{ fontSize: 12, color: P.muted, marginBottom: 4 }}>Checklist</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: P.text }}>
            <span>{submission.template_name || 'Form'}</span>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: submission.completion_percent === 100 ? P.green : P.amber,
            }}>{submission.completion_percent ?? 0}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ P, label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: P.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{
        fontSize: 16, fontWeight: 700, color: color || P.text,
        fontFamily: "'JetBrains Mono', monospace", marginTop: 2,
      }}>{value}</div>
    </div>
  );
}
