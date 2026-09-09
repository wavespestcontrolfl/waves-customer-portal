import React, { useState } from 'react';
import { Button, Input, Select } from '../ui';

const roles = [
  ['unknown', 'Role not recorded'], ['owner_occupied', 'Customer lives here'],
  ['family_occupied', 'Family member lives here'], ['rental_investment', 'Rental property'],
  ['commercial', 'Commercial'], ['seasonal', 'Seasonal home'], ['vacant', 'Vacant'],
];

export default function SmsAdditionalPropertyEvidence({ item, busy, onApply, active }) {
  const payload = item.payload || {};
  const [addresses, setAddresses] = useState(() => payload.additional_property_proposals.map((p) => ({
    ...p, state: p.state || 'FL', occupancy_type: 'unknown',
  })));
  const [responsibility, setResponsibility] = useState('');
  const change = (index, key, value) => setAddresses((rows) => rows.map((row, i) => i === index ? { ...row, [key]: value } : row));
  const complete = addresses.every((a) => a.address_line1 && a.city && /^[A-Z]{2}$/.test(a.state) && /^\d{5}(?:-\d{4})?$/.test(a.zip || ''));
  return <div className="mt-3 space-y-4 text-14 text-zinc-700">
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <p className="font-medium text-zinc-900">Customer’s full text</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{payload.sms_text}</p>
    </div>
    {addresses.map((address, index) => <div key={index} className="space-y-3 rounded-md border border-zinc-200 p-3">
      <p className="font-medium text-zinc-900">Address {index + 1}</p>
      <p className="whitespace-pre-wrap break-words italic">“{address.quote}”</p>
      {address.label && <p>Customer’s label: {address.label}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[['address_line1', 'Street address'], ['address_line2', 'Unit (optional)'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP code']].map(([key, label]) =>
          <label key={key} className="block">{label}<Input className="mt-1 !h-11 !text-14" value={address[key] || ''}
            disabled={!active || busy} onChange={(e) => change(index, key, e.target.value)} /></label>)}
        <label className="block">Property role<Select className="mt-1 !h-11 !text-14" value={address.occupancy_type}
          disabled={!active || busy} onChange={(e) => change(index, 'occupancy_type', e.target.value)}>
          {roles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></label>
      </div>
    </div>)}
    {active && <>
      <label className="block font-medium">Service and billing responsibility
        <Select className="mt-1 !h-11 !text-14" value={responsibility} disabled={busy} onChange={(e) => setResponsibility(e.target.value)}>
          <option value="">Choose after reviewing the message</option>
          <option value="same">This customer for every address</option>
          <option value="review">Different or unclear</option>
        </Select>
      </label>
      {responsibility === 'review' && <p>Keep this card open while the office confirms the account arrangement.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button className="!h-11 !text-14" disabled={busy || responsibility !== 'same' || !complete}
          onClick={() => onApply(item, { same_responsibility: true, addresses })}>{busy ? 'Adding…' : 'Add properties'}</Button>
        <a className="inline-flex min-h-11 items-center text-zinc-700 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-500" href={`/admin/customers?customerId=${encodeURIComponent(item.customer_id)}&tab=properties`}>Open customer</a>
      </div>
    </>}
  </div>;
}
