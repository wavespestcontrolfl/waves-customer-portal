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

// Badge tooltip — say what the role MEANS for this profile, per role.
const CONTACT_ROLE_TITLES = {
  owner: "Contact owns / occupies the serviced property",
  property_manager:
    "Contact manages the properties for their owners — payer is not the occupant",
  tenant: "Contact occupies but does not own the serviced property",
};

export function contactRoleTitle(role) {
  return CONTACT_ROLE_TITLES[role] || "Contact role";
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

// Relationship vocabulary of customer_properties.relationship (server
// constants/property-relationships.js) — how the CUSTOMER relates to the
// address, distinct from occupancy. "" = not recorded.
export const RELATIONSHIP_OPTIONS = [
  { value: "", label: "Not recorded" },
  { value: "own_home", label: "Own home" },
  { value: "rental_owned", label: "Rental I own" },
  { value: "family_home", label: "Family member's home" },
  { value: "managed_for_client", label: "Managed for a client" },
];

// One-word chip copy for the New Appointment service-address picker. Reads
// customer_properties.relationship when the row carries it (own_home /
// rental_owned / family_home / managed_for_client — see
// server/constants/property-relationships.js) and falls back to the occupancy
// so an unclassified row still says something useful.
const RELATIONSHIP_SHORT_LABELS = {
  own_home: "Home",
  rental_owned: "Rental",
  family_home: "Family",
  managed_for_client: "Managed",
};

export function propertyRelationshipChip(property) {
  if (!property) return "";
  if (RELATIONSHIP_SHORT_LABELS[property.relationship]) return RELATIONSHIP_SHORT_LABELS[property.relationship];
  const occ = OCCUPANCY_OPTIONS.find((o) => o.value === property.occupancy_type && o.value !== "unknown");
  return occ ? occ.label : "";
}
