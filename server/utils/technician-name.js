function namePartsFromString(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean);
}

function formatTechnicianForCustomer(technician = {}) {
  const first = String(technician.first_name || '').trim();
  const last = String(technician.last_name || '').trim();
  if (first && last) return `${first} ${last[0].toUpperCase()}.`;

  const parts = namePartsFromString(technician.name || technician.tech_name || technician.technician_name);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  return parts[0] || 'Your Waves technician';
}

function initialsForCustomerTechnicianName(name) {
  const parts = namePartsFromString(name);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'W';
}

module.exports = {
  formatTechnicianForCustomer,
  initialsForCustomerTechnicianName,
};
