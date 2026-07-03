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
 */
import { useState } from 'react';

const DEFAULT_CHIPS = ['Tomorrow morning', 'This weekend', 'Next week afternoon'];

export default function WavesAIScheduleSearch({
  theme,
  title = 'Search by date or time',
  subtitle = 'Tell Waves AI when works — we’ll show what’s open.',
  placeholder = 'e.g. “anything next Tuesday afternoon”',
  chips = DEFAULT_CHIPS,
  showEyebrow = true,
  onSearch,
}) {
  const t = {
    accent: '#1B2C5B',
    accentText: '#FFFFFF',
    surface: '#FFFFFF',
    inputBg: '#F8FCFE',
    text: '#1B2C5B',
    muted: '#64748B',
    border: '#CFE7F5',
    ...theme,
  };

  const [query, setQuery] = useState('');
  const [summary, setSummary] = useState('');
  const [asking, setAsking] = useState(false);

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
    <section style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12,
      padding: 20, display: 'grid', gap: 12,
    }}>
      <div>
        {showEyebrow ? (
          <div style={{
            fontSize: 12, color: t.muted, letterSpacing: '0.12em',
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
            width: '100%', minHeight: 46, border: `1px solid ${t.border}`,
            borderRadius: 10, padding: '12px 14px', fontSize: 15,
            color: t.text, background: t.inputBg, outline: 'none', boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          disabled={asking || !query.trim()}
          style={{
            minHeight: 46, border: 0, borderRadius: 10, padding: '0 18px',
            background: t.accent, color: t.accentText, fontSize: 14, fontWeight: 700,
            cursor: asking || !query.trim() ? 'not-allowed' : 'pointer',
            opacity: asking || !query.trim() ? 0.8 : 1,
          }}
        >
          {asking ? 'Searching…' : 'Search'}
        </button>
      </form>

      {chips && chips.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} aria-label="Example searches">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={asking}
              onClick={() => { setQuery(chip); run(chip); }}
              style={{
                border: `1px solid ${t.border}`, background: t.inputBg, color: t.text,
                borderRadius: 999, padding: '7px 12px', fontSize: 13, fontWeight: 600,
                cursor: asking ? 'not-allowed' : 'pointer', opacity: asking ? 0.8 : 1,
              }}
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      {summary ? (
        <div aria-live="polite" style={{
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
