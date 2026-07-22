// Traced Treatment Zone map + spray render (owner 2026-07-21): the
// tech-traced perimeter snapshot with the looping smoke/spray replay.
// Shared by the pest V2 hero and the legacy coverage card.
import { useEffect, useRef, useState } from 'react';

export default function TracedTreatmentZoneMap({ traced }) {
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
    if (!canReplay || sprayLive) return undefined;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const el = mapRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSprayLive(true); obs.disconnect(); }
    }, { threshold: 0.35 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [canReplay, sprayLive]);

  if (!traced?.snapshotUrl) return null;
  const caption = [
    traced.label || 'Treated perimeter traced on-site by your technician.',
    traced.linearFt ? `${traced.linearFt} linear ft treated.` : null,
  ].filter(Boolean).join(' ');
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
          alt="Satellite photo of the property with the treated perimeter highlighted"
        />
        {sprayLive && pathD && (
          <svg
            viewBox="0 0 1280 960"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            <defs>
              {/* smoke, not lines: everything renders through a heavy blur so
                  the band reads as drifting spray — same teal as the mist the
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
                50% { opacity: 0.55; }
              }
              .traced-spray-line { animation: tracedSprayDraw 3.2s ease-in-out both; }
              .traced-mist-breathe { animation: tracedMistPulse 4.8s ease-in-out 3.2s infinite; }
              .traced-spray-puff { opacity: 0; transform-box: fill-box; transform-origin: center; animation: tracedSprayPuff 7s linear infinite; }
              .traced-spray-emitter { animation: tracedEmitterBreathe 1.4s ease-in-out infinite; }
            `}</style>
            {/* wide soft mist band + tighter dense core — draw in once, then
                the whole band breathes */}
            <g className="traced-mist-breathe">
              <path
                className="traced-spray-line"
                d={pathD}
                fill="none"
                stroke="#2FA89D"
                strokeOpacity="0.34"
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
                stroke="#2FA89D"
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
                <circle cx={Math.round(p.x)} cy={Math.round(p.y)} r="30" fill="#2FA89D" fillOpacity="0.5" />
                <circle cx={Math.round(p.x) + 14} cy={Math.round(p.y) - 10} r="20" fill="#7CD6CB" fillOpacity="0.45" />
                <circle cx={Math.round(p.x) - 13} cy={Math.round(p.y) + 6} r="17" fill="#2FA89D" fillOpacity="0.4" />
              </g>
            ))}
            {/* mist emitter — a glowing spray blob riding the band, no hard marker */}
            <g className="traced-spray-emitter" filter="url(#tracedMistBlur)">
              <circle r="26" fill="#7CD6CB" fillOpacity="0.8">
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