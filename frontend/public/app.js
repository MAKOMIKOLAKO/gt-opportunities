// GT Campus Opportunity Finder — client-side SPA (directory / detail / submit).
// All data comes from live fetch() calls against the backend API (see
// API-CONTRACT.md); there is no local seed/demo data.

const API_BASE = "/api"; // same-origin; frontend/server.js proxies this to the backend

const TYPE_META = {
  vip: { label: "VIP Team", color: "#003057" },
  lab: { label: "Research Lab", color: "#5F249F" },
  club: { label: "Student Org", color: "#008C95" },
};

const TYPE_FILTERS = [
  { key: "", label: "All", dot: "#54585A" },
  { key: "vip", label: "VIP Teams", dot: TYPE_META.vip.color },
  { key: "lab", label: "Research Labs", dot: TYPE_META.lab.color },
  { key: "club", label: "Student Orgs", dot: TYPE_META.club.color },
];

// Real scraped `majors` arrays contain full major names in inconsistent
// forms (e.g. "Computer Engineering", "EE"). Bucket them into GT college
// abbreviations for a usable discipline filter; orgs whose majors span
// multiple buckets (or don't map) are "Multidisciplinary".
const DISCIPLINE_RULES = [
  { key: "CS", test: /computer science|computational media|cs\b/i },
  { key: "ECE", test: /electrical engineering|computer engineering|\bee\b|\bece\b/i },
  { key: "ME", test: /mechanical engineering|\bme\b/i },
  { key: "ISyE", test: /industrial engineering|analytics|\bisye\b/i },
  { key: "BME", test: /biomedical engineering|bioengineering|\bbme\b/i },
  { key: "CEE", test: /civil engineering|environmental engineering|\bcee\b/i },
];
const DISCIPLINE_ORDER = ["All Disciplines", "CS", "ECE", "ME", "ISyE", "BME", "CEE", "Multidisciplinary"];

function computeDiscipline(majors) {
  if (!majors || majors.length === 0) return "Multidisciplinary";
  const buckets = new Set();
  for (const m of majors) {
    const hit = DISCIPLINE_RULES.find((r) => r.test.test(m));
    buckets.add(hit ? hit.key : "Other");
  }
  buckets.delete("Other");
  if (buckets.size === 1) return [...buckets][0];
  return "Multidisciplinary";
}

