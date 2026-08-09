// Admin SPA: login gate + every moderation/ops surface the backend exposes
// under /api/admin/*. Hash-routed (#/login, #/opportunities, #/reviews, ...)
// so the URL reflects state without needing server-side routes.
//
// This used to be split across two separate admin frontends — this file
// (opportunity approval queue + leader-access revocation, module 6 of 7)
// and a second, entirely separate app at the old /admin.html (reviews,
// reports, links, icons, suggested edits, access requests + claim links,
// audit log). Neither ever overlapped in functionality, so folding them
// together was a straight port, not a conflict-resolution exercise: every
// section below lives at its own hash route in this one shell, sharing the
// same AdminAPI auth (both apps already used the same sessionStorage token
// key, so a login here is not a regression for anyone with that old file
// bookmarked — see /admin.html, which now just redirects here).
const root = document.getElementById("admin-app");

const SECTIONS = [
  { slug: "opportunities", label: "Opportunities" },
  { slug: "reviews", label: "Reviews" },
  { slug: "reports", label: "Reports / Disputes" },
  { slug: "links", label: "Links" },
  { slug: "icons", label: "Pending Icons" },
  { slug: "suggested-edits", label: "Suggested Edits" },
  { slug: "access-requests", label: "Access Requests" },
  { slug: "audit-log", label: "Audit Log" },
];

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (!AdminAPI.isLoggedIn()) {
    if (hash !== "login") location.hash = "#/login";
    renderLogin();
    return;
  }
  if (hash === "login" || hash === "") {
    location.hash = "#/opportunities";
    return;
  }
  const section = SECTIONS.find((s) => s.slug === hash) ? hash : "opportunities";
  if (section !== hash) {
    location.hash = `#/${section}`;
    return;
  }
  renderShell(section);
}

window.addEventListener("hashchange", route);
document.addEventListener("DOMContentLoaded", route);

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------
// Login view
// ---------------------------------------------------------------------

function renderLogin(errorMessage) {
  root.innerHTML = `
    <div class="admin-login-wrap">
      <form class="admin-login-card" id="login-form" novalidate>
        <div class="admin-brand">Georgia Tech</div>
        <h1>Admin Sign In</h1>
        <p class="admin-sub">Review queue access for the Opportunity Finder.</p>
        <label class="admin-field">
          <span>Username</span>
          <input type="text" name="username" autocomplete="username" required />
        </label>
        <label class="admin-field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <div class="admin-error" id="login-error" ${errorMessage ? "" : "hidden"}>${errorMessage || ""}</div>
        <button type="submit" class="admin-btn admin-btn-primary">Log In</button>
      </form>
      <p class="admin-login-note">Credentials are generated fresh on every backend restart if not set via env vars — see RUN-STATUS.md (gitignored, printed to the backend console) for a local dev run.</p>
    </div>
  `;

  const form = document.getElementById("login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("login-error");
    const submitBtn = form.querySelector("button[type=submit]");
    const username = form.username.value.trim();
    const password = form.password.value;

    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    try {
      await AdminAPI.login(username, password);
      location.hash = "#/opportunities";
      route();
    } catch (err) {
      errorEl.textContent = err.message || "Login failed. Please try again.";
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Log In";
    }
  });
}

// ---------------------------------------------------------------------
// Shell — topbar + section nav, shared by every logged-in view
// ---------------------------------------------------------------------

function renderShell(section) {
  root.innerHTML = `
    <div class="admin-shell">
      <header class="admin-topbar">
        <div class="admin-brand">Georgia Tech <span>Admin</span></div>
        <button class="admin-btn admin-btn-ghost" id="logout-btn">Log Out</button>
      </header>
      <nav class="admin-section-nav" id="section-nav">
        ${SECTIONS.map(
          (s) => `<a class="admin-section-tab ${s.slug === section ? "active" : ""}" href="#/${s.slug}">${s.label}</a>`
        ).join("")}
      </nav>
      <main class="admin-main" id="admin-section-root"></main>
    </div>
  `;
  document.getElementById("logout-btn").addEventListener("click", () => AdminAPI.logout());

  const sectionRoot = document.getElementById("admin-section-root");
  const renderers = {
    opportunities: renderOpportunitiesSection,
    reviews: renderReviewsSection,
    reports: renderReportsSection,
    links: renderLinksSection,
    icons: renderIconsSection,
    "suggested-edits": renderSuggestedEditsSection,
    "access-requests": renderAccessRequestsSection,
    "audit-log": renderAuditLogSection,
  };
  (renderers[section] || renderOpportunitiesSection)(sectionRoot);
}

