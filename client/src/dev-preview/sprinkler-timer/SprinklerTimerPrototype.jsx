/**
 * UI PROTOTYPE — "Your sprinkler timer" card for My Property. Fixture-driven,
 * no api calls, no server. It exists so the screens in
 * docs/sprinkler-timer-connect-scope.md can be looked at inside the real
 * portal before any of it is built. Rendered only by
 * sprinkler-timer-preview-main.jsx (/preview-sprinkler-timer.html); nothing in
 * the app imports it, so it is not part of the production bundle.
 *
 * Every string here is draft copy for owner review, not approved copy.
 */
import { useState } from 'react';
import Icon from '../../components/Icon';
import { COLORS as B, FONTS, BUTTON_BASE } from '../../theme-brand';
import { addETDays, etDateString, formatETDateOnly } from '../../lib/timezone';

const BODY = '#3F4A65';
const RULE = '#E7E2D7';
const GREEN = '#16A34A';
const AMBER = '#B45309';

const cardStyle = {
  padding: 24, borderRadius: 12, border: `1px solid ${RULE}`,
  background: B.white, color: B.glassNavy, fontFamily: FONTS.ui,
  fontSize: 16, lineHeight: 1.55,
};
const title = { fontSize: 20, margin: '0 0 8px' };
const prose = { margin: '0 0 16px', color: BODY };
const meta = { fontSize: 14, color: BODY, lineHeight: 1.45 };
const buttonBase = { ...BUTTON_BASE, letterSpacing: 0, boxShadow: 'none', cursor: 'pointer' };

const duration = (minutes) => {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
};
const weekday = (offset) => formatETDateOnly(etDateString(addETDays(new Date(), offset)), { weekday: 'long' });
const shortDay = (offset) => formatETDateOnly(etDateString(addETDays(new Date(), offset)), { weekday: 'short', month: 'short', day: 'numeric' });

const GUIDE = {
  index: 'https://www.wavespestcontrol.com/sprinkler-timers/',
  hunter: 'https://www.wavespestcontrol.com/sprinkler-timers/hunter/',
  rainBird: 'https://www.wavespestcontrol.com/lawn-care/rain-bird-sprinkler-timer-guide/',
};

const BRANDS = [
  { value: 'hunter', label: 'Hunter' },
  { value: 'rain_bird', label: 'Rain Bird' },
  { value: 'other', label: 'Another brand' },
];
const HUNTER_MODELS = [
  { value: 'x2', name: 'X2', hint: 'Gray box with a dial. X2 is printed in the top corner.', next: 'x2' },
  { value: 'x_core', name: 'X-Core', hint: 'Looks like the X2. X-Core is printed on the front.', next: 'xcore' },
  { value: 'pro_c', name: 'Pro-C', hint: 'Wider box with a dial and room for extra zones.', next: 'xcore' },
  { value: 'hydrawise', name: 'Hydrawise touchscreen', hint: 'No dial. You run it from a screen or the Hydrawise app.', next: 'ready' },
];
const ZONES = [
  { id: 1, name: 'Front lawn', turf: true },
  { id: 2, name: 'Side lawn', turf: true },
  { id: 3, name: 'Back lawn', turf: true },
  { id: 4, name: 'Front beds', turf: false },
  { id: 5, name: 'Hedge drip', turf: false },
  { id: 6, name: 'Back lawn rotors', turf: true },
];

function PrimaryButton({ children, onClick, disabled }) {
  return (
    <button type="button" data-glass-accent="" data-glass-size="primary" onClick={onClick} disabled={disabled} style={{
      ...buttonBase, width: '100%', minHeight: 48, padding: '12px 16px', borderRadius: 10,
      border: `1px solid ${B.yellow}`, background: B.yellow, color: B.glassNavy, fontSize: 16, fontWeight: 700,
    }}>{children}</button>
  );
}

function ChipButton({ children, onClick, icon }) {
  return (
    <button type="button" data-glass="chip" onClick={onClick} style={{
      ...buttonBase, minHeight: 44, padding: '10px 14px', borderRadius: 10, border: '1px solid #D8D0C0',
      background: '#fff', color: B.glassNavy, fontSize: 14, fontWeight: 700,
      display: 'inline-flex', alignItems: 'center', gap: 8,
    }}>{icon && <Icon name={icon} size={16} strokeWidth={2} />}{children}</button>
  );
}

