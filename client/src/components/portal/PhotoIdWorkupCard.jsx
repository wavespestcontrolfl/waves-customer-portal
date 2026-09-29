import { useState } from 'react';
import { createPortal } from 'react-dom';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import Icon from '../Icon';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useModalFocus from '../../hooks/useModalFocus';
import { Chip, ResultPhotos, V2_TIER_LABEL } from './photoIdShared';
import {
  FIELD_TEST_TECHNICIAN_LINE,
  LOCAL_FIT_LABELS,
  OUTCOME_CHIP_LABEL,
  WEED_WORDING_PHRASE,
  evidenceChipPhrase,
  subjectPlantChipText,
} from './photoIdCopy';

// =========================================================================
// The lawn / tree-shrub / palm workup card — renders only when the server
// hands back `data.v2.kind === 'workup'` (PLANT-ENGINE-CONTRACT.md §6.7).
// Every string here is either payload text (headline, observed, possibility
// names/fits/what_it_means, settle_it/next_step_hint text) rendered
// verbatim, or one of the fixed section headings / phrase templates this
// file and photoIdCopy.js name explicitly. Order (assignment / scope §2):
// headline+subhead (+ weed chips) -> tier line -> photos -> what we can see
// -> what may explain it -> evidence we have -> the one thing that would
// settle it -> next step.
// =========================================================================

// The catalog's own warning for anything the card names (a possibility, a
// weed chip) — the same bold red line the identity card shows for a named
// entry, so a poison / sap / sting warning is never dropped just because the
// answer came back as a workup (Codex #5250 r3 P2: fairy ring's poisonous
// mushrooms).
function SafetyLine({ text }) {
  if (!text) return null;
  return <div style={{ fontSize: 16, color: B.red, fontWeight: 700, lineHeight: 1.45 }}>{text}</div>;
}

function SectionHeading({ children }) {
  return (
    <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

// The plant the workup is about — the account's grass on file, or the plant
// the photo named — with its catalog warning (Codex #5250 r4: a sago palm
// workup must not drop the pet-poisoning line).
function SubjectPlant({ plant, subjectType }) {
  if (!plant?.common_name) return null;
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Chip>{subjectPlantChipText(plant, subjectType)}</Chip>
      </div>
      <SafetyLine text={plant.safety_line} />
    </>
  );
}

function WeedChips({ weeds }) {
  if (!Array.isArray(weeds) || weeds.length === 0) return null;
  const warnings = [...new Set(weeds.map((w) => w.safety_line).filter(Boolean))];
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {weeds.map((w, i) => {
          const phrase = WEED_WORDING_PHRASE[w.wording];
          return (
            <Chip key={w.slug || i}>
              {`Also spotted: ${w.common_name}${phrase ? ` — ${phrase}` : ''}`}
            </Chip>
          );
        })}
      </div>
      {warnings.map((text) => <SafetyLine key={text} text={text} />)}
    </>
  );
}

