import React from 'react';
import { propertyStreetLine } from '@waves/invoice-property-groups';
import { DOC, DOC_FONT, FS, FW, LH } from '../../theme-doc';

// Multi-property invoice rows for the pay and receipt item tables: the lines
// grouped under each property's address, with that property's line-item
// discounts and subtotal. Rendered INSIDE the existing table shell (header row
// stays with the page) so a flat invoice's table is untouched.
const ROW = {
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  gap: '0 16px',
  padding: '12px',
  borderTop: `1px solid ${DOC.border}`,
  fontSize: FS.body,
  color: DOC.ink,
  alignItems: 'start',
};

function amountOf(item) {
  return Number(item.amount ?? (Number(item.quantity) || 1) * (Number(item.unit_price) || 0));
}

export default function PropertyLineGroups({ groups, fmtCurrency }) {
  return (
    <>
      {groups.map((group, groupIdx) => (
        <React.Fragment key={group.property_id || groupIdx}>
          <div
            data-testid="property-group-heading"
            style={{
              ...ROW,
              display: 'block',
              borderTop: groupIdx === 0 ? 'none' : `1px solid ${DOC.border}`,
              background: DOC.soft,
              fontWeight: FW.bold,
              lineHeight: LH.snug,
            }}
          >
            {group.label}
          </div>
          {group.lines.map((item, idx) => (
            <div key={`line-${item.client_id || idx}`} style={ROW}>
              <div style={{ lineHeight: LH.snug, minWidth: 0 }}>{item.description}</div>
              <div style={{ textAlign: 'right', fontFamily: DOC_FONT }}>{item.quantity || 1}</div>
              <div style={{ textAlign: 'right', fontFamily: DOC_FONT, minWidth: 82, fontWeight: FW.semibold }}>
                {fmtCurrency(amountOf(item))}
              </div>
            </div>
          ))}
          {group.discounts.map((item, idx) => (
            <div key={`discount-${item.client_id || idx}`} style={{ ...ROW, color: DOC.success }}>
              <div style={{ lineHeight: LH.snug, minWidth: 0 }}>{item.description}</div>
              <div />
              <div style={{ textAlign: 'right', fontFamily: DOC_FONT, minWidth: 82, fontWeight: FW.semibold }}>
                {`− ${fmtCurrency(Math.abs(amountOf(item)))}`}
              </div>
            </div>
          ))}
          <div style={{ ...ROW, color: DOC.muted, fontWeight: FW.medium }}>
            <div style={{ textAlign: 'right' }}>{`${propertyStreetLine(group.address) || 'Property'} subtotal`}</div>
            <div />
            <div style={{ textAlign: 'right', fontFamily: DOC_FONT, minWidth: 82, color: DOC.ink }}>
              {fmtCurrency(group.subtotal)}
            </div>
          </div>
        </React.Fragment>
      ))}
    </>
  );
}
