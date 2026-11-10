import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFieldPortalClass } from './fieldPortal';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { techEstimateRequest } from './useTechEstimates';
import TechMyEstimates from './TechMyEstimates';
import { INK, LineList, s, Totals } from './techEstimateParts';

// The technician estimate tool's phone screen (GATE_TECH_ESTIMATES, owner 2026-11-09), step 3 of 4: price a quote,
// save it as a draft, read his own. It sends nothing. The server prices; this screen only asks and shows.

const EMPTY_PROSPECT = { firstName: '', lastName: '', phone: '', address: '', city: '', zip: '' };
const PROSPECT_FIELDS = [
  ['firstName', 'First name', 'given-name'],
  ['lastName', 'Last name', 'family-name'],
  ['phone', 'Mobile phone', 'tel'],
  ['address', 'Street address', 'street-address'],
  ['city', 'City', 'address-level2'],
  ['zip', 'ZIP', 'postal-code'],
];
const FACTS = [
  ['homeSqFt', 'Home size', 'sq ft'],
  ['lotSqFt', 'Lot size', 'sq ft'],
  ['stories', 'Stories', ''],
  ['perimeterLF', 'Termite perimeter', 'ft'],
];
const FACT_PHRASE = { homeSqFt: 'the home size', lotSqFt: 'the lot size', stories: 'the number of stories', perimeterLF: 'the termite perimeter' };
const PRICE_CHANGED = 'The price changed. Check it, then save.';
const RETRY = 'Something went wrong. Try again.';

// The verdict, in plain words. Only the three server codes are known; anything else reads as the office check.
function reasonLine(code, holdDollars) {
  if (String(code).startsWith('changed_fact:')) {
    return `You changed ${FACT_PHRASE[String(code).slice('changed_fact:'.length)] || 'a measured fact'}.`;
  }
  if (code === 'one_time_over_limit') return `A one-time job over ${holdDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`;
  return 'The office must check this one.';
}

function Verdict({ officeFirst, holdDollars }) {
  if (!officeFirst?.required) return <p role="status" style={{ ...s.card, fontWeight: 500, marginBottom: 12 }}>This estimate is ready. Save it.</p>;
  return (
    <div role="status" style={{ ...s.notice, marginBottom: 12 }}>
      <strong>The office checks this one first.</strong>
      {officeFirst.reasons.map((code) => <div key={code}>{reasonLine(code, holdDollars)}</div>)}
    </div>
  );
}

// One measured fact with a Change control. An edit is only held here until "Update price".
function FactRow({ name, label, unit, fact, edit, onEdit, disabled }) {
  const shown = fact ? `${Number(fact.value).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}` : 'Not set';
  return (
    <div style={{ padding: '2px 0' }}>
      <div style={s.row}>
        <span>{label}: <strong>{shown}</strong>{fact?.source === 'technician' && <span style={{ color: '#57534e' }}> (you changed it)</span>}</span>
        {edit === undefined && <button type="button" style={s.small} disabled={disabled} aria-label={`Change ${label.toLowerCase()}`} onClick={() => onEdit(name, fact ? String(fact.value) : '')}>Change</button>}
      </div>
      {edit !== undefined && (
        <input
          aria-label={`New ${label.toLowerCase()}`} inputMode="numeric" style={{ ...s.input, marginBottom: 0 }}
          value={edit} onChange={(e) => onEdit(name, e.target.value)}
        />
      )}
    </div>
  );
}

