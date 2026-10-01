// client/src/components/tech/FastCompleteParts.jsx
//
// The pieces every Fast Complete sheet shares, whatever the service line:
// the dialog frame and header, the saved view, the visit note with its mic,
// the one-tip picker, and the choice tiles. Each sheet keeps what is its
// own line's (products, photos, findings) and its completion body. The
// /complete submit lives in hooks/useFastCompleteSubmit.js.
import React, { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { rankTechTips, techTipSubtext, techTipSentLabel } from '../../lib/tech-tips';
import DictationButton from './DictationButton';
import { UiSurface, Button, Field, Input, Textarea, cn } from '../ui';
import '../../styles/tech-workflow.css';

// Tips shown before the tech searches or opens the whole list.
const TIP_PREVIEW_COUNT = 4;
// Mirrors MAX_CUSTOM_TIP_CHARS (server tip-library.js): the server rejects a
// longer line, never trims it.
const CUSTOM_TIP_MAX_CHARS = 240;
const MIC_PALETTE = { accent: '#e2e8f0', muted: '#334155', red: '#ef4444', card: '#1e293b' };

// "123 Oak St, Bradenton" from the context's resolved address.
function liveAddressLine(address) {
  if (!address || typeof address !== 'object') return '';
  return [[address.line1, address.line2].filter(Boolean).join(' '), address.city].filter(Boolean).join(', ');
}

// The LIVE visit once loaded, so the tech sees whose property this
// completion records against.
export function customerNameOf(visit, service) {
  return visit?.customerName || service?.customerName || '';
}

// The sheet over the page: full screen on a phone, a dialog at desktop
// width. A tap on the backdrop dismisses it. `overlay` renders beside the
// dialog (a photo manager opened over the sheet); `hiddenProps` makes the
// dialog inert while it is up.
export function FastCompleteFrame({ isMobile, dialogRef, titleId, onDismiss, hiddenProps, overlay, children }) {
  return createPortal(
    <>
    <UiSurface
      density="touch"
      className={cn('tech-visit-surface tech-visit-overlay', isMobile && 'tech-visit-overlay--fullscreen')}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onDismiss(); }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('tech-visit-dialog', isMobile && 'tech-visit-dialog--fullscreen')}
        {...hiddenProps}
      >
        {children}
      </section>
    </UiSurface>
    {overlay}
    </>,
    document.body,
  );
}

export function SheetHeader({ titleId, title, service, visit, done, locked, dictationPending, submitting, onFullForm, onClose }) {
  const address = liveAddressLine(visit?.address);
  return (
    <header className="tech-visit-header">
      <div>
        <h2 id={titleId} className="tech-visit-title">{title}</h2>
        <p className="tech-visit-muted">
          {customerNameOf(visit, service) || 'Customer'}{service?.serviceType ? ` · ${service.serviceType}` : ''}
        </p>
        {address && <p className="tech-visit-muted">{address}</p>}
      </div>
      {!done && (
        <Button variant="ghost" className="tech-visit-action" onClick={onFullForm} disabled={locked || dictationPending}>Full form</Button>
      )}
      <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={onClose} disabled={submitting} aria-label="Close">×</Button>
    </header>
  );
}

// What the tech sees once the visit is saved.
export function SavedView({ service, summary, onCompleted }) {
  return (
    <div className="tech-visit-body">
      <div className="tech-visit-card">
        <p className="tech-visit-muted">{[service?.address, service?.timeLabel].filter(Boolean).join(' · ') || 'This visit'}</p>
        <p>{summary}</p>
      </div>
      <div className="tech-visit-actions">
        <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={() => onCompleted?.()}>Next stop</Button>
      </div>
    </div>
  );
}

// One tile — a real button, aria-pressed, 44px min touch target via the
// shared Button component's `touch` density.
export function Chip({ label, pressed, onClick, className, disabled }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn('tech-visit-action tech-visit-product', className)}
      {...(pressed != null ? { 'aria-pressed': pressed } : {})}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

export function ChoiceSection({ title, action, columns = 2, children }) {
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">{title}</h3>
        {action}
      </div>
      <div className={cn('tech-visit-tile-grid', `tech-visit-tile-grid--${columns}`)}>{children}</div>
    </section>
  );
}

// The visit note leads the sheet. The mic appends what the tech says; on a
// phone without speech recognition it records a clip for server transcription
// (DictationButton's upload fallback), and renders nothing where neither works.
export function VisitNote({ note, onChange, onDictated, onDictationPending, serviceId, locked }) {
  const noteId = useId();
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title"><label htmlFor={noteId}>Tell me about the visit</label></h3>
      </div>
      <div className="tech-visit-note-row">
        <DictationButton onAppend={onDictated} onPendingChange={onDictationPending} palette={MIC_PALETTE} size={48} title="Talk about the visit" disabled={locked} uploadServiceId={serviceId} />
        <Textarea
          id={noteId}
          className="tech-visit-control"
          rows={3}
          value={note}
          onChange={(e) => onChange(e.target.value)}
          placeholder="What you treated, where, and what you saw"
        />
      </div>
    </section>
  );
}

