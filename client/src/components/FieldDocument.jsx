import React from 'react';
import {
  WAVES_ADDRESS_LINE,
  WAVES_FL_LICENSE_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
} from '../constants/business';
import { FIELD_DOCUMENT } from '../theme-doc';
import './field-document.css';

const WAVES_EMAIL = 'contact@wavespestcontrol.com';

function fieldVars() {
  return {
    '--field-navy': FIELD_DOCUMENT.navy,
    '--field-blue': FIELD_DOCUMENT.blue,
    '--field-gold': FIELD_DOCUMENT.gold,
    '--field-ink': FIELD_DOCUMENT.ink,
    '--field-muted': FIELD_DOCUMENT.muted,
    '--field-rule': FIELD_DOCUMENT.rule,
    '--field-soft': FIELD_DOCUMENT.soft,
    '--field-warm': FIELD_DOCUMENT.warm,
    '--field-paper': FIELD_DOCUMENT.paper,
    '--field-canvas': FIELD_DOCUMENT.canvas,
    '--field-prose-size': `${FIELD_DOCUMENT.screen.prose}px`,
    '--field-meta-size': `${FIELD_DOCUMENT.screen.meta}px`,
    '--field-section-size': `${FIELD_DOCUMENT.screen.section}px`,
    '--field-title-size': `${FIELD_DOCUMENT.screen.title}px`,
    '--field-print-prose-size': FIELD_DOCUMENT.print.prose,
    '--field-print-meta-size': FIELD_DOCUMENT.print.meta,
    '--field-print-fine-size': FIELD_DOCUMENT.print.fine,
    '--field-print-section-size': FIELD_DOCUMENT.print.section,
    '--field-print-title-size': FIELD_DOCUMENT.print.title,
  };
}

export const FIELD_DOCUMENT_CLASSES = Object.freeze({
  root: 'waves-field-document',
  body: 'waves-field-document-body',
  sheet: 'field-document-sheet',
  masthead: 'field-document-masthead',
  title: 'field-document-title',
  section: 'field-section-heading',
  metaGrid: 'field-info-grid',
  metaRow: 'field-info-row',
});

export function FieldDocument({ children, className = '', sheetClassName = '', style }) {
  return (
    <div className={`${FIELD_DOCUMENT_CLASSES.root}${className ? ` ${className}` : ''}`} style={{ ...fieldVars(), ...style }}>
      <div className={`${FIELD_DOCUMENT_CLASSES.sheet}${sheetClassName ? ` ${sheetClassName}` : ''}`}>
        {children}
      </div>
    </div>
  );
}

// Used where action/share/assistant chrome must remain outside the authored
// page while the report body itself adopts Field presentation.
export function FieldDocumentBody({ children, className = '', style }) {
  return (
    <div className={`${FIELD_DOCUMENT_CLASSES.body}${className ? ` ${className}` : ''}`} style={{ ...fieldVars(), ...style }}>
      {children}
    </div>
  );
}

export function FieldMasthead({ licenseLine = WAVES_FL_LICENSE_LINE, variant = 'customer' }) {
  const staff = variant === 'staff';
  return (
    <header className={FIELD_DOCUMENT_CLASSES.masthead}>
      <div className="field-document-brand">
        {!staff && <img src="/waves-logo.png" alt="Waves Pest Control" />}
        <div>
          <div className="field-document-brand-name">Waves Pest Control</div>
          <div className="field-document-license">{staff ? 'Controlled staff document' : licenseLine}</div>
        </div>
      </div>
      {!staff && <div className="field-document-contact">
        <a className="field-document-phone" href={WAVES_SUPPORT_PHONE_TEL}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>
        <div>
          <a href={`mailto:${WAVES_EMAIL}`}>{WAVES_EMAIL}</a>
          {' · '}
          <a href="https://www.wavespestcontrol.com">wavespestcontrol.com</a>
        </div>
        <div>{WAVES_ADDRESS_LINE}</div>
      </div>}
    </header>
  );
}

export function FieldTitle({ eyebrow, title, subtitle, reference }) {
  return (
    <div className={FIELD_DOCUMENT_CLASSES.title}>
      <div className="field-document-title-copy">
        {eyebrow ? <div className="field-document-doctype">{eyebrow}</div> : null}
        <div role="heading" aria-level={1} className="field-document-h1">{title}</div>
        {subtitle ? <div className="field-document-subtitle">{subtitle}</div> : null}
      </div>
      {reference ? <div className="field-document-reference">{reference}</div> : null}
    </div>
  );
}

export function FieldFooter({ label, reference }) {
  return (
    <footer className="field-document-footer">
      <div>
        <strong>Waves Pest Control, LLC</strong>
        {label ? <div>{label}</div> : null}
      </div>
      {reference ? <div className="field-document-footer-reference">{reference}</div> : null}
    </footer>
  );
}
