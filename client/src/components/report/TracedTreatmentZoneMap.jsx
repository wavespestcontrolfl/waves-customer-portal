// Traced Treatment Zone map + spray render (owner 2026-07-21): the
// tech-traced perimeter snapshot with the looping smoke/spray replay.
// Shared by the pest V2 hero and the legacy coverage card.
// variant="outline" (owner 2026-07-28): lawn visits treat an AREA, not a
// perimeter barrier — the smoke/spray replay read wrong on lawn reports.
// Lawn renders a clean pulsing outline of the treated lawn instead.
import { useEffect, useRef, useState } from 'react';

export default function TracedTreatmentZoneMap({ traced, live = true, variant = 'spray' }) {
  // Spray replay (owner 2026-07-21): the tech-side mapper animates a
  // spray-mist "applying" the barrier along the traced line — the customer
  // report replays it over the saved snapshot. Mounts ONLY after the map
  // scrolls into view on a motion-tolerant screen, so PDFs (no scroll, print
  // media) and reduced-motion visitors keep the plain snapshot — which
  // already carries the settled mist baked in.
  const mapRef = useRef(null);
  const [sprayLive, setSprayLive] = useState(false);
  const points = Array.isArray(traced?.pathPoints) ? traced.pathPoints : [];
  const canReplay = points.length >= 2;
  useEffect(() => {
    // pdf/static renders keep the plain snapshot — the PDF renderer has a
    // window + IntersectionObserver, so mode gating is the only reliable
    // guard against capturing an arbitrary animation frame (codex P2).
    if (!live || !canReplay || sprayLive) return undefined;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const el = mapRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSprayLive(true); obs.disconnect(); }
    }, { threshold: 0.35 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [live, canReplay, sprayLive]);

  if (!traced?.snapshotUrl) return null;
  const outline = variant === 'outline';
  // Only traces CAPTURED by the lawn outline workflow may claim "treated lawn
  // area" — legacy rows predate capture_mode and may be building-perimeter
  // traces, so they keep a neutral caption and skip the interior wash while
  // still getting the calmer outline presentation (codex P1 #3038).
  // 'lawn_highlight' = the snapshot carries the baked grass highlight —
  // suppress the polygon overlay and say "highlighted". Plain 'lawn' rows
  // (legacy saves + highlight-fallback saves) contain the baked OUTLINE, so
  // they keep the outline overlay and outline language — the caption must
  // never claim a highlight the snapshot doesn't contain (codex P1 #3075).
  const highlightCapture = traced.captureMode === 'lawn_highlight';
  const lawnCapture = traced.captureMode === 'lawn' || highlightCapture;
  // Interior-spray captures (owner 2026-07-29) flood the traced footprint
  // with the brand-blue wash — only rows captured that way, and only closed
  // loops, get the fill (same area-claim rule as lawn).
  const interiorCapture = traced.captureMode === 'interior' && Boolean(traced.closedLoop);
  // No linear-ft figure in the customer caption (owner 2026-07-21). The
  // server label speaks perimeter language — the outline variant tells the
  // area story instead.
  const caption = outline
    ? (highlightCapture
      ? 'Treated lawn areas highlighted on-site by your technician.'
      : (lawnCapture
        ? 'Treated lawn area outlined on-site by your technician.'
        : 'Service area traced on-site by your technician.'))
    : (traced.label || 'Treated perimeter traced on-site by your technician.');
  const pathD = canReplay
    ? `M ${points.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(' L ')}${traced.closedLoop ? ' Z' : ''}`
    : null;
  // Mist puffs sampled along the trace — every ~4th point keeps it airy.
  const puffs = canReplay ? points.filter((_, i) => i % 4 === 0).slice(0, 24) : [];
  return (
    <div className="service-coverage-map-panel">
      <div className="service-coverage-map traced-zone-map" ref={mapRef} style={{ position: 'relative' }}>
        {/* Eager on purpose: the PDF renderer prints without scrolling, so a
            native-lazy image below the fold could render blank in PDFs. */}
        <img
          className="traced-zone-image"
          src={traced.snapshotUrl}
          alt={outline
            ? (highlightCapture
              ? 'Satellite photo of the property with the treated lawn areas highlighted'
              : (lawnCapture
                ? 'Satellite photo of the property with the treated lawn area outlined'
                : 'Satellite photo of the property with the technician-traced service area outlined'))
            : (interiorCapture
              ? 'Satellite photo of the property with the treated home and perimeter highlighted'
              : 'Satellite photo of the property with the treated perimeter highlighted')}
        />
        {/* Highlight-captured rows carry the grass HIGHLIGHT baked into the
            snapshot (owner 2026-07-30: no box) — never draw the polygon
            overlay on them. Legacy 'lawn' rows and highlight-fallback rows
            carry the baked OUTLINE and keep the animated line. */}
        {sprayLive && pathD && outline && !highlightCapture && (
          <svg
            viewBox="0 0 1280 960"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            <defs>
              <filter id="outlineGlow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
            </defs>
            <style>{`
              @keyframes outlineDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
              /* The treated area breathes: a slow, calm pulse — no smoke, no
                 emitter. Draw-in plays once, then the pulse takes over. */
              @keyframes outlinePulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.35; }
              }
              .treated-outline-line { animation: outlineDraw 2.4s ease-in-out both; }
              .treated-outline-pulse { animation: outlinePulse 3.6s ease-in-out 2.4s infinite; }
            `}</style>
            {/* NO interior fill — the loop commonly wraps the yard with the
                house inside it, and a filled polygon would shade the roof as
                treated turf (codex P1 #3038 r3). The boundary + pulse carry
                the treated-area story. */}
            <g className="treated-outline-pulse">
              <path
                className="treated-outline-line"
                d={pathD}
                fill="none"
                stroke="#7CC7F0"
                strokeOpacity="0.5"
                strokeWidth="22"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength="1"
                strokeDasharray="1"
                filter="url(#outlineGlow)"
              />
              {/* white casing keeps the navy core readable over dark roofs */}
              <path
                className="treated-outline-line"
                d={pathD}
                fill="none"
                stroke="#FFFFFF"
                strokeOpacity="0.8"
                strokeWidth="12"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength="1"
                strokeDasharray="1"
              />
              <path
                className="treated-outline-line"
                d={pathD}
                fill="none"
                stroke="#0A7EC2"
                strokeOpacity="0.95"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength="1"
                strokeDasharray="1"
              />
            </g>
          </svg>
        )}
        {sprayLive && pathD && !outline && (
          <svg
            viewBox="0 0 1280 960"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            <defs>
              {/* smoke, not lines: everything renders through a heavy blur so
                  the band reads as drifting spray — same brand navy as the mist the
                  tech-side engine bakes into the snapshot (MIST_COLOR). */}
              <filter id="tracedMistBlur" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="10" />
              </filter>
              <filter id="tracedMistBlurSoft" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="16" />
              </filter>
            </defs>
            <style>{`
              @keyframes tracedSprayDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
              /* Smoke loop (owner 2026-07-21): each puff swells, drifts up a
                 touch, and dissolves once per cycle as the emitter passes. */
              @keyframes tracedSprayPuff {
                0% { opacity: 0; transform: translateY(0) scale(0.5); }
                8% { opacity: 0.55; }
                26% { opacity: 0; transform: translateY(-16px) scale(2.4); }
                100% { opacity: 0; transform: translateY(-16px) scale(2.4); }
              }
              @keyframes tracedEmitterBreathe {
                0%, 100% { opacity: 0.75; }
                50% { opacity: 0.45; }
              }
              /* The settled band breathes — a slow opacity/size pulse so the
                 barrier reads as alive (owner 2026-07-21). Draw-in plays
                 first, then the pulse takes over. */
              @keyframes tracedMistPulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.35; }
              }
              .traced-spray-line { animation: tracedSprayDraw 3.2s ease-in-out both; }
              .traced-mist-breathe { animation: tracedMistPulse 4.8s ease-in-out 3.2s infinite; }
              .traced-spray-puff { opacity: 0; transform-box: fill-box; transform-origin: center; animation: tracedSprayPuff 7s linear infinite; }
              .traced-spray-emitter { animation: tracedEmitterBreathe 1.4s ease-in-out infinite; }
            `}</style>
            {/* wide soft mist band + tighter dense core — draw in once, then
                the whole band breathes */}
            <g className="traced-mist-breathe">
              {interiorCapture && (
                /* interior-spray capture: the footprint breathes with the
                   band — the snapshot already carries the settled wash */
                <path d={pathD} fill="#0A7EC2" fillOpacity="0.14" stroke="none" />
              )}
              <path
                className="traced-spray-line"
                d={pathD}
                fill="none"
                stroke="#0A7EC2"
                strokeOpacity="0.4"
                strokeWidth="58"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength="1"
                strokeDasharray="1"
                filter="url(#tracedMistBlurSoft)"
              />
              <path
                className="traced-spray-line"
                d={pathD}
                fill="none"
                stroke="#0A7EC2"
                strokeOpacity="0.52"
                strokeWidth="26"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength="1"
                strokeDasharray="1"
                filter="url(#tracedMistBlur)"
              />
            </g>
            {/* smoke puffs — clustered blurred blobs, not crisp circles */}
            {puffs.map((p, i) => (
              <g
                key={i}
                className="traced-spray-puff"
                filter="url(#tracedMistBlur)"
                style={{ animationDelay: `${(i / Math.max(1, puffs.length)) * 7}s` }}
              >
                {/* dark waves-navy smoke with one light accent so the puffs
                    still read as mist, not shadow (owner 2026-07-29) */}
                <circle cx={Math.round(p.x)} cy={Math.round(p.y)} r="30" fill="#0A7EC2" fillOpacity="0.5" />
                <circle cx={Math.round(p.x) + 14} cy={Math.round(p.y) - 10} r="20" fill="#7CC7F0" fillOpacity="0.45" />
                <circle cx={Math.round(p.x) - 13} cy={Math.round(p.y) + 6} r="17" fill="#0A7EC2" fillOpacity="0.4" />
              </g>
            ))}
            {/* mist emitter — a glowing spray blob riding the band, no hard marker */}
            <g className="traced-spray-emitter" filter="url(#tracedMistBlur)">
              <circle r="26" fill="#7CC7F0" fillOpacity="0.8">
                <animateMotion dur="7s" repeatCount="indefinite" path={pathD} calcMode="linear" />
              </circle>
            </g>
          </svg>
        )}
      </div>
      <p className="traced-zone-caption">{caption}</p>
    </div>
  );
}