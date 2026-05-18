const CLEAN_VISIT_FINDINGS = {
  pest: {
    title: 'No activity observed this visit',
    detail: 'All inspected zones were clear of pest activity and conducive conditions. Continuing routine protective service per schedule.',
  },
  mosquito: {
    title: 'No mosquito activity observed this visit',
    detail: 'Inspected mosquito treatment zones were clear of notable mosquito activity and breeding conditions. Continuing routine mosquito service per schedule.',
  },
  termite: {
    title: 'No termite activity observed this visit',
    detail: 'Inspected termite monitoring areas were clear of termite activity and conducive conditions. Continuing routine termite protection per schedule.',
  },
  rodent: {
    title: 'No rodent activity observed this visit',
    detail: 'Inspected exclusion and monitoring areas were clear of rodent activity. Continuing routine rodent protection per schedule.',
  },
  lawn: {
    title: 'No lawn issues observed this visit',
    detail: 'Turf areas inspected during this visit did not show conditions requiring a corrective finding. Continuing routine lawn care per schedule.',
  },
  tree_shrub: {
    title: 'No tree or shrub issues observed this visit',
    detail: 'Inspected tree and shrub areas did not show conditions requiring a corrective finding. Continuing routine plant health care per schedule.',
  },
  palm: {
    title: 'No palm issues observed this visit',
    detail: 'Inspected palms did not show conditions requiring a corrective finding. Continuing routine palm care per schedule.',
  },
};

function buildNoActivityFinding(serviceLine = 'pest') {
  const copy = CLEAN_VISIT_FINDINGS[serviceLine] || {
    title: 'No issues observed this visit',
    detail: 'Inspected service areas did not show conditions requiring a corrective finding. Continuing routine service per schedule.',
  };
  return {
    category: 'no_activity',
    severity: 'info',
    title: copy.title,
    detail: copy.detail,
    recommendation: null,
  };
}

module.exports = {
  CLEAN_VISIT_FINDINGS,
  buildNoActivityFinding,
};
