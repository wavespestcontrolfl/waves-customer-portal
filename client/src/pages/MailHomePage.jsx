/**
 * /h/:token — the page a new homeowner reaches from the QR code on a Waves postcard (mailer step 2c).
 *
 * The visitor is a stranger with no account. The page shows the home's street address, the quarterly pest control
 * price we worked out for it (or "Call us for your price" when there is none) and one action: call us.
 * Data: GET /api/public/home/:token (server/routes/mail-home-public.js). Any failure, a dead link and the gate being
 * off all read the same: one friendly "not available" state, so the page never hints whether a token exists.
 *
 * The logo, the header phone link, the license line and the business address come from WavesShell (App.jsx wraps this
 * page like /card/:token); the page does not repeat them. The plan lines come from glassPestInclusions, the same
 * list the estimate shows for the quarterly pest plan.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BrandCard, CustomerColumn, PublicStateCard } from '../components/brand';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { glassPestInclusions } from '../lib/estimate-glass-copy';
import { useGlassSurface } from '../glass/glass-engine';
import { DOC, DOC_EYEBROW, FS, FW, LH, SP, docHeading } from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Cents only when the amount is not whole: $37 a month, $37.50 a month.
function formatMoney(value) {
  const n = Number(value);
  const whole = Number.isInteger(n);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// glassPestInclusions(4) = protected 4x a year, then interior included, then free callbacks. The first line
// ("Premium non-repellent...") and the last two (guarantee, contract) are left out of this short page.
const PLAN_LINES = glassPestInclusions(4).slice(1, 4);

const callButtonStyle = {
  minHeight: 48,
  width: '100%',
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 20px',
  border: 'none',
  borderRadius: 10,
  background: DOC.navyLiteral,
  color: '#FFFFFF',
  fontSize: FS.bodyLg,
  fontWeight: FW.bold,
  textDecoration: 'none',
  textTransform: 'none',
  letterSpacing: 0,
  cursor: 'pointer',
};

function Unavailable() {
  return (
    <CustomerColumn column="flow">
      <PublicStateCard state="not-found" title="This page is not available" contact="call">
        Call us and we will help.
      </PublicStateCard>
    </CustomerColumn>
  );
}

export default function MailHomePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | unavailable
  useGlassSurface(true);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    fetch(`${API_BASE}/public/home/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        if (json && json.address) { setData(json); setStatus('ready'); } else setStatus('unavailable');
      })
      .catch(() => { if (alive) setStatus('unavailable'); });
    return () => { alive = false; };
  }, [token]);

  if (status === 'loading') {
    return (
      <CustomerColumn column="flow">
        <p role="status" style={{ margin: 0, textAlign: 'center', fontSize: FS.bodyLg, color: DOC.supporting }}>
          Loading your page&hellip;
        </p>
      </CustomerColumn>
    );
  }
  if (status === 'unavailable') return <Unavailable />;

  const line1 = data.address.line1 || null;
  const city = data.address.city || null;
  const price = data.price;
  const setupFee = price && Number(price.setupFee) > 0 ? Number(price.setupFee) : null;

  return (
    <CustomerColumn column="flow">
      <div data-gt="eyebrow" style={DOC_EYEBROW}>Waves Pest Control</div>
      <h1 style={docHeading(1)}>Welcome to your new home</h1>
      {(line1 || city) && (
        <p data-testid="address" style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.sub, lineHeight: LH.snug, color: DOC.muted }}>
          {line1}
          {line1 && city ? <br /> : null}
          {city}
        </p>
      )}

      <BrandCard style={{ marginTop: SP.xl, textAlign: 'center' }}>
        {price ? (
          <>
            <div data-testid="monthly-price" style={{ fontSize: 44, fontWeight: FW.bold, lineHeight: LH.display, color: DOC.ink, letterSpacing: '-0.02em' }}>
              {formatMoney(price.monthly)} a month
            </div>
            <p style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
              Quarterly pest control{line1 ? ` for ${line1}` : ''}
            </p>
            {setupFee ? (
              <p style={{ margin: `${SP.xs}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
                One-time setup: {formatMoney(setupFee)}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div style={{ fontSize: FS.h2, fontWeight: FW.bold, lineHeight: LH.heading, color: DOC.ink }}>
              Call us for your price
            </div>
            <p style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
              Quarterly pest control{line1 ? ` for ${line1}` : ''}
            </p>
          </>
        )}
      </BrandCard>

      <BrandCard style={{ marginTop: SP.md }}>
        <h2 style={{ ...docHeading(3), marginBottom: SP.sm }}>What the plan includes</h2>
        <ul style={{ margin: 0, paddingLeft: SP.lg, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
          {PLAN_LINES.map((line) => (
            <li key={line} style={{ marginTop: SP.xs }}>{line}</li>
          ))}
        </ul>
      </BrandCard>

      <div style={{ marginTop: SP.xl }}>
        <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" data-glass-size="primary" style={callButtonStyle}>
          Call {WAVES_SUPPORT_PHONE_DISPLAY}
        </a>
      </div>
    </CustomerColumn>
  );
}
