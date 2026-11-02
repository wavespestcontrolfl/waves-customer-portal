// Customer moving page (owner 2026-11-02, dark behind GATE_MOVING_FLOW): the
// link the office sends a customer who is moving. The customer types a new
// address, checks it, gives move-out and move-in dates, and sees a fixed
// receipt. Nothing here shows a price. Every sentence comes from this file or
// from the server; no model writes any of it.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WavesShell, CustomerColumn, PublicStateCard, BrandButton } from '../components/brand';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { DOC, DOC_FONT, DOC_FONT_SERIF, FS, FW, LH, SP, RADIUS, SHADOW } from '../theme-doc';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const SURFACE = {
  page: DOC.page,
  card: DOC.surface,
  border: DOC.border,
  text: DOC.ink,
  body: DOC.muted,
  muted: DOC.supporting,
  calloutBg: CUSTOMER_SURFACE.successBg,
  calloutBorder: CUSTOMER_SURFACE.successBorder,
  detailBg: '#F9F8F5',
};

const H1 = { fontFamily: DOC_FONT_SERIF, fontSize: FS.h2, fontWeight: FW.bold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading };
const H2 = { fontFamily: DOC_FONT_SERIF, fontSize: FS.h3, fontWeight: FW.semibold, color: SURFACE.text, margin: `0 0 ${SP.sm}px`, lineHeight: LH.heading };
const BODY = { fontSize: FS.bodyLg, lineHeight: LH.body, color: SURFACE.body, margin: `0 0 ${SP.md}px` };
const LABEL = { display: 'block', fontSize: FS.body, fontWeight: FW.medium, color: SURFACE.text, margin: `0 0 ${SP.xs}px` };
const INPUT = {
  width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '0 12px',
  border: `1px solid ${SURFACE.border}`, borderRadius: RADIUS.input, background: '#FFFFFF',
  fontFamily: DOC_FONT, fontSize: FS.bodyLg, color: SURFACE.text,
};
const CHECK_ROW = { display: 'flex', alignItems: 'center', gap: SP.sm, margin: `${SP.xs}px 0 0`, fontSize: FS.body, color: SURFACE.body };
const FIELD = { margin: `0 0 ${SP.lg}px` };
const ERROR = { fontSize: FS.body, color: '#B42318', margin: `0 0 ${SP.md}px` };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Nov 15, 2026" from an ISO date, with no time-zone hop.
function prettyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : null;
}

const OUT_OF_AREA_SENTENCE = 'We do not serve that address yet. We will contact you about your last visit and ending your plan on your move-out date.';

function serviceList(services) {
  if (!services || !services.length) return null;
  if (services.length === 1) return services[0];
  return `${services.slice(0, -1).join(', ')} and ${services[services.length - 1]}`;
}

function Card({ children }) {
  return (
    <CustomerColumn style={{ fontFamily: DOC_FONT, color: SURFACE.text }}>
      <div
        data-glass="card"
        style={{
          background: SURFACE.card, borderRadius: RADIUS.card, border: `1px solid ${SURFACE.border}`,
          boxShadow: SHADOW.card, padding: '28px 24px 32px',
        }}
      >
        {children}
        <div style={{ marginTop: SP.lg, paddingTop: SP.lg, borderTop: `1px solid ${SURFACE.border}` }}>
          <p style={{ fontSize: FS.body, color: SURFACE.muted, lineHeight: LH.body, margin: 0 }}>
            Questions? Call or text us at{' '}
            <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: SURFACE.text, fontWeight: FW.medium }}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>.
          </p>
        </div>
      </div>
    </CustomerColumn>
  );
}

function SavedSummary({ view, onEdit }) {
  const city = view.newCity;
  return (
    <>
      <h1 style={H1}>We have your move, {view.firstName}.</h1>
      <div
        data-glass="soft"
        style={{ background: SURFACE.detailBg, borderRadius: RADIUS.input, padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.lg}px` }}
      >
        <p style={{ ...BODY, margin: 0 }}>Move-out date: {prettyDate(view.moveOutDate) || 'not sure yet'}</p>
        <p style={{ ...BODY, margin: 0 }}>Move-in date: {prettyDate(view.moveInDate) || 'not sure yet'}</p>
        <p style={{ ...BODY, margin: 0 }}>New home: {city || 'address not added yet'}</p>
      </div>
      {view.verdict === 'out_of_area' && <p style={BODY}>{OUT_OF_AREA_SENTENCE}</p>}
      <p style={BODY}>You can add or change your address and dates at any time with this same link.</p>
      <BrandButton onClick={onEdit}>Add or change details</BrandButton>
    </>
  );
}

function Receipt({ lines, onEdit }) {
  return (
    <>
      <h1 style={H1}>Got it</h1>
      <div
        style={{
          borderLeft: `4px solid ${SURFACE.calloutBorder}`, background: SURFACE.calloutBg,
          borderRadius: `0 ${RADIUS.input}px ${RADIUS.input}px 0`, padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.lg}px`,
        }}
      >
        {lines.map((line) => <p key={line} style={{ ...BODY, margin: 0, color: SURFACE.text }}>{line}</p>)}
      </div>
      <p style={BODY}>You can open this same link to add or change anything.</p>
      <BrandButton variant="secondary" onClick={onEdit}>Add or change details</BrandButton>
    </>
  );
}