// The tip library, read on its own: the picker is optional, so a slow or
// failed read never holds the sheet. null until it arrives, and when the
// read fails or the tips gate is off.
export function useTipLibrary({ base, request }) {
  const [library, setLibrary] = useState(null);
  useEffect(() => {
    let active = true;
    request(`${base}/tech-tips`)
      .then((data) => { if (active) setLibrary(data?.available === true ? data : null); })
      .catch(() => { if (active) setLibrary(null); });
    return () => { active = false; };
  }, [base, request]);
  return library;
}

// One tip per service visit: a library pick OR the tech's own line, never
// both. null when the picker never loaded, so nothing the tech could not see
// freezes onto the report.
export function techTipsOf({ tipId, customTip }, tipsAvailable) {
  if (!tipsAvailable) return null;
  const custom = customTip.trim();
  return custom ? { ids: [], custom } : { ids: tipId ? [tipId] : [], custom: null };
}

// What the picker says beside a tip: already covered by the customer's
// saved settings, or when it last went out to this customer.
function tipMark(tip, library) {
  if (tip.condition === 'irrigation_on_file' && library?.conditions?.irrigation_on_file === true) return 'already on file';
  const day = library?.lastSent?.[tip.id];
  return day ? techTipSentLabel(day) : null;
}

// The tips on screen: search results, the whole list, or the short list,
// with the pick always kept in view. `noMatch` is about the search alone, so
// a pinned pick never hides that a search found nothing.
function visibleTips(allTips, { query, showAll, tipId }) {
  const listed = query ? rankTechTips(allTips, query) : showAll ? allTips : allTips.slice(0, TIP_PREVIEW_COUNT);
  const pinned = tipId && !listed.some((tip) => tip.id === tipId) ? allTips.find((tip) => tip.id === tipId) : null;
  return { tips: pinned ? [pinned, ...listed] : listed, noMatch: !!query && !listed.length };
}

function TipOption({ tip, library, pressed, locked, onPick }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className="tech-visit-action tech-visit-tip"
      aria-pressed={pressed}
      onClick={() => onPick(tip.id)}
      disabled={locked}
    >
      <span>
        {tip.label}
        <span className="tech-visit-tip-copy">{[techTipSubtext(tip.copy), tipMark(tip, library)].filter(Boolean).join(' · ')}</span>
      </span>
    </Button>
  );
}

// One tip per service visit, from this visit's options: a short list first,
// the whole list behind "Show all", search across all of it, or the tech's
// own line. Only the id (or the typed line) goes on the wire; the server
// resolves and freezes the copy.
export function TipSection({ library, tipId, customTip, locked, onPick, onCustom }) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [writing, setWriting] = useState(false);
  const allTips = useMemo(
    () => (library?.groups || []).flatMap((group) => group.tips || []),
    [library],
  );
  const q = query.trim().toLowerCase();
  const { tips: visible, noMatch } = visibleTips(allTips, { query: q, showAll, tipId });
  const hasPick = !!tipId || !!customTip.trim();
  const writingOwn = writing || !!customTip;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Tip for the customer</h3>
        <span className="tech-visit-muted">{hasPick ? '1 picked' : 'Pick 1 (optional)'}</span>
      </div>
      <Field label="Search tips" className="tech-visit-field">
        <Input className="tech-visit-control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ants, porch light" />
      </Field>
      <div className="tech-visit-tip-list">
        {visible.map((tip) => (
          <TipOption key={tip.id} tip={tip} library={library} pressed={tip.id === tipId} locked={locked} onPick={onPick} />
        ))}
        {noMatch && <p className="tech-visit-muted">No tips match.</p>}
      </div>
      <div className="tech-visit-tile-grid">
        {!q && allTips.length > TIP_PREVIEW_COUNT && (
          <Chip disabled={locked} label={showAll ? 'Show fewer' : 'Show all'} onClick={() => setShowAll((on) => !on)} />
        )}
        {!writingOwn && <Chip disabled={locked} label="Write your own" onClick={() => setWriting(true)} />}
      </div>
      {writingOwn && (
        <Field label="Your own tip (one sentence)" className="tech-visit-field">
          <Input className="tech-visit-control" value={customTip} maxLength={CUSTOM_TIP_MAX_CHARS} onChange={(e) => onCustom(e.target.value)} placeholder="Goes on the report as a note from you" />
        </Field>
      )}
    </section>
  );
}
