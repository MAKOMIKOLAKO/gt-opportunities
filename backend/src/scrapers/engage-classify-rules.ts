// The classification "brain" for stage 2 of the Engage pipeline.
//
// This encodes the judgment calls of the person building this pipeline about
// what textual signals in a GT student org's name/description indicate (a)
// that the org is technical/STEM-and-engineering-oriented (as opposed to
// Greek life, cultural/religious/identity groups, club sports, arts/music,
// or general campus admin/office listings), and (b) which of the controlled
// tags in tag-vocabulary.ts apply. It is a deterministic rule set rather than
// a live model call, tuned by hand-reading the full list of ~733 scraped org
// names (see NOTES-FOR-REVIEW.md for the methodology note and its
// limitations) — every keyword group below maps 1:1 to a real
// TAG_VOCABULARY slug, so it can never emit an invented tag.
import { TAG_VOCABULARY } from "../db/tag-vocabulary.js";

const VALID_SLUGS = new Set(TAG_VOCABULARY.map((t) => t.slug));

interface TagRule {
  slug: string;
  patterns: RegExp[];
}

// Order doesn't matter; an org can match multiple tags.
const TAG_RULES: TagRule[] = [
  {
    slug: "robotics",
    patterns: [/\brobot(ics|ic)?\b/i, /\bhumanoid/i, /\bmarine robotics/i, /\bmechatronic/i],
  },
  {
    slug: "ml-ai",
    patterns: [
      /\bartificial intelligence\b/i,
      /\bmachine learning\b/i,
      /\bdeep learning\b/i,
      /\bneural network/i,
      /\bai safety\b/i,
      /\bai[@ ]/i,
      /^ai\b/i,
    ],
  },
  {
    slug: "embedded-hardware",
    patterns: [
      /\bembedded\b/i,
      /\bcircuit(s|ry)?\b/i,
      /\bhardware\b/i,
      /\belectronics?\b/i,
      /\bpcb\b/i,
      /\bmicrocontroller/i,
      /\binvention studio\b/i,
      /\bmaker(s|space)?\b/i,
      /\bnanotechnology\b/i,
    ],
  },
  {
    slug: "software",
    patterns: [
      /\bsoftware\b/i,
      /\bcoding\b/i,
      /\bprogramming\b/i,
      /\bweb ?dev(elopment)?\b/i,
      /\bapp development\b/i,
      /\bios\b/i,
      /\bhackathon\b/i,
      /\bhack(er)?\b/i,
      /\bopen[- ]?source\b/i,
      /\bbyte/i,
    ],
  },
  {
    slug: "aerospace",
    patterns: [
      /\baerospace\b/i,
      /\baeronautic/i,
      /\bastronautic/i,
      /\brocket/i,
      /\bpropulsion\b/i,
      /\baviation\b/i,
      /\bflying\b/i,
      /\baircraft\b/i,
      /\bvertical flight\b/i,
      /\bcansat\b/i,
      /\bdesign-build-fly\b/i,
    ],
  },
  {
    slug: "bio-biomed",
    patterns: [
      /\bbiomedical\b/i,
      /\bbioengineering\b/i,
      /\bbiotech(nology)?\b/i,
      /\bbiomaterials?\b/i,
      /\bprosthetics?\b/i,
      /\bbiomechanic/i,
      /\bbioinformatics\b/i,
      /\bmicro-physiological\b/i,
      /\bnucleic acid\b/i,
    ],
  },
  {
    slug: "energy",
    patterns: [
      /\benergy\b/i,
      /\bsolar\b/i,
      /\bnuclear\b/i,
      /\brenewable/i,
      /\bpower systems?\b/i,
      /\bsustainable systems\b/i,
    ],
  },
  {
    slug: "materials",
    patterns: [
      /\bmaterials? (science|engineering|research)/i,
      /\bpolymer/i,
      /\bceramics?\b/i,
      /\bmetallurgy\b/i,
      /\bnanotechnology\b/i,
    ],
  },
  {
    slug: "data-science",
    patterns: [
      /\bdata science\b/i,
      /\bbig data\b/i,
      /\banalytics\b/i,
      /\bquantum computing\b/i,
      /\bcomputational (science|cognition)/i,
    ],
  },
  {
    slug: "hci",
    patterns: [/\bhuman[- ]computer interaction\b/i, /\bhci\b/i, /\buser experience\b/i, /\bhuman factors\b/i],
  },
  {
    slug: "cybersecurity",
    patterns: [/\bcyber(security)?\b/i, /\bprivacy\b/i, /\bgreyhat\b/i, /\bhacking\b/i, /\bpenetration test/i],
  },
  {
    slug: "controls",
    patterns: [/\bcontrol systems?\b/i, /\bcontrols\b/i, /\bsystems engineering\b/i],
  },
  {
    slug: "ee",
    patterns: [
      /\belectrical (and computer )?engineering\b/i,
      /\becE\b/i,
      /\bpower electronics\b/i,
      /\belectrical engineers?\b/i,
    ],
  },
  {
    slug: "me",
    patterns: [/\bmechanical engineering\b/i, /\bmechanical engineers?\b/i, /\bmechanical design\b/i],
  },
  {
    slug: "cs",
    patterns: [
      /\bcomputer science\b/i,
      /\bcomputing\b/i,
      /\bsoftware engineering\b/i,
      /\bcompetitive programming\b/i,
    ],
  },
  {
    slug: "civil",
    patterns: [
      /\bcivil (and environmental )?engineer/i,
      /\bstructural engineering\b/i,
      /\btransportation engineering\b/i,
      /\bgeotechnical\b/i,
      /\btrenchless\b/i,
      /\bconstruction (engineering|management)\b/i,
    ],
  },
  {
    slug: "chemical",
    patterns: [
      /\bchemical engineer/i,
      /\bchemistry\b/i,
      /\bchemists?\b/i,
      /\bprocess engineering\b/i,
      /\belectro-?chemical\b/i,
    ],
  },
];

