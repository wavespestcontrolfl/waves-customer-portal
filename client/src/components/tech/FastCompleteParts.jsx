// client/src/components/tech/FastCompleteParts.jsx
//
// The pieces every Fast Complete sheet shares, whatever the service line:
// the dialog frame and header, the saved view, the visit note with its mic,
// the one-tip picker, and the choice tiles. Each sheet keeps what is its
// own line's (products, photos, findings) and its completion body. The
// /complete submit lives in hooks/useFastCompleteSubmit.js. The amount entry,
// "+ Other product" picker wiring, stale-visit check and footer are shared
// by every sheet that takes products.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFieldPortalClass } from './fieldPortal';
import { createPortal } from 'react-dom';
import { rankTechTips, techTipSubtext, techTipSentLabel } from '../../lib/tech-tips';
import { UNIT_CHOICES, isOutOfStock } from '../../lib/fast-complete-products';
import { isMlUnit } from '../../lib/measure-units';
import RATE_UNITS from '../../../../shared/rate-units.json';
import DictationButton from './DictationButton';
import FastCompleteProductPicker, { WarningIcon } from './FastCompleteProductPicker';
import { UiSurface, ActionFeedback, Button, Field, Input, Select, Textarea, cn } from '../ui';
import '../../styles/tech-workflow.css';

// Tips shown before the tech searches or opens the whole list.
const TIP_PREVIEW_COUNT = 4;
// Mirrors MAX_CUSTOM_TIP_CHARS (server tip-library.js): the server rejects a
// longer line, never trims it.
const CUSTOM_TIP_MAX_CHARS = 240;
// The mic on the light sheet: ink outline at rest, filled ink while it listens
// (`red` is DictationButton's listening colour; the admin look keeps red for errors).
const MIC_PALETTE = { accent: '#1c1917', muted: '#d6d3d1', red: '#1c1917', card: '#ffffff' };

