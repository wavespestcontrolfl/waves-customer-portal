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
 * Tier 1 V2 styling: Card / Badge primitives, light surface, zinc
 * ramp, fontWeight 400/500 only.
 *
 * Resolve action lives in a future PR — this card is read-only.
 */
import React from 'react';
import { Card, Badge, cn } from '../ui';

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

const TYPE_RENDERERS = {
  tech_late: TechLateBody,
  missed_photo: MissedPhotoBody,
  moa_violation: MoaViolationBody,
};

export default function AlertCard({ alert }) {
  const Body = TYPE_RENDERERS[alert.type] || GenericBody;
  const tone = SEVERITY_TONE[alert.severity] || 'neutral';

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
          <span className="text-11 uppercase tracking-label font-medium text-ink-tertiary truncate">
            {alert.type}
          </span>
        </div>
        <span className="text-11 text-ink-tertiary flex-shrink-0">
          {timeAgo(alert.created_at)}
        </span>
      </div>
      <Body alert={alert} />
    </Card>
  );
}
