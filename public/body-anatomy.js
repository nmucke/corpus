// Original, schematic body artwork. Regions represent the broad muscle groups
// available in Hevy, rather than individual anatomical muscles.
const pair = (d) => [{ d }, { d, transform: 'translate(180 0) scale(-1 1)' }];

export const BODY_PATHS = [
  // Arms, with relaxed hands. Mirroring keeps both sides identical.
  ...pair('M57 63 C45 65 42 77 39 94 L35 112 C35 121 32 128 30 137 L25 165 L25 174 C20 180 20 188 24 194 L29 198 L33 194 L35 185 L39 180 L40 170 L43 151 L49 128 L51 117 L60 96 L65 79 Z'),
  // Legs and feet: thighs taper towards the knee, calves towards the ankle.
  ...pair('M64 175 C56 187 57 204 59 223 L61 248 L62 263 C58 278 58 289 61 304 L65 335 L65 341 L58 349 C55 354 61 358 67 358 L78 358 C83 357 85 353 82 348 L78 341 L79 333 L83 302 C86 285 84 274 82 263 L85 244 L89 214 L89 194 Z'),
  // Neck, torso and pelvis. Limb joins sit beneath this outline.
  { d: 'M82 44 L98 44 L100 55 C111 56 121 60 126 68 C128 77 124 90 119 102 C116 116 111 133 112 146 L120 174 C124 189 116 202 105 205 L96 202 Q90 197 84 202 L75 205 C64 202 56 189 60 174 L68 146 C69 133 64 116 61 102 C56 90 52 77 54 68 C59 60 69 56 80 55 Z' },
];

const neck = [{ d: 'M83 47 L97 47 L99 58 Q90 63 81 58 Z' }];
const shoulders = pair('M58 65 Q65 59 77 59 L73 70 Q63 76 60 88 L51 88 Q48 72 58 65 Z');
const upperArms = pair('M48 91 Q52 88 57 90 L52 108 Q49 119 44 122 L38 119 L41 105 Z');
const forearms = pair('M38 125 L46 128 Q43 143 39 157 L35 170 L28 167 L31 147 Z');

export const FRONT_REGIONS = {
  neck,
  shoulders,
  chest: pair('M64 80 Q76 76 87 79 L88 104 Q78 113 65 107 L61 92 Z'),
  biceps: upperArms,
  forearms,
  abdominals: pair('M76 115 Q82 113 87 114 L88 158 L77 157 Q73 140 76 115 Z'),
  abductors: pair('M66 160 L74 162 L69 180 L61 185 Q59 176 66 160 Z'),
  adductors: pair('M78 190 L87 199 L84 225 L80 244 L75 235 L73 210 Z'),
  quadriceps: pair('M63 191 Q66 186 72 189 L71 217 L77 242 L74 255 L64 253 L62 232 Q58 204 63 191 Z'),
};

export const BACK_REGIONS = {
  neck,
  shoulders,
  traps: [{ d: 'M83 59 L97 59 Q105 65 112 76 L99 82 L90 98 L81 82 L68 76 Q75 65 83 59 Z' }],
  triceps: upperArms,
  forearms,
  upper_back: pair('M65 82 L77 83 L86 101 L86 119 Q75 116 66 107 L62 93 Z'),
  lats: pair('M63 111 L74 120 L86 125 L85 152 L72 147 Q66 131 63 111 Z'),
  lower_back: pair('M78 148 L87 154 L88 173 L75 168 L71 157 Z'),
  glutes: pair('M67 172 Q77 169 88 177 L88 198 Q77 208 64 196 Q59 184 67 172 Z'),
  hamstrings: pair('M63 203 Q74 210 86 204 L82 233 L78 254 L66 255 L63 236 Z'),
  calves: pair('M65 270 Q72 264 80 270 Q85 288 79 306 L73 328 L68 323 L63 297 Q61 281 65 270 Z'),
};
