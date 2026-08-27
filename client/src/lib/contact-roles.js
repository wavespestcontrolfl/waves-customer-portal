// Mirrors server/constants/contact-roles.js — the customers.contact_role enum.
export const CONTACT_ROLE_OPTIONS = [
  { value: "", label: "Not recorded (treated as owner)" },
  { value: "owner", label: "Owner / occupant" },
  { value: "property_manager", label: "Property manager" },
  { value: "tenant", label: "Tenant" },
];

export const CONTACT_ROLE_LABELS = {
  owner: "Owner",
  property_manager: "Property manager",
  tenant: "Tenant",
};

export function contactRoleLabel(role) {
  return CONTACT_ROLE_LABELS[role] || "";
}

// Occupancy vocabulary of customer_properties.occupancy_type (server
// services/customer-properties.js OCCUPANCY_TYPES).
export const OCCUPANCY_OPTIONS = [
  { value: "unknown", label: "Unknown" },
  { value: "owner_occupied", label: "Owner-occupied" },
  { value: "rental_investment", label: "Rental / investment" },
  { value: "seasonal", label: "Seasonal" },
  { value: "vacant", label: "Vacant" },
  { value: "commercial", label: "Commercial" },
];
