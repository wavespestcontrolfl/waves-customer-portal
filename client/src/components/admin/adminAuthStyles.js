// Shared look for the staff auth pages (sign in, two-step, forgot, reset and
// change password). They render outside AdminLayoutV2, so they keep inline
// styles, but the values mirror the admin tokens in tailwind.config.js
// (surface / ink / zinc / alert) so the first screen staff see matches the
// admin they land in. Focus rings live in index.css (.admin-auth-page).

export const AUTH = {
  page: '#FAFAFA', // surface.page
  card: '#FFFFFF', // surface.card
  sunken: '#F4F4F5', // surface.sunken
  border: '#E4E4E7', // zinc-200
  control: '#D4D4D8', // zinc-300
  text: '#18181B', // ink.primary
  muted: '#52525B', // ink.secondary
  onPrimary: '#FFFFFF',
  alertBg: '#FCEBEB', // alert.bg
  alertText: '#A32D2D', // alert.hover
};

export const ADMIN_FONT = "'Roboto', Arial, sans-serif";

export const authPageStyle = {
  background: AUTH.page,
  color: AUTH.text,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: ADMIN_FONT,
};

export const authTitleStyle = { fontSize: 22, fontWeight: 500, margin: 0, color: AUTH.text };
export const authIntroStyle = { fontSize: 14, lineHeight: 1.5, color: AUTH.muted, margin: '8px 0 0' };
export const authCardStyle = { background: AUTH.card, borderRadius: 8, padding: 28, border: `1px solid ${AUTH.border}` };
export const authLabelStyle = { display: 'block', color: AUTH.text, fontSize: 14, fontWeight: 500, marginBottom: 6 };

export const authInputStyle = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 6,
  border: `1px solid ${AUTH.control}`,
  fontSize: 16,
  fontFamily: ADMIN_FONT,
  color: AUTH.text,
  background: AUTH.card,
  boxSizing: 'border-box',
};

export const authErrorStyle = { marginTop: 14, padding: '10px 14px', borderRadius: 6, background: AUTH.alertBg, color: AUTH.alertText, fontSize: 14 };
export const authNoticeStyle = { marginBottom: 16, padding: '10px 14px', borderRadius: 6, background: AUTH.card, border: `1px solid ${AUTH.border}`, color: AUTH.text, fontSize: 14 };

export function authPrimaryButton(busy) {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 48,
    marginTop: 18,
    border: `1px solid ${AUTH.text}`,
    borderRadius: 6,
    background: AUTH.text,
    color: AUTH.onPrimary,
    fontSize: 14,
    fontWeight: 500,
    fontFamily: ADMIN_FONT,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
    transition: 'background-color 0.15s ease, opacity 0.15s ease',
  };
}

export const authSecondaryButton = {
  minHeight: 44,
  border: `1px solid ${AUTH.control}`,
  borderRadius: 6,
  background: AUTH.card,
  color: AUTH.text,
  fontSize: 14,
  fontWeight: 500,
  fontFamily: ADMIN_FONT,
  cursor: 'pointer',
};

// Text links and link-style buttons: primary ink, underlined, 44px target.
export const authLinkStyle = {
  color: AUTH.text,
  fontSize: 14,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
};
