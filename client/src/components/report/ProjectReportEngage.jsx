/**
 * Project-report engage layer (owner rules 2026-07-16): every report carries
 * the Waves AI ask bar and the "How did today's visit go?" review ask —
 * EXCEPT the WDO / pre-treatment paper documents, whose pages never mount
 * these. Visuals mirror ReportViewPage's floating-ask bar and top review
 * card; the ask hits the deterministic project-report assistant endpoint.
 */
import { useState } from 'react';
import { COLORS as B } from '../../theme-brand';
import Icon from '../Icon';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Mirrors server/services/project-report-assistant.js projectReportAskPrompts.
const PROMPTS = [
  'What did you find?',
  'What was treated?',
  'What should I do next?',
  'When is my next visit?',
];

// Same office → review-link resolution as the service report (REVIEW_LOCATIONS
// in ReportViewPage.jsx); matched against the report's own address strings.
const REVIEW_LOCATIONS = [
  { key: 'parrish', reviewUrl: 'https://g.page/r/Ca-4KKoWwFacEBM/review', match: ['parrish', 'palmetto', 'ellenton', '34219', '34221', '34222'] },
  { key: 'sarasota', reviewUrl: 'https://g.page/r/CRkzS6M4EpncEBM/review', match: ['sarasota', 'siesta', '34231', '34232', '34233', '34236', '34237', '34238', '34239', '34240', '34241'] },
  { key: 'venice', reviewUrl: 'https://g.page/r/CURA5pQ1KatBEBM/review', match: ['venice', 'north port', 'englewood', 'nokomis', '34223', '34224', '34275', '34285', '34286', '34287', '34288', '34289', '34292', '34293'] },
  { key: 'bradenton', reviewUrl: 'https://g.page/r/CVRc_P5butTMEBM/review', match: ['lakewood ranch', 'bradenton', '34202', '34203', '34205', '34208', '34209', '34210', '34211', '34212'] },
];

function reviewLocationForProject(data = {}) {
  const haystack = [data.customerAddress, data.cityState]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  return REVIEW_LOCATIONS.find((loc) => loc.match.some((m) => haystack.includes(m)))
    || REVIEW_LOCATIONS[REVIEW_LOCATIONS.length - 1];
}

export function ProjectAskWaves({ token }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  const ask = async (text) => {
    const q = String((text ?? question) || '').trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer('');
    try {
      const response = await fetch(`${API_BASE}/reports/project/${token}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'question_failed');
      setAnswer(payload.answer || 'I could not answer that from this report.');
    } catch {
      setAnswer('I could not answer that right now — please try again, or call or text (941) 297-5749.');
    } finally {
      setAsking(false);
      if (text) setQuestion('');
    }
  };

  // The estimate's Ask Waves card (owner 2026-09-03), the same markup and
  // glass-theme classes as the service report: eyebrow, heading, input +
  // Ask, the prompts as stacked rows, the answer in flow. The sticky
  // marquee bar this replaced is gone with its CSS.
  return (
    <section className="waves-ask-card" data-glass="card" aria-label="Waves AI — ask about this report">
      <div className="waves-ask-eyebrow" data-gt="eyebrow">Ask Waves</div>
      <h2 className="waves-ask-title">Questions about this project?</h2>
      <p className="waves-ask-intro">What we found, what was treated, what to do next, or when the next visit is.</p>
      <form
        className="waves-ask-form"
        onSubmit={(event) => { event.preventDefault(); ask(); }}
      >
        <input
          id="project-report-question"
          name="project_report_question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about this project"
          aria-label="Ask Waves about this project report"
        />
        <button data-glass-accent="" type="submit" disabled={asking || !question.trim()}>
          {asking ? 'Checking…' : 'Ask'}
        </button>
      </form>
      <div className="waves-ask-list" data-glass="soft" role="list">
        {PROMPTS.map((prompt, i) => (
          <div role="listitem" key={prompt}>
            <button
              type="button"
              className="waves-ask-row"
              data-first={i === 0 ? '' : undefined}
              onClick={() => ask(prompt)}
              disabled={asking}
            >
              <span>{prompt}</span>
              <span aria-hidden="true" className="waves-ask-go">Ask ›</span>
            </button>
          </div>
        ))}
      </div>
      {answer && (
        <div className="waves-ask-answer" role="status">
          <span>{answer}</span>
          <button type="button" className="waves-ask-dismiss" onClick={() => setAnswer('')} aria-label="Dismiss answer">
            <Icon name="close" size={16} strokeWidth={2} />
          </button>
        </div>
      )}
    </section>
  );
}

export function ProjectReviewAsk({ data }) {
  if (data?.hasLeftGoogleReview) return null;
  // Server-resolved canonical office first (payload.reviewLocation — the ONE
  // resolver in config/locations.js); the local substring table is only a
  // fallback for cached pre-resolver payloads. The table is incomplete by
  // construction (no Port Charlotte / 33948) — never extend it, extend the
  // server resolver.
  const location = data?.reviewLocation?.reviewUrl
    ? { key: data.reviewLocation.id, reviewUrl: data.reviewLocation.reviewUrl }
    : reviewLocationForProject(data);
  return (
    <section
      data-glass="card"
      aria-label="Share feedback"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, flexWrap: 'wrap', background: '#fff',
        border: '1px solid var(--line, #E2E8F0)', borderRadius: 16,
        padding: '18px 22px', margin: '18px 0 0',
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text, #04395E)' }}>
        How did today&apos;s visit go?
      </h2>
      <a
        data-glass-accent=""
        href={location.reviewUrl}
        target="_blank"
        rel="noreferrer"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 44, padding: '0 18px', borderRadius: 999,
          background: B.yellow, color: B.glassNavy, fontWeight: 700,
          fontSize: 14, textDecoration: 'none', border: `1px solid ${B.glassNavy}`,
        }}
      >
        Share feedback
      </a>
    </section>
  );
}
