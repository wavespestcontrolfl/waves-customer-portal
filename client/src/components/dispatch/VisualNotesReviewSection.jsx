import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Textarea } from '../ui';
import { adminFetch } from '../../utils/admin-fetch';

const STATUS_LABELS = {
  internal_only: 'Internal only',
  draft_customer: 'Draft',
  approved_customer: 'Approved',
  rejected: 'Rejected',
};

function statusTone(status) {
  if (status === 'approved_customer') return 'strong';
  if (status === 'rejected') return 'alert';
  return 'neutral';
}

function formatTime(value) {
  if (!value) return 'Not captured';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Not captured';
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function VisualNotesReviewSection({ jobId }) {
  const [moments, setMoments] = useState([]);
  const [captionDrafts, setCaptionDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setError('');
    try {
      const data = await adminFetch(`/jobs/${jobId}/visual-moments`);
      const next = data.moments || [];
      setMoments(next);
      setCaptionDrafts(Object.fromEntries(next.map((moment) => [
        moment.id,
        moment.rawCustomerCaption || moment.customerCaption || '',
      ])));
    } catch (err) {
      setError(err.message || 'Could not load visual notes');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  const updateVisibility = async (momentId, visibilityStatus) => {
    setBusyId(momentId);
    setError('');
    try {
      const body = { visibilityStatus };
      if (visibilityStatus === 'approved_customer') {
        body.customerCaption = captionDrafts[momentId] || '';
      }
      await adminFetch(`/visual-moments/${momentId}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not update visibility');
    } finally {
      setBusyId('');
    }
  };

  const saveCaption = async (momentId) => {
    setBusyId(momentId);
    setError('');
    try {
      await adminFetch(`/visual-moments/${momentId}/customer-caption`, {
        method: 'PATCH',
        body: JSON.stringify({ customerCaption: captionDrafts[momentId] || '' }),
      });
      await load();
    } catch (err) {
      setError(err.message || 'Could not save caption');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="mt-5 pt-4 border-t border-zinc-200">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1">
            Visual Notes
          </div>
          <div className="text-14 text-ink-primary">Proof moments for this job.</div>
        </div>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </Button>
      </div>
      {error && <div className="text-12 text-alert-fg mb-2">{error}</div>}
      {!loading && moments.length === 0 && (
        <div className="text-13 text-ink-tertiary border border-dashed border-zinc-300 rounded-sm p-3">
          No visual notes yet.
        </div>
      )}
      <div className="space-y-3">
        {moments.map((moment) => (
          <div key={moment.id} className="border border-zinc-200 rounded-sm p-3 bg-white">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-14 font-medium text-ink-primary">{moment.tagLabel}</div>
                <div className="text-12 text-ink-tertiary mt-0.5">
                  {[moment.tagGroup, moment.locationArea, formatTime(moment.capturedAt)].filter(Boolean).join(' · ')}
                </div>
              </div>
              <Badge tone={statusTone(moment.visibilityStatus)}>
                {STATUS_LABELS[moment.visibilityStatus] || moment.visibilityStatus}
              </Badge>
            </div>

            {moment.mediaUrl && (
              <div className="mt-3">
                {moment.mediaType === 'video' ? (
                  <video src={moment.mediaUrl} controls className="w-full rounded-sm border border-zinc-200" />
                ) : (
                  <img
                    src={moment.mediaUrl}
                    alt={moment.tagLabel || 'Visual note'}
                    className="w-full max-h-64 object-cover rounded-sm border border-zinc-200"
                  />
                )}
              </div>
            )}

            {moment.note && (
              <div className="mt-3 text-13 text-ink-secondary whitespace-pre-wrap">{moment.note}</div>
            )}

            <label className="block mt-3 text-11 uppercase tracking-label text-ink-tertiary font-medium">
              Customer caption
            </label>
            <Textarea
              value={captionDrafts[moment.id] || ''}
              onChange={(e) => setCaptionDrafts((prev) => ({ ...prev, [moment.id]: e.target.value }))}
              rows={3}
              className="mt-1 w-full"
              placeholder="Caption shown on approved customer report"
            />

            <div className="flex flex-wrap gap-2 mt-3">
              <Button
                size="sm"
                variant="primary"
                onClick={() => updateVisibility(moment.id, 'approved_customer')}
                disabled={busyId === moment.id}
              >
                Approve for report
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => updateVisibility(moment.id, 'internal_only')}
                disabled={busyId === moment.id}
              >
                Keep internal
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => updateVisibility(moment.id, 'rejected')}
                disabled={busyId === moment.id}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => saveCaption(moment.id)}
                disabled={busyId === moment.id}
              >
                Save caption
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