function showQueueError(message) {
  const errorEl = document.getElementById("queue-error");
  if (errorEl) {
    errorEl.textContent = message || "Something went wrong.";
    errorEl.hidden = false;
  }
}

// ---------------------------------------------------------------------
// Opportunities — approval queue + leader-access revocation (module 6 of 7)
// ---------------------------------------------------------------------

let currentStatus = "pending";
let editingId = null;
// Leader-access revocation panel state. Keyed by opportunity id so only one
// row's panel is fetched/expanded at a time. `accessCache[id]` holds the
// last-loaded { access, sessions } response for that opportunity so
// re-rendering the list (e.g. after a session revoke) doesn't need a fresh
// network round trip unless explicitly refetched.
let accessPanelOpenId = null;
const accessCache = {};

async function renderOpportunitiesSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head">
      <h1>Review Queue</h1>
      <div class="admin-status-tabs" id="status-tabs">
        ${["pending", "approved", "rejected", ""].map((s) => `
          <button class="admin-tab ${s === currentStatus ? "active" : ""}" data-status="${s}">
            ${s === "" ? "All" : s[0].toUpperCase() + s.slice(1)}
          </button>
        `).join("")}
      </div>
    </div>
    <div class="admin-error" id="queue-error" hidden></div>
    <div id="queue-list" class="admin-queue-list">
      <p class="admin-loading">Loading...</p>
    </div>
  `;

  document.getElementById("status-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    currentStatus = btn.dataset.status;
    renderOpportunitiesSection(sectionRoot);
  });

  await loadQueue();
}

async function loadQueue() {
  const listEl = document.getElementById("queue-list");
  const errorEl = document.getElementById("queue-error");
  try {
    const qs = currentStatus ? `?status=${encodeURIComponent(currentStatus)}` : "";
    const { results } = await AdminAPI.request(`/api/admin/opportunities${qs}`);
    renderList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    listEl.innerHTML = "";
    errorEl.textContent = err.message || "Failed to load the queue.";
    errorEl.hidden = false;
  }
}

function renderList(results) {
  const listEl = document.getElementById("queue-list");
  if (!results.length) {
    listEl.innerHTML = `<p class="admin-empty">Nothing here.</p>`;
    return;
  }

  listEl.innerHTML = results.map((opp) => rowHtml(opp)).join("");

  listEl.querySelectorAll("[data-approve]").forEach((btn) =>
    btn.addEventListener("click", () => handleApprove(Number(btn.dataset.approve)))
  );
  listEl.querySelectorAll("[data-reject]").forEach((btn) =>
    btn.addEventListener("click", () => handleReject(Number(btn.dataset.reject)))
  );
  listEl.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingId = editingId === Number(btn.dataset.edit) ? null : Number(btn.dataset.edit);
      renderList(results);
    })
  );
  listEl.querySelectorAll("[data-save]").forEach((btn) =>
    btn.addEventListener("click", () => handleSave(Number(btn.dataset.save), results))
  );
  listEl.querySelectorAll("[data-toggle-access]").forEach((btn) =>
    btn.addEventListener("click", () => handleToggleAccess(Number(btn.dataset.toggleAccess), results))
  );
  listEl.querySelectorAll("[data-revoke-account]").forEach((btn) =>
    btn.addEventListener("click", () => handleRevokeAccount(Number(btn.dataset.revokeAccount), results))
  );
  listEl.querySelectorAll("[data-revoke-session]").forEach((btn) =>
    btn.addEventListener("click", () =>
      handleRevokeSession(Number(btn.dataset.revokeSession), Number(btn.dataset.opportunityId), results)
    )
  );
}

function rowHtml(opp) {
  const isEditing = editingId === opp.id;
  return `
    <div class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-title">
          <span class="admin-pill admin-pill-${opp.type}">${opp.type}</span>
          <strong>${escapeHtml(opp.name)}</strong>
          <span class="admin-status admin-status-${opp.status}">${opp.status}</span>
        </div>
        <p class="admin-row-desc">${escapeHtml(opp.description || "")}</p>
      </div>
      <div class="admin-row-actions">
        ${opp.status !== "approved" ? `<button class="admin-btn admin-btn-approve" data-approve="${opp.id}">Approve</button>` : ""}
        ${opp.status !== "rejected" ? `<button class="admin-btn admin-btn-reject" data-reject="${opp.id}">Reject</button>` : ""}
        <button class="admin-btn admin-btn-ghost" data-edit="${opp.id}">${isEditing ? "Cancel" : "Edit"}</button>
        <button class="admin-btn admin-btn-ghost" data-toggle-access="${opp.id}">${accessPanelOpenId === opp.id ? "Hide Access" : "Manage Access"}</button>
      </div>
      ${isEditing ? editFormHtml(opp) : ""}
      ${accessPanelOpenId === opp.id ? accessPanelHtml(opp.id) : ""}
    </div>
  `;
}

function accessPanelHtml(opportunityId) {
  const cached = accessCache[opportunityId];
  if (!cached) {
    return `<div class="admin-access-panel"><p class="admin-loading">Loading access…</p></div>`;
  }
  if (cached.error) {
    return `<div class="admin-access-panel"><div class="admin-error">${escapeHtml(cached.error)}</div></div>`;
  }

  const { access, sessions } = cached;
  const isActive = access && access.status === "active";

  return `
    <div class="admin-access-panel">
      <div class="admin-access-status-row">
        <span class="admin-access-label">Leader account:</span>
        ${
          access
            ? `<span class="admin-status admin-status-${access.status === "active" ? "approved" : "rejected"}">${escapeHtml(access.status)}</span>`
            : `<span class="admin-access-label">no account created</span>`
        }
        ${isActive ? `<button class="admin-btn admin-btn-reject" data-revoke-account="${opportunityId}">Revoke Account</button>` : ""}
      </div>
      <div class="admin-access-sessions">
        <div class="admin-access-label">Active sessions (${sessions.length})</div>
        ${
          sessions.length === 0
            ? `<p class="admin-empty">No active sessions.</p>`
            : sessions
                .map(
                  (s) => `
              <div class="admin-session-row">
                <span>Session #${s.id} &middot; expires ${escapeHtml((s.expiresAt || "").slice(0, 16))}</span>
                <button class="admin-btn admin-btn-reject" data-revoke-session="${s.id}" data-opportunity-id="${opportunityId}">Revoke</button>
              </div>
            `
                )
                .join("")
        }
      </div>
    </div>
  `;
}

async function loadAccessPanel(opportunityId, results) {
  try {
    const data = await AdminAPI.request(`/api/admin/opportunities/${opportunityId}/access`);
    accessCache[opportunityId] = { access: data.access, sessions: data.sessions };
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    accessCache[opportunityId] = { error: err.message || "Failed to load access." };
  }
  renderList(results);
}

function handleToggleAccess(id, results) {
  if (accessPanelOpenId === id) {
    accessPanelOpenId = null;
    renderList(results);
    return;
  }
  accessPanelOpenId = id;
  delete accessCache[id];
  renderList(results);
  loadAccessPanel(id, results);
}

async function handleRevokeAccount(opportunityId, results) {
  if (!window.confirm("Revoke this org's leader account? This immediately ends every active session for this org and cannot be undone from here.")) {
    return;
  }
  try {
    await AdminAPI.request(`/api/admin/opportunities/${opportunityId}/access/revoke`, { method: "POST" });
    await loadAccessPanel(opportunityId, results);
  } catch (err) {
    if (err.message !== "unauthorized" && err.message !== "not_authenticated") showQueueError(err.message);
  }
}

async function handleRevokeSession(sessionId, opportunityId, results) {
  if (!window.confirm("Revoke this session? The org's leader will be signed out on that device immediately.")) {
    return;
  }
  try {
    await AdminAPI.request(`/api/admin/sessions/${sessionId}/revoke`, { method: "POST" });
    await loadAccessPanel(opportunityId, results);
  } catch (err) {
    if (err.message !== "unauthorized" && err.message !== "not_authenticated") showQueueError(err.message);
  }
}

function editFormHtml(opp) {
  return `
    <div class="admin-edit-form">
      <label>Name<input type="text" data-field="name" value="${escapeHtml(opp.name)}" /></label>
      <label>Description<textarea data-field="description">${escapeHtml(opp.description || "")}</textarea></label>
      <label>Link<input type="text" data-field="link" value="${escapeHtml(opp.link || "")}" /></label>
      <div class="admin-edit-actions">
        <button class="admin-btn admin-btn-primary" data-save="${opp.id}">Save & Approve</button>
      </div>
    </div>
  `;
}

async function handleApprove(id) {
  try {
    await AdminAPI.request(`/api/admin/opportunities/${id}/approve`, { method: "POST" });
    await loadQueue();
  } catch (err) {
    if (err.message !== "unauthorized" && err.message !== "not_authenticated") showQueueError(err.message);
  }
}

async function handleReject(id) {
  try {
    await AdminAPI.request(`/api/admin/opportunities/${id}/reject`, { method: "POST" });
    await loadQueue();
  } catch (err) {
    if (err.message !== "unauthorized" && err.message !== "not_authenticated") showQueueError(err.message);
  }
}

async function handleSave(id, results) {
  const row = document.querySelector(`[data-save="${id}"]`).closest(".admin-row");
  const name = row.querySelector('[data-field="name"]').value;
  const description = row.querySelector('[data-field="description"]').value;
  const link = row.querySelector('[data-field="link"]').value;

  try {
    await AdminAPI.request(`/api/admin/opportunities/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, description, link, approve: true }),
    });
    editingId = null;
    await loadQueue();
  } catch (err) {
    if (err.message !== "unauthorized" && err.message !== "not_authenticated") showQueueError(err.message);
  }
}