function initials(name) {
  const words = (name || "").replace(/^VIP:\s*/i, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Best-effort extraction from the free-form `meta`/`details` blobs — real
// records don't consistently populate every field the design calls for, so
// each falls back to an em dash rather than fabricating a value.
//
// Two different sources populate these fields with different shapes: hand-
// curated rows may set meta.lead/meta.meetingInfo/meta.advisors directly,
// but the VIP scraper (backend/src/scrapers/vip.ts) writes advisor/meeting
// info into `details` instead, as flat semicolon-joined strings
// (advisor_name, advisor_email, meeting_info) — check both.
function detailFields(opp) {
  const meta = opp.meta || {};
  const details = opp.details || {};
  const advisor = Array.isArray(meta.advisors) && meta.advisors.length ? meta.advisors[0] : null;
  return {
    creditPay: meta.creditPay || meta.pay || (opp.type === "vip" ? "Credit (VIP course)" : "—"),
    lead: meta.lead || meta.facultyLead || (advisor ? advisor.name : null) || details.advisor_name || "—",
    meets: meta.meets || meta.meetingInfo || details.meeting_info || "—",
    contact:
      meta.contact || (advisor ? advisor.email : null) || details.advisor_email || opp.submittedBy || "—",
    applyUrl: opp.link || null,
  };
}

const el = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const state = {
  view: "directory", // directory | detail | submit
  layout: "grid", // grid | list
  query: "",
  typeFilter: "",
  discipline: "All Disciplines",
  selectedId: null,
  allTags: [],
  submitted: false,
  lastSubmittedName: "",
  reviewFormOpportunityId: null,
  flagReviewId: null,
  suggestEditOpen: false,
  suggestEditMessage: "",
};

let searchDebounce = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

// ---------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------

async function fetchOpportunities() {
  const params = new URLSearchParams();
  if (state.typeFilter) params.set("type", state.typeFilter);
  if (state.query.trim()) params.set("search", state.query.trim());
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/opportunities${qs ? "?" + qs : ""}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

async function fetchOpportunity(id) {
  const res = await fetch(`${API_BASE}/opportunities/${id}`);
  if (!res.ok) throw new Error(res.status === 404 ? "not_found" : `HTTP ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function fetchTags() {
  const res = await fetch(`${API_BASE}/tags`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

async function submitReview(opportunityId, body) {
  const res = await fetch(`${API_BASE}/opportunities/${opportunityId}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`);
  return data.result;
}

// Field picker for "Suggest an edit" — matches the server-side allowlist
// exactly (backend/src/routes/public.ts SUGGESTABLE_FIELDS). `majors` is
// entered as a comma-separated list in the UI and converted to the
// JSON-serialized array string the API expects before posting.
const SUGGEST_EDIT_FIELDS = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "link", label: "Link" },
  { key: "majors", label: "Majors sought" },
];

async function submitSuggestEdit(opportunityId, field, newValueRaw) {
  const newValue = field === "majors"
    ? JSON.stringify(newValueRaw.split(",").map((m) => m.trim()).filter(Boolean))
    : newValueRaw;
  const res = await fetch(`${API_BASE}/opportunities/${opportunityId}/suggest-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, newValue }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`);
  return data.result;
}

async function flagReview(reviewId, category, details) {
  const res = await fetch(`${API_BASE}/reviews/${reviewId}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, details }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`);
  return data.result;
}

// ---------------------------------------------------------------------
// Rendering — header (all views)
// ---------------------------------------------------------------------

function renderHeader() {
  return `
    <header class="gt-header">
      <div class="gt-header-inner">
        <button class="gt-brand" data-action="go-directory">
          <span class="gt-brand-mark">GT</span>
          <span class="gt-brand-text">
            <div class="gt-brand-title">Opportunity Finder</div>
            <div class="gt-brand-sub">VIP &middot; Labs &middot; Student Orgs</div>
          </span>
        </button>
        <nav class="gt-nav">
          <button class="gt-nav-btn ${state.view === "directory" ? "active" : ""}" data-action="go-directory">Directory</button>
          <button class="gt-nav-btn ${state.view === "submit" ? "active" : ""}" data-action="go-submit">Submit an Org</button>
        </nav>
        <div class="gt-header-spacer"></div>
        <div class="gt-header-institution">Georgia Institute of Technology</div>
      </div>
    </header>
  `;
}

function renderFooter() {
  return `
    <footer class="gt-footer">
      Built by students, for students — not an official Georgia Tech resource.
    </footer>
  `;
}

// ---------------------------------------------------------------------
// Rendering — directory
// ---------------------------------------------------------------------

function decorateOrg(opp) {
  const type = TYPE_META[opp.type] || { label: opp.type, color: "#54585A" };
  const discipline = computeDiscipline(opp.majors);
  return {
    ...opp,
    typeLabel: type.label,
    iconColor: type.color,
    discipline,
    initials: initials(opp.name),
  };
}

function matchesDiscipline(org) {
  return state.discipline === "All Disciplines" || org.discipline === state.discipline;
}

function renderDirectory() {
  const hasActiveFilters = !!(state.query || state.typeFilter || state.discipline !== "All Disciplines");

  return `
    <main class="view-directory">
      <div class="dir-heading">
        <h1>Find your next project</h1>
        <p>Search VIP teams, research labs, and technical student organizations in one place — no more digging through CampusGroups.</p>
      </div>

      <div class="dir-toolbar">
        <div class="dir-search">
          <input id="searchInput" type="text" value="${escapeAttr(state.query)}"
            placeholder='Search by name, keyword, skill (e.g. "robotics", "Python")' autocomplete="off" />
          <span class="dir-search-icon">&#8981;</span>
        </div>
        <div class="view-toggle">
          <button class="${state.layout === "grid" ? "active" : ""}" data-action="layout-grid">Grid</button>
          <button class="${state.layout === "list" ? "active" : ""}" data-action="layout-list">List</button>
        </div>
      </div>

      <div class="dir-filters">
        <span class="filter-label">Type</span>
        ${TYPE_FILTERS.map(
          (t) => `
          <button class="type-pill ${state.typeFilter === t.key ? "active" : ""}" data-action="type-filter" data-type="${t.key}">
            <span class="dot" style="background:${t.dot}"></span>${t.label}
          </button>
        `
        ).join("")}
        <div class="filter-divider"></div>
        <span class="filter-label">Discipline</span>
        <select id="disciplineSelect" class="discipline-select">
          ${DISCIPLINE_ORDER.map((d) => `<option value="${escapeAttr(d)}" ${d === state.discipline ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}
        </select>
        ${hasActiveFilters ? `<button class="clear-filters-btn" data-action="clear-filters">Clear filters</button>` : ""}
      </div>

      <div id="resultCount" class="result-count">Loading&hellip;</div>
      <div id="resultsContainer">
        <div class="state-msg">Loading opportunities&hellip;</div>
      </div>
    </main>
  `;
}

function renderCardsInto(orgs) {
  const container = el("#resultsContainer");
  if (!container) return;

  const filtered = orgs.filter(matchesDiscipline);
  el("#resultCount").textContent = `${filtered.length} organization${filtered.length === 1 ? "" : "s"} found`;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No matches found</div>
        <div class="empty-state-sub">Try a different keyword or clear your filters — or submit the org yourself.</div>
      </div>
    `;
    return;
  }

  if (state.layout === "list") {
    container.innerHTML = `
      <div class="org-list">
        <div class="org-list-head">
          <div>Name</div><div>Type</div><div>Discipline</div>
        </div>
        ${filtered
          .map((o) => {
            return `
            <button class="org-list-row" data-action="open-detail" data-id="${o.id}">
              <div class="org-list-name">
                <span class="org-list-dot" style="background:${o.iconColor}"></span>
                <span class="name">${escapeHtml(o.name)}</span>
              </div>
              <div class="org-list-cell type">${escapeHtml(o.typeLabel)}</div>
              <div class="org-list-cell discipline">${escapeHtml(o.discipline)}</div>
            </button>
          `;
          })
          .join("")}
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="org-grid">
      ${filtered
        .map(
          (o) => `
        <button class="org-card" data-action="open-detail" data-id="${o.id}">
          <div class="org-card-top">
            <div class="org-icon" style="background:${o.iconColor}">${o.initials}</div>
          </div>
          <div>
            <div class="org-card-name">${escapeHtml(o.name)}</div>
            <div class="org-card-sub">${escapeHtml(o.typeLabel)} &middot; ${escapeHtml(o.discipline)}</div>
          </div>
          <div class="org-card-blurb">${escapeHtml(truncate(o.description, 140))}</div>
          <div class="tag-chips">
            ${(o.tags || []).slice(0, 4).map((t) => `<span class="tag-chip">${escapeHtml(t.label)}</span>`).join("")}
          </div>
        </button>
      `
        )
        .join("")}
    </div>
  `;
}

async function loadDirectory() {
  try {
    const raw = await fetchOpportunities();
    directoryCache = raw.map(decorateOrg);
    renderCardsInto(directoryCache);
  } catch (err) {
    const container = el("#resultsContainer");
    if (container) container.innerHTML = `<div class="state-msg error">Failed to load opportunities: ${escapeHtml(err.message)}</div>`;
  }
}

let directoryCache = [];

// ---------------------------------------------------------------------
// Rendering — detail
// ---------------------------------------------------------------------

function renderDetailShell() {
  return `
    <main class="view-detail">
      <button class="detail-back" data-action="go-directory">&larr; Back to directory</button>
      <div id="detailContent"><div class="state-msg">Loading&hellip;</div></div>
    </main>
  `;
}

async function loadDetail(id) {
  const container = el("#detailContent");
  try {
    const opp = decorateOrg(await fetchOpportunity(id));
    const d = detailFields(opp);
    container.innerHTML = `
      <div class="detail-card">
        <div class="detail-header">
          <div class="org-icon lg" style="background:${opp.iconColor}">${opp.initials}</div>
          <div class="detail-header-text">
            <div class="detail-title-row">
              <h1>${escapeHtml(opp.name)}</h1>
            </div>
            <div class="detail-sub">${escapeHtml(opp.typeLabel)} &middot; ${escapeHtml(opp.discipline)}</div>
          </div>
        </div>

        <p class="detail-desc">${escapeHtml(opp.description || "")}</p>

        <div class="detail-info-grid">
          <div><div class="detail-info-label">Credit / Pay</div><div class="detail-info-value">${escapeHtml(d.creditPay)}</div></div>
          <div><div class="detail-info-label">Faculty Lead</div><div class="detail-info-value">${escapeHtml(d.lead)}</div></div>
          <div><div class="detail-info-label">Meets</div><div class="detail-info-value">${escapeHtml(d.meets)}</div></div>
        </div>

        ${
          (opp.tags || []).length
            ? `
        <div class="detail-tags-block">
          <div class="detail-tags-label">Skills &amp; Keywords</div>
          <div class="tag-chips">${opp.tags.map((t) => `<span class="tag-chip">${escapeHtml(t.label)}</span>`).join("")}</div>
        </div>`
            : ""
        }

        <div class="detail-footer">
          ${d.applyUrl ? `<a class="apply-btn" href="${escapeAttr(d.applyUrl)}" target="_blank" rel="noopener">How to Apply</a>` : ""}
          <div class="detail-contact">Contact: ${escapeHtml(d.contact)}</div>
        </div>

        ${renderSuggestEditBlock(opp)}

        ${renderReviewsBlock(opp)}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="state-msg error">${err.message === "not_found" ? "This opportunity could not be found." : "Failed to load: " + escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Rendering — suggest an edit
//
// Lightweight, unobtrusive "propose a correction" affordance: collapsed by
// default (a small link), expands into a one-field-at-a-time form. Posts to
// POST /api/opportunities/:id/suggest-edit and lands in the admin
// "Suggested Edits" queue as a pending row — nothing here touches the live
// listing directly.
// ---------------------------------------------------------------------

function renderSuggestEditBlock(opp) {
  if (!state.suggestEditOpen) {
    return `
      <div class="suggest-edit-block">
        <button class="suggest-edit-toggle" data-action="open-suggest-edit" data-id="${opp.id}">Suggest an edit to this listing</button>
        ${state.suggestEditMessage ? `<div class="suggest-edit-message">${escapeHtml(state.suggestEditMessage)}</div>` : ""}
      </div>
    `;
  }
  return `
    <div class="suggest-edit-block open">
      <div class="suggest-edit-title">Suggest an edit</div>
      <form id="suggestEditForm" data-id="${opp.id}">
        <div class="suggest-edit-row">
          <label>Field</label>
          <select name="field" required>
            ${SUGGEST_EDIT_FIELDS.map((f) => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join("")}
          </select>
        </div>
        <label>Proposed new value</label>
        <textarea name="newValue" required rows="2" maxlength="2000" placeholder="For Majors sought, separate multiple majors with commas"></textarea>
        <div id="suggestEditError"></div>
        <div class="review-form-actions">
          <button type="button" class="review-form-cancel-btn" data-action="close-suggest-edit">Cancel</button>
          <button type="submit" class="submit-btn">Submit suggestion</button>
        </div>
      </form>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Rendering — reviews (Addition 3)
//
// Reviews are anonymous, structured (three short-answer prompts), and
// deliberately have no rating field. Only approved reviews are ever sent
// to this client (see getApprovedReviews() server-side) — most recent
// first.
// ---------------------------------------------------------------------

function renderReviewsBlock(opp) {
  const reviews = opp.reviews || [];
  return `
    <div class="reviews-block">
      <div class="reviews-block-head">
        <h2>Member Reviews</h2>
        <button class="review-write-btn" data-action="open-review-form" data-id="${opp.id}">Write a review</button>
      </div>
      ${
        reviews.length === 0
          ? `<div class="review-empty">No reviews yet — be the first to share what it's actually like.</div>`
          : `<div class="review-list">${reviews.map(renderReviewCard).join("")}</div>`
      }
    </div>
  `;
}

function renderReviewCard(r) {
  return `
    <div class="review-card">
      <div class="review-card-row">
        <div class="review-card-q">Time commitment</div>
        <div class="review-card-a">${escapeHtml(r.timeCommitment)}</div>
      </div>
      <div class="review-card-row">
        <div class="review-card-q">Before applying</div>
        <div class="review-card-a">${escapeHtml(r.beforeApplying)}</div>
      </div>
      <div class="review-card-row">
        <div class="review-card-q">Advice for a new member</div>
        <div class="review-card-a">${escapeHtml(r.adviceNewMember)}</div>
      </div>
      <div class="review-card-footer">
        <span class="review-card-date">${escapeHtml((r.createdAt || "").slice(0, 10))}</span>
        <button class="review-flag-btn" data-action="flag-review" data-review-id="${escapeAttr(r.id)}">Flag this review</button>
      </div>
    </div>
  `;
}

function renderReviewFormModal() {
  if (!state.reviewFormOpportunityId) return "";
  return `
    <div class="review-form-modal-backdrop" data-action="close-review-form">
      <div class="review-form-modal" data-stop-close="1">
        <h3>Write a review</h3>
        <div class="modal-sub">Anonymous — we don't collect your name, email, or any identifying info. No rating, just three short answers.</div>
        <form id="reviewForm">
          <label>What's the time commitment actually like?</label>
          <textarea name="timeCommitment" required rows="2" maxlength="1000"></textarea>
          <label>What should someone know before applying?</label>
          <textarea name="beforeApplying" required rows="2" maxlength="1000"></textarea>
          <label>Any advice for a new member?</label>
          <textarea name="adviceNewMember" required rows="2" maxlength="1000"></textarea>
          <div id="reviewFormError"></div>
          <div class="review-form-actions">
            <button type="button" class="review-form-cancel-btn" data-action="close-review-form">Cancel</button>
            <button type="submit" class="submit-btn">Submit for review</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderFlagFormModal() {
  if (!state.flagReviewId) return "";
  return `
    <div class="review-form-modal-backdrop" data-action="close-flag-form">
      <div class="review-form-modal" data-stop-close="1">
        <h3>Flag this review</h3>
        <div class="modal-sub">For PIs/advisors/club leaders to request re-review of a published review. No account needed.</div>
        <form id="flagForm">
          <label>Reason</label>
          <select name="category" required style="width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid var(--pi-mile);font-size:13.5px;margin-bottom:14px;">
            <option value="other">Other / needs re-review</option>
            <option value="outdated_info">Outdated info</option>
            <option value="wrong_contact">Wrong contact info</option>
            <option value="broken_link">Broken link</option>
          </select>
          <label>Details (optional)</label>
          <textarea name="details" rows="3" maxlength="1000" placeholder="What's wrong with this review?"></textarea>
          <div id="flagFormError"></div>
          <div class="review-form-actions">
            <button type="button" class="review-form-cancel-btn" data-action="close-flag-form">Cancel</button>
            <button type="submit" class="submit-btn">Submit flag</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Rendering — submit
// ---------------------------------------------------------------------

function renderSubmit() {
  if (state.submitted) {
    return `
      <main class="view-submit">
        <div class="submit-heading">
          <h1>Submit an organization</h1>
        </div>
        <div class="submit-success">
          <div class="submit-success-badge">&#10003;</div>
          <div class="submit-success-title">Thanks — submission received</div>
          <div class="submit-success-sub">A moderator will review "${escapeHtml(state.lastSubmittedName)}" before it goes live.</div>
          <button class="submit-again-btn" data-action="submit-again">Submit another</button>
        </div>
      </main>
    `;
  }

  const disciplineOptions = DISCIPLINE_ORDER.filter((d) => d !== "All Disciplines" && d !== "Multidisciplinary").concat(["Multidisciplinary"]);

  return `
    <main class="view-submit">
      <div class="submit-heading">
        <h1>Submit an organization</h1>
        <p>Know a VIP team, lab, or technical org that's missing? Submissions are reviewed by student moderators before appearing in the directory.</p>
      </div>
      <form id="submitForm" class="submit-form">
        <div>
          <label>Organization name *</label>
          <input type="text" name="name" required maxlength="200" placeholder="e.g. VIP-Autonomous Racing" />
        </div>
        <div class="submit-form-row">
          <div>
            <label>Type *</label>
            <select name="type" required>
              <option value="">Select type</option>
              <option value="vip">VIP Team</option>
              <option value="lab">Research Lab</option>
              <option value="club">Student Org</option>
            </select>
          </div>
          <div>
            <label>Discipline / College</label>
            <select name="discipline">
              ${disciplineOptions.map((d) => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div>
          <label>Short description *</label>
          <textarea name="description" required rows="4" maxlength="2000" placeholder="What does this org do? Who should join?"></textarea>
        </div>
        <div class="submit-form-row">
          <div>
            <label>Skills / keywords</label>
            <input type="text" name="tags" placeholder="comma separated, e.g. Python, CAD" />
          </div>
          <div>
            <label>Your GT email *</label>
            <input type="email" name="email" required placeholder="you@gatech.edu" />
          </div>
        </div>
        <div class="submit-callout">
          <span>&#8505;</span><span>Submissions enter a review queue and are checked for accuracy before publishing — expect 3&ndash;5 days.</span>
        </div>
        <div id="submitError"></div>
        <button type="submit" class="submit-btn">Submit for review</button>
      </form>
    </main>
  `;
}

async function handleSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  const errorEl = el("#submitError");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Submitting…";

  const tagsRaw = form.tags.value.trim();
  const disciplineVal = form.discipline.value;
  const body = {
    type: form.type.value,
    name: form.name.value.trim(),
    description: form.description.value.trim(),
    majors: disciplineVal && disciplineVal !== "Multidisciplinary" ? [disciplineVal] : [],
    tagSlugs: resolveTagSlugs(tagsRaw),
    submittedBy: form.email.value.trim() || undefined,
  };

  try {
    const res = await fetch(`${API_BASE}/opportunities/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error((data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`);
    }
    setState({ submitted: true, lastSubmittedName: body.name });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Submit for review";
    errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

function resolveTagSlugs(tagsRaw) {
  if (!tagsRaw) return [];
  const wanted = tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  return state.allTags.filter((t) => wanted.includes(t.label.toLowerCase()) || wanted.includes(t.slug)).map((t) => t.slug);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function truncate(str, n) {
  const s = str || "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}

// ---------------------------------------------------------------------
// Main render / event wiring
// ---------------------------------------------------------------------

function render() {
  const app = el("#app");
  let body;
  if (state.view === "detail") body = renderDetailShell();
  else if (state.view === "submit") body = renderSubmit();
  else body = renderDirectory();

  app.innerHTML = renderHeader() + body + renderFooter() + renderReviewFormModal() + renderFlagFormModal();
  wireEvents();

  if (state.view === "directory") {
    if (directoryCache.length) renderCardsInto(directoryCache);
    loadDirectory();
  } else if (state.view === "detail") {
    loadDetail(state.selectedId);
  }
}

let eventsWired = false;

// Cards, list rows, and other action targets can be inserted into the DOM
// well after render() runs (loadDirectory() populates #resultsContainer
// asynchronously), so [data-action] listeners are delegated on #app once
// rather than attached per-node on every render.
function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  const app = el("#app");

  app.addEventListener("click", (e) => {
    const node = e.target.closest("[data-action]");
    if (!node) return;
    // Modal backdrops close on click, but not when the click originated
    // inside the modal card itself (data-stop-close) — e.g. clicking a
    // <select> inside the flag form shouldn't dismiss the modal. This only
    // applies when the closest [data-action] is the backdrop itself — the
    // Cancel/exit buttons live inside data-stop-close too, and must still
    // close the modal when clicked directly.
    if (
      (node.dataset.action === "close-review-form" || node.dataset.action === "close-flag-form") &&
      node.classList.contains("review-form-modal-backdrop") &&
      e.target.closest("[data-stop-close]")
    ) {
      return;
    }
    switch (node.dataset.action) {
      case "go-directory":
        setState({ view: "directory" });
        break;
      case "go-submit":
        setState({ view: "submit", submitted: false });
        break;
      case "layout-grid":
        setState({ layout: "grid" });
        break;
      case "layout-list":
        setState({ layout: "list" });
        break;
      case "type-filter":
        setState({ typeFilter: node.dataset.type });
        break;
      case "clear-filters":
        setState({ query: "", typeFilter: "", discipline: "All Disciplines" });
        break;
      case "open-detail":
        setState({ view: "detail", selectedId: Number(node.dataset.id), suggestEditOpen: false, suggestEditMessage: "" });
        break;
      case "submit-again":
        setState({ submitted: false, lastSubmittedName: "" });
        break;
      case "open-review-form":
        setState({ reviewFormOpportunityId: Number(node.dataset.id) });
        break;
      case "close-review-form":
        if (e.target !== node && node.dataset.stopClose) return;
        setState({ reviewFormOpportunityId: null });
        break;
      case "flag-review":
        setState({ flagReviewId: node.dataset.reviewId });
        break;
      case "close-flag-form":
        if (e.target !== node && node.dataset.stopClose) return;
        setState({ flagReviewId: null });
        break;
      case "open-suggest-edit":
        setState({ suggestEditOpen: true, suggestEditMessage: "" });
        break;
      case "close-suggest-edit":
        setState({ suggestEditOpen: false });
        break;
    }
  });

  app.addEventListener("input", (e) => {
    if (e.target.id !== "searchInput") return;
    state.query = e.target.value;
    updateFilterChrome();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadDirectory(), 300);
  });

  app.addEventListener("change", (e) => {
    if (e.target.id !== "disciplineSelect") return;
    state.discipline = e.target.value;
    renderCardsInto(directoryCache);
    updateFilterChrome();
  });

  app.addEventListener("submit", (e) => {
    if (e.target.id === "submitForm") {
      handleSubmit(e);
    } else if (e.target.id === "reviewForm") {
      handleReviewSubmit(e);
    } else if (e.target.id === "flagForm") {
      handleFlagSubmit(e);
    } else if (e.target.id === "suggestEditForm") {
      handleSuggestEditSubmit(e);
    }
  });
}

async function handleReviewSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const opportunityId = state.reviewFormOpportunityId;
  const btn = form.querySelector("button[type=submit]");
  const errorEl = el("#reviewFormError");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await submitReview(opportunityId, {
      timeCommitment: form.timeCommitment.value.trim(),
      beforeApplying: form.beforeApplying.value.trim(),
      adviceNewMember: form.adviceNewMember.value.trim(),
    });
    setState({ reviewFormOpportunityId: null });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Submit for review";
    errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

async function handleFlagSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const reviewId = state.flagReviewId;
  const btn = form.querySelector("button[type=submit]");
  const errorEl = el("#flagFormError");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await flagReview(reviewId, form.category.value, form.details.value.trim());
    setState({ flagReviewId: null });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Submit flag";
    errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

async function handleSuggestEditSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const opportunityId = Number(form.dataset.id);
  const btn = form.querySelector("button[type=submit]");
  const errorEl = el("#suggestEditError");
  errorEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await submitSuggestEdit(opportunityId, form.field.value, form.newValue.value.trim());
    setState({ suggestEditOpen: false, suggestEditMessage: "Thanks — your suggestion was submitted for review." });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Submit suggestion";
    errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

// Re-render just the "Clear filters" link visibility without a full rebuild.
function updateFilterChrome() {
  const hasActiveFilters = !!(state.query || state.typeFilter || state.discipline !== "All Disciplines");
  const filtersRow = el(".dir-filters");
  if (!filtersRow) return;
  let btn = filtersRow.querySelector(".clear-filters-btn");
  if (hasActiveFilters && !btn) {
    btn = document.createElement("button");
    btn.className = "clear-filters-btn";
    btn.dataset.action = "clear-filters";
    btn.textContent = "Clear filters";
    btn.addEventListener("click", () => setState({ query: "", typeFilter: "", discipline: "All Disciplines" }));
    filtersRow.appendChild(btn);
  } else if (!hasActiveFilters && btn) {
    btn.remove();
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

(async function init() {
  render();
  try {
    state.allTags = await fetchTags();
  } catch {
    // tag vocabulary is optional (used for submit-form tag matching); ignore failures
  }
})();
