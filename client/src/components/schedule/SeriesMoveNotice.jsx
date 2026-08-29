// The one informational line a staff surface shows before a collective
// series move commits ("Moves this visit and N later visits …"). Style-
// agnostic: the reschedule modals pass tailwind classes, the SchedulePage
// modals pass their inline D-palette styles. Renders nothing when the
// preview is not a collective move (gate off, one-time row, same date).
import { isCollectivePreview, seriesMoveSummary } from './seriesMove';

export default function SeriesMoveNotice({
  preview,
  loading = false,
  stale = '', // server message from a refused ack — the plan changed since
  className = '',
  style,
  tone = 'tailwind', // 'tailwind' | 'inline'
}) {
  const inline = tone === 'inline';
  if (loading && !preview) {
    return (
      <p
        role="status"
        className={inline ? className : `text-12 text-ink-secondary ${className}`}
        style={inline ? { fontSize: 12, color: '#64748B', ...(style || {}) } : style}
      >
        Checking the recurring plan…
      </p>
    );
  }
  if (!isCollectivePreview(preview)) return null;
  const summary = seriesMoveSummary(preview);
  return (
    <div
      role="status"
      data-testid="series-move-notice"
      className={inline ? className : `rounded-sm px-3 py-2 ${className}`}
      style={inline
        ? { padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#F1F5F9', ...(style || {}) }
        : { border: '1px solid #E4E4E7', background: '#FAFAFA', ...(style || {}) }}
    >
      {stale ? (
        <p
          className={inline ? '' : 'text-12 font-medium text-ink-primary mb-1'}
          style={inline ? { fontSize: 12, fontWeight: 500, color: '#334155', marginBottom: 4 } : undefined}
        >
          The recurring plan changed since you looked — review the updated line and confirm again.
        </p>
      ) : null}
      <p
        className={inline ? '' : 'text-13 text-ink-primary leading-relaxed'}
        style={inline ? { fontSize: 13, color: '#334155', lineHeight: 1.5 } : undefined}
      >
        <strong className={inline ? '' : 'font-medium'} style={inline ? { fontWeight: 500 } : undefined}>Recurring plan:</strong>{' '}
        {summary}
      </p>
    </div>
  );
}
