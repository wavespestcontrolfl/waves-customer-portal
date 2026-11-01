import Icon from '../Icon';
import { BUTTON_BASE, COLORS as B, CUSTOMER_SECTION_LABEL } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import { PET_NAME_ASK_COPY as COPY } from './petNameAskCopy';

// =========================================================================
// Pet-name ask: a small Home card that asks a WaveGuard member for their dogs'
// and cats' names, so the text after each visit can name them
// (server/services/pet-name-line.js). The server decides: GET
// /api/property/preferences carries petNameAsk: true only while
// GATE_PET_NAME_TEXT is live, for a member with no name the text could use.
// DashboardTab owns the read, the "Not now" memory and the link to the Pets
// section of the Property tab; this file only lays the card out. All words
// live in petNameAskCopy.js.
// =========================================================================

const DEFAULT_CARD = { background: '#FFFFFF', border: '1px solid #E7E2D7', borderRadius: 16, position: 'relative' };
const addStyle = {
  ...BUTTON_BASE, letterSpacing: 0, background: B.glassNavy, color: '#fff', padding: '10px 18px',
  minHeight: 44, boxShadow: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700,
};
const notNowStyle = {
  ...BUTTON_BASE, letterSpacing: 0, background: 'transparent', color: B.glassNavy, padding: '10px 14px',
  minHeight: 44, boxShadow: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, border: `1px solid ${SHELL.softBorder}`,
};

export default function PetNameAskCard({ onAdd, onNotNow, cardStyle = DEFAULT_CARD }) {
  return (
    <section data-glass="card" data-testid="pet-name-ask-card" style={{ ...cardStyle, padding: 20, display: 'grid', gap: 12 }}>
      <div data-glass="chip" style={CUSTOMER_SECTION_LABEL}><Icon name="paw" size={14} strokeWidth={2} />{COPY.kicker}</div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: B.glassNavy, lineHeight: 1.25 }}>{COPY.title}</h2>
      <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.45 }}>{COPY.body}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" data-testid="pet-name-ask-add" onClick={onAdd} style={addStyle}>{COPY.addButton}</button>
        <button type="button" data-testid="pet-name-ask-not-now" onClick={onNotNow} style={notNowStyle}>{COPY.notNow}</button>
      </div>
    </section>
  );
}
