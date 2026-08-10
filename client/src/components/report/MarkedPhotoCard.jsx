import { useEffect, useRef, useState } from 'react';

// Marked-photo card — treated points the technician tapped onto a photo of the
// area they actually treated (GATE_PHOTO_MARKS, dark).
// Scope + rulings: docs/design/treatment-animation-scope.md.
//
// Pin vocabulary is deliberately the bait-station one (numbered badge, stem,
// staggered pop-in) so the two cards read as one system. ONE deliberate
// divergence: this card states NO count. Stations are an exhaustive registry,
// so "8 of 8 stations inspected" is a fact their data backs. Marks are
// optional and need not be exhaustive, and foam is priced by drill-point
// count — a total here would invite a customer to tally pins against billed
// points. The server context carries no total for the same reason.
//
// Unlike the station map this renders in PDFs too: it pins against OUR photo,
// not a satellite basemap, so there is no provider-ToS reason to withhold it.
// Motion is the only thing gated on live view.

const KIND_COLOR = {
  foam_injection: '#0A7EC2',
  spot_treatment: '#157A5B',
  wood_treatment: '#A9690C',
};
// Never alert red: that is reserved for genuine alerts, and a treated point is
// a record of work performed, not a warning.
const DEFAULT_COLOR = '#0A7EC2';

const CAPTIONS = {
  foamPoints: 'Foam was injected at the points your technician marked on this visit.',
};
// The caption attributes the marks to the technician's record rather than
// asserting they are all of them — the phrasing the count rule requires.
const FALLBACK_CAPTION = 'Your technician marked the points treated on this visit.';

export default function MarkedPhotoCard({ marked, live = true }) {
  const stageRef = useRef(null);
  const [pinsLive, setPinsLive] = useState(false);

  const marks = Array.isArray(marked?.marks) ? marked.marks : [];
  const hasMarks = marks.length > 0;

  useEffect(() => {
    // Same trigger the traced map uses: mount the animation only after the
    // card scrolls into view on a motion-tolerant screen, so PDFs (no scroll,
    // print media) and reduced-motion visitors get the settled frame.
    if (!live || !hasMarks || pinsLive) return undefined;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const el = stageRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setPinsLive(true); obs.disconnect(); }
    }, { threshold: 0.35 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [live, hasMarks, pinsLive]);

  // No marks means no card — the optional-marks ruling. The photo still
  // appears in the ordinary gallery; nothing here signals an absence.
  if (!marked?.url || !hasMarks) return null;

  const legend = Array.isArray(marked.legend) ? marked.legend : [];
  const caption = CAPTIONS[marked.captionKey] || FALLBACK_CAPTION;

  return (
    <section data-glass="card" className="sr-section" id="treated-points">
      <h2>Where we treated</h2>
      <p className="sr-ink" style={{ fontSize: 15, color: '#04395E', lineHeight: 1.5, margin: '0 0 16px' }}>
        Your technician photographed the treated area and marked each point.
      </p>
      <div
        ref={stageRef}
        style={{
          position: 'relative',
          borderRadius: 8,
          overflow: 'hidden',
          border: '0.5px solid #d4d4d4',
          lineHeight: 0,
        }}
      >
        {/* Eager on purpose: the PDF renderer prints without scrolling, so a
            native-lazy image below the fold could render blank. */}
        <img
          src={marked.url}
          alt={marked.caption || 'Photograph of the treated area with the treated points marked'}
          style={{ width: '100%', display: 'block' }}
        />
        {pinsLive && (
          <style>{`
            @keyframes markedPinPop {
              from { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
              to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            }
            .marked-pin-pop { animation: markedPinPop .42s cubic-bezier(.2,1.5,.4,1) backwards; }
          `}</style>
        )}
        {marks.map((mark, i) => (
          <div
            key={`${mark.n}-${mark.kind}`}
            className={pinsLive ? 'marked-pin-pop' : undefined}
            // Percentage offsets ARE the stored normalized 0..1 coordinates —
            // no pixel math, so the card holds at any width and on any device
            // the photo came from.
            style={{
              position: 'absolute',
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              ...(pinsLive ? { animationDelay: `${i * 90}ms` } : null),
            }}
            role="img"
            aria-label={`Mark ${mark.n}: ${mark.label || 'treated point'}`}
          >
            <span
              style={{
                position: 'absolute', left: '50%', top: '50%',
                width: 7, height: 7, margin: '-3.5px 0 0 -3.5px',
                borderRadius: '50%', background: '#fff',
                boxShadow: '0 0 0 2px rgba(8,20,28,.55)',
              }}
            />
            <span
              style={{
                position: 'absolute', left: '50%', bottom: 3,
                width: 2, height: 11, marginLeft: -1,
                background: 'rgba(255,255,255,.9)',
                boxShadow: '0 0 3px rgba(6,16,24,.6)',
              }}
            />
            <span
              style={{
                position: 'absolute', left: '50%', bottom: 13,
                transform: 'translateX(-50%)',
                minWidth: 25, height: 25, padding: '0 6px',
                borderRadius: 999, border: '2px solid rgba(255,255,255,.94)',
                background: KIND_COLOR[mark.kind] || DEFAULT_COLOR,
                color: '#fff', fontSize: 12, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 7px rgba(6,16,24,.5)',
                lineHeight: 1,
              }}
            >
              {mark.n}
            </span>
          </div>
        ))}
      </div>
      {legend.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', margin: '12px 0 0' }}>
          {legend.map((entry) => (
            <span
              key={entry.kind}
              style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 14, color: '#04395E' }}
            >
              <span
                style={{
                  width: 11, height: 11, borderRadius: '50%', flex: 'none',
                  background: KIND_COLOR[entry.kind] || DEFAULT_COLOR,
                }}
              />
              {entry.label}
            </span>
          ))}
        </div>
      )}
      <p style={{ fontSize: 14, color: '#04395E', margin: '10px 0 0', lineHeight: 1.5 }}>
        {caption}
      </p>
    </section>
  );
}