function LinkOut({ href, children }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: B.glassNavy, textDecoration: 'underline', fontWeight: 600 }}>{children}</a>;
}

function TextButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      ...buttonBase, minHeight: 44, padding: '0 2px', border: 'none', background: 'transparent',
      color: B.glassNavy, fontSize: 14, fontWeight: 600, textDecoration: 'underline',
    }}>{children}</button>
  );
}

function StatusLine({ tone = 'idle', label, detail }) {
  const dot = tone === 'ok' ? GREEN : tone === 'warn' ? AMBER : '#94A3B8';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: dot, flexShrink: 0 }} />
      <span style={{ fontWeight: 700 }}>{label}</span>
      {detail && <span style={meta}>{detail}</span>}
    </div>
  );
}

// Same switch as the Rain sensor row in the Irrigation section.
function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} data-glass-pill="" onClick={onChange} style={{
      width: 50, height: 44, borderRadius: 999, border: 'none', cursor: 'pointer', background: 'transparent', position: 'relative', flexShrink: 0,
    }}>
      <span aria-hidden="true" style={{ position: 'absolute', inset: '7px 0', borderRadius: 999, background: checked ? B.yellow : `${B.yellow}55`, transition: 'background 0.18s ease' }}>
        <span style={{ position: 'absolute', top: 4, left: checked ? 24 : 4, width: 22, height: 22, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(15,23,42,0.22)', transition: 'left 0.18s ease' }} />
      </span>
    </button>
  );
}

function Callout({ children }) {
  return (
    <div data-glass="soft" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ borderLeft: `4px solid ${B.yellow}`, paddingLeft: 12 }}>{children}</div>
    </div>
  );
}

function Sheet({ label, onClose, children }) {
  return (
    <div data-glass-scrim="" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
      background: 'rgba(15,23,42,0.48)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'calc(20px + env(safe-area-inset-top, 0px)) calc(20px + env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) calc(20px + env(safe-area-inset-left, 0px))',
    }}>
      <div role="dialog" aria-modal="true" aria-label={label} data-glass="modal" style={{
        background: 'rgba(255,255,255,0.94)', borderRadius: 16, padding: 24, width: '100%', maxWidth: 460,
        maxHeight: '100%', boxSizing: 'border-box', overflowY: 'auto', overscrollBehavior: 'contain',
        color: B.glassNavy, fontFamily: FONTS.ui, fontSize: 16, lineHeight: 1.55,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>{label}</div>
          <button type="button" aria-label="Close" onClick={onClose} style={{
            ...buttonBase, width: 44, height: 44, margin: '-10px -10px 0 0', border: 'none', background: 'transparent', color: BODY,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon name="close" size={20} strokeWidth={2} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PointList({ icon, tone, heading, points }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{heading}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {points.map((point) => (
          <li key={point} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: BODY }}>
            <span style={{ color: tone, marginTop: 3, flexShrink: 0 }}><Icon name={icon} size={18} strokeWidth={2.4} /></span>
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SheetActions({ primary, onPrimary, secondary, onSecondary }) {
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 20 }}>
      <PrimaryButton onClick={onPrimary}>{primary}</PrimaryButton>
      <button type="button" data-glass="chip" onClick={onSecondary} style={{
        ...buttonBase, minHeight: 44, borderRadius: 10, border: '1px solid #D8D0C0', background: 'rgba(255,255,255,0.78)',
        color: B.glassNavy, fontSize: 14, fontWeight: 700,
      }}>{secondary}</button>
    </div>
  );
}

function ActivityList({ rows }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Recent activity</div>
      {rows.map((row) => (
        <div key={row.when + row.what} style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 12, padding: '10px 0', borderBottom: `1px solid ${RULE}` }}>
          <div style={meta}>{row.when}</div>
          <div style={{ fontSize: 14, color: B.glassNavy, lineHeight: 1.45 }}>{row.what}</div>
        </div>
      ))}
    </div>
  );
}

