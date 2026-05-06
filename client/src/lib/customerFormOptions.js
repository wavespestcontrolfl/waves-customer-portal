export const LEAD_SOURCE_OPTIONS = [
  'existing_customer',
  'manual_entry',
  'referral',
  'phone_call',
  'google',
  'facebook',
  'nextdoor',
  'website',
  'door_knock',
  'yelp',
  'field_tech',
  'other',
];

export const PROPERTY_LABEL_OPTIONS = [
  { value: 'Primary', label: 'Primary' },
  { value: 'Rental property', label: 'Rental property' },
  { value: 'Vacation home', label: 'Vacation home' },
  { value: 'Airbnb / short-term rental', label: 'Airbnb / short-term rental' },
  { value: 'Family property', label: 'Family property' },
  { value: 'Commercial property', label: 'Commercial property' },
  { value: 'HOA / common area', label: 'HOA / common area' },
  { value: 'Other property', label: 'Other property' },
  { value: '__custom__', label: 'Custom label...' },
];

export const CUSTOMER_TAG_OPTIONS = [
  { value: 'multi_property', label: 'Multi-property' },
  { value: 'existing_customer_addon', label: 'Existing customer add-on' },
  { value: 'rental_property', label: 'Rental property' },
  { value: 'short_term_rental', label: 'Short-term rental' },
  { value: 'family_property', label: 'Family property' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'vip', label: 'VIP' },
  { value: 'referral_machine', label: 'Referral machine' },
  { value: 'price_sensitive', label: 'Price sensitive' },
  { value: 'gate_code_required', label: 'Gate code required' },
  { value: 'pets_on_property', label: 'Pets on property' },
];

export function normalizeCustomerTag(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
