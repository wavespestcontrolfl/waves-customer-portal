/**
 * <DispatchBoardPage> — the new "Board" tab content. Owns nothing
 * directly; delegates state to useDispatchBoard() and rendering to
 * the dispatch component family.
 *
 * Phase 2 scope shipped: roster + map + action queue + job drawer +
 * tech drawer + drag-to-reassign on the map. Out of scope (still):
 * color borders on roster cards (green/amber/red), revenue/KPI
 * strips, mobile responsiveness.
 *
 * Drag-to-reassign:
 *   draggingJobId state tracks an in-flight drag started by a job
 *   marker on the map. While set, every TechCard renders a drop-zone
 *   affordance (dashed waves-blue ring). On a successful drop,
 *   handleJobDropOnTech PUTs /api/admin/dispatch/jobs/:id/assign
 *   (PR #320). The dispatch:job_update broadcast (PR #322) re-colors
 *   the pin for every connected dispatcher; this dispatcher's local
 *   board updates the same way.
 *
 *   Errors are surfaced via assignError state (a transient banner at
 *   the top of the page). 409 (terminal job) and 400 (inactive tech)
 *   are normal user-facing conditions — alert via the banner instead
 *   of swallowing.
 *
 * Tier 1 V2 styling.
 */
import React, { useCallback, useState } from 'react';
import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import DispatchBoardLayout from '../../components/dispatch/DispatchBoardLayout';
import TechRosterPane from '../../components/dispatch/TechRosterPane';
import DispatchMap from '../../components/dispatch/DispatchMap';
import ActionQueuePane from '../../components/dispatch/ActionQueuePane';
import JobDrawer from '../../components/dispatch/JobDrawer';
import TechDrawer from '../../components/dispatch/TechDrawer';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminAuthHeaders() {
  const token = localStorage.getItem('waves_admin_token');
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export default function DispatchBoardPage() {
  const {
    techs,
    jobs,
    jobsById,
    selectedTechId,
    setSelectedTechId,
    selectedJobId,
    setSelectedJobId,
    loading,
    error,
  } = useDispatchBoard();

  // Stable callback so memoized <TechCard> doesn't see a new prop on
  // every parent render.
  const handleSelectTech = useCallback(
    (id) => setSelectedTechId((cur) => (cur === id ? null : id)),
    [setSelectedTechId]
  );

  const handleSelectJob = useCallback(
    (id) => setSelectedJobId(id),
    [setSelectedJobId]
  );

  const handleCloseJob = useCallback(
    () => setSelectedJobId(null),
    [setSelectedJobId]
  );

  const handleCloseTech = useCallback(
    () => setSelectedTechId(null),
    [setSelectedTechId]
  );

  // ---- Drag-to-reassign ----
  // draggingJobId is the source of truth for "a drag is currently
  // happening." Used by TechRosterPane to flip every TechCard into
  // drop-zone mode. Reset to null on dragend regardless of drop
  // outcome (success refetches via broadcast; miss is a no-op).
  const [draggingJobId, setDraggingJobId] = useState(null);
  const [assignError, setAssignError] = useState(null);

  const handleJobDragStart = useCallback((jobId) => {
    setDraggingJobId(jobId);
    setAssignError(null);
  }, []);
  const handleJobDragEnd = useCallback(() => {
    setDraggingJobId(null);
  }, []);

  // Fire the assignment PUT. The endpoint already enforces the same
  // validations the JobDrawer dropdown uses (404 / 409 / 400) and
  // emits dispatch:job_update on success — so the local board AND
  // every other dispatcher's board re-color the pin. We don't
  // optimistically mutate jobs[] here because the broadcast handles it.
  const handleJobDropOnTech = useCallback(async (jobId, techId) => {
    if (!jobId || !techId) return;
    try {
      const res = await fetch(
        `${API_BASE}/admin/dispatch/jobs/${jobId}/assign`,
        {
          method: 'PUT',
          headers: adminAuthHeaders(),
          body: JSON.stringify({ technicianId: techId }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setAssignError(err.message || 'Reassignment failed');
    }
  }, []);

  if (loading) {
    return (
      <div className="bg-surface-page text-14 text-ink-tertiary p-10 text-center">
        Loading dispatch board…
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-surface-page text-14 text-alert-fg p-10 text-center">
        Failed to load dispatch board: {error}
      </div>
    );
  }

  return (
    <>
      {assignError && (
        <div
          role="alert"
          className="bg-alert-fg text-white text-12 px-4 py-2 cursor-pointer"
          onClick={() => setAssignError(null)}
          title="Click to dismiss"
        >
          Reassignment failed: {assignError}
        </div>
      )}
      <DispatchBoardLayout
        left={
          <TechRosterPane
            techs={techs}
            jobsById={jobsById}
            selectedTechId={selectedTechId}
            onSelect={handleSelectTech}
            draggingJobId={draggingJobId}
          />
        }
        center={
          <DispatchMap
            techs={techs}
            jobs={jobs}
            selectedTechId={selectedTechId}
            onSelectTech={handleSelectTech}
            onSelectJob={handleSelectJob}
            onJobDragStart={handleJobDragStart}
            onJobDragEnd={handleJobDragEnd}
            onJobDropOnTech={handleJobDropOnTech}
          />
        }
        right={<ActionQueuePane />}
      />
      <JobDrawer jobId={selectedJobId} onClose={handleCloseJob} />
      <TechDrawer techId={selectedTechId} onClose={handleCloseTech} />
    </>
  );
}
