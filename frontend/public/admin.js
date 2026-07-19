// Minimal admin panel: pending reviews queue + reports/disputes queue +
// pending links queue (additional org links beyond "how to apply") + pending
// icons queue (org profile icon submissions) + suggested edits queue
// (single-field correction proposals against existing listings). It does not
// attempt to build out opportunity-approval UI (that queue already has a
// working API at GET/POST /api/admin/opportunities/* but no frontend; out of
// scope here).
const API_BASE = "/api";
const el = (sel, root = document) => root.querySelector(sel);

const state = {
  token: sessionStorage.getItem("gt_admin_token") || null,
  tab: "reviews", // reviews | reports | links | icons | suggestedEdits
  reviews: [],
  reports: [],
  links: [],
  icons: [],
  suggestedEdits: [],
  guidance: "",
  loading: false,
  error: "",
};

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
  });
  if (res.status === 401) {
    setState({ token: null });
    sessionStorage.removeItem("gt_admin_token");
    throw new Error("Session expired — please log in again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`);
  return data;
}

async function login(username, password) {
  const res = await fetch(`${API_BASE}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");
  sessionStorage.setItem("gt_admin_token", data.token);
  setState({ token: data.token });
  loadQueues();
}

async function loadQueues() {
  setState({ loading: true, error: "" });
  try {
    const [reviewsRes, reportsRes, linksRes, iconsRes, suggestedEditsRes] = await Promise.all([
      apiFetch("/admin/reviews?status=pending"),
      apiFetch("/admin/reports?status=open"),
      apiFetch("/admin/links?status=pending"),
      apiFetch("/admin/icons/pending"),
      apiFetch("/admin/suggested-edits?status=pending"),
    ]);
    setState({
      reviews: reviewsRes.results,
      guidance: reviewsRes.guidance || "",
      reports: reportsRes.results,
      links: linksRes.results,
      icons: iconsRes.results,
      suggestedEdits: suggestedEditsRes.results,
      loading: false,
    });
  } catch (err) {
    setState({ loading: false, error: err.message });
  }
}

async function approveReview(id) {
  try {
    await apiFetch(`/admin/reviews/${id}/approve`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function rejectReview(id) {
  try {
    await apiFetch(`/admin/reviews/${id}/reject`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function resolveReport(id) {
  try {
    await apiFetch(`/admin/reports/${id}/resolve`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function approveLink(id) {
  try {
    await apiFetch(`/admin/links/${id}/approve`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function rejectLink(id) {
  try {
    await apiFetch(`/admin/links/${id}/reject`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function approveIcon(id) {
  try {
    await apiFetch(`/admin/opportunities/${id}/icon/approve`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function rejectIcon(id) {
  try {
    await apiFetch(`/admin/opportunities/${id}/icon/reject`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function approveSuggestedEdit(id) {
  try {
    await apiFetch(`/admin/suggested-edits/${id}/approve`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

async function rejectSuggestedEdit(id) {
  try {
    await apiFetch(`/admin/suggested-edits/${id}/reject`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

function renderLogin() {
  return `
    <main class="view-admin">
      <h1 style="font-size:22px;font-weight:800;color:var(--navy);">Admin login</h1>
      <form id="loginForm" class="admin-login-form">
        <input type="text" name="username" placeholder="Username" required autocomplete="username" />
        <input type="password" name="password" placeholder="Password" required autocomplete="current-password" />
        <div id="loginError"></div>
        <button type="submit" class="submit-btn">Log in</button>
      </form>
      <p style="font-size:12px;color:var(--gray-matter);max-width:400px;">
        Credentials are generated fresh on every backend restart — see
        RUN-STATUS.md (gitignored, printed to the backend console).
      </p>
    </main>
  `;
}

function renderReviewsTab() {
  if (state.reviews.length === 0) {
    return `<div class="review-empty">No pending reviews.</div>`;
  }
  return state.reviews
    .map(
      (r) => `
    <div class="admin-queue-item">
      <div class="admin-queue-item-head">
        <div class="admin-queue-item-title">${escapeHtml(r.opportunityName)} <span class="admin-queue-item-meta">(opportunity #${r.opportunityId})</span></div>
        <div class="admin-queue-item-meta">${escapeHtml((r.createdAt || "").slice(0, 16))}</div>
      </div>
      <div class="review-card-row"><div class="review-card-q">Time commitment</div><div class="review-card-a">${escapeHtml(r.timeCommitment)}</div></div>
      <div class="review-card-row"><div class="review-card-q">Before applying</div><div class="review-card-a">${escapeHtml(r.beforeApplying)}</div></div>
      <div class="review-card-row"><div class="review-card-q">Advice for a new member</div><div class="review-card-a">${escapeHtml(r.adviceNewMember)}</div></div>
      <div class="admin-queue-actions">
        <button class="admin-btn approve" data-action="approve-review" data-id="${escapeHtml(r.id)}">Approve</button>
        <button class="admin-btn reject" data-action="reject-review" data-id="${escapeHtml(r.id)}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderReportsTab() {
  if (state.reports.length === 0) {
    return `<div class="review-empty">No open reports.</div>`;
  }
  return state.reports
    .map(
      (r) => `
    <div class="admin-queue-item">
      <div class="admin-queue-item-head">
        <div class="admin-queue-item-title">
          ${r.reviewId ? `Review dispute — review ${escapeHtml(r.reviewId.slice(0, 8))}&hellip;` : "Opportunity report"}
          ${r.opportunityId ? `<span class="admin-queue-item-meta">(opportunity #${r.opportunityId})</span>` : ""}
        </div>
        <div class="admin-queue-item-meta">${escapeHtml((r.createdAt || "").slice(0, 16))}</div>
      </div>
      <div class="review-card-row"><div class="review-card-q">Category</div><div class="review-card-a">${escapeHtml(r.category)}</div></div>
      ${r.details ? `<div class="review-card-row"><div class="review-card-q">Details</div><div class="review-card-a">${escapeHtml(r.details)}</div></div>` : ""}
      <div class="admin-queue-actions">
        <button class="admin-btn resolve" data-action="resolve-report" data-id="${r.id}">Mark resolved</button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderLinksTab() {
  if (state.links.length === 0) {
    return `<div class="review-empty">No pending links.</div>`;
  }
  return state.links
    .map(
      (l) => `
    <div class="admin-queue-item">
      <div class="admin-queue-item-head">
        <div class="admin-queue-item-title">${escapeHtml(l.opportunityName)} <span class="admin-queue-item-meta">(opportunity #${l.opportunityId})</span></div>
        <div class="admin-queue-item-meta">${escapeHtml((l.createdAt || "").slice(0, 16))}</div>
      </div>
      <div class="review-card-row"><div class="review-card-q">Type</div><div class="review-card-a">${escapeHtml(l.type)}</div></div>
      <div class="review-card-row"><div class="review-card-q">Label</div><div class="review-card-a">${escapeHtml(l.label)}</div></div>
      <div class="review-card-row"><div class="review-card-q">URL</div><div class="review-card-a"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a></div></div>
      <div class="admin-queue-actions">
        <button class="admin-btn approve" data-action="approve-link" data-id="${l.id}">Approve</button>
        <button class="admin-btn reject" data-action="reject-link" data-id="${l.id}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderIconsTab() {
  if (state.icons.length === 0) {
    return `<div class="review-empty">No pending icon submissions.</div>`;
  }
  return state.icons
    .map(
      (o) => `
    <div class="admin-queue-item">
      <div class="admin-queue-item-head">
        <div class="admin-queue-item-title">${escapeHtml(o.name)} <span class="admin-queue-item-meta">(opportunity #${o.id})</span></div>
      </div>
      <div class="icon-compare-row">
        <div class="icon-compare-col">
          <div class="icon-compare-label">Current</div>
          <div class="icon-compare-thumb">${o.iconUrl ? `<img src="${escapeHtml(o.iconUrl)}" alt="" onerror="this.parentElement.textContent='broken'" />` : "no icon"}</div>
        </div>
        <div class="icon-compare-arrow">&rarr;</div>
        <div class="icon-compare-col">
          <div class="icon-compare-label">Submitted</div>
          <div class="icon-compare-thumb">${o.iconPendingUrl ? `<img src="${escapeHtml(o.iconPendingUrl)}" alt="" onerror="this.parentElement.textContent='broken'" />` : "no icon"}</div>
        </div>
      </div>
      <div class="admin-queue-actions">
        <button class="admin-btn approve" data-action="approve-icon" data-id="${o.id}">Approve</button>
        <button class="admin-btn reject" data-action="reject-icon" data-id="${o.id}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
}

const SUGGEST_EDIT_FIELD_LABELS = { name: "Name", description: "Description", link: "Link", majors: "Majors sought" };

// Simple side-by-side strikethrough-old / highlighted-new display — no real
// diff algorithm, these are short field values (a name/description/link, or
// a majors list), not documents. `majors` values are stored/submitted as
// JSON-serialized arrays; pretty-print them as a comma list for readability.
function formatSuggestedValue(field, value) {
  if (value === null || value === undefined) return "(empty)";
  if (field !== "majors") return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join(", ") || "(none)" : value;
  } catch {
    return value;
  }
}

function renderSuggestedEditsTab() {
  if (state.suggestedEdits.length === 0) {
    return `<div class="review-empty">No pending suggested edits.</div>`;
  }
  return state.suggestedEdits
    .map(
      (s) => `
    <div class="admin-queue-item">
      <div class="admin-queue-item-head">
        <div class="admin-queue-item-title">
          <span class="suggest-edit-field-badge">${escapeHtml(SUGGEST_EDIT_FIELD_LABELS[s.field] || s.field)}</span>
          ${escapeHtml(s.opportunityName)} <span class="admin-queue-item-meta">(opportunity #${s.opportunityId})</span>
        </div>
        <div class="admin-queue-item-meta">${escapeHtml((s.createdAt || "").slice(0, 16))}</div>
      </div>
      <div class="suggest-edit-diff">
        <div class="suggest-edit-diff-old">${escapeHtml(formatSuggestedValue(s.field, s.oldValue))}</div>
        <div class="suggest-edit-diff-new">${escapeHtml(formatSuggestedValue(s.field, s.newValue))}</div>
      </div>
      ${s.submittedBy ? `<div class="admin-queue-item-meta">Submitted by: ${escapeHtml(s.submittedBy)}</div>` : ""}
      <div class="admin-queue-actions">
        <button class="admin-btn approve" data-action="approve-suggested-edit" data-id="${s.id}">Approve</button>
        <button class="admin-btn reject" data-action="reject-suggested-edit" data-id="${s.id}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderDashboard() {
  return `
    <main class="view-admin">
      <h1 style="font-size:22px;font-weight:800;color:var(--navy);margin-bottom:16px;">Moderation queue</h1>
      <div class="admin-tabs">
        <button class="${state.tab === "reviews" ? "active" : ""}" data-action="tab-reviews">Reviews (${state.reviews.length})</button>
        <button class="${state.tab === "reports" ? "active" : ""}" data-action="tab-reports">Reports / Disputes (${state.reports.length})</button>
        <button class="${state.tab === "links" ? "active" : ""}" data-action="tab-links">Links (${state.links.length})</button>
        <button class="${state.tab === "icons" ? "active" : ""}" data-action="tab-icons">Pending Icons (${state.icons.length})</button>
        <button class="${state.tab === "suggestedEdits" ? "active" : ""}" data-action="tab-suggested-edits">Suggested Edits (${state.suggestedEdits.length})</button>
      </div>
      ${
        state.tab === "reviews"
          ? `<div class="admin-guidance"><strong>Moderation guidance for reviews:</strong> ${escapeHtml(state.guidance)}</div>`
          : state.tab === "reports"
          ? `<div class="admin-guidance">General opportunity reports and review disputes (flagged published reviews) both land here. A review dispute is a request for re-review — go back to the Reviews tab, re-check the flagged review against the same guidance, and reject it if warranted; resolving here just closes the report itself.</div>`
          : state.tab === "links"
          ? `<div class="admin-guidance">Additional org links (apply-adjacent, homepage, social, other) submitted either standalone or alongside a new org submission. Approve only links that look legitimate and match the organization.</div>`
          : state.tab === "icons"
          ? `<div class="admin-guidance">Compare the current live icon (if any) against the submitted icon before approving. Approve promotes the submitted icon to live; reject discards it without touching the live icon.</div>`
          : `<div class="admin-guidance">Anonymous corrections proposed for a single field on an existing listing. Approving writes the new value directly onto the live listing (and refreshes search); rejecting leaves the listing untouched.</div>`
      }
      ${state.error ? `<div class="form-error" style="margin-bottom:14px;">${escapeHtml(state.error)}</div>` : ""}
      ${
        state.loading
          ? `<div class="state-msg">Loading&hellip;</div>`
          : state.tab === "reviews"
          ? renderReviewsTab()
          : state.tab === "reports"
          ? renderReportsTab()
          : state.tab === "links"
          ? renderLinksTab()
          : state.tab === "icons"
          ? renderIconsTab()
          : renderSuggestedEditsTab()
      }
    </main>
  `;
}

function render() {
  const app = el("#app");
  app.innerHTML = state.token ? renderDashboard() : renderLogin();
  wireEvents();
}

let eventsWired = false;
function wireEvents() {
  if (eventsWired) return;
  eventsWired = true;
  const app = el("#app");

  app.addEventListener("submit", async (e) => {
    if (e.target.id !== "loginForm") return;
    e.preventDefault();
    const form = e.target;
    const errorEl = el("#loginError");
    errorEl.innerHTML = "";
    try {
      await login(form.username.value, form.password.value);
    } catch (err) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  });

  app.addEventListener("click", (e) => {
    const node = e.target.closest("[data-action]");
    if (!node) return;
    switch (node.dataset.action) {
      case "tab-reviews":
        setState({ tab: "reviews" });
        break;
      case "tab-reports":
        setState({ tab: "reports" });
        break;
      case "tab-links":
        setState({ tab: "links" });
        break;
      case "tab-icons":
        setState({ tab: "icons" });
        break;
      case "tab-suggested-edits":
        setState({ tab: "suggestedEdits" });
        break;
      case "approve-review":
        approveReview(node.dataset.id);
        break;
      case "reject-review":
        rejectReview(node.dataset.id);
        break;
      case "resolve-report":
        resolveReport(Number(node.dataset.id));
        break;
      case "approve-link":
        approveLink(Number(node.dataset.id));
        break;
      case "reject-link":
        rejectLink(Number(node.dataset.id));
        break;
      case "approve-icon":
        approveIcon(Number(node.dataset.id));
        break;
      case "reject-icon":
        rejectIcon(Number(node.dataset.id));
        break;
      case "approve-suggested-edit":
        approveSuggestedEdit(Number(node.dataset.id));
        break;
      case "reject-suggested-edit":
        rejectSuggestedEdit(Number(node.dataset.id));
        break;
    }
  });
}

render();
if (state.token) loadQueues();
