/**
 * <TechCard> — single roster card. Memoized via React.memo on the
 * triple [tech.id, tech.updated_at, tech.current_job_id]. Reason for
 * the third key: a tech can change current_job_id without updated_at
 * advancing (rare but possible if Bouncie pings the same lat/lng
 * while the dispatcher reassigns the job). Including it prevents a
 * class of stale-render bugs.
 *
 * Tier 1 V2 styling: Tailwind + components/ui primitives, light
 * surface, zinc ramp, font weights 400/500 only, text-14 minimum.
 * No D palette. See AGENTS.md / CLAUDE.md for the V2 contract.
 */
import React from 'react';
import { Card, cn } from '../ui';

// Status → color token mapping. Kept narrow: only the dot color
// changes by status; surrounding text is always zinc. Avoids the
// accent-soup that the V1 dark palette had.
const STATUS_DOT = {
  en_route:    'bg-waves-blue',
  on_site:     'bg-waves-gold',
  wrapping_up: 'bg-zinc-500',
  driving:     'bg-waves-blue',
  break:       'bg-zinc-400',
  idle:        'bg-zinc-300',
};

const STATUS_TEXT = {
  en_route:    'text-waves-blue-dark',
  on_site:     'text-waves-gold',
  wrapping_up: 'text-zinc-700',
  driving:     'text-waves-blue-dark',
  break:       'text-zinc-500',
  idle:        'text-zinc-500',
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

function TechCardImpl({ tech, jobs, selected, onSelect, isDropTarget }) {
  const currentJob = tech.current_job_id ? jobs.get(tech.current_job_id) : null;
  const addressLine = currentJob ? truncate(streetOnly(currentJob.address), 28) : '—';
  const dotColor = STATUS_DOT[tech.status] || STATUS_DOT.idle;
  const statusTextColor = STATUS_TEXT[tech.status] || STATUS_TEXT.idle;

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
      // data-tech-card-id is the drop-target hook for drag-to-reassign.
      // <DispatchMap>'s onJobDragEnd hit-tests document.elementFromPoint
      // and walks up to find an ancestor with this attribute. The id
      // value is the technicians.id passed to PUT /jobs/:id/assign.
      data-tech-card-id={tech.id}
      className={cn(
        'block w-full text-left mb-2 u-focus-ring rounded-md',
        'transition-shadow',
        selected && 'ring-2 ring-zinc-900 ring-offset-1',
        // Drop-zone affordance while a job is being dragged from the map.
        // CSS-only hover highlight via the parent's data attribute would
        // be cleaner, but a prop keeps the contract explicit + makes
        // the affordance testable. The dashed border signals "you can
        // drop here" without competing with the selected ring.
        isDropTarget && 'ring-2 ring-dashed ring-waves-blue ring-offset-1'
      )}
    >
      <Card
        className={cn(
          'cursor-pointer hover:bg-zinc-50',
          selected && 'border-zinc-900',
          isDropTarget && 'bg-zinc-50'
        )}
      >
        <div className="flex items-center gap-3 px-3 pt-3">
          {tech.avatar_url ? (
            <img
              src={tech.avatar_url}
              alt=""
              className="w-9 h-9 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div
              aria-hidden
              className="w-9 h-9 rounded-full bg-zinc-200 text-zinc-700 text-13 font-medium flex items-center justify-center flex-shrink-0"
            >
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-14 font-medium text-ink-primary truncate">
              {tech.name}
            </div>
            <div className={cn('flex items-center gap-1.5 mt-0.5')}>
              <span className={cn('inline-block w-1.5 h-1.5 rounded-full', dotColor)} />
              <span
                className={cn(
                  'text-11 uppercase tracking-label font-medium',
                  statusTextColor
                )}
              >
                {tech.status || 'idle'}
              </span>
            </div>
          </div>
        </div>
        <div
          className="px-3 pt-2 text-12 text-ink-secondary truncate"
          title={currentJob ? currentJob.address : ''}
        >
          {addressLine}
        </div>
        <div className="px-3 pt-1 pb-3 text-12 text-ink-tertiary">
          {tech.today_completed} / {tech.today_total} jobs
        </div>
      </Card>
    </button>
  );
}

// React.memo with a custom equality fn. The triple [id, updated_at,
// current_job_id] is the dirty key. If any external prop other than
// `tech` changes (selected, jobs reference, onSelect, isDropTarget),
// we re-render regardless via the secondary checks below.
export default React.memo(TechCardImpl, (prev, next) => {
  if (prev.tech.id !== next.tech.id) return false;
  if (prev.tech.updated_at !== next.tech.updated_at) return false;
  if (prev.tech.current_job_id !== next.tech.current_job_id) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.jobs !== next.jobs) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.isDropTarget !== next.isDropTarget) return false;
  return true;
});
