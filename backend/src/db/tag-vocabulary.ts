// Single source of truth for the starter tag vocabulary. seed-tags.ts upserts
// exactly these rows (by slug) into the `tags` table. Add new tags here only.

export interface TagSeed {
  slug: string;
  label: string;
  category: string;
}

export const TAG_VOCABULARY: TagSeed[] = [
  { slug: "robotics", label: "Robotics", category: "discipline" },
  { slug: "ml-ai", label: "ML/AI", category: "discipline" },
  { slug: "embedded-hardware", label: "Embedded/Hardware", category: "discipline" },
  { slug: "software", label: "Software", category: "discipline" },
  { slug: "aerospace", label: "Aerospace", category: "discipline" },
  { slug: "bio-biomed", label: "Bio/Biomed", category: "discipline" },
  { slug: "energy", label: "Energy", category: "discipline" },
  { slug: "materials", label: "Materials", category: "discipline" },
  { slug: "data-science", label: "Data Science", category: "discipline" },
  { slug: "hci", label: "HCI", category: "discipline" },
  { slug: "cybersecurity", label: "Cybersecurity", category: "discipline" },
  { slug: "controls", label: "Controls", category: "discipline" },
  { slug: "ee", label: "EE", category: "major" },
  { slug: "me", label: "ME", category: "major" },
  { slug: "cs", label: "CS", category: "major" },
  { slug: "civil", label: "Civil", category: "major" },
  { slug: "chemical", label: "Chemical", category: "major" },
];
