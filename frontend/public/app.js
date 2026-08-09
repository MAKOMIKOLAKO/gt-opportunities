// GT Campus Opportunity Finder — client-side SPA (directory / detail / submit).
// All data comes from live fetch() calls against the backend API (see
// API-CONTRACT.md); there is no local seed/demo data.

const API_BASE = "/api"; // same-origin; frontend/server.js proxies this to the backend

// Per-type icon-background / label colors, reused directly from the
// Club Aggregator mockup's own catColors/avatarBg maps (VIP -> its "Arts &
// Culture" rose, Lab -> its "Technology" blue, Club -> its "Service"
// green) — see the matching --cat-* custom properties in style.css.
const TYPE_META = {
  vip: { label: "VIP Team", color: "oklch(62% 0.11 340)", catColor: "oklch(55% 0.1 340)" },
  lab: { label: "Research Lab", color: "oklch(55% 0.09 200)", catColor: "oklch(50% 0.09 200)" },
  club: { label: "Student Org", color: "oklch(56% 0.09 140)", catColor: "oklch(52% 0.08 140)" },
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

// Renders the org-icon element: an <img> against the type color background
// when `iconUrl` is set (falls back to initials text if the image URL 404s
// or fails to load — see the onerror handler), otherwise the existing
// colored-initials placeholder.
function renderOrgIcon(o, extraClass) {
  const cls = extraClass ? `org-icon ${extraClass}` : "org-icon";
  if (o.iconUrl) {
    return `<div class="${cls}" style="background:${o.iconColor}"><img src="${escapeAttr(o.iconUrl)}" alt="" loading="lazy" data-fallback="${escapeAttr(o.initials)}" onerror="this.parentElement.textContent=this.dataset.fallback" /></div>`;
  }
  return `<div class="${cls}" style="background:${o.iconColor}">${o.initials}</div>`;
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
  detailTab: "about", // about | apply — reset to "about" on every open-detail
  allTags: [],
  submitted: false,
  lastSubmittedName: "",
  iconFormOpportunityId: null,
  iconSubmitMessage: "",
  suggestEditFormOpportunityId: null,
  suggestEditMessage: "",
  filtersOpen: false, // mobile-only filter drawer; ignored above the collapse breakpoint (see .dir-filters CSS)
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
  const type = TYPE_META[opp.type] || { label: opp.type, color: "#54585A", catColor: "#54585A" };
  const discipline = computeDiscipline(opp.majors);
  return {
    ...opp,
    typeLabel: type.label,
    iconColor: type.color,
    catColor: type.catColor,
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
        <div class="dir-eyebrow">Georgia Institute of Technology</div>
        <h1>Find your next project</h1>
        <p>Search VIP teams, research labs, and technical student organizations in one place — no more digging through CampusGroups.</p>
      </div>

      <div class="dir-toolbar">
        <div class="dir-search" role="search">
          <label for="searchInput" class="visually-hidden">Search opportunities</label>
          <input id="searchInput" type="text" value="${escapeAttr(state.query)}"
            placeholder='Search by name, keyword, skill (e.g. "robotics", "Python")' autocomplete="off" />
          <span class="dir-search-icon" aria-hidden="true">&#8981;</span>
        </div>
        <div class="view-toggle" role="group" aria-label="Layout">
          <button class="${state.layout === "grid" ? "active" : ""}" data-action="layout-grid" aria-pressed="${state.layout === "grid"}">Grid</button>
          <button class="${state.layout === "list" ? "active" : ""}" data-action="layout-list" aria-pressed="${state.layout === "list"}">List</button>
        </div>
      </div>

      <button type="button" class="filters-toggle-btn" data-action="toggle-filters"
        aria-expanded="${state.filtersOpen}" aria-controls="dirFiltersPanel">
        <span>Filters${hasActiveFilters ? ` <span class="filters-active-dot" aria-hidden="true"></span>` : ""}</span>
        <span class="filters-toggle-chevron" aria-hidden="true">${state.filtersOpen ? "&#9650;" : "&#9660;"}</span>
      </button>

      <div id="dirFiltersPanel" class="dir-filters ${state.filtersOpen ? "is-open" : ""}">
        <span class="filter-label" id="typeFilterLabel">Type</span>
        <div class="type-pill-group" role="group" aria-labelledby="typeFilterLabel">
        ${TYPE_FILTERS.map(
          (t) => `
          <button class="type-pill ${state.typeFilter === t.key ? "active" : ""}" data-action="type-filter" data-type="${t.key}" aria-pressed="${state.typeFilter === t.key}">
            <span class="dot" aria-hidden="true" style="background:${t.dot}"></span>${t.label}
          </button>
        `
        ).join("")}
        </div>
        <div class="filter-divider"></div>
        <label for="disciplineSelect" class="filter-label">Discipline</label>
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
            ${renderOrgIcon(o)}
          </div>
          <div>
            <div class="org-card-name">${escapeHtml(o.name)}</div>
            <div class="org-card-sub" style="color:${o.catColor}">${escapeHtml(o.typeLabel)} &middot; ${escapeHtml(o.discipline)}</div>
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
      <div id="detailContent"><div class="state-msg">Loading&hellip;</div></div>
    </main>
  `;
}

// Detail data is cached per-id so that opening/closing the "Suggest an
// edit" or "Submit an icon" modals, and switching tabs — all of which go
// through the same setState() -> render() path as everything else — don't
// refetch and flash the whole detail pane back to a loading state.
let detailCache = {};

const DETAIL_TABS = [
  { key: "about", label: "About" },
  { key: "apply", label: "How to Apply" },
];

function renderDetailAboutTab(opp, d) {
  return `
    <div class="detail-info-grid">
      ${
        opp.type === "club"
          ? ""
          : `
      <div><div class="detail-info-label">Credit / Pay</div><div class="detail-info-value">${escapeHtml(d.creditPay)}</div></div>
      <div><div class="detail-info-label">Faculty Lead</div><div class="detail-info-value">${escapeHtml(d.lead)}</div></div>
      `
      }
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

    ${renderRelatedOrgsBlock(opp)}

    <div class="detail-manage-row">
      <button class="propose-edit-btn" data-action="open-suggest-edit" data-id="${opp.id}">Suggest an edit</button>
      <button class="icon-submit-btn" data-action="open-icon-form" data-id="${opp.id}">Submit an icon</button>
    </div>
    ${state.suggestEditMessage ? `<div class="utility-feedback">${escapeHtml(state.suggestEditMessage)}</div>` : ""}
    ${state.iconSubmitMessage ? `<div class="utility-feedback">${escapeHtml(state.iconSubmitMessage)}</div>` : ""}
  `;
}

function renderDetailApplyTab(opp, d) {
  return `
    ${d.applyUrl ? `<p><a class="apply-btn" href="${escapeAttr(d.applyUrl)}" target="_blank" rel="noopener">Apply / Learn more &rarr;</a></p>` : ""}
    <p class="detail-contact">Contact: ${escapeHtml(d.contact)}</p>
    ${renderLinksBlock(opp)}
  `;
}

function renderDetailBody(opp) {
    const d = detailFields(opp);
    const tab = state.detailTab;
    return `
      <div class="detail-card">
        <nav class="detail-breadcrumbs" aria-label="Breadcrumb">
          <button type="button" data-action="go-directory">Directory</button>
          <span aria-hidden="true">/</span>
          <span class="crumb-cat" style="color:${opp.catColor}">${escapeHtml(opp.typeLabel)}</span>
          <span aria-hidden="true">/</span>
          <span class="crumb-current">${escapeHtml(opp.name)}</span>
        </nav>

        <div class="detail-header">
          ${renderOrgIcon(opp, "lg")}
          <div class="detail-header-text">
            <h1>${escapeHtml(opp.name)}</h1>
            <div class="detail-sub" style="color:${opp.catColor}">${escapeHtml(opp.typeLabel)}</div>
          </div>
        </div>

        <p class="detail-desc">${escapeHtml(opp.description || "")}</p>

        <div class="detail-tabs" role="tablist">
          ${DETAIL_TABS.map(
            (t) => `
          <button class="detail-tab-btn ${tab === t.key ? "active" : ""}" role="tab" aria-selected="${tab === t.key}" data-action="detail-tab" data-tab="${t.key}">${t.label}</button>
          `
          ).join("")}
        </div>

        <div class="detail-tab-panel" role="tabpanel">
          ${tab === "apply" ? renderDetailApplyTab(opp, d) : renderDetailAboutTab(opp, d)}
        </div>
      </div>
    `;
}

async function loadDetail(id, { forceRefresh = false } = {}) {
  const container = el("#detailContent");
  const cached = detailCache[id];
  if (cached && !forceRefresh) {
    container.innerHTML = renderDetailBody(cached);
    return;
  }
  try {
    const opp = decorateOrg(await fetchOpportunity(id));
    detailCache[id] = opp;
    // The container may have been swapped out (view changed / user
    // navigated away) while this fetch was in flight.
    if (state.view !== "detail" || state.selectedId !== id) return;
    el("#detailContent").innerHTML = renderDetailBody(opp);
  } catch (err) {
    if (state.view !== "detail" || state.selectedId !== id) return;
    el("#detailContent").innerHTML = `<div class="state-msg error">${err.message === "not_found" ? "This opportunity could not be found." : "Failed to load: " + escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Rendering — detail page utility actions ("Submit an icon" / "Suggest an
// edit"). Both are secondary actions that live together in .detail-manage-row
// at the bottom of the About tab, out of the way of Apply/social buttons.
//
// Icon submission is scoped to the detail page only, not the "submit an
// org" form — a brand new org submission has no id until an admin
// approves it, so there's nothing for /api/opportunities/:id/icon to
// attach to yet. (See BUILD_NOTES.md for this as a documented assumption,
// not an oversight.)
// ---------------------------------------------------------------------

function renderIconFormModal() {
  if (!state.iconFormOpportunityId) return "";
  return `
    <div class="review-form-modal-backdrop" data-action="close-icon-form">
      <div class="review-form-modal" data-stop-close="1">
        <h3>Submit an icon</h3>
        <div class="modal-sub">Upload a logo/icon image for this org (PNG, JPG, GIF, WEBP, or SVG, max 2MB). A moderator reviews it before it goes live.</div>
        <form id="iconForm" data-id="${state.iconFormOpportunityId}">
          <input type="file" name="icon" required accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" />
          <div id="iconFormError"></div>
          <div class="review-form-actions">
            <button type="button" class="review-form-cancel-btn" data-action="close-icon-form">Cancel</button>
            <button type="submit" class="submit-btn">Submit icon</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Rendering — related organizations
//
// `relatedOrgs` comes back on the detail response (see API-CONTRACT.md),
// precomputed server-side from embedding similarity — never computed here.
// Deliberately cross-category: a VIP team's related orgs can include labs
// and clubs with zero tag overlap, so this section does NOT group/label by
// type the way the directory filters do. Hidden entirely (not rendered as
// an empty slider) when there's nothing to show — most opportunities will
// have an empty relatedOrgs array until OPENAI_API_KEY is configured
// server-side (see BUILD_NOTES.md), so this is the common case for now.
// ---------------------------------------------------------------------

function renderRelatedOrgsBlock(opp) {
  const related = (opp.relatedOrgs || []).map(decorateOrg);
  if (related.length === 0) return "";
  return `
    <div class="related-orgs-block">
      <h2>Related organizations</h2>
      <div class="related-orgs-scroller">
        ${related.map(renderRelatedOrgChip).join("")}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Rendering — additional links
//
// `opp.link` (the primary "how to apply" link, rendered as the Apply button
// above) is separate from this — these are ADDITIONAL org links (apply-
// adjacent, homepage, social, other) approved via the links moderation
// queue. Only approved links are ever sent to this client.
// ---------------------------------------------------------------------

const LINK_TYPE_LABELS = { apply: "Apply", homepage: "Homepage", social: "Social", other: "Link" };

function renderLinksBlock(opp) {
  const links = opp.links || [];
  if (links.length === 0) return "";
  return `
    <div class="links-block">
      <div class="detail-tags-label">More links</div>
      <ul class="links-list">
        ${links
          .map(
            (l) => `
          <li class="links-list-item">
            <span class="link-type-badge">${escapeHtml(LINK_TYPE_LABELS[l.type] || l.type)}</span>
            <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>
          </li>
        `
          )
          .join("")}
      </ul>
    </div>
  `;
}

async function submitIcon(opportunityId, file) {
  const formData = new FormData();
  formData.append("icon", file);
  const res = await fetch(`${API_BASE}/opportunities/${opportunityId}/icon`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`);
  return data.result;
}

async function handleIconSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const opportunityId = Number(form.dataset.id);
  const errorEl = el("#iconFormError");
  errorEl.innerHTML = "";
  const file = form.icon.files[0];
  if (!file) {
    errorEl.innerHTML = `<div class="form-error">Choose an image file first.</div>`;
    return;
  }
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await submitIcon(opportunityId, file);
    setState({ iconFormOpportunityId: null, iconSubmitMessage: "Thanks — submitted for moderator review." });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Submit icon";
    errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

function renderRelatedOrgChip(o) {
  return `<button class="related-org-chip" data-action="open-detail" data-id="${o.id}">${escapeHtml(o.name)}</button>`;
}

// ---------------------------------------------------------------------
// Rendering — suggest an edit
//
// Lightweight, unobtrusive "propose a correction" affordance, opened from
// the "Suggest an edit" button in .detail-manage-row. Posts to
// POST /api/opportunities/:id/suggest-edit and lands in the admin
// "Suggested Edits" queue as a pending row — nothing here touches the live
// listing directly.
// ---------------------------------------------------------------------

function renderSuggestEditModal() {
  if (!state.suggestEditFormOpportunityId) return "";
  return `
    <div class="review-form-modal-backdrop" data-action="close-suggest-edit">
      <div class="review-form-modal" data-stop-close="1">
        <h3>Suggest an edit</h3>
        <form id="suggestEditForm" data-id="${state.suggestEditFormOpportunityId}">
          <label for="suggestEditField">Field</label>
          <select id="suggestEditField" name="field" required style="width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid var(--pi-mile);font-size:16px;margin-bottom:14px;">
            ${SUGGEST_EDIT_FIELDS.map((f) => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join("")}
          </select>
          <label for="suggestEditValue">Proposed new value</label>
          <textarea id="suggestEditValue" name="newValue" required rows="2" maxlength="2000" placeholder="For Majors sought, separate multiple majors with commas"></textarea>
          <div id="suggestEditError"></div>
          <div class="review-form-actions">
            <button type="button" class="review-form-cancel-btn" data-action="close-suggest-edit">Cancel</button>
            <button type="submit" class="submit-btn">Submit suggestion</button>
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
          <label for="submitName">Organization name *</label>
          <input id="submitName" type="text" name="name" required maxlength="200" placeholder="e.g. VIP-Autonomous Racing" autocomplete="off" />
        </div>
        <div class="submit-form-row">
          <div>
            <label for="submitType">Type *</label>
            <select id="submitType" name="type" required>
              <option value="">Select type</option>
              <option value="vip">VIP Team</option>
              <option value="lab">Research Lab</option>
              <option value="club">Student Org</option>
            </select>
          </div>
          <div>
            <label for="submitDiscipline">Discipline / College</label>
            <select id="submitDiscipline" name="discipline">
              ${disciplineOptions.map((d) => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div>
          <label for="submitDescription">Short description *</label>
          <textarea id="submitDescription" name="description" required rows="4" maxlength="2000" placeholder="What does this org do? Who should join?"></textarea>
        </div>
        <div class="submit-form-row">
          <div>
            <label for="submitTags">Skills / keywords</label>
            <input id="submitTags" type="text" name="tags" placeholder="comma separated, e.g. Python, CAD" autocomplete="off" />
          </div>
          <div>
            <label for="submitEmail">Your GT email *</label>
            <input id="submitEmail" type="email" name="email" required placeholder="you@gatech.edu" autocomplete="email" inputmode="email" />
          </div>
        </div>
        <div class="submit-links-block">
          <div class="submit-links-head">
            <label>Additional links <span class="submit-links-hint">(optional — apply link, homepage, socials, etc.)</span></label>
            <button type="button" class="add-link-row-btn" data-action="add-link-row">+ Add a link</button>
          </div>
          <div id="linkRows"></div>
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

function linkRowHtml() {
  return `
    <div class="link-row">
      <input type="text" class="link-row-label" placeholder="Label (e.g. Apply Now)" maxlength="200" aria-label="Link label" autocomplete="off" />
      <input type="url" class="link-row-url" placeholder="https://..." maxlength="500" aria-label="Link URL" inputmode="url" autocomplete="off" />
      <select class="link-row-type" aria-label="Link type">
        <option value="apply">Apply</option>
        <option value="homepage">Homepage</option>
        <option value="social">Social</option>
        <option value="other" selected>Other</option>
      </select>
      <button type="button" class="remove-link-row-btn" data-action="remove-link-row" aria-label="Remove link">&times;</button>
    </div>
  `;
}

function collectLinkRows(form) {
  const rows = [...form.querySelectorAll(".link-row")];
  return rows
    .map((row) => ({
      label: row.querySelector(".link-row-label").value.trim(),
      url: row.querySelector(".link-row-url").value.trim(),
      type: row.querySelector(".link-row-type").value,
    }))
    .filter((r) => r.label && r.url);
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
    links: collectLinkRows(form),
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

// The modal forms (icon/suggest-edit) toggle open and closed
// through the same setState()->render() path as every other state change,
// but they only ever open from the detail page and don't affect the
// header/detail/footer content at all. Rebuilding the *entire* #app
// innerHTML just to show/hide a modal tears down and recreates the whole
// page's DOM (header, nav, detail card, org icons, footer) on every click —
// which is what actually reads as "the page refreshing", even with
// loadDetail()'s cache avoiding a refetch. When we're still on the same
// detail page as the last render, skip the full shell rebuild and only
// refresh #detailContent (from cache) and #modalRoot.
let lastDetailShellId = null;

function render() {
  const app = el("#app");

  if (state.view === "detail" && state.selectedId === lastDetailShellId && el("#pageShell")) {
    loadDetail(state.selectedId);
    renderModals();
    return;
  }
  lastDetailShellId = state.view === "detail" ? state.selectedId : null;

  let body;
  if (state.view === "detail") body = renderDetailShell();
  else if (state.view === "submit") body = renderSubmit();
  else body = renderDirectory();

  app.innerHTML = `<div id="pageShell">${renderHeader() + body + renderFooter()}</div><div id="modalRoot"></div>`;
  wireEvents();

  if (state.view === "directory") {
    if (directoryCache.length) renderCardsInto(directoryCache);
    loadDirectory();
  } else if (state.view === "detail") {
    loadDetail(state.selectedId);
  }

  renderModals();
}

function renderModals() {
  const modalRoot = el("#modalRoot");
  if (!modalRoot) return;
  modalRoot.innerHTML = renderIconFormModal() + renderSuggestEditModal();
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
    // inside the modal card itself (data-stop-close). This only applies
    // when the closest [data-action] is the backdrop itself — the
    // Cancel/exit buttons live inside data-stop-close too, and must still
    // close the modal when clicked directly.
    if (
      (node.dataset.action === "close-icon-form" ||
        node.dataset.action === "close-suggest-edit") &&
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
      case "toggle-filters":
        setState({ filtersOpen: !state.filtersOpen });
        break;
      case "open-detail":
        setState({
          view: "detail",
          selectedId: Number(node.dataset.id),
          detailTab: "about",
          suggestEditFormOpportunityId: null,
          suggestEditMessage: "",
          iconFormOpportunityId: null,
          iconSubmitMessage: "",
        });
        break;
      case "detail-tab":
        setState({ detailTab: node.dataset.tab });
        break;
      case "submit-again":
        setState({ submitted: false, lastSubmittedName: "" });
        break;
      case "add-link-row": {
        const container = el("#linkRows");
        if (container) container.insertAdjacentHTML("beforeend", linkRowHtml());
        break;
      }
      case "remove-link-row": {
        const row = node.closest(".link-row");
        if (row) row.remove();
        break;
      }
      case "open-icon-form":
        setState({ iconFormOpportunityId: Number(node.dataset.id), iconSubmitMessage: "" });
        break;
      case "close-icon-form":
        if (e.target !== node && node.dataset.stopClose) return;
        setState({ iconFormOpportunityId: null });
        break;
      case "open-suggest-edit":
        setState({ suggestEditFormOpportunityId: Number(node.dataset.id), suggestEditMessage: "" });
        break;
      case "close-suggest-edit":
        if (e.target !== node && node.dataset.stopClose) return;
        setState({ suggestEditFormOpportunityId: null });
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
    } else if (e.target.id === "iconForm") {
      handleIconSubmit(e);
    } else if (e.target.id === "suggestEditForm") {
      handleSuggestEditSubmit(e);
    }
  });
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
    setState({ suggestEditFormOpportunityId: null, suggestEditMessage: "Thanks — your suggestion was submitted for review." });
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

// Reads deep-link params so links from the server-rendered SEO pages
// (backend/src/routes/seo.ts's "open in interactive app" link, and the
// WebSite/SearchAction JSON-LD on this page) land the SPA in the right
// state instead of always starting at the bare directory:
//   ?opportunity=<id> -> open that listing's detail view directly
//   ?search=<term>    -> pre-fill the search box (also what the
//                        sitelinks-search-box JSON-LD's SearchAction targets)
//   ?type=vip|lab|club -> pre-select a type filter
function applyDeepLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const opportunityId = Number(params.get("opportunity"));
  if (Number.isInteger(opportunityId) && opportunityId > 0) {
    Object.assign(state, { view: "detail", selectedId: opportunityId });
    return;
  }
  const search = params.get("search");
  const type = params.get("type");
  if (search) state.query = search;
  if (type === "vip" || type === "lab" || type === "club") state.typeFilter = type;
}

(async function init() {
  applyDeepLinkFromUrl();
  render();
  try {
    state.allTags = await fetchTags();
  } catch {
    // tag vocabulary is optional (used for submit-form tag matching); ignore failures
  }
})();
