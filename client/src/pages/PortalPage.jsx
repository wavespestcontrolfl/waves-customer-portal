import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import api from '../utils/api';
import { COLORS as B, TIER, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme';
import NotificationBell from '../components/NotificationBell';

// Normalize date strings from API — handles both "2026-04-02" and "2026-04-02T00:00:00.000Z"
function parseDate(d) {
  if (!d) return new Date(NaN);
  const str = typeof d === 'string' ? d.split('T')[0] : new Date(d).toISOString().split('T')[0];
  return new Date(str + 'T12:00:00');
}

function fmtDate(d, opts) {
  const dt = parseDate(d);
  return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', opts);
}

// =========================================================================
// TAB BAR — scrollable for 6 tabs on mobile
// =========================================================================
function TabBar({ tabs, active, onSelect }) {
  const scrollRef = useRef(null);
  const [hovered, setHovered] = useState(null);
  const rafRef = useRef(null);
  const velocityRef = useRef(0);

  const handleMouseMove = useCallback((e) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    const edge = 0.12;

    if (pct < edge) {
      velocityRef.current = -(1 - pct / edge) * 6;
    } else if (pct > 1 - edge) {
      velocityRef.current = ((pct - (1 - edge)) / edge) * 6;
    } else {
      velocityRef.current = 0;
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      const el = scrollRef.current;
      if (el && velocityRef.current !== 0) {
        el.scrollLeft += velocityRef.current;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <>
      <style>{`.tabs-scroll::-webkit-scrollbar{display:none}`}</style>
      <div
        ref={scrollRef}
        className="tabs-scroll"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { velocityRef.current = 0; setHovered(null); }}
        style={{
          display: 'flex', gap: 4, background: B.white, borderRadius: 14,
          padding: 5, maxWidth: 700, margin: '0 auto', overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          scrollbarWidth: 'none', scrollBehavior: 'smooth',
        }}
      >
        {tabs.map(t => {
          const isActive = active === t.id;
          const isHovered = hovered === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              onMouseEnter={() => setHovered(t.id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                flex: '0 0 auto', padding: '11px 16px', borderRadius: 11, border: 'none',
                cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
                fontWeight: isActive ? 700 : 600,
                fontFamily: FONTS.heading,
                background: isActive ? B.wavesBlue : isHovered ? `${B.wavesBlue}18` : 'transparent',
                color: isActive ? B.white : isHovered ? B.wavesBlue : B.grayMid,
                boxShadow: isActive ? `0 2px 8px ${B.wavesBlue}30` : 'none',
                transition: 'all 0.2s ease',
                transform: isHovered && !isActive ? 'scale(1.04)' : 'scale(1)',
              }}
            >{t.icon} {t.label}</button>
          );
        })}
      </div>
    </>
  );
}

// =========================================================================
// SECTION HEADING HELPER
// =========================================================================
function SectionHeading({ children }) {
  return <div style={{ fontSize: 22, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, letterSpacing: -0.3 }}>{children}</div>;
}

// Wave divider SVG — used between sections
function WaveDivider() {
  return (
    <div style={{ height: 20, overflow: 'hidden', margin: '4px 0' }}>
      <svg viewBox="0 0 1200 60" style={{ width: '100%', height: '100%' }}>
        <path d="M0,30 C200,60 400,0 600,30 C800,60 1000,0 1200,30" fill="none" stroke={B.blueLight} strokeWidth="2" strokeOpacity="0.3" />
      </svg>
    </div>
  );
}

// =========================================================================
// SOCIAL FOOTER — reusable across all tabs
// =========================================================================
const SOCIAL_LINKS = [
  { name: 'Facebook', url: 'https://facebook.com/wavespestcontrol', path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  { name: 'YouTube', url: 'https://youtube.com/@wavespestcontrol', path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { name: 'TikTok', url: 'https://tiktok.com/@wavespestcontrol', path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'Pinterest', url: 'https://pinterest.com/wavespestcontrol', path: 'M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12.017 24c6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641 0 12.017 0z' },
  { name: 'LinkedIn', url: 'https://linkedin.com/company/wavespestcontrol', path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  { name: 'X', url: 'https://x.com/wavespest', path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
];

function SocialIcon({ path, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d={path} />
    </svg>
  );
}

const GBP_LOCATIONS = [
  { name: 'Lakewood Ranch', url: 'https://maps.google.com/?cid=14769059513826704468', reviewUrl: 'https://g.page/r/CVRc_P5butTMEBM/review' },
  { name: 'Parrish',        url: 'https://maps.google.com/?cid=4289832891027056559',  reviewUrl: 'https://g.page/r/Ca-4KKoWwFacEBM/review' },
  { name: 'Sarasota',       url: 'https://maps.google.com/?cid=15891900048665778201', reviewUrl: 'https://g.page/r/CRkzS6M4EpncEBM/review' },
  { name: 'Venice',         url: 'https://maps.google.com/?cid=4727792987037655364',  reviewUrl: 'https://g.page/r/CURA5pQ1KatBEBM/review' },
];

function SocialFooter({ compact }) {
  const [hovered, setHovered] = useState(null);
  const [hoveredCity, setHoveredCity] = useState(null);
  const circleSize = compact ? 36 : 44;
  const iconSize = compact ? 16 : 20;

  return (
    <div style={{ padding: compact ? '16px 0' : '32px 0 16px', textAlign: 'center' }}>
      {!compact && (
        <div style={{ height: 20, overflow: 'hidden', marginBottom: 20 }}>
          <svg viewBox="0 0 1200 40" style={{ width: '100%', height: '100%' }}>
            <path d="M0,20 C150,40 350,0 500,20 C650,40 850,0 1000,20 C1100,35 1200,10 1200,20" fill="none" stroke={B.blueLight} strokeWidth="2" strokeOpacity="0.2" />
          </svg>
        </div>
      )}

      <div style={{
        fontSize: compact ? 12 : 14, fontWeight: 600, color: B.grayDark,
        fontFamily: FONTS.heading, marginBottom: compact ? 10 : 14,
      }}>🌊 Stay in the loop</div>

      <div style={{ display: 'flex', gap: compact ? 10 : 14, justifyContent: 'center', flexWrap: 'wrap' }}>
        {SOCIAL_LINKS.map(s => {
          const isHov = hovered === s.name;
          return (
            <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" title={s.name}
              onMouseEnter={() => setHovered(s.name)} onMouseLeave={() => setHovered(null)}
              style={{
                width: circleSize, height: circleSize, borderRadius: '50%',
                background: isHov ? B.wavesBlue : B.blueSurface,
                color: isHov ? B.white : B.wavesBlue,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                textDecoration: 'none', transition: 'all 0.2s ease',
                transform: isHov ? 'scale(1.1)' : 'scale(1)',
              }}
            >
              <SocialIcon path={s.path} size={iconSize} />
            </a>
          );
        })}
      </div>

      {!compact && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: B.wavesBlue, fontFamily: FONTS.heading, marginBottom: 6 }}>
            Wave Goodbye to Pests! 🌊
          </div>
          <div style={{ fontSize: 13, color: B.grayMid, fontFamily: FONTS.body }}>Waves Pest Control, LLC</div>
          <div style={{ fontSize: 12, color: B.grayMid, fontFamily: FONTS.body, marginTop: 2 }}>
            Family-owned pest control & lawn care · Southwest Florida
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            {GBP_LOCATIONS.map((loc, i) => (
              <span key={loc.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <a href={loc.url} target="_blank" rel="noopener noreferrer"
                  onMouseEnter={() => setHoveredCity(loc.name)} onMouseLeave={() => setHoveredCity(null)}
                  style={{
                    fontSize: 12, fontWeight: 600, fontFamily: FONTS.body,
                    color: hoveredCity === loc.name ? B.wavesBlue : B.grayMid,
                    textDecoration: 'none', transition: 'color 0.2s ease',
                  }}>{loc.name}</a>
                {i < GBP_LOCATIONS.length - 1 && <span style={{ color: B.grayLight, fontSize: 10 }}>·</span>}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11, color: B.grayMid, fontFamily: FONTS.body, marginTop: 12 }}>
            © {new Date().getFullYear()} Waves Pest Control, LLC · All rights reserved
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// LAWN HEALTH HOOK
// =========================================================================
function useLawnHealth(customerId) {
  const [data, setData] = useState({ scores: null, initialScores: null, hasLawnCare: false, loading: true });

  useEffect(() => {
    if (!customerId) return;
    api.getLawnHealth(customerId)
      .then(d => setData({ scores: d.scores, initialScores: d.initialScores, hasLawnCare: d.hasLawnCare, loading: false }))
      .catch(() => setData(prev => ({ ...prev, loading: false })));
  }, [customerId]);

  return data;
}

// =========================================================================
// BEFORE / AFTER PHOTO COMPARISON SLIDER
// =========================================================================
function BeforeAfterSlider() {
  const [position, setPosition] = useState(50);
  const containerRef = useRef(null);
  const dragging = useRef(false);

  const updatePosition = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setPosition((x / rect.width) * 100);
  }, []);

  const onPointerDown = useCallback((e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePosition(e.clientX);
  }, [updatePosition]);

  const onPointerMove = useCallback((e) => {
    if (dragging.current) updatePosition(e.clientX);
  }, [updatePosition]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'relative', width: '100%', height: 200, borderRadius: 14,
        overflow: 'hidden', cursor: 'ew-resize', userSelect: 'none', touchAction: 'none',
      }}
    >
      {/* BEFORE layer (full width, underneath) */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(135deg, #8B6914 0%, #A0522D 40%, #CD853F 70%, #D2B48C 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: 40 }}>🏠</div>
        <div style={{ color: '#fff', fontWeight: 800, fontSize: 14, fontFamily: FONTS.heading, textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
          BEFORE — Jan 28
        </div>
        <div style={{ color: '#ffffffcc', fontSize: 11, fontFamily: FONTS.body, marginTop: 2 }}>
          Sparse, dollar weed, thatch
        </div>
      </div>

      {/* AFTER layer (clips based on slider) */}
      <div style={{
        position: 'absolute', inset: 0,
        clipPath: `inset(0 ${100 - position}% 0 0)`,
        background: 'linear-gradient(135deg, #2E7D32 0%, #43A047 30%, #66BB6A 60%, #81C784 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        transition: dragging.current ? 'none' : 'clip-path 0.05s ease-out',
      }}>
        <div style={{ fontSize: 40 }}>🏠</div>
        <div style={{ color: '#fff', fontWeight: 800, fontSize: 14, fontFamily: FONTS.heading, textShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
          AFTER — Mar 25
        </div>
        <div style={{ color: '#ffffffcc', fontSize: 11, fontFamily: FONTS.body, marginTop: 2 }}>
          Dense, filling in, healthy
        </div>
      </div>

      {/* Slider handle */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: `${position}%`,
        transform: 'translateX(-50%)', width: 3, background: '#fff',
        boxShadow: '0 0 8px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 36, height: 36, borderRadius: '50%', background: '#fff',
          boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, color: B.navy,
        }}>⇔</div>
      </div>
    </div>
  );
}

// =========================================================================
// LAWN HEALTH CARD — progress bars + photo slider
// =========================================================================
function LawnHealthCard({ scores, initialScores }) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(timer);
  }, []);

  const metrics = [
    { label: 'Turf Density', key: 'turfDensity', initialKey: 'turfDensity' },
    { label: 'Weed Suppression', key: 'weedSuppression', initialKey: 'weedSuppression' },
    { label: 'Fungus Control', key: 'fungusControl', initialKey: 'fungusControl' },
    { label: 'Thatch Level', key: 'thatchScore', initialKey: 'thatchScore', thatchInches: true },
  ];

  return (
    <div style={{
      background: B.white, borderRadius: 16, padding: 20,
      border: `2px solid ${B.green}22`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 24 }}>🌱</span>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Lawn Health Progress</div>
      </div>
      <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 18, paddingLeft: 34 }}>
        Your lawn's journey since starting the premium program.
      </div>

      {/* Progress Bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {metrics.map((m, i) => {
          const current = scores[m.key];
          const initial = initialScores[m.initialKey];
          const thatchNote = m.thatchInches && scores.thatchInches
            ? ` · ${scores.thatchInches}" monitoring` : '';
          return (
            <div key={m.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, fontFamily: FONTS.body }}>{m.label}</span>
                <span style={{ fontSize: 12, fontFamily: FONTS.ui }}>
                  <span style={{ fontWeight: 700, color: B.green }}>{current}%</span>
                  <span style={{ color: B.grayMid, fontSize: 11, marginLeft: 4 }}>from {initial}%{thatchNote}</span>
                </span>
              </div>
              <div style={{
                position: 'relative', height: 10, borderRadius: 5, background: B.grayLight, overflow: 'hidden',
              }}>
                {/* Faded background bar showing initial/starting value */}
                <div style={{
                  position: 'absolute', height: '100%', borderRadius: 5,
                  background: `linear-gradient(90deg, ${B.teal}30, ${B.green}30)`,
                  width: `${initial}%`,
                }} />
                {/* Filled gradient bar showing current value */}
                <div style={{
                  position: 'absolute', height: '100%', borderRadius: 5,
                  background: `linear-gradient(90deg, ${B.teal}, ${B.green})`,
                  width: animated ? `${current}%` : '0%',
                  transition: `width 1s ease-out ${i * 0.15}s`,
                }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Before / After Slider */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: B.grayDark, fontFamily: FONTS.heading, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Before &amp; After
        </div>
        <BeforeAfterSlider />
      </div>
    </div>
  );
}

// =========================================================================
// BADGE SYSTEM — dashboard row, celebration toast, detail modal
// =========================================================================
function useBadges() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getBadges()
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return { data, loading };
}

function BadgeRow({ badges, earnedCount, totalCount, onViewAll }) {
  if (!badges) return null;
  const earned = badges.filter(b => b.earned).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
  if (!earned.length) return null;

  const displayBadges = earned.slice(0, 8);
  const remaining = earned.length - displayBadges.length;

  return (
    <div style={{
      background: B.white, borderRadius: 14, padding: '14px 18px',
      border: `1px solid ${B.grayLight}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Your Badges</div>
        <div style={{ fontSize: 11, color: B.grayMid }}>{earnedCount} of {totalCount}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
        {displayBadges.map(b => (
          <div key={b.badgeType} title={b.title} style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: `${B.wavesBlue}12`, border: `1.5px solid ${B.wavesBlue}33`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>{b.icon}</div>
        ))}
        {remaining > 0 && (
          <div onClick={onViewAll} style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: B.offWhite, border: `1px solid ${B.grayLight}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: B.grayMid, cursor: 'pointer',
          }}>+{remaining}</div>
        )}
      </div>
    </div>
  );
}

function BadgeShowcase({ badges, categories }) {
  const [selected, setSelected] = useState(null);

  if (!badges) return null;

  // Group by category
  const grouped = {};
  for (const b of badges) {
    if (!grouped[b.category]) grouped[b.category] = [];
    grouped[b.category].push(b);
  }

  const earnedCount = badges.filter(b => b.earned).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 16, padding: 20, color: '#fff', textAlign: 'center',
      }}>
        <div style={{ fontSize: 32 }}>🏅</div>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginTop: 4 }}>{earnedCount} Badges Earned</div>
        <div style={{ fontSize: 13, color: B.blueLight, marginTop: 4 }}>out of {badges.length} total</div>
        <div style={{
          marginTop: 12, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.15)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 3,
            background: `linear-gradient(90deg, ${B.yellow}, ${B.orange})`,
            width: `${(earnedCount / badges.length) * 100}%`,
            transition: 'width 1s ease-out',
          }} />
        </div>
      </div>

      {Object.entries(grouped).map(([cat, catBadges]) => (
        <div key={cat}>
          <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
            {categories[cat] || cat}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {catBadges.sort((a, b) => a.order - b.order).map(b => (
              <div key={b.badgeType} onClick={() => setSelected(b)} style={{
                background: B.white, borderRadius: 12, padding: '14px 8px',
                border: `1px solid ${b.earned ? B.wavesBlue + '33' : B.grayLight}`,
                textAlign: 'center', cursor: 'pointer',
                opacity: b.earned ? 1 : 0.5,
                transition: 'transform 0.15s',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%', margin: '0 auto',
                  background: b.earned ? `${B.wavesBlue}12` : B.grayLight,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, position: 'relative',
                }}>
                  {b.icon}
                  {!b.earned && (
                    <div style={{
                      position: 'absolute', bottom: -2, right: -2,
                      fontSize: 10, background: B.grayMid, color: '#fff',
                      width: 16, height: 16, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>🔒</div>
                  )}
                </div>
                <div style={{
                  fontSize: 11, fontWeight: 600, marginTop: 6,
                  color: b.earned ? B.navy : B.grayMid,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{b.title}</div>
                {b.earned && b.earnedAt && (
                  <div style={{ fontSize: 9, color: B.grayMid, marginTop: 2 }}>
                    {new Date(b.earnedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                  </div>
                )}
                {!b.earned && b.progress && (
                  <div style={{ fontSize: 9, color: B.orange, fontWeight: 600, marginTop: 2 }}>{b.progress}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Badge Detail Modal */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: B.white, borderRadius: 20, padding: 28, maxWidth: 340, width: '100%',
            textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%', margin: '0 auto',
              background: selected.earned ? `${B.wavesBlue}12` : B.grayLight,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 36,
            }}>{selected.icon}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: 12 }}>
              {selected.title}
            </div>
            <div style={{ fontSize: 10, color: B.wavesBlue, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 4 }}>
              {selected.categoryLabel}
            </div>
            <div style={{ fontSize: 13, color: B.grayDark, marginTop: 10, lineHeight: 1.6 }}>
              {selected.description}
            </div>

            {selected.earned ? (
              <div style={{ fontSize: 12, color: B.green, fontWeight: 600, marginTop: 12 }}>
                ✓ Earned {selected.earnedAt ? new Date(selected.earnedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
              </div>
            ) : (
              <>
                {selected.progress && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: B.grayMid, marginBottom: 4 }}>Progress</div>
                    <div style={{
                      height: 6, borderRadius: 3, background: B.grayLight, overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', borderRadius: 3, background: B.orange,
                        width: (() => {
                          const match = selected.progress.match(/(\d+)\/(\d+)/);
                          return match ? `${(parseInt(match[1]) / parseInt(match[2])) * 100}%` : '0%';
                        })(),
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: B.orange, fontWeight: 600, marginTop: 4 }}>{selected.progress}</div>
                  </div>
                )}
              </>
            )}

            {selected.nextBadgeInCategory && (
              <div style={{
                marginTop: 14, padding: '10px 14px', borderRadius: 10,
                background: B.offWhite, border: `1px solid ${B.grayLight}`,
              }}>
                <div style={{ fontSize: 10, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.5 }}>Next badge</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: B.navy, marginTop: 2 }}>{selected.nextBadgeInCategory.title}</div>
                <div style={{ fontSize: 11, color: B.orange, marginTop: 1 }}>{selected.nextBadgeInCategory.remaining}</div>
              </div>
            )}

            <button onClick={() => setSelected(null)} style={{
              ...BUTTON_BASE, marginTop: 16, padding: '9px 24px', fontSize: 13,
              background: B.offWhite, color: B.grayDark, border: `1px solid ${B.grayLight}`,
            }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BadgeCelebrationToast({ badges }) {
  const [toasts, setToasts] = useState([]);
  const notifiedRef = useRef(new Set());

  useEffect(() => {
    if (!badges) return;
    const unnotified = badges.filter(b => b.earned && !b.notified && !notifiedRef.current.has(b.badgeType));
    if (!unnotified.length) return;

    // Queue toasts 2 seconds apart
    unnotified.forEach((b, i) => {
      notifiedRef.current.add(b.badgeType);
      setTimeout(() => {
        setToasts(prev => [...prev, b]);
        api.notifyBadge(b.badgeType).catch(() => {});
        // Remove after 4 seconds
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.badgeType !== b.badgeType));
        }, 4000);
      }, i * 2000);
    });
  }, [badges]);

  if (!toasts.length) return null;

  return (
    <>
      <style>{`
        @keyframes toast-slide-in { from { transform: translateY(-100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes toast-slide-out { from { opacity: 1; } to { opacity: 0; transform: translateY(-20px); } }
        @keyframes badge-confetti { 0% { transform: translateY(0) rotate(0); opacity: 1; } 100% { transform: translateY(60px) rotate(360deg); opacity: 0; } }
      `}</style>
      {toasts.map((b, i) => (
        <div key={b.badgeType} style={{
          position: 'fixed', top: 60 + i * 70, left: '50%', transform: 'translateX(-50%)',
          zIndex: 2000, animation: 'toast-slide-in 0.5s ease-out',
          background: B.white, borderRadius: 16, padding: '12px 20px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.15)', border: `2px solid ${B.yellow}`,
          display: 'flex', alignItems: 'center', gap: 12, minWidth: 280,
          overflow: 'visible', position: 'fixed',
        }}>
          {/* Mini confetti */}
          {[B.yellow, B.green, B.wavesBlue, B.orange].map((c, j) => (
            <div key={j} style={{
              position: 'absolute', top: -4, left: `${20 + j * 20}%`,
              width: 5, height: 5, borderRadius: j % 2 ? 1 : '50%',
              background: c, animation: `badge-confetti 1.5s ease-out ${j * 0.1}s forwards`,
            }} />
          ))}
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: `${B.yellow}20`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 20, flexShrink: 0,
          }}>{b.icon}</div>
          <div>
            <div style={{ fontSize: 11, color: B.yellow, fontWeight: 700 }}>🎉 New Badge Earned!</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{b.title}</div>
          </div>
        </div>
      ))}
    </>
  );
}

// =========================================================================
// CONTEXTUAL PROMOTION CARDS
// =========================================================================
function PromotionCards() {
  const [promoData, setPromoData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(null); // promoId being acted on
  const [interested, setInterested] = useState(new Set());

  useEffect(() => {
    api.getRelevantPromotions()
      .then(d => { setPromoData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleInterest = async (promo) => {
    setInteracting(promo.id);
    try {
      await api.expressPromoInterest(promo.id, {
        serviceType: promo.serviceType,
        serviceName: promo.serviceName,
      });
      setInterested(prev => new Set([...prev, promo.id]));
    } catch (err) { console.error(err); }
    setInteracting(null);
  };

  const handleDismiss = async (promoId) => {
    try {
      await api.dismissPromotion(promoId);
      setPromoData(prev => ({
        ...prev,
        promotions: prev.promotions.filter(p => p.id !== promoId),
      }));
    } catch (err) { console.error(err); }
  };

  if (loading || !promoData) return null;

  // Fully protected — celebration card
  if (promoData.fullyProtected) {
    return (
      <div style={{
        background: `linear-gradient(135deg, ${B.green}15, ${B.teal}10)`,
        borderRadius: 16, padding: 20,
        border: `2px solid ${B.green}22`,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 28 }}>🛡️</div>
        <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: 8 }}>
          You're Fully Protected
        </div>
        <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>
          WaveGuard Platinum member saving {promoData.discount} on everything. Thank you for trusting Waves with your complete home protection.
        </div>
      </div>
    );
  }

  if (!promoData.promotions?.length) return null;

  const urgencyConfig = {
    peak: { badge: '🔥 Peak Season', color: B.orange, bg: '#FFF3E0', borderColor: B.orange },
    high: { badge: '📈 Rising', color: B.orange, bg: '#FFF3E0', borderColor: B.orange },
    moderate: { badge: '📋 Recommended', color: B.teal, bg: '#E0F7FA', borderColor: B.teal },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {promoData.promotions.map(promo => {
        const u = urgencyConfig[promo.seasonalUrgency] || urgencyConfig.moderate;
        const isInterested = interested.has(promo.id);

        return (
          <div key={promo.id} style={{
            background: B.white, borderRadius: 16, overflow: 'hidden',
            border: `1px solid ${B.grayLight}`,
            boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
            borderLeft: `4px solid ${u.borderColor}`,
          }}>
            <div style={{ padding: '16px 18px' }}>
              {/* Header: urgency badge + dismiss */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: u.bg, color: u.color,
                }}>{u.badge}</span>
                <button onClick={() => handleDismiss(promo.id)} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: B.grayMid, fontSize: 18, padding: 0, lineHeight: 1,
                }} title="Dismiss">✕</button>
              </div>

              {/* Title & description */}
              <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
                {promo.title}
              </div>
              <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4, lineHeight: 1.5 }}>
                {promo.description}
              </div>

              {/* Price block */}
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 10,
                background: B.offWhite, display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 14, color: B.grayMid, textDecoration: 'line-through' }}>
                  ${promo.originalMonthlyPrice}/mo
                </span>
                <span style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui }}>
                  ${promo.discountedMonthlyPrice}/mo
                </span>
                {promo.savingsText && (
                  <span style={{ fontSize: 11, color: B.green, fontWeight: 600, marginLeft: 'auto' }}>
                    {promo.savingsText}
                  </span>
                )}
              </div>

              {/* Tier upgrade banner */}
              {promo.tierUpgradeAvailable && (
                <div style={{
                  marginTop: 10, padding: '10px 14px', borderRadius: 10,
                  background: `linear-gradient(135deg, ${B.yellow}15, ${B.orange}10)`,
                  border: `1px solid ${B.yellow}33`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: B.navy }}>
                    ⬆️ Add this and unlock {promo.potentialNewTier} — {promo.potentialNewDiscount} off everything
                  </div>
                  {promo.totalMonthlySavingsAtNewTier > 0 && (
                    <div style={{ fontSize: 11, color: B.green, fontWeight: 600, marginTop: 2 }}>
                      You'd save ${promo.totalMonthlySavingsAtNewTier.toFixed(2)}/mo total across all services
                    </div>
                  )}
                </div>
              )}

              {/* Social proof */}
              <div style={{ fontSize: 11, color: B.grayMid, marginTop: 10 }}>
                {promo.socialProof}
              </div>

              {/* CTA */}
              {!isInterested ? (
                <button
                  onClick={() => handleInterest(promo)}
                  disabled={interacting === promo.id}
                  style={{
                    ...BUTTON_BASE, width: '100%', padding: 13, marginTop: 12, fontSize: 14,
                    background: B.red,
                    color: '#fff',
                    boxShadow: `0 4px 15px ${B.red}30`,
                    opacity: interacting === promo.id ? 0.7 : 1,
                  }}
                >
                  {interacting === promo.id ? 'Sending...' : promo.ctaText}
                </button>
              ) : (
                <div style={{
                  marginTop: 12, padding: 13, borderRadius: 50, textAlign: 'center',
                  background: '#E8F5E9', color: B.green, fontSize: 14, fontWeight: 700,
                }}>
                  ✓ We'll follow up within 24 hours!
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =========================================================================
// DASHBOARD TAB — with referral, review prompt, irrigation recs
// =========================================================================
function DashboardTab({ customer, onSwitchTab }) {
  const [nextService, setNextService] = useState(null);
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);
  const [lastService, setLastService] = useState(null);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [pendingSatisfaction, setPendingSatisfaction] = useState(null);
  const [referralStats, setReferralStats] = useState(null);
  const badgeData = useBadges();
  const [satRating, setSatRating] = useState(0);
  const [satHover, setSatHover] = useState(0);
  const [satPhase, setSatPhase] = useState('rate'); // rate | review | feedback | thanks
  const [satFeedback, setSatFeedback] = useState('');
  const [satReviewLink, setSatReviewLink] = useState('');
  const [satOfficeName, setSatOfficeName] = useState('');
  const [satSubmitting, setSatSubmitting] = useState(false);
  const [satDismissed, setSatDismissed] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const lawnHealth = useLawnHealth(customer.id);

  useEffect(() => {
    api.getNextService().then(d => setNextService(d.next)).catch(console.error);
    api.getServiceStats().then(setStats).catch(console.error);
    api.getBalance().then(setBalance).catch(console.error);
    api.getServices({ limit: 1 }).then(d => {
      if (d.services?.length) setLastService(d.services[0]);
    }).catch(console.error);
    api.getPendingSatisfaction().then(d => {
      if (d.pending?.length) setPendingSatisfaction(d.pending[0]);
    }).catch(console.error);
    api.getReferrals().then(d => {
      if (d?.stats) setReferralStats(d.stats);
    }).catch(console.error);
  }, []);

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const tier = TIER[customer.tier];
  const referralCode = customer.referralCode || '';

  // Extract irrigation recommendations from last service notes
  const irrigationRecs = [];
  if (lastService?.notes) {
    const noteText = lastService.notes.toLowerCase();
    if (noteText.includes('irrigation') || noteText.includes('zone') || noteText.includes('watering') || noteText.includes('sprinkler')) {
      irrigationRecs.push({ text: lastService.notes, date: lastService.date, tech: lastService.technician });
    }
  }

  // Show review prompt if last service was within 3 days
  const showReview = lastService && !reviewDismissed && (() => {
    const svcDate = parseDate(lastService.date);
    const now = new Date();
    const diffDays = (now - svcDate) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 3;
  })();

  const handleSatRating = async (rating) => {
    setSatRating(rating);
    setSatSubmitting(true);
    try {
      const result = await api.submitSatisfaction({
        serviceRecordId: pendingSatisfaction.id,
        rating,
      });
      if (result.action === 'review') {
        setSatReviewLink(result.reviewLink);
        setSatOfficeName(result.officeName);
        setSatPhase('review');
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 3000);
      } else {
        setSatPhase('feedback');
      }
    } catch (err) {
      console.error(err);
    }
    setSatSubmitting(false);
  };

  const handleSatFeedback = async () => {
    setSatSubmitting(true);
    try {
      await api.submitSatisfaction({
        serviceRecordId: pendingSatisfaction.id,
        rating: satRating,
        feedbackText: satFeedback,
      });
    } catch (err) {
      // Already submitted the rating, feedback is supplemental
    }
    setSatPhase('thanks');
    setSatSubmitting(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Satisfaction Pulse — above everything */}
      {pendingSatisfaction && !satDismissed && (() => {
        const svcDate = parseDate(pendingSatisfaction.service_date || pendingSatisfaction.serviceDate);

        // Confetti particles
        const confettiColors = [B.yellow, B.green, B.wavesBlue, B.orange, B.red, '#9C27B0'];
        const confettiParticles = showConfetti ? Array.from({ length: 40 }, (_, i) => ({
          id: i,
          color: confettiColors[i % confettiColors.length],
          left: Math.random() * 100,
          delay: Math.random() * 0.5,
          size: 4 + Math.random() * 6,
          rotation: Math.random() * 360,
        })) : [];

        return (
          <div style={{
            position: 'relative', overflow: 'hidden',
            background: B.white, borderRadius: 16,
            border: `2px solid ${satPhase === 'review' ? B.yellow : satPhase === 'feedback' || satPhase === 'thanks' ? B.wavesBlue : B.orange}33`,
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          }}>
            {/* Confetti animation */}
            {showConfetti && (
              <style>{`
                @keyframes confetti-fall {
                  0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
                  100% { transform: translateY(300px) rotate(720deg); opacity: 0; }
                }
              `}</style>
            )}
            {confettiParticles.map(p => (
              <div key={p.id} style={{
                position: 'absolute', top: 0, left: `${p.left}%`,
                width: p.size, height: p.size, borderRadius: p.size > 7 ? 2 : '50%',
                background: p.color, zIndex: 10, pointerEvents: 'none',
                animation: `confetti-fall 2.5s ease-out ${p.delay}s forwards`,
                transform: `rotate(${p.rotation}deg)`,
              }} />
            ))}

            <div style={{ padding: 20, position: 'relative', zIndex: 5 }}>
              {/* PHASE: Rate */}
              {satPhase === 'rate' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 28 }}>⭐</span>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>How was your visit?</div>
                        <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>
                          {pendingSatisfaction.service_type || pendingSatisfaction.serviceType} · {!isNaN(svcDate) ? svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''} · {pendingSatisfaction.technician_name || pendingSatisfaction.technicianName}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => setSatDismissed(true)} style={{
                      background: 'none', border: 'none', color: B.grayMid, cursor: 'pointer', fontSize: 20, padding: 0, lineHeight: 1,
                      minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>×</button>
                  </div>

                  <div style={{ marginTop: 16, textAlign: 'center' }}>
                    <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 8 }}>Tap a number to rate your experience</div>
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'center', flexWrap: 'wrap' }}>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => {
                        const isActive = n <= (satHover || satRating);
                        const color = n <= 3 ? B.red : n <= 7 ? B.orange : B.green;
                        return (
                          <button
                            key={n}
                            onMouseEnter={() => setSatHover(n)}
                            onMouseLeave={() => setSatHover(0)}
                            onClick={() => handleSatRating(n)}
                            disabled={satSubmitting}
                            style={{
                              minWidth: 28, height: 44, borderRadius: 8, border: 'none',
                              cursor: satSubmitting ? 'wait' : 'pointer',
                              background: isActive ? color : B.offWhite,
                              color: isActive ? '#fff' : B.grayMid,
                              fontSize: 14, fontWeight: 700, fontFamily: FONTS.ui,
                              transition: 'all 0.15s ease',
                              transform: isActive ? 'scale(1.1)' : 'scale(1)',
                              flex: '1 1 0',
                            }}
                          >{n}</button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, padding: '0 2px' }}>
                      <span style={{ fontSize: 10, color: B.grayMid }}>Not great</span>
                      <span style={{ fontSize: 10, color: B.grayMid }}>Amazing</span>
                    </div>
                  </div>
                </>
              )}

              {/* PHASE: Review prompt (8-10) */}
              {satPhase === 'review' && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>🎉</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
                    Awesome — {satRating}/10!
                  </div>
                  <div style={{ fontSize: 13, color: B.grayDark, marginTop: 6, lineHeight: 1.6 }}>
                    Would you share your experience on Google? It helps your neighbors find great pest & lawn care and means the world to our {satOfficeName} team.
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <a href={satReviewLink} target="_blank" rel="noopener noreferrer" style={{
                      ...BUTTON_BASE, padding: '11px 22px', fontSize: 14,
                      background: `linear-gradient(135deg, ${B.yellow}, ${B.orange})`,
                      color: B.navy, textDecoration: 'none',
                    }}>Leave a Review ⭐</a>
                    <button onClick={() => setSatDismissed(true)} style={{
                      ...BUTTON_BASE, padding: '11px 22px', fontSize: 13,
                      background: 'transparent', color: B.grayMid,
                      border: `1px solid ${B.grayLight}`,
                    }}>Maybe Later</button>
                  </div>
                  <div style={{ fontSize: 11, color: B.grayMid, marginTop: 12 }}>
                    We also texted you the review link in case you want to do it later
                  </div>
                </div>
              )}

              {/* PHASE: Feedback (1-7) */}
              {satPhase === 'feedback' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <span style={{ fontSize: 24 }}>💬</span>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>
                        {satRating <= 3 ? "We're sorry to hear that." : "Thanks for the honest feedback."}
                      </div>
                      <div style={{ fontSize: 12, color: B.grayMid }}>
                        {satRating <= 3
                          ? "Tell us what went wrong and we'll make it right."
                          : "Anything we could do better? This stays between us."}
                      </div>
                    </div>
                  </div>
                  <textarea
                    value={satFeedback}
                    onChange={e => setSatFeedback(e.target.value)}
                    placeholder="What could we have done differently?"
                    rows={3}
                    style={{
                      width: '100%', padding: '12px 14px', borderRadius: 12,
                      border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
                      color: B.navy, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
                    }}
                    onFocus={e => e.target.style.borderColor = B.wavesBlue}
                    onBlur={e => e.target.style.borderColor = B.grayLight}
                  />
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <button onClick={handleSatFeedback} disabled={satSubmitting} style={{
                      ...BUTTON_BASE, padding: '10px 20px', flex: 1, fontSize: 13,
                      background: B.red, color: '#fff',
                      opacity: satSubmitting ? 0.7 : 1,
                    }}>{satSubmitting ? 'Sending...' : 'Send Feedback'}</button>
                    <button onClick={() => setSatPhase('thanks')} style={{
                      ...BUTTON_BASE, padding: '10px 20px', fontSize: 13,
                      background: 'transparent', color: B.grayMid,
                      border: `1px solid ${B.grayLight}`,
                    }}>Skip</button>
                  </div>
                </>
              )}

              {/* PHASE: Thank you */}
              {satPhase === 'thanks' && (
                <div style={{ textAlign: 'center', padding: '8px 0' }}>
                  <span style={{ fontSize: 32 }}>🙏</span>
                  <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 6 }}>
                    Thank you for your feedback.
                  </div>
                  <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>
                    {satRating <= 3
                      ? `${(pendingSatisfaction.technician_name || pendingSatisfaction.technicianName) ? (pendingSatisfaction.technician_name || pendingSatisfaction.technicianName).split(' ')[0] + ' at Waves' : 'Your team at Waves'} will personally follow up with you within 24 hours.`
                      : satRating <= 7
                        ? "We appreciate you letting us know. We're always working to improve."
                        : "Thank you for being a valued Waves customer!"}
                  </div>
                  <button onClick={() => setSatDismissed(true)} style={{
                    ...BUTTON_BASE, padding: '8px 20px', fontSize: 12, marginTop: 12,
                    background: B.offWhite, color: B.grayDark, border: `1px solid ${B.grayLight}`,
                  }}>Dismiss</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Welcome */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark}, ${B.wavesBlue})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark}, ${B.wavesBlue})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 20, padding: '28px 24px 40px', color: '#fff',
      }}>
        {/* Wave motif at bottom */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 30,
          background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 120'%3E%3Cpath d='M0,60 C200,120 400,0 600,60 C800,120 1000,0 1200,60 L1200,120 L0,120Z' fill='%232196F3' fill-opacity='0.15'/%3E%3C/svg%3E") no-repeat bottom`,
          backgroundSize: '100% 100%',
        }} />
        <div style={{ fontSize: 14, color: B.blueLight, fontFamily: FONTS.body }}>Hey there,</div>
        <div style={{ fontSize: 32, fontWeight: 800, fontFamily: FONTS.heading, letterSpacing: -0.5 }}>
          {customer.firstName}! 👋
        </div>
        {tier && (
          <div style={{
            marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 24, fontSize: 13, fontWeight: 700,
            fontFamily: FONTS.heading,
            background: `linear-gradient(135deg, ${tier.gradientFrom}33, ${tier.gradientTo}22)`,
            color: tier.darkText ? B.navy : '#fff',
            border: `1.5px solid ${tier.color}55`,
          }}>🛡️ WaveGuard {customer.tier}</div>
        )}
        <div style={{ marginTop: 12, fontSize: 13, color: '#fff', lineHeight: 1.6 }}>
          {customer.address?.line1}, {customer.address?.city}, {customer.address?.state} {customer.address?.zip}<br/>
          <span style={{ color: B.blueLight }}>{(customer.property?.lawnType || '').replace(/\s*(Full Sun|Shade|Sun\/Shade)\s*/gi, '') || 'Lawn'} · {customer.property?.propertySqFt?.toLocaleString()} sq ft · {customer.property?.lotSqFt?.toLocaleString()} sq ft lot</span>
        </div>
      </div>

      {/* Quick Actions Row */}
      <div style={{
        display: 'flex', gap: 10, overflowX: 'auto', WebkitOverflowScrolling: 'touch',
        paddingBottom: 4, scrollbarWidth: 'none',
      }}>
        {[
          { icon: '🔧', label: 'Request Service', action: () => onSwitchTab?.('services') },
          { icon: '💬', label: 'Message Us', action: () => onSwitchTab?.('messages') },
          { icon: '💳', label: 'Pay Now', action: () => onSwitchTab?.('billing') },
          { icon: '🎁', label: 'Refer a Friend', action: () => onSwitchTab?.('refer') },
        ].map((item, i) => (
          <button key={i} onClick={item.action} style={{
            ...BUTTON_BASE, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            padding: '14px 16px', minWidth: 90, flexShrink: 0, borderRadius: 14,
            background: B.white, border: `1.5px solid ${B.bluePale}`,
            color: B.navy, fontSize: 11, fontWeight: 600, fontFamily: FONTS.ui,
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}>
            <span style={{ fontSize: 22 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      {/* Tech Tracker — shows when service is today */}
      {/* Domino's-style Service Tracker */}
      <ServiceTracker />

      {/* Legacy tracker — only if no new tracker active */}
      {nextService && false && <TechTrackerCard nextService={nextService} />}

      {/* Next service — enhanced pre-service communication */}
      {nextService && (() => {
        const svcDate = parseDate(nextService.date);
        const now = new Date();
        const diffHrs = (svcDate - now) / (1000 * 60 * 60);
        const isToday = svcDate.toDateString() === now.toDateString();
        const isTomorrow = diffHrs > 0 && diffHrs <= 48 && !isToday;
        const daysUntil = Math.max(0, Math.ceil(diffHrs / 24));

        return (
          <div style={{
            background: B.white, borderRadius: 16, overflow: 'hidden',
            border: `2px solid ${isToday ? B.green : isTomorrow ? B.orange : B.wavesBlue}22`,
            boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
          }}>
            {/* Header */}
            <div style={{
              background: isToday
                ? `linear-gradient(135deg, ${B.green}, #2E7D32)`
                : isTomorrow
                  ? `linear-gradient(135deg, ${B.orange}, #E65100)`
                  : `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`,
              padding: '16px 20px', color: '#fff',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 26 }}>{isToday ? '🔧' : isTomorrow ? '⏰' : '📅'}</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.85, fontFamily: FONTS.heading }}>
                    {isToday ? "Today's Service" : isTomorrow ? 'Tomorrow' : 'Your Next Visit'}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: FONTS.heading }}>
                    {svcDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </div>
              {!isToday && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.ui }}>{daysUntil}</div>
                  <div style={{ fontSize: 10, opacity: 0.75, textTransform: 'uppercase', letterSpacing: 0.5 }}>{daysUntil === 1 ? 'day away' : 'days away'}</div>
                </div>
              )}
            </div>

            {/* Service details */}
            <div style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: B.navy }}>{nextService.serviceType}</div>
              <div style={{ fontSize: 12, color: B.grayDark, marginTop: 3, lineHeight: 1.5, fontStyle: 'italic' }}>
                {(() => {
                  const sType = (nextService.serviceType || '').toLowerCase();
                  if (sType.includes('lawn') || sType.includes('fertiliz') || sType.includes('celsius'))
                    return 'Fertilizer application + weed spot treatment + perimeter pest barrier';
                  if (sType.includes('pest') || sType.includes('general'))
                    return 'Interior + exterior perimeter spray + entry point treatment';
                  if (sType.includes('mosquito'))
                    return 'Backyard fogging + standing water treatment + barrier spray';
                  if (sType.includes('rodent'))
                    return 'Bait station check + exclusion inspection + trapping';
                  if (sType.includes('termite'))
                    return 'Termite monitoring station inspection + barrier check';
                  return 'Full property inspection + targeted treatment application';
                })()}
              </div>
              <div style={{ fontSize: 13, color: B.grayMid, marginTop: 4 }}>
                Technician: <strong style={{ color: B.navy }}>{nextService.technician || 'TBD'}</strong>
                {nextService.windowStart && ` · ${formatTime(nextService.windowStart)} – ${formatTime(nextService.windowEnd)}`}
              </div>

              {/* SMS Communication Timeline */}
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 12,
                background: B.offWhite, border: `1px solid ${B.grayLight}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.grayMid, marginBottom: 10 }}>
                  Communication Timeline
                </div>
                {[
                  { icon: '📲', label: '72-hour reminder', desc: 'SMS 3 days before your visit', done: diffHrs <= 72, active: diffHrs <= 72 && diffHrs > 24 },
                  { icon: '📲', label: '24-hour reminder', desc: 'SMS the day before your visit', done: diffHrs <= 24, active: diffHrs <= 24 && diffHrs > 1 },
                  { icon: '🚐', label: 'Tech en route alert', desc: 'Live GPS tracking via Bouncie', done: false, active: isToday },
                  { icon: '✅', label: 'Service complete summary', desc: 'Products applied + tech notes', done: false, active: false },
                ].map((step, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: i < 3 ? 10 : 0 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      background: step.done ? `${B.green}18` : step.active ? `${B.orange}18` : B.grayLight,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                      border: step.active ? `1.5px solid ${B.orange}` : step.done ? `1.5px solid ${B.green}` : `1px solid ${B.grayLight}`,
                    }}>{step.icon}</div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: step.done ? B.green : step.active ? B.orange : B.grayDark }}>
                        {step.label} {step.done && '✓'}
                      </div>
                      <div style={{ fontSize: 11, color: B.grayMid }}>{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {!nextService.customerConfirmed ? (
                  <button onClick={() => {
                    api.confirmAppointment(nextService.id).then(() => {
                      setNextService({ ...nextService, customerConfirmed: true, status: 'confirmed' });
                    });
                  }} style={{
                    ...BUTTON_BASE, padding: '10px 20px', flex: 1,
                    background: B.green, color: '#fff', fontSize: 13,
                    boxShadow: `0 3px 10px ${B.green}30`,
                  }}>✓ Confirm Appointment</button>
                ) : (
                  <span style={{
                    padding: '10px 20px', borderRadius: 50, background: '#E8F5E9', flex: 1,
                    color: B.green, fontSize: 13, fontWeight: 700, textAlign: 'center',
                  }}>✓ Confirmed</span>
                )}
                <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${nextService.serviceType} on ${svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. What's available?`} style={{
                  ...BUTTON_BASE, padding: '10px 20px', flex: 1, textDecoration: 'none',
                  background: 'transparent', color: B.wavesBlue, fontSize: 13,
                  border: `1.5px solid ${B.wavesBlue}`,
                }}>Reschedule</a>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Last Service Summary */}
      {lastService && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 20,
          border: `1px solid ${B.bluePale}`, boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 22 }}>✅</span>
            <div style={{ fontSize: 14, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>Last Visit</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: B.navy }}>{lastService.type || lastService.serviceType}</div>
              <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>
                {parseDate(lastService.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {lastService.technician || 'Waves Team'}
              </div>
            </div>
            <span style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 6,
              background: '#E8F5E9', color: B.green, fontWeight: 700,
            }}>Completed</span>
          </div>
          {lastService.notes || lastService.technician_notes ? (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 10,
              background: B.offWhite, fontSize: 13, color: B.grayDark, lineHeight: 1.6,
              borderLeft: `3px solid ${B.wavesBlue}`,
            }}>
              {((lastService.notes || lastService.technician_notes) || '').slice(0, 100)}
              {((lastService.notes || lastService.technician_notes) || '').length > 100 ? '...' : ''}
            </div>
          ) : (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 10,
              background: B.offWhite, fontSize: 12, color: B.grayMid, lineHeight: 1.5,
            }}>
              Service completed — full report in Documents
            </div>
          )}
        </div>
      )}

      {/* Irrigation Recommendations */}
      {irrigationRecs.length > 0 && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 20,
          border: `2px solid ${B.teal}33`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 24 }}>💧</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Irrigation Recommendation</div>
              <div style={{ fontSize: 11, color: B.grayMid }}>From {irrigationRecs[0].tech} · {parseDate(irrigationRecs[0].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            </div>
          </div>
          <div style={{
            padding: 14, borderRadius: 12, background: `${B.teal}08`,
            fontSize: 13, color: B.grayDark, lineHeight: 1.6, borderLeft: `3px solid ${B.teal}`,
          }}>
            {irrigationRecs[0].text}
          </div>
        </div>
      )}

      {/* Lawn Health Progress — conditional display (moved up) */}
      {!lawnHealth.loading && lawnHealth.hasLawnCare && lawnHealth.scores && lawnHealth.initialScores && (
        <LawnHealthCard scores={lawnHealth.scores} initialScores={lawnHealth.initialScores} />
      )}
      {!lawnHealth.loading && lawnHealth.hasLawnCare && !lawnHealth.scores && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 24,
          border: `2px solid ${B.green}22`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
          textAlign: 'center',
        }}>
          <span style={{ fontSize: 32 }}>🌱</span>
          <div style={{ fontSize: 14, fontWeight: 600, color: B.navy, fontFamily: FONTS.heading, marginTop: 8 }}>Lawn Health Tracking</div>
          <div style={{ fontSize: 13, color: B.grayMid, marginTop: 6, lineHeight: 1.6 }}>
            Your lawn health tracking will begin after your first assessment visit.
          </div>
        </div>
      )}

      {/* Contextual Promotions — based on services they don't have + season */}
      <PromotionCards />

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {[
          { label: 'Monthly Rate', value: `$${customer.monthlyRate}`, sub: `${tier?.discount || '0%'} discount`, icon: '💰' },
          { label: 'Next Service', value: nextService ? parseDate(nextService.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—', sub: nextService?.serviceType || '', icon: '📅' },
          { label: 'Services YTD', value: stats?.servicesYTD ?? '...', sub: stats?.celsiusApplicationsThisYear != null ? `Weed treatments: ${stats.celsiusApplicationsThisYear} of ${stats.celsiusMaxPerYear || 3} annual` : '', icon: '📋' },
          { label: 'Member Since', value: customer.memberSince ? parseDate(customer.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—', sub: '', icon: '⭐' },
        ].map((s, i) => (
          <div key={i} style={{
            background: B.white, borderRadius: 14, padding: 16,
            border: `1px solid ${B.bluePale}`,
          }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{s.icon}</div>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: B.grayDark, fontFamily: FONTS.ui }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: B.navy, marginTop: 2, fontFamily: FONTS.ui }}>{s.value}</div>
            <div style={{ fontSize: 11, color: B.green, fontWeight: 600, marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* My Requests — open service requests */}
      <MyRequestsCard />

      {/* Badge Row */}
      {!badgeData.loading && badgeData.data && (
        <BadgeRow
          badges={badgeData.data.badges}
          earnedCount={badgeData.data.earnedCount}
          totalCount={badgeData.data.totalCount}
          onViewAll={() => onSwitchTab?.('plan')}
        />
      )}

      {/* Referral — compact dashboard card */}
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 16, padding: 20, color: '#fff',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{ fontSize: 36 }}>🎁</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: FONTS.heading }}>
            {referralStats && referralStats.totalReferrals > 0
              ? `You've referred ${referralStats.totalReferrals} neighbor${referralStats.totalReferrals !== 1 ? 's' : ''} — $${referralStats.totalEarned} earned!`
              : 'Give $25, Get $25'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2, lineHeight: 1.5 }}>
            {referralStats && referralStats.totalReferrals > 0
              ? 'Keep sharing — every referral earns you $25.'
              : 'Know someone who needs pest control? Refer a neighbor and you both get $25.'}
          </div>
        </div>
        <button onClick={() => onSwitchTab?.('refer')} style={{
          ...BUTTON_BASE, padding: '9px 16px', fontSize: 12, flexShrink: 0,
          background: B.red, color: '#fff',
        }}>Refer Now</button>
      </div>
    </div>
  );
}