function AutoPauseRow({ checked, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${RULE}`, borderRadius: 8 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Pause the lawn after treatments</div>
        <div style={{ ...meta, marginTop: 2 }}>When a treatment has to stay dry, we pause your turf zones until it's safe to water.</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label="Pause the lawn after treatments" />
    </div>
  );
}

function ManageRow({ onZones, onDisconnect }) {
  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 12 }}>
      <TextButton onClick={onZones}>Change turf zones</TextButton>
      <TextButton onClick={onDisconnect}>Disconnect</TextButton>
    </div>
  );
}

// ── one component per screen; `go` moves between them ──────────────────────

function PickView({ go }) {
  const [brand, setBrand] = useState('hunter');
  return (
    <>
      <p style={prose}>Tell us which timer runs your sprinklers and we'll show the right steps for this week's plan.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {BRANDS.map((option) => {
          const active = brand === option.value;
          return (
            <button key={option.value} type="button" aria-pressed={active} onClick={() => setBrand(option.value)}
              {...(active ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })} style={{
                ...buttonBase, minHeight: 44, padding: '8px 14px', borderRadius: 8, fontSize: 14, fontWeight: 700,
                background: active ? '#F8FCFE' : '#fff', color: B.glassNavy, border: `1px solid ${active ? B.yellow : '#D8D0C0'}`,
              }}>{option.label}</button>
          );
        })}
      </div>
      {brand === 'hunter' && (
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {HUNTER_MODELS.map((model) => (
            <button key={model.value} type="button" data-glass="chip" onClick={() => go(model.next)} style={{
              ...buttonBase, minHeight: 64, padding: '12px 14px', borderRadius: 10, border: '1px solid #D8D0C0', background: '#fff',
              color: B.glassNavy, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <span>
                <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{model.name}</span>
                <span style={{ display: 'block', ...meta, fontWeight: 400 }}>{model.hint}</span>
              </span>
              <Icon name="chevronRight" size={18} strokeWidth={2} />
            </button>
          ))}
        </div>
      )}
      {brand === 'rain_bird' && (
        <div style={{ marginBottom: 16 }}><ChipButton onClick={() => go('rainbird')} icon="check">My timer is a Rain Bird</ChipButton></div>
      )}
      {brand === 'other' && <p style={prose}>Send us a photo of the front of the box and we'll tell you which guide to use.</p>}
      <p style={{ ...meta, margin: 0 }}>Not sure? The name is printed on the front of the box. <LinkOut href={GUIDE.index}>See what each one looks like</LinkOut></p>
    </>
  );
}

function X2View({ go }) {
  return (
    <>
      <StatusLine label="Hunter X2" detail="Runs from the dial" />
      <p style={prose}>Your X2 can connect to the Waves app once it's on Hunter's Hydrawise app. That takes Hunter's WAND Wi-Fi module, which is sold separately.</p>
      <Callout>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Good to know before you add one</div>
        <div style={{ color: BODY }}>After the module goes in, the dial stops working and your schedule lives in the Hydrawise app.</div>
      </Callout>
      <div style={{ display: 'grid', gap: 12 }}>
        <ChipButton onClick={() => go('ready')} icon="check">My X2 is on Hydrawise now</ChipButton>
        <p style={{ ...meta, margin: 0 }}><LinkOut href={GUIDE.hunter}>How to run this week's plan from the dial</LinkOut></p>
      </div>
    </>
  );
}

// Timers with no way onto the Waves app: the guide is the whole card.
const GUIDE_ONLY = {
  rainbird: {
    name: 'Rain Bird', guide: GUIDE.rainBird, cta: 'How to run it on a Rain Bird',
    line: 'Rain Bird timers can\'t connect to the Waves app yet. You can still follow this week\'s plan by hand in about a minute.',
  },
  xcore: {
    name: 'Hunter X-Core', guide: GUIDE.hunter, cta: 'How to run it on a Hunter',
    line: 'This timer can\'t connect to the Waves app. You can still follow this week\'s plan by hand in about a minute.',
  },
};

function GuideOnlyView({ view, go }) {
  const timer = GUIDE_ONLY[view];
  return (
    <>
      <StatusLine label={timer.name} detail="Runs from the dial" />
      <p style={prose}>{timer.line}</p>
      <div style={{ display: 'grid', gap: 12 }}>
        <a href={timer.guide} target="_blank" rel="noopener noreferrer" data-glass-accent="" data-glass-size="primary" style={{
          ...buttonBase, minHeight: 48, padding: '12px 16px', borderRadius: 10, border: `1px solid ${B.yellow}`, background: B.yellow,
          color: B.glassNavy, fontSize: 16, fontWeight: 700, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{timer.cta}</a>
        <TextButton onClick={() => go('pick')}>Change my timer</TextButton>
      </div>
    </>
  );
}

function ReadyView({ go, openSheet }) {
  return (
    <>
      <StatusLine label="Hunter X2 on Hydrawise" detail="Not connected" />
      <p style={prose}>Connect your timer and we'll keep the lawn dry after treatments that need it. You can also start this week's plan from here.</p>
      <PrimaryButton onClick={() => openSheet('consent')}>Connect my timer</PrimaryButton>
      <div style={{ marginTop: 4 }}><TextButton onClick={() => go('pick')}>Change my timer</TextButton></div>
    </>
  );
}

function ZonesView({ go, zones, setZones, turfCount }) {
  const flip = (id) => setZones((list) => list.map((item) => (item.id === id ? { ...item, turf: !item.turf } : item)));
  return (
    <>
      <StatusLine tone="ok" label="Connected" detail="Hunter X2" />
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Which zones water your grass?</div>
      <p style={prose}>We only pause or run the zones you mark as turf. Beds, drip and everything else stay exactly as they are.</p>
      <div style={{ marginBottom: 16 }}>
        {zones.map((zone) => (
          <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: `1px solid ${RULE}` }}>
            <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 999, background: 'rgba(4,57,94,0.08)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{zone.id}</span>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{zone.name}</span>
            <span style={meta}>{zone.turf ? 'Turf' : 'Not turf'}</span>
            <Toggle checked={zone.turf} label={`${zone.name} waters grass`} onChange={() => flip(zone.id)} />
          </div>
        ))}
      </div>
      <PrimaryButton onClick={() => go('connected')} disabled={turfCount === 0}>Save {turfCount} turf {turfCount === 1 ? 'zone' : 'zones'}</PrimaryButton>
    </>
  );
}

function OfflineView({ go }) {
  return (
    <>
      <StatusLine tone="warn" label="We can't reach your timer" detail={`Last seen ${weekday(-1)} at 6:40 PM`} />
      <p style={prose}>It may have lost Wi-Fi. Check that your home Wi-Fi reaches the timer, then try again. We can't pause or start watering until it's back online.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <ChipButton onClick={() => go('connected')} icon="refresh">Try again</ChipButton>
      </div>
      <ManageRow onZones={() => go('zones')} onDisconnect={() => go('ready')} />
    </>
  );
}

function RunCallout({ openSheet, turfCount, totalMinutes }) {
  return (
    <Callout>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>This week: about 30 minutes per turf zone</div>
      <div style={{ color: BODY, marginBottom: 14 }}>{turfCount} zones, one after another. About {duration(totalMinutes)} in all.</div>
      <PrimaryButton onClick={() => openSheet('run')}>Run this week's plan</PrimaryButton>
      <div style={{ ...meta, marginTop: 10 }}>Only on your permitted watering day, during your area's allowed hours.</div>
    </Callout>
  );
}

function PausedCallout({ go }) {
  return (
    <>
      <Callout>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Lawn watering is paused until {weekday(1)} at 10:14 AM</div>
        <div style={{ color: BODY }}>Today's weed control needs 24 hours to dry. Your beds and drip zones keep running as usual, and the pause ends on its own.</div>
        <div style={{ marginTop: 4 }}><TextButton onClick={() => go('connected')}>End the pause early</TextButton></div>
      </Callout>
      <p style={{ ...meta, margin: '0 0 16px' }}>You can run this week's plan once the pause ends.</p>
    </>
  );
}

// A fixed moment: 35 minutes into the run.
function RunningCallout({ go, turfCount, totalMinutes }) {
  const progress = totalMinutes ? Math.min(100, Math.round((35 / totalMinutes) * 100)) : 0;
  return (
    <Callout>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Watering now: zone 2 of {turfCount}</div>
      <div style={{ color: BODY, marginBottom: 12 }}>Side lawn, 30 minutes. About {duration(Math.max(0, totalMinutes - 35))} left in this run.</div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Run progress" style={{ height: 8, borderRadius: 999, background: 'rgba(4,57,94,0.12)', overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ width: `${progress}%`, height: '100%', background: B.glassNavy, borderRadius: 999 }} />
      </div>
      <ChipButton onClick={() => go('connected')} icon="close">Stop watering</ChipButton>
    </Callout>
  );
}

const LIVE_CALLOUT = { connected: RunCallout, paused: PausedCallout, running: RunningCallout };
const ACTIVITY = {
  paused: () => [
    { when: 'Today', what: 'Paused your turf zones for 24 hours after weed control.' },
    { when: shortDay(-6), what: 'You ran the weekly plan: 4 zones, 30 minutes each.' },
  ],
  usual: () => [
    { when: shortDay(-2), what: 'You ran the weekly plan: 4 zones, 30 minutes each.' },
    { when: shortDay(-13), what: 'Pause ended. Watering is back on your schedule.' },
    { when: shortDay(-14), what: 'Paused your turf zones for 24 hours after weed control.' },
  ],
};

// connected | paused | running
function LiveView({ view, go, openSheet, turfCount, totalMinutes }) {
  const [autoPause, setAutoPause] = useState(true);
  const LiveCallout = LIVE_CALLOUT[view];
  return (
    <>
      <StatusLine tone="ok" label="Connected" detail={`Hunter X2 · ${turfCount} turf zones`} />
      <LiveCallout go={go} openSheet={openSheet} turfCount={turfCount} totalMinutes={totalMinutes} />
      <AutoPauseRow checked={autoPause} onChange={() => setAutoPause((on) => !on)} />
      <ActivityList rows={(ACTIVITY[view] || ACTIVITY.usual)()} />
      <ManageRow onZones={() => go('zones')} onDisconnect={() => go('ready')} />
    </>
  );
}

const VIEWS = {
  pick: PickView, x2: X2View, xcore: GuideOnlyView, rainbird: GuideOnlyView, ready: ReadyView,
  zones: ZonesView, offline: OfflineView, connected: LiveView, paused: LiveView, running: LiveView,
};
// ?timer=consent and ?timer=confirm open a screen with its sheet already up.
const SHEET_VIEWS = { consent: ['ready', 'consent'], confirm: ['connected', 'run'] };

export default function SprinklerTimerCard({ initialView = 'pick' }) {
  const [start, startSheet] = SHEET_VIEWS[initialView] || [VIEWS[initialView] ? initialView : 'pick', null];
  const [view, setView] = useState(start);
  const [sheet, setSheet] = useState(startSheet);
  const [zones, setZones] = useState(ZONES);
  const turfCount = zones.filter((zone) => zone.turf).length;
  const totalMinutes = turfCount * 30;
  const View = VIEWS[view];
  const closeSheet = () => setSheet(null);

  return (
    <>
      <section data-glass="card" data-prototype="sprinkler-timer" style={cardStyle} aria-label="Your sprinkler timer">
        <h2 style={title}>Your sprinkler timer</h2>
        <View view={view} go={setView} openSheet={setSheet} zones={zones} setZones={setZones} turfCount={turfCount} totalMinutes={totalMinutes} />
      </section>

      {sheet === 'consent' && (
        <Sheet label="Connect your sprinkler timer" onClose={closeSheet}>
          <PointList icon="check" tone={GREEN} heading="When you connect, Waves can" points={[
            'Pause your turf zones after a treatment that has to stay dry. The pause ends on its own.',
            'Start this week\'s watering plan when you tap Run.',
          ]} />
          <PointList icon="close" tone="#B91C1C" heading="Waves will never" points={[
            'Start watering on its own.',
            'Change the schedule you set in the Hydrawise app.',
            'Touch your beds or drip zones.',
          ]} />
          <p style={{ ...meta, margin: 0 }}>You sign in with your Hydrawise account, and you can disconnect any time from this page.</p>
          <SheetActions primary="Continue to Hydrawise" onPrimary={() => { closeSheet(); setView('zones'); }} secondary="Not now" onSecondary={closeSheet} />
        </Sheet>
      )}

      {sheet === 'run' && (
        <Sheet label="Run this week's plan?" onClose={closeSheet}>
          <p style={{ margin: '0 0 12px', color: BODY }}>{turfCount} turf zones, about 30 minutes each. About {duration(totalMinutes)} in all.</p>
          <PointList icon="alert" tone={AMBER} heading="Before you start" points={[
            'Only run on your permitted watering day, during your area\'s allowed hours.',
            'If half an inch or more of rain has fallen since your last watering day, skip this run.',
          ]} />
          <SheetActions primary="Start watering" onPrimary={() => { closeSheet(); setView('running'); }} secondary="Cancel" onSecondary={closeSheet} />
        </Sheet>
      )}
    </>
  );
}
