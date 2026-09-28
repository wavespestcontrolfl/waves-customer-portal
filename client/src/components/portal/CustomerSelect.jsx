import Icon from '../Icon';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';

// Native option picker with the same glass control on WebKit and Chromium.
export default function CustomerSelect({ children, disabled, fullWidth = false, style, ...props }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, minWidth: 0, width: fullWidth ? '100%' : undefined }}>
      <select {...props} disabled={disabled} style={{
        appearance: 'none', WebkitAppearance: 'none',
        fontSize: 16, fontWeight: 700, color: SHELL.text, fontFamily: 'inherit',
        border: `1px solid ${SHELL.borderStrong}`, borderRadius: 8, background: 'rgba(255,255,255,0.55)',
        padding: '7px 32px 7px 12px', minHeight: 44, lineHeight: 1.25, boxSizing: 'border-box',
        width: fullWidth ? '100%' : undefined,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
        ...style,
      }}>
        {children}
      </select>
      <Icon name="chevronDown" size={16} strokeWidth={2} style={{
        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
        pointerEvents: 'none', zIndex: 3, color: SHELL.text, opacity: disabled ? 0.4 : 1,
      }} />
    </span>
  );
}
