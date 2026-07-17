import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useModalFocus from '../../hooks/useModalFocus';
import { COLORS, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import Icon from '../Icon';

const DIALOG_EVENT = 'waves:customer-dialog';

function requestDialog(kind, message, options = {}) {
  if (typeof window === 'undefined') return Promise.resolve(kind !== 'confirm');
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(DIALOG_EVENT, {
      detail: { kind, message, options, resolve },
    }));
  });
}

export function showCustomerAlert(message, options = {}) {
  return requestDialog('alert', message, options);
}

export function showCustomerConfirm(message, options = {}) {
  return requestDialog('confirm', message, options);
}

export default function CustomerDialogHost() {
  const [dialogs, setDialogs] = useState([]);
  const active = dialogs[0] || null;

  useEffect(() => {
    const enqueue = (event) => setDialogs((current) => [...current, event.detail]);
    window.addEventListener(DIALOG_EVENT, enqueue);
    return () => window.removeEventListener(DIALOG_EVENT, enqueue);
  }, []);

  const settle = useCallback((result) => {
    setDialogs((current) => {
      const [dialog, ...rest] = current;
      dialog?.resolve(result);
      return rest;
    });
  }, []);

  useLockBodyScroll(Boolean(active));
  const dialogRef = useModalFocus(Boolean(active), () => settle(false));

  if (!active || typeof document === 'undefined') return null;

  const { kind, message, options } = active;
  const confirm = kind === 'confirm';
  const danger = Boolean(options.danger);
  const title = options.title || (confirm ? 'Please confirm' : 'Something went wrong');
  const confirmLabel = options.confirmLabel || (confirm ? 'Confirm' : 'OK');
  const cancelLabel = options.cancelLabel || 'Cancel';

  return createPortal(
    <div
      data-glass-scrim=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) settle(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(15,23,42,0.48)',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div
        ref={dialogRef}
        role={confirm ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="customer-dialog-title"
        aria-describedby="customer-dialog-message"
        data-glass="modal"
        style={{
          width: 'min(420px, 100%)',
          position: 'relative',
          padding: 24,
          borderRadius: 16,
          background: 'rgba(255,255,255,0.94)',
          border: `1px solid ${CUSTOMER_SURFACE.border}`,
          boxShadow: '0 24px 70px rgba(4,57,94,0.24)',
          fontFamily: FONTS.body,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <span style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: danger ? `${COLORS.red}12` : CUSTOMER_SURFACE.soft,
            color: danger ? COLORS.red : COLORS.glassNavy,
          }}>
            <Icon name="warning" size={20} strokeWidth={2} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h2 id="customer-dialog-title" style={{
              margin: 0,
              color: CUSTOMER_SURFACE.text,
              fontFamily: FONTS.heading,
              fontSize: 19,
              lineHeight: 1.25,
            }}>
              {title}
            </h2>
            <p id="customer-dialog-message" style={{
              margin: '7px 0 0',
              color: CUSTOMER_SURFACE.body,
              fontSize: 14,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
            }}>
              {message}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
          {confirm && (
            <button
              type="button"
              autoFocus
              data-glass="chip"
              onClick={() => settle(false)}
              style={{
                minHeight: 42,
                padding: '0 17px',
                borderRadius: 10,
                border: `1px solid ${CUSTOMER_SURFACE.borderStrong}`,
                background: 'rgba(255,255,255,0.78)',
                color: CUSTOMER_SURFACE.text,
                fontFamily: FONTS.heading,
                fontSize: 14,
                fontWeight: 850,
                cursor: 'pointer',
              }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            autoFocus={!confirm}
            data-glass-accent={danger ? undefined : ''}
            onClick={() => settle(true)}
            style={{
              minHeight: 42,
              padding: '0 18px',
              borderRadius: 10,
              border: danger ? `1px solid ${COLORS.red}` : '1px solid rgba(4,57,94,0.16)',
              background: danger ? COLORS.red : COLORS.glassNavy,
              color: '#fff',
              fontFamily: FONTS.heading,
              fontSize: 14,
              fontWeight: 850,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
