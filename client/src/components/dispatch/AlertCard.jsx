/**
 * <AlertCard> — single action queue card. Type-aware rendering
 * (tech_late / missed_photo / moa_violation get pretty layouts;
 * everything else falls back to a generic key/value dump of the
 * payload).
 *
 * Severity drives the left-edge color stripe + icon tone:
 *   info     → zinc accent (informational)
 *   warn     → waves-gold (action needed soon)
 *   critical → alert-fg red (immediate attention)
 *
 * Tier 1 V2 styling: Card / Badge / Button primitives, light surface,
 * zinc ramp, fontWeight 400/500 only.
 *
 * Resolve flow: when the dispatcher clicks Resolve, the card calls
 * `onResolve(alert.id)` (passed in from <ActionQueuePane> via
 * useDispatchAlerts). The hook PATCHes the resolve endpoint, drops
 * the row optimistically on success, and the dispatch:alert_resolved
 * broadcast removes it from every other connected dispatcher's pane.
 * While the PATCH is in flight the button is disabled + shows
 * "Resolving…". On failure the button re-enables for retry. If no
 * `onResolve` prop is passed, the button is omitted (read-only mode).
 */
import React, { useState } from 'react';
import { Card, Button, cn } from '../ui';
import { formatETTime, formatETDate } from '../../lib/timezone';

const SEVERITY_TONE = {
  info: 'neutral',
  warn: 'neutral',     // V2 Badge tones don't include amber; use neutral + custom dot below
  critical: 'alert',
};

const SEVERITY_BORDER = {
  info: 'border-l-zinc-400',
  warn: 'border-l-waves-gold',
  critical: 'border-l-alert-fg',
};