export const unitLabel = (unit) => String(unit || '').replace(/_/g, ' ');
export const methodLabel = (value) => {
  const text = String(value || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// A rate goes on the record only in a unit /complete accepts: the server's
// own list (shared/rate-units.json, read by inventory-units.js), matched
// trimmed and case-blind as it matches them, less its mL units, which this
// sheet never shows (owner ruling 2026-09-27) — a rate the tech can't see
// is not one they confirmed. Any other unit (a catalog oddity such as
// "percent_solution") leaves the row without a rate rather than have the
// server refuse the whole visit.
const SENDABLE_RATE_UNITS = new Set(RATE_UNITS.filter((unit) => !isMlUnit(unit)));
export const isSendableRateUnit = (unit) => SENDABLE_RATE_UNITS.has(String(unit || '').trim().toLowerCase());

// A catalog row with the stock on hand a fresh read has for it.
export function withFreshStock(product, fresh) {
  const row = fresh.get(String(product.id));
  return row ? { ...product, inventory_on_hand: row.inventory_on_hand, inventory_unit: row.inventory_unit } : product;
}

// The photo manager opens over the sheet. While it is up the sheet is inert
// and hidden from assistive tech, the way the photo manager treats its own
// marks dialog; `version` moves on each close so the count is read again.
export function usePhotoManager() {
  const [state, setState] = useState({ isOpen: false, version: 0 });
  const open = useCallback(() => setState((prev) => ({ ...prev, isOpen: true })), []);
  const close = useCallback(() => setState((prev) => ({ isOpen: false, version: prev.version + 1 })), []);
  return { ...state, open, close, hiddenProps: state.isOpen ? { 'aria-hidden': true, inert: '' } : {} };
}

export function toggleInSet(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export const CLOSED_VISIT_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const dayOf = (value) => String(value || '').slice(0, 10);
// Letters and digits only: the row's address is built in SQL and the live
// one from fields, so spacing and punctuation may differ, but a different
// unit never matches ("apt 4" vs "apt 5").
const addressKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Whether the tapped row's property is no longer the live visit's. The row's
// property id decides: a move to another unit at the same street is another
// property. A visit never stamped with one (null on both sides) falls back to
// the whole address, unit included. A row without the fields (an older
// payload) gives no verdict.
function propertyMoved(service, visit) {
  const routedId = service?.routedPropertyId;
  if (routedId !== undefined) {
    if (String(routedId ?? '') !== String(visit?.propertyId ?? '')) return true;
    if (routedId != null) return false;
  }
  const live = visit?.address;
  if (!service?.routedAddress || !live?.line1) return false;
  return addressKey(service.routedAddress) !== addressKey([live.line1, live.line2, live.city, live.state, live.zip].join(' '));
}

// The schedule row the tech tapped may be stale: the loaded visit must still
// be that visit (same customer, day and property).
export function visitChangedSinceSchedule(visit, service) {
  const movedCustomer = service?.routedCustomerId && visit?.customerId
    && String(service.routedCustomerId) !== String(visit.customerId);
  const movedDay = service?.routedScheduledDate && visit?.scheduledDate
    && dayOf(service.routedScheduledDate) !== dayOf(visit.scheduledDate);
  return !!(movedCustomer || movedDay || propertyMoved(service, visit));
}

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
// `dialogClassName` (the lawn sheet): a class on the dialog, for its scoped look.
export function FastCompleteFrame({ isMobile, dialogRef, titleId, onDismiss, hiddenProps, overlay, dialogClassName, children }) {
  const fieldPortalClass = useFieldPortalClass();
  return createPortal(
    <>
    <UiSurface
      density="touch"
      className={cn('tech-visit-surface tech-visit-overlay', isMobile && 'tech-visit-overlay--fullscreen', fieldPortalClass)}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onDismiss(); }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('tech-visit-dialog', isMobile && 'tech-visit-dialog--fullscreen', dialogClassName)}
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

// What the tech sees once the visit is saved; `children` carries a sheet's
// own line under the summary (the pest sheet's sent-text result).
export function SavedView({ service, summary, notice, onCompleted, children }) {
  return (
    <div className="tech-visit-body">
      <div className="tech-visit-card">
        <p className="tech-visit-muted">{[service?.address, service?.timeLabel].filter(Boolean).join(' · ') || 'This visit'}</p>
        <p>{summary}</p>
        {notice && <p className="tech-visit-muted tech-visit-status--warn" role="status">{notice}</p>}
        {children}
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

// "How much?" and its unit chips: the amount a row records, in the units its
// measure allows (lib/fast-complete-products.js: never mL).
export function AmountEntry({ id, row, locked, inputRef, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="tech-product-editor-label">How much?</label>
      <div className="tech-product-editor-amount">
        <Input
          ref={inputRef}
          id={id}
          className="tech-visit-control tech-product-amount-input"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          disabled={locked}
          value={row.totalAmount ?? ''}
          onChange={(e) => onChange({ totalAmount: e.target.value })}
        />
        <div role="group" aria-label="Unit" className="tech-product-units">
          {UNIT_CHOICES[row.dimension].map((choice) => (
            <Chip disabled={locked} key={choice.value} className="tech-product-unit" label={choice.label} pressed={row.amountUnit === choice.value} onClick={() => onChange({ amountUnit: choice.value })} />
          ))}
        </div>
      </div>
    </div>
  );
}

// "Edit amounts": every product's amount in its own measure's units, and
// its rate. A label rate in mL is neither shown nor recorded (owner ruling
// 2026-09-27): rowRate leaves such a row without a rate unit.
export function AmountRow({ row, rate, onChange }) {
  const inputId = useId();
  const rateId = useId();
  const overLabel = rate.max != null && parseFloat(rate.rate) > rate.max;
  return (
    <div className="tech-visit-amount-block">
      <div className="tech-visit-amount-row">
        <label htmlFor={inputId} className="tech-visit-amount-label">{row.name}</label>
        <Input
          id={inputId}
          className="tech-visit-control"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={row.totalAmount ?? ''}
          // amountPicked: the tech's own entry, even when it equals the seeded amount
          onChange={(e) => onChange({ totalAmount: e.target.value, amountPicked: true })}
        />
        <select
          className="ui-control tech-visit-control"
          aria-label={`Unit for ${row.name}`}
          value={row.amountUnit}
          onChange={(e) => onChange({ amountUnit: e.target.value, amountPicked: true })}
        >
          {UNIT_CHOICES[row.dimension].map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </div>
      {rate.rateUnit ? (
        <div className="tech-visit-amount-row">
          <label htmlFor={rateId} className="tech-visit-amount-label">{`${row.name} rate`}</label>
          <Input
            id={rateId}
            className="tech-visit-control"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={rate.rate ?? ''}
            onChange={(e) => onChange({ rateInput: e.target.value })}
          />
          <span className="tech-visit-amount-label">{unitLabel(rate.rateUnit)}</span>
        </div>
      ) : null}
      {overLabel && <p className="tech-visit-warning" role="status">&gt; label max {rate.max}</p>}
    </div>
  );
}

// The common lawn methods the sheets fall back to when the context offers none
// (an older server): the three every lawn visit uses, in screen order. The
// server's list (lawn-reservice-fast-context LAWN_METHODS) is the authority
// when it is there.
export const COMMON_LAWN_METHODS = [
  { value: 'spot_treatment', label: 'Spot treatment', common: true },
  { value: 'broadcast_spray', label: 'Broadcast spray', common: true },
  { value: 'granular_broadcast', label: 'Granular broadcast', common: true },
];

/** The context's method list, or the common three when it has none. */
export function methodChoicesOf(data) {
  const offered = (Array.isArray(data?.methods) ? data.methods : []).filter((choice) => choice?.value);
  return offered.length ? offered : COMMON_LAWN_METHODS;
}

// How a product went down. Two readings, shared by the two lawn sheets:
// `layout="chips"` (the lawn re-service sheet) puts the common methods as chips
// under "How" and the rest in a "More methods" select; `layout="select"` (the
// lawn sheet, owner 2026-10-05) is one dropdown with every method, the common
// ones first. `footnote` is the sheet's own line under the control, if any.
export function MethodSection({ row, methods, locked, onChange, footnote = null, layout = 'chips' }) {
  const methodId = useId();
  if (layout === 'select') {
    const ordered = [...methods.filter((choice) => choice.common), ...methods.filter((choice) => !choice.common)];
    const known = ordered.some((choice) => choice.value === row.method);
    return (
      <div>
        <label htmlFor={methodId} className="tech-product-editor-label">How</label>
        <Select
          id={methodId}
          aria-label={`Method for ${row.name}`}
          className="tech-visit-control"
          disabled={locked}
          value={known ? row.method : ''}
          onChange={(e) => { if (e.target.value) onChange({ method: e.target.value }); }}
        >
          {!known && <option value="">Choose a method</option>}
          {ordered.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </Select>
        {footnote && <p className="tech-visit-muted">{footnote}</p>}
      </div>
    );
  }
  // An older context without `common` shows every method as a button.
  const hasCommon = methods.some((choice) => choice.common);
  const common = hasCommon ? methods.filter((choice) => choice.common) : methods;
  const more = hasCommon ? methods.filter((choice) => !choice.common) : [];
  return (
    <div>
      <span id={methodId} className="tech-product-editor-label">How</span>
      <div role="group" aria-labelledby={methodId} className="tech-visit-tile-grid">
        {common.map((choice) => (
          <Chip disabled={locked} key={choice.value} label={choice.label} pressed={row.method === choice.value} onClick={() => onChange({ method: choice.value })} />
        ))}
      </div>
      {more.length > 0 && (
        <Select
          aria-label={`More methods for ${row.name}`}
          className="tech-visit-control"
          disabled={locked}
          value={more.some((choice) => choice.value === row.method) ? row.method : ''}
          onChange={(e) => { if (e.target.value) onChange({ method: e.target.value }); }}
        >
          <option value="">More methods</option>
          {more.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </Select>
      )}
      {footnote && <p className="tech-visit-muted">{footnote}</p>}
    </div>
  );
}

// A product tile's shell, shared by every sheet's tiles: the name, the detail
// line under it (an amount, "Tap if applied"), and the zero-stock flag. Each
// sheet decides its own detail text, the states that dim or mark the tile and
// its aria attributes (`ariaProps`: pressed for a toggle, expanded for a tile
// that opens an editor).
export function ProductTileButton({ tileRef, row, detail, off = false, added = false, editing = false, ariaProps, disabled, onClick }) {
  const outOfStock = row.active && isOutOfStock(row.product);
  return (
    <Button
      ref={tileRef}
      type="button"
      variant="secondary"
      className={cn('tech-visit-action tech-visit-product tech-visit-product-tile', {
        'tech-visit-product--off': off,
        'tech-visit-product--added': added,
        'tech-visit-product--editing': editing,
        'tech-visit-product--stock': outOfStock,
      })}
      disabled={disabled}
      onClick={onClick}
      {...ariaProps}
    >
      {/* Two lines on the tile (the amount never wraps apart from its unit);
          one name for assistive tech: "Taurus SC — 4 fl oz". */}
      <span className="tech-visit-product-name">{row.name}</span>
      <span className="sr-only"> — </span>
      <span className="tech-visit-product-amount">{detail}</span>
      {outOfStock && (
        <>
          {' '}
          <span className="tech-visit-stock-flag"><WarningIcon />0 in stock</span>
        </>
      )}
    </Button>
  );
}

export function OtherProductButton({ buttonRef, locked, onClick, hasPicker, expanded, popover }) {
  return (
    <div className="tech-product-other">
      <Button
        ref={buttonRef}
        type="button"
        variant="secondary"
        className="tech-visit-action tech-visit-wide"
        disabled={locked}
        onClick={onClick}
        {...(hasPicker ? { 'aria-haspopup': 'dialog', 'aria-expanded': expanded } : {})}
      >
        + Other product
      </Button>
      {popover}
    </div>
  );
}

// "+ Other product" opens the product picker: a bottom sheet over the form
// on a phone, a popover under the button at desktop width. With no product
// list loaded it opens the full completion screen, as it always did.
// `commonProducts` is the picker's "Used most" list, already without the
// products the sheet starts with; `rows` are the products on the sheet.
// `inline` (the lawn sheet) also returns `inlineSearch`: a search box that
// lives in the Products section itself and adds a product on one tap, with no
// sheet to open. With no catalog it is null and the button's full-form hand-off stays.
export function useProductPicker({ products, commonProducts, rows, locked, isMobile, onFullForm, onPick, line, inline = false }) {
  const buttonRef = useRef(null);
  const [open, setOpen] = useState(false);
  const hasCatalog = products.length > 0;
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  const onSheetIds = useMemo(() => new Set(rows.map((row) => String(row.productId))), [rows]);
  const shown = open && !locked;
  const picker = shown ? (
    <FastCompleteProductPicker
      variant={isMobile ? 'sheet' : 'popover'}
      {...(line ? { line } : {})}
      products={products}
      commonProducts={commonProducts}
      onSheetIds={onSheetIds}
      anchorRef={buttonRef}
      onPick={(product) => { setOpen(false); onPick(product); }}
      onClose={() => setOpen(false)}
    />
  ) : null;
  const inlineSearch = inline && hasCatalog ? (
    <FastCompleteProductPicker
      variant="inline"
      {...(line ? { line } : {})}
      products={products}
      commonProducts={commonProducts}
      onSheetIds={onSheetIds}
      locked={locked}
      onPick={onPick}
    />
  ) : null;
  const onClick = (event) => {
    if (!hasCatalog) {
      onFullForm?.();
      return;
    }
    // Safari never focuses a tapped button; the picker hands focus back here.
    event.currentTarget.focus();
    setOpen((was) => !was);
  };
  return {
    button: { buttonRef, locked, onClick, hasPicker: hasCatalog, expanded: shown },
    inlineSearch,
    popover: isMobile ? null : picker,
    sheet: isMobile ? picker : null,
    // What the phone sheet covers is out of reach until it closes.
    coverProps: shown && isMobile ? { 'aria-hidden': true, inert: '' } : {},
  };
}

// The reason sits above full-width actions, so neither squeezes the other on
// a phone or beside an extra action (`children`, e.g. "Check stock").
// `reasonInButton` (the lawn sheet): a short reason is the disabled button's
// own label instead of a line above it.
export function CompleteFooter({ submission, missingReason, warn, label, onSubmit, coverProps, children, reasonInButton = false }) {
  return (
    <footer className="tech-visit-footer tech-visit-footer--stacked" {...coverProps}>
      {submission.error && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{submission.error}</ActionFeedback>}
      {submission.storageWarning && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{submission.storageWarning}</ActionFeedback>}
      {missingReason && !submission.failure && !reasonInButton && (
        <p className={cn('tech-visit-muted', warn && 'tech-visit-status--warn')} role="status">{missingReason}</p>
      )}
      <div className="tech-visit-actions">
        {children}
        <Button
          className="tech-visit-action tech-visit-complete tech-visit-wide"
          onClick={onSubmit}
          loading={submission.submitting}
          disabled={submission.recovering || submission.failure === 'terminal' || (!!missingReason && !submission.retryPending)}
        >
          {submission.storageBypassPending ? 'Send anyway' : submission.retryPending ? 'Retry' : reasonInButton && missingReason && !submission.failure ? missingReason : label}
        </Button>
      </div>
    </footer>
  );
}

// Nothing on a sheet is editable while it checks for a saved attempt, while
// a save is in flight, or while an attempt is unresolved or refused for good.
export function submissionHolds(submission) {
  return submission.recovering || submission.submitting || submission.failure !== null;
}

// A refusal the server gave a recovered attempt stays on screen when the
// visit's live details cannot be shown (loading, unreadable or blocked);
// once they load, the form's footer carries it (GitHub Codex P2 on #5972).
export function refusalWithoutContext(submission, ctx) {
  if (submission.failure !== 'terminal' || !submission.error) return null;
  if (!(ctx.loading || ctx.loadError || ctx.blockedReason)) return null;
  return <ActionFeedback error className="tech-visit-feedback tech-visit-loading">{submission.error}</ActionFeedback>;
}

// A reload may recover a committed request before (or even when) its live
// context can be read. The retry does not rebuild from that context: this
// compact view sends only the exact stored body when the tech taps Retry.
export function RecoveredCompletion({ submission }) {
  if (submission.prompt) {
    return (
      <div className="tech-visit-form-area">
        <div className="tech-visit-body">
          <div className={cn('tech-visit-card', 'tech-report-confirm')} role="alertdialog" aria-label="Before this goes out">
            <p className="tech-visit-section-title">Before this goes out</p>
            {String(submission.prompt.message || '').split('\n').filter(Boolean).map((line) => (
              <p key={line} className="tech-visit-muted">{line}</p>
            ))}
            {submission.error && <ActionFeedback error className="tech-visit-feedback">{submission.error}</ActionFeedback>}
            <div className="tech-visit-tile-grid">
              <Chip label="Go back" disabled={submission.submitting} onClick={submission.dismissPrompt} />
              <Chip label="Send as is" disabled={submission.submitting} onClick={submission.confirm} />
            </div>
          </div>
        </div>
      </div>
    );
  }
  const canRetry = submission.hasPendingBody() && submission.retryPending;
  // A request refused for good whose saved copy would not clear keeps it here
  // to discard, never to retry.
  const canDiscard = submission.hasPendingBody() && (submission.retryPending || submission.failure === 'terminal');
  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body">
        <ActionFeedback className="tech-visit-feedback">
          {submission.pendingSummary
            ? `Saved completion: ${submission.pendingSummary}`
            : 'An unfinished completion is saved on this device.'}
        </ActionFeedback>
      </div>
      <CompleteFooter
        submission={submission}
        label="Retry completion"
        onSubmit={submission.retry}
        missingReason={canRetry ? '' : 'Close and reopen this visit to make a new completion.'}
      >
        {canDiscard && (
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={submission.discard}>
            Discard saved retry
          </Button>
        )}
      </CompleteFooter>
    </div>
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
// `children` (the report flow's photos, GATE_NOTE_BOX_PHOTOS) sit inside the
// note's box under the words; without them the note is exactly as before.
// `onClip` (voice fill on the report flow): the mic records and the clip goes to
// our own transcriber, which answers the words for this box.
// `micInside` (the lawn sheet): the mic sits in the box's bottom-right corner
// instead of beside it, and the box keeps clear padding so words never run under it.
export function VisitNote({ note, onChange, onDictated, onDictationPending, serviceId, locked, onClip, children, micInside = false }) {
  const noteId = useId();
  const text = (
    <Textarea
      id={noteId}
      className="tech-visit-control"
      rows={3}
      value={note}
      disabled={locked}
      onChange={(e) => onChange(e.target.value)}
      placeholder="What you treated, where, and what you saw"
    />
  );
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title"><label htmlFor={noteId}>Tell me about the visit</label></h3>
      </div>
      <div className={cn('tech-visit-note-row', micInside && 'tech-visit-note-row--inside')}>
        {micInside ? (
          <>
            {children ? <div className="tech-visit-note-box">{text}{children}</div> : text}
            <span className="tech-visit-note-mic">
              <DictationButton onAppend={onDictated} onPendingChange={onDictationPending} palette={MIC_PALETTE} size={40} title="Talk about the visit" disabled={locked} uploadServiceId={serviceId} clipHandler={onClip} />
            </span>
          </>
        ) : (
          <>
            <DictationButton onAppend={onDictated} onPendingChange={onDictationPending} palette={MIC_PALETTE} size={48} title="Talk about the visit" disabled={locked} uploadServiceId={serviceId} clipHandler={onClip} />
            {children ? <div className="tech-visit-note-box">{text}{children}</div> : text}
          </>
        )}
      </div>
    </section>
  );
}

// The tip library, read on its own: the picker is optional, so a slow or
// failed read never holds the sheet. null until it arrives, and when the
// read fails or the tips gate is off. `refreshKey` reads it again when it
// changes (the lawn sheet passes its confirmed assessment, which re-ranks the
// list). A re-read that FAILS keeps the tips on screen; one that answers
// unavailable (the tips gate went off) clears them, since the server would drop
// the pick.
export function useTipLibrary({ base, request, refreshKey = null }) {
  const [library, setLibrary] = useState(null);
  useEffect(() => {
    let active = true;
    request(`${base}/tech-tips`)
      .then((data) => { if (active) setLibrary(data?.available === true ? data : null); })
      .catch(() => {});
    return () => { active = false; };
  }, [base, request, refreshKey]);
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
// resolves and freezes the copy. `priorityTipIds` (optional, the tree & shrub
// sheet's seen watch items) lifts those tips above the list under their own
// heading, in library order; a search ignores it, and nothing is ever picked
// for the tech.
// `quiet` (the lawn sheet): no "Search tips" label and no "Pick 1 (optional)"
// hint; the search box keeps its name as an aria-label and the section keeps the
// hint as its aria-description. The one-tip limit is unchanged.
export function TipSection({ library, tipId, customTip, locked, onPick, onCustom, priorityTipIds, priorityOrdered = false, quiet = false }) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [writing, setWriting] = useState(false);
  const allTips = useMemo(
    () => (library?.groups || []).flatMap((group) => group.tips || []),
    [library],
  );
  const q = query.trim().toLowerCase();
  const priority = useMemo(() => {
    if (!priorityTipIds?.length) return [];
    const ids = new Set(priorityTipIds);
    const lifted = allTips.filter((tip) => ids.has(tip.id));
    // Library order by default (the tree & shrub Seen list); `priorityOrdered`
    // keeps the caller's own ranking (the lawn sheet's note matches, best first).
    return priorityOrdered ? lifted.sort((a, b) => priorityTipIds.indexOf(a.id) - priorityTipIds.indexOf(b.id)) : lifted;
  }, [allTips, priorityTipIds, priorityOrdered]);
  const lifted = !q && priority.length > 0;
  const rest = lifted ? allTips.filter((tip) => !priority.includes(tip)) : allTips;
  const { tips: visible, noMatch } = visibleTips(rest, { query: q, showAll, tipId });
  const hasPick = !!tipId || !!customTip.trim();
  const writingOwn = writing || !!customTip;
  return (
    <section className="tech-visit-choice-section" {...(quiet ? { 'aria-description': 'Pick 1 (optional)' } : {})}>
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Tip for the customer</h3>
        {(!quiet || hasPick) && <span className="tech-visit-muted">{hasPick ? '1 picked' : 'Pick 1 (optional)'}</span>}
      </div>
      {quiet ? (
        <div className="ui-field tech-visit-field">
          <Input className="tech-visit-control" aria-label="Search tips" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ants, porch light" />
        </div>
      ) : (
        <Field label="Search tips" className="tech-visit-field">
          <Input className="tech-visit-control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ants, porch light" />
        </Field>
      )}
      {lifted && (
        <>
          <h4 className="tech-visit-muted">For what you saw today</h4>
          <div className="tech-visit-tip-list">
            {priority.map((tip) => (
              <TipOption key={tip.id} tip={tip} library={library} pressed={tip.id === tipId} locked={locked} onPick={onPick} />
            ))}
          </div>
          <h4 className="tech-visit-muted">Other tips</h4>
        </>
      )}
      <div className="tech-visit-tip-list">
        {visible.map((tip) => (
          <TipOption key={tip.id} tip={tip} library={library} pressed={tip.id === tipId} locked={locked} onPick={onPick} />
        ))}
        {noMatch && <p className="tech-visit-muted">No tips match.</p>}
      </div>
      <div className="tech-visit-tile-grid">
        {!q && rest.length > TIP_PREVIEW_COUNT && (
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
