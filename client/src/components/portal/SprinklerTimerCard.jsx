/**
 * "Your sprinkler timer" on My Property, under the weekly watering plan (owner 2026-11-19, sprinkler timer connect,
 * step 1). The customer says which timer is on the wall and whether they run it from the maker's phone app; the card
 * then links the Waves guide for that timer. It records and links, nothing more: the portal does not connect to,
 * pause or start a timer, and this card must not say that it can or will.
 *
 * The three values live on property_preferences and save through the Property tab's own autosave (onChange). They are
 * one record: every change sends all three together, and the server saves them whole or not at all. Keys, labels and
 * the rule for who gets the phone-app question come from @waves/irrigation-runtime, which the server uses too.
 */
import { useState } from 'react';
import { CONTROLLER_BRANDS, CONTROLLER_MODELS, CONTROLLER_APP_ANSWERS, controllerAsksAboutApp } from '@waves/irrigation-runtime';
import Icon from '../Icon';
import { COLORS as B, FONTS, BUTTON_BASE } from '../../theme-brand';

const BODY = '#3F4A65';
const RULE = '#D8D0C0';
const HUB = 'https://www.wavespestcontrol.com/sprinkler-timers/';

const cardStyle = {
  padding: 24, borderRadius: 12, border: '1px solid #E7E2D7',
  background: B.white, color: B.glassNavy, fontFamily: FONTS.ui,
  fontSize: 16, lineHeight: 1.55,
};
const prose = { margin: '0 0 16px', color: BODY };
const meta = { fontSize: 14, color: BODY, lineHeight: 1.45 };
const buttonBase = { ...BUTTON_BASE, letterSpacing: 0, boxShadow: 'none', cursor: 'pointer' };

// What a customer reads on the box, in the words of the Waves Hunter guide. Every guide is named as a Waves guide
// (owner 2026-11-19: Waves content always says Waves, never "our").
const MODEL_HINTS = {
  x2: 'A box with a dial. X2 is printed on the front.',
  x_core: 'A box with a dial. X-Core is printed on the front.',
  pro_c: 'A larger box with a dial and room for extra zones.',
  hydrawise: 'No dial. A touchscreen on the box, and the Hydrawise phone app.',
};

const HUNTER_GUIDE = { url: `${HUB}hunter/`, cta: 'How to run it on a Hunter', line: 'The Waves Hunter guide shows how to run this week\'s plan on your timer.' };
// The question's words, by brand. Who is asked is controllerAsksAboutApp: an X-Core has no phone app, so it is not.
const APP_QUESTIONS = { hunter: 'Do you run it from Hunter\'s Hydrawise phone app?', rain_bird: 'Do you run it from the Rain Bird phone app?' };
// One entry per timer the card can show.
const TIMERS = {
  x2: { name: 'Hunter X2', ...HUNTER_GUIDE },
  x_core: { name: 'Hunter X-Core', ...HUNTER_GUIDE },
  pro_c: { name: 'Hunter Pro-C', ...HUNTER_GUIDE },
  hydrawise: { name: 'Hunter Hydrawise timer', ...HUNTER_GUIDE },
  rain_bird: {
    name: 'Rain Bird', url: `${HUB}rain-bird/`, cta: 'How to run it on a Rain Bird',
    line: 'The Waves Rain Bird guide shows how to run this week\'s plan on your timer.',
  },
  other: {
    name: 'Another brand', url: HUB, cta: 'See the Waves timer guides',
    line: 'The Waves timer guides cover the most common brands. This week\'s plan gives the minutes for any timer.',
  },
};

// The timer on file, or null while there is nothing complete to show (no brand, or a Hunter with no model yet).
function timerOnFile(brand, model) {
  if (brand === 'hunter') return TIMERS[model] && model in CONTROLLER_MODELS ? TIMERS[model] : null;
  return brand === 'rain_bird' || brand === 'other' ? TIMERS[brand] : null;
}

function ChoiceChip({ active, onClick, children }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      {...(active ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })} style={{
        ...buttonBase, minHeight: 44, padding: '8px 14px', borderRadius: 8, fontSize: 14, fontWeight: 700,
        background: active ? '#F8FCFE' : '#fff', color: B.glassNavy, border: `1px solid ${active ? B.yellow : RULE}`,
      }}>{children}</button>
  );
}

function TextButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      ...buttonBase, minHeight: 44, padding: '0 2px', border: 'none', background: 'transparent',
      color: B.glassNavy, fontSize: 14, fontWeight: 600, textDecoration: 'underline',
    }}>{children}</button>
  );
}

function LinkOut({ href, children }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: B.glassNavy, textDecoration: 'underline', fontWeight: 600 }}>{children}</a>;
}

