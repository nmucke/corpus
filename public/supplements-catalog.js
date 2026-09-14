// Shared vocabulary for the Supplements module. Imported by the server for
// validation and by the browser for labels, like metrics-catalog.js.

export const SUPPLEMENT_TYPES = [
  { key: 'protein', label: 'Protein' },
  { key: 'creatine', label: 'Creatine' },
  { key: 'pre_workout', label: 'Pre-workout' },
  { key: 'amino_acid', label: 'Amino acid' },
  { key: 'vitamin', label: 'Vitamin' },
  { key: 'mineral', label: 'Mineral' },
  { key: 'omega_3', label: 'Omega-3' },
  { key: 'electrolyte', label: 'Electrolyte' },
  { key: 'probiotic', label: 'Probiotic' },
  { key: 'herbal', label: 'Herbal' },
  { key: 'other', label: 'Other' },
];

/** `label` follows the amount (`5 g`); count units pluralise (`2 capsules`). */
export const DOSE_UNITS = [
  { key: 'g', label: 'g', plural: 'g' },
  { key: 'mg', label: 'mg', plural: 'mg' },
  { key: 'mcg', label: 'mcg', plural: 'mcg' },
  { key: 'iu', label: 'IU', plural: 'IU' },
  { key: 'ml', label: 'ml', plural: 'ml' },
  { key: 'capsule', label: 'capsule', plural: 'capsules' },
  { key: 'tablet', label: 'tablet', plural: 'tablets' },
  { key: 'scoop', label: 'scoop', plural: 'scoops' },
  { key: 'serving', label: 'serving', plural: 'servings' },
];

export const FREQUENCY_KINDS = [
  { key: 'daily', label: 'Every day', hint: 'Counted once per day, or more with times per day.' },
  { key: 'weekly', label: 'Certain weekdays', hint: 'Counted on the weekdays you pick.' },
  { key: 'workout', label: 'With every workout', hint: 'One dose is counted for every logged workout session. You can skip a session from Today.' },
  { key: 'as_needed', label: 'As needed', hint: 'Nothing is expected; log doses when you take one.' },
];

/** Monday-first, matching the dashboard's calendar weeks. */
export const WEEKDAYS = [
  { key: 0, label: 'Mon', long: 'Monday' },
  { key: 1, label: 'Tue', long: 'Tuesday' },
  { key: 2, label: 'Wed', long: 'Wednesday' },
  { key: 3, label: 'Thu', long: 'Thursday' },
  { key: 4, label: 'Fri', long: 'Friday' },
  { key: 5, label: 'Sat', long: 'Saturday' },
  { key: 6, label: 'Sun', long: 'Sunday' },
];

export const SUPPLEMENT_TYPE_KEYS = SUPPLEMENT_TYPES.map((type) => type.key);
export const DOSE_UNIT_KEYS = DOSE_UNITS.map((unit) => unit.key);
export const FREQUENCY_KIND_KEYS = FREQUENCY_KINDS.map((kind) => kind.key);