const SEVERITY_LABEL_COLOR = {
  info: 'text-zinc-600',
  warn: 'text-waves-gold',
  critical: 'text-alert-fg',
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function customerLine(alert) {
  if (!alert.customer_first_name) return null;
  const last = (alert.customer_last_name || '').charAt(0).toUpperCase();
  return last ? `${alert.customer_first_name} ${last}.` : alert.customer_first_name;
}

// Per-type pretty rendering. Each returns the body content for the
// card (under the header row). Generic fallback handles unknown types
// and any new type a future generator adds without a UI update.
function TechLateBody({ alert }) {
  const delay = alert.payload && alert.payload.delay_minutes;
  return (
    <div className="text-14 text-ink-primary">
      {alert.tech_name ? (
        <span className="font-medium">{alert.tech_name}</span>
      ) : (
        <span className="text-ink-tertiary italic">Unknown tech</span>
      )}{' '}
      running{' '}
      {delay != null ? (
        <span className="font-medium">{delay} min</span>
      ) : (
        'late'
      )}{' '}
      behind schedule
      {customerLine(alert) && (
        <>
          {' '}— heading to <span className="font-medium">{customerLine(alert)}</span>
        </>
      )}
    </div>
  );
}

function UnassignedOverdueBody({ alert }) {
  const delay = alert.payload && alert.payload.delay_minutes;
  return (
    <div className="text-14 text-ink-primary">
      <span className="font-medium">Unassigned job</span>{' '}
      {delay != null ? (
        <>
          overdue by <span className="font-medium">{delay} min</span>
        </>
      ) : (
        'past its window'
      )}
      {customerLine(alert) && (
        <>
          {' '}— <span className="font-medium">{customerLine(alert)}</span>
        </>
      )}
    </div>
  );
}

function MissedPhotoBody({ alert }) {
  return (
    <div className="text-14 text-ink-primary">
      {alert.tech_name && (
        <span className="font-medium">{alert.tech_name} </span>
      )}
      marked job complete without a required photo
      {customerLine(alert) && (
        <>
          {' '}— <span className="font-medium">{customerLine(alert)}</span>
        </>
      )}
    </div>
  );
}

function MoaViolationBody({ alert }) {
  const moa = alert.payload && alert.payload.moa_group;
  return (
    <div className="text-14 text-ink-primary">
      MOA rotation conflict
      {moa && (
        <>
          {' '}— same group <span className="font-medium">{moa}</span>
        </>
      )}
      {alert.tech_name && (
        <>
          {' '}for <span className="font-medium">{alert.tech_name}</span>
        </>
      )}
      {customerLine(alert) && (
        <>
          {' '}at <span className="font-medium">{customerLine(alert)}</span>
        </>
      )}
    </div>
  );
}

function GenericBody({ alert }) {
  // Last-resort renderer for unknown types. Shows the payload as a
  // compact key/value list so a new generator type isn't invisible
  // until the UI catches up.
  return (
    <div className="text-14 text-ink-primary">
      <div>
        {alert.tech_name && <span className="font-medium">{alert.tech_name}</span>}
        {alert.tech_name && customerLine(alert) && ' · '}
        {customerLine(alert) && (
          <span className="text-ink-secondary">{customerLine(alert)}</span>
        )}
      </div>
      {alert.payload && Object.keys(alert.payload).length > 0 && (
        <dl className="mt-1 text-12 text-ink-secondary">
          {Object.entries(alert.payload).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="text-ink-tertiary">{k}:</dt>
              <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function RouteQualityBody({ alert }) {
  const { date, issues = [], departureMinutes, techName } = alert.payload || {};
  const departure = Number.isFinite(departureMinutes)
    ? `${String(Math.floor(departureMinutes / 60)).padStart(2, '0')}:${String(departureMinutes % 60).padStart(2, '0')}` : null;
  // The dispatch:alert broadcast carries the bare row, so a live card has no
  // joined tech_name — the generator puts the name in the payload and this
  // renderer prefers it, keeping same-day route cards distinguishable
  // without waiting for the next board hydration.
  const tech = techName || alert.tech_name;
  return (
    <div className="text-14 text-ink-primary space-y-2">
      <p className="font-medium">{date}{tech ? ` · ${tech}` : ''}</p>
      {issues.map(issue => <p key={issue}>{issue}</p>)}
      {departure && <p className="text-ink-secondary">Timing assumes departure from base at {departure} ET. This is a forecast.</p>}
      {date && (
        <a className="inline-block text-ink-primary underline underline-offset-2" href={`/admin/dispatch?tab=schedule&date=${encodeURIComponent(date)}`}>
          Review this day
        </a>
      )}
    </div>
  );
}

// Missing-departure/arrival tracking cards reuse the existing tech_late /
// unassigned_overdue alert types (same Action Queue lifecycle — resolve,
// auto-clear on status change) and are distinguished only by
// payload.source. They still need their own body: the generic
// TechLateBody/UnassignedOverdueBody read payload.delay_minutes, which
// this generator never sets, so without this renderer a tracking card
// would show "Unknown tech running late" with no way to tell which visit
// needs attention (codex P1 — af4925f71).
// "9:00–11:00 AM" (shared meridiem compressed onto the end time only) /
// "11:00 AM–1:00 PM" (both kept when they differ) — same compression style
// tech-visit-notifications.js's formatPromisedWindow uses server-side.
function formatWindowRange(startAt, endAt) {
  if (!startAt) return null;
  const start = formatETTime(startAt);
  if (!endAt) return start;
  const end = formatETTime(endAt);
  const meridiem = (s) => s.slice(-2);
  const clock = (s) => s.slice(0, -3);
  return meridiem(start) === meridiem(end) ? `${clock(start)}–${end}` : `${start}–${end}`;
}

function TrackingBody({ alert }) {
  const payload = alert.payload || {};
  const window = payload.promised_window;
  // Read the PROMISED window, not alert.scheduled_date/window_* — those
  // are the visit's current, mutable fields, and stage 2 is enforced
  // against the promise. A shorter service block or an uncommunicated
  // internal move must not repaint the card with a different date/time
  // than the one the message is judging (codex P1). Both ends of the
  // window render — a bare start time doesn't tell the dispatcher how
  // long the promised arrival slot actually runs (codex P2).
  const windowLabel = formatWindowRange(window?.start_at, window?.end_at);
  const dateLabel = window?.start_at ? formatETDate(window.start_at) : null;
  const when = [dateLabel, windowLabel].filter(Boolean).join(' · ');
  // The dispatch:alert socket broadcast carries the bare inserted row (no
  // tech_name/customer join) until the board's next /alerts hydration — an
  // admin with the board already open would otherwise see "Unassigned" on
  // an assigned stage-2 card and a blank customer name (codex P1). The
  // generator puts these in the payload too; prefer the row-level (joined)
  // field when present, same pattern as RouteQualityBody's techName.
  const techName = alert.tech_name || payload.tech_name;
  const customer = customerLine(alert) || customerLine({
    customer_first_name: payload.customer_first_name, customer_last_name: payload.customer_last_name,
  });
  return (
    <div className="text-14 text-ink-primary space-y-1">
      <div>
        {techName ? (
          <span className="font-medium">{techName}</span>
        ) : (
          <span className="text-ink-tertiary italic">Unassigned</span>
        )}
        {customer && (
          <>
            {' '}— <span className="font-medium">{customer}</span>
          </>
        )}
        {when && <span className="text-ink-secondary"> ({when})</span>}
      </div>
      <p className="text-ink-secondary">{payload.message}</p>
    </div>
  );
}

const TYPE_RENDERERS = {
  tech_late: TechLateBody,
  unassigned_overdue: UnassignedOverdueBody,
  missed_photo: MissedPhotoBody,
  moa_violation: MoaViolationBody,
  schedule_route_quality: RouteQualityBody,
};

export default function AlertCard({ alert, onResolve }) {
  const tracking = alert.payload?.source === 'no_show_detector';
  const Body = tracking ? TrackingBody : (TYPE_RENDERERS[alert.type] || GenericBody);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);

  async function handleResolve() {
    if (!onResolve || resolving) return;
    setResolving(true);
    setResolveError(null);
    try {
      await onResolve(alert.id);
      // On success the hook drops this card from state, so this
      // component unmounts before any state-setter would re-render.
      // No need to flip `resolving` back.
    } catch (err) {
      setResolving(false);
      setResolveError(err?.message || 'Resolve failed');
    }
  }

  return (
    <Card
      className={cn(
        'border-l-4 p-3 mb-2',
        SEVERITY_BORDER[alert.severity] || SEVERITY_BORDER.info
      )}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'text-11 uppercase tracking-label font-medium',
              SEVERITY_LABEL_COLOR[alert.severity] || SEVERITY_LABEL_COLOR.info
            )}
          >
            {alert.severity}
          </span>
          <span className={cn('font-medium text-ink-tertiary truncate', alert.type === 'schedule_route_quality' ? 'text-14' : 'text-11 uppercase tracking-label')}>
            {alert.type === 'schedule_route_quality' ? 'Route needs review' : tracking ? 'Missing tracking' : alert.type}
          </span>
        </div>
        <span className="text-11 text-ink-tertiary flex-shrink-0">
          {timeAgo(alert.created_at)}
        </span>
      </div>
      <Body alert={alert} />
      {onResolve && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {resolveError && (
            <span className="text-11 text-alert-fg">{resolveError}</span>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={handleResolve}
            disabled={resolving}
          >
            {resolving ? 'Resolving…' : 'Resolve'}
          </Button>
        </div>
      )}
    </Card>
  );
}
