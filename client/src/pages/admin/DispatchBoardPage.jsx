/**
 * <DispatchBoardPage> — the new "Board" tab content. Owns nothing
 * directly; delegates state to useDispatchBoard() and rendering to
 * the dispatch component family.
 *
 * Phase 2 v1 scope. Out of scope: drag-to-reassign, color borders on
 * roster cards (green/amber/red on schedule), revenue/KPI strips,
 * mobile responsiveness, tech drawer, job drawer.
 */
import React, { useCallback } from 'react';
import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import DispatchBoardLayout from '../../components/dispatch/DispatchBoardLayout';
import TechRosterPane from '../../components/dispatch/TechRosterPane';
import DispatchMap from '../../components/dispatch/DispatchMap';
import ActionQueuePane from '../../components/dispatch/ActionQueuePane';

const D = { bg: '#0f1923', muted: '#94a3b8', alert: '#ef4444' };

export default function DispatchBoardPage() {
  const {
    techs,
    jobs,
    jobsById,
    selectedTechId,
    setSelectedTechId,
    loading,
    error,
  } = useDispatchBoard();

  // Stable callback so memoized <TechCard> doesn't see a new prop on
  // every parent render.
  const handleSelect = useCallback(
    (id) => setSelectedTechId((cur) => (cur === id ? null : id)),
    [setSelectedTechId]
  );

  if (loading) {
    return (
      <div style={{ background: D.bg, color: D.muted, padding: 40, textAlign: 'center' }}>
        Loading dispatch board…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ background: D.bg, color: D.alert, padding: 40, textAlign: 'center' }}>
        Failed to load dispatch board: {error}
      </div>
    );
  }

  return (
    <DispatchBoardLayout
      left={
        <TechRosterPane
          techs={techs}
          jobsById={jobsById}
          selectedTechId={selectedTechId}
          onSelect={handleSelect}
        />
      }
      center={
        <DispatchMap
          techs={techs}
          jobs={jobs}
          selectedTechId={selectedTechId}
          onSelectTech={handleSelect}
        />
      }
      right={<ActionQueuePane />}
    />
  );
}
