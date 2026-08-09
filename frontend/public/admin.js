// Minimal admin panel: pending reviews queue + reports/disputes queue +
// pending links queue (additional org links beyond "how to apply") + pending
// icons queue (org profile icon submissions) + suggested edits queue
// (single-field correction proposals against existing listings) + club/VIP
// leader access requests queue (module 4 of 7 of the leader-access
// feature) + a read-only audit log viewer (module 7 of 7). It does not
// attempt to build out opportunity-approval UI (that queue already has a
// working API at GET/POST /api/admin/opportunities/* but no frontend; out
// of scope here), nor the leader edit UI (module 5) or revocation controls
// (module 6, which live in the OTHER admin frontend — frontend/public/admin/
// — see that file's comments; the audit log viewer was added HERE instead
// of there because this panel already has the most other leader-access UI:
// the full Access Requests tab, claim-link issuance/resend, all built
// around the same "opportunity id text input" filter pattern this tab
// reuses) — this panel only reviews/approves/denies access requests, issues
// claim links, and now reads (never writes) the audit log.
const API_BASE = "/api";
const el = (sel, root = document) => root.querySelector(sel);

const state = {
  token: sessionStorage.getItem("gt_admin_token") || null,
  tab: "reviews", // reviews | reports | links | icons | suggestedEdits | accessRequests | auditLog
  reviews: [],
  reports: [],
  links: [],
  icons: [],
  suggestedEdits: [],
  accessRequests: [],
  // Freshly-issued claim links, keyed by access_request id (or "resend" for
  // the standalone resend-claim-link form below) — shown once, per the
  // backend's "raw token returned exactly once" contract, then cleared if
  // the queue reloads.
  claimLinks: {},
  guidance: "",
  loading: false,
  error: "",
  // ---- Audit log viewer (module 7 of 7) ----
  auditLog: [],
  auditLogLoaded: false, // distinguishes "never fetched yet" from "fetched, zero rows"
  auditLogOpportunityId: "", // last-applied filter, shown back in the input
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
    const [reviewsRes, reportsRes, linksRes, iconsRes, suggestedEditsRes, accessRequestsRes] = await Promise.all([
      apiFetch("/admin/reviews?status=pending"),
      apiFetch("/admin/reports?status=open"),
      apiFetch("/admin/links?status=pending"),
      apiFetch("/admin/icons/pending"),
      apiFetch("/admin/suggested-edits?status=pending"),
      apiFetch("/admin/access-requests?status=pending"),
    ]);
    setState({
      reviews: reviewsRes.results,
      guidance: reviewsRes.guidance || "",
      reports: reportsRes.results,
      links: linksRes.results,
      icons: iconsRes.results,
      suggestedEdits: suggestedEditsRes.results,
      accessRequests: accessRequestsRes.results,
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

// ---- Leader access requests (module 4 of 7) ----
// Approve/deny do NOT immediately drop the row from the queue the way the
// other tabs' actions do — approving mints a one-time claim link that has
// to stay visible (with a copy affordance) until the admin has copied it
// out, so `loadQueues()` is deliberately NOT called right after approve
// (it would refetch status=pending and the now-approved row would vanish
// along with the link still shown for it). Deny has no link to show, so it
// does refresh immediately.
async function approveAccessRequest(id) {
  try {
    setState({ error: "" });
    const data = await apiFetch(`/admin/access-requests/${id}/approve`, { method: "POST" });
    setState({
      claimLinks: { ...state.claimLinks, [id]: data },
      accessRequests: state.accessRequests.map((r) => (r.id === id ? { ...r, status: "approved" } : r)),
    });
  } catch (err) {
    setState({ error: err.message });
  }
}

async function denyAccessRequest(id) {
  try {
    await apiFetch(`/admin/access-requests/${id}/deny`, { method: "POST" });
    loadQueues();
  } catch (err) {
    setState({ error: err.message });
  }
}

// `rawOpportunityId` is read directly from the input at click time (not
// tracked reactively in `state`) — every setState() call replaces
// #app.innerHTML wholesale, which would blow away focus/cursor position on
// every keystroke if this field re-rendered from state on each `input`
// event.
async function resendClaimLink(rawOpportunityId) {
  const opportunityId = Number(rawOpportunityId);
  if (!Number.isInteger(opportunityId) || opportunityId <= 0) {
    setState({ error: "Enter a valid opportunity id to resend a claim link." });
    return;
  }
  try {
    setState({ error: "" });
    const data = await apiFetch(`/admin/opportunities/${opportunityId}/resend-claim-link`, { method: "POST" });
    setState({ claimLinks: { ...state.claimLinks, resend: data } });
  } catch (err) {
    setState({ error: err.message });
  }
}

// ---- Audit log viewer (module 7 of 7) ----
// Read-only view over GET /api/admin/audit-log. `rawOpportunityId` is read
// directly from the input at call time (same reasoning as
// resendClaimLink() above: state-driven re-render on every keystroke would
// blow away cursor position). Empty/blank input means "all recent entries
// across all orgs" — the backend's no-opportunityId mode, capped server-side
// at its own limit (see admin.ts).
async function loadAuditLog(rawOpportunityId) {
  const trimmed = (rawOpportunityId ?? "").trim();
  let qs = "";
  if (trimmed.length > 0) {
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setState({ error: "Enter a valid opportunity id, or leave blank for all recent entries." });
      return;
    }
    qs = `?opportunityId=${parsed}`;
  }
  try {
    setState({ loading: true, error: "" });
    const data = await apiFetch(`/admin/audit-log${qs}`);
    setState({
      auditLog: data.results,
      auditLogLoaded: true,
      auditLogOpportunityId: trimmed,
      loading: false,
    });
  } catch (err) {
    setState({ loading: false, error: err.message });
  }
}

async function copyClaimLink(rawPath, buttonEl) {
  const fullUrl = `${window.location.origin}${rawPath}`;
  try {
    await navigator.clipboard.writeText(fullUrl);
    if (buttonEl) {
      const original = buttonEl.textContent;
      buttonEl.textContent = "Copied!";
      setTimeout(() => {
        buttonEl.textContent = original;
      }, 1500);
    }
  } catch {
    // Clipboard API can be unavailable (non-HTTPS context, permissions
    // denied, older browser) — the link text is already selectable in the
    // adjacent <input readonly>, so this failure is silent by design; the
    // admin can select-and-copy manually instead.
  }
}

function renderClaimLinkBox(claimLinkData, keyForCopyBtn) {
  if (!claimLinkData) return "";
  const fullUrl = `${window.location.origin}${claimLinkData.claimLinkPath}`;
  return `
    <div class="claim-link-box">
      <div class="claim-link-box-label">Claim link — copy and send this to the requester now</div>
      <div class="claim-link-box-row">
        <input type="text" readonly value="${escapeHtml(fullUrl)}" onclick="this.select()" />
        <button type="button" class="admin-btn secondary" data-action="copy-claim-link" data-path="${escapeHtml(claimLinkData.claimLinkPath)}" data-key="${escapeHtml(keyForCopyBtn)}">Copy</button>
      </div>
      <div class="claim-link-box-note">Expires ${escapeHtml((claimLinkData.expiresAt || "").slice(0, 16))} UTC · single-use · not stored anywhere else — this is the only time it's shown.</div>
    </div>
  `;
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

function renderAccessRequestsTab() {
  const resendBox = `
    <div class="admin-queue-item">
      <div class="admin-queue-item-title">Resend a claim link</div>
      <div class="admin-queue-item-meta" style="margin:6px 0 10px;">
        For an org whose first claim link expired unused (no pending request needed). Blocked if the
        opportunity already has active leader access — see backend guard.
      </div>
      <div class="claim-link-box-row">
        <input type="text" id="resendOpportunityId" placeholder="Opportunity id"
          style="max-width:160px;font-family:monospace;padding:8px 10px;border-radius:6px;border:1.5px solid var(--pi-mile);" />
        <button type="button" class="admin-btn secondary" data-action="resend-claim-link">Generate link</button>
      </div>
      ${renderClaimLinkBox(state.claimLinks.resend, "resend")}
    </div>
  `;

  if (state.accessRequests.length === 0) {
    return `${resendBox}<div class="review-empty">No pending access requests.</div>`;
  }

  const rows = state.accessRequests
    .map((r) => {
      const claimData = state.claimLinks[r.id];
      const alreadyDecided = r.status !== "pending";
      return `
    <div class="admin-queue-item">
      <div class="admin-queue-item-head">
        <div class="admin-queue-item-title">${escapeHtml(r.opportunityName)} <span class="admin-queue-item-meta">(${escapeHtml(r.opportunityType)} · opportunity #${r.opportunityId})</span></div>
        <div class="admin-queue-item-meta">${escapeHtml((r.createdAt || "").slice(0, 16))}</div>
      </div>
      <div class="review-card-row"><div class="review-card-q">Requester</div><div class="review-card-a">${escapeHtml(r.requesterName)}</div></div>
      <div class="review-card-row"><div class="review-card-q">Contact</div><div class="review-card-a">${escapeHtml(r.requesterContact)}</div></div>
      ${r.note ? `<div class="review-card-row"><div class="review-card-q">Note</div><div class="review-card-a">${escapeHtml(r.note)}</div></div>` : ""}
      ${
        alreadyDecided
          ? `<div class="admin-queue-item-meta" style="margin-top:10px;">Status: ${escapeHtml(r.status)}</div>`
          : `<div class="admin-queue-actions">
               <button class="admin-btn approve" data-action="approve-access-request" data-id="${r.id}">Approve</button>
               <button class="admin-btn deny" data-action="deny-access-request" data-id="${r.id}">Deny</button>
             </div>`
      }
      ${renderClaimLinkBox(claimData, String(r.id))}
    </div>
  `;
    })
    .join("");

  return resendBox + rows;
}

function renderAuditLogTab() {
  const filterBox = `
    <div class="admin-queue-item">
      <div class="admin-queue-item-title">Filter by opportunity</div>
      <div class="admin-queue-item-meta" style="margin:6px 0 10px;">
        Enter an opportunity id to see only its history, or leave blank and load to see the most recent
        entries across every org.
      </div>
      <div class="claim-link-box-row">
        <input type="text" id="auditLogOpportunityId" placeholder="Opportunity id (blank = all)"
          value="${escapeHtml(state.auditLogOpportunityId)}"
          style="max-width:220px;font-family:monospace;padding:8px 10px;border-radius:6px;border:1.5px solid var(--pi-mile);" />
        <button type="button" class="admin-btn secondary" data-action="load-audit-log">Load</button>
      </div>
    </div>
  `;

  if (!state.auditLogLoaded) {
    return `${filterBox}<div class="review-empty">No entries loaded yet — click Load.</div>`;
  }
  if (state.auditLog.length === 0) {
    return `${filterBox}<div class="review-empty">No audit log entries found.</div>`;
  }

  const rows = state.auditLog
    .map(
      (a) => `
    <tr>
      <td>${escapeHtml((a.createdAt || "").slice(0, 19).replace("T", " "))}</td>
      <td>${escapeHtml(a.opportunityName)} <span class="admin-queue-item-meta">(#${a.opportunityId})</span></td>
      <td>${escapeHtml(a.actor)}</td>
      <td>${escapeHtml(a.action)}</td>
      <td>${escapeHtml(a.fieldChanged ?? "—")}</td>
      <td>${escapeHtml(a.oldValue ?? "—")}</td>
      <td>${escapeHtml(a.newValue ?? "—")}</td>
    </tr>
  `
    )
    .join("");

  return `
    ${filterBox}
    <div style="overflow-x:auto;">
      <table class="admin-audit-log-table" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;border-bottom:1.5px solid var(--pi-mile);">
            <th style="padding:6px 8px;">Time (UTC)</th>
            <th style="padding:6px 8px;">Opportunity</th>
            <th style="padding:6px 8px;">Actor</th>
            <th style="padding:6px 8px;">Action</th>
            <th style="padding:6px 8px;">Field</th>
            <th style="padding:6px 8px;">Old value</th>
            <th style="padding:6px 8px;">New value</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
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
        <button class="${state.tab === "accessRequests" ? "active" : ""}" data-action="tab-access-requests">Access Requests (${state.accessRequests.length})</button>
        <button class="${state.tab === "auditLog" ? "active" : ""}" data-action="tab-audit-log">Audit Log</button>
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
          : state.tab === "accessRequests"
          ? `<div class="admin-guidance">Club/VIP leader access requests. Approving mints a one-time claim link — copy it and send it to the requester via the contact info shown (no automatic email/SMS delivery exists). Denying just closes the request; the org can file a new one.</div>`
          : state.tab === "auditLog"
          ? `<div class="admin-guidance">Read-only history of leader-access events (grants, edits, approvals, denials, claim link reissues, revocations) written by the other tabs and the leader-facing edit UI. This view never writes to the log.</div>`
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
          : state.tab === "accessRequests"
          ? renderAccessRequestsTab()
          : state.tab === "auditLog"
          ? renderAuditLogTab()
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
      case "tab-access-requests":
        setState({ tab: "accessRequests" });
        break;
      case "approve-access-request":
        approveAccessRequest(Number(node.dataset.id));
        break;
      case "deny-access-request":
        denyAccessRequest(Number(node.dataset.id));
        break;
      case "resend-claim-link": {
        const input = el("#resendOpportunityId");
        resendClaimLink(input ? input.value : "");
        break;
      }
      case "copy-claim-link":
        copyClaimLink(node.dataset.path, node);
        break;
      case "tab-audit-log":
        setState({ tab: "auditLog" });
        break;
      case "load-audit-log": {
        const input = el("#auditLogOpportunityId");
        loadAuditLog(input ? input.value : "");
        break;
      }
    }
  });
}

render();
if (state.token) loadQueues();