// Generic STEM/engineering/research signal that should mark an org technical
// even when none of the specific controlled tags fit well (e.g. general
// physics, math, or "engineering" societies without a matching discipline
// tag). Used only when TAG_RULES found zero matches.
const GENERIC_TECHNICAL_SIGNAL = [
  /\bengineer(ing|s)?\b/i,
  /\bscience\b/i,
  /\bscientists?\b/i,
  /\btechnology\b/i,
  /\bphysics\b/i,
  /\bphysicists?\b/i,
  /\bmathematic/i,
  /\bresearch\b/i,
  /\bstem\b/i,
  /\btechnical\b/i,
  /\binnovation\b/i,
  /\bdesign-build\b/i,
];

// Explicit non-technical signal used to raise confidence (and, when no
// technical signal at all is present, decide the org is not technical).
// This is NOT a hard veto over positive keyword matches — an org can be
// e.g. a cultural org for women in engineering, which is legitimately
// technical despite also matching identity-group language.
const NON_TECHNICAL_SIGNAL = [
  /\bfraternity\b/i,
  /\bsorority\b/i,
  /\bpanhellenic\b/i,
  /\binterfraternity\b/i,
  /\bministry\b/i,
  /\bfellowship\b/i,
  /\bchristian\b/i,
  /\bcatholic\b/i,
  /\bmuslim(s)? (students?|association)/i,
  /\bchoir\b/i,
  /\bdance\b/i,
  /\ba cappella\b/i,
  /\bsorority\b/i,
  /\bclub (soccer|basketball|volleyball|lacrosse|rugby|tennis|golf)\b/i,
  /\bintramural\b/i,
  /\bworship\b/i,
];

export interface ClassificationResult {
  isTechnical: boolean;
  tags: string[];
  confidence: number;
  reasoning: string;
}

export function classifyOrg(name: string, description: string, categoryNames: string[]): ClassificationResult {
  const text = `${name} ${description} ${categoryNames.join(" ")}`;
  // The non-technical veto deliberately looks at name+description ONLY, not
  // CategoryNames — CampusLabs' own "Cultural"/"Academic/Professional"
  // categories are broad enough to land on genuinely technical affinity
  // groups (e.g. "Muslim Tech Collaborative" is tagged Cultural), so using
  // them as a negative signal produced false negatives during spot-checking.
  const nonTechnicalVetoText = `${name} ${description}`;

  const matchedTags: string[] = [];
  let strongMatches = 0;
  for (const rule of TAG_RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      matchedTags.push(rule.slug);
      strongMatches++;
    }
  }
  // De-dupe while keeping only real vocabulary slugs (defensive; TAG_RULES
  // slugs are hand-typed against TAG_VOCABULARY above).
  const tags = [...new Set(matchedTags)].filter((s) => VALID_SLUGS.has(s));

  const genericHit = GENERIC_TECHNICAL_SIGNAL.some((p) => p.test(text));
  const nonTechnicalHits = NON_TECHNICAL_SIGNAL.filter((p) => p.test(nonTechnicalVetoText)).length;

  let isTechnical: boolean;
  let confidence: number;
  let reasoning: string;

  if (tags.length > 0) {
    isTechnical = true;
    // More specific tag matches + no competing non-technical signal => higher confidence.
    confidence = Math.min(0.95, 0.65 + tags.length * 0.1 - nonTechnicalHits * 0.05);
    reasoning = `Matched discipline tag(s): ${tags.join(", ")}.`;
  } else if (genericHit && nonTechnicalHits === 0) {
    isTechnical = true;
    tags.length = 0;
    confidence = 0.55;
    reasoning = "Generic STEM/engineering/research language, no specific discipline tag matched.";
  } else if (genericHit && nonTechnicalHits > 0) {
    // Ambiguous: has some STEM language but also social/identity/religious/sports framing.
    isTechnical = false;
    confidence = 0.4;
    reasoning = "Mixed signal (STEM language + social/cultural/religious/sports framing); defaulted to non-technical.";
  } else {
    isTechnical = false;
    confidence = nonTechnicalHits > 0 ? 0.85 : 0.7;
    reasoning = nonTechnicalHits > 0 ? "Explicit social/Greek/religious/sports framing, no STEM signal." : "No technical or STEM signal found.";
  }

  confidence = Math.max(0.05, Math.min(0.95, Number(confidence.toFixed(2))));

  return { isTechnical, tags, confidence, reasoning };
}
