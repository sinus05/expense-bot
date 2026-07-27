// Brands and expense categories.
// Add/remove entries here to customize — no other code changes needed.

const BRANDS = [
  { id: 'LittleBritain', label: 'Little Britain' },
  { id: 'WorldLink', label: 'WorldLink' },
];

const CATEGORIES = [
  'Rent & Utilities',
  'Salaries',
  'Marketing',
  'Supplies & Materials',
  'Food & Catering',
  'Maintenance & Repairs',
  'Transport',
  'Miscellaneous',
];

// Large, non-cash categories — always paid directly (bank transfer, etc.),
// never from someone's cash wallet. Excluded from the /expense category
// picker; still available under /directpay.
const DIRECT_ONLY_CATEGORIES = ['Salaries', 'Rent & Utilities', 'Maintenance & Repairs'];

const WALLET_CATEGORIES = CATEGORIES.filter((c) => !DIRECT_ONLY_CATEGORIES.includes(c));

module.exports = { BRANDS, CATEGORIES, WALLET_CATEGORIES, DIRECT_ONLY_CATEGORIES };
