/**
 * <TechRosterPane> — left pane, fixed 240px wide. Pure list renderer
 * around <TechCard>. Uses the jobsById Map from useDispatchBoard for
 * each card's current-job address lookup.
 */
import React from 'react';
import TechCard from './TechCard';

const D = {
  bg: '#0f1923', border: '#334155', muted: '#94a3b8', heading: '#fff',
};

export default function TechRosterPane({ techs, jobsById, selectedTechId, onSelect }) {
  return (
    <aside
      style={{
        width: 240,
        flexShrink: 0,
        background: D.bg,
        borderRight: `1px solid ${D.border}`,
        padding: 12,
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <h2
        style={{
          color: D.heading,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          margin: '4px 0 12px 4px',
        }}
      >
        Tech Roster
      </h2>
      {techs.length === 0 ? (
        <div style={{ color: D.muted, fontSize: 12, padding: '8px 4px' }}>
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
          />
        ))
      )}
    </aside>
  );
}