// =========================================================================
// SERVICES TAB
// =========================================================================
function ServicesTab() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    api.getServices({ limit: 20 }).then(d => { setServices(d.services); setLoading(false); }).catch(console.error);
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Loading service history...</div>;

  const thSt = { padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: B.grayMid, textAlign: 'left', borderBottom: `1px solid ${B.grayLight}` };
  const tdSt = { padding: '8px 10px', fontSize: 12, color: B.navy, borderBottom: `1px solid ${B.offWhite}`, verticalAlign: 'top' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeading>Service Inspection Reports</SectionHeading>
      <div style={{ fontSize: 13, color: B.grayDark }}>Detailed reports from every visit including products applied, technician observations, and conditions.</div>

      {services.map(s => (
        <div key={s.id} style={{
          background: B.white, borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${expanded === s.id ? B.wavesBlue + '44' : B.grayLight}`,
          transition: 'all 0.3s ease',
        }}>
          {/* Header — always visible */}
          <div onClick={() => setExpanded(expanded === s.id ? null : s.id)}
            style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 16, fontWeight: 800, fontFamily: FONTS.heading,
                flexShrink: 0,
              }}>{(s.technician || 'W')[0]}</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{s.type}</div>
                <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>
                  {parseDate(s.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · {s.technician}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: '#E8F5E9', color: B.green, fontWeight: 700 }}>Completed</span>
              <span style={{ fontSize: 18, color: B.grayMid, transition: 'transform 0.3s', transform: expanded === s.id ? 'rotate(180deg)' : 'rotate(0)' }}>{'▾'}</span>
            </div>
          </div>

          {/* Expanded detail — full service inspection report */}
          {expanded === s.id && (
            <div style={{ borderTop: `1px solid ${B.grayLight}` }}>

              {/* Service Info Bar */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 0, borderBottom: `1px solid ${B.grayLight}`, background: B.offWhite }}>
                {[
                  { label: 'Date', value: parseDate(s.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) },
                  { label: 'Technician', value: s.technician },
                  { label: 'Duration', value: s.serviceTimeMinutes ? `${s.serviceTimeMinutes} min` : '—' },
                  { label: 'Status', value: 'Completed' },
                ].map((item, i) => (
                  <div key={i} style={{ padding: '10px 14px', borderRight: i % 2 === 0 ? `1px solid ${B.grayLight}` : 'none', borderBottom: i < 2 ? `1px solid ${B.grayLight}` : 'none' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.grayMid }}>{item.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: B.navy, marginTop: 2, wordBreak: 'break-word' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Conditions */}
              {(s.soilTemp || s.soilPh || s.thatchMeasurement || s.soilMoisture) && (
                <div style={{ padding: '12px 18px', background: B.blueSurface, borderBottom: `1px solid ${B.grayLight}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.wavesBlue, marginBottom: 6 }}>Conditions & Measurements</div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {s.soilTemp && <div style={{ fontSize: 12, color: B.navy }}>{'🌡️'} Soil Temp: <strong>{s.soilTemp}°F</strong></div>}
                    {s.soilPh && <div style={{ fontSize: 12, color: B.navy }}>{'⚗️'} pH: <strong>{s.soilPh}</strong></div>}
                    {s.thatchMeasurement && <div style={{ fontSize: 12, color: B.navy }}>{'📏'} Thatch: <strong>{s.thatchMeasurement}"</strong></div>}
                    {s.soilMoisture && <div style={{ fontSize: 12, color: B.navy }}>{'💧'} Moisture: <strong>{s.soilMoisture}</strong></div>}
                  </div>
                </div>
              )}

              {/* Products Applied — full table */}
              {s.products?.length > 0 && (
                <div style={{ padding: '14px 18px', borderBottom: `1px solid ${B.grayLight}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.green, marginBottom: 10 }}>Products Applied</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={thSt}>Product</th>
                          <th style={thSt}>Active Ingredient</th>
                          <th style={thSt}>Rate</th>
                          <th style={thSt}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.products.map((p, i) => (
                          <tr key={i}>
                            <td style={{ ...tdSt, fontWeight: 600 }}>
                              {p.product_name}
                              {p.product_category && <div style={{ fontSize: 10, color: B.grayMid, textTransform: 'capitalize', marginTop: 1 }}>{p.product_category}</div>}
                            </td>
                            <td style={{ ...tdSt, fontSize: 11, color: B.grayDark }}>
                              {p.active_ingredient || '—'}
                              {p.moa_group && <div style={{ fontSize: 10, color: B.grayMid }}>{p.moa_group}</div>}
                            </td>
                            <td style={{ ...tdSt, fontSize: 11 }}>{p.application_rate ? `${p.application_rate} ${p.rate_unit || ''}` : '—'}</td>
                            <td style={{ ...tdSt, fontSize: 11 }}>{p.total_amount ? `${p.total_amount} ${p.amount_unit || ''}` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Technician Notes */}
              {s.notes && (
                <div style={{ padding: '14px 18px', borderBottom: `1px solid ${B.grayLight}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.wavesBlue, marginBottom: 8 }}>Technician Comments</div>
                  <div style={{ fontSize: 13, color: B.navy, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{s.notes}</div>
                </div>
              )}

              {/* Photos */}
              {s.hasPhotos && (
                <div style={{ padding: '14px 18px', borderBottom: `1px solid ${B.grayLight}` }}>
                  <div style={{ padding: '10px 14px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}`, fontSize: 12, color: B.wavesBlue, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {'📷'} {s.photoCount} photo{s.photoCount > 1 ? 's' : ''} attached — tap to view
                  </div>
                </div>
              )}

              {/* Precautions */}
              <div style={{ padding: '12px 18px', background: '#FFF8E1', borderBottom: `1px solid ${B.grayLight}` }}>
                <div style={{ fontSize: 11, color: '#F57F17', lineHeight: 1.5 }}>
                  {'⚠️'} Keep people and pets away from treated surfaces until dry. Do not contact treated surfaces until dry. For questions about products applied, contact us at (941) 318-7612.
                </div>
              </div>

              {/* Footer */}
              <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 10, color: B.grayMid }}>Report generated automatically from service data</div>
                <div style={{ fontSize: 10, color: B.grayMid }}>Waves Pest Control · (941) 318-7612</div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// SCHEDULE TAB
// =========================================================================
function ScheduleTab({ customer }) {
  const [upcoming, setUpcoming] = useState([]);
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getSchedule(90),
      api.getNotificationPrefs(),
    ]).then(([schedData, prefsData]) => {
      setUpcoming(schedData.upcoming);
      setPrefs(prefsData);
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleToggle = async (key) => {
    const newVal = !prefs[key];
    setPrefs({ ...prefs, [key]: newVal });
    try { await api.updateNotificationPrefs({ [key]: newVal }); }
    catch (err) { setPrefs({ ...prefs, [key]: !newVal }); console.error(err); }
  };

  const handleConfirm = async (id) => {
    try {
      await api.confirmAppointment(id);
      setUpcoming(upcoming.map(s => s.id === id ? { ...s, status: 'confirmed', customerConfirmed: true } : s));
    } catch (err) { console.error(err); }
  };

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Loading schedule...</div>;

  // Compute time-awareness for each service
  const now = new Date();
  const enriched = upcoming.map(s => {
    const svcDate = parseDate(s.date);
    const diffHrs = (svcDate - now) / (1000 * 60 * 60);
    const isToday = svcDate.toDateString() === now.toDateString();
    const isTomorrow = diffHrs > 0 && diffHrs <= 48 && !isToday;
    const daysUntil = Math.max(0, Math.ceil(diffHrs / 24));
    return { ...s, svcDate, diffHrs, isToday, isTomorrow, daysUntil };
  });

  const nextUp = enriched[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHeading>Upcoming Services</SectionHeading>

      {/* Featured next service card */}
      {nextUp && (
        <div style={{
          background: B.white, borderRadius: 16, overflow: 'hidden',
          border: `2px solid ${nextUp.isToday ? B.green : nextUp.isTomorrow ? B.orange : B.wavesBlue}22`,
          boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
        }}>
          {/* Colored header */}
          <div style={{
            background: nextUp.isToday
              ? `linear-gradient(135deg, ${B.green}, #2E7D32)`
              : nextUp.isTomorrow
                ? `linear-gradient(135deg, ${B.orange}, #E65100)`
                : `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`,
            padding: '14px 18px', color: '#fff',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22 }}>{nextUp.isToday ? '🔧' : nextUp.isTomorrow ? '⏰' : '📅'}</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.85 }}>
                  {nextUp.isToday ? 'Service Today' : nextUp.isTomorrow ? 'Service Tomorrow' : 'Next Up'}
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, fontFamily: FONTS.heading }}>
                  {nextUp.svcDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                </div>
              </div>
            </div>
            {!nextUp.isToday && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.ui }}>{nextUp.daysUntil}</div>
                <div style={{ fontSize: 9, opacity: 0.75, textTransform: 'uppercase' }}>{nextUp.daysUntil === 1 ? 'day' : 'days'}</div>
              </div>
            )}
          </div>

          <div style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: B.navy }}>{nextUp.serviceType}</div>
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 3 }}>
              {nextUp.windowStart ? `${formatTime(nextUp.windowStart)} – ${formatTime(nextUp.windowEnd)}` : 'Time TBD'} · {nextUp.technician}
            </div>

            {/* Communication Timeline */}
            <div style={{
              marginTop: 14, padding: 12, borderRadius: 10,
              background: B.offWhite, border: `1px solid ${B.grayLight}`,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: B.grayMid, marginBottom: 8 }}>
                You'll hear from us
              </div>
              {[
                { icon: '📲', label: '72-hour SMS reminder', time: '3 days before your visit', done: nextUp.diffHrs <= 72 },
                { icon: '📲', label: '24-hour SMS reminder', time: 'Day before your visit', done: nextUp.diffHrs <= 24 },
                { icon: '🚐', label: 'Tech en route', time: '~1 hour before arrival · Live Bouncie GPS', done: false, active: nextUp.isToday },
                { icon: '✅', label: 'Service complete report', time: 'Products used + tech notes texted to you', done: false },
              ].map((step, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: i < 3 ? 8 : 0 }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    background: step.done ? `${B.green}18` : step.active ? `${B.orange}18` : B.grayLight,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
                    border: step.done ? `1.5px solid ${B.green}` : step.active ? `1.5px solid ${B.orange}` : 'none',
                  }}>{step.icon}</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: step.done ? B.green : step.active ? B.orange : B.grayDark }}>
                      {step.label} {step.done && '✓'}
                    </div>
                    <div style={{ fontSize: 10, color: B.grayMid }}>{step.time}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Confirm + Reschedule */}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              {!nextUp.customerConfirmed ? (
                <button onClick={() => handleConfirm(nextUp.id)} style={{
                  ...BUTTON_BASE, padding: '9px 18px', flex: 1,
                  background: B.red, color: '#fff', fontSize: 12,
                }}>✓ Confirm</button>
              ) : (
                <span style={{
                  flex: 1, padding: '9px 18px', borderRadius: 50, background: '#E8F5E9',
                  color: B.green, fontSize: 12, fontWeight: 700, textAlign: 'center',
                }}>✓ Confirmed</span>
              )}
              <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${nextUp.serviceType} on ${nextUp.svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. What's available?`} style={{
                ...BUTTON_BASE, padding: '9px 18px', flex: 1, textDecoration: 'none',
                background: 'transparent', color: B.wavesBlue, fontSize: 12,
                border: `1.5px solid ${B.wavesBlue}`,
              }}>Reschedule</a>
            </div>
          </div>
        </div>
      )}

      {/* Remaining upcoming services */}
      {enriched.slice(1).map(s => (
        <div key={s.id} style={{
          background: B.white, borderRadius: 14, padding: 18,
          border: `1px solid ${B.grayLight}`, display: 'flex', gap: 14,
        }}>
          <div style={{
            minWidth: 52, height: 52, borderRadius: 12,
            background: B.bluePale, border: `1px solid ${B.wavesBlue}22`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: B.wavesBlue, fontFamily: FONTS.ui }}>
              {s.svcDate.getDate()}
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: B.grayMid, textTransform: 'uppercase' }}>
              {s.svcDate.toLocaleDateString('en-US', { month: 'short' })}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{s.serviceType}</div>
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 3 }}>
              {s.windowStart ? `${formatTime(s.windowStart)} – ${formatTime(s.windowEnd)}` : 'Time TBD'} · {s.technician}
            </div>
            <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>
              In {s.daysUntil} {s.daysUntil === 1 ? 'day' : 'days'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {!s.customerConfirmed ? (
                <button onClick={() => handleConfirm(s.id)} style={{
                  ...BUTTON_BASE, padding: '6px 14px',
                  background: B.red, color: '#fff', fontSize: 12,
                }}>Confirm</button>
              ) : (
                <span style={{ fontSize: 12, color: B.green, fontWeight: 700 }}>✓ Confirmed</span>
              )}
              <a href={`sms:+19412975749?body=Hi Waves, I'd like to reschedule my ${s.serviceType} on ${s.svcDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. What's available?`} style={{
                ...BUTTON_BASE, padding: '6px 14px', textDecoration: 'none',
                background: 'transparent', color: B.grayMid, fontSize: 12,
                border: `1px solid ${B.grayLight}`,
              }}>Reschedule</a>
            </div>
          </div>
        </div>
      ))}

      {/* Notification Preferences — enhanced */}
      {prefs && (
        <div style={{ marginTop: 8, background: B.white, borderRadius: 14, overflow: 'hidden', border: `1px solid ${B.grayLight}` }}>
          <div style={{
            background: `linear-gradient(135deg, ${B.blueDark}, ${B.wavesBlue})`,
            padding: '14px 20px', color: '#fff',
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: FONTS.heading }}>📱 SMS Notifications</div>
            <div style={{ fontSize: 11, color: B.blueLight, marginTop: 2 }}>Powered by Twilio · We'll never show up unannounced</div>
          </div>
          <div style={{ padding: '6px 20px 16px' }}>
            <div style={{ fontSize: 11, color: B.grayMid, padding: '10px 0 6px' }}>Messages sent to {customer.phone}</div>
            {[
              { key: 'serviceReminder72h', label: '72-Hour Appointment Reminder', desc: 'Get a text 3 days before every visit', icon: '📲' },
              { key: 'serviceReminder24h', label: '24-Hour Service Reminder', desc: 'Get a text the day before every visit', icon: '📲' },
              { key: 'techEnRoute', label: 'Tech En Route Alert', desc: 'Know exactly when your tech is headed over — live GPS', icon: '🚐' },
              { key: 'serviceCompleted', label: 'Service Complete Report', desc: 'Products applied, tech notes, and next steps', icon: '✅' },
              { key: 'billingReminder', label: 'Billing Reminder', desc: '3-day heads up before your monthly charge', icon: '💳' },
              { key: 'seasonalTips', label: 'Seasonal Lawn Tips', desc: 'Watering, mowing height, and care tips for SW Florida', icon: '🌴' },
            ].map((p, i) => (
              <div key={p.key} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 0',
                borderBottom: i < 4 ? `1px solid ${B.grayLight}` : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <span style={{ fontSize: 18 }}>{p.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, color: B.navy, fontWeight: 600 }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: B.grayMid }}>{p.desc}</div>
                  </div>
                </div>
                <div onClick={() => handleToggle(p.key)} style={{
                  width: 44, height: 24, borderRadius: 12, cursor: 'pointer', flexShrink: 0,
                  background: prefs[p.key] ? B.wavesBlue : B.grayLight,
                  position: 'relative', transition: 'background 0.3s',
                }}>
                  <div style={{
                    position: 'absolute', top: 2, width: 20, height: 20,
                    borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                    left: prefs[p.key] ? 22 : 2, transition: 'left 0.3s',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// BILLING TAB
// =========================================================================
function BillingTab({ customer }) {
  const [payments, setPayments] = useState([]);
  const [balance, setBalance] = useState(null);
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [yearFilter, setYearFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [billingEmail, setBillingEmail] = useState('');
  const [paymentSmsEnabled, setPaymentSmsEnabled] = useState(true);
  const [billingPrefsSaving, setBillingPrefsSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.getPayments(), api.getBalance(), api.getCards()])
      .then(([payData, balData, cardData]) => {
        setPayments(payData.payments); setBalance(balData); setCards(cardData.cards); setLoading(false);
      }).catch(console.error);
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Loading billing...</div>;

  // Compute upcoming auto-pay info
  const nextCharge = balance?.nextCharge;
  const amountDue = nextCharge?.amount || balance?.currentBalance || 247.02;
  const dueDate = nextCharge?.date ? parseDate(nextCharge.date) : (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d; })();
  const daysUntilDue = Math.max(0, Math.ceil((dueDate - new Date()) / 86400000));
  const defaultCard = cards.find(c => c.isDefault) || cards[0];
  const hasAutoPay = defaultCard?.autopayEnabled !== false;
  const lastPaymentFailed = balance?.lastPaymentFailed || false;
  const tierName = customer?.tier || 'Bronze';
  const tier = TIER[tierName];
  const monthlyRate = customer?.monthlyRate || 0;
  const numServices = TIER_SERVICES[tierName] || 1;
  const discount = TIER_DISCOUNTS[tierName] || 0;

  // Card expiry check — within 60 days
  const cardExpiringSoon = (() => {
    if (!defaultCard) return null;
    const now = new Date();
    const expDate = new Date(defaultCard.expYear, defaultCard.expMonth, 0); // last day of exp month
    const diffMs = expDate - now;
    const diffDays = Math.ceil(diffMs / 86400000);
    if (diffDays > 0 && diffDays <= 60) {
      const months = Math.ceil(diffDays / 30);
      return { last4: defaultCard.lastFour, months };
    }
    return null;
  })();

  // Banner state: red (failed) > amber (expiring) > green (all good)
  const bannerState = lastPaymentFailed ? 'failed' : cardExpiringSoon ? 'expiring' : 'active';
  const bannerConfig = {
    failed: {
      bg: '#FFEBEE', border: '#FFCDD2', iconBg: B.red,
      icon: '!', titleColor: '#C62828', subtitleColor: '#D32F2F',
    },
    expiring: {
      bg: '#FFF8E1', border: '#FFE082', iconBg: B.orange,
      icon: '!', titleColor: '#E65100', subtitleColor: '#F57C00',
    },
    active: {
      bg: '#E8F5E9', border: '#C8E6C9', iconBg: B.green,
      icon: '\u2713', titleColor: '#2E7D32', subtitleColor: '#558B2F',
    },
  }[bannerState];

  // Payment status badge helper
  const statusBadge = (status) => {
    const map = {
      paid: { bg: '#E8F5E9', color: B.green },
      upcoming: { bg: '#FFF8E1', color: B.orange },
      processing: { bg: B.blueSurface, color: B.wavesBlue },
      failed: { bg: '#FFEBEE', color: B.red },
      refunded: { bg: B.offWhite, color: B.grayMid },
    };
    const s = map[status] || map.paid;
    return { background: s.bg, color: s.color };
  };

  // Year-to-date summary
  const currentYear = new Date().getFullYear();
  const ytdPayments = payments.filter(p => {
    const yr = parseDate(p.date).getFullYear();
    return yr === currentYear && p.status === 'paid';
  });
  const ytdTotal = ytdPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const ytdRecurring = ytdPayments.filter(p => p.type === 'recurring').reduce((sum, p) => sum + (p.amount || 0), 0);
  const ytdOneTime = ytdPayments.filter(p => p.type === 'one_time').reduce((sum, p) => sum + (p.amount || 0), 0);

  // Filtered payments
  const filteredPayments = payments.filter(p => {
    const yr = parseDate(p.date).getFullYear();
    if (yearFilter !== 'All' && yr !== parseInt(yearFilter)) return false;
    if (typeFilter === 'Recurring' && p.type !== 'recurring') return false;
    if (typeFilter === 'One-Time' && p.type !== 'one_time') return false;
    return true;
  });

  // Credits
  const credits = customer?.credits || [];
  const referralCredits = credits.filter(c => c.type === 'referral');
  const serviceCredits = credits.filter(c => c.type === 'service');
  const promoCredits = credits.filter(c => c.type === 'promo');
  const totalCredits = credits.reduce((sum, c) => sum + (c.amount || 0), 0);

  // WaveGuard membership — services & upsell
  const includedServices = SERVICE_CATALOG.slice(0, numServices);
  const totalFullPrice = includedServices.reduce((sum, s) => sum + s.basePrice * 12, 0);
  const annualSavings = totalFullPrice * discount;
  const platinumDiscount = TIER_DISCOUNTS.Platinum || 0.30;
  const platinumSavings = totalFullPrice * platinumDiscount;
  const additionalSavings = platinumSavings - annualSavings;

  // Pill filter helper
  const PillFilter = ({ options, value, onChange }) => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(opt => (
        <button key={opt} onClick={() => onChange(opt)} style={{
          padding: '6px 14px', borderRadius: 20, border: `1px solid ${value === opt ? B.wavesBlue : B.grayLight}`,
          background: value === opt ? `${B.wavesBlue}15` : 'transparent',
          color: value === opt ? B.wavesBlue : B.grayMid,
          fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: FONTS.heading,
          transition: 'all 0.2s ease',
        }}>{opt}</button>
      ))}
    </div>
  );

  const saveBillingPrefs = () => {
    setBillingPrefsSaving(true);
    api.updateNotificationPrefs?.({ billing_email: billingEmail || null, payment_confirmation_sms: paymentSmsEnabled })
      .then(() => setBillingPrefsSaving(false))
      .catch(() => setBillingPrefsSaving(false));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHeading>Billing</SectionHeading>

      {/* ── 1. Status Banner — conditional states ── */}
      <div style={{
        background: bannerConfig.bg, borderRadius: 14, padding: '16px 20px',
        border: `1px solid ${bannerConfig.border}`, display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 20, background: bannerConfig.iconBg,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <span style={{ color: '#fff', fontSize: 18, fontWeight: 700 }}>{bannerConfig.icon}</span>
        </div>
        <div style={{ flex: 1 }}>
          {bannerState === 'failed' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 700, color: bannerConfig.titleColor }}>
                Payment failed — please update your payment method
              </div>
              <div style={{ fontSize: 13, color: bannerConfig.subtitleColor, marginTop: 2 }}>
                Your last payment could not be processed. Update your card to avoid service interruption.
              </div>
            </>
          )}
          {bannerState === 'expiring' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 700, color: bannerConfig.titleColor }}>
                Your card ending in {cardExpiringSoon.last4} expires in {cardExpiringSoon.months} month{cardExpiringSoon.months !== 1 ? 's' : ''} — update now
              </div>
              <div style={{ fontSize: 13, color: bannerConfig.subtitleColor, marginTop: 2 }}>
                Update your payment method to avoid any disruption to your service.
              </div>
            </>
          )}
          {bannerState === 'active' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 700, color: bannerConfig.titleColor }}>
                {daysUntilDue === 0
                  ? 'Auto Pay is active — your payment is processing today'
                  : `Auto Pay is active — your next charge of $${amountDue.toFixed(2)} processes on ${dueDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
                }
              </div>
              <div style={{ fontSize: 13, color: bannerConfig.subtitleColor, marginTop: 2 }}>
                {daysUntilDue === 0
                  ? `Amount: $${amountDue.toFixed(2)}`
                  : `Amount due: $${amountDue.toFixed(2)} · Due ${dueDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
                }
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 2. Balance Card with context ── */}
      {balance && (
        <div style={{ background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`, borderRadius: 16, padding: 22, color: '#fff' }}>
          <div style={{ fontSize: 12, color: B.blueLight, fontFamily: FONTS.body }}>Current Balance</div>
          <div style={{ fontSize: 36, fontWeight: 700, fontFamily: FONTS.ui }}>${balance.currentBalance.toFixed(2)}</div>
          {balance.currentBalance === 0 ? (
            <div style={{ fontSize: 13, color: '#81C784', marginTop: 4, fontWeight: 600 }}>
              All payments current — you're in good standing
            </div>
          ) : (
            <div style={{ fontSize: 12, color: B.blueLight, marginTop: 4 }}>
              {balance.balanceDescription || `Balance for WaveGuard ${tierName} membership`}
              {balance.dueDate && ` · Due ${parseDate(balance.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
            </div>
          )}
          {nextCharge && balance.currentBalance === 0 && (
            <div style={{ fontSize: 12, color: B.blueLight, marginTop: 4 }}>
              Next charge: ${nextCharge.amount.toFixed(2)} on {parseDate(nextCharge.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </div>
          )}
        </div>
      )}

      {/* ── 7. WaveGuard Membership Summary Card ── */}
      <div style={{
        background: `linear-gradient(135deg, ${tier?.gradientFrom || B.navy}22, ${tier?.gradientTo || B.navyLight}15)`,
        borderRadius: 16, padding: 20, border: `1.5px solid ${tier?.color || B.navy}44`,
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: -20, right: -20, fontSize: 80, opacity: 0.08 }}>🛡️</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
            padding: '4px 12px', borderRadius: 20,
            background: `${tier?.color || B.navy}22`,
            color: tier?.darkText ? B.navy : (tier?.color || B.navy),
          }}>{tierName} WaveGuard</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui }}>${monthlyRate}/mo</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: B.navy, marginBottom: 8, fontFamily: FONTS.heading }}>Included Services</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {includedServices.map(svc => (
            <div key={svc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: B.grayDark }}>
              <span>{svc.icon}</span>
              <span>{svc.name}</span>
              {discount > 0 && (
                <span style={{ fontSize: 11, color: B.green, fontWeight: 600, marginLeft: 'auto' }}>
                  ${(svc.basePrice * (1 - discount)).toFixed(0)}/mo <span style={{ textDecoration: 'line-through', color: B.grayMid }}>${svc.basePrice}</span>
                </span>
              )}
            </div>
          ))}
        </div>
        {annualSavings > 0 && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: `${B.green}12`, borderRadius: 8, fontSize: 12, color: B.green, fontWeight: 600 }}>
            Saving ${annualSavings.toFixed(0)}/year with your {tierName} bundle
          </div>
        )}
        {tierName !== 'Platinum' && additionalSavings > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: B.wavesBlue, fontWeight: 600, cursor: 'pointer' }}>
            Explore Platinum — save {Math.round(((platinumDiscount - discount) / (1 - discount)) * 100)}% more on services
          </div>
        )}
      </div>

      {/* ── 3. Manage Auto Pay ── */}
      <div style={{ background: B.white, borderRadius: 14, padding: 20, border: `1px solid ${B.grayLight}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 14 }}>Manage Auto Pay</div>

        {/* Enrollment status */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', background: B.offWhite, borderRadius: 10,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>Auto Pay Enrollment</div>
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>Auto Pay keeps your WaveGuard {tierName} membership active and hassle-free.</div>
          </div>
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase',
            padding: '4px 12px', borderRadius: 20,
            background: hasAutoPay ? '#E8F5E9' : '#FFF3E0',
            color: hasAutoPay ? B.green : B.orange,
          }}>{hasAutoPay ? 'Enrolled' : 'Not Enrolled'}</span>
        </div>
      </div>

      {/* ── Manage Payment Methods ── */}
      <div style={{ background: B.white, borderRadius: 14, padding: 20, border: `1px solid ${B.grayLight}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Manage Payment Methods</div>
          <button style={{
            padding: '6px 14px', borderRadius: 8, border: `1px solid ${B.wavesBlue}`,
            background: 'transparent', color: B.wavesBlue, fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>+ Add New</button>
        </div>

        {cards.map(c => (
          <div key={c.id} style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
            background: B.offWhite, borderRadius: 10, marginBottom: 8,
          }}>
            <div style={{
              width: 48, height: 32, borderRadius: 6,
              background: `linear-gradient(135deg, ${B.navy}, ${B.navyLight})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: 1, fontFamily: FONTS.ui,
            }}>{c.brand}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>{c.brand} ending in {c.lastFour}</div>
              <div style={{ fontSize: 12, color: B.grayMid }}>Expires {c.expMonth}/{c.expYear}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {c.isDefault && (
                <span style={{ fontSize: 11, fontWeight: 600, color: B.green, background: `${B.green}15`, padding: '3px 8px', borderRadius: 6 }}>Default</span>
              )}
              <button style={{
                padding: '4px 10px', borderRadius: 6, border: `1px solid ${B.grayLight}`,
                background: 'transparent', color: B.grayMid, fontSize: 11, cursor: 'pointer',
              }}>Edit</button>
            </div>
          </div>
        ))}

        {cards.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: B.grayMid, fontSize: 13 }}>
            No payment methods on file. Add a card to enable Auto Pay.
          </div>
        )}
      </div>

      {/* ── 8. Credits & Adjustments ── */}
      {(totalCredits > 0 || credits.length > 0) && (
        <div style={{ background: B.white, borderRadius: 14, padding: 20, border: `1px solid ${B.grayLight}` }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 14 }}>Credits & Adjustments</div>
          {totalCredits > 0 && (
            <div style={{
              padding: '10px 14px', background: `${B.green}10`, borderRadius: 10, marginBottom: 12,
              fontSize: 14, fontWeight: 700, color: B.green, display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Total Account Credit</span>
              <span>${totalCredits.toFixed(2)}</span>
            </div>
          )}
          {[
            { label: 'Referral Credits', items: referralCredits, icon: '🤝' },
            { label: 'Service Credits', items: serviceCredits, icon: '🔧' },
            { label: 'Promo Credits', items: promoCredits, icon: '🎉' },
          ].filter(g => g.items.length > 0).map(group => (
            <div key={group.label} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                {group.icon} {group.label}
              </div>
              {group.items.map((cr, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 14px', background: B.offWhite, borderRadius: 8, marginBottom: 4,
                }}>
                  <span style={{ fontSize: 13, color: B.grayDark }}>{cr.description || group.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: B.green, fontFamily: FONTS.ui }}>${(cr.amount || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          ))}
          {credits.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: B.grayMid, fontSize: 13 }}>No credits on your account</div>
          )}
        </div>
      )}

      {/* ── 4. Year-to-Date Summary ── */}
      <div style={{ background: B.white, borderRadius: 14, padding: 20, border: `1px solid ${B.grayLight}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
          {currentYear} Summary
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui }}>
          ${ytdTotal.toFixed(2)} <span style={{ fontSize: 13, fontWeight: 500, color: B.grayMid }}>across {ytdPayments.length} payment{ytdPayments.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4 }}>
          ${ytdRecurring.toFixed(2)} WaveGuard {tierName} · ${ytdOneTime.toFixed(2)} one-time services
        </div>
      </div>

      {/* ── 5. Payment History with filters ── */}
      <div style={{ background: B.white, borderRadius: 14, padding: 20, border: `1px solid ${B.grayLight}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 14 }}>Payment History</div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.5 }}>Year</span>
            <PillFilter options={['2025', '2026', 'All']} value={yearFilter} onChange={setYearFilter} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.5 }}>Type</span>
            <PillFilter options={['All', 'Recurring', 'One-Time']} value={typeFilter} onChange={setTypeFilter} />
          </div>
        </div>

        {filteredPayments.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: B.grayMid, fontSize: 13 }}>No payments match your filters</div>
        )}
        {filteredPayments.map(p => (
          <div key={p.id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 0', borderBottom: `1px solid ${B.grayLight}`,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.navy }}>{p.description}</div>
              <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>
                {parseDate(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {p.lastFour && ` · ${p.cardBrand} ••••${p.lastFour}`}
              </div>
              {/* 6. Failed payments inline action */}
              {p.status === 'failed' && (
                <button style={{
                  marginTop: 6, padding: '4px 12px', borderRadius: 6, border: `1px solid ${B.red}`,
                  background: 'transparent', color: B.red, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}>Update Payment Method</button>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui }}>${p.amount.toFixed(2)}</div>
              <span style={{
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                padding: '3px 8px', borderRadius: 20,
                ...statusBadge(p.status),
              }}>{p.status}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── 9. Billing Preferences ── */}
      <div style={{ background: B.white, borderRadius: 14, padding: 20, border: `1px solid ${B.grayLight}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 14 }}>Billing Preferences</div>

        {/* Billing email */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: B.grayMid, display: 'block', marginBottom: 6 }}>
            Billing Email (optional — separate from account email)
          </label>
          <input
            type="email"
            value={billingEmail}
            onChange={e => setBillingEmail(e.target.value)}
            placeholder={customer?.email || 'billing@example.com'}
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 10, border: `1px solid ${B.grayLight}`,
              fontSize: 14, fontFamily: FONTS.body, color: B.navy, background: B.offWhite,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* SMS toggle */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', background: B.offWhite, borderRadius: 10, marginBottom: 14,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>Payment confirmation texts</div>
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>Get a text when your payment processes</div>
          </div>
          <button
            onClick={() => setPaymentSmsEnabled(!paymentSmsEnabled)}
            style={{
              width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer',
              background: paymentSmsEnabled ? B.green : B.grayLight,
              position: 'relative', transition: 'background 0.2s ease',
            }}
          >
            <div style={{
              width: 22, height: 22, borderRadius: 11, background: '#fff',
              position: 'absolute', top: 2,
              left: paymentSmsEnabled ? 24 : 2,
              transition: 'left 0.2s ease',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        <button onClick={saveBillingPrefs} disabled={billingPrefsSaving} style={{
          ...BUTTON_BASE, padding: '10px 20px', background: B.wavesBlue, color: '#fff',
          fontSize: 13, opacity: billingPrefsSaving ? 0.6 : 1, width: '100%',
        }}>
          {billingPrefsSaving ? 'Saving...' : 'Save Billing Preferences'}
        </button>
      </div>
    </div>
  );
}

// =========================================================================
// SERVICE REQUEST TAB
// =========================================================================
function RequestTab({ customer }) {
  const [category, setCategory] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [photoPreview, setPhotoPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [requests, setRequests] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    api.getRequests?.().then(d => setRequests(d?.requests || [])).catch(() => {});
  }, [submitted]);

  const categories = [
    {
      value: 'pest_issue', label: '🐜 Pest Issue', desc: 'Seeing bugs, rodents, or wildlife',
      color: B.red, quickTaps: [
        'Ants in the kitchen',
        'Roaches in the bathroom',
        'Spiders on the lanai',
        'Wasps near the garage',
        'Rodent activity in attic',
      ],
    },
    {
      value: 'lawn_concern', label: '🌱 Lawn Concern', desc: 'Brown patches, weeds, fungus, bare spots',
      color: B.green, quickTaps: [
        'Brown patches near oak tree',
        'Dollar weed spreading',
        'Fungus spots appearing',
        'Bare spots not filling in',
        'Chinch bug damage',
      ],
    },
    {
      value: 'add_service', label: '➕ Add a Service', desc: 'Upgrade your plan or add one-time treatments',
      color: B.wavesBlue, quickTaps: [
        'Add tree & shrub care',
        'Add mosquito service',
        'One-time flea treatment',
        'Upgrade my WaveGuard tier',
        'Add fire ant treatment',
      ],
    },
    {
      value: 'irrigation', label: '💧 Irrigation Issue', desc: 'Sprinkler problems, dry spots, overwatering',
      color: B.teal, quickTaps: [
        'Sprinkler head broken',
        'Dry spots in lawn',
        'Zone not running',
        'Need irrigation adjustment',
      ],
    },
    {
      value: 'billing', label: '💳 Billing Question', desc: 'Payments, charges, plan changes',
      color: B.orange, quickTaps: [
        'Question about my bill',
        'Update payment method',
        'Change my plan',
      ],
    },
    {
      value: 'other', label: '💬 Other', desc: 'General questions or feedback',
      color: B.grayDark, quickTaps: [],
    },
  ];

  const selectedCat = categories.find(c => c.value === category);

  const handleQuickTap = (text) => {
    setSubject(text);
  };

  const handlePhotoSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    if (!category || !subject.trim()) return;
    setSubmitting(true);
    try {
      await api.createRequest?.({
        category,
        subject: subject.trim(),
        description: description.trim(),
        urgency,
      });
      setSubmitted(true);
      setCategory(''); setSubject(''); setDescription('');
      setUrgency('normal'); setPhotoPreview(null);
      setTimeout(() => setSubmitted(false), 4000);
    } catch (err) {
      console.error(err);
    }
    setSubmitting(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHeading>Service Request</SectionHeading>
      <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.65 }}>
        See something? Snap a photo and tell us. We'll get back to you within a few hours — usually much faster.
      </div>

      {submitted && (
        <div style={{
          padding: 18, borderRadius: 14, background: '#E8F5E9',
          border: `1.5px solid ${B.green}33`,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: B.green }}>✅ Request submitted!</div>
          <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4 }}>
            We've notified your service team. You'll get a text when we've reviewed it.
          </div>
        </div>
      )}

      {/* Category Selection */}
      <div style={{ background: B.white, borderRadius: 16, padding: 20, border: `1px solid ${B.grayLight}` }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 12 }}>What do you need help with?</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {categories.map(c => (
            <div key={c.value} onClick={() => { setCategory(c.value); setSubject(''); }} style={{
              padding: '14px 14px', borderRadius: 12, cursor: 'pointer',
              border: category === c.value ? `2px solid ${c.color}` : `1px solid ${B.grayLight}`,
              background: category === c.value ? `${c.color}08` : B.white,
              transition: 'all 0.2s',
              gridColumn: c.value === 'other' ? 'span 2' : undefined,
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>{c.label}</div>
              <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>{c.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail Form — shows after category selection */}
      {category && (
        <div style={{ background: B.white, borderRadius: 16, padding: 20, border: `1px solid ${B.grayLight}` }}>
          {/* Quick-tap suggestions */}
          {selectedCat?.quickTaps?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayMid, marginBottom: 8 }}>Common issues — tap to select:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {selectedCat.quickTaps.map(qt => (
                  <button key={qt} onClick={() => handleQuickTap(qt)} style={{
                    ...BUTTON_BASE, padding: '7px 12px', fontSize: 12, borderRadius: 20,
                    background: subject === qt ? selectedCat.color : B.offWhite,
                    color: subject === qt ? '#fff' : B.grayDark,
                    border: subject === qt ? 'none' : `1px solid ${B.grayLight}`,
                  }}>{qt}</button>
                ))}
              </div>
            </div>
          )}

          {/* Subject */}
          <input
            type="text" value={subject} onChange={e => setSubject(e.target.value)}
            placeholder={
              category === 'pest_issue' ? "What are you seeing? (e.g., 'Ants in the kitchen')" :
              category === 'lawn_concern' ? "Describe the issue (e.g., 'Brown patches near oak tree')" :
              category === 'add_service' ? "What service are you interested in?" :
              "Brief summary"
            }
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 12,
              border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
              color: B.navy, outline: 'none', boxSizing: 'border-box',
            }}
            onFocus={e => e.target.style.borderColor = B.wavesBlue}
            onBlur={e => e.target.style.borderColor = B.grayLight}
          />

          {/* Description */}
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            placeholder={
              category === 'pest_issue' ? "Where exactly? How long have you noticed it? Any patterns (time of day, after rain, etc.)?" :
              category === 'lawn_concern' ? "Where on the property? How big is the affected area? When did you first notice?" :
              "Any additional details that would help us (optional)"
            }
            rows={3}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 12, marginTop: 10,
              border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
              color: B.navy, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
            }}
            onFocus={e => e.target.style.borderColor = B.wavesBlue}
            onBlur={e => e.target.style.borderColor = B.grayLight}
          />

          {/* Photo Upload */}
          <div style={{ marginTop: 12 }}>
            <input
              ref={fileInputRef}
              type="file" accept="image/*" capture="environment"
              onChange={handlePhotoSelect}
              style={{ display: 'none' }}
            />
            {!photoPreview ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: '18px 16px', borderRadius: 12, cursor: 'pointer',
                  border: `2px dashed ${B.grayLight}`, textAlign: 'center',
                  background: B.offWhite, transition: 'border-color 0.2s',
                }}
              >
                <div style={{ fontSize: 28 }}>📸</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: B.navy, marginTop: 4 }}>Add a Photo</div>
                <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>
                  A photo helps us diagnose faster — snap the issue area
                </div>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <img src={photoPreview} alt="Issue photo" style={{
                  width: '100%', height: 180, objectFit: 'cover', borderRadius: 12,
                  border: `1px solid ${B.grayLight}`,
                }} />
                <button onClick={() => setPhotoPreview(null)} style={{
                  position: 'absolute', top: 8, right: 8,
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'rgba(0,0,0,0.6)', color: '#fff',
                  border: 'none', cursor: 'pointer', fontSize: 14,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>×</button>
                <div style={{
                  position: 'absolute', bottom: 8, left: 8,
                  padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                  background: 'rgba(0,0,0,0.6)', color: '#fff',
                }}>📎 Photo attached</div>
              </div>
            )}
          </div>

          {/* Urgency */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: B.grayMid, marginBottom: 8 }}>How urgent is this?</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { value: 'low', label: 'Not Urgent', desc: 'Next visit is fine', color: B.grayMid },
                { value: 'normal', label: 'Normal', desc: 'Within a few days', color: B.wavesBlue },
                { value: 'urgent', label: 'Urgent', desc: 'ASAP please', color: B.red },
              ].map(u => (
                <button key={u.value} onClick={() => setUrgency(u.value)} style={{
                  flex: 1, padding: '10px 8px', borderRadius: 10, cursor: 'pointer',
                  border: urgency === u.value ? `2px solid ${u.color}` : `1px solid ${B.grayLight}`,
                  background: urgency === u.value ? `${u.color}10` : B.white,
                  textAlign: 'center', transition: 'all 0.2s',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: urgency === u.value ? u.color : B.grayDark }}>{u.label}</div>
                  <div style={{ fontSize: 10, color: B.grayMid, marginTop: 2 }}>{u.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Submit */}
          <button onClick={handleSubmit} disabled={!subject.trim() || submitting} style={{
            ...BUTTON_BASE, width: '100%', padding: 14, marginTop: 16, fontSize: 15,
            background: subject.trim() ? B.red : B.grayLight,
            color: subject.trim() ? '#fff' : B.grayMid,
            opacity: submitting ? 0.7 : 1,
          }}>
            {submitting ? 'Sending...' : '📤 Submit Request'}
          </button>

          <div style={{ fontSize: 11, color: B.grayMid, textAlign: 'center', marginTop: 8 }}>
            We'll text you at {customer.phone} when we've reviewed your request
          </div>
        </div>
      )}

      {/* Add a Service — upsell when not in add_service category */}
      {category !== 'add_service' && (
        <div style={{
          background: `linear-gradient(135deg, ${B.wavesBlue}08, ${B.bluePale})`,
          borderRadius: 14, padding: 18, border: `1px solid ${B.wavesBlue}22`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Looking to add a service?</div>
          <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4, lineHeight: 1.5 }}>
            Expand your coverage with add-on services — tree & shrub care, mosquito barrier, fire ant control, and more.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {[
              { label: '🌳 Tree & Shrub', service: 'Add tree & shrub care' },
              { label: '🦟 Mosquito', service: 'Add mosquito service' },
              { label: '🔥 Fire Ant', service: 'Add fire ant treatment' },
              { label: '⬆️ Upgrade Plan', service: 'Upgrade my WaveGuard tier' },
            ].map(s => (
              <button key={s.label} onClick={() => { setCategory('add_service'); setSubject(s.service); }} style={{
                ...BUTTON_BASE, padding: '7px 12px', fontSize: 11, borderRadius: 20,
                background: B.white, color: B.wavesBlue, border: `1px solid ${B.wavesBlue}33`,
              }}>{s.label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Past requests */}
      {requests.length > 0 && (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 8 }}>Your Requests</div>
          {requests.map(r => (
            <div key={r.id} style={{
              background: B.white, borderRadius: 12, padding: '14px 18px',
              border: `1px solid ${r.status === 'resolved' ? B.green + '33' : B.grayLight}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: B.navy }}>{r.subject}</div>
                <span style={{
                  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', padding: '3px 8px', borderRadius: 20,
                  background: r.status === 'resolved' ? '#E8F5E9' : r.status === 'in_progress' ? '#FFF3E0' : B.bluePale,
                  color: r.status === 'resolved' ? B.green : r.status === 'in_progress' ? B.orange : B.wavesBlue,
                }}>{r.status?.replace('_', ' ')}</span>
              </div>
              <div style={{ fontSize: 11, color: B.grayMid, marginTop: 4 }}>
                {r.category?.replace('_', ' ')} · {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// =========================================================================
// MY PROPERTY TAB — access codes, pets, scheduling, irrigation, HOA
// =========================================================================
function PropertySection({ title, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  return (
    <div style={{
      background: B.white, borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${B.grayLight}`,
    }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: '14px 18px', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{title}</div>
        <span style={{
          fontSize: 18, color: B.grayMid, transition: 'transform 0.3s',
          transform: open ? 'rotate(180deg)' : 'rotate(0)',
        }}>▾</span>
      </div>
      {open && <div style={{ padding: '0 18px 18px' }}>{children}</div>}
    </div>
  );
}

function PasswordField({ value, onChange, placeholder, label }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>{label}</div>}
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%', padding: '11px 40px 11px 14px', borderRadius: 10,
            border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
            color: B.navy, outline: 'none', boxSizing: 'border-box',
          }}
          onFocus={e => e.target.style.borderColor = B.wavesBlue}
          onBlur={e => e.target.style.borderColor = B.grayLight}
        />
        <button onClick={() => setShow(!show)} style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 16,
          color: B.grayMid, padding: 4,
        }}>{show ? '🙈' : '👁️'}</button>
      </div>
    </div>
  );
}

function PillSelector({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{
          ...BUTTON_BASE, padding: '7px 14px', fontSize: 12, borderRadius: 20,
          background: value === o.value ? B.wavesBlue : B.offWhite,
          color: value === o.value ? '#fff' : B.grayDark,
          border: value === o.value ? 'none' : `1px solid ${B.grayLight}`,
        }}>{o.label}</button>
      ))}
    </div>
  );
}

