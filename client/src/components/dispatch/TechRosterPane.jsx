/**
 * <TechRosterPane> — left pane, fixed 240px wide. Pure list renderer
 * around <TechCard>. Uses the jobsById Map from useDispatchBoard for
 * each card's current-job address lookup.
 *
 * When draggingJobId is non-null (a job pin on the map is being
 * dragged), every card renders a drop-zone affordance via
 * <TechCard isDropTarget>. The card's data-tech-card-id attribute is
 * the hit-test target the map's dragend handler walks up to find.
 *
 * Tier 1 V2 styling.
 */
import React from 'react';
import TechCard from './TechCard';

export default function TechRosterPane({ techs, jobsById, selectedTechId, onSelect, draggingJobId }) {
  const dragActive = !!draggingJobId;
  return (
    <aside className="w-full md:w-60 md:flex-shrink-0 bg-white md:border-r border-hairline border-zinc-200 p-3 overflow-y-auto">
      <h2 className="text-12 uppercase tracking-label font-medium text-ink-secondary mb-3 px-1">
        Tech Roster
      </h2>
      {techs.length === 0 ? (
        <div className="text-12 text-ink-tertiary px-1 py-2">
          No active techs in the last 24h.
        </div>
      ) : (
        techs.map((tech) => (
          <TechCard
            key={tech.id}
            tech={tech}
            jobs={jobsById}
            selected={tech.id === selectedTechId}
            onSelect={onSelect}
            isDropTarget={dragActive}
          />
        ))
      )}
    </aside>
  );
}
