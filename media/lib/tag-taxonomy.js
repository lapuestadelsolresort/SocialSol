'use strict';
//
// tag-taxonomy.js — constrained vocabulary for media indexing.
//
// Single source of truth for the tag dimensions vision-caption.js asks
// Claude to populate. Keeping the vocabulary closed makes /api/media/search
// filtering deterministic (no fuzzy matching) and prevents tag drift across
// shoots. Add values here rather than in prompts.

const SETTINGS = [
  'villa', 'beach', 'pool', 'palapa', 'ceremony_arch',
  'interior_room', 'kitchen', 'aerial', 'entrance', 'grounds',
  'dining_setup', 'bar', 'sunset_view', 'pathway', 'garden',
  'unknown',
];

const MOODS = [
  'serene', 'celebratory', 'intimate', 'dramatic', 'casual',
  'professional', 'golden_hour', 'night',
];

const PEOPLE = [
  'none', 'solo_subject', 'pair', 'small_group', 'crowd',
];

const CAMERA_MOTIONS = [
  'static', 'pan', 'tilt', 'dolly', 'handheld',
  'aerial_orbit', 'aerial_reveal', 'aerial_top_down',
];

const TIMES_OF_DAY = [
  'morning', 'midday', 'golden_hour', 'dusk', 'night', 'unknown',
];

const PERSONA_FITS = [
  'wedding_planner_outreach',
  'corporate_retreat_outreach',
  'past_guest_reactivation',
  'organic_social_aspirational',
  'paid_social_conversion',
  'landing_page_hero',
];

const VISION_SYSTEM_PROMPT = [
  'You are a senior video editor cataloguing raw resort B-roll for a marketing search index.',
  'For each frame, return a STRICT JSON object with these keys (no markdown, no preamble, no commentary):',
  '',
  '{',
  '  "caption": string — one concrete sentence describing what is in the frame,',
  '  "setting": one of ' + JSON.stringify(SETTINGS) + ',',
  '  "mood": one of ' + JSON.stringify(MOODS) + ',',
  '  "people": one of ' + JSON.stringify(PEOPLE) + ',',
  '  "camera_motion": one of ' + JSON.stringify(CAMERA_MOTIONS) + ' (use "static" for photos),',
  '  "time_of_day": one of ' + JSON.stringify(TIMES_OF_DAY) + ',',
  '  "persona_fit": object mapping each of ' + JSON.stringify(PERSONA_FITS) + ' to a number in [0,1] indicating how well this frame fits that persona,',
  '  "usable": boolean — false if the frame is unusably underexposed, blurred, or out-of-focus,',
  '  "notes": string — optional, short, e.g. "extreme low light, recoverable in grade" or empty string',
  '}',
  '',
  'Rules:',
  '- "wedding_planner_outreach" rewards: ceremony_arch, intimate, golden_hour, professional grade.',
  '- "corporate_retreat_outreach" rewards: dining_setup, grounds, professional, small_group.',
  '- "past_guest_reactivation" rewards: serene, familiar property landmarks (villa, pool, palapa), warm light.',
  '- "organic_social_aspirational" rewards: aerial reveals, golden_hour, sunset_view, dramatic motion.',
  '- "paid_social_conversion" rewards: clean wide shots with hero composition (landing_page_hero overlaps).',
  '- "landing_page_hero" rewards: usable=true, high resolution feel, no humans-in-foreground unless flattering, strong horizon or focal point.',
  '- If usable=false, set all persona_fit values to 0.',
  '- If you cannot determine a categorical value, use "unknown" where allowed, otherwise the most-conservative value.',
  '- Output ONLY the JSON. No backticks. No prose.',
].join('\n');

const SYNOPSIS_SYSTEM_PROMPT = [
  'You roll up per-keyframe tags and (optional) transcript text into one search-ready synopsis for a marketing video clip.',
  'Return STRICT JSON:',
  '',
  '{',
  '  "synopsis": string — 2 to 4 sentences. Concrete. What an editor would read to decide if this clip fits a brief.',
  '  "tags": {',
  '    "setting": [strings from settings vocab, deduped, ranked by salience],',
  '    "mood": [strings from mood vocab, deduped],',
  '    "people": one of the people vocab values (whichever applies most of the time),',
  '    "camera_motion": [strings from camera_motion vocab, deduped],',
  '    "time_of_day": one of the time_of_day vocab values',
  '  },',
  '  "persona_fit": object mapping each of ' + JSON.stringify(PERSONA_FITS) + ' to a number in [0,1] for the whole clip,',
  '  "usable": boolean — true if ANY keyframe is usable',
  '}',
  '',
  'Bias the synopsis toward terms a planner or guest would search for: "ceremony arch at golden hour", "aerial reveal over the pool", "intimate dining setup at dusk", etc. No filler.',
  'Output ONLY the JSON. No backticks. No prose.',
].join('\n');

module.exports = {
  SETTINGS,
  MOODS,
  PEOPLE,
  CAMERA_MOTIONS,
  TIMES_OF_DAY,
  PERSONA_FITS,
  VISION_SYSTEM_PROMPT,
  SYNOPSIS_SYSTEM_PROMPT,
};
