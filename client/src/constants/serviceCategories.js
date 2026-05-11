export const SERVICE_CATEGORIES = [
  { value: 'pest_control', label: 'Pest Control' },
  { value: 'lawn_care', label: 'Lawn Care' },
  { value: 'mosquito', label: 'Mosquito' },
  { value: 'termite', label: 'Termite' },
  { value: 'rodent', label: 'Rodent' },
  { value: 'tree_shrub', label: 'Tree & Shrub' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'specialty', label: 'Specialty' },
  { value: 'other', label: 'Other' },
];

export const SERVICE_CATEGORY_LABELS = SERVICE_CATEGORIES.reduce((labels, category) => {
  labels[category.value] = category.label;
  return labels;
}, {});
