// The typed hour on every technician's route (owner 2026-10-05, PestPac's
// "Best Fit"): who can take it and what each adds to their drive, least
// first. Tapping a row books that technician — the drive was priced on
// their route. Renders nothing with no rows (one tech chosen, hints gated,
// or nobody can take the hour).

import { detourPhrase } from './BestTimeHint';

function fmtHour(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function driveIn(row) {
  const mins = Math.round(Number(row.driveInMinutes));
  if (row.driveInMinutes == null || !Number.isFinite(mins)) return null;
  return `${mins} min drive from ${row.fromHomeBase ? 'home base' : (row.fromName || 'the previous stop')}`;
}

export default function HourTechCompare({ rows, onPick, style }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // "Best fit" only when the winner's route was actually priced.
  const best = rows.length > 1 && Number.isFinite(rows[0].detourMinutes);
  return (
    <section aria-label="Technicians free at this hour" style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: '#18181B' }}>
        Free at {fmtHour(rows[0].start)}
      </div>
      {rows.map((row, i) => (
        <button
          key={row.technicianId}
          type="button"
          onClick={() => onPick?.(row)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, padding: '8px 12px',
            background: '#FFFFFF', border: `1px solid ${best && i === 0 ? '#18181B' : '#E4E4E7'}`, borderRadius: 8,
            cursor: 'pointer', textAlign: 'left', fontSize: 14,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 500, color: '#18181B' }}>
              {row.technicianName || 'Technician'}
              {best && i === 0 && <span style={{ marginLeft: 8, color: '#52525B' }}>Best fit</span>}
            </span>
            <span style={{ display: 'block', color: '#71717A' }}>
              {[driveIn(row), detourPhrase(row)].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span style={{ color: '#52525B', fontWeight: 500 }}>Use</span>
        </button>
      ))}
    </section>
  );
}
