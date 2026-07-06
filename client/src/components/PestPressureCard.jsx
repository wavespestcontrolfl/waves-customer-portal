import { useEffect, useMemo, useState } from 'react';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { CheckCircle2 } from 'lucide-react';
import {
  MAX_SCORE,
  MeterSvg,
  PressureHistoryChart,
  TrendChip,
  formatGaugeDate as formatDate,
} from './report/GaugePrimitives';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * Customer-facing Pest Pressure card.
 *
 * Data comes from the report API's `pestPressure` field (built by
 * server/services/pest-pressure/customer-view.js). When the field is
 * null (feature disabled or showOnCustomerReport is false), the card
 * renders nothing. When dataCompleteness is "insufficient", it shows
 * a polite placeholder instead of a misleading number.
 *
 * Accessibility:
 * - The meter is an SVG with role="img" + an aria-label that includes
 *   the numeric score, label, and trend so screen readers don't depend
 *   on visual position.
 * - The numeric score and label are always rendered as text — color
 *   never carries information alone.
 * - The trend chip uses an icon + word, not color alone.
 */

function ComponentsTable({ components }) {
  if (!components || typeof components !== 'object') return null;
  const labelByKey = {
    clientRating: 'Client-reported activity',
    technicianRating: 'Technician observations',
    reServiceImpact: 'Re-services / callbacks',
    recurringIssueRating: 'Recurring issue areas',
    riskFactorRating: 'Risk factors / conditions',
  };
  const rows = Object.entries(components).map(([key, c]) => ({
    key,
    label: labelByKey[key] || key,
    value: c && c.present ? Number(c.value) : null,
    weight: c ? Number(c.weight) : 0,
  }));
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#64748B', fontWeight: 600 }}>
          <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB' }}>Component</th>
          <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB', textAlign: 'right' }}>Rating</th>
          <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB', textAlign: 'right' }}>Weight</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} style={{ borderBottom: '1px solid #F1F5F9' }}>
            <td style={{ padding: '6px 4px', color: CUSTOMER_SURFACE.text }}>{row.label}</td>
            <td style={{ padding: '6px 4px', textAlign: 'right', color: row.value === null ? '#94A3B8' : CUSTOMER_SURFACE.text, fontFamily: "'JetBrains Mono', monospace" }}>
              {row.value === null ? '—' : row.value.toFixed(1)}
            </td>
            <td style={{ padding: '6px 4px', textAlign: 'right', color: '#64748B', fontFamily: "'JetBrains Mono', monospace" }}>
              {row.weight}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClientRatingPicker({ token, question, onSubmitted }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (rating) => {
    if (submitting || !token) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/reports/${token}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (onSubmitted) onSubmitted(body.pestPressure);
    } catch (err) {
      setError(err.message || 'Could not submit rating');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      marginTop: 12, marginBottom: 4, padding: 14,
      background: CUSTOMER_SURFACE.page, border: `1px solid ${CUSTOMER_SURFACE.border}`, borderRadius: 10,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 }}>
        Help us calibrate your Pest Pressure score
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: CUSTOMER_SURFACE.text, marginBottom: 8 }}>
        {question}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Rating ${n} out of 5`}
            disabled={submitting}
            onClick={() => submit(n)}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 10,
              border: '1px solid #CFE7F5', background: '#F8FCFE',
              color: '#0B3A66', fontSize: 15, fontWeight: 600, lineHeight: 1,
              cursor: submitting ? 'wait' : 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {n}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: CUSTOMER_SURFACE.muted, marginTop: 8 }}>
        0 = no activity · 5 = severe activity
      </div>
      {error ? (
        <div style={{ fontSize: 12, color: '#991B1B', marginTop: 8 }}>{error}</div>
      ) : null}
    </div>
  );
}

function SubmittedRatingNote() {
  return (
    <div style={{
      marginTop: 12, padding: 10,
      background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8,
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#15803D',
    }}>
      <CheckCircle2 size={14} aria-hidden="true" />
      <span>Thanks — your feedback helps us compare technician findings with what you are seeing at home.</span>
    </div>
  );
}

export default function PestPressureCard({ data, token }) {
  const [override, setOverride] = useState(null);
  // Reset the post-submit override whenever the report token changes —
  // in React Router v6 the same component instance can be reused across
  // `/report/:token` param changes, which would otherwise leak a stale
  // override (with `canCaptureClientRating: false`) into the next
  // report and hide its picker. Clearing on token transition restores
  // the next report's server payload as the source of truth.
  useEffect(() => {
    setOverride(null);
  }, [token]);
  const effective = override || data;

  // Pre-compute date once (avoid recompute on hover/expand).
  const dateText = useMemo(() => formatDate(effective && effective.date), [effective]);

  if (!effective) return null;
  if (effective.enabled === false || effective.showOnCustomerReport === false) return null;

  const isInsufficient = effective.dataCompleteness === 'insufficient' || effective.score === null || effective.score === undefined;
  const scoreNum = isInsufficient ? null : Number(effective.score);
  const labelName = effective.label || (effective.labelKey ? effective.labelKey.replace('_', ' ') : null);

  return (
    <section
      id="pest-pressure"
      data-section="pest-pressure"
      data-glass="card"
      style={{
        background: '#FFFFFF',
        border: `1px solid ${CUSTOMER_SURFACE.border}`,
        borderRadius: 14,
        padding: 24,
        margin: '0 0 16px',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: CUSTOMER_SURFACE.text,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: CUSTOMER_SURFACE.muted, fontWeight: 600 }}>
            Pest Pressure
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, color: CUSTOMER_SURFACE.text }}>
            {isInsufficient ? 'Pest Pressure is being calculated' : `${labelName || 'Score'} — ${scoreNum.toFixed(1)} / ${MAX_SCORE}`}
          </h2>
          {dateText ? (
            <div style={{ fontSize: 12, color: CUSTOMER_SURFACE.muted, marginTop: 4 }}>As of {dateText}</div>
          ) : null}
        </div>
        <TrendChip trend={effective.trend} delta={effective.trendDelta} />
      </header>

      {!isInsufficient ? (
        <div style={{ marginBottom: 16 }}>
          <MeterSvg score={scoreNum} label={{ name: labelName }} />
        </div>
      ) : null}

      {effective.summary ? (
        <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.55, color: '#3F4A65' }}>
          {effective.summary}
        </p>
      ) : null}

      <PressureHistoryChart history={effective.history} cadence={effective.cadence} />

      {effective.canCaptureClientRating && token ? (
        <ClientRatingPicker
          token={token}
          question={effective.clientRatingQuestion || 'Over the past 3 months, how much pest activity have you noticed?'}
          onSubmitted={(updated) => setOverride(updated || effective)}
        />
      ) : null}

      {effective.submittedClientRating !== null && effective.submittedClientRating !== undefined ? (
        <SubmittedRatingNote />
      ) : null}

      {effective.showComponentBreakdown && effective.components ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#0B3A66', fontWeight: 600 }}>
            Component breakdown
          </summary>
          <ComponentsTable components={effective.components} />
        </details>
      ) : null}

      {effective.howCalculated ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#0B3A66', fontWeight: 600 }}>
            How we calculate Pest Pressure
          </summary>
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: '#3F4A65', whiteSpace: 'pre-line' }}>
            {effective.howCalculated}
          </div>
        </details>
      ) : null}
    </section>
  );
}
