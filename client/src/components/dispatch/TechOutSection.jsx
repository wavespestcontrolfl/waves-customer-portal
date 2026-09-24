/**
 * <TechOutSection> — "Tech out today" panel inside <TechDrawer>, under the
 * stats cards. Lets a dispatcher mark the open tech out for today (sick /
 * emergency / no-show / other) with a one-step inline confirm, then shows
 * the redistribution summary the server computed (moved / parked / failed)
 * once out, with a "Tech is back" clear.
 *
 * Feature-gated server-side (GATE_TECH_OUT_REDISTRIBUTE): a 404 means the
 * gate is off, and this section renders nothing — same contract as a
 * disabled Intelligence Bar surface.
 *
 * Race-safety: same fetchSeq pattern as TechDrawer's own fetchTech — a
 * per-request sequence token so a stale fetch (tech switched, or the same
 * tech reselected before the first fetch resolved) can't clobber state.
 *
 * Tier 1 V2 styling: Card / Badge / Button / Select / Textarea primitives,
 * zinc ramp, fontWeight 400/500, 14px text minimum.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Select, Textarea, cn } from '../ui';
import { etDateString } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminAuthHeaders() {
  const token = localStorage.getItem('waves_admin_token');
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

const REASONS = [
  { value: 'sick', label: 'Sick' },
  { value: 'emergency', label: 'Emergency' },
  { value: 'no_show', label: 'No-show' },
  { value: 'other', label: 'Other' },
];

const REASON_LABELS = REASONS.reduce((acc, r) => {
  acc[r.value] = r.label;
  return acc;
}, {});

function postErrorMessage(errCode) {
  if (errCode === 'past_date') return "Can't mark a past date";
  if (errCode === 'already_out') return 'Already marked out';
  return null;
}

export default function TechOutSection({ techId, techName }) {
  // 'loading' | 'off' | 'ready'
  const [phase, setPhase] = useState('loading');
  const [absence, setAbsence] = useState(null);

  const [reason, setReason] = useState('sick');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [clearing, setClearing] = useState(false);

  const fetchSeqRef = useRef(0);

  const fetchStatus = useCallback(async (id) => {
    const seq = ++fetchSeqRef.current;
    try {
      const date = etDateString();
      const res = await fetch(`${API_BASE}/admin/tech-out/${id}?date=${date}`, {
        headers: adminAuthHeaders(),
      });
      if (res.status === 404) {
        if (fetchSeqRef.current !== seq) return;
        setPhase('off');
        setAbsence(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (fetchSeqRef.current !== seq) return;
      if (!data.enabled) {
        setPhase('off');
        setAbsence(null);
        return;
      }
      setAbsence(data.absence || null);
      setPhase('ready');
    } catch {
      // No error UI is specified for the status GET itself — treat a
      // failed read the same as "feature not usable right now".
      if (fetchSeqRef.current !== seq) return;
      setPhase('off');
      setAbsence(null);
    }
  }, []);

  useEffect(() => {
    // Bump the seq synchronously on every selection change so an in-flight
    // fetch from the previous tech (or a previous fetch for this same tech)
    // can't apply state — same two race patterns TechDrawer guards against.
    fetchSeqRef.current += 1;
    setPhase('loading');
    setAbsence(null);
    setConfirming(false);
    setSubmitError(null);
    setSubmitting(false);
    setNote('');
    setReason('sick');
    if (techId) fetchStatus(techId);
  }, [techId, fetchStatus]);

  async function handleConfirmMarkOut() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/tech-out/${techId}`, {
        method: 'POST',
        headers: adminAuthHeaders(),
        body: JSON.stringify({ reason, note: note || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 400) {
        setSubmitError(postErrorMessage(data.error) || data.error || 'Failed to mark out');
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // The POST response shape is { absence, summary } (siblings), unlike
      // the GET status shape which nests summary as absence.redistribution
      // — normalize so the "out" view below has one shape to read.
      setAbsence({ ...data.absence, redistribution: data.absence?.redistribution || data.summary });
      setConfirming(false);
      setNote('');
    } catch (err) {
      setSubmitError(err.message || 'Failed to mark out');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTechIsBack() {
    if (clearing) return;
    setClearing(true);
    setSubmitError(null);
    try {
      const date = etDateString();
      const res = await fetch(`${API_BASE}/admin/tech-out/${techId}?date=${date}`, {
        method: 'DELETE',
        headers: adminAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchStatus(techId);
    } catch (err) {
      setSubmitError(err.message || 'Failed to clear absence');
    } finally {
      setClearing(false);
    }
  }

  if (phase !== 'ready') return null;

  if (absence) {
    const redistribution = absence.redistribution || {};
    const moved = redistribution.moved || [];
    const parked = redistribution.parked || [];
    const failed = redistribution.failed || [];
    return (
      <Card className="p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <Badge tone="warn">
            Out today · {REASON_LABELS[absence.reason] || absence.reason}
          </Badge>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="text-center">
            <div className="text-18 tabular-nums text-ink-primary">{moved.length}</div>
            <div className="text-11 text-ink-tertiary">moved</div>
          </div>
          <div className="text-center">
            <div className="text-18 tabular-nums text-ink-primary">{parked.length}</div>
            <div className="text-11 text-ink-tertiary">need a decision</div>
          </div>
          <div className="text-center">
            <div className={cn('text-18 tabular-nums', failed.length > 0 ? 'text-alert-fg' : 'text-ink-primary')}>
              {failed.length}
            </div>
            <div className="text-11 text-ink-tertiary">failed</div>
          </div>
        </div>
        {moved.length > 0 && (
          <div className="mb-3">
            {moved.map((m) => (
              <div key={m.job_id} className="text-14 text-ink-primary">
                → {m.to_technician_name}
              </div>
            ))}
          </div>
        )}
        <div className="text-12 text-ink-tertiary mb-3">
          Parked stops are in the Action Queue as &quot;Needs a decision&quot;.
        </div>
        {submitError && <div className="text-14 text-alert-fg mb-3">{submitError}</div>}
        <Button variant="secondary" onClick={handleTechIsBack} disabled={clearing}>
          {clearing ? 'Clearing…' : 'Tech is back'}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4 mb-4">
      <div className="text-14 font-medium text-ink-primary mb-3">Availability</div>
      {!confirming ? (
        <>
          <div className="mb-3">
            <label className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1 block">
              Reason
            </label>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </Select>
          </div>
          <div className="mb-3">
            <label className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1 block">
              Note (optional)
            </label>
            <Textarea
              rows={2}
              value={note}
              maxLength={300}
              placeholder="Optional note"
              onChange={(e) => setNote(e.target.value.slice(0, 300))}
            />
          </div>
          {submitError && <div className="text-14 text-alert-fg mb-3">{submitError}</div>}
          <Button
            variant="primary"
            onClick={() => {
              setSubmitError(null);
              setConfirming(true);
            }}
          >
            Mark out today
          </Button>
        </>
      ) : (
        <div>
          <div className="text-14 text-ink-primary mb-3">
            Reassign {techName}&apos;s stops to the rest of the crew and park what can&apos;t move?
          </div>
          {submitError && <div className="text-14 text-alert-fg mb-3">{submitError}</div>}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={handleConfirmMarkOut} disabled={submitting}>
              {submitting ? 'Redistributing…' : 'Confirm'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                setSubmitError(null);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