function Picker({ startBrand, onPick, onCancel }) {
  const [brand, setBrand] = useState(startBrand || 'hunter');
  return (
    <>
      <p style={prose}>Tell us which timer runs your sprinklers, and we'll show the Waves guide for it.</p>
      <div role="group" aria-label="Timer brand" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {Object.entries(CONTROLLER_BRANDS).map(([key, label]) => (
          <ChoiceChip key={key} active={brand === key} onClick={() => setBrand(key)}>{label}</ChoiceChip>
        ))}
      </div>
      {brand === 'hunter' ? (
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {Object.entries(CONTROLLER_MODELS).map(([key, label]) => (
            <button key={key} type="button" data-glass="chip" onClick={() => onPick('hunter', key)} style={{
              ...buttonBase, minHeight: 64, padding: '12px 14px', borderRadius: 10, border: `1px solid ${RULE}`, background: '#fff',
              color: B.glassNavy, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <span>
                <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{label}</span>
                <span style={{ display: 'block', ...meta, fontWeight: 400 }}>{MODEL_HINTS[key]}</span>
              </span>
              <Icon name="chevronRight" size={18} strokeWidth={2} />
            </button>
          ))}
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <button type="button" data-glass="chip" onClick={() => onPick(brand, null)} style={{
            ...buttonBase, minHeight: 44, padding: '10px 14px', borderRadius: 10, border: `1px solid ${RULE}`,
            background: '#fff', color: B.glassNavy, fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            <Icon name="check" size={16} strokeWidth={2} />
            {brand === 'rain_bird' ? 'My timer is a Rain Bird' : 'My timer is another brand'}
          </button>
        </div>
      )}
      <p style={{ ...meta, margin: 0 }}>Not sure? The name is printed on the front of the box. <LinkOut href={`${HUB}identify/`}>See what each one looks like</LinkOut></p>
      {onCancel && <div style={{ marginTop: 8 }}><TextButton onClick={onCancel}>Keep my timer</TextButton></div>}
    </>
  );
}

function OnFile({ timer, saved, appQuestion, app, onApp, onChangeTimer }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: '#94A3B8', flexShrink: 0 }} />
        <span style={{ fontWeight: 700 }}>{timer.name}</span>
        <span style={meta}>{saved ? 'On file' : 'Not saved'}</span>
      </div>
      <p style={prose}>{timer.line}</p>
      {appQuestion && (
        <div role="group" aria-label={appQuestion} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{appQuestion}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(CONTROLLER_APP_ANSWERS).map(([key, label]) => (
              <ChoiceChip key={key} active={app === key} onClick={() => onApp(app === key ? null : key)}>{label}</ChoiceChip>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gap: 12 }}>
        <a href={timer.url} target="_blank" rel="noopener noreferrer" data-glass-accent="" data-glass-size="primary" style={{
          ...buttonBase, minHeight: 48, padding: '12px 16px', borderRadius: 10, border: `1px solid ${B.yellow}`, background: B.yellow,
          color: B.glassNavy, fontSize: 16, fontWeight: 700, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{timer.cta}</a>
        <div><TextButton onClick={onChangeTimer}>Change my timer</TextButton></div>
      </div>
    </>
  );
}

export default function SprinklerTimerCard({ brand = null, model = null, app = null, error = '', onChange }) {
  const [picking, setPicking] = useState(false);
  const timer = timerOnFile(brand, model);
  // Only a Hunter has a model on the list.
  const modelOnFile = brand === 'hunter' ? model : null;
  // Every change sends the whole timer, so an answer can never land on a timer the customer did not see.
  const save = (nextBrand, nextModel, nextApp) => onChange({
    irrigationControllerBrand: nextBrand, irrigationControllerModel: nextModel, irrigationControllerApp: nextApp,
  });
  // A new timer is a new box: the app answer on file was about the old one.
  const pick = (nextBrand, nextModel) => {
    setPicking(false);
    if (nextBrand === brand && nextModel === modelOnFile) return;
    save(nextBrand, nextModel, null);
  };
  return (
    <section data-glass="card" style={cardStyle} aria-label="Your sprinkler timer">
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Your sprinkler timer</h2>
      {timer && !picking
        ? (
          // The timer shows as the customer set it; while the server refuses it, it is not on file.
          <OnFile timer={timer} saved={!error} appQuestion={controllerAsksAboutApp(brand, modelOnFile) ? APP_QUESTIONS[brand] : null}
            app={app} onApp={(next) => save(brand, modelOnFile, next)} onChangeTimer={() => setPicking(true)} />
        )
        : <Picker startBrand={brand} onPick={pick} onCancel={timer ? () => setPicking(false) : null} />}
      {error && <p role="alert" style={{ ...meta, margin: '12px 0 0', color: B.red }}>We could not save your timer. {error}</p>}
    </section>
  );
}