function NumberStepper({ value, onChange, min = 0, max = 99 }) {
  const v = value || 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button onClick={() => onChange(Math.max(min, v - 1))} style={{
        width: 32, height: 32, borderRadius: '50%', border: `1px solid ${B.grayLight}`,
        background: B.offWhite, cursor: 'pointer', fontSize: 16, color: B.navy,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>−</button>
      <span style={{ fontSize: 18, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui, minWidth: 24, textAlign: 'center' }}>{v}</span>
      <button onClick={() => onChange(Math.min(max, v + 1))} style={{
        width: 32, height: 32, borderRadius: '50%', border: `1px solid ${B.grayLight}`,
        background: B.offWhite, cursor: 'pointer', fontSize: 16, color: B.navy,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>+</button>
    </div>
  );
}

function PropertyTab({ customer }) {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved'
  const debounceRef = useRef(null);
  const pendingRef = useRef({});

  useEffect(() => {
    api.getPropertyPreferences()
      .then(d => { setPrefs(d.preferences); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const updateField = useCallback((field, value) => {
    setPrefs(prev => ({ ...prev, [field]: value }));
    pendingRef.current[field] = value;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const toSave = { ...pendingRef.current };
      pendingRef.current = {};
      setSaveStatus('saving');
      try {
        await api.updatePropertyPreferences(toSave);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus(null), 2000);
      } catch (err) {
        console.error(err);
        setSaveStatus(null);
      }
    }, 1000);
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Loading property info...</div>;
  if (!prefs) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Unable to load preferences.</div>;

  const updatedAt = prefs.updatedAt ? (() => {
    const d = new Date(prefs.updatedAt);
    const diff = Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'Updated today';
    if (diff === 1) return 'Updated yesterday';
    return `Updated ${diff} days ago`;
  })() : null;

  const textArea = (field, placeholder, rows = 2) => (
    <textarea
      value={prefs[field] || ''}
      onChange={e => updateField(field, e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: '100%', padding: '11px 14px', borderRadius: 10,
        border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
        color: B.navy, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
      }}
      onFocus={e => e.target.style.borderColor = B.wavesBlue}
      onBlur={e => e.target.style.borderColor = B.grayLight}
    />
  );

  const textInput = (field, placeholder, label) => (
    <div style={{ marginBottom: 12 }}>
      {label && <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>{label}</div>}
      <input
        type="text"
        value={prefs[field] || ''}
        onChange={e => updateField(field, e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '11px 14px', borderRadius: 10,
          border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
          color: B.navy, outline: 'none', boxSizing: 'border-box',
        }}
        onFocus={e => e.target.style.borderColor = B.wavesBlue}
        onBlur={e => e.target.style.borderColor = B.grayLight}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'relative' }}>
      {/* Save toast */}
      {saveStatus && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)',
          padding: '8px 20px', borderRadius: 20, zIndex: 200,
          background: saveStatus === 'saved' ? B.green : B.wavesBlue,
          color: '#fff', fontSize: 13, fontWeight: 600,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          transition: 'opacity 0.3s',
          opacity: saveStatus ? 1 : 0,
        }}>
          {saveStatus === 'saving' ? 'Saving...' : 'Saved ✓'}
        </div>
      )}

      <SectionHeading>My Property</SectionHeading>

      {/* Property overview from customer profile */}
      <div style={{
        borderRadius: 16, overflow: 'hidden', border: `1px solid ${B.grayLight}`,
      }}>
        {/* Satellite image */}
        {customer.address?.line1 && (
          <div style={{ width: '100%', height: 180, overflow: 'hidden', position: 'relative' }}>
            <img
              src={`https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(`${customer.address.line1}, ${customer.address.city}, ${customer.address.state} ${customer.address.zip}`)}&zoom=19&size=640x300&maptype=satellite&key=${import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''}`}
              alt="Property satellite view"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={e => { e.target.style.display = 'none'; }}
            />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 40, background: 'linear-gradient(transparent, rgba(0,0,0,0.5))' }} />
          </div>
        )}
        <div style={{
          background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
          backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
          backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
          padding: 20, color: '#fff',
        }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: FONTS.heading }}>
            {customer.address?.line1}
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            {customer.address?.city}, {customer.address?.state} {customer.address?.zip}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
            {[
              { label: 'Turf', value: (customer.property?.lawnType || '—').replace(/\s*(Full Sun|Shade|Sun\/Shade)\s*/gi, '') || '—' },
              { label: 'Home', value: customer.property?.propertySqFt ? `${customer.property.propertySqFt.toLocaleString()} sq ft` : '—' },
              { label: 'Treated Area', value: customer.property?.bedSqFt ? `${(customer.property.propertySqFt - (customer.property.bedSqFt || 0)).toLocaleString()} sq ft` : (customer.property?.propertySqFt ? `${customer.property.propertySqFt.toLocaleString()} sq ft` : '—') },
              { label: 'Lot', value: customer.property?.lotSqFt ? `${customer.property.lotSqFt.toLocaleString()} sq ft` : '—' },
            ].map(p => (
              <div key={p.label}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8, color: B.blueLight }}>{p.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{p.value}</div>
              </div>
            ))}
          </div>
          {updatedAt && (
            <div style={{ fontSize: 11, color: B.blueLight, marginTop: 12 }}>{updatedAt}</div>
          )}
        </div>
      </div>

      {/* SECTION 1 — Access & Gate Codes */}
      <PropertySection title="🔑 Access & Gate Codes">
        <PasswordField
          label="Neighborhood / Community Gate Code"
          value={prefs.neighborhoodGateCode}
          onChange={v => updateField('neighborhoodGateCode', v)}
          placeholder="e.g., #1234 or press 5 for visitor"
        />
        <PasswordField
          label="Property Gate Code"
          value={prefs.propertyGateCode}
          onChange={v => updateField('propertyGateCode', v)}
          placeholder="e.g., Combination lock: 4821"
        />
        <PasswordField
          label="Garage Code"
          value={prefs.garageCode}
          onChange={v => updateField('garageCode', v)}
          placeholder="e.g., Keypad code: 9876"
        />
        <PasswordField
          label="Lockbox Code"
          value={prefs.lockboxCode}
          onChange={v => updateField('lockboxCode', v)}
          placeholder="e.g., Lockbox on back door: 0000"
        />
        {textInput('sideGateAccess', 'e.g., Side gate - lift latch, no code needed', 'Side Gate / Backyard Access')}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Parking Notes</div>
          {textArea('parkingNotes', 'e.g., Park in driveway, HOA enforces no street parking')}
        </div>
        <div style={{ fontSize: 11, color: B.grayMid, fontStyle: 'italic', marginTop: 4 }}>
          🔒 Only visible to your assigned technician on service day
        </div>
      </PropertySection>

      {/* SECTION 2 — Pets */}
      <PropertySection title="🐾 Pets">
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>How many pets?</div>
          <NumberStepper value={prefs.petCount} onChange={v => {
            updateField('petCount', v);
            // Resize structured pets array to match count
            const current = Array.isArray(prefs.petsStructured) ? prefs.petsStructured : [];
            if (v > current.length) {
              const extended = [...current];
              for (let i = current.length; i < v; i++) {
                extended.push({ name: '', type: '', breed: '', indoor: '', temperament: '' });
              }
              updateField('petsStructured', extended);
            } else if (v < current.length) {
              updateField('petsStructured', current.slice(0, v));
            }
          }} max={10} />
        </div>
        {(prefs.petCount || 0) > 0 && (
          <>
            {Array.from({ length: prefs.petCount }).map((_, idx) => {
              const pet = (Array.isArray(prefs.petsStructured) ? prefs.petsStructured : [])[idx] || {};
              const updatePet = (key, val) => {
                const arr = Array.isArray(prefs.petsStructured) ? [...prefs.petsStructured] : [];
                while (arr.length <= idx) arr.push({ name: '', type: '', breed: '', indoor: '', temperament: '' });
                arr[idx] = { ...arr[idx], [key]: val };
                updateField('petsStructured', arr);
              };
              return (
                <div key={idx} style={{
                  marginBottom: 14, padding: 14, borderRadius: 12,
                  background: B.offWhite, border: `1px solid ${B.grayLight}`,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 10 }}>
                    Pet {idx + 1}
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Name</div>
                    <input
                      type="text"
                      value={pet.name || ''}
                      onChange={e => updatePet('name', e.target.value)}
                      placeholder="e.g., Max"
                      style={{
                        width: '100%', padding: '11px 14px', borderRadius: 10,
                        border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
                        color: B.navy, outline: 'none', boxSizing: 'border-box',
                      }}
                      onFocus={e => e.target.style.borderColor = B.wavesBlue}
                      onBlur={e => e.target.style.borderColor = B.grayLight}
                    />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 6 }}>Type</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {['Dog', 'Cat', 'Other'].map(t => (
                        <button key={t} onClick={() => updatePet('type', t)} style={{
                          ...BUTTON_BASE, padding: '7px 14px', fontSize: 12, borderRadius: 20,
                          background: pet.type === t ? B.wavesBlue : B.white,
                          color: pet.type === t ? '#fff' : B.grayDark,
                          border: pet.type === t ? 'none' : `1px solid ${B.grayLight}`,
                        }}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Breed (optional)</div>
                    <input
                      type="text"
                      value={pet.breed || ''}
                      onChange={e => updatePet('breed', e.target.value)}
                      placeholder="e.g., Golden Retriever"
                      style={{
                        width: '100%', padding: '11px 14px', borderRadius: 10,
                        border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
                        color: B.navy, outline: 'none', boxSizing: 'border-box',
                      }}
                      onFocus={e => e.target.style.borderColor = B.wavesBlue}
                      onBlur={e => e.target.style.borderColor = B.grayLight}
                    />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 6 }}>Indoor / Outdoor</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {['Indoor', 'Outdoor', 'Both'].map(t => (
                        <button key={t} onClick={() => updatePet('indoor', t)} style={{
                          ...BUTTON_BASE, padding: '7px 14px', fontSize: 12, borderRadius: 20,
                          background: pet.indoor === t ? B.wavesBlue : B.white,
                          color: pet.indoor === t ? '#fff' : B.grayDark,
                          border: pet.indoor === t ? 'none' : `1px solid ${B.grayLight}`,
                        }}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 6 }}>Temperament</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {['Friendly', 'Cautious', 'Aggressive'].map(t => (
                        <button key={t} onClick={() => updatePet('temperament', t)} style={{
                          ...BUTTON_BASE, padding: '7px 14px', fontSize: 12, borderRadius: 20,
                          background: pet.temperament === t ? B.wavesBlue : B.white,
                          color: pet.temperament === t ? '#fff' : B.grayDark,
                          border: pet.temperament === t ? 'none' : `1px solid ${B.grayLight}`,
                        }}>{t}</button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Pet Plan for Service Day</div>
              {textArea('petSecuredPlan', 'e.g., Dogs will be inside. Please text 15 min before so I can secure them.', 2)}
            </div>
          </>
        )}
      </PropertySection>

      {/* SECTION 3 — Scheduling Preferences */}
      <PropertySection title="⏰ Scheduling Preferences">
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>Preferred Day</div>
          <PillSelector
            value={prefs.preferredDay}
            onChange={v => updateField('preferredDay', v)}
            options={[
              { value: 'monday', label: 'Mon' }, { value: 'tuesday', label: 'Tue' },
              { value: 'wednesday', label: 'Wed' }, { value: 'thursday', label: 'Thu' },
              { value: 'friday', label: 'Fri' }, { value: 'no_preference', label: 'No Preference' },
            ]}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>Preferred Time</div>
          <PillSelector
            value={prefs.preferredTime}
            onChange={v => updateField('preferredTime', v)}
            options={[
              { value: 'early_morning', label: 'Early AM (7-9)' }, { value: 'morning', label: 'Morning (9-11)' },
              { value: 'midday', label: 'Midday (11-1)' }, { value: 'afternoon', label: 'Afternoon (1-4)' },
              { value: 'no_preference', label: 'No Preference' },
            ]}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>Contact Preference</div>
          <PillSelector
            value={prefs.contactPreference}
            onChange={v => updateField('contactPreference', v)}
            options={[
              { value: 'call', label: '📞 Call' }, { value: 'text', label: '💬 Text' },
              { value: 'email', label: '📧 Email' },
            ]}
          />
        </div>
        <div style={{
          padding: 14, borderRadius: 12, background: B.offWhite,
          border: `1px solid ${B.grayLight}`,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 4 }}>Blackout Dates</div>
          <div style={{ fontSize: 11, color: B.grayMid, marginBottom: 10 }}>
            Do not service between these dates (vacation, events, etc.)
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 130 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Start Date</div>
              <input
                type="date"
                value={prefs.blackoutStart || ''}
                onChange={e => updateField('blackoutStart', e.target.value || null)}
                style={{
                  width: '100%', padding: '11px 14px', borderRadius: 10,
                  border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
                  color: B.navy, outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = B.wavesBlue}
                onBlur={e => e.target.style.borderColor = B.grayLight}
              />
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>End Date</div>
              <input
                type="date"
                value={prefs.blackoutEnd || ''}
                onChange={e => updateField('blackoutEnd', e.target.value || null)}
                style={{
                  width: '100%', padding: '11px 14px', borderRadius: 10,
                  border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
                  color: B.navy, outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = B.wavesBlue}
                onBlur={e => e.target.style.borderColor = B.grayLight}
              />
            </div>
          </div>
        </div>
      </PropertySection>

      {/* SECTION 4 — Irrigation */}
      <PropertySection title="💧 Irrigation">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: B.navy }}>Has irrigation system?</div>
          <div onClick={() => updateField('irrigationSystem', !prefs.irrigationSystem)} style={{
            width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
            background: prefs.irrigationSystem ? B.wavesBlue : B.grayLight,
            position: 'relative', transition: 'background 0.3s',
          }}>
            <div style={{
              position: 'absolute', top: 2, width: 20, height: 20,
              borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
              left: prefs.irrigationSystem ? 22 : 2, transition: 'left 0.3s',
            }} />
          </div>
        </div>
        {prefs.irrigationSystem && (
          <>
            {textInput('irrigationControllerLocation', 'e.g., Left side of garage, gray box', 'Controller Location')}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>Number of Zones</div>
              <NumberStepper value={prefs.irrigationZones} onChange={v => updateField('irrigationZones', v)} max={20} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>Watering Days</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => {
                  const days = Array.isArray(prefs.wateringDays) ? prefs.wateringDays : [];
                  const active = days.includes(day);
                  return (
                    <button key={day} onClick={() => {
                      const next = active ? days.filter(d => d !== day) : [...days, day];
                      updateField('wateringDays', next);
                    }} style={{
                      ...BUTTON_BASE, padding: '7px 14px', fontSize: 12, borderRadius: 20,
                      background: active ? B.wavesBlue : B.offWhite,
                      color: active ? '#fff' : B.grayDark,
                      border: active ? 'none' : `1px solid ${B.grayLight}`,
                    }}>{day}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 8 }}>System Type</div>
              <PillSelector
                value={prefs.irrigationSystemType}
                onChange={v => updateField('irrigationSystemType', v)}
                options={[
                  { value: 'spray', label: 'In-ground Spray' },
                  { value: 'drip', label: 'Drip' },
                  { value: 'rotor', label: 'Rotor' },
                ]}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.navy }}>Rain sensor installed?</div>
              <div onClick={() => updateField('rainSensor', !prefs.rainSensor)} style={{
                width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                background: prefs.rainSensor ? B.wavesBlue : B.grayLight,
                position: 'relative', transition: 'background 0.3s',
              }}>
                <div style={{
                  position: 'absolute', top: 2, width: 20, height: 20,
                  borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                  left: prefs.rainSensor ? 22 : 2, transition: 'left 0.3s',
                }} />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Schedule Notes</div>
              {textArea('irrigationScheduleNotes', 'e.g., Runs Mon/Wed/Fri at 4am. Zone 3 seems to run too long.', 3)}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>Known Issues</div>
              {textArea('irrigationIssues', "e.g., Zone 4 doesn't reach the back corner", 2)}
            </div>
          </>
        )}
      </PropertySection>

      {/* SECTION 5 — HOA Information */}
      <PropertySection title="🏘️ HOA Information">
        {textInput('hoaName', 'e.g., Sandpiper Bay HOA', 'HOA Name')}
        {textInput('hoaCompany', 'e.g., FirstService Residential', 'HOA Management Company')}
        {textInput('hoaPhone', 'e.g., (239) 555-0100', 'HOA Contact Phone')}
        {textInput('hoaEmail', 'e.g., manager@sandpiperhoa.com', 'HOA Contact Email')}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: B.grayDark, marginBottom: 4 }}>HOA Restrictions</div>
          {textArea('hoaRestrictions', 'e.g., No signs in yard, must notify management 24hr before exterior treatment, no parking on street', 3)}
        </div>
        {textInput('hoaLawnHeight', 'e.g., Must be mowed below 4 inches', 'Lawn Height Requirement')}
        {textInput('hoaSignageRules', 'e.g., No lawn signs allowed', 'Treatment Signage Rules')}
        {textInput('hoaTimingRestrictions', 'e.g., No spray before 9 AM near pool', 'Application Timing Restrictions')}
        {textInput('hoaInspectionPeriod', 'e.g., March and October', 'Annual Inspection Period')}
      </PropertySection>

      {/* SECTION 6 — Access Notes */}
      <PropertySection title="🚪 Access Notes">
        {textArea('accessNotes', "e.g., Please don't ring doorbell — baby sleeping during morning appointments", 2)}
      </PropertySection>

      {/* SECTION 7 — Anything Else */}
      <PropertySection title="📝 Anything Else">
        {textArea('specialInstructions', 'Anything else your technician should know about your property...', 4)}
      </PropertySection>
    </div>
  );
}

// =========================================================================
// KNOWLEDGE BASE TAB — SWFL-specific pest & lawn content
// =========================================================================
const ARTICLES = [
  {
    id: 1, icon: '🐜', category: 'Pests',
    title: 'Why Ghost Ants Love Your Kitchen',
    summary: 'Ghost ants are one of the most common indoor pests in Southwest Florida. They\'re attracted to moisture and sweet foods, and their tiny size (1.3mm) lets them slip through the smallest cracks.',
    tips: ['Keep counters wiped down — even small crumbs attract them', 'Fix any dripping faucets or pipes', 'Don\'t leave pet food out overnight', 'Our quarterly treatment creates a barrier they can\'t cross'],
  },
  {
    id: 2, icon: '🌿', category: 'Lawn Care',
    title: 'Large Patch Fungus in St. Augustine',
    summary: 'Large patch (Rhizoctonia solani) is the #1 disease in St. Augustine lawns in Florida. It shows up as circular brown patches, usually in fall/spring when soil temps are 60-75°F.',
    tips: ['Don\'t water in the evening — morning irrigation only', 'Reduce nitrogen fertilizer during active infection', 'Improve air circulation by trimming overhanging branches', 'We treat with Headway G or Azoxystrobin for proven control'],
  },
  {
    id: 3, icon: '🦟', category: 'Pests',
    title: 'Mosquito Season in SWFL',
    summary: 'In Southwest Florida, mosquito season runs nearly year-round but peaks June through October. Standing water after rain is their #1 breeding ground.',
    tips: ['Empty saucers, bird baths, and any standing water weekly', 'Keep gutters clear and draining properly', 'Our barrier treatments last 21-30 days per application', 'WaveGuard Gold and Platinum include monthly mosquito service'],
  },
  {
    id: 4, icon: '🌴', category: 'Lawn Care',
    title: 'Dollar Weed: What It Tells You',
    summary: 'Dollar weed (Hydrocotyle) is actually an indicator plant — it thrives in overwatered areas. If you see it spreading, your irrigation is probably too aggressive.',
    tips: ['Reduce irrigation runtime by 5-10 minutes per zone', 'Water deeply but less frequently (2-3x per week max)', 'We spot-treat with Celsius WG (max 3 applications/year)', 'Proper irrigation is the real long-term fix'],
  },
  {
    id: 5, icon: '🕷️', category: 'Pests',
    title: 'Spiders Around Your Lanai',
    summary: 'Most spiders in SWFL (banana spiders, orb weavers, wolf spiders) are harmless and actually helpful — they eat other pests. But nobody wants webs all over their lanai.',
    tips: ['Our cobweb sweep is included in every quarterly visit', 'Reducing outdoor lighting at night reduces spider food (bugs)', 'Seal gaps around doors and windows', 'Dangerous species (brown recluse, black widow) are rare but we monitor'],
  },
  {
    id: 6, icon: '🌱', category: 'Lawn Care',
    title: 'Chinch Bugs: The Silent Lawn Killer',
    summary: 'Southern chinch bugs cause more damage to St. Augustine lawns in Florida than any other insect. They suck plant juices and inject a toxin that kills the grass.',
    tips: ['Damage looks like drought stress — yellowing then browning at edges', 'Peak season is July-September in the hottest, sunniest spots', 'Thatch buildup over 0.5" increases risk — ask us about dethatching', 'We rotate insecticide modes of action to prevent resistance'],
  },
];

function WeatherPestWidget() {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getWeather()
      .then(d => { setWeather(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{
      background: `linear-gradient(135deg, ${B.navy}, ${B.navyLight})`,
      borderRadius: 16, padding: 24, color: '#fff', textAlign: 'center',
    }}>
      <div style={{ fontSize: 13, opacity: 0.7 }}>Loading weather data...</div>
    </div>
  );

  if (!weather) return null;

  const pressureItems = [
    { label: 'Mosquito Pressure', ...weather.pestPressure.mosquito, icon: '🦟' },
    { label: 'Fungus Risk', ...weather.pestPressure.fungus, icon: '🍄' },
    { label: 'Chinch Bug Risk', ...weather.pestPressure.chinch, icon: '🐛' },
  ];

  return (
    <div style={{
      background: `linear-gradient(135deg, ${B.navy}, ${B.navyLight}, #1a3a5c)`,
      borderRadius: 16, overflow: 'hidden', color: '#fff',
    }}>
      {/* Weather header */}
      <div style={{ padding: '18px 20px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: B.blueLight }}>
            {weather.location}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 42, fontWeight: 800, fontFamily: FONTS.ui }}>{weather.temp}°</span>
            <span style={{ fontSize: 14, opacity: 0.8 }}>F</span>
          </div>
          <div style={{ fontSize: 13, color: '#fff', marginTop: 2 }}>{weather.forecast}</div>
          <div style={{ fontSize: 11, color: B.blueLight, marginTop: 2 }}>
            Tonight: {weather.nightTemp}° · Humidity: {weather.humidity}% · Wind: {weather.wind}
          </div>
        </div>
        <div style={{ fontSize: 48, lineHeight: 1 }}>
          {weather.forecast?.toLowerCase().includes('rain') || weather.forecast?.toLowerCase().includes('storm') ? '⛈️' :
           weather.forecast?.toLowerCase().includes('cloud') ? '⛅' :
           weather.forecast?.toLowerCase().includes('sunny') || weather.forecast?.toLowerCase().includes('clear') ? '☀️' : '🌤️'}
        </div>
      </div>

      {/* Pest pressure bars */}
      <div style={{ padding: '0 20px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pressureItems.map(p => (
          <div key={p.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.9 }}>{p.icon} {p.label}</span>
              <span style={{
                fontSize: 11, fontWeight: 800, letterSpacing: 0.5,
                padding: '2px 8px', borderRadius: 10,
                background: `${p.color}33`, color: p.color,
              }}>{p.level}</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.15)' }}>
              <div style={{
                height: '100%', borderRadius: 2, background: p.color,
                width: p.level === 'HIGH' ? '100%' : p.level === 'MODERATE' ? '60%' : '25%',
                transition: 'width 1s ease-out',
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* Irrigation recommendation */}
      <div style={{
        margin: '0 12px 12px', padding: '12px 16px', borderRadius: 12,
        background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: 24 }}>💧</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>
            Irrigation: {weather.irrigationRecommendation.inches}" recommended
          </div>
          <div style={{ fontSize: 11, color: B.blueLight }}>{weather.irrigationRecommendation.note}</div>
        </div>
      </div>

      {/* Updated timestamp */}
      <div style={{ padding: '0 20px 12px', fontSize: 10, opacity: 0.4, textAlign: 'right' }}>
        Updated {new Date(weather.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
      </div>
    </div>
  );
}

function FeedSection({ title, icon, fetchFn, emptyMsg }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFn()
      .then(d => { setPosts(d.posts || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ padding: 20, textAlign: 'center', color: B.grayMid, fontSize: 12 }}>Loading {title.toLowerCase()}...</div>
  );
  if (!posts.length) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{title}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {posts.map((p, i) => {
          const pubDate = p.pubDate ? new Date(p.pubDate) : null;
          return (
            <a key={i} href={p.link} target="_blank" rel="noopener noreferrer" style={{
              background: B.white, borderRadius: 12, padding: '14px 16px',
              border: `1px solid ${B.grayLight}`, textDecoration: 'none',
              transition: 'border-color 0.2s',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: B.navy, lineHeight: 1.4 }}>{p.title}</div>
              {p.description && (
                <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4, lineHeight: 1.5 }}>
                  {p.description}{p.description.length >= 200 ? '...' : ''}
                </div>
              )}
              <div style={{ fontSize: 11, color: B.grayMid, marginTop: 6 }}>
                {pubDate && !isNaN(pubDate) ? pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                {p.category ? ` · ${p.category}` : ''}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function ContentCard({ post, large }) {
  const pubDate = post.pubDate ? new Date(post.pubDate) : null;
  const sourceColors = { blog: B.wavesBlue, newsletter: B.yellow, ifas: B.green, local: B.grayMid };
  const srcColor = sourceColors[post.source] || B.grayMid;

  return (
    <a href={post.link} target="_blank" rel="noopener noreferrer" style={{
      background: B.white, borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${B.bluePale}`, textDecoration: 'none',
      display: 'block', transition: 'box-shadow 0.2s',
    }}>
      {post.image && large && (
        <div style={{
          height: 140, background: `url(${post.image}) center/cover no-repeat`,
          borderBottom: `1px solid ${B.grayLight}`,
        }} />
      )}
      <div style={{ padding: large ? '14px 16px' : '12px 14px', display: 'flex', gap: 12 }}>
        {post.image && !large && (
          <div style={{
            width: 56, height: 56, borderRadius: 10, flexShrink: 0,
            background: `url(${post.image}) center/cover no-repeat, ${B.blueSurface}`,
          }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
              padding: '2px 7px', borderRadius: 8,
              background: `${srcColor}18`, color: srcColor,
            }}>{post.sourceName}</span>
            {pubDate && !isNaN(pubDate) && (
              <span style={{ fontSize: 10, color: '#90A4AE' }}>
                {pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
          <div style={{
            fontSize: large ? 15 : 13, fontWeight: 700, color: B.navy, lineHeight: 1.4,
            overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>{post.title}</div>
          {post.description && large && (
            <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4, lineHeight: 1.5,
              overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            }}>{post.description}</div>
          )}
        </div>
      </div>
    </a>
  );
}

function LearnTab() {
  const [alerts, setAlerts] = useState([]);
  const [blogPosts, setBlogPosts] = useState([]);
  const [newsletterPosts, setNewsletterPosts] = useState([]);
  const [expertPosts, setExpertPosts] = useState([]);
  const [localNews, setLocalNews] = useState([]);
  const [faq, setFaq] = useState([]);
  const [monthlyTip, setMonthlyTip] = useState(null);
  const [expandedFaq, setExpandedFaq] = useState(null);
  const [faqSearch, setFaqSearch] = useState('');

  useEffect(() => {
    api.getAlerts().then(d => setAlerts(d.alerts || [])).catch(() => {});
    api.getBlogPosts().then(d => setBlogPosts(d.posts || [])).catch(() => {});
    api.getNewsletterPosts().then(d => setNewsletterPosts(d.posts || [])).catch(() => {});
    api.getExpertPosts().then(d => setExpertPosts(d.posts || [])).catch(() => {});
    api.getLocalNews().then(d => setLocalNews(d.posts || [])).catch(() => {});
    api.getFaq().then(d => setFaq(d.categories || [])).catch(() => {});
    api.getMonthlyTip().then(setMonthlyTip).catch(() => {});
  }, []);

  const alertColors = { urgent: B.red, seasonal: B.orange, info: B.wavesBlue };

  const wavesPosts = [...blogPosts, ...newsletterPosts]
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, 4);

  // FAQ search filter
  const filteredFaq = faqSearch.trim()
    ? faq.map(cat => ({
        ...cat,
        questions: cat.questions.filter(q =>
          `${q.q} ${q.a}`.toLowerCase().includes(faqSearch.toLowerCase())
        ),
      })).filter(cat => cat.questions.length > 0)
    : faq;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionHeading>Learn & Stay Informed</SectionHeading>

      {/* Weather & Pest Pressure Widget */}
      <WeatherPestWidget />

      {/* SECTION 1 — SWFL Alerts */}
      {alerts.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
            🚨 SWFL Alerts
          </div>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
            {alerts.map((a, i) => (
              <div key={i} style={{
                flex: '0 0 260px', background: B.white, borderRadius: 12, padding: '12px 14px',
                borderLeft: `4px solid ${alertColors[a.type] || B.wavesBlue}`,
                border: `1px solid ${B.grayLight}`,
                borderLeftWidth: 4, borderLeftColor: alertColors[a.type] || B.wavesBlue,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 16 }}>{a.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: B.navy }}>{a.title}</span>
                </div>
                <div style={{ fontSize: 12, color: B.grayDark, lineHeight: 1.5 }}>{a.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 2 — From Waves */}
      {wavesPosts.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
            🌿 From Waves
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {wavesPosts.map((p, i) => (
              <ContentCard key={i} post={p} />
            ))}
          </div>
        </div>
      )}

      {/* SECTION 3 — From the Experts */}
      {expertPosts.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
            🔬 From the Experts
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {expertPosts.map((p, i) => (
              <ContentCard key={i} post={p} />
            ))}
          </div>
        </div>
      )}

      {/* SECTION 4 — Local Suncoast News */}
      {localNews.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
            📰 Local Suncoast News
          </div>
          <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 10 }}>What's happening in SWFL that affects your home</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {localNews.map((p, i) => (
              <ContentCard key={i} post={p} />
            ))}
          </div>
        </div>
      )}

      {/* SECTION 5 — Monthly Tip */}
      {monthlyTip && (
        <div style={{
          background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
          backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark})`,
          backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
          borderRadius: 16, padding: 20, color: '#fff',
        }}>
          <div style={{ fontSize: 12, color: B.blueLight, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8 }}>
            🌴 {monthlyTip.month} Homeowner Tip
          </div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: FONTS.heading, marginTop: 6 }}>
            {monthlyTip.title}
          </div>
          <div style={{ fontSize: 14, color: '#fff', lineHeight: 1.65, marginTop: 8 }}>
            {monthlyTip.tip}
          </div>
        </div>
      )}

      {/* SECTION 6 — FAQ */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>
          🧠 Pest & Lawn FAQ
        </div>
        <input
          type="text" value={faqSearch} onChange={e => setFaqSearch(e.target.value)}
          placeholder="Search questions..."
          style={{
            width: '100%', padding: '10px 14px', borderRadius: 10, marginBottom: 12,
            border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
            color: B.navy, outline: 'none', boxSizing: 'border-box',
          }}
          onFocus={e => e.target.style.borderColor = B.wavesBlue}
          onBlur={e => e.target.style.borderColor = B.grayLight}
        />

        {filteredFaq.map(cat => (
          <div key={cat.category} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.grayDark, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{cat.icon}</span> {cat.category}
            </div>
            {cat.questions.map((q, qi) => {
              const faqId = `${cat.category}-${qi}`;
              const isOpen = expandedFaq === faqId;
              return (
                <div key={qi} style={{
                  background: B.white, borderRadius: 10, marginBottom: 6,
                  border: `1px solid ${isOpen ? B.wavesBlue + '44' : B.grayLight}`,
                  overflow: 'hidden',
                }}>
                  <div onClick={() => setExpandedFaq(isOpen ? null : faqId)} style={{
                    padding: '12px 14px', cursor: 'pointer',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: B.navy, flex: 1, paddingRight: 10 }}>{q.q}</div>
                    <span style={{ fontSize: 14, color: B.grayMid, transform: isOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▾</span>
                  </div>
                  {isOpen && (
                    <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${B.grayLight}` }}>
                      <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.7, marginTop: 10 }}>{q.a}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div style={{
          textAlign: 'center', padding: 16, background: B.blueSurface, borderRadius: 12, marginTop: 8,
        }}>
          <div style={{ fontSize: 13, color: B.grayDark }}>Still have questions?</div>
          <a href="sms:+19413187612" style={{
            ...BUTTON_BASE, padding: '9px 18px', fontSize: 13, marginTop: 8,
            background: B.red, color: '#fff', textDecoration: 'none',
            display: 'inline-flex',
          }}>💬 Text Us</a>
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// SERVICE CATALOG — pricing & details for My Plan
// =========================================================================
const SERVICE_CATALOG = [
  {
    id: 'pest_control', name: 'Quarterly Pest Control', icon: '🐜',
    frequencies: ['Quarterly (4x)', 'Bi-Monthly (6x)', 'Monthly (12x)'],
    basePrice: 55, description: 'Interior + exterior treatment, granular perimeter band, bait station check, cobweb sweep on all eaves',
    products: ['Demand CS', 'Advion WDG Granular', 'Alpine WSG'],
  },
  {
    id: 'lawn_care', name: 'Lawn Care Program', icon: '🌱',
    frequencies: ['4x per year', '6x per year', '9x per year', '12x per year'],
    basePrice: 65, description: 'Fertilization, weed control, fungicide treatments, soil testing, thatch monitoring',
    products: ['Prodiamine 65 WDG', 'Celsius WG', '16-4-8 + Micros', 'Headway G'],
  },
  {
    id: 'mosquito', name: 'Mosquito Barrier Treatment', icon: '🦟',
    frequencies: ['Monthly (Apr–Oct)', 'Year-Round (12x)'],
    basePrice: 45, description: 'Perimeter barrier spray, standing water treatment, foliage and shrub line application',
    products: ['Cyzmic CS', 'Tekko Pro IGR'],
  },
  {
    id: 'tree_shrub', name: 'Tree & Shrub Program', icon: '🌴',
    frequencies: ['4x per year', '6x per year'],
    basePrice: 50, description: 'Deep root feeding, insect & disease treatment, palm injections (Arborjet)',
    products: ['Merit 75 WP', 'Keel Fungicide', 'Arborjet TREE-age'],
  },
  {
    id: 'termite', name: 'Termite Bait Monitoring', icon: '🪵',
    frequencies: ['Basic (annual inspection)', 'Premier (quarterly monitoring + warranty)'],
    basePrice: 35, description: 'Bait station installation, quarterly monitoring, damage warranty (Premier)',
    products: ['Sentricon Always Active', 'Trelona ATBS'],
  },
];

const ADD_ONS = [
  { id: 'palm_injection', name: 'Arborjet Palm Injection', icon: '🌴', price: 35, unit: '/palm', min: '$75/visit minimum', desc: 'Trunk-injected nutrients and pest protection for coconut, queen, and royal palms' },
  { id: 'top_dressing', name: 'Top Dressing / Dethatching', icon: '🏖️', price: 150, unit: '/service', min: 'Seasonal (fall recommended)', desc: 'Sand top-dressing to improve soil structure + mechanical dethatching when thatch exceeds 0.5"' },
  { id: 'fire_ant', name: 'Fire Ant Treatment', icon: '🔥', price: 40, unit: '/treatment', min: 'As needed', desc: 'Broadcast granular bait + individual mound drench for aggressive colonies' },
  { id: 'rodent', name: 'Rodent Bait Stations', icon: '🐀', price: 30, unit: '/month', min: 'Monthly monitoring', desc: 'Tamper-resistant exterior bait stations, monthly monitoring and reporting' },
  { id: 'wdo_inspection', name: 'WDO Inspection', icon: '📋', price: 250, unit: '', min: 'Real estate transaction?', desc: 'Wood-destroying organism inspection report for real estate closings. FL Form 13645 compliant. Includes full attic, crawl space, and exterior assessment.' },
];

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const TIER_SERVICES = { Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
const TIER_DISCOUNTS = { Bronze: 0.10, Silver: 0.15, Gold: 0.20, Platinum: 0.30 };

const TIER_SERVICE_NAMES = {
  Bronze: ['Quarterly Pest Control'],
  Silver: ['Quarterly Pest Control', 'Lawn Care Program'],
  Gold: ['Quarterly Pest Control', 'Lawn Care Program', 'Mosquito Barrier Treatment'],
  Platinum: ['Quarterly Pest Control', 'Lawn Care Program', 'Mosquito Barrier Treatment', 'Tree & Shrub Program'],
};

// Coverage details for each included service
const SERVICE_COVERAGE = {
  pest_control: { summary: 'Unlimited callbacks within 30 days. Interior re-treatment included.', details: ['Interior + exterior perimeter treatment', 'Granular bait band around foundation', 'Bait station monitoring', 'Cobweb sweep on all eaves', 'Free callback if pests return within 30 days'] },
  lawn_care: { summary: 'Fertilization, weed control, fungicide. Callbacks for breakthrough weeds.', details: ['Custom fertilization for your turf type', 'Pre-emergent and post-emergent weed control', 'Fungicide treatments as needed', 'Soil testing and thatch monitoring', 'Callback for breakthrough weeds between visits'] },
  mosquito: { summary: 'Barrier treatments Apr-Oct. Re-spray within 14 days of heavy rain.', details: ['Monthly perimeter barrier spray (Apr-Oct)', 'Standing water treatment with larvicide', 'Foliage and shrub line application', 'Free re-spray within 14 days of heavy rain', 'Event spray available on request'] },
  tree_shrub: { summary: 'Deep root feeding, insect & disease treatment, palm injections.', details: ['Deep root fertilization', 'Insect and disease treatment', 'Palm trunk injections (Arborjet)', 'Seasonal monitoring and reporting'] },
  termite: { summary: 'Bait station installation and monitoring with damage warranty.', details: ['Bait station installation around perimeter', 'Quarterly monitoring inspections', 'Damage warranty (Premier tier)', 'Annual re-certification report'] },
};

// Service schedule months for calendar view
const SERVICE_SCHEDULE_MONTHS = {
  pest_control: [0, 3, 6, 9],        // Jan, Apr, Jul, Oct (quarterly)
  lawn_care: [0, 2, 5, 8],            // Jan, Mar, Jun, Sep (4x/year)
  mosquito: [3, 4, 5, 6, 7, 8, 9],   // Apr-Oct
  tree_shrub: [1, 4, 7, 10],          // Feb, May, Aug, Nov
  termite: [0, 3, 6, 9],              // Quarterly
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Hidden badge types (engagement-tracking ones we don't show)
const HIDDEN_BADGE_TYPES = ['portal_regular', 'document_downloader', 'responsive', 'early_adopter', 'feedback_hero', 'portal_explorer'];

// =========================================================================
// MY PLAN TAB
// =========================================================================
function MyPlanTab({ customer }) {
  const [expandedService, setExpandedService] = useState(null);
  const [expandedAddon, setExpandedAddon] = useState(null);
  const [expandedCoverage, setExpandedCoverage] = useState(null);
  const [stats, setStats] = useState(null);
  const [nextService, setNextService] = useState(null);
  const [serviceHistory, setServiceHistory] = useState([]);
  const [addonRequested, setAddonRequested] = useState({});
  const [showPauseForm, setShowPauseForm] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [pauseDuration, setPauseDuration] = useState('1');
  const [pauseReason, setPauseReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelDetails, setCancelDetails] = useState('');
  const [pauseSubmitted, setPauseSubmitted] = useState(false);
  const [cancelSubmitted, setCancelSubmitted] = useState(false);
  const [upgradeRequested, setUpgradeRequested] = useState({});
  const badgeData = useBadges();

  useEffect(() => {
    api.getServiceStats().then(setStats).catch(console.error);
    api.getNextService().then(d => setNextService(d.next || null)).catch(console.error);
    api.getServices({ limit: 50 }).then(d => {
      if (d.services) setServiceHistory(d.services);
    }).catch(console.error);
  }, []);

  const tier = TIER[customer.tier];
  const tierName = customer.tier || 'Bronze';
  const tierIdx = TIER_ORDER.indexOf(tierName);
  const discount = TIER_DISCOUNTS[tierName] || 0;
  const memberMonths = customer.memberSince
    ? Math.max(1, Math.round((new Date() - parseDate(customer.memberSince)) / (1000 * 60 * 60 * 24 * 30)))
    : 0;
  const numServices = TIER_SERVICES[tierName] || 1;

  // Calculate annual savings
  const totalFullPrice = SERVICE_CATALOG.slice(0, numServices).reduce((sum, s) => sum + s.basePrice * 12, 0);
  const annualSavings = totalFullPrice * discount;
  const monthlyRate = customer.monthlyRate || 0;

  // Build bundled services one-liner
  const includedServices = SERVICE_CATALOG.slice(0, numServices);
  const bundleSummary = includedServices.map(s => s.name.replace(/ Program| Barrier Treatment| Control/g, '').replace('Quarterly ', '')).join(' + ');

  // Build plan history timeline from member data
  const planTimeline = [];
  if (customer.memberSince) {
    const startDate = parseDate(customer.memberSince);
    planTimeline.push({ date: startDate, label: `Started ${tierName} WaveGuard`, icon: '🚀' });
  }
  if (customer.activity_log) {
    customer.activity_log.forEach(a => {
      if (a.type === 'tier_change' || a.type === 'upgrade') {
        planTimeline.push({ date: parseDate(a.date), label: a.description || `Upgraded to ${a.tier || 'new tier'}`, icon: '⬆️' });
      }
      if (a.type === 'service_added') {
        planTimeline.push({ date: parseDate(a.date), label: a.description || `Added ${a.service || 'service'}`, icon: '➕' });
      }
    });
  }
  // If no activity log, construct from tier
  if (planTimeline.length === 1 && tierIdx > 0) {
    const startDate = parseDate(customer.memberSince);
    const upgradeDate = new Date(startDate);
    upgradeDate.setMonth(upgradeDate.getMonth() + Math.floor(memberMonths * 0.4));
    planTimeline.push({ date: upgradeDate, label: `Upgraded to ${tierName}`, icon: '⬆️' });
  }
  if (numServices >= 3 && planTimeline.length <= 2) {
    const startDate = parseDate(customer.memberSince);
    const addDate = new Date(startDate);
    addDate.setMonth(addDate.getMonth() + Math.floor(memberMonths * 0.6));
    planTimeline.push({ date: addDate, label: 'Added mosquito service', icon: '🦟' });
  }
  planTimeline.sort((a, b) => a.date - b.date);

  // Current month for calendar
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // Determine completed months from service history
  const getCompletedMonths = (svcId) => {
    const completed = new Set();
    serviceHistory.forEach(s => {
      const svcType = (s.serviceType || s.type || '').toLowerCase();
      const matchesService = (
        (svcId === 'pest_control' && (svcType.includes('pest') || svcType.includes('general'))) ||
        (svcId === 'lawn_care' && (svcType.includes('lawn') || svcType.includes('fertiliz'))) ||
        (svcId === 'mosquito' && svcType.includes('mosquito')) ||
        (svcId === 'tree_shrub' && (svcType.includes('tree') || svcType.includes('shrub'))) ||
        (svcId === 'termite' && svcType.includes('termite'))
      );
      if (matchesService && s.date) {
        const d = parseDate(s.date);
        if (d.getFullYear() === currentYear) {
          completed.add(d.getMonth());
        }
      }
    });
    return completed;
  };

  // Included service IDs for filtering add-ons
  const includedServiceIds = includedServices.map(s => s.id);

  // Filter add-ons that are NOT already included in the plan
  const availableAddOns = ADD_ONS.filter(addon => {
    // Map add-on IDs to service IDs they might overlap with
    const overlapMap = { palm_injection: 'tree_shrub', rodent: 'pest_control' };
    const overlaps = overlapMap[addon.id];
    // Don't filter based on overlap — just exclude exact matches
    return !includedServiceIds.includes(addon.id);
  });

  // Curated badges — filter out engagement-tracking ones
  const curatedBadges = badgeData.data?.badges?.filter(b =>
    !HIDDEN_BADGE_TYPES.includes(b.badgeType)
  ) || [];
  const recentEarnedBadges = curatedBadges
    .filter(b => b.earned)
    .sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt))
    .slice(0, 4);

  const Card = ({ children, style: s }) => (
    <div style={{ background: B.white, borderRadius: 16, padding: 20, border: `1px solid ${B.grayLight}`, ...s }}>{children}</div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Section 1 — Plan Summary Hero Card */}
      <div style={{
        background: `linear-gradient(135deg, ${tier?.gradientFrom || B.navy}, ${tier?.gradientTo || B.navyLight})`,
        borderRadius: 20, padding: '28px 24px', color: tier?.darkText ? B.navy : '#fff',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: -30, right: -30, fontSize: 120, opacity: 0.1 }}>🛡️</div>
        <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.5, opacity: 0.8 }}>Your Plan</div>
        <div style={{ fontSize: 32, fontWeight: 900, fontFamily: FONTS.heading, marginTop: 4 }}>
          {tierName} WaveGuard
        </div>

        {/* Bundled services one-liner */}
        <div style={{
          fontSize: 13, fontWeight: 600, marginTop: 6, opacity: 0.9,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {bundleSummary} — {numServices} service{numServices > 1 ? 's' : ''} bundled
        </div>

        {/* Next service date */}
        {nextService && (
          <div style={{
            marginTop: 10, padding: '8px 14px', borderRadius: 10,
            background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(4px)',
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontSize: 13, fontWeight: 600,
          }}>
            <span style={{ fontSize: 16 }}>📅</span>
            Next visit: {parseDate(nextService.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
            {nextService.serviceType ? ` (${nextService.serviceType})` : ''}
          </div>
        )}

        <div style={{ display: 'flex', gap: 20, marginTop: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: tier?.darkText ? B.grayMid : B.blueLight }}>Monthly Rate</div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: FONTS.ui }}>${monthlyRate}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: tier?.darkText ? B.grayMid : B.blueLight }}>Bundle Discount</div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: FONTS.ui }}>{Math.round(discount * 100)}%</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: tier?.darkText ? B.grayMid : B.blueLight }}>Member Since</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{customer.memberSince ? parseDate(customer.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: tier?.darkText ? B.grayMid : B.blueLight }}>Loyalty</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{memberMonths} months</div>
          </div>
        </div>

        {/* Recent badges strip */}
        {recentEarnedBadges.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 16 }}>
            {recentEarnedBadges.map(b => (
              <div key={b.badgeType} title={b.title} style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(4px)',
                border: '1.5px solid rgba(255,255,255,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15,
              }}>{b.icon}</div>
            ))}
          </div>
        )}
      </div>

      {/* Section 2 — Included Services Breakdown */}
      <SectionHeading>Your Included Services</SectionHeading>
      <div style={{ fontSize: 13, color: B.grayMid }}>{tierName} includes {numServices} recurring service{numServices > 1 ? 's' : ''}</div>

      {includedServices.map(svc => {
        const completedMonths = getCompletedMonths(svc.id);
        const scheduleMonths = SERVICE_SCHEDULE_MONTHS[svc.id] || [];
        const totalVisits = scheduleMonths.length;
        const completedVisits = scheduleMonths.filter(m => completedMonths.has(m)).length;
        const annualSavingsForService = svc.basePrice * 12 * discount;
        const coverage = SERVICE_COVERAGE[svc.id];

        return (
          <Card key={svc.id}>
            <div onClick={() => setExpandedService(expandedService === svc.id ? null : svc.id)}
              style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 28 }}>{svc.icon}</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{svc.name}</div>
                  <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>{svc.frequencies[0]}</div>
                  {/* Service cycle tracker */}
                  <div style={{ fontSize: 11, color: B.wavesBlue, fontWeight: 600, marginTop: 3 }}>
                    {completedVisits} of {totalVisits} visits completed this year
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: B.grayMid, textDecoration: 'line-through' }}>${svc.basePrice * 12}/yr</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: B.green, fontFamily: FONTS.ui }}>
                  ${annualSavingsForService > 0 ? `${annualSavingsForService.toFixed(0)}/yr saved` : `${svc.basePrice * 12}/yr`}
                </div>
              </div>
            </div>

            {/* Cycle progress bar */}
            <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: B.grayLight, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2, background: B.wavesBlue,
                width: `${totalVisits > 0 ? (completedVisits / totalVisits) * 100 : 0}%`,
                transition: 'width 0.6s ease-out',
              }} />
            </div>

            {expandedService === svc.id && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${B.grayLight}` }}>
                <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.7 }}>{svc.description}</div>
                <div style={{ marginTop: 12, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: B.grayMid }}>Products Used</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {svc.products.map((p, i) => (
                    <span key={i} style={{
                      padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                      background: `${B.wavesBlue}12`, color: B.wavesBlue, border: `1px solid ${B.wavesBlue}22`,
                    }}>{p}</span>
                  ))}
                </div>
                <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 10, background: '#E8F5E9', fontSize: 12, color: B.green, fontWeight: 600 }}>
                  💰 You save ${annualSavingsForService.toFixed(0)}/year on {svc.name} with your {tierName} discount
                </div>

                {/* What's Covered — collapsible */}
                {coverage && (
                  <div style={{ marginTop: 12 }}>
                    <div
                      onClick={(e) => { e.stopPropagation(); setExpandedCoverage(expandedCoverage === svc.id ? null : svc.id); }}
                      style={{
                        cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '10px 14px', borderRadius: 10, background: `${B.wavesBlue}08`,
                        border: `1px solid ${B.wavesBlue}18`,
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700, color: B.wavesBlue }}>What's Covered</span>
                      <span style={{ fontSize: 12, color: B.wavesBlue, transform: expandedCoverage === svc.id ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
                    </div>
                    {expandedCoverage === svc.id && (
                      <div style={{ padding: '12px 14px', borderRadius: '0 0 10px 10px', background: `${B.wavesBlue}05`, borderTop: 'none' }}>
                        <div style={{ fontSize: 12, color: B.grayDark, fontWeight: 600, marginBottom: 8 }}>{coverage.summary}</div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {coverage.details.map((d, i) => (
                            <li key={i} style={{ fontSize: 12, color: B.grayDark, lineHeight: 1.8 }}>{d}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}

      {/* Section — Service Calendar (Year-at-a-Glance) */}
      <SectionHeading>Service Calendar</SectionHeading>
      <Card>
        <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 14 }}>Your {currentYear} service schedule at a glance</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {includedServices.map(svc => {
            const scheduleMonths = SERVICE_SCHEDULE_MONTHS[svc.id] || [];
            const completedMonths = getCompletedMonths(svc.id);
            return (
              <div key={svc.id}>
                <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 6 }}>
                  {svc.icon} {svc.name.replace(/ Program| Barrier Treatment/g, '')}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {MONTH_LABELS.map((month, mi) => {
                    const isScheduled = scheduleMonths.includes(mi);
                    const isCompleted = completedMonths.has(mi);
                    const isCurrentMonth = mi === currentMonth;
                    const isPast = mi < currentMonth;
                    // Determine dot state
                    let dotColor = B.grayLight;
                    let dotBorder = B.grayLight;
                    let dotFill = 'transparent';
                    let label = '';
                    if (!isScheduled) {
                      dotColor = B.grayLight;
                      dotFill = 'transparent';
                      dotBorder = B.grayLight;
                    } else if (isCompleted) {
                      dotColor = B.green;
                      dotFill = B.green;
                      dotBorder = B.green;
                      label = 'Completed';
                    } else if (isCurrentMonth) {
                      dotColor = B.wavesBlue;
                      dotFill = B.wavesBlue;
                      dotBorder = B.wavesBlue;
                      label = 'This month';
                    } else if (isPast && isScheduled) {
                      dotColor = B.orange;
                      dotFill = B.orange;
                      dotBorder = B.orange;
                      label = 'Missed/Pending';
                    } else {
                      dotColor = B.grayMid;
                      dotFill = 'transparent';
                      dotBorder = B.grayMid;
                      label = 'Upcoming';
                    }
                    return (
                      <div key={mi} title={isScheduled ? `${month}: ${label}` : `${month}: No service`} style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', width: 28,
                      }}>
                        <div style={{
                          width: 14, height: 14, borderRadius: '50%',
                          background: dotFill,
                          border: `2px solid ${dotBorder}`,
                          opacity: isScheduled ? 1 : 0.3,
                          transition: 'all 0.2s',
                          boxShadow: isCurrentMonth && isScheduled ? `0 0 0 3px ${B.wavesBlue}30` : 'none',
                        }} />
                        <div style={{ fontSize: 9, color: B.grayMid, marginTop: 2, fontWeight: isCurrentMonth ? 700 : 400 }}>{month.slice(0, 1)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {/* Legend */}
        <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap' }}>
          {[
            { color: B.green, fill: true, label: 'Completed' },
            { color: B.wavesBlue, fill: true, label: 'This Month' },
            { color: B.grayMid, fill: false, label: 'Upcoming' },
          ].map(l => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: l.fill ? l.color : 'transparent', border: `2px solid ${l.color}` }} />
              <span style={{ fontSize: 10, color: B.grayMid }}>{l.label}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Section 3 — Available Add-Ons */}
      <SectionHeading>Available Add-Ons</SectionHeading>
      <div style={{ fontSize: 13, color: B.grayMid }}>Enhance your plan — your {Math.round(discount * 100)}% {tierName} discount applies</div>

      {availableAddOns.map(addon => (
        <Card key={addon.id}>
          <div onClick={() => setExpandedAddon(expandedAddon === addon.id ? null : addon.id)}
            style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 24 }}>{addon.icon}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{addon.name}</div>
                <div style={{ fontSize: 12, color: B.grayMid }}>{addon.min}</div>
              </div>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui }}>
              ${discount > 0 && addon.id !== 'wdo_inspection' ? (addon.price * (1 - discount)).toFixed(0) : addon.price}{addon.unit}
            </div>
          </div>
          {expandedAddon === addon.id && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${B.grayLight}` }}>
              <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.7 }}>{addon.desc}</div>
              {discount > 0 && addon.id !== 'wdo_inspection' && (
                <div style={{ fontSize: 12, color: B.green, fontWeight: 600, marginTop: 8 }}>
                  Your price: ${(addon.price * (1 - discount)).toFixed(2)}{addon.unit} (was ${addon.price}{addon.unit})
                </div>
              )}
              {addonRequested[addon.id] ? (
                <div style={{
                  marginTop: 12, padding: '10px 18px', borderRadius: 12, fontSize: 13,
                  background: '#E8F5E9', color: B.green, fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ fontSize: 16 }}>✓</span>
                  Request sent — we'll call to confirm
                </div>
              ) : (
                <button onClick={() => {
                  api.createRequest?.({ category: 'add_service', subject: `Add ${addon.name} to my plan`, description: `Customer requested to add ${addon.name} via portal.` });
                  setAddonRequested(prev => ({ ...prev, [addon.id]: true }));
                  setExpandedAddon(null);
                }} style={{
                  ...BUTTON_BASE, marginTop: 12, padding: '9px 18px', fontSize: 13,
                  background: B.red, color: '#fff',
                }}>Add to My Plan</button>
              )}
            </div>
          )}
        </Card>
      ))}

      {/* Section 4 — Tier Comparison */}
      <SectionHeading>Compare WaveGuard Tiers</SectionHeading>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div style={{ display: 'flex', gap: 12, minWidth: 600, paddingBottom: 4 }}>
          {TIER_ORDER.map((tn, i) => {
            const t = TIER[tn];
            const isCurrent = tn === tierName;
            const disc = TIER_DISCOUNTS[tn];
            const svcs = TIER_SERVICES[tn];
            const tierServiceNames = TIER_SERVICE_NAMES[tn] || [];
            // Estimate monthly cost for this tier
            const tierMonthly = SERVICE_CATALOG.slice(0, svcs).reduce((sum, s) => sum + s.basePrice * (1 - disc), 0);
            return (
              <div key={tn} style={{
                flex: 1, minWidth: 140, borderRadius: 14, padding: 16, textAlign: 'center',
                border: isCurrent ? `2px solid ${t.color}` : `1px solid ${B.grayLight}`,
                background: isCurrent ? `${t.color}12` : B.white,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10, margin: '0 auto 8px',
                  background: `linear-gradient(135deg, ${t.gradientFrom}, ${t.gradientTo})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18,
                }}>🛡️</div>
                <div style={{ fontSize: 14, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>{tn}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: B.navy, fontFamily: FONTS.ui, marginTop: 4 }}>{Math.round(disc * 100)}%</div>
                <div style={{ fontSize: 11, color: B.grayMid }}>discount</div>

                {/* Estimated monthly cost */}
                <div style={{ fontSize: 13, fontWeight: 700, color: B.wavesBlue, fontFamily: FONTS.ui, marginTop: 6 }}>
                  ~${tierMonthly.toFixed(0)}/mo
                </div>

                {/* Service names list */}
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {tierServiceNames.map((sn, si) => (
                    <div key={si} style={{ fontSize: 10, color: B.grayDark, lineHeight: 1.4 }}>{sn}</div>
                  ))}
                </div>

                {isCurrent ? (
                  <div style={{ marginTop: 10, fontSize: 11, fontWeight: 700, color: B.green, background: '#E8F5E9', padding: '4px 10px', borderRadius: 20 }}>Current Plan</div>
                ) : i > tierIdx ? (
                  upgradeRequested[tn] ? (
                    <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: B.green, padding: '4px 10px' }}>
                      ✓ Request sent
                    </div>
                  ) : (
                    <button onClick={() => {
                      api.createRequest?.({ category: 'billing', subject: `Upgrade to ${tn} WaveGuard`, description: `Customer requested tier upgrade from ${tierName} to ${tn}.` });
                      setUpgradeRequested(prev => ({ ...prev, [tn]: true }));
                    }} style={{
                      ...BUTTON_BASE, marginTop: 10, padding: '4px 12px', fontSize: 11,
                      background: B.red, color: '#fff',
                    }}>Upgrade</button>
                  )
                ) : (
                  <a href="sms:+19413187612?body=Hi Waves, I'd like to discuss adjusting my WaveGuard plan." style={{
                    marginTop: 10, display: 'inline-block', fontSize: 10, color: B.wavesBlue,
                    fontWeight: 600, textDecoration: 'none', padding: '4px 0',
                  }}>Contact us to adjust</a>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 5 — Annual Savings Summary */}
      <Card style={{ background: `linear-gradient(135deg, ${B.green}12, #E8F5E9)`, border: `1.5px solid ${B.green}33` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <span style={{ fontSize: 32 }}>💰</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>Your Annual Savings</div>
            <div style={{ fontSize: 12, color: B.grayMid }}>With your {tierName} WaveGuard bundle</div>
          </div>
        </div>
        <div style={{ fontSize: 36, fontWeight: 700, color: B.green, fontFamily: FONTS.ui }}>
          ${annualSavings.toFixed(0)}<span style={{ fontSize: 16 }}>/year</span>
        </div>
        <div style={{ fontSize: 13, color: B.grayDark, marginTop: 8, lineHeight: 1.6 }}>
          Full price for {numServices} service{numServices > 1 ? 's' : ''}: <strong>${totalFullPrice.toFixed(0)}/yr</strong><br/>
          Your {Math.round(discount * 100)}% bundle rate: <strong>${(totalFullPrice - annualSavings).toFixed(0)}/yr</strong><br/>
          You keep <strong style={{ color: B.green }}>${annualSavings.toFixed(0)}</strong> in your pocket.
        </div>
      </Card>

      {/* Section 6 — Plan History Timeline */}
      <Card>
        <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 16 }}>Plan History</div>
        <div style={{ position: 'relative', paddingLeft: 28 }}>
          {/* Vertical line */}
          <div style={{
            position: 'absolute', left: 9, top: 4, bottom: 4, width: 2,
            background: `linear-gradient(to bottom, ${B.wavesBlue}, ${B.grayLight})`,
            borderRadius: 1,
          }} />
          {planTimeline.map((event, idx) => (
            <div key={idx} style={{
              position: 'relative', paddingBottom: idx < planTimeline.length - 1 ? 20 : 0,
              display: 'flex', flexDirection: 'column',
            }}>
              {/* Dot on timeline */}
              <div style={{
                position: 'absolute', left: -23, top: 2,
                width: 14, height: 14, borderRadius: '50%',
                background: idx === planTimeline.length - 1 ? B.wavesBlue : B.white,
                border: `2.5px solid ${idx === planTimeline.length - 1 ? B.wavesBlue : B.blueLight}`,
                zIndex: 1,
              }} />
              <div style={{ fontSize: 11, color: B.grayMid, fontWeight: 600 }}>
                {!isNaN(event.date) ? event.date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.navy, marginTop: 2 }}>
                {event.icon} {event.label}
              </div>
            </div>
          ))}
          {/* Current status */}
          <div style={{ position: 'relative', paddingTop: planTimeline.length > 0 ? 0 : 0 }}>
            <div style={{
              position: 'absolute', left: -25, top: 2,
              width: 18, height: 18, borderRadius: '50%',
              background: B.green, border: `3px solid #E8F5E9`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1,
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />
            </div>
            <div style={{ paddingTop: planTimeline.length > 0 ? 20 : 0 }}>
              <div style={{ fontSize: 11, color: B.grayMid, fontWeight: 600 }}>Now</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.green, marginTop: 2 }}>
                Active — {tierName} WaveGuard · No contract
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Badge Showcase — curated */}
      {!badgeData.loading && badgeData.data && curatedBadges.length > 0 && (
        <>
          <div style={{ marginTop: 8 }} />
          <BadgeShowcase
            badges={curatedBadges}
            categories={badgeData.data.categories}
          />
        </>
      )}

      {/* Section — Pause / Cancel Controls */}
      <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
        {!showPauseForm && !showCancelForm && !pauseSubmitted && !cancelSubmitted && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, alignItems: 'center' }}>
            <button onClick={() => setShowPauseForm(true)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: B.grayMid, fontWeight: 600, fontFamily: FONTS.body,
              textDecoration: 'underline', textUnderlineOffset: 3, padding: '4px 8px',
            }}>Pause My Plan</button>
            <span style={{ color: B.grayLight }}>|</span>
            <button onClick={() => setShowCancelForm(true)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: B.grayMid, fontWeight: 500, fontFamily: FONTS.body,
              textDecoration: 'underline', textUnderlineOffset: 3, padding: '4px 8px',
            }}>Cancel</button>
          </div>
        )}

        {/* Pause Form */}
        {showPauseForm && !pauseSubmitted && (
          <Card style={{ textAlign: 'left', border: `1px solid ${B.orange}33` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 12 }}>Pause My Plan</div>
            <div style={{ fontSize: 12, color: B.grayDark, marginBottom: 12 }}>
              We'll hold your services and billing. Your spot stays reserved.
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Duration</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {['1', '2'].map(d => (
                  <button key={d} onClick={() => setPauseDuration(d)} style={{
                    padding: '8px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                    border: `1.5px solid ${pauseDuration === d ? B.wavesBlue : B.grayLight}`,
                    background: pauseDuration === d ? `${B.wavesBlue}12` : B.white,
                    color: pauseDuration === d ? B.wavesBlue : B.grayMid,
                    cursor: 'pointer', fontFamily: FONTS.body,
                  }}>{d} month{d === '2' ? 's' : ''}</button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Reason (optional)</div>
              <input
                value={pauseReason}
                onChange={e => setPauseReason(e.target.value)}
                placeholder="Traveling, seasonal, etc."
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 10, fontSize: 13,
                  border: `1px solid ${B.grayLight}`, fontFamily: FONTS.body, outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => {
                api.createRequest?.({
                  category: 'billing',
                  subject: `Pause plan for ${pauseDuration} month(s)`,
                  description: `Customer requested to pause their ${tierName} WaveGuard plan for ${pauseDuration} month(s). Reason: ${pauseReason || 'Not specified'}`,
                });
                setPauseSubmitted(true);
                setShowPauseForm(false);
              }} style={{
                ...BUTTON_BASE, padding: '9px 18px', fontSize: 13,
                background: B.orange, color: '#fff',
              }}>Submit Pause Request</button>
              <button onClick={() => setShowPauseForm(false)} style={{
                ...BUTTON_BASE, padding: '9px 18px', fontSize: 13,
                background: B.offWhite, color: B.grayDark, border: `1px solid ${B.grayLight}`,
              }}>Never mind</button>
            </div>
          </Card>
        )}

        {pauseSubmitted && (
          <div style={{ padding: '12px 18px', borderRadius: 12, background: '#E8F5E9', fontSize: 13, color: B.green, fontWeight: 600 }}>
            ✓ Pause request submitted — we'll confirm within 1 business day.
          </div>
        )}

        {/* Cancel Form */}
        {showCancelForm && !cancelSubmitted && (
          <Card style={{ textAlign: 'left', border: `1px solid ${B.red}33` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>We're sorry to see you go</div>
            <div style={{ fontSize: 12, color: B.grayDark, marginBottom: 14 }}>
              Before you cancel, would you consider pausing instead? Your discount and spot stay reserved.
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Tell us why</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['Moving', 'Cost', 'Not satisfied', 'Switching providers', 'Other'].map(r => (
                  <button key={r} onClick={() => setCancelReason(r)} style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    border: `1.5px solid ${cancelReason === r ? B.red : B.grayLight}`,
                    background: cancelReason === r ? `${B.red}10` : B.white,
                    color: cancelReason === r ? B.red : B.grayMid,
                    cursor: 'pointer', fontFamily: FONTS.body,
                  }}>{r}</button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <textarea
                value={cancelDetails}
                onChange={e => setCancelDetails(e.target.value)}
                placeholder="Anything else you'd like us to know?"
                rows={3}
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 10, fontSize: 13,
                  border: `1px solid ${B.grayLight}`, fontFamily: FONTS.body, outline: 'none',
                  resize: 'vertical', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => {
                api.createRequest?.({
                  category: 'cancellation',
                  subject: `Cancel ${tierName} WaveGuard plan`,
                  description: `Customer requested cancellation. Reason: ${cancelReason || 'Not specified'}. Details: ${cancelDetails || 'None'}`,
                });
                setCancelSubmitted(true);
                setShowCancelForm(false);
              }} style={{
                ...BUTTON_BASE, padding: '9px 18px', fontSize: 13,
                background: B.grayMid, color: '#fff',
              }}>Submit Cancellation Request</button>
              <button onClick={() => setShowCancelForm(false)} style={{
                ...BUTTON_BASE, padding: '9px 18px', fontSize: 13,
                background: B.offWhite, color: B.grayDark, border: `1px solid ${B.grayLight}`,
              }}>Keep My Plan</button>
            </div>
          </Card>
        )}

        {cancelSubmitted && (
          <div style={{ padding: '12px 18px', borderRadius: 12, background: `${B.grayMid}15`, fontSize: 13, color: B.grayDark, fontWeight: 600 }}>
            ✓ Cancellation request received — we'll reach out to finalize.
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// WAVES SERVICE TRACKER — Domino's-style real-time tracker
// =========================================================================
function ServiceTracker() {
  const [tracker, setTracker] = useState(null);
  const [loading, setLoading] = useState(true);
  const [demoNote, setDemoNote] = useState('');
  const [propertyPrefs, setPropertyPrefs] = useState(null);
  const [weather, setWeather] = useState(null);
  const [showExpect, setShowExpect] = useState(false);

  const fetchTracker = useCallback(() => {
    api.getActiveTracker()
      .then(d => { setTracker(d.tracker); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.getTodayTracker()
      .then(d => { setTracker(d.tracker); setLoading(false); })
      .catch(() => fetchTracker());
    api.getPropertyPreferences().then(d => setPropertyPrefs(d.preferences)).catch(() => {});
    api.getWeather().then(setWeather).catch(() => {});
  }, [fetchTracker]);

  useEffect(() => {
    if (!tracker || tracker.currentStep <= 1 || tracker.currentStep >= 7) return;
    const interval = setInterval(fetchTracker, 15000);
    return () => clearInterval(interval);
  }, [tracker?.currentStep, fetchTracker]);

  const handleAdvance = async () => {
    try { const r = await api.advanceTrackerDemo(); setTracker(r.tracker); } catch (e) { console.error(e); }
  };
  const handleAddNote = async () => {
    if (!demoNote.trim() || !tracker) return;
    await api.addTrackerNote(tracker.id, demoNote.trim());
    setDemoNote('');
    fetchTracker();
  };

  if (loading || !tracker) return null;

  const step = tracker.currentStep;
  const techName = tracker.technician?.name || 'Your tech';
  const techFirst = techName.split(' ')[0];
  const techInitials = tracker.technician?.initials || '?';
  const svcType = tracker.service?.type || 'Service';
  const eta = tracker.etaMinutes;
  const notes = tracker.liveNotes || [];
  const summary = tracker.serviceSummary;
  const office = tracker.office || { name: 'Waves Pest Control', phone: '(941) 318-7612', area: 'Southwest Florida' };
  const isLawn = svcType.toLowerCase().includes('lawn');
  const isPest = svcType.toLowerCase().includes('pest');
  const isMosquito = svcType.toLowerCase().includes('mosquito');
  const isTermite = svcType.toLowerCase().includes('termite');

  const STEPS = [
    { num: 1, label: 'SCHEDULED' },
    { num: 2, label: 'CONFIRMED' },
    { num: 3, label: 'EN ROUTE' },
    { num: 4, label: 'ON-SITE' },
    { num: 5, label: 'IN PROGRESS' },
    { num: 6, label: 'WRAPPING UP' },
    { num: 7, label: 'COMPLETE' },
  ];

  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const window = tracker.service?.windowStart ? `${fmtTime(tracker.service.windowStart)} – ${fmtTime(tracker.service.windowEnd)}` : 'today';
  const stepTs = tracker.steps[step - 1]?.completedAt;

  // Estimated completion
  const avgDurations = { lawn: 45, pest: 35, mosquito: 25, termite: 60 };
  const svcDuration = isLawn ? avgDurations.lawn : isPest ? avgDurations.pest : isMosquito ? avgDurations.mosquito : isTermite ? avgDurations.termite : 40;
  const estComplete = step >= 4 && step < 7 && tracker.steps[3]?.completedAt
    ? new Date(new Date(tracker.steps[3].completedAt).getTime() + svcDuration * 60000)
    : null;

  const whatToExpect = isPest
    ? 'Your tech will treat the exterior perimeter with a liquid barrier, apply granular product to landscaping beds, check all bait stations, sweep cobwebs from eaves, and treat interior baseboards and entry points.'
    : isLawn
    ? "Your tech will inspect your turf for disease, weeds, and insects, apply fertilizer or herbicide based on your lawn's current program schedule, take soil/thatch measurements, and document any recommendations."
    : isMosquito
    ? 'Your tech will apply a barrier treatment to all foliage, fence lines, and standing water areas around your property perimeter, including the lanai area.'
    : isTermite
    ? 'Your tech will inspect all bait stations, check for evidence of termite activity, and document findings. Any active stations will be serviced.'
    : 'Your tech will perform a thorough treatment of your property based on your service plan.';

  return (
    <div style={{ borderRadius: 20, overflow: 'hidden', boxShadow: '0 4px 30px rgba(0,0,0,0.12)' }}>
      <style>{`
        @keyframes active-pulse { 0%,100%{opacity:.92;box-shadow:0 0 10px rgba(168,59,52,.3)} 50%{opacity:1;box-shadow:0 0 22px rgba(168,59,52,.5)} }
      `}</style>

      {/* Header */}
      <div style={{
        background: `linear-gradient(135deg, #0D47A1, ${B.blueDark})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, #0D47A1, ${B.blueDark})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        padding: '16px 20px 24px', position: 'relative',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/waves-logo.png" alt="" style={{ height: 22, width: 'auto', opacity: 0.9 }} />
          <div style={{ fontSize: 20, fontWeight: 900, color: '#fff', fontFamily: FONTS.heading, letterSpacing: 2, textShadow: '0 2px 4px rgba(0,0,0,0.2)' }}>
            WAVES SERVICE TRACKER
          </div>
        </div>
        {/* Weather badge */}
        {weather && (
          <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, fontFamily: FONTS.ui, textAlign: 'right' }}>
            {weather.forecast?.toLowerCase().includes('rain') ? '🌧️' : weather.temp >= 85 ? '☀️' : '⛅'} {weather.temp}°F
            {weather.forecast?.toLowerCase().includes('rain') && (
              <div style={{ fontSize: 9, color: B.blueLight, marginTop: 2 }}>Rain possible — tech may adjust timing</div>
            )}
          </div>
        )}
        {/* Wave bottom */}
        <div style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 16, background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 60'%3E%3Cpath d='M0,15 C200,45 400,0 600,25 C800,50 1000,5 1200,20 L1200,60 L0,60Z' fill='%231565C0'/%3E%3C/svg%3E") no-repeat bottom`, backgroundSize: '100% 100%' }} />
      </div>

      {/* Chevron tracker bar */}
      <div style={{ background: `linear-gradient(180deg, ${B.blueDark}, #1976D2)`, padding: '12px 8px 18px' }}>
        <div style={{ display: 'flex', position: 'relative' }}>
          {STEPS.map((s, i) => {
            const isComplete = i + 1 < step;
            const isCurrent = i + 1 === step;
            const isFuture = i + 1 > step;
            const isFirst = i === 0;
            const isLast = i === 6;
            const chevronW = 10;

            const bg = isComplete ? `linear-gradient(135deg, ${B.wavesBlue}, #64B5F6)` : isCurrent ? B.red : 'rgba(255,255,255,0.08)';

            return (
              <div key={s.num} style={{
                flex: 1, position: 'relative',
                height: isCurrent ? 56 : 48,
                marginTop: isCurrent ? -4 : 0,
                zIndex: isCurrent ? 10 : 7 - i,
                transition: 'all 0.4s ease',
              }}>
                {/* Chevron shape via SVG */}
                <svg viewBox="0 0 100 48" preserveAspectRatio="none" style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  filter: isCurrent ? 'drop-shadow(0 4px 8px rgba(168,59,52,0.4))' : 'none',
                }}>
                  <defs>
                    {isComplete && <linearGradient id={`grad-${i}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={B.wavesBlue}/><stop offset="100%" stopColor="#64B5F6"/></linearGradient>}
                  </defs>
                  <path
                    d={isFirst
                      ? `M0,0 L${100 - chevronW},0 L100,24 L${100 - chevronW},48 L0,48 Z`
                      : isLast
                        ? `M0,0 L100,0 L100,48 L0,48 L${chevronW},24 Z`
                        : `M0,0 L${100 - chevronW},0 L100,24 L${100 - chevronW},48 L0,48 L${chevronW},24 Z`
                    }
                    fill={isComplete ? `url(#grad-${i})` : isCurrent ? B.red : 'rgba(255,255,255,0.08)'}
                    stroke="rgba(0,0,0,0.1)"
                    strokeWidth="0.5"
                  />
                </svg>

                {/* Content */}
                <div style={{
                  position: 'relative', zIndex: 2, height: '100%',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  animation: isCurrent ? 'active-pulse 2s ease-in-out infinite' : 'none',
                }}>
                  <div style={{
                    fontSize: isCurrent ? 22 : 18, fontWeight: 900,
                    color: '#fff', fontFamily: FONTS.ui, lineHeight: 1,
                    textShadow: isCurrent ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
                  }}>{isComplete ? '✓' : s.num}</div>
                  <div style={{
                    fontSize: 6, fontWeight: 700, marginTop: 2,
                    color: isCurrent ? B.yellow : isFuture ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)',
                    fontFamily: FONTS.heading, letterSpacing: 0.3,
                    display: isCurrent ? 'block' : 'none',
                  }}>{s.label}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Labels below */}
        <div style={{ display: 'flex', marginTop: 6, padding: '0 4px' }}>
          {STEPS.map((s, i) => {
            const isComplete = i + 1 < step;
            const isCurrent = i + 1 === step;
            const isFuture = i + 1 > step;
            return (
              <div key={s.num} style={{
                flex: 1, textAlign: 'center',
                fontSize: 7, fontWeight: isCurrent ? 800 : 600,
                fontFamily: FONTS.ui, textTransform: 'uppercase', letterSpacing: 0.8,
                color: isCurrent ? B.yellow : isComplete ? '#fff' : 'rgba(255,255,255,0.35)',
              }}>{s.label}</div>
            );
          })}
        </div>
      </div>

      {/* Wave divider */}
      <div style={{ height: 14, background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 60'%3E%3Cpath d='M0,0 L0,25 C200,50 400,5 600,25 C800,45 1000,5 1200,25 L1200,0Z' fill='%231976D2'/%3E%3C/svg%3E") no-repeat top`, backgroundSize: '100% 100%', backgroundColor: B.blueSurface }} />

      {/* Content */}
      <div style={{ background: B.blueSurface, padding: '4px 16px 16px' }}>
        {/* Status */}
        <div style={{
          padding: '16px 18px', borderRadius: 14,
          background: step === 7 ? '#E8F5E9' : B.white,
          border: `1px solid ${step === 7 ? B.green + '33' : B.bluePale}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          {/* Date badge */}
          <div style={{
            width: 48, height: 52, borderRadius: 10, flexShrink: 0,
            background: step === 7 ? B.green : B.red,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            color: '#fff', boxShadow: `0 2px 8px ${step === 7 ? B.green : B.red}40`,
          }}>
            <div style={{ fontSize: 20, fontWeight: 900, fontFamily: FONTS.ui, lineHeight: 1 }}>
              {new Date().getDate()}
            </div>
            <div style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 }}>
              {new Date().toLocaleDateString('en-US', { month: 'short' })}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, lineHeight: 1.3 }}>
              {svcType}
            </div>
            <div style={{ fontSize: 13, color: B.grayDark, marginTop: 3, lineHeight: 1.4 }}>
              {step === 7 ? 'Service complete!' : step === 3 ? `${techName} is on the way${eta ? ` — ~${eta} min` : ''}` : step >= 4 ? `${techName} is on your property` : `Scheduled for ${window}`}
              {estComplete && step >= 4 && step < 7 && (
                <span style={{ color: B.wavesBlue, fontWeight: 600 }}> · Est. done ~{estComplete.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
              )}
            </div>
            {stepTs && (
              <div style={{ fontSize: 12, color: '#90A4AE', marginTop: 3 }}>
                {techName} · {new Date(stepTs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </div>
            )}
          </div>
        </div>

        {/* Two columns */}
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          {/* Left */}
          <div style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* ETA */}
            {step === 3 && eta && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 12, background: B.white, border: `1px solid ${B.bluePale}` }}>
                <span style={{ fontSize: 22 }}>🚐</span>
                <div style={{ flex: 1 }}><div style={{ height: 6, borderRadius: 3, background: B.grayLight, overflow: 'hidden' }}><div style={{ height: '100%', borderRadius: 3, background: `linear-gradient(90deg, ${B.wavesBlue}, ${B.green})`, width: `${Math.max(10, 100 - eta * 3)}%`, transition: 'width 1s ease' }} /></div></div>
                <span style={{ fontSize: 18, fontWeight: 900, color: B.navy, fontFamily: FONTS.ui }}>~{eta}m</span>
              </div>
            )}

            {/* Tech card */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 12, background: B.white, border: `1px solid ${B.bluePale}` }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`,
                border: `2.5px solid ${B.yellow}`,
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading, flexShrink: 0,
              }}>{techInitials}</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{techName}</div>
                <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 10, background: B.yellow, color: '#1E1E2B', fontFamily: FONTS.ui, marginTop: 2 }}>{svcType}</span>
              </div>
            </div>

            {/* Live notes */}
            {notes.length > 0 && (
              <div style={{ padding: '12px 14px', borderRadius: 12, background: B.white, border: `1px solid ${B.bluePale}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: B.wavesBlue, fontFamily: FONTS.ui, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Live Updates</div>
                {notes.map((n, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: i < notes.length - 1 ? 8 : 0 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 10, flexShrink: 0 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: B.wavesBlue }} />
                      {i < notes.length - 1 && <div style={{ width: 2, flex: 1, background: B.bluePale, marginTop: 2 }} />}
                    </div>
                    <div><div style={{ fontSize: 12, color: B.navy, fontWeight: 500, lineHeight: 1.4 }}>{n.note}</div><div style={{ fontSize: 10, color: '#90A4AE' }}>{new Date(n.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right */}
          <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Office card */}
            <div style={{ padding: '12px 14px', borderRadius: 12, background: B.white, border: `1px solid ${B.bluePale}` }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>{office.name}</div>
              <div style={{ fontSize: 12, color: B.grayDark, marginBottom: 8 }}>{office.area}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <a href={`tel:${office.phone.replace(/\D/g, '')}`} style={{ ...BUTTON_BASE, flex: 1, padding: '7px 10px', fontSize: 11, background: B.red, color: '#fff', textDecoration: 'none' }}>📞 Call</a>
                <a href={`sms:${office.phone.replace(/\D/g, '')}`} style={{ ...BUTTON_BASE, flex: 1, padding: '7px 10px', fontSize: 11, background: B.wavesBlue, color: '#fff', textDecoration: 'none' }}>💬 Text</a>
              </div>
              <div style={{ fontSize: 10, color: '#90A4AE', marginTop: 6 }}>Mon-Fri 7AM-5PM · Sat 8AM-12PM</div>
            </div>

            {/* Pre-arrival checklist */}
            {step < 5 && (
              <div style={{ padding: '12px 14px', borderRadius: 12, background: B.white, border: `1px solid ${B.bluePale}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 8 }}>Before Your Tech Arrives</div>
                {[
                  propertyPrefs?.neighborhoodGateCode || propertyPrefs?.propertyGateCode
                    ? { icon: '✅', text: 'Gate code on file — your tech has it', ok: true }
                    : { icon: '⚠️', text: 'No gate code on file — update Property Preferences', ok: false },
                  propertyPrefs?.petCount > 0 && propertyPrefs?.petSecuredPlan
                    ? { icon: '✅', text: `Pet plan: ${propertyPrefs.petSecuredPlan.slice(0, 60)}${propertyPrefs.petSecuredPlan.length > 60 ? '...' : ''}`, ok: true }
                    : { icon: '⚠️', text: 'Got pets? Secure them before tech arrives', ok: false },
                  { icon: '🔓', text: 'Ensure gates are unlocked', ok: true },
                  ...(isLawn ? [
                    { icon: '💧', text: 'Turn off irrigation 24hrs before treatment', ok: true },
                    { icon: '🌿', text: "Don't mow 3 days before or after treatment", ok: true },
                  ] : []),
                  ...(isPest ? [
                    { icon: '🏠', text: 'Clear counters and floors along baseboards', ok: true },
                    { icon: '🐠', text: 'Cover fish tanks and pet food/water bowls', ok: true },
                  ] : []),
                  ...(isMosquito ? [
                    { icon: '💧', text: 'Remove standing water from yard', ok: true },
                    { icon: '✅', text: 'Exterior only — no indoor prep needed', ok: true },
                  ] : []),
                  ...(isTermite ? [
                    { icon: '🏠', text: 'Clear access to garage, attic, and crawl spaces', ok: true },
                  ] : []),
                ].map((item, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 5,
                    padding: item.ok ? '0' : '4px 0 4px 0',
                    borderLeft: item.ok ? 'none' : `3px solid ${B.orange}`,
                    paddingLeft: item.ok ? 0 : 8,
                  }}>
                    <span style={{ flexShrink: 0, fontSize: 12 }}>{item.icon}</span>
                    <span style={{ fontSize: item.ok ? 12 : 12, fontWeight: item.ok ? 400 : 600, color: item.ok ? B.grayDark : B.navy, lineHeight: 1.4 }}>{item.text}</span>
                  </div>
                ))}
              </div>
            )}

            {/* What to Expect */}
            <div style={{ borderRadius: 12, background: B.white, border: `1px solid ${B.bluePale}`, overflow: 'hidden' }}>
              <div onClick={() => setShowExpect(!showExpect)} style={{
                padding: '10px 14px', cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>What to Expect</span>
                <span style={{ fontSize: 14, color: B.grayMid, transform: showExpect ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▾</span>
              </div>
              {showExpect && (
                <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${B.grayLight}` }}>
                  <div style={{ fontSize: 12, color: B.grayDark, lineHeight: 1.65, marginTop: 8 }}>{whatToExpect}</div>
                </div>
              )}
            </div>

            {/* Completion summary */}
            {step === 7 && summary && (
              <div style={{ padding: '12px 14px', borderRadius: 12, background: '#E8F5E9', border: `1px solid ${B.green}33` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: B.green, marginBottom: 6 }}>Service Summary</div>
                {summary.productsApplied?.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 10, color: B.grayDark, fontWeight: 600, marginBottom: 3 }}>Products:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>{summary.productsApplied.map((p, i) => (<span key={i} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 5, background: B.white, color: B.navy, fontWeight: 600 }}>{p}</span>))}</div>
                  </div>
                )}
                {summary.areasTreated?.length > 0 && <div style={{ fontSize: 11, color: B.grayDark, marginBottom: 4 }}><strong>Areas:</strong> {summary.areasTreated.join(' · ')}</div>}
                {summary.recommendations && <div style={{ fontSize: 11, color: B.grayDark, fontStyle: 'italic' }}>💡 {summary.recommendations}</div>}
                {summary.nextVisitDate && <div style={{ fontSize: 10, color: B.wavesBlue, fontWeight: 600, marginTop: 4 }}>Next visit: {new Date(summary.nextVisitDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Demo controls */}
      {step < 7 && (
        <div style={{ padding: '10px 16px 14px', background: B.white, borderTop: `1px solid ${B.grayLight}`, display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={handleAdvance} style={{ ...BUTTON_BASE, padding: '8px 14px', fontSize: 11, background: B.red, color: '#fff', flexShrink: 0 }}>Next Step →</button>
          <input type="text" value={demoNote} onChange={e => setDemoNote(e.target.value)} placeholder="Add note..." style={{ flex: 1, padding: '7px 10px', borderRadius: 8, fontSize: 11, border: `1px solid ${B.grayLight}`, outline: 'none', fontFamily: FONTS.body, color: B.navy, boxSizing: 'border-box' }} onKeyDown={e => e.key === 'Enter' && handleAddNote()} />
          <button onClick={handleAddNote} disabled={!demoNote.trim()} style={{ ...BUTTON_BASE, padding: '8px 10px', fontSize: 11, background: B.wavesBlue, color: '#fff', flexShrink: 0, opacity: demoNote.trim() ? 1 : 0.5 }}>+Note</button>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// REFER & EARN TAB
// =========================================================================
function ReferTab({ customer, onSwitchTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchData = () => {
    api.getReferrals()
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const handleCopy = () => {
    navigator.clipboard?.writeText(data?.shareLink || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSubmit = async () => {
    if (!name.trim() || !phone.trim()) return;
    setSubmitting(true);
    try {
      await api.submitReferral({ refereeName: name.trim(), refereePhone: phone.trim() });
      setSubmitted(true);
      setName(''); setPhone('');
      fetchData();
      setTimeout(() => setSubmitted(false), 3000);
    } catch (err) {
      console.error(err);
    }
    setSubmitting(false);
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Loading referrals...</div>;

  const referralCode = data?.referralCode || customer.referralCode || '';
  const shareLink = data?.shareLink || `https://wavespestcontrol.com?ref=${referralCode}`;
  const stats = data?.stats || { totalReferrals: 0, converted: 0, totalEarned: 0 };
  const referrals = data?.referrals || [];

  const shareText = `Hey! I use Waves Pest Control for my lawn and pest service — they're the best in SW Florida. Use my referral link and we both get $25 off: ${shareLink}`;

  const statusConfig = {
    pending: { label: 'Invited', color: B.grayMid, bg: B.grayLight },
    contacted: { label: 'Contacted', color: B.wavesBlue, bg: B.bluePale },
    signed_up: { label: 'Signed Up', color: B.orange, bg: '#FFF3E0' },
    credited: { label: 'Credit Applied', color: B.green, bg: '#E8F5E9' },
  };

  const STATUS_ORDER = ['pending', 'contacted', 'signed_up', 'credited'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Hero Banner */}
      <div style={{
        background: `linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark}, ${B.wavesBlue})`,
        backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(135deg, ${B.blueDeeper}, ${B.blueDark}, ${B.wavesBlue})`,
        backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
        borderRadius: 20, padding: '28px 24px', color: '#fff', textAlign: 'center',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🎁</div>
        <div style={{ fontSize: 28, fontWeight: 800, fontFamily: FONTS.heading }}>Give $25, Get $25</div>
        <div style={{ fontSize: 14, opacity: 0.85, marginTop: 8, lineHeight: 1.6 }}>
          Refer a neighbor to Waves Pest Control. When they sign up for any WaveGuard plan, you both get a <strong>$25 credit</strong> on your next bill.
        </div>
        {/* Stats pills */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
          {[
            { value: stats.totalReferrals, label: 'Referred' },
            { value: stats.converted, label: 'Signed Up' },
            { value: `$${stats.totalEarned}`, label: 'Earned' },
          ].map(s => (
            <div key={s.label} style={{
              padding: '8px 16px', borderRadius: 12,
              background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.15)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.ui }}>{s.value}</div>
              <div style={{ fontSize: 10, color: B.blueLight, marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Your Referral Code */}
      <div style={{
        background: B.white, borderRadius: 16, padding: 20,
        border: `1px solid ${B.grayLight}`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 10 }}>Your Referral Code</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: B.offWhite, borderRadius: 12, padding: '12px 16px',
          border: `1px solid ${B.grayLight}`,
        }}>
          <div style={{ flex: 1, fontSize: 20, fontWeight: 800, fontFamily: FONTS.ui, color: B.navy, letterSpacing: 2 }}>
            {referralCode}
          </div>
          <button onClick={handleCopy} style={{
            ...BUTTON_BASE, padding: '8px 16px', fontSize: 12,
            background: copied ? B.green : B.red, color: '#fff',
          }}>{copied ? '✓ Copied!' : 'Copy Link'}</button>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <a href={`sms:?body=${encodeURIComponent(shareText)}`} style={{
            ...BUTTON_BASE, flex: 1, padding: '10px 16px', fontSize: 13,
            background: B.red, color: '#fff', textDecoration: 'none',
          }}>💬 Share via Text</a>
        </div>
        <div style={{ fontSize: 11, color: B.grayMid, marginTop: 8, textAlign: 'center' }}>
          Share link: {shareLink}
        </div>
      </div>

      {/* Quick Refer Form */}
      <div style={{
        background: B.white, borderRadius: 16, padding: 20,
        border: `1px solid ${B.grayLight}`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>Send an Invite</div>
        <div style={{ fontSize: 12, color: B.grayMid, marginBottom: 14 }}>
          Enter their name and number — we'll text them on your behalf.
        </div>

        {submitted && (
          <div style={{
            padding: 14, borderRadius: 12, background: '#E8F5E9', marginBottom: 14,
            fontSize: 13, fontWeight: 600, color: B.green,
          }}>✅ Invite sent! We texted them your referral.</div>
        )}

        <input
          type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="Neighbor's name"
          style={{
            width: '100%', padding: '11px 14px', borderRadius: 10, marginBottom: 10,
            border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
            color: B.navy, outline: 'none', boxSizing: 'border-box',
          }}
          onFocus={e => e.target.style.borderColor = B.wavesBlue}
          onBlur={e => e.target.style.borderColor = B.grayLight}
        />
        <input
          type="tel" value={phone} onChange={e => setPhone(e.target.value)}
          placeholder="Their phone number"
          style={{
            width: '100%', padding: '11px 14px', borderRadius: 10, marginBottom: 14,
            border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
            color: B.navy, outline: 'none', boxSizing: 'border-box',
          }}
          onFocus={e => e.target.style.borderColor = B.wavesBlue}
          onBlur={e => e.target.style.borderColor = B.grayLight}
        />
        <button onClick={handleSubmit} disabled={!name.trim() || !phone.trim() || submitting} style={{
          ...BUTTON_BASE, width: '100%', padding: 13, fontSize: 14,
          background: (name.trim() && phone.trim()) ? B.red : B.grayLight,
          color: (name.trim() && phone.trim()) ? '#fff' : B.grayMid,
          opacity: submitting ? 0.7 : 1,
        }}>
          {submitting ? 'Sending...' : '📲 Send Invite'}
        </button>
      </div>

      {/* Referral Tracker */}
      {referrals.length > 0 && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 20,
          border: `1px solid ${B.grayLight}`,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
            Your Referrals
          </div>
          <div style={{ fontSize: 12, color: B.green, fontWeight: 600, marginBottom: 14 }}>
            You've referred {stats.totalReferrals} neighbor{stats.totalReferrals !== 1 ? 's' : ''} and earned ${stats.totalEarned}!
          </div>

          {referrals.map(r => {
            const s = statusConfig[r.status] || statusConfig.pending;
            return (
              <div key={r.id} style={{
                padding: '14px 0',
                borderBottom: `1px solid ${B.grayLight}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>{r.refereeName}</div>
                    <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>
                      {r.refereePhone} · {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                    padding: '4px 10px', borderRadius: 20,
                    background: s.bg, color: s.color,
                  }}>{s.label}</span>
                </div>
                {/* Status progress */}
                <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
                  {STATUS_ORDER.map((st, i) => (
                    <div key={st} style={{
                      flex: 1, height: 3, borderRadius: 2,
                      background: STATUS_ORDER.indexOf(r.status) >= i ? s.color : B.grayLight,
                    }} />
                  ))}
                </div>
                {r.referrerCredited && (
                  <div style={{ fontSize: 11, color: B.green, fontWeight: 600, marginTop: 6 }}>
                    ✓ ${r.creditAmount} credit applied to your bill
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* How it works */}
      <div style={{
        background: B.offWhite, borderRadius: 14, padding: 18,
        border: `1px solid ${B.grayLight}`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 10 }}>How it works</div>
        {[
          { step: '1', text: 'Share your code or send an invite from above' },
          { step: '2', text: 'Your neighbor gets a text with your referral and $25 off' },
          { step: '3', text: 'When they sign up for any WaveGuard plan, you both get credited' },
          { step: '4', text: '$25 auto-applied to your next monthly bill via Square' },
        ].map(s => (
          <div key={s.step} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%', fontSize: 12, fontWeight: 700,
              background: `${B.wavesBlue}15`, color: B.wavesBlue,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>{s.step}</div>
            <div style={{ fontSize: 12, color: B.grayDark }}>{s.text}</div>
          </div>
        ))}
        <div style={{ fontSize: 11, color: B.grayMid, marginTop: 8 }}>
          No limit on referrals — the more you share, the more you save.
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// DOCUMENTS TAB
// =========================================================================
function DocumentsTab({ customer }) {
  const [docs, setDocs] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [shareStatus, setShareStatus] = useState({}); // { docId: 'copying' | 'copied' | shareLink }

  useEffect(() => {
    api.getDocuments()
      .then(d => { setDocs(d.documents || {}); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleDownload = (doc) => {
    if (doc.isAutoGenerated && doc.linkedServiceRecordId) {
      // Open auto-generated PDF in new tab
      const url = api.getServiceReportUrl(doc.linkedServiceRecordId);
      const token = localStorage.getItem('waves_token');
      // Fetch with auth and open as blob
      fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.blob())
        .then(blob => {
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = doc.fileName;
          a.click();
          URL.revokeObjectURL(blobUrl);
        })
        .catch(console.error);
    }
    // For S3 docs, would redirect to presigned URL
  };

  const handleShare = async (doc) => {
    setShareStatus(prev => ({ ...prev, [doc.id]: 'copying' }));
    try {
      const result = await api.shareDocument(doc.id);
      await navigator.clipboard?.writeText(result.shareLink);
      setShareStatus(prev => ({ ...prev, [doc.id]: 'copied' }));
      setTimeout(() => setShareStatus(prev => ({ ...prev, [doc.id]: null })), 3000);
    } catch (err) {
      console.error(err);
      setShareStatus(prev => ({ ...prev, [doc.id]: null }));
    }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.grayMid }}>Loading documents...</div>;

  const categories = [
    { key: 'service_report', label: '📄 Visit Reports', empty: 'Reports will auto-generate from your service history.' },
    { key: 'wdo_inspection', label: '🏠 WDO Inspection Reports', empty: 'No WDO inspections on file. Need one for a real estate transaction? Contact us to schedule.' },
    { key: 'service_agreement', label: '📋 Service Agreements & Proposals', empty: 'Your service agreement will appear here after enrollment.' },
    { key: 'annual_summary', label: '📊 Annual Summaries', empty: 'Your first annual summary will be generated at the end of the year.' },
    { key: 'invoice', label: '💰 Invoices & Receipts', empty: 'Invoice history coming soon — currently available in your billing tab.' },
    { key: 'insurance_cert', label: '🔒 Insurance & Licensing', empty: 'Insurance certificates will be uploaded by Waves.' },
  ];

  const typeFilters = [
    { value: 'all', label: 'All' },
    { value: 'service_report', label: 'Reports' },
    { value: 'wdo_inspection', label: 'WDO' },
    { value: 'service_agreement', label: 'Agreements' },
    { value: 'insurance_cert', label: 'Insurance' },
  ];

  // Filter docs
  const filteredCategories = categories
    .filter(c => typeFilter === 'all' || c.key === typeFilter)
    .map(c => {
      let items = docs[c.key] || [];
      if (search.trim()) {
        const q = search.toLowerCase();
        items = items.filter(d => d.title?.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q));
      }
      return { ...c, items };
    });

  const getExpirationBadge = (expDate) => {
    if (!expDate) return null;
    const exp = new Date(expDate + 'T12:00:00');
    const now = new Date();
    const daysUntil = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));

    if (daysUntil < 0) return { label: 'Expired', color: B.red, bg: '#FFEBEE' };
    if (daysUntil <= 60) return { label: `Expires in ${daysUntil}d`, color: B.orange, bg: '#FFF3E0' };
    return { label: 'Valid', color: B.green, bg: '#E8F5E9' };
  };

  const relativeTime = (date) => {
    const d = new Date(date);
    const diff = Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 30) return `${diff} days ago`;
    if (diff < 365) return `${Math.floor(diff / 30)} months ago`;
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHeading>Documents</SectionHeading>
      <div style={{ fontSize: 14, color: B.grayDark }}>Your service records, compliance docs, and important paperwork</div>

      {/* Search & Filter */}
      <div>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search documents..."
          style={{
            width: '100%', padding: '10px 14px', borderRadius: 10,
            border: `1px solid ${B.grayLight}`, fontSize: 13, fontFamily: FONTS.body,
            color: B.navy, outline: 'none', boxSizing: 'border-box', marginBottom: 10,
          }}
          onFocus={e => e.target.style.borderColor = B.wavesBlue}
          onBlur={e => e.target.style.borderColor = B.grayLight}
        />
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {typeFilters.map(f => (
            <button key={f.value} onClick={() => setTypeFilter(f.value)} style={{
              ...BUTTON_BASE, padding: '5px 12px', fontSize: 11, whiteSpace: 'nowrap',
              background: typeFilter === f.value ? B.wavesBlue : B.white,
              color: typeFilter === f.value ? '#fff' : B.grayMid,
              border: typeFilter === f.value ? 'none' : `1px solid ${B.grayLight}`,
            }}>{f.label}</button>
          ))}
        </div>
      </div>

      {/* Document Categories */}
      {filteredCategories.map(cat => (
        <DocumentSection
          key={cat.key}
          title={cat.label}
          items={cat.items}
          emptyMessage={cat.empty}
          onDownload={handleDownload}
          onShare={handleShare}
          shareStatus={shareStatus}
          getExpirationBadge={getExpirationBadge}
          relativeTime={relativeTime}
          formatSize={formatSize}
          showWdoShare={cat.key === 'wdo_inspection'}
        />
      ))}

      {/* Bottom note */}
      <div style={{
        background: B.offWhite, borderRadius: 14, padding: 18,
        border: `1px solid ${B.grayLight}`, textAlign: 'center',
      }}>
        <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.6 }}>
          Need a specific document? We'll upload it within 24 hours.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 12 }}>
          <a href="tel:+19413187612" style={{
            ...BUTTON_BASE, padding: '8px 16px', fontSize: 12,
            background: B.red, color: '#fff', textDecoration: 'none',
          }}>📞 Call</a>
          <a href="sms:+19413187612" style={{
            ...BUTTON_BASE, padding: '8px 16px', fontSize: 12,
            background: B.red, color: '#fff', textDecoration: 'none',
          }}>💬 Text</a>
        </div>
        <div style={{ fontSize: 11, color: B.grayMid, marginTop: 10 }}>
          All pesticide application records and visit reports are automatically generated from your service history.
        </div>
      </div>
    </div>
  );
}

function DocumentSection({ title, items, emptyMessage, onDownload, onShare, shareStatus, getExpirationBadge, relativeTime, formatSize, showWdoShare }) {
  const [open, setOpen] = useState(true);

  return (
    <div style={{
      background: B.white, borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${B.grayLight}`,
    }}>
      <div onClick={() => setOpen(!open)} style={{
        padding: '14px 18px', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{title}</div>
          {items.length > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: B.bluePale, color: B.wavesBlue,
            }}>{items.length}</span>
          )}
        </div>
        <span style={{
          fontSize: 18, color: B.grayMid, transition: 'transform 0.3s',
          transform: open ? 'rotate(180deg)' : 'rotate(0)',
        }}>▾</span>
      </div>

      {open && (
        <div style={{ padding: '0 18px 14px' }}>
          {items.length === 0 ? (
            <div style={{ fontSize: 12, color: B.grayMid, fontStyle: 'italic', padding: '4px 0' }}>
              {emptyMessage}
            </div>
          ) : (
            items.map(doc => {
              const expBadge = doc.expirationDate ? getExpirationBadge(doc.expirationDate) : null;
              const share = shareStatus[doc.id];

              return (
                <div key={doc.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 0',
                  borderBottom: `1px solid ${B.grayLight}`,
                }}>
                  {/* Icon */}
                  <div style={{
                    width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                    background: doc.isAutoGenerated ? `${B.teal}15` : B.bluePale,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16,
                  }}>{doc.isAutoGenerated ? '⚡' : '📎'}</div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 600, color: B.navy,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{doc.title}</div>
                    <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>
                      {relativeTime(doc.createdAt)}
                      {doc.fileSizeBytes ? ` · ${formatSize(doc.fileSizeBytes)}` : ''}
                      {doc.isAutoGenerated && ' · Auto-generated'}
                    </div>
                    {expBadge && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                        background: expBadge.bg, color: expBadge.color, marginTop: 3,
                        display: 'inline-block',
                      }}>{expBadge.label}</span>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {(showWdoShare || doc.documentType === 'wdo_inspection') && (
                      <button onClick={() => onShare(doc)} style={{
                        ...BUTTON_BASE, padding: '5px 8px', fontSize: 11, borderRadius: 8,
                        background: share === 'copied' ? B.green : B.offWhite,
                        color: share === 'copied' ? '#fff' : B.grayDark,
                        border: share === 'copied' ? 'none' : `1px solid ${B.grayLight}`,
                      }}>{share === 'copied' ? '✓' : share === 'copying' ? '...' : '↗'}</button>
                    )}
                    <button onClick={() => onDownload(doc)} style={{
                      ...BUTTON_BASE, padding: '5px 8px', fontSize: 11, borderRadius: 8,
                      background: B.offWhite, color: B.navy,
                      border: `1px solid ${B.grayLight}`,
                    }}>⬇</button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// REPORT ISSUE OVERLAY — full-screen form triggered by FAB
// =========================================================================
function ReportIssueOverlay({ open, onClose, onSubmitted }) {
  const [category, setCategory] = useState('');
  const [urgency, setUrgency] = useState('routine');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [location, setLocation] = useState('');
  const [photos, setPhotos] = useState([]); // array of { preview, data }
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const fileRef = useRef(null);

  const categories = [
    { value: 'pest_issue', label: '🐜 Pest Issue' },
    { value: 'lawn_concern', label: '🌱 Lawn Problem' },
    { value: 'billing', label: '💳 Billing' },
    { value: 'schedule_change', label: '📅 Schedule' },
    { value: 'add_service', label: '➕ Add Service' },
    { value: 'other', label: '💬 Other' },
  ];

  const locations = [
    { value: 'front_yard', label: 'Front Yard' },
    { value: 'back_yard', label: 'Back Yard' },
    { value: 'side_yard', label: 'Side Yard' },
    { value: 'inside_home', label: 'Inside Home' },
    { value: 'garage_lanai', label: 'Garage / Lanai' },
    { value: 'garden_beds', label: 'Garden Beds' },
    { value: 'other', label: 'Other' },
  ];

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file || photos.length >= 3) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPhotos(prev => [...prev, { preview: ev.target.result, data: ev.target.result }]);
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // allow re-selecting same file
  };

  const removePhoto = (idx) => {
    setPhotos(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!category || !subject.trim()) return;
    setSubmitting(true);
    try {
      await api.createRequest({
        category,
        subject: subject.trim(),
        description: description.trim(),
        urgency,
        locationOnProperty: location || null,
        photos: photos.map(p => p.data),
      });
      setSubmitted(true);
      onSubmitted?.();
      setTimeout(() => {
        setSubmitted(false);
        setCategory(''); setSubject(''); setDescription('');
        setUrgency('routine'); setLocation(''); setPhotos([]);
        onClose();
      }, 2500);
    } catch (err) {
      console.error(err);
    }
    setSubmitting(false);
  };

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: B.offWhite, overflowY: 'auto',
      animation: 'slideUp 0.3s ease-out',
    }}>
      <style>{`@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>

      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${B.grayLight}`,
        padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>Report an Issue</div>
        <button onClick={onClose} style={{
          background: B.offWhite, border: 'none', cursor: 'pointer', fontSize: 18,
          color: B.grayMid, width: 32, height: 32, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>✕</button>
      </div>

      {submitted ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginTop: 12 }}>Sent to Waves!</div>
          <div style={{ fontSize: 13, color: B.grayDark, marginTop: 8, lineHeight: 1.6 }}>
            We'll review your request and text you when it's been assigned.
            {urgency === 'urgent' ? ' Urgent requests are prioritized — expect a response within 2 hours.' : ''}
          </div>
        </div>
      ) : (
        <div style={{ padding: '16px 20px 120px', maxWidth: 600, margin: '0 auto' }}>
          {/* Category */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 8 }}>What's going on?</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {categories.map(c => (
                <button key={c.value} onClick={() => setCategory(c.value)} style={{
                  ...BUTTON_BASE, padding: '9px 16px', fontSize: 13, borderRadius: 12,
                  background: category === c.value ? B.wavesBlue : B.white,
                  color: category === c.value ? '#fff' : B.grayDark,
                  border: category === c.value ? 'none' : `1px solid ${B.grayLight}`,
                }}>{c.label}</button>
              ))}
            </div>
          </div>

          {/* Urgency */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 8 }}>How urgent?</div>
            <div style={{ display: 'flex', gap: 10 }}>
              {[
                { value: 'routine', label: 'Routine', desc: 'Next 24 hours', color: B.wavesBlue },
                { value: 'urgent', label: 'Urgent', desc: 'Within 2 hours', color: B.red },
              ].map(u => (
                <button key={u.value} onClick={() => setUrgency(u.value)} style={{
                  flex: 1, padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
                  border: urgency === u.value ? `2px solid ${u.color}` : `1px solid ${B.grayLight}`,
                  background: urgency === u.value ? `${u.color}10` : B.white,
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: urgency === u.value ? u.color : B.grayDark }}>{u.label}</div>
                  <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>{u.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Subject */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 8 }}>Brief summary</div>
            <input
              type="text" value={subject} onChange={e => setSubject(e.target.value)}
              placeholder="e.g., Ants in the kitchen, Brown patch near oak tree"
              maxLength={255}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12,
                border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
                color: B.navy, outline: 'none', boxSizing: 'border-box',
              }}
              onFocus={e => e.target.style.borderColor = B.wavesBlue}
              onBlur={e => e.target.style.borderColor = B.grayLight}
            />
          </div>

          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: B.navy }}>Details</div>
              <div style={{ fontSize: 11, color: description.length > 450 ? B.red : B.grayMid }}>
                {description.length}/500
              </div>
            </div>
            <textarea
              value={description} onChange={e => { if (e.target.value.length <= 500) setDescription(e.target.value); }}
              placeholder="Tell us what you're seeing..."
              rows={4}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12,
                border: `1px solid ${B.grayLight}`, fontSize: 14, fontFamily: FONTS.body,
                color: B.navy, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
              }}
              onFocus={e => e.target.style.borderColor = B.wavesBlue}
              onBlur={e => e.target.style.borderColor = B.grayLight}
            />
          </div>

          {/* Photo Upload */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 8 }}>
              Photos <span style={{ fontWeight: 400, color: B.grayMid }}>(optional, up to 3)</span>
            </div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: 'none' }} />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {photos.map((p, i) => (
                <div key={i} style={{ position: 'relative', width: 80, height: 80 }}>
                  <img src={p.preview} alt="" style={{
                    width: 80, height: 80, objectFit: 'cover', borderRadius: 10,
                    border: `1px solid ${B.grayLight}`,
                  }} />
                  <button onClick={() => removePhoto(i)} style={{
                    position: 'absolute', top: -6, right: -6,
                    width: 22, height: 22, borderRadius: '50%',
                    background: B.red, color: '#fff', border: '2px solid #fff',
                    cursor: 'pointer', fontSize: 11, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', padding: 0,
                  }}>✕</button>
                </div>
              ))}
              {photos.length < 3 && (
                <div onClick={() => fileRef.current?.click()} style={{
                  width: 80, height: 80, borderRadius: 10, cursor: 'pointer',
                  border: `2px dashed ${B.grayLight}`, background: B.offWhite,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span style={{ fontSize: 20 }}>📸</span>
                  <span style={{ fontSize: 9, color: B.grayMid, marginTop: 2 }}>Add photo</span>
                </div>
              )}
            </div>
          </div>

          {/* Location on Property */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, marginBottom: 8 }}>Where on your property?</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {locations.map(l => (
                <button key={l.value} onClick={() => setLocation(location === l.value ? '' : l.value)} style={{
                  ...BUTTON_BASE, padding: '7px 12px', fontSize: 12, borderRadius: 20,
                  background: location === l.value ? B.teal : B.white,
                  color: location === l.value ? '#fff' : B.grayDark,
                  border: location === l.value ? 'none' : `1px solid ${B.grayLight}`,
                }}>{l.label}</button>
              ))}
            </div>
          </div>

          {/* Submit */}
          <button onClick={handleSubmit} disabled={!category || !subject.trim() || submitting} style={{
            ...BUTTON_BASE, width: '100%', padding: 16, fontSize: 16,
            background: (category && subject.trim()) ? B.red : B.grayLight,
            color: (category && subject.trim()) ? '#fff' : B.grayMid,
            opacity: submitting ? 0.7 : 1,
            boxShadow: (category && subject.trim()) ? `0 4px 15px ${B.teal}40` : 'none',
          }}>
            {submitting ? 'Sending...' : '📤 Send to Waves'}
          </button>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// MY REQUESTS CARD — shows on dashboard when customer has open requests
// =========================================================================
function MyRequestsCard() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRequests()
      .then(d => { setRequests(d.requests || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return null;

  const open = requests.filter(r => r.status !== 'resolved');
  if (!open.length) return null;

  const statusConfig = {
    new: { label: 'New', color: B.wavesBlue, bg: B.bluePale },
    acknowledged: { label: 'Reviewed', color: B.orange, bg: '#FFF3E0' },
    scheduled: { label: 'Scheduled', color: B.teal, bg: '#E0F7FA' },
    resolved: { label: 'Resolved', color: B.green, bg: '#E8F5E9' },
  };

  const STATUS_ORDER = ['new', 'acknowledged', 'scheduled', 'resolved'];

  return (
    <div style={{
      background: B.white, borderRadius: 16, padding: 20,
      border: `1px solid ${B.grayLight}`, boxShadow: '0 2px 12px rgba(0,0,0,0.03)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>📋</span>
        <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>My Requests</div>
        <span style={{
          marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '2px 8px',
          borderRadius: 10, background: B.bluePale, color: B.wavesBlue,
        }}>{open.length} open</span>
      </div>

      {open.slice(0, 3).map(r => {
        const s = statusConfig[r.status] || statusConfig.new;
        const created = new Date(r.createdAt);
        return (
          <div key={r.id} style={{
            padding: '12px 0',
            borderBottom: `1px solid ${B.grayLight}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: B.navy }}>{r.subject}</div>
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                padding: '3px 8px', borderRadius: 20,
                background: s.bg, color: s.color,
              }}>{s.label}</span>
            </div>
            {/* Status progress */}
            <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
              {STATUS_ORDER.map((st, i) => (
                <div key={st} style={{
                  flex: 1, height: 3, borderRadius: 2,
                  background: STATUS_ORDER.indexOf(r.status) >= i ? s.color : B.grayLight,
                }} />
              ))}
            </div>
            <div style={{ fontSize: 11, color: B.grayMid, marginTop: 6 }}>
              {r.category?.replace(/_/g, ' ')} · {created.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              {r.urgency === 'urgent' && <span style={{ color: B.red, fontWeight: 700, marginLeft: 6 }}>URGENT</span>}
              {r.assignedTechnician && <span> · Assigned: {r.assignedTechnician}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =========================================================================
// MAIN PORTAL
// =========================================================================
const TABS = [
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'plan', label: 'My Plan', icon: '🛡️' },
  { id: 'services', label: 'History', icon: '📋' },
  { id: 'schedule', label: 'Schedule', icon: '📅' },
  { id: 'billing', label: 'Billing', icon: '💳' },
  { id: 'request', label: 'Request', icon: '🆘' },
  { id: 'refer', label: 'Refer & Earn', icon: '🎁' },
  { id: 'documents', label: 'Documents', icon: '📄' },
  { id: 'property', label: 'My Property', icon: '🏡' },
  { id: 'learn', label: 'Learn', icon: '💡' },
];

// =========================================================================
// AI CHAT WIDGET
// =========================================================================
function ChatWidget({ customer, onClose }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: `Hi${customer?.first_name ? ` ${customer.first_name}` : ''}! I'm the Waves AI assistant. How can I help you today?` },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);
  const sessionId = useRef(`chat-${Date.now()}`);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_token')}`,
        },
        body: JSON.stringify({ message: text, sessionId: sessionId.current }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply || "I'm having trouble right now. Please try calling us at (941) 318-7612." }]);
      if (data.escalated) {
        setMessages(prev => [...prev, { role: 'system', content: 'A team member has been notified and will follow up shortly.' }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: "Connection issue — please try again or call us at (941) 318-7612." }]);
    }
    setSending(false);
  };

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, top: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: B.white, borderRadius: '20px 20px 0 0', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
        animation: 'chatSlideUp 0.3s ease',
      }}>
        <style>{`@keyframes chatSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>

        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${B.grayLight}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: `linear-gradient(135deg, ${B.wavesBlue}, ${B.blueDark})`, borderRadius: '20px 20px 0 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }}>{'🌊'}</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Waves Assistant</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Usually replies instantly</div>
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff',
            width: 32, height: 32, borderRadius: 16, cursor: 'pointer', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{'✕'}</button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 300, maxHeight: '60vh' }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 10,
            }}>
              <div style={{
                maxWidth: '80%', padding: '10px 14px', borderRadius: 16,
                fontSize: 14, lineHeight: 1.5, fontFamily: FONTS.body,
                ...(msg.role === 'user' ? {
                  background: B.wavesBlue, color: '#fff',
                  borderBottomRightRadius: 4,
                } : msg.role === 'system' ? {
                  background: B.offWhite, color: B.grayMid, fontSize: 12, fontStyle: 'italic',
                  borderRadius: 8,
                } : {
                  background: B.offWhite, color: B.navy,
                  borderBottomLeftRadius: 4,
                }),
              }}>
                {msg.content}
              </div>
            </div>
          ))}
          {sending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
              <div style={{ background: B.offWhite, padding: '10px 18px', borderRadius: 16, fontSize: 14, color: B.grayMid }}>
                <span style={{ animation: 'pulse 1.5s ease infinite' }}>{'•••'}</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div style={{
          padding: '12px 16px', borderTop: `1px solid ${B.grayLight}`,
          display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Type a message..."
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 24, border: `1px solid ${B.grayLight}`,
              fontSize: 14, fontFamily: FONTS.body, outline: 'none', background: B.offWhite,
            }}
            autoFocus
          />
          <button onClick={send} disabled={sending || !input.trim()} style={{
            width: 40, height: 40, borderRadius: 20, border: 'none',
            background: input.trim() ? B.wavesBlue : B.grayLight,
            color: '#fff', cursor: input.trim() ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            transition: 'background 0.15s',
          }}>{'↑'}</button>
        </div>
      </div>
    </div>
  );
}

export default function PortalPage() {
  const { customer, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [showMenu, setShowMenu] = useState(false);
  const [showReportIssue, setShowReportIssue] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [requestRefreshKey, setRequestRefreshKey] = useState(0);
  const menuRef = useRef(null);
  const portalBadgeData = useBadges();

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  if (!customer) return null;

  const initials = `${customer.firstName?.[0] || ''}${customer.lastName?.[0] || ''}`;

  return (
    <div style={{
      minHeight: '100vh',
      background: B.offWhite,
      fontFamily: FONTS.body,
    }}>
      {/* Header */}
      <div style={{
        background: B.blueDark,
        backgroundImage: `${HALFTONE_PATTERN}`,
        backgroundSize: HALFTONE_SIZE,
        padding: '12px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 34, width: 'auto' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: B.white, fontFamily: FONTS.heading }}>WAVES LAWN & PEST</div>
            <div style={{ fontSize: 9, color: B.blueLight, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' }}>Customer Portal</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <NotificationBell type="customer" />
          <div ref={menuRef} style={{ position: 'relative' }}>
          <div onClick={() => setShowMenu(!showMenu)} style={{
            width: 36, height: 36, borderRadius: '50%',
            background: B.yellow,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: B.navy, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: FONTS.heading,
          }}>{initials}</div>
          {showMenu && (
            <div style={{
              position: 'absolute', right: 0, top: 44, minWidth: 200,
              background: B.white, borderRadius: 14, overflow: 'hidden',
              boxShadow: '0 8px 30px rgba(0,0,0,0.12)', border: `1px solid ${B.grayLight}`,
              zIndex: 200,
            }}>
              <div style={{ padding: '14px 16px', borderBottom: `1px solid ${B.grayLight}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{customer.firstName} {customer.lastName}</div>
                <div style={{ fontSize: 11, color: B.grayMid, marginTop: 2 }}>{customer.phone}</div>
              </div>
              {[
                { icon: '🏡', label: 'My Property', action: () => { setActiveTab('property'); setShowMenu(false); } },
                { icon: '📄', label: 'Documents', action: () => { setActiveTab('documents'); setShowMenu(false); } },
                { icon: '📅', label: 'Schedule', action: () => { setActiveTab('schedule'); setShowMenu(false); } },
                { icon: '💳', label: 'Billing', action: () => { setActiveTab('billing'); setShowMenu(false); } },
              ].map(item => (
                <div key={item.label} onClick={item.action} style={{
                  padding: '11px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                  transition: 'background 0.15s',
                }} onMouseEnter={e => e.currentTarget.style.background = B.offWhite}
                   onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span style={{ fontSize: 16 }}>{item.icon}</span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: B.navy }}>{item.label}</span>
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${B.grayLight}` }}>
                <div onClick={() => { logout(); setShowMenu(false); }} style={{
                  padding: '11px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                }} onMouseEnter={e => e.currentTarget.style.background = B.offWhite}
                   onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span style={{ fontSize: 16 }}>👋</span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: B.red }}>Sign Out</span>
                </div>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '14px 16px 0' }}>
        <TabBar tabs={TABS} active={activeTab} onSelect={setActiveTab} />
      </div>

      {/* Content */}
      <div style={{ padding: '16px 16px 100px', maxWidth: 700, margin: '0 auto' }}>
        {activeTab === 'dashboard' && <DashboardTab customer={customer} onSwitchTab={setActiveTab} />}
        {activeTab === 'plan' && <MyPlanTab customer={customer} />}
        {activeTab === 'services' && <ServicesTab />}
        {activeTab === 'schedule' && <ScheduleTab customer={customer} />}
        {activeTab === 'billing' && <BillingTab customer={customer} />}
        {activeTab === 'request' && <RequestTab customer={customer} />}
        {activeTab === 'refer' && <ReferTab customer={customer} />}
        {activeTab === 'documents' && <DocumentsTab customer={customer} />}
        {activeTab === 'property' && <PropertyTab customer={customer} />}
        {activeTab === 'learn' && <LearnTab />}
      </div>

      {/* Social Footer */}
      <div style={{ maxWidth: 700, margin: '0 auto', paddingBottom: 80 }}>
        <SocialFooter />
      </div>

      {/* Bottom CTA */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(12px)',
        borderTop: `1px solid ${B.grayLight}`, padding: '10px 12px',
        display: 'flex', gap: 6, justifyContent: 'center', zIndex: 100,
      }}>
        <a href="tel:+19413187612" style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: B.red, color: '#fff', fontSize: 12, textAlign: 'center',
          boxShadow: `0 4px 15px ${B.red}40`, minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{'📞'} Call</a>
        <a href="sms:+19413187612" style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: B.red, color: '#fff', fontSize: 12,
          textAlign: 'center', boxShadow: `0 4px 15px ${B.red}30`, minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{'💬'} Text</a>
        <button onClick={() => setShowChat(true)} style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: B.wavesBlue, color: '#fff', fontSize: 12,
          textAlign: 'center', boxShadow: `0 4px 15px ${B.wavesBlue}40`, minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{'🤖'} Chat</button>
        <a href="mailto:contact@wavespestcontrol.com" style={{
          ...BUTTON_BASE, flex: 1, maxWidth: 150, padding: '10px 4px',
          background: B.navy, color: '#fff', fontSize: 12,
          textAlign: 'center', boxShadow: `0 4px 15px ${B.navy}30`, minHeight: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{'✉️'} Email</a>
      </div>

      {/* AI Chat Widget */}
      {showChat && <ChatWidget customer={customer} onClose={() => setShowChat(false)} />}

      {/* Badge Celebration Toast */}
      {!portalBadgeData.loading && portalBadgeData.data && (
        <BadgeCelebrationToast badges={portalBadgeData.data.badges} />
      )}

      {/* Floating Action Button — Report Issue */}
      <div style={{ position: 'fixed', bottom: 76, right: 16, zIndex: 99, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          background: B.navy, color: '#fff', padding: '8px 14px', borderRadius: 10,
          fontSize: 12, fontWeight: 700, fontFamily: FONTS.heading,
          boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
          whiteSpace: 'nowrap',
        }}>Report an Issue</div>
        <button onClick={() => setShowReportIssue(true)} style={{
          width: 56, height: 56, borderRadius: '50%',
          background: B.red, color: '#fff', border: 'none', cursor: 'pointer',
          boxShadow: `0 4px 20px ${B.red}60`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28, fontWeight: 300,
          transition: 'transform 0.2s, box-shadow 0.2s',
        }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
        >+</button>
      </div>

      {/* Report Issue Overlay */}
      <ReportIssueOverlay
        open={showReportIssue}
        onClose={() => setShowReportIssue(false)}
        onSubmitted={() => setRequestRefreshKey(k => k + 1)}
      />
    </div>
  );
}
