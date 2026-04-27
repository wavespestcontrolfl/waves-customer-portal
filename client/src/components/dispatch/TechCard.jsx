/**
 * <TechCard> — single roster card. Memoized via React.memo on the
 * triple [tech.id, tech.updated_at, tech.current_job_id]. Reason for
 * the third key: a tech can change current_job_id without updated_at
 * advancing (rare but possible if Bouncie pings the same lat/lng
 * while the dispatcher reassigns the job). Including it prevents a
 * class of stale-render bugs.
 *
 * Address truncation lives at this render layer, not at the API. The
 * `jobs` prop (full job records) is the lookup table for
 * current_job_id → address. Truncated to 28 chars on display.
 *
 * Click handler highlights the corresponding map marker via the
 * shared selectedTechId state in useDispatchBoard().
 */
import React from 'react';

const STATUS_COLORS = {
  en_route:    '#0ea5e9', // teal — moving
  on_site:     '#10b981', // green — at customer
  wrapping_up: '#a855f7', // purple — finishing
  driving:     '#0ea5e9', // teal — same as en_route in v1
  break:       '#94a3b8', // muted — off-task
  idle:        '#64748b', // dim — no current activity
};

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  text: '#e2e8f0', muted: '#94a3b8', heading: '#fff',
};

function truncate(str, n) {
  if (!str) return '';
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + '…';
}

function streetOnly(fullAddress) {
  // The API returns "123 Main St, Bradenton, FL 34203" format.
  // For the card's "current job address" line, dispatchers only need
  // the street portion at a glance — city/state/zip steals horizontal
  // space in a 240px pane. Pull the first comma-segment.
  if (!fullAddress) return '';
  const idx = fullAddress.indexOf(',');
  return idx === -1 ? fullAddress : fullAddress.slice(0, idx);
}

function TechCardImpl({ tech, jobs, selected, onSelect }) {
  const currentJob = tech.current_job_id ? jobs.get(tech.current_job_id) : null;
  const addressLine = currentJob ? truncate(streetOnly(currentJob.address), 28) : '—';
  const statusColor = STATUS_COLORS[tech.status] || STATUS_COLORS.idle;

  const initials = (tech.name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n.charAt(0).toUpperCase())
    .join('');

  return (
    <button
      type="button"
      onClick={() => onSelect(tech.id)}
      style={{
        all: 'unset',
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        background: D.card,
        border: `1px solid ${selected ? statusColor : D.border}`,
        borderRadius: 10,
        padding: 12,
        marginBottom: 8,
        cursor: 'pointer',
        boxShadow: selected ? `0 0 0 2px ${statusColor}33` : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {tech.avatar_url ? (
          <img
            src={tech.avatar_url}
            alt=""
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              objectFit: 'cover',
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            aria-hidden
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: '#334155',
              color: D.text,
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: D.heading,
              fontWeight: 600,
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tech.name}
          </div>
          <div
            style={{
              color: statusColor,
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginTop: 2,
            }}
          >
            {tech.status || 'idle'}
          </div>
        </div>
      </div>
      <div
        style={{
          color: D.muted,
          fontSize: 12,
          marginTop: 8,
          fontFamily: "'JetBrains Mono', monospace",
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={currentJob ? currentJob.address : ''}
      >
        {addressLine}
      </div>
      <div
        style={{
          color: D.text,
          fontSize: 11,
          marginTop: 6,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {tech.today_completed} / {tech.today_total} jobs
      </div>
    </button>
  );
}

// React.memo with a custom equality fn. The triple [id, updated_at,
// current_job_id] is the dirty key — see file header for why
// current_job_id is a separate axis. If any external prop other than
// `tech` changes (selected, jobs reference, onSelect), we re-render
// regardless via the secondary checks below.
export default React.memo(TechCardImpl, (prev, next) => {
  if (prev.tech.id !== next.tech.id) return false;
  if (prev.tech.updated_at !== next.tech.updated_at) return false;
  if (prev.tech.current_job_id !== next.tech.current_job_id) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.jobs !== next.jobs) return false;
  if (prev.onSelect !== next.onSelect) return false;
  return true;
});
