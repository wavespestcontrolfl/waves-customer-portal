/**
 * Project-report engage layer (owner rules 2026-07-16): every report carries
 * the Waves AI ask bar and the "How did today's visit go?" review ask —
 * EXCEPT the WDO / pre-treatment paper documents, whose pages never mount
 * these. Visuals mirror ReportViewPage's floating-ask bar and top review
 * card; the ask hits the deterministic project-report assistant endpoint.
 */
import { useState } from 'react';
import { COLORS as B } from '../../theme-brand';

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

const ASK_CSS = `
.project-ask-wrap { position: sticky; top: 57px; z-index: 8; margin: 0 0 18px; }
.project-ask-bar {
  position: relative;
  display: grid;
  grid-template-areas: 'title pills form';
  grid-template-columns: auto minmax(0, 1fr) minmax(280px, 38%);
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line, #E2E8F0);
  border-radius: 18px;
  background: var(--wash, #F8FAFC);
  padding: 10px 14px;
}
.project-ask-title {
  grid-area: title; color: var(--text, #04395E);
  font-size: 12px; font-weight: 800; letter-spacing: 0.08em;
  text-transform: uppercase; white-space: nowrap;
}
.project-ask-title::before { content: '\\2726  '; color: ${B.yellow}; }
.project-ask-pills {
  grid-area: pills; min-width: 0; overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent);
  mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent);
}
.project-ask-track { display: flex; gap: 8px; width: max-content; animation: projectPillMarquee 56s linear infinite; }
.project-ask-pills:hover .project-ask-track, .project-ask-track:focus-within { animation-play-state: paused; }
@keyframes projectPillMarquee { from { transform: translateX(0); } to { transform: translateX(calc(-50% - 4px)); } }
@media (prefers-reduced-motion: reduce) { .project-ask-track { animation: none; } }
.project-ask-pill {
  flex: 0 0 auto; border: 1px solid var(--line, #E2E8F0); border-radius: 999px;
  background: #fff; color: var(--text, #04395E); font: inherit; font-size: 14px;
  line-height: 1; font-weight: 700; padding: 9px 12px; cursor: pointer; white-space: nowrap;
}
.project-ask-form { grid-area: form; display: flex; gap: 8px; min-width: 0; }
.project-ask-form input {
  flex: 1; min-width: 0; border: 1px solid var(--line, #E2E8F0); border-radius: 999px;
  padding: 9px 14px; color: var(--text, #04395E); font: inherit; font-size: 14px;
  outline: none; background: #fff;
}
.project-ask-form button {
  border: 1px solid ${B.glassNavy}; border-radius: 999px; background: ${B.yellow};
  color: ${B.glassNavy}; font: inherit; font-size: 14px; font-weight: 800;
  padding: 9px 16px; cursor: pointer; white-space: nowrap;
}
.project-ask-form button:disabled, .project-ask-pills button:disabled { opacity: .5; cursor: default; }
.project-ask-answer {
  position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 9;
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  border: 1px solid var(--line, #E2E8F0); border-radius: 14px; background: #fff;
  padding: 12px 14px; font-size: 14px; line-height: 1.55; color: var(--text, #04395E);
  box-shadow: 0 18px 44px rgba(4, 57, 94, 0.16);
}
.project-ask-dismiss { border: 0; background: none; cursor: pointer; font-size: 13px; color: var(--muted, #475569); }
@media (max-width: 720px) {
  .project-ask-bar { grid-template-areas: 'title form' 'pills pills'; grid-template-columns: auto 1fr; }
}
@media print { .project-ask-wrap { display: none !important; } }
`;

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

  return (
    <div className="project-ask-wrap">
      <style>{ASK_CSS}</style>
      <section data-glass="card" className="project-ask-bar" aria-label="Waves AI — ask about this report">
        <span className="project-ask-title">Waves AI</span>
        <div className="project-ask-pills" aria-label="Example questions">
          <div className="project-ask-track">
            {[...PROMPTS, ...PROMPTS].map((prompt, i) => (
              <button
                data-glass="chip"
                type="button"
                key={`${prompt}-${i}`}
                className="project-ask-pill"
                onClick={() => ask(prompt)}
                disabled={asking}
                tabIndex={i < PROMPTS.length ? 0 : -1}
                aria-hidden={i >= PROMPTS.length}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
        <div className="project-ask-form">
          <input
            id="project-report-question"
            name="project_report_question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                ask();
              }
            }}
            placeholder="Ask Waves"
            aria-label="Ask Waves about this project report"
          />
          <button data-glass-accent="" type="button" onClick={() => ask()} disabled={asking || !question.trim()}>
            {asking ? 'Checking…' : 'Ask'}
          </button>
        </div>
        {answer && (
          <div className="project-ask-answer" role="status">
            <span>{answer}</span>
            <button type="button" className="project-ask-dismiss" onClick={() => setAnswer('')} aria-label="Dismiss answer">{'✕'}</button>
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectReviewAsk({ data }) {
  if (data?.hasLeftGoogleReview) return null;
  const location = reviewLocationForProject(data);
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
          background: B.yellow, color: B.glassNavy, fontWeight: 800,
          fontSize: 14, textDecoration: 'none', border: `1px solid ${B.glassNavy}`,
        }}
      >
        Share feedback
      </a>
    </section>
  );
}