function Quote({ priced, setup, keys, edits, onEdit, onUpdate, onSave, busy }) {
  const { answer } = priced;
  const pending = Object.entries(edits).filter(([name, v]) => /^\d+(\.\d+)?$/.test(v.trim()) && Number(v) !== Number(answer.facts?.[name]?.value));
  return (
    <div>
      <div style={s.card}>
        <LineList lines={answer.lines} />
        <Totals quote={answer} />
      </div>
      <div style={s.card}>
        <h4 style={{ margin: '0 0 4px', fontSize: 16, color: INK }}>What the lookup found</h4>
        {FACTS.filter(([name]) => name !== 'perimeterLF' || keys.includes('TERMITE_BAIT')).map(([name, label, unit]) => (
          <FactRow key={name} name={name} label={label} unit={unit} fact={answer.facts?.[name]} edit={edits[name]} onEdit={onEdit} disabled={busy} />
        ))}
        <p style={s.muted}>If you change a measured fact, the office checks the estimate before it goes.</p>
        {pending.length > 0 && <button type="button" style={{ ...s.secondary, marginTop: 10, marginBottom: 0 }} disabled={busy} onClick={() => onUpdate(pending)}>Update price</button>}
      </div>
      <Verdict officeFirst={answer.officeFirst} holdDollars={setup.oneTimeHoldDollars} />
      <button type="button" style={{ ...s.primary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={onSave}>{busy ? 'Working…' : 'Save estimate'}</button>
    </div>
  );
}

function Saved({ saved, onMine, onAnother }) {
  return (
    <div>
      <p role="status" style={{ ...s.card, fontWeight: 500 }}>
        {saved.officeFirst?.required
          ? 'Saved. The office checks it and sends it.'
          : 'Saved. Sending from the phone comes next; for now the office sends it.'}
      </p>
      <button type="button" style={s.primary} onClick={onMine}>My estimates</button>
      <button type="button" style={s.secondary} onClick={onAnother}>Another estimate</button>
    </div>
  );
}

function Problem({ problem, onHandOff }) {
  if (!problem) return null;
  return (
    <div role="alert" style={problem.office ? s.notice : s.error}>
      {problem.text}
      {problem.office && onHandOff && <div><button type="button" style={{ ...s.secondary, marginTop: 10, marginBottom: 0 }} onClick={onHandOff}>Flag it for the office</button></div>}
    </div>
  );
}

// Why a call failed, as words for the technician. The server's own message stands except for the two fixed answers.
function problemOf(err) {
  if (err.status === 422 && err.code === 'office_prices') return { office: true, text: 'The office needs to price this one.' };
  if (err.status === 502) return { text: 'The property lookup is not available right now. Try again.' };
  return { text: err.status && err.message ? err.message : RETRY };
}

function NewEstimate({ setup, customer, service, onHandOff, onMine }) {
  const handOffAllowed = useFeatureFlag('commission_sold_by', false);
  const [prospect, setProspect] = useState(EMPTY_PROSPECT);
  const [keys, setKeys] = useState([]);
  const [priced, setPriced] = useState(null); // { body, answer, draftId }: one id for each priced quote
  const [edits, setEdits] = useState({});
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const typed = Object.fromEntries(Object.entries(prospect).map(([k, v]) => [k, v.trim()]));
  const reset = () => { setPriced(null); setEdits({}); setNotice(''); setProblem(null); };
  const run = async (work) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try { await work(); } finally { inFlight.current = false; setBusy(false); }
  };
  const price = (body, note = '') => run(async () => {
    try {
      const answer = await techEstimateRequest('/price', { method: 'POST', body });
      setPriced({ body, answer, draftId: crypto.randomUUID() });
      setEdits({});
      setNotice(note);
    } catch (err) { setProblem(problemOf(err)); }
  });

  const getPrice = () => {
    if (!customer && ['firstName', 'phone', 'address', 'zip'].some((k) => !typed[k])) {
      setProblem({ text: 'First name, phone, address and ZIP are required.' });
      return;
    }
    if (keys.length === 0) { setProblem({ text: 'Pick at least one service.' }); return; }
    reset();
    price({ ...(customer ? { customerId: customer.id } : { prospect: typed }), services: keys });
  };
  const update = (pending) => {
    const facts = { ...(priced.body.facts || {}), ...Object.fromEntries(pending.map(([name, v]) => [name, Number(v)])) };
    price({ ...priced.body, facts });
  };
  const save = () => run(async () => {
    try {
      const result = await techEstimateRequest('', { method: 'POST', body: { ...priced.body, clientDraftId: priced.draftId, digest: priced.answer.digest } });
      setSaved(result);
    } catch (err) {
      if (err.status === 409 && err.code === 'price_changed') {
        // The price moved since the preview: price the same quote again (a new id), then ask him to look.
        try {
          const answer = await techEstimateRequest('/price', { method: 'POST', body: priced.body });
          setPriced({ body: priced.body, answer, draftId: crypto.randomUUID() });
          setEdits({});
          setNotice(PRICE_CHANGED);
        } catch (again) { setProblem(problemOf(again)); }
        return;
      }
      setProblem(problemOf(err));
    }
  });

  if (saved) return <Saved saved={saved} onMine={onMine} onAnother={() => { setSaved(null); setKeys([]); setProspect(EMPTY_PROSPECT); reset(); }} />;
  const canHandOff = customer ? true : handOffAllowed;
  return (
    <div>
      {customer ? (
        <div style={s.card}>
          <div style={{ fontSize: 16, fontWeight: 500, color: INK }}>{customer.name}</div>
          {customer.address && <div style={{ fontSize: 14, color: '#57534e', marginTop: 2 }}>{customer.address}</div>}
        </div>
      ) : (
        <div>
          <p style={{ ...s.muted, margin: '0 0 10px' }}>A new person. Get their mobile phone and address.</p>
          {PROSPECT_FIELDS.map(([key, label, autoComplete]) => (
            <label key={key} style={s.label}>
              {label}
              <input
                autoComplete={autoComplete} disabled={busy} style={{ ...s.input, marginTop: 4, fontWeight: 400 }}
                inputMode={key === 'phone' ? 'tel' : key === 'zip' ? 'numeric' : undefined}
                value={prospect[key]} onChange={(e) => { setProspect((p) => ({ ...p, [key]: e.target.value })); reset(); }}
              />
            </label>
          ))}
        </div>
      )}
      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 14px' }} disabled={busy}>
        <legend style={s.label}>Services</legend>
        {setup.services.map((svc) => (
          <label key={svc.key} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 16, color: INK }}>
            <input
              type="checkbox" style={{ width: 20, height: 20 }} checked={keys.includes(svc.key)}
              onChange={(e) => { setKeys((k) => (e.target.checked ? [...k, svc.key] : k.filter((x) => x !== svc.key))); reset(); }}
            />
            {svc.label}
          </label>
        ))}
      </fieldset>
      {notice && <div role="status" style={s.notice}>{notice}</div>}
      <Problem problem={problem} onHandOff={canHandOff ? () => onHandOff({ service, prospect: customer ? null : typed }) : null} />
      {priced ? (
        <Quote priced={priced} setup={setup} keys={priced.body.services} edits={edits} busy={busy} onSave={save} onUpdate={update}
          onEdit={(name, value) => setEdits((e) => ({ ...e, [name]: value }))} />
      ) : (
        <button type="button" style={{ ...s.primary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={getPrice}>{busy ? 'Getting the price…' : 'Get price'}</button>
      )}
    </div>
  );
}

// `service` is the visit it was opened from (null from the general entry: a new person, or My estimates).
export default function TechEstimateSheet({ setup, service = null, onClose, onHandOff }) {
  const fieldPortalClass = useFieldPortalClass();
  const isMobile = useIsMobile();
  const dialogRef = useModalFocus(true, onClose);
  const [tab, setTab] = useState('new');
  const customerId = service && (service.customer_id || service.customerId);
  const customer = customerId
    ? { id: customerId, name: service.customerName || service.customer_name || 'Customer', address: service.address || '' }
    : null;
  return createPortal(
    <div ref={dialogRef} className={fieldPortalClass || undefined} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Estimate" style={{
      position: 'fixed', inset: 0, zIndex: 9999, fontFamily: '"Roboto", system-ui, sans-serif',
      display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(28,25,23,0.45)',
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#fff', borderRadius: isMobile ? 0 : 6, width: isMobile ? '100%' : '90%', maxWidth: isMobile ? 'none' : 520,
        height: isMobile ? '100%' : undefined, maxHeight: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)', boxShadow: '0 20px 60px rgba(28,25,23,0.18)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, padding: '12px 16px 0 16px' }}>
          <h3 style={{ margin: 0, fontSize: 18, color: INK }}>Estimate</h3>
          <button type="button" aria-label="Close" onClick={onClose} style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#78716c' }}>&times;</button>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px', flexShrink: 0 }}>
          {[['new', 'New estimate'], ['mine', 'My estimates']].map(([key, label]) => (
            <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} style={{
              flex: 1, minHeight: 44, borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: 'pointer',
              border: tab === key ? 'none' : `1px solid #d6d3d1`, background: tab === key ? INK : '#fff', color: tab === key ? '#fff' : '#57534e',
            }}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 24px' }}>
          {/* Kept mounted while My estimates is open, so a priced quote is not lost. */}
          <div hidden={tab !== 'new'}>
            <NewEstimate setup={setup} customer={customer} service={service} onMine={() => setTab('mine')} onHandOff={onHandOff} />
          </div>
          {tab === 'mine' && <TechMyEstimates />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
