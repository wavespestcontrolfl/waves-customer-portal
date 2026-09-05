/**
 * DEV HARNESS — the customer glass showcase. Renders the REAL shared customer
 * primitives (WavesShell, BrandCard, BrandButton, DocumentActionBar, the
 * data-glass tiers, the data-gt type roles, the Ask Waves card markup) under
 * the live glass sheet with synthetic data, so every role can be checked at
 * any width in one page. Served by `npx vite` at /preview-tokens.html.
 * NOT part of the app build (no rollup input) — never a public route.
 * Fixtures are fictional; the long-name / long-address / large-balance rows
 * exist to exercise wrapping.
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../index.css';
import '../styles/brand-tokens.css';
import '../glass/glass-theme.css';
import { useGlassSurface } from '../glass/glass-engine';
import { WavesShell, BrandCard, BrandButton } from '../components/brand';
import DocumentActionBar from '../components/DocumentActionBar';
import PublicLoadError from '../components/PublicLoadError';
import Icon from '../components/Icon';
import { DOC_EYEBROW, DOC_COLUMN, FS, FW, LH, SP } from '../theme-doc';

const LONG_NAME = 'Alexandria Montgomery-Vanderbilt-Castellanos';
const LONG_ADDRESS = '17845 Northwest Sarasota Bayfront Boulevard, Building C, Unit 1204, Lakewood Ranch, FL 34202';
const BIG_BALANCE = '$12,480.75';

function Section({ id, title, children }) {
  return (
    <section id={id} data-glass="card" style={{ padding: 24, marginTop: 16, position: 'relative' }}>
      <div data-gt="eyebrow" style={DOC_EYEBROW}>{title}</div>
      {children}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 160px) minmax(0, 1fr)', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: '1px solid rgba(4,57,94,0.12)' }}>
      <div style={{ fontSize: FS.body, color: '#3F4A65' }}>{label}</div>
      <div style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function TypeScale() {
  return (
    <Section id="type" title="Type roles · one system stack">
      <h1 style={{ marginTop: 12 }}>Hello Pat, your pest-free Parrish plan is ready!</h1>
      <p style={{ fontSize: FS.lead, lineHeight: LH.body, color: '#3F4A65', margin: '12px 0 0', maxWidth: '62ch' }}>
        Body prose at 16px: we can start protecting your home as soon as Tuesday. Your plan includes exterior and interior pest protection, unlimited free callbacks, and a 90-day money-back guarantee.
      </p>
      <h2 style={{ marginTop: 20 }}>Section heading (h2, 26px)</h2>
      <h3 style={{ marginTop: 12 }}>Card title (h3, 20px)</h3>
      <div data-gt="eyebrow" style={{ ...DOC_EYEBROW, marginTop: 12 }}>Eyebrow · 14 / 600 / .06em</div>
      <div style={{ fontSize: FS.body, color: '#3F4A65', marginTop: 8 }}>Meta row at 14px — the floor. Table cells, footer, helper copy.</div>
      <div data-gt="fine" style={{ marginTop: 8 }}>Fine print at 14px: licensed &amp; insured · FL License #JB35154.</div>
      <div data-gt="metric" style={{ fontSize: 32, marginTop: 12 }}>{BIG_BALANCE}</div>
      <div style={{ fontSize: FS.body, color: '#3F4A65' }}>Numeric role — 700, tabular figures, ink.</div>
    </Section>
  );
}

function GlassTiers() {
  return (
    <Section id="glass" title="Glass tiers · card / soft / chip">
      <p style={{ fontSize: FS.lead, color: '#3F4A65', margin: '12px 0 0' }}>This section is the <code>card</code> tier (blur 32, the estimate's warm tint, r12). Inside it:</p>
      <div data-glass="soft" style={{ padding: 16, marginTop: 12, position: 'relative' }}>
        <h3 style={{ marginTop: 0 }}>Soft inner box</h3>
        <p style={{ fontSize: FS.body, color: '#3F4A65', margin: '6px 0 0' }}>Blur 18, r10 — findings, pricing tiers, question lists live here.</p>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button type="button" data-glass="chip" data-glass-pill="" style={{ padding: '0 14px', fontSize: 14, border: '1px solid rgba(4,57,94,0.16)' }}>Chip · 40px pill</button>
        <button type="button" data-glass="chip" data-glass-pill="" style={{ padding: '0 14px', fontSize: 14, border: '1px solid rgba(4,57,94,0.16)' }}>Tomorrow morning</button>
        <button type="button" data-glass="chip" data-glass-pill="" disabled style={{ padding: '0 14px', fontSize: 14, border: '1px solid rgba(4,57,94,0.16)', opacity: 0.55 }}>Disabled chip</button>
      </div>
      <p style={{ fontSize: FS.body, color: '#3F4A65', margin: '12px 0 0' }}>
        Solid fallback: with <code>backdrop-filter</code> unsupported, <code>prefers-reduced-transparency</code>, or <code>forced-colors</code>, every tier renders 93% white with a real border and no sheen.
      </p>
    </Section>
  );
}

function Actions() {
  return (
    <Section id="actions" title="Actions · gold primary, quiet secondary">
      <Row label="Primary 48px"><BrandButton onClick={() => {}}>Approve my plan</BrandButton></Row>
      <Row label="Disabled"><BrandButton disabled onClick={() => {}}>Send code</BrandButton></Row>
      <Row label="Secondary"><BrandButton variant="secondary" onClick={() => {}}>Show all open times</BrandButton></Row>
      <Row label="Ghost"><BrandButton variant="ghost" onClick={() => {}}>Not now</BrandButton></Row>
      <Row label="Gold accent link"><a href="#actions" data-glass-accent="" style={{ display: 'inline-flex', alignItems: 'center', padding: '0 20px', textDecoration: 'none' }}>Pay {BIG_BALANCE} now</a></Row>
      <Row label="Long label">
        <BrandButton onClick={() => {}}>Reserve Thursday, September 10 at 9:00 AM and text me the confirmation</BrandButton>
      </Row>
      <Row label="Document bar"><div style={{ width: '100%' }}><DocumentActionBar pdfUrl="#" pdfFileName="Waves_Sample.pdf" shareTitle="Waves sample document" /></div></Row>
    </Section>
  );
}

function Forms() {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const invalid = touched && value.trim().length < 3;
  return (
    <Section id="forms" title="Forms · 48px inputs, 16px text, 14px placeholder">
      <label htmlFor="sc-name" style={{ display: 'block', fontSize: FS.lead, fontWeight: FW.semibold, marginTop: 12 }}>Full name</label>
      <input
        id="sc-name" type="text" value={value} placeholder="First and last name"
        onChange={(e) => setValue(e.target.value)} onBlur={() => setTouched(true)}
        aria-invalid={invalid ? 'true' : undefined} aria-describedby={invalid ? 'sc-name-err' : undefined}
        style={{ width: '100%', minHeight: 48, padding: '12px 16px', fontSize: 16, border: `1px solid ${invalid ? '#C8102E' : 'rgba(4,57,94,0.16)'}`, background: 'rgba(255,255,255,0.8)', color: '#04395E', marginTop: 6 }}
      />
      {invalid ? <div id="sc-name-err" role="alert" style={{ fontSize: FS.body, color: '#C8102E', marginTop: 6 }}>Enter at least three characters.</div> : null}
      <label htmlFor="sc-when" style={{ display: 'block', fontSize: FS.lead, fontWeight: FW.semibold, marginTop: 16 }}>Preferred time</label>
      <select id="sc-when" defaultValue="" style={{ width: '100%', minHeight: 48, padding: '0 16px', fontSize: 16, border: '1px solid rgba(4,57,94,0.16)', background: 'rgba(255,255,255,0.8)', color: '#04395E', marginTop: 6 }}>
        <option value="" disabled>Choose a window</option>
        <option>Morning · 8–11 AM</option>
        <option>Midday · 11 AM–2 PM</option>
        <option>Afternoon · 2–5 PM</option>
      </select>
      <label htmlFor="sc-notes" style={{ display: 'block', fontSize: FS.lead, fontWeight: FW.semibold, marginTop: 16 }}>Anything we should know?</label>
      <textarea id="sc-notes" rows={3} placeholder="Gate code, pets, problem areas…" style={{ width: '100%', padding: '12px 16px', fontSize: 16, border: '1px solid rgba(4,57,94,0.16)', background: 'rgba(255,255,255,0.8)', color: '#04395E', marginTop: 6, resize: 'vertical' }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: FS.lead, marginTop: 16, minHeight: 44 }}>
        <input type="checkbox" defaultChecked style={{ width: 20, height: 20 }} /> Text me when the technician is on the way
      </label>
    </Section>
  );
}

function ListsAndAlerts() {
  return (
    <Section id="lists" title="List rows, alerts, Ask Waves">
      <div className="waves-ask-card" data-glass="soft" style={{ marginTop: 12 }}>
        <div className="waves-ask-eyebrow" data-gt="eyebrow" style={DOC_EYEBROW}>Ask Waves</div>
        <h2 className="waves-ask-title">Questions about today's service? Ask anything</h2>
        <p className="waves-ask-intro">What was applied, when you can go back in, what to watch for, or your next visit — straight answers in seconds.</p>
        <form className="waves-ask-form" onSubmit={(e) => e.preventDefault()}>
          <input type="text" placeholder="Ask about today's service" aria-label="Ask Waves" />
          <button type="submit" data-glass-accent="">Ask</button>
        </form>
        <div className="waves-ask-list" data-glass="soft" role="list">
          {['When can I re-enter treated areas?', 'Why was Termidor SC used?', 'What should I watch for next?'].map((q, i) => (
            <div role="listitem" key={q}>
              <button type="button" className="waves-ask-row" data-first={i === 0 ? '' : undefined}>
                <span>{q}</span>
                <span aria-hidden="true" className="waves-ask-go">Ask ›</span>
              </button>
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <Row label="Customer">{LONG_NAME}</Row>
        <Row label="Address">{LONG_ADDRESS}</Row>
        <Row label="Balance"><span data-gt="metric" style={{ fontSize: 20 }}>{BIG_BALANCE}</span></Row>
      </div>
      <div role="alert" style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: 'rgba(200,16,46,0.08)', border: '1px solid rgba(200,16,46,0.28)', color: '#9F1239', fontSize: FS.lead, display: 'flex', gap: SP.sm, alignItems: 'center' }}>
        <Icon name="warning" size={18} strokeWidth={2} /><span>This invoice is overdue. Please pay at your earliest convenience.</span>
      </div>
      <div role="status" style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)', color: '#166534', fontSize: FS.lead, display: 'flex', gap: SP.sm, alignItems: 'center' }}>
        <Icon name="check" size={18} strokeWidth={2} /><span>Confirmed. See you Thursday, September 10 between 9:00 and 11:00 AM.</span>
      </div>
    </Section>
  );
}

function States() {
  const [busy, setBusy] = useState(true);
  return (
    <Section id="states" title="Loading, empty, error">
      <Row label="Skeleton">
        <div aria-hidden="true" style={{ width: '100%', display: 'grid', gap: 8 }}>
          {[80, 60, 70].map((w) => <div key={w} style={{ height: 14, width: `${w}%`, borderRadius: 999, background: 'rgba(4,57,94,0.10)' }} />)}
        </div>
      </Row>
      <Row label="Empty">
        <div style={{ fontSize: FS.lead, color: '#3F4A65' }}>No visits scheduled yet. When one is booked it appears here with the arrival window.</div>
      </Row>
      <Row label="Load error">
        <div style={{ width: '100%' }}><PublicLoadError onRetry={() => setBusy(!busy)} resource="report" /></div>
      </Row>
    </Section>
  );
}

function Showcase() {
  useGlassSurface(true);
  return (
    <WavesShell>
      {/* WavesShell owns the page's one <main>; the showcase is a plain column. */}
      <div style={{ width: DOC_COLUMN, margin: '32px auto 56px', padding: '0 0 24px' }}>
        <div data-gt="eyebrow" style={DOC_EYEBROW}>Customer glass showcase · dev only</div>
        <h1>One sheet for every customer page</h1>
        <p style={{ fontSize: FS.lead, color: '#3F4A65', margin: '12px 0 0', maxWidth: '62ch' }}>
          Real shared components under the live glass sheet with fictional data. Resize to 360 / 390 / 430 / 768 / 1440 and tab through every control.
        </p>
        <nav aria-label="Sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          {[['type', 'Type'], ['glass', 'Glass'], ['actions', 'Actions'], ['forms', 'Forms'], ['lists', 'Lists & alerts'], ['states', 'States']].map(([id, label]) => (
            <a key={id} href={`#${id}`} data-glass="chip" data-glass-pill="" style={{ display: 'inline-flex', alignItems: 'center', padding: '0 14px', fontSize: 14, textDecoration: 'none', border: '1px solid rgba(4,57,94,0.16)' }}>{label}</a>
          ))}
        </nav>
        <BrandCard padding={24} style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>BrandCard</h3>
          <p style={{ fontSize: FS.body, color: '#3F4A65', margin: '6px 0 0' }}>The pay / receipt / statement card primitive — same card tier, 24px padding.</p>
        </BrandCard>
        <TypeScale />
        <GlassTiers />
        <Actions />
        <Forms />
        <ListsAndAlerts />
        <States />
      </div>
    </WavesShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Showcase />
    </BrowserRouter>
  </React.StrictMode>,
);