// ---------------------------------------------------------------------
// Shared "queue item" card renderer — reviews / reports / links / icons /
// suggested edits / access requests all use the same shape (a title row +
// a few label/value pairs + action buttons), just reused across sections
// instead of duplicating layout CSS per section.
// ---------------------------------------------------------------------

function fieldRowHtml(label, value) {
  return `<div class="admin-field-row"><div class="admin-field-row-label">${escapeHtml(label)}</div><div class="admin-field-row-value">${value}</div></div>`;
}

function guidanceBannerHtml(text) {
  return `<div class="admin-guidance">${text}</div>`;
}

// ---------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------

async function renderReviewsSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Reviews</h1></div>
    <div id="reviews-guidance"></div>
    <div class="admin-error" id="reviews-error" hidden></div>
    <div id="reviews-list" class="admin-queue-list"><p class="admin-loading">Loading...</p></div>
  `;
  await loadReviews();
}

async function loadReviews() {
  try {
    const { results, guidance } = await AdminAPI.request("/api/admin/reviews?status=pending");
    document.getElementById("reviews-guidance").innerHTML = guidanceBannerHtml(
      `<strong>Moderation guidance:</strong> ${escapeHtml(guidance || "")}`
    );
    renderReviewsList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    document.getElementById("reviews-error").textContent = err.message;
    document.getElementById("reviews-error").hidden = false;
  }
}

function renderReviewsList(results) {
  const listEl = document.getElementById("reviews-list");
  if (results.length === 0) {
    listEl.innerHTML = `<p class="admin-empty">No pending reviews.</p>`;
    return;
  }
  listEl.innerHTML = results
    .map(
      (r) => `
    <div class="admin-row">
      <div class="admin-row-title">
        <strong>${escapeHtml(r.opportunityName)}</strong>
        <span class="admin-row-desc">(opportunity #${r.opportunityId})</span>
      </div>
      ${fieldRowHtml("Time commitment", escapeHtml(r.timeCommitment))}
      ${fieldRowHtml("Before applying", escapeHtml(r.beforeApplying))}
      ${fieldRowHtml("Advice for a new member", escapeHtml(r.adviceNewMember))}
      <div class="admin-row-actions">
        <button class="admin-btn admin-btn-approve" data-approve-review="${escapeHtml(r.id)}">Approve</button>
        <button class="admin-btn admin-btn-reject" data-reject-review="${escapeHtml(r.id)}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
  listEl.querySelectorAll("[data-approve-review]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/reviews/${btn.dataset.approveReview}/approve`, { method: "POST" });
        loadReviews();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
  listEl.querySelectorAll("[data-reject-review]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/reviews/${btn.dataset.rejectReview}/reject`, { method: "POST" });
        loadReviews();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
}

// ---------------------------------------------------------------------
// Reports / disputes
// ---------------------------------------------------------------------

async function renderReportsSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Reports / Disputes</h1></div>
    ${guidanceBannerHtml(
      "General opportunity reports and review disputes (flagged published reviews) both land here. A review dispute is a request for re-review — go to the Reviews tab, re-check the flagged review against the same guidance, and reject it if warranted; resolving here just closes the report itself."
    )}
    <div class="admin-error" id="reports-error" hidden></div>
    <div id="reports-list" class="admin-queue-list"><p class="admin-loading">Loading...</p></div>
  `;
  await loadReports();
}

async function loadReports() {
  try {
    const { results } = await AdminAPI.request("/api/admin/reports?status=open");
    renderReportsList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    document.getElementById("reports-error").textContent = err.message;
    document.getElementById("reports-error").hidden = false;
  }
}

function renderReportsList(results) {
  const listEl = document.getElementById("reports-list");
  if (results.length === 0) {
    listEl.innerHTML = `<p class="admin-empty">No open reports.</p>`;
    return;
  }
  listEl.innerHTML = results
    .map(
      (r) => `
    <div class="admin-row">
      <div class="admin-row-title">
        <strong>${r.reviewId ? `Review dispute — review ${escapeHtml(r.reviewId.slice(0, 8))}&hellip;` : "Opportunity report"}</strong>
        ${r.opportunityId ? `<span class="admin-row-desc">(opportunity #${r.opportunityId})</span>` : ""}
      </div>
      ${fieldRowHtml("Category", escapeHtml(r.category))}
      ${r.details ? fieldRowHtml("Details", escapeHtml(r.details)) : ""}
      <div class="admin-row-actions">
        <button class="admin-btn admin-btn-primary" data-resolve="${r.id}">Mark resolved</button>
      </div>
    </div>
  `
    )
    .join("");
  listEl.querySelectorAll("[data-resolve]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/reports/${btn.dataset.resolve}/resolve`, { method: "POST" });
        loadReports();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
}

