/**
 * <DispatchBoardPage> — the new "Board" tab content. Owns nothing
 * directly; delegates state to useDispatchBoard() and rendering to
 * the dispatch component family.
 *
 * Phase 2 v1 scope. Out of scope: drag-to-reassign, color borders on
 * roster cards (green/amber/red on schedule), revenue/KPI strips,
 * mobile responsiveness, tech drawer, job drawer.
 *
 * Tier 1 V2 styling.
 */
import React, { useCallback } from 'react';
import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import DispatchBoardLayout from '../../components/dispatch/DispatchBoardLayout';
import TechRosterPane from '../../components/dispatch/TechRosterPane';
import DispatchMap from '../../components/dispatch/DispatchMap';
import ActionQueuePane from '../../components/dispatch/ActionQueuePane';

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
