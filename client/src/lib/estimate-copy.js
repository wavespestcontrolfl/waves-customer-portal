export const SERVICE_COPY = {
  pest_control: {
    headline: "Hey {first}, choose your pest control option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your property before pricing this estimate',
    aiBody: 'We reviewed your home, lot, and pest-risk factors before pricing this plan.',
    askChips: [
      'How do you handle ants?',
      'Can you treat inside?',
      'When am I charged?',
      'What happens after approval?',
    ],
    priceWording: {},
  },
  rodent: {
    headline: "Hey {first}, here's your rodent remediation plan.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed rodent activity signals at your property',
    aiBody: 'We reviewed property conditions linked to rodent pressure and entry risk.',
    askChips: [
      'Trapping vs exclusion?',
      'Do I need sanitation?',
      'Is the inspection fee credited?',
      "How long until they're gone?",
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  tree_shrub: {
    headline: "Hey {first}, choose your tree & shrub option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your beds and trees before pricing this estimate',
    aiBody: 'We reviewed your beds, trees, and treatment needs before pricing this plan.',
    askChips: [
      'Which trees get treated?',
      'What gets applied?',
      'When do visits start?',
      'Can I prepay annually?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  mosquito: {
    headline: "Hey {first}, choose your mosquito control option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your lot and mosquito pressure before pricing this estimate',
    aiBody: 'We reviewed your lot, resting zones, and mosquito pressure before pricing this plan.',
    askChips: [
      'How long does each visit last?',
      'Pet & kid safe?',
      'When does the season start?',
      'What about my pool area?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  termite_bait: {
    headline: "Hey {first}, choose your termite protection option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your termite perimeter before pricing this estimate',
    aiBody: 'We reviewed your home, lot, and termite perimeter before pricing this plan.',
    askChips: [
      "What's monitored?",
      'How often are stations checked?',
      'Basic vs Premier?',
      'What about active termites?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
  termite_trenching: {
    headline: "Hey {first}, here's your termite trenching quote.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI mapped your trenching path and confirmed required linear feet',
    aiBody: 'We measured the trenching path and linear footage used for this quote.',
    askChips: [
      'How long does the barrier last?',
      'What product is used?',
      "What's covered?",
      'Do you renew it?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this quote.",
    },
  },
  lawn_care: {
    headline: "Hey {first}, choose your lawn care option.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your lawn before pricing this estimate',
    aiBody: 'We reviewed your lawn size, turf type, and treatment needs before pricing this plan.',
    askChips: [
      'How does your lawn assessment tech work?',
      'What lawn issues do you check?',
      'When do visits start?',
      'What about weeds?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for lawn care.",
    },
  },
  bundle: {
    headline: "Hey {first}, here's your custom Waves plan.",
    aiEyebrow: 'Waves AI',
    aiTitle: 'Waves AI reviewed your property before pricing this estimate',
    aiBody: 'We reviewed the services, property details, and pricing rules used for this plan.',
    askChips: [
      'What is included in this plan?',
      'How do you handle ants?',
      'How does your lawn assessment tech work?',
      'Are pets and kids safe?',
    ],
    priceWording: {
      dayLine: "That's about {amount}/day for this plan.",
    },
  },
};

export function estimateCopyFor(category) {
  return SERVICE_COPY[category] || SERVICE_COPY.pest_control;
}
