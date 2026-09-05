/**
 * WavesAIScheduleSearch — a natural-language "when do you want service?" bar,
 * styled after the estimate "Ask Waves" bar. The customer types something like
 * "anything next Tuesday afternoon" and the parent's onSearch() resolves to a
 * short summary line (and updates its own slot state as a side effect).
 *
 * Presentation only: input + example chips + the AI recap line. The slot cards
 * themselves are rendered by the parent so each surface keeps its own card UI
 * and selection wiring.
 *
 * onSearch(query) => Promise<{ summary: string }>  (may throw)
 *
 * Glass: the markup carries native data-glass / data-gt hooks (glass-theme.css)
 * so any surface mounted under html[data-glass-theme] — glass estimate, glass
 * reschedule — renders the bar in the glass language with no walker pass.
 * The attributes are inert everywhere else; the inline `theme` styles remain
 * the non-glass rendering. Buttons are tagged data-glass-accent (not "chip")
 * because their inline navy fill is what the estimate walker normalizes to an
 * accent anyway, and the accent rules force readable navy-on-gold text.
 */
import { useEffect, useRef, useState } from 'react';

const DEFAULT_CHIPS = ['Tomorrow morning', 'This weekend', 'Next week afternoon'];

export default function WavesAIScheduleSearch({
  theme,
  title = 'Search by date or time',
  subtitle = 'Tell Waves AI when works — we’ll show what’s open.',
  placeholder = 'Anything next Tuesday afternoon',
  chips = DEFAULT_CHIPS,
  showEyebrow = true,
  onSearch,
}) {
  const t = {
    accent: '#04395E',
    accentText: '#FFFFFF',
    surface: '#FFFFFF',
    inputBg: '#F8FCFE',
    text: '#04395E',
    muted: '#64748B',
    border: '#CFE7F5',
    ...theme,
  };

  const [query, setQuery] = useState('');
  const [summary, setSummary] = useState('');
  const [asking, setAsking] = useState(false);
  // Drift the quick-pick strip slowly leftward only when it overflows (phones);
  // paused while a finger or pointer is on it, off under reduced-motion (CSS).
  const stripRef = useRef(null);
  const [drift, setDrift] = useState(false);
  // Keyboard focus anywhere in the strip ends the drift for good: a focused
  // chip must stay inside the clipped strip, and a plain scrollable strip
  // lets the browser scroll each focused choice into view (GH Codex P1).
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return undefined;
    const measure = () => {
      const kids = [...el.children].slice(0, chips.length);
      const setWidth = kids.reduce((w, k) => w + k.offsetWidth, 0) + 8 * chips.length;
      el.style.setProperty('--chip-shift', `-${setWidth}px`);
      // Reduced motion: no drift, so the overflowing set stays a plain
      // scrollable strip instead of a clipped one (GH Codex pre-push P1).
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setDrift(!reduced && !keyboard && setWidth > el.clientWidth - 36);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [chips, drift, keyboard]);

  const run = async (prompt) => {
    const q = String(prompt ?? query).trim();
    if (!q || asking) return;
    setAsking(true);
    setSummary('Checking the route map…');
    try {
      const res = await onSearch(q);
      setSummary((res && res.summary) || '');
    } catch {
      setSummary('Sorry — couldn’t search just now. Call (941) 297-5749 and we’ll help.');
    } finally {
      setAsking(false);
    }
  };

  return (
    <section data-glass="soft" style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12,
      padding: 20, display: 'grid', gap: 12,
    }}>
      <div>
        {showEyebrow ? (
          <div data-gt="eyebrow" style={{
            fontSize: 14, color: t.muted, letterSpacing: '0.12em',
            textTransform: 'uppercase', fontWeight: 700, marginBottom: 4,
          }}>
            Waves AI
          </div>
        ) : null}
        <div style={{ fontSize: 18, fontWeight: 700, color: t.text }}>{title}</div>
        {subtitle ? <div style={{ fontSize: 14, color: t.muted, marginTop: 2 }}>{subtitle}</div> : null}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); run(); }}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search for a service date or time"
          maxLength={500}
          style={{
            width: '100%', minHeight: 48, border: `1px solid ${t.border}`,
            borderRadius: 10, padding: '12px 14px', fontSize: 16,
            color: t.text, background: t.inputBg, outline: 'none', boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          data-glass-accent=""
          disabled={asking || !query.trim()}
          style={{
            minHeight: 48, border: 0, borderRadius: 10, padding: '0 20px',
            background: t.accent, color: t.accentText, fontSize: 16, fontWeight: 700,
            cursor: asking || !query.trim() ? 'not-allowed' : 'pointer',
            opacity: asking || !query.trim() ? 0.8 : 1,
          }}
        >
          {asking ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* One-line quick-pick strip: never wraps, scrolls sideways on phones
          (bleeds to the card edge so a cut-off chip signals "more"). */}
      {chips && chips.length > 0 ? (
        <div
          ref={stripRef}
          aria-label="Example searches"
          // Keyboard-initiated focus only (:focus-visible is set for Tab, not
          // for a pointer press) — a mousedown on a drifting duplicate must not
          // re-render the strip before its click lands (GH Codex P1).
          onFocus={(e) => { if (typeof e.target.matches === 'function' && e.target.matches(':focus-visible')) setKeyboard(true); }}
          className={drift ? 'waves-chip-strip waves-chip-strip--drift' : 'waves-chip-strip'}
          style={{
            display: 'flex', flexWrap: 'nowrap', gap: 8, overflowX: drift ? 'hidden' : 'auto',
            margin: '0 -20px', padding: '2px 20px', scrollbarWidth: 'none',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {(drift ? [...chips, ...chips] : chips).map((chip, i) => (
            <button
              key={`${chip}-${i}`}
              aria-hidden={i >= chips.length ? 'true' : undefined}
              tabIndex={i >= chips.length ? -1 : undefined}
              type="button"
              data-glass="chip"
              data-glass-pill=""
              disabled={asking}
              onClick={() => { setQuery(chip); run(chip); }}
              style={{
                flex: '0 0 auto', whiteSpace: 'nowrap', minHeight: 40,
                border: `1px solid ${t.border}`, background: t.inputBg, color: t.text,
                borderRadius: 999, padding: '0 14px', fontSize: 14, fontWeight: 600,
                cursor: asking ? 'not-allowed' : 'pointer', opacity: asking ? 0.8 : 1,
              }}
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      {summary ? (
        <div aria-live="polite" data-glass="soft" style={{
          fontSize: 14, lineHeight: 1.5, color: t.text,
          background: t.inputBg, border: `1px solid ${t.border}`,
          borderRadius: 10, padding: '10px 12px',
        }}>
          {summary}
        </div>
      ) : null}
    </section>
  );
}