function ObservedSection({ observed }) {
  if (!Array.isArray(observed) || observed.length === 0) return null;
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16 }}>
      <SectionHeading>What we can see</SectionHeading>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {observed.map((text, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 16, color: SHELL.body, lineHeight: 1.45 }}>
            <Icon name="eye" size={16} strokeWidth={2} style={{ color: SHELL.muted, flexShrink: 0, marginTop: 3 }} />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Tapping a possibility opens a bottom sheet with its `what_it_means` —
// same modal mechanics (focus trap + body scroll lock) as the parent
// PhotoIdSheet; reference-counted, so nesting is safe. Portaled to
// document.body (codex round-0 P1): the parent PhotoIdSheet's own outer
// scrim has `backdrop-filter`, which establishes a containing block for
// `position: fixed` descendants — left un-portaled, this sheet would be
// positioned within, and clipped/scrolled by, that ancestor instead of the
// viewport (same pattern as ConsultationOutcomeSheet / ServiceRecapModal).
function PossibilitySheet({ possibility, onClose }) {
  useLockBodyScroll(!!possibility);
  const dialogRef = useModalFocus(!!possibility, onClose);
  if (!possibility) return null;
  return createPortal((
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-glass-scrim=""
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(15,23,42,0.42)', backdropFilter: 'blur(5px)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={possibility.common_name}
        data-glass="modal"
        style={{
          background: SHELL.page, borderRadius: '8px 8px 0 0', padding: 20,
          boxShadow: '0 -8px 40px rgba(15,23,42,0.18)', borderTop: `1px solid ${SHELL.border}`,
          maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto', fontFamily: FONTS.body,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: SHELL.text }}>{possibility.common_name}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{
            width: 40, height: 40, minWidth: 44, minHeight: 44, borderRadius: 999,
            border: `1px solid ${SHELL.border}`, background: SHELL.surface, color: SHELL.text,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            <Icon name="x" size={18} strokeWidth={2} />
          </button>
        </div>
        <SafetyLine text={possibility.safety_line} />
        {possibility.what_it_means && (
          <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.55 }}>{possibility.what_it_means}</div>
        )}
      </div>
    </div>
  ), document.body);
}

function PossibilityRow({ possibility, isLast, onOpen }) {
  const outcomeLabel = OUTCOME_CHIP_LABEL[possibility.outcome] || null;
  const localTags = Array.isArray(possibility.local) ? possibility.local : [];
  return (
    <button
      type="button"
      onClick={() => onOpen(possibility)}
      style={{
        width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6,
        border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONTS.body, padding: 0,
        paddingBottom: isLast ? 0 : 12, borderBottom: isLast ? 'none' : `1px solid ${SHELL.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: SHELL.text }}>{possibility.common_name}</span>
        <Chip>{possibility.strength === 'strong' ? 'Strong match' : 'Possible match'}</Chip>
        {outcomeLabel && <Chip tone="alert">{outcomeLabel}</Chip>}
        {localTags.map((tag) => (LOCAL_FIT_LABELS[tag] ? <Chip key={tag}>{LOCAL_FIT_LABELS[tag]}</Chip> : null))}
      </div>
      <SafetyLine text={possibility.safety_line} />
      {Array.isArray(possibility.fits) && possibility.fits.length > 0 && (
        <div style={{ fontSize: 15, color: SHELL.body, lineHeight: 1.4 }}>
          <span style={{ fontWeight: 700 }}>What fits: </span>{possibility.fits.join('; ')}
        </div>
      )}
      {Array.isArray(possibility.not_yet) && possibility.not_yet.length > 0 && (
        <div style={{ fontSize: 15, color: SHELL.muted, lineHeight: 1.4 }}>
          <span style={{ fontWeight: 700 }}>What doesn&apos;t fit yet: </span>{possibility.not_yet.join('; ')}
        </div>
      )}
    </button>
  );
}

function PossibilitiesSection({ possibilities, onOpenPossibility }) {
  if (!Array.isArray(possibilities) || possibilities.length === 0) return null;
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16 }}>
      <SectionHeading>What may explain it</SectionHeading>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {possibilities.map((p, i) => (
          <PossibilityRow key={p.slug || i} possibility={p} isLast={i === possibilities.length - 1} onOpen={onOpenPossibility} />
        ))}
      </div>
    </section>
  );
}

function EvidenceWeHaveSection({ evidence }) {
  if (!evidence) return null;
  const chipEntries = evidence.chips && typeof evidence.chips === 'object' ? Object.entries(evidence.chips) : [];
  const phrases = chipEntries.map(([key, value]) => evidenceChipPhrase(key, value)).filter(Boolean);
  const accountGrass = evidence.account && evidence.account.grass_type;
  const hasPhotos = typeof evidence.photos === 'number' && evidence.photos > 0;
  if (!hasPhotos && phrases.length === 0 && !accountGrass) return null;
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16 }}>
      <SectionHeading>Evidence we have</SectionHeading>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {hasPhotos && (
          <li style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.45 }}>
            {evidence.photos === 1 ? '1 photo' : `${evidence.photos} photos`}
          </li>
        )}
        {accountGrass && (
          <li style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.45 }}>
            {`Grass type on file: ${String(accountGrass).replace(/-/g, ' ')}`}
          </li>
        )}
        {phrases.map((text, i) => (
          <li key={i} style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.45 }}>{text}</li>
        ))}
      </ul>
    </section>
  );
}

// "The one thing that would settle it" — §6.5. `kind`:
//   photo      -> text + "Take this photo" retake button
//   field_test -> name/how/reads_as, marked optional, + the fixed
//                 technician line (decision 6: always offered alongside)
//   technician -> text only, no button
//   retake     -> text + a retake button (zero possibilities)
function SettleItSection({ settleIt, onRetakePhoto }) {
  if (!settleIt || !settleIt.kind) return null;
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeading>The one thing that would settle it</SectionHeading>
      {settleIt.kind === 'field_test' && (
        <>
          <div style={{ fontSize: 16, color: SHELL.text, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700 }}>{settleIt.name}</span> (optional)
          </div>
          {settleIt.how && <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.5 }}>{settleIt.how}</div>}
          {settleIt.reads_as && (
            <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 700 }}>Reads as: </span>{settleIt.reads_as}
            </div>
          )}
          <div style={{ fontSize: 15, color: SHELL.muted, lineHeight: 1.45 }}>{FIELD_TEST_TECHNICIAN_LINE}</div>
        </>
      )}
      {(settleIt.kind === 'photo' || settleIt.kind === 'retake') && (
        <>
          {settleIt.text && <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.5 }}>{settleIt.text}</div>}
          <button type="button" data-glass-accent="" data-glass-size="primary"
            onClick={() => onRetakePhoto?.({ ask: settleIt.text || '' })}
            style={{ minHeight: 48, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 700, fontFamily: FONTS.body, alignSelf: 'flex-start' }}
          >
            {settleIt.kind === 'retake' ? 'Take these photos again' : 'Take this photo'}
          </button>
        </>
      )}
      {settleIt.kind === 'technician' && settleIt.text && (
        <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.5 }}>{settleIt.text}</div>
      )}
    </section>
  );
}

const NEXT_STEP_HINT_CTA = { inspection: 'Request service', unclear: 'Send to the team' };

// next_step_hint kinds: inspection / specialist / fix_conditions / none /
// unclear (§6.6) — a separate vocabulary from the pest `next_step` kinds
// NextStepBlock renders, so this is its own block rather than a reuse.
// inspection/unclear open the same request handoff as today's next-step
// CTAs; specialist/fix_conditions/none are informational (no on-site visit
// offered by default — §6.6 hard rule) and close the sheet.
function NextStepHintBlock({ nextStepHint, referral, onOpenRequestCta, onDone }) {
  if (!nextStepHint && !referral) return null;
  const kind = nextStepHint?.kind;
  const requestable = kind === 'inspection' || kind === 'unclear';
  return (
    <section data-glass="soft" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {nextStepHint?.text && <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.5 }}>{nextStepHint.text}</div>}
      {/* `referral` is `{ kind, text }`; its text usually repeats the hint's own (Codex #5250 r4 P1). */}
      {referral?.text && referral.text !== nextStepHint?.text && (
        <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.5 }}>{referral.text}</div>
      )}
      {requestable ? (
        <button type="button" data-glass-accent="" data-glass-size="primary" onClick={onOpenRequestCta} style={{
          minHeight: 48, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 700, fontFamily: FONTS.body, alignSelf: 'flex-start',
        }}>
          {NEXT_STEP_HINT_CTA[kind]}
        </button>
      ) : (
        <button type="button" onClick={onDone} style={{
          minHeight: 44, borderRadius: 8, border: `1px solid ${SHELL.borderStrong}`, background: SHELL.surface,
          color: SHELL.text, cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: FONTS.body, alignSelf: 'flex-start',
        }}>
          {kind === 'none' ? 'Got it' : 'Done'}
        </button>
      )}
    </section>
  );
}

export default function PhotoIdWorkupCard({ v2, photos, unavailablePhotoIds, onPhotoUnavailable, onRetakePhoto, onOpenRequestCta, onDone }) {
  const [openPossibility, setOpenPossibility] = useState(null);
  const answer = v2.answer || {};
  const subject = v2.subject || {};
  const tierLabel = V2_TIER_LABEL[v2.tier] || null;

  return (
    <>
      <section data-glass="card" style={{ borderRadius: 8, border: `1px solid ${SHELL.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          {answer.headline && <div style={{ fontSize: 20, fontWeight: 700, color: SHELL.text, lineHeight: 1.25 }}>{answer.headline}</div>}
          {answer.subhead && <div style={{ fontSize: 16, fontStyle: 'italic', color: SHELL.muted, marginTop: 2 }}>{answer.subhead}</div>}
        </div>
        <SubjectPlant plant={subject.plant} subjectType={v2.subject_type} />
        <WeedChips weeds={subject.weeds} />
        {tierLabel && (
          <div style={{ fontSize: 14, fontWeight: 700, color: SHELL.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{tierLabel}</div>
        )}
        <ResultPhotos photos={photos} unavailablePhotoIds={unavailablePhotoIds} onPhotoUnavailable={onPhotoUnavailable} />
      </section>

      <ObservedSection observed={v2.observed} />
      <PossibilitiesSection possibilities={v2.possibilities} onOpenPossibility={setOpenPossibility} />
      <EvidenceWeHaveSection evidence={v2.evidence} />
      <SettleItSection settleIt={v2.settle_it} onRetakePhoto={onRetakePhoto} />
      <NextStepHintBlock
        nextStepHint={v2.next_step_hint}
        referral={v2.referral}
        onOpenRequestCta={onOpenRequestCta}
        onDone={onDone}
      />

      <PossibilitySheet possibility={openPossibility} onClose={() => setOpenPossibility(null)} />
    </>
  );
}
