function namePartsFromString(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean);
}

function isGenericTechnicianLabel(name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    'your waves technician',
    'your technician',
    'your tech',
    'waves technician',
    'waves team',
  ].includes(normalized);
}

function formatTechnicianForCustomer(technician = {}) {
  const first = String(technician.first_name || '').trim();
  const last = String(technician.last_name || '').trim();
  if (first && last) return `${first} ${last[0].toUpperCase()}.`;

  const rawName = technician.name || technician.tech_name || technician.technician_name;
  if (isGenericTechnicianLabel(rawName)) return String(rawName).trim();

  const parts = namePartsFromString(rawName);
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
  isGenericTechnicianLabel,
};