// ---------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------

async function renderLinksSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Links</h1></div>
    ${guidanceBannerHtml(
      "Additional org links (apply-adjacent, homepage, social, other) submitted either standalone or alongside a new org submission. Approve only links that look legitimate and match the organization."
    )}
    <div class="admin-error" id="links-error" hidden></div>
    <div id="links-list" class="admin-queue-list"><p class="admin-loading">Loading...</p></div>
  `;
  await loadLinks();
}

async function loadLinks() {
  try {
    const { results } = await AdminAPI.request("/api/admin/links?status=pending");
    renderLinksList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    document.getElementById("links-error").textContent = err.message;
    document.getElementById("links-error").hidden = false;
  }
}

function renderLinksList(results) {
  const listEl = document.getElementById("links-list");
  if (results.length === 0) {
    listEl.innerHTML = `<p class="admin-empty">No pending links.</p>`;
    return;
  }
  listEl.innerHTML = results
    .map(
      (l) => `
    <div class="admin-row">
      <div class="admin-row-title">
        <strong>${escapeHtml(l.opportunityName)}</strong>
        <span class="admin-row-desc">(opportunity #${l.opportunityId})</span>
      </div>
      ${fieldRowHtml("Type", escapeHtml(l.type))}
      ${fieldRowHtml("Label", escapeHtml(l.label))}
      ${fieldRowHtml("URL", `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a>`)}
      <div class="admin-row-actions">
        <button class="admin-btn admin-btn-approve" data-approve-link="${l.id}">Approve</button>
        <button class="admin-btn admin-btn-reject" data-reject-link="${l.id}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
  listEl.querySelectorAll("[data-approve-link]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/links/${btn.dataset.approveLink}/approve`, { method: "POST" });
        loadLinks();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
  listEl.querySelectorAll("[data-reject-link]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/links/${btn.dataset.rejectLink}/reject`, { method: "POST" });
        loadLinks();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
}

// ---------------------------------------------------------------------
// Pending icons
// ---------------------------------------------------------------------

async function renderIconsSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Pending Icons</h1></div>
    ${guidanceBannerHtml(
      "Compare the current live icon (if any) against the submitted icon before approving. Approve promotes the submitted icon to live; reject discards it without touching the live icon."
    )}
    <div class="admin-error" id="icons-error" hidden></div>
    <div id="icons-list" class="admin-queue-list"><p class="admin-loading">Loading...</p></div>
  `;
  await loadIcons();
}

async function loadIcons() {
  try {
    const { results } = await AdminAPI.request("/api/admin/icons/pending");
    renderIconsList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    document.getElementById("icons-error").textContent = err.message;
    document.getElementById("icons-error").hidden = false;
  }
}

function renderIconsList(results) {
  const listEl = document.getElementById("icons-list");
  if (results.length === 0) {
    listEl.innerHTML = `<p class="admin-empty">No pending icon submissions.</p>`;
    return;
  }
  listEl.innerHTML = results
    .map(
      (o) => `
    <div class="admin-row">
      <div class="admin-row-title"><strong>${escapeHtml(o.name)}</strong><span class="admin-row-desc">(opportunity #${o.id})</span></div>
      <div class="admin-icon-compare">
        <div class="admin-icon-compare-col">
          <div class="admin-icon-compare-label">Current</div>
          <div class="admin-icon-compare-thumb">${o.iconUrl ? `<img src="${escapeHtml(o.iconUrl)}" alt="" onerror="this.parentElement.textContent='broken'" />` : "no icon"}</div>
        </div>
        <div class="admin-icon-compare-arrow">&rarr;</div>
        <div class="admin-icon-compare-col">
          <div class="admin-icon-compare-label">Submitted</div>
          <div class="admin-icon-compare-thumb">${o.iconPendingUrl ? `<img src="${escapeHtml(o.iconPendingUrl)}" alt="" onerror="this.parentElement.textContent='broken'" />` : "no icon"}</div>
        </div>
      </div>
      <div class="admin-row-actions">
        <button class="admin-btn admin-btn-approve" data-approve-icon="${o.id}">Approve</button>
        <button class="admin-btn admin-btn-reject" data-reject-icon="${o.id}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
  listEl.querySelectorAll("[data-approve-icon]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/opportunities/${btn.dataset.approveIcon}/icon/approve`, { method: "POST" });
        loadIcons();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
  listEl.querySelectorAll("[data-reject-icon]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/opportunities/${btn.dataset.rejectIcon}/icon/reject`, { method: "POST" });
        loadIcons();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
}

// ---------------------------------------------------------------------
// Suggested edits
// ---------------------------------------------------------------------

const SUGGEST_EDIT_FIELD_LABELS = { name: "Name", description: "Description", link: "Link", majors: "Majors sought" };

// Simple side-by-side strikethrough-old / highlighted-new display — no real
// diff algorithm, these are short field values, not documents. `majors`
// values are stored/submitted as JSON-serialized arrays; pretty-print them
// as a comma list for readability.
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

async function renderSuggestedEditsSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Suggested Edits</h1></div>
    ${guidanceBannerHtml(
      "Anonymous corrections proposed for a single field on an existing listing. Approving writes the new value directly onto the live listing (and refreshes search); rejecting leaves the listing untouched."
    )}
    <div class="admin-error" id="suggested-edits-error" hidden></div>
    <div id="suggested-edits-list" class="admin-queue-list"><p class="admin-loading">Loading...</p></div>
  `;
  await loadSuggestedEdits();
}

async function loadSuggestedEdits() {
  try {
    const { results } = await AdminAPI.request("/api/admin/suggested-edits?status=pending");
    renderSuggestedEditsList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    document.getElementById("suggested-edits-error").textContent = err.message;
    document.getElementById("suggested-edits-error").hidden = false;
  }
}

function renderSuggestedEditsList(results) {
  const listEl = document.getElementById("suggested-edits-list");
  if (results.length === 0) {
    listEl.innerHTML = `<p class="admin-empty">No pending suggested edits.</p>`;
    return;
  }
  listEl.innerHTML = results
    .map(
      (s) => `
    <div class="admin-row">
      <div class="admin-row-title">
        <span class="admin-pill admin-pill-suggest">${escapeHtml(SUGGEST_EDIT_FIELD_LABELS[s.field] || s.field)}</span>
        <strong>${escapeHtml(s.opportunityName)}</strong>
        <span class="admin-row-desc">(opportunity #${s.opportunityId})</span>
      </div>
      <div class="admin-suggest-diff">
        <div class="admin-suggest-diff-old">${escapeHtml(formatSuggestedValue(s.field, s.oldValue))}</div>
        <div class="admin-suggest-diff-new">${escapeHtml(formatSuggestedValue(s.field, s.newValue))}</div>
      </div>
      ${s.submittedBy ? `<p class="admin-row-desc">Submitted by: ${escapeHtml(s.submittedBy)}</p>` : ""}
      <div class="admin-row-actions">
        <button class="admin-btn admin-btn-approve" data-approve-suggested="${s.id}">Approve</button>
        <button class="admin-btn admin-btn-reject" data-reject-suggested="${s.id}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");
  listEl.querySelectorAll("[data-approve-suggested]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/suggested-edits/${btn.dataset.approveSuggested}/approve`, { method: "POST" });
        loadSuggestedEdits();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
  listEl.querySelectorAll("[data-reject-suggested]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/suggested-edits/${btn.dataset.rejectSuggested}/reject`, { method: "POST" });
        loadSuggestedEdits();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
}

// ---------------------------------------------------------------------
// Access requests — approve/deny + one-time claim-link display (module 4 of 7)
// ---------------------------------------------------------------------

// Freshly-issued claim links, keyed by access_request id (or "resend" for
// the standalone resend-claim-link form) — shown once, per the backend's
// "raw token returned exactly once" contract, then cleared on next full
// section load.
const claimLinks = {};

async function renderAccessRequestsSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Access Requests</h1></div>
    ${guidanceBannerHtml(
      "Club/VIP leader access requests. Approving mints a one-time claim link — copy it and send it to the requester via the contact info shown (no automatic email/SMS delivery exists). Denying just closes the request; the org can file a new one."
    )}
    <div class="admin-error" id="access-requests-error" hidden></div>
    <div class="admin-row" id="resend-claim-box">
      <div class="admin-row-title"><strong>Resend a claim link</strong></div>
      <p class="admin-row-desc">For an org whose first claim link expired unused (no pending request needed). Blocked if the opportunity already has active leader access.</p>
      <div class="admin-claim-link-row">
        <input type="text" id="resend-opportunity-id" placeholder="Opportunity id" class="admin-claim-link-input-id" />
        <button type="button" class="admin-btn admin-btn-primary" id="resend-claim-btn">Generate link</button>
      </div>
      <div id="resend-claim-box-result"></div>
    </div>
    <div id="access-requests-list" class="admin-queue-list"></div>
  `;

  document.getElementById("resend-claim-btn").addEventListener("click", async () => {
    const raw = document.getElementById("resend-opportunity-id").value;
    const opportunityId = Number(raw);
    const errorEl = document.getElementById("access-requests-error");
    if (!Number.isInteger(opportunityId) || opportunityId <= 0) {
      errorEl.textContent = "Enter a valid opportunity id to resend a claim link.";
      errorEl.hidden = false;
      return;
    }
    try {
      errorEl.hidden = true;
      const data = await AdminAPI.request(`/api/admin/opportunities/${opportunityId}/resend-claim-link`, { method: "POST" });
      claimLinks.resend = data;
      document.getElementById("resend-claim-box-result").innerHTML = claimLinkBoxHtml(data, "resend");
      wireClaimLinkCopyButtons(document.getElementById("resend-claim-box-result"));
    } catch (err) {
      if (err.message !== "unauthorized" && err.message !== "not_authenticated") {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }
  });

  await loadAccessRequests();
}

async function loadAccessRequests() {
  try {
    const { results } = await AdminAPI.request("/api/admin/access-requests?status=pending");
    renderAccessRequestsList(results);
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    document.getElementById("access-requests-error").textContent = err.message;
    document.getElementById("access-requests-error").hidden = false;
  }
}

function claimLinkBoxHtml(claimLinkData, keyForCopyBtn) {
  if (!claimLinkData) return "";
  const fullUrl = `${window.location.origin}${claimLinkData.claimLinkPath}`;
  return `
    <div class="admin-claim-link-box">
      <div class="admin-claim-link-box-label">Claim link — copy and send this to the requester now</div>
      <div class="admin-claim-link-row">
        <input type="text" readonly value="${escapeHtml(fullUrl)}" onclick="this.select()" />
        <button type="button" class="admin-btn admin-btn-ghost" data-copy-claim="${escapeHtml(claimLinkData.claimLinkPath)}" data-key="${escapeHtml(keyForCopyBtn)}">Copy</button>
      </div>
      <div class="admin-claim-link-box-note">Expires ${escapeHtml((claimLinkData.expiresAt || "").slice(0, 16))} UTC · single-use · not stored anywhere else — this is the only time it's shown.</div>
    </div>
  `;
}

function wireClaimLinkCopyButtons(root) {
  root.querySelectorAll("[data-copy-claim]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const fullUrl = `${window.location.origin}${btn.dataset.copyClaim}`;
      try {
        await navigator.clipboard.writeText(fullUrl);
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      } catch {
        // Clipboard API can be unavailable (non-HTTPS context, permissions
        // denied, older browser) — the link text is already selectable in
        // the adjacent <input readonly>, so this failure is silent by
        // design; the admin can select-and-copy manually instead.
      }
    })
  );
}

function renderAccessRequestsList(results) {
  const listEl = document.getElementById("access-requests-list");
  if (results.length === 0) {
    listEl.innerHTML = `<p class="admin-empty">No pending access requests.</p>`;
    return;
  }
  listEl.innerHTML = results
    .map((r) => {
      const claimData = claimLinks[r.id];
      const alreadyDecided = r.status !== "pending";
      return `
    <div class="admin-row" data-request-row="${r.id}">
      <div class="admin-row-title">
        <strong>${escapeHtml(r.opportunityName)}</strong>
        <span class="admin-row-desc">(${escapeHtml(r.opportunityType)} · opportunity #${r.opportunityId})</span>
      </div>
      ${fieldRowHtml("Requester", escapeHtml(r.requesterName))}
      ${fieldRowHtml("Contact", escapeHtml(r.requesterContact))}
      ${r.note ? fieldRowHtml("Note", escapeHtml(r.note)) : ""}
      ${
        alreadyDecided
          ? `<p class="admin-row-desc">Status: ${escapeHtml(r.status)}</p>`
          : `<div class="admin-row-actions">
               <button class="admin-btn admin-btn-approve" data-approve-request="${r.id}">Approve</button>
               <button class="admin-btn admin-btn-reject" data-deny-request="${r.id}">Deny</button>
             </div>`
      }
      <div data-claim-link-slot>${claimLinkBoxHtml(claimData, String(r.id))}</div>
    </div>
  `;
    })
    .join("");

  wireClaimLinkCopyButtons(listEl);
  listEl.querySelectorAll("[data-approve-request]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.approveRequest);
      const errorEl = document.getElementById("access-requests-error");
      try {
        errorEl.hidden = true;
        const data = await AdminAPI.request(`/api/admin/access-requests/${id}/approve`, { method: "POST" });
        claimLinks[id] = data;
        // Deliberately does NOT reload the whole list (which would refetch
        // status=pending and make the now-approved row vanish along with
        // the claim link still shown for it) — just patch this one row's
        // action buttons + claim-link slot in place.
        const row = listEl.querySelector(`[data-request-row="${id}"]`);
        if (row) {
          const actions = row.querySelector(".admin-row-actions");
          if (actions) actions.outerHTML = `<p class="admin-row-desc">Status: approved</p>`;
          const slot = row.querySelector("[data-claim-link-slot]");
          if (slot) {
            slot.innerHTML = claimLinkBoxHtml(data, String(id));
            wireClaimLinkCopyButtons(slot);
          }
        }
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        }
      }
    })
  );
  listEl.querySelectorAll("[data-deny-request]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await AdminAPI.request(`/api/admin/access-requests/${btn.dataset.denyRequest}/deny`, { method: "POST" });
        loadAccessRequests();
      } catch (err) {
        if (err.message !== "unauthorized" && err.message !== "not_authenticated") alert(err.message);
      }
    })
  );
}

// ---------------------------------------------------------------------
// Audit log — read-only (module 7 of 7)
// ---------------------------------------------------------------------

async function renderAuditLogSection(sectionRoot) {
  sectionRoot.innerHTML = `
    <div class="admin-main-head"><h1>Audit Log</h1></div>
    ${guidanceBannerHtml(
      "Read-only history of leader-access events (grants, edits, approvals, denials, claim link reissues, revocations). This view never writes to the log."
    )}
    <div class="admin-row">
      <div class="admin-row-title"><strong>Filter by opportunity</strong></div>
      <p class="admin-row-desc">Enter an opportunity id to see only its history, or leave blank and load to see the most recent entries across every org.</p>
      <div class="admin-claim-link-row">
        <input type="text" id="audit-log-opportunity-id" placeholder="Opportunity id (blank = all)" class="admin-claim-link-input-id" />
        <button type="button" class="admin-btn admin-btn-primary" id="audit-log-load-btn">Load</button>
      </div>
    </div>
    <div class="admin-error" id="audit-log-error" hidden></div>
    <div id="audit-log-result"><p class="admin-empty">No entries loaded yet — click Load.</p></div>
  `;

  document.getElementById("audit-log-load-btn").addEventListener("click", () => {
    loadAuditLog(document.getElementById("audit-log-opportunity-id").value);
  });
}

async function loadAuditLog(rawOpportunityId) {
  const trimmed = (rawOpportunityId ?? "").trim();
  const errorEl = document.getElementById("audit-log-error");
  let qs = "";
  if (trimmed.length > 0) {
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errorEl.textContent = "Enter a valid opportunity id, or leave blank for all recent entries.";
      errorEl.hidden = false;
      return;
    }
    qs = `?opportunityId=${parsed}`;
  }
  errorEl.hidden = true;
  const resultEl = document.getElementById("audit-log-result");
  resultEl.innerHTML = `<p class="admin-loading">Loading...</p>`;
  try {
    const { results } = await AdminAPI.request(`/api/admin/audit-log${qs}`);
    if (results.length === 0) {
      resultEl.innerHTML = `<p class="admin-empty">No audit log entries found.</p>`;
      return;
    }
    resultEl.innerHTML = `
      <div class="admin-audit-table-wrap">
        <table class="admin-audit-table">
          <thead>
            <tr>
              <th>Time (UTC)</th><th>Opportunity</th><th>Actor</th><th>Action</th><th>Field</th><th>Old value</th><th>New value</th>
            </tr>
          </thead>
          <tbody>
            ${results
              .map(
                (a) => `
              <tr>
                <td>${escapeHtml((a.createdAt || "").slice(0, 19).replace("T", " "))}</td>
                <td>${escapeHtml(a.opportunityName)} <span class="admin-row-desc">(#${a.opportunityId})</span></td>
                <td>${escapeHtml(a.actor)}</td>
                <td>${escapeHtml(a.action)}</td>
                <td>${escapeHtml(a.fieldChanged ?? "—")}</td>
                <td>${escapeHtml(a.oldValue ?? "—")}</td>
                <td>${escapeHtml(a.newValue ?? "—")}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    if (err.message === "unauthorized" || err.message === "not_authenticated") return;
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    resultEl.innerHTML = "";
  }
}