function DateField({ id, label, value, unsure, onValue, onUnsure }) {
  return (
    <div style={FIELD}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input
        id={id}
        type="date"
        style={{ ...INPUT, opacity: unsure ? 0.5 : 1 }}
        value={unsure ? '' : value}
        disabled={unsure}
        onChange={(e) => onValue(e.target.value)}
      />
      <label style={CHECK_ROW}>
        <input type="checkbox" checked={unsure} onChange={(e) => onUnsure(e.target.checked)} />
        Not sure yet
      </label>
    </div>
  );
}

function AddressConfirm({ check, onYes, onChange }) {
  const g = check.normalized || {};
  const google = [g.line1, g.line2, [g.city, [g.state, g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  return (
    <div
      data-glass="soft"
      style={{ background: SURFACE.detailBg, borderRadius: RADIUS.input, padding: `${SP.md}px ${SP.lg}px`, margin: `0 0 ${SP.lg}px` }}
    >
      <h2 style={H2}>Is this the right address?</h2>
      <p style={{ ...BODY, margin: `0 0 ${SP.xs}px` }}>You typed: {check.typed}</p>
      {google && <p style={{ ...BODY, margin: `0 0 ${SP.sm}px` }}>We found: {google}</p>}
      {check.verdict === 'out_of_area' && <p style={BODY}>{OUT_OF_AREA_SENTENCE}</p>}
      {check.verdict === 'unverified' && <p style={BODY}>We could not confirm that address. You can still send it and we will check it with you.</p>}
      <div style={{ display: 'flex', gap: SP.sm, flexWrap: 'wrap' }}>
        <BrandButton onClick={onYes}>Yes, that&rsquo;s it</BrandButton>
        <BrandButton variant="secondary" onClick={onChange}>Change it</BrandButton>
      </div>
    </div>
  );
}

function useMoveForm(view) {
  const [address, setAddress] = useState('');
  const [noAddress, setNoAddress] = useState(false);
  const [check, setCheck] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [moveOut, setMoveOut] = useState(view?.moveOutDate || '');
  const [moveIn, setMoveIn] = useState(view?.moveInDate || '');
  const [outUnsure, setOutUnsure] = useState(false);
  const [inUnsure, setInUnsure] = useState(false);
  return {
    address, setAddress, noAddress, setNoAddress, check, setCheck, confirmed, setConfirmed,
    moveOut, setMoveOut, moveIn, setMoveIn, outUnsure, setOutUnsure, inUnsure, setInUnsure,
  };
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
  return data;
}

// The address input, its "Not sure yet" box and the Check button.
function AddressField({ f, busy, canCheck, onCheck }) {
  const reset = () => { f.setCheck(null); f.setConfirmed(false); };
  return (
    <div style={FIELD}>
      <label htmlFor="moving-address" style={LABEL}>New address</label>
      {f.check && f.confirmed ? (
        <>
          <p style={{ ...BODY, margin: `0 0 ${SP.xs}px` }}>{f.check.typed}</p>
          <BrandButton variant="ghost" onClick={reset}>Change address</BrandButton>
        </>
      ) : (
        <AddressAutocomplete
          id="moving-address"
          value={f.address}
          disabled={f.noAddress}
          onChange={(v) => { f.setAddress(v); reset(); }}
          onSelect={(parts) => { f.setAddress(parts.formatted || parts.line1); reset(); }}
          placeholder="123 Main St, City"
          maxLength={200}
          geocodeOnBlur={false}
          style={{ ...INPUT, opacity: f.noAddress ? 0.5 : 1 }}
        />
      )}
      <label style={CHECK_ROW}>
        <input type="checkbox" checked={f.noAddress} onChange={(e) => { f.setNoAddress(e.target.checked); reset(); }} />
        Not sure yet
      </label>
      {!f.check && !f.noAddress && (
        <div style={{ marginTop: SP.sm }}>
          <BrandButton variant="secondary" disabled={!canCheck} onClick={onCheck}>
            {busy === 'check' ? 'Checking' : 'Check address'}
          </BrandButton>
        </div>
      )}
    </div>
  );
}

// What the form may do right now.
function formFlags(f, busy, view) {
  const hasOut = !!(f.outUnsure ? '' : f.moveOut);
  const addressPending = !f.noAddress && f.address.trim().length > 0 && !f.confirmed;
  return {
    addressPending,
    canSubmit: !busy && !addressPending && (f.confirmed || hasOut || !!view.addressOnFile),
    canCheck: !busy && !f.noAddress && f.address.trim().length >= 5,
  };
}

function MoveForm({ token, view, onDone }) {
  const f = useMoveForm(view);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const base = `${API_BASE}/public/moving/${token}`;
  const services = serviceList(view.services);
  const { addressPending, canSubmit, canCheck } = formFlags(f, busy, view);

  const runCheck = async () => {
    setBusy('check'); setError('');
    try {
      f.setCheck(await postJson(`${base}/check`, { address: f.address }));
      f.setConfirmed(false);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const submit = async () => {
    setBusy('submit'); setError('');
    try {
      onDone(await postJson(`${base}/submit`, {
        // The check the customer confirmed; none keeps the saved address.
        checkId: f.confirmed ? f.check.checkId : undefined,
        moveOutDate: f.outUnsure ? '' : f.moveOut,
        moveInDate: f.inUnsure ? '' : f.moveIn,
      }));
    } catch (e) {
      setError(e.message);
      // 409: another window checked a different address since; check again.
      if (e.status === 409) { f.setCheck(null); f.setConfirmed(false); }
    } finally { setBusy(''); }
  };

  return (
    <>
      <h1 style={H1}>Moving, {view.firstName}?</h1>
      <p style={BODY}>
        Tell us your new address and when you move.
        {services ? ` Your plan today: ${services}.` : ''} We will price your new home and show you before anything changes.
      </p>
      <p style={BODY}>Your WaveGuard level comes with you, and there is no setup fee at the new home.</p>

      <AddressField f={f} busy={busy} canCheck={canCheck} onCheck={runCheck} />

      {f.check && !f.confirmed && (
        <AddressConfirm
          check={f.check}
          onYes={() => f.setConfirmed(true)}
          onChange={() => { f.setCheck(null); f.setConfirmed(false); }}
        />
      )}
      {f.check && f.confirmed && f.check.verdict === 'out_of_area' && <p style={BODY}>{OUT_OF_AREA_SENTENCE}</p>}

      <DateField id="moving-out" label="Move-out date" value={f.moveOut} unsure={f.outUnsure} onValue={f.setMoveOut} onUnsure={f.setOutUnsure} />
      <DateField id="moving-in" label="Move-in date" value={f.moveIn} unsure={f.inUnsure} onValue={f.setMoveIn} onUnsure={f.setInUnsure} />

      {error && <p role="alert" style={ERROR}>{error}</p>}
      {addressPending && <p style={{ ...BODY, fontSize: FS.body }}>Check the address first, or tick &ldquo;Not sure yet&rdquo;.</p>}
      <BrandButton fullWidth disabled={!canSubmit} onClick={submit}>
        {busy === 'submit' ? 'Sending' : 'Send my move'}
      </BrandButton>
    </>
  );
}

export default function MovingPage() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [state, setState] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const [receipt, setReceipt] = useState(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState('loading');
      try {
        const res = await fetch(`${API_BASE}/public/moving/${token}`);
        if (cancelled) return;
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        setView(await res.json());
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token, attempt]);

  const onDone = useCallback((data) => {
    setReceipt(data.receipt || []);
    setView(data.view);
    setEditing(false);
  }, []);

  let content;
  if (state === 'loading') {
    content = <CustomerColumn><p style={BODY}>Loading</p></CustomerColumn>;
  } else if (state === 'error') {
    content = (
      <CustomerColumn>
        <PublicStateCard state="error" title="We couldn&rsquo;t load that page" onRetry={() => setAttempt((a) => a + 1)}>
          This looks temporary. Your link is still good. Check your connection and try again.
        </PublicStateCard>
      </CustomerColumn>
    );
  } else if (state === 'notfound' || !view) {
    content = (
      <CustomerColumn>
        <PublicStateCard state="not-found" title="Page not found" contact="call">
          This link is no longer available. Give us a call and we will help with your move.
        </PublicStateCard>
      </CustomerColumn>
    );
  } else if (receipt && !editing) {
    content = <Card><Receipt lines={receipt} onEdit={() => { setEditing(true); }} /></Card>;
  } else if (view.status === 'submitted' && !editing) {
    content = <Card><SavedSummary view={view} onEdit={() => setEditing(true)} /></Card>;
  } else {
    content = <Card><MoveForm token={token} view={view} onDone={onDone} /></Card>;
  }

  return (
    <>
      <meta name="robots" content="noindex, nofollow" />
      <WavesShell variant="customer" topBar="solid">
        <div data-glass-clear="" style={{ flex: 1, background: SURFACE.page }}>{content}</div>
      </WavesShell>
    </>
  );
}
