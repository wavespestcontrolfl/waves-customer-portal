/**
 * UI PROTOTYPE — "Your sprinkler timer" card for My Property. Fixture-driven,
 * no api calls, no server. It exists so the screens in
 * docs/sprinkler-timer-connect-scope.md can be looked at inside the real
 * portal before any of it is built. Rendered only by
 * sprinkler-timer-preview-main.jsx (/preview-sprinkler-timer.html); nothing in
 * the app imports it, so it is not part of the production bundle.
 *
 * Every string here is draft copy for owner review, not approved copy. A
 * pause is worded as the visit's own "skip your turf watering until <time>"
 * instruction: never a fixed drying or re-entry figure (AGENTS.md).
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
const weekdayShort = (offset) => formatETDateOnly(etDateString(addETDays(new Date(), offset)), { weekday: 'short' });
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
  { value: 'x2', name: 'X2', label: 'Hunter X2', hint: 'Gray box with a dial. X2 is printed in the top corner.', next: 'x2' },
  { value: 'x_core', name: 'X-Core', label: 'Hunter X-Core', hint: 'Looks like the X2. X-Core is printed on the front.', next: 'xcore' },
  { value: 'pro_c', name: 'Pro-C', label: 'Hunter Pro-C', hint: 'Wider box with a dial and room for extra zones.', next: 'proc' },
  { value: 'hydrawise', name: 'Hydrawise touchscreen', label: 'Hunter Hydrawise timer', hint: 'No dial. You run it from a screen or the Hydrawise app.', next: 'ready' },
];
const DEFAULT_MODEL = 'Hunter X2';
// "Hunter X2 on Hydrawise"; a Hydrawise touchscreen already says so.
const onHydrawise = (model) => (model.includes('Hydrawise') ? model : `${model} on Hydrawise`);
const DAY_NAMES = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const clock = (time) => time.replace(' ', ':00 ');
const zoneCount = (count, kind = '') => `${count} ${kind}${count === 1 ? 'zone' : 'zones'}`;
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

function ChoiceChip({ active, onClick, children }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      {...(active ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })} style={{
        ...buttonBase, minHeight: 44, padding: '8px 14px', borderRadius: 8, fontSize: 14, fontWeight: 700,
        background: active ? '#F8FCFE' : '#fff', color: B.glassNavy, border: `1px solid ${active ? B.yellow : '#D8D0C0'}`,
      }}>{children}</button>
  );
}

function ChoiceGroup({ heading, hint, options, value, onChange }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{heading}</div>
      <div style={{ ...meta, margin: '2px 0 8px' }}>{hint}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map((option) => (
          <ChoiceChip key={option} active={value === option} onClick={() => onChange(option)}>{option}</ChoiceChip>
        ))}
      </div>
    </div>
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

function SheetActions({ primary, onPrimary, primaryDisabled, secondary, onSecondary }) {
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 20 }}>
      <PrimaryButton onClick={onPrimary} disabled={primaryDisabled}>{primary}</PrimaryButton>
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

function SettingRow({ label, detail, checked, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${RULE}`, borderRadius: 8 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
        <div style={{ ...meta, marginTop: 2 }}>{detail}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
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

function PickView({ go, pickModel }) {
  const [brand, setBrand] = useState('hunter');
  return (
    <>
      <p style={prose}>Tell us which timer runs your sprinklers and we'll show the right steps for this week's plan.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {BRANDS.map((option) => (
          <ChoiceChip key={option.value} active={brand === option.value} onClick={() => setBrand(option.value)}>{option.label}</ChoiceChip>
        ))}
      </div>
      {brand === 'hunter' && (
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {HUNTER_MODELS.map((model) => (
            <button key={model.value} type="button" data-glass="chip" onClick={() => pickModel(model)} style={{
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

// Step 1 records this answer, so the count can tell a dial-only timer from one already on its maker's app.
const APP_ANSWERS = ['Yes', 'No', 'Not sure'];
const HYDRAWISE_QUESTION = 'Do you run it from Hunter\'s Hydrawise phone app?';

function AppQuestion({ question, onYes }) {
  const [answer, setAnswer] = useState(null);
  const choose = (option) => { setAnswer(option); if (option === 'Yes' && onYes) onYes(); };
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{question}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {APP_ANSWERS.map((option) => (
          <ChoiceChip key={option} active={answer === option} onClick={() => choose(option)}>{option}</ChoiceChip>
        ))}
      </div>
      {answer && <div style={{ ...meta, marginTop: 8 }}>Thanks. We saved your answer.</div>}
    </div>
  );
}

function X2View({ go, model }) {
  return (
    <>
      <StatusLine label={model} detail="Runs from the dial" />
      <p style={prose}>Your X2 can connect to the Waves app once it's on Hunter's Hydrawise app. That takes Hunter's WAND Wi-Fi module, which is sold separately.</p>
      <AppQuestion question={HYDRAWISE_QUESTION} onYes={() => go('ready')} />
      <Callout>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Good to know before you add one</div>
        <div style={{ color: BODY }}>After the module goes in, the dial stops working and your schedule lives in the Hydrawise app.</div>
      </Callout>
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ ...meta, margin: 0 }}><LinkOut href={GUIDE.hunter}>How to run this week's plan from the dial</LinkOut></p>
        <TextButton onClick={() => go('pick')}>Change my timer</TextButton>
      </div>
    </>
  );
}

// Timers that stay on the guide. A Pro-C may already be on Hydrawise, and a
// Rain Bird owner is asked whether they use Rain Bird's app.
const GUIDE_ONLY = {
  rainbird: {
    name: 'Rain Bird', guide: GUIDE.rainBird, cta: 'How to run it on a Rain Bird', appQuestion: 'Do you run it from the Rain Bird phone app?',
    line: 'Rain Bird timers can\'t connect to the Waves app yet. You can still follow this week\'s plan by hand in about a minute.',
  },
  xcore: {
    name: 'Hunter X-Core', guide: GUIDE.hunter, cta: 'How to run it on a Hunter',
    line: 'This timer can\'t connect to the Waves app. You can still follow this week\'s plan by hand in about a minute.',
  },
  proc: {
    name: 'Hunter Pro-C', guide: GUIDE.hunter, cta: 'How to run it on a Hunter', appQuestion: HYDRAWISE_QUESTION, yesGoes: 'ready',
    line: 'Some Pro-C timers can go on Hunter\'s Hydrawise app with a Hunter Wi-Fi part, and some can\'t. It depends on the year it was made. You can follow this week\'s plan by hand in about a minute.',
  },
};
function GuideOnlyView({ view, go }) {
  const timer = GUIDE_ONLY[view];
  return (
    <>
      <StatusLine label={timer.name} detail="Runs from the dial" />
      <p style={prose}>{timer.line}</p>
      {timer.appQuestion && <AppQuestion question={timer.appQuestion} onYes={timer.yesGoes ? () => go(timer.yesGoes) : undefined} />}
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

function ReadyView({ go, openSheet, model }) {
  return (
    <>
      <StatusLine label={onHydrawise(model)} detail="Not connected" />
      <p style={prose}>Connect your timer and we'll pause your turf watering after treatments that call for it. You can also start this week's plan from here.</p>
      <PrimaryButton onClick={() => openSheet('consent')}>Connect my timer</PrimaryButton>
      <div style={{ marginTop: 4 }}><TextButton onClick={() => go('pick')}>Change my timer</TextButton></div>
    </>
  );
}

// Connect by request: Waves asks through Hydrawise, the customer approves the email.
function ApproveView({ go, model }) {
  return (
    <>
      <StatusLine label={onHydrawise(model)} detail="Waiting for your approval" />
      <p style={prose}>We sent a request through Hydrawise. Open the email from Hydrawise and approve Waves. This page updates once you do.</p>
      <ChipButton onClick={() => go('zones')} icon="check">I approved it</ChipButton>
      <div style={{ marginTop: 4 }}><TextButton onClick={() => go('ready')}>Cancel the request</TextButton></div>
    </>
  );
}

function ZonesView({ saveZones, zones, setZones, turfCount, model }) {
  const flip = (id) => setZones((list) => list.map((item) => (item.id === id ? { ...item, turf: !item.turf } : item)));
  return (
    <>
      <StatusLine tone="ok" label="Connected" detail={model} />
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
      <PrimaryButton onClick={saveZones} disabled={turfCount === 0}>Save {zoneCount(turfCount, 'turf ')}</PrimaryButton>
    </>
  );
}

function OfflineView({ go, editZones }) {
  return (
    <>
      <StatusLine tone="warn" label="We can't reach your timer" detail={`Last seen ${weekday(-1)} at 6:40 PM`} />
      <p style={prose}>It may have lost Wi-Fi. Check that your home Wi-Fi reaches the timer, then try again. We can't pause or start watering until it's back online.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <ChipButton onClick={() => go('connected')} icon="refresh">Try again</ChipButton>
      </div>
      <ManageRow onZones={editZones} onDisconnect={() => go('ready')} />
    </>
  );
}

function RunCallout({ openSheet, turfCount, totalMinutes }) {
  return (
    <Callout>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>This week: about 30 minutes per turf zone</div>
      <div style={{ color: BODY, marginBottom: 14 }}>{zoneCount(turfCount)}{turfCount === 1 ? '.' : ', one after another.'} About {duration(totalMinutes)} in all.</div>
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
        <div style={{ color: BODY }}>This follows today's weed control visit. Your beds and drip zones keep running as usual, and the pause ends on its own.</div>
        <div style={{ marginTop: 4 }}><TextButton onClick={() => go('connected')}>End the pause early</TextButton></div>
      </Callout>
      <p style={{ ...meta, margin: '0 0 16px' }}>You can run this week's plan once the pause ends.</p>
    </>
  );
}

// A fixed moment: 35 minutes into the run, or 10 minutes from the end of a short one.
function RunningCallout({ go, turfZones, totalMinutes }) {
  const elapsed = Math.min(35, Math.max(0, totalMinutes - 10));
  const index = Math.min(turfZones.length - 1, Math.floor(elapsed / 30));
  const progress = totalMinutes ? Math.round((elapsed / totalMinutes) * 100) : 0;
  return (
    <Callout>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Watering now: zone {index + 1} of {turfZones.length}</div>
      <div style={{ color: BODY, marginBottom: 12 }}>{turfZones[index]?.name}, 30 minutes. About {duration(totalMinutes - elapsed)} left in this run.</div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Run progress" style={{ height: 8, borderRadius: 999, background: 'rgba(4,57,94,0.12)', overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ width: `${progress}%`, height: '100%', background: B.glassNavy, borderRadius: 999 }} />
      </div>
      <ChipButton onClick={() => go('connected')} icon="close">Stop watering</ChipButton>
    </Callout>
  );
}

// Step 4: the timer follows the weekly plan at the day and time the customer set.
function AutoCallout({ openSheet, turfCount, totalMinutes, schedule }) {
  return (
    <Callout>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Next run: {DAY_NAMES[schedule.day]} at {clock(schedule.time)}</div>
      <div style={{ color: BODY }}>About 30 minutes per turf zone, from this week's plan. {zoneCount(turfCount)}, about {duration(totalMinutes)} in all.</div>
      <div style={{ marginTop: 4 }}><TextButton onClick={() => openSheet('auto')}>Change day or time</TextButton></div>
    </Callout>
  );
}

function RainSkipCallout() {
  return (
    <>
      <Callout>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{weekday(-1)}'s run was skipped for rain</div>
        <div style={{ color: BODY }}>About 0.8 inches of rain fell at your home since your last watering day. The plan skips a run after half an inch or more.</div>
      </Callout>
      <p style={{ ...meta, margin: '0 0 16px' }}>Your next run follows next week's plan.</p>
    </>
  );
}

function MissedCallout({ openSheet, schedule }) {
  return (
    <Callout>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{weekday(-1)}'s run did not start</div>
      <div style={{ color: BODY, marginBottom: 14 }}>We couldn't reach your timer at {clock(schedule.time)}, so your lawn was not watered. Check that your home Wi-Fi reaches the timer.</div>
      <PrimaryButton onClick={() => openSheet('run')}>Run this week's plan</PrimaryButton>
      <div style={{ ...meta, marginTop: 10 }}>Only on your permitted watering day, during your area's allowed hours.</div>
    </Callout>
  );
}

const LIVE_CALLOUT = {
  connected: RunCallout, paused: PausedCallout, running: RunningCallout,
  auto: AutoCallout, rainskip: RainSkipCallout, missed: MissedCallout,
};
const ACTIVITY = {
  paused: () => [
    { when: 'Today', what: `Paused your turf zones after weed control, until ${weekday(1)} at 10:14 AM.` },
    { when: shortDay(-6), what: 'You ran the weekly plan: 4 zones, 30 minutes each.' },
  ],
  usual: () => [
    { when: shortDay(-2), what: 'You ran the weekly plan: 4 zones, 30 minutes each.' },
    { when: shortDay(-13), what: 'Pause ended. Watering is back on your schedule.' },
    { when: shortDay(-14), what: 'Paused your turf zones after weed control.' },
  ],
  auto: () => [
    { when: shortDay(-5), what: 'Ran the weekly plan for you: 4 zones, 30 minutes each.' },
    { when: shortDay(-12), what: 'No run. The weekly plan said skip.' },
    { when: shortDay(-14), what: 'Paused your turf zones after weed control.' },
  ],
  rainskip: () => [
    { when: shortDay(-1), what: 'Skipped the run. About 0.8 inches of rain since your last watering day.' },
    { when: shortDay(-8), what: 'Ran the weekly plan for you: 4 zones, 30 minutes each.' },
  ],
  missed: () => [
    { when: shortDay(-1), what: 'The run did not start. We could not reach your timer.' },
    { when: shortDay(-8), what: 'Ran the weekly plan for you: 4 zones, 30 minutes each.' },
  ],
};

// The screen is the timer's status: connected | paused | running. The two settings are the
// customer's own and live on the card, so a pause, a run or a zone edit never changes them.
function LiveView({ view, go, openSheet, editZones, turfZones, turfCount, totalMinutes, model, schedule, auto, setAuto, autoPause, setAutoPause }) {
  // A pause or a run in progress always shows. Automatic runs only replace the Run button of a normal week.
  const callout = view === 'connected' && auto.on ? (auto.lastRun || 'auto') : view;
  const LiveCallout = LIVE_CALLOUT[callout];
  return (
    <>
      <StatusLine tone="ok" label="Connected" detail={`${model} · ${zoneCount(turfCount, 'turf ')}`} />
      <LiveCallout go={go} openSheet={openSheet} turfZones={turfZones} turfCount={turfCount} totalMinutes={totalMinutes} schedule={schedule} />
      {auto.on && view !== 'connected' && (
        <p style={{ ...meta, margin: '0 0 16px' }}>Automatic runs are on: {DAY_NAMES[schedule.day]} at {clock(schedule.time)}.</p>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        <SettingRow label="Pause the lawn after treatments" checked={autoPause} onChange={() => setAutoPause((on) => !on)}
          detail="When your service report says to skip turf watering after a treatment, we pause your turf zones until that time." />
        <SettingRow label="Run the weekly plan for me" checked={auto.on} onChange={() => (auto.on ? setAuto({ on: false, lastRun: null }) : openSheet('auto'))}
          detail="Each week we start your turf zones for that week's minutes, on the day and time you pick." />
      </div>
      <ActivityList rows={(ACTIVITY[callout] || ACTIVITY.usual)()} />
      <ManageRow onZones={editZones} onDisconnect={() => go('ready')} />
    </>
  );
}

// The connect step has two possible shapes, and Hunter decides which: a sign-in
// on Hunter's page, or a request the customer approves from a Hydrawise email.
function ConnectSheet({ byRequest, onClose, onContinue }) {
  return (
    <Sheet label="Connect your sprinkler timer" onClose={onClose}>
      <PointList icon="check" tone={GREEN} heading="When you connect, Waves can" points={[
        'Pause your turf zones when a treatment\'s instructions say to skip watering. The pause ends on its own.',
        'Start this week\'s watering plan when you tap Run.',
      ]} />
      <PointList icon="close" tone="#B91C1C" heading="Waves will never" points={[
        'Start watering on its own, unless you turn on automatic runs and pick the day and time.',
        'Change the schedule you set in the Hydrawise app.',
        'Touch your beds or drip zones.',
      ]} />
      <p style={{ ...meta, margin: 0 }}>
        {byRequest
          ? 'We send a request through Hydrawise, and you approve it from the email Hydrawise sends you. You can disconnect any time from this page.'
          : 'You sign in with your Hydrawise account, and you can disconnect any time from this page.'}
      </p>
      <SheetActions primary={byRequest ? 'Send the request' : 'Continue to Hydrawise'} onPrimary={onContinue} secondary="Not now" onSecondary={onClose} />
    </Sheet>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const START_TIMES = ['4 AM', '5 AM', '6 AM', '8 PM'];
// The watering days on file in Irrigation settings ("tuesday"), as the short names the chips use.
const savedDayChips = (wateringDays) => WEEKDAYS.filter((day) => wateringDays.includes(DAY_NAMES[day].toLowerCase()));
// The next of those days after today; none on file means the customer has to pick one.
const nextSavedDay = (savedDays) => [1, 2, 3, 4, 5, 6, 7].map(weekdayShort).find((day) => savedDays.includes(day)) || null;

function AutoRunSheet({ schedule, savedDays, onClose, onSave }) {
  const [day, setDay] = useState(schedule.day);
  const [time, setTime] = useState(schedule.time);
  const onFile = savedDays.length > 0;
  return (
    <Sheet label="Run the weekly plan for me" onClose={onClose}>
      <p style={{ margin: '0 0 16px', color: BODY }}>Each week we start your turf zones for that week's minutes, on the day and time you pick. No run in a week the plan says skip.</p>
      <ChoiceGroup heading="Your watering day" options={onFile ? savedDays : WEEKDAYS} value={day} onChange={setDay}
        hint={onFile ? 'From your Irrigation settings. Change your watering days there.' : 'No watering day is on file. Pick the day your address may water.'} />
      <ChoiceGroup heading="Start time" hint="Pick a time inside your area's allowed hours." options={START_TIMES} value={time} onChange={setTime} />
      <PointList icon="alert" tone={AMBER} heading="Before you turn this on" points={[
        'Clear the lawn schedule in your Hydrawise app first, or your lawn gets watered twice.',
        'We skip a run after half an inch or more of rain.',
        'If we can\'t reach your timer, the run does not happen. You can start it from this page.',
      ]} />
      <SheetActions primary="Turn on automatic runs" onPrimary={() => onSave({ day, time })} primaryDisabled={!day} secondary="Not now" onSecondary={onClose} />
    </Sheet>
  );
}

const VIEWS = {
  pick: PickView, x2: X2View, xcore: GuideOnlyView, proc: GuideOnlyView, rainbird: GuideOnlyView, ready: ReadyView, approve: ApproveView,
  zones: ZonesView, offline: OfflineView, connected: LiveView, paused: LiveView, running: LiveView,
};
// These ?timer= values open a screen with its sheet already up, or with automatic runs already on.
const START_VIEWS = {
  consent: { view: 'ready', sheet: 'consent' }, request: { view: 'ready', sheet: 'request' },
  confirm: { view: 'connected', sheet: 'run' }, autosetup: { view: 'connected', sheet: 'auto' },
  auto: { view: 'connected', auto: { on: true, lastRun: null } },
  rainskip: { view: 'connected', auto: { on: true, lastRun: 'rainskip' } },
  missed: { view: 'connected', auto: { on: true, lastRun: 'missed' } },
};
const AUTO_OFF = { on: false, lastRun: null };

export default function SprinklerTimerCard({ initialView = 'pick', wateringDays = [] }) {
  const start = START_VIEWS[initialView] || { view: VIEWS[initialView] ? initialView : 'pick' };
  const savedDays = savedDayChips(wateringDays);
  const [view, setView] = useState(start.view);
  const [sheet, setSheet] = useState(start.sheet || null);
  const [zones, setZones] = useState(ZONES);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [schedule, setSchedule] = useState({ day: nextSavedDay(savedDays), time: '5 AM' });
  const [auto, setAuto] = useState(start.auto || AUTO_OFF);
  const [autoPause, setAutoPause] = useState(true);
  // Editing turf zones returns to the screen it was opened from, so a pause or an offline warning is not lost.
  const [zonesReturn, setZonesReturn] = useState('connected');
  const turfZones = zones.filter((zone) => zone.turf);
  const turfCount = turfZones.length;
  const totalMinutes = turfCount * 30;
  const View = VIEWS[view];
  const closeSheet = () => setSheet(null);
  const pickModel = (picked) => { setModel(picked.label); setView(picked.next); };
  const editZones = () => { setZonesReturn(view); setView('zones'); };
  const saveZones = () => { setView(zonesReturn); setZonesReturn('connected'); };

  return (
    <>
      <section data-glass="card" data-prototype="sprinkler-timer" style={cardStyle} aria-label="Your sprinkler timer">
        <h2 style={title}>Your sprinkler timer</h2>
        <View view={view} go={setView} openSheet={setSheet} zones={zones} setZones={setZones} turfZones={turfZones} turfCount={turfCount}
          totalMinutes={totalMinutes} model={model} schedule={schedule} pickModel={pickModel} editZones={editZones} saveZones={saveZones}
          auto={auto} setAuto={setAuto} autoPause={autoPause} setAutoPause={setAutoPause} />
      </section>

      {(sheet === 'consent' || sheet === 'request') && (
        <ConnectSheet byRequest={sheet === 'request'} onClose={closeSheet}
          onContinue={() => { closeSheet(); setView(sheet === 'request' ? 'approve' : 'zones'); }} />
      )}

      {sheet === 'auto' && (
        <AutoRunSheet schedule={schedule} savedDays={savedDays} onClose={closeSheet}
          onSave={(next) => { setSchedule(next); setAuto({ on: true, lastRun: null }); closeSheet(); }} />
      )}

      {sheet === 'run' && (
        <Sheet label="Run this week's plan?" onClose={closeSheet}>
          <p style={{ margin: '0 0 12px', color: BODY }}>{zoneCount(turfCount, 'turf ')}, about 30 minutes each. About {duration(totalMinutes)} in all.</p>
          <PointList icon="alert" tone={AMBER} heading="Before you start" points={[
            'Only run on your permitted watering day, during your area\'s allowed hours.',
            'If half an inch or more of rain has fallen since your last watering day, skip this run.',
          ]} />
          <SheetActions primary="Start watering" onPrimary={() => { closeSheet(); setAuto((now) => ({ ...now, lastRun: null })); setView('running'); }} secondary="Cancel" onSecondary={closeSheet} />
        </Sheet>
      )}
    </>
  );
}
