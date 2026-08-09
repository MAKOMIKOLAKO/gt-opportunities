// Leader self-service edit page (module 5 of 7). Served two ways: the
// legacy static /leader-edit.html, and /org/:slug/manage (the SSR wrapper
// in backend/src/routes/seo.ts) — both load this exact same script.
//
// Two ways in:
//   1. Already has a `leader_session` httpOnly cookie (issued by a previous
//      POST /api/leader/verify) — straight to loadOpportunity().
//   2. Landed here via a claim/login link an admin hand-delivered (see
//      routes/admin.ts's claim-link box — no outbound email/SMS infra in
//      this repo), which points at this exact page with `?token=...`
//      appended — consumeUrlTokenThenLoad() below POSTs it to
//      /api/leader/verify to set that session cookie before anything else
//      runs, then strips it from the URL bar so a reload/bookmark doesn't
//      replay a single-use token.
//
// No admin-style login form lives here. If loadOpportunity() 401s (no/
// expired session and no valid ?token=), this page falls back to a minimal
// "request a new login link" form that posts to /api/leader/login-request.
const API_BASE = "/api";
const el = (sel, root = document) => root.querySelector(sel);

const state = {
  loading: true,
  sessionExpired: false,
  error: "",
  saving: false,
  saveMessage: "",
  opportunity: null, // { id, name, description, link, iconUrl, tagSlugs, links }
  loginRequestStatus: "", // "", "sending", "sent", "recovered"
  loginRequestError: "",
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
function escapeAttr(str) {
  return escapeHtml(str);
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// ---- Load ----
async function loadOpportunity() {
  setState({ loading: true, error: "" });
  const { res, data } = await apiFetch("/leader/opportunity");
  if (res.status === 401) {
    setState({ loading: false, sessionExpired: true, opportunity: null });
    return;
  }
  if (!res.ok) {
    setState({ loading: false, error: (data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}` });
    return;
  }
  setState({ loading: false, sessionExpired: false, error: "", opportunity: data.result });
}

// ---- Save ----
function linkRowHtml(link) {
  const label = link ? escapeAttr(link.label) : "";
  const url = link ? escapeAttr(link.url) : "";
  const type = link ? link.type : "other";
  return `
    <div class="link-row">
      <input type="text" class="link-row-label" placeholder="Label (e.g. Apply Now)" maxlength="200" aria-label="Link label" autocomplete="off" value="${label}" />
      <input type="url" class="link-row-url" placeholder="https://..." maxlength="500" aria-label="Link URL" inputmode="url" autocomplete="off" value="${url}" />
      <select class="link-row-type" aria-label="Link type">
        <option value="apply" ${type === "apply" ? "selected" : ""}>Apply</option>
        <option value="homepage" ${type === "homepage" ? "selected" : ""}>Homepage</option>
        <option value="social" ${type === "social" ? "selected" : ""}>Social</option>
        <option value="other" ${type === "other" ? "selected" : ""}>Other</option>
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

async function handleSave(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  setState({ saving: true, saveMessage: "", error: "" });

  const description = form.querySelector("#editDescription").value.trim();
  const link = form.querySelector("#editLink").value.trim();
  const iconUrl = form.querySelector("#editIconUrl").value.trim();
  const tagSlugs = form
    .querySelector("#editTags")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const links = collectLinkRows(form);

  const { res, data } = await apiFetch("/leader/opportunity", {
    method: "PUT",
    body: JSON.stringify({
      description,
      link: link || null,
      iconUrl: iconUrl || null,
      tagSlugs,
      links,
    }),
  });

  if (res.status === 401) {
    setState({ saving: false, sessionExpired: true, opportunity: null });
    return;
  }
  if (!res.ok) {
    setState({
      saving: false,
      error: (data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}`,
    });
    btn.disabled = false;
    return;
  }
  setState({ saving: false, saveMessage: "Saved — your changes are live.", opportunity: data.result, error: "" });
}

// ---- Session-expired recovery ----
async function handleLoginRequest(e) {
  e.preventDefault();
  const form = e.target;
  const opportunityId = Number(form.querySelector("#recoverOrgId").value);
  const contact = form.querySelector("#recoverContact").value.trim();
  if (!Number.isInteger(opportunityId) || !contact) {
    setState({ loginRequestError: "Organization ID and contact are both required." });
    return;
  }

  setState({ loginRequestStatus: "sending", loginRequestError: "" });
  const { res, data } = await apiFetch("/leader/login-request", {
    method: "POST",
    body: JSON.stringify({ opportunityId, contact }),
  });

  if (!res.ok) {
    setState({ loginRequestStatus: "", loginRequestError: (data.details && data.details.join("; ")) || data.error || `HTTP ${res.status}` });
    return;
  }

  if (data.result && data.result.status === "issued" && data.result.token) {
    // No outbound email/SMS exists in this repo yet (see leader.ts) — the
    // token is returned directly. Consume it immediately in place of
    // "click the link in your email".
    const verifyRes = await apiFetch("/leader/verify", { method: "POST", body: JSON.stringify({ token: data.result.token }) });
    if (verifyRes.res.ok) {
      setState({ loginRequestStatus: "recovered", loginRequestError: "" });
      loadOpportunity();
      return;
    }
    setState({ loginRequestStatus: "", loginRequestError: "That login link could not be verified. Please try again." });
    return;
  }

  // Generic response — matches were intentionally not distinguishable
  // (see login-request's GENERIC_RESULT / no-enumeration behavior).
  setState({ loginRequestStatus: "sent", loginRequestError: "" });
}

// ---- Render ----
function renderLoading() {
  return `<main class="view-submit"><p>Loading your listing&hellip;</p></main>`;
}

function renderSessionExpired() {
  const statusNote =
    state.loginRequestStatus === "sent"
      ? `<div class="submit-callout">If that organization ID and contact match our records, a fresh login link was issued. Since this environment has no outbound email yet, an admin/developer can retrieve it from the API response directly.</div>`
      : "";
  return `
    <main class="view-submit">
      <div class="dir-heading">
        <h1>Session expired</h1>
        <p>Your login link has expired or this session is no longer valid. Request a new login link below.</p>
      </div>
      <form id="recoverForm" class="submit-form">
        <div>
          <label for="recoverOrgId">Organization ID *</label>
          <input id="recoverOrgId" type="number" min="1" required placeholder="e.g. 42" autocomplete="off" />
        </div>
        <div>
          <label for="recoverContact">Contact on file (email or phone) *</label>
          <input id="recoverContact" type="text" required placeholder="you@gatech.edu" autocomplete="email" />
        </div>
        ${state.loginRequestError ? `<div class="form-error">${escapeHtml(state.loginRequestError)}</div>` : ""}
        ${statusNote}
        <button type="submit" class="submit-btn" ${state.loginRequestStatus === "sending" ? "disabled" : ""}>
          ${state.loginRequestStatus === "sending" ? "Requesting&hellip;" : "Request new login link"}
        </button>
      </form>
    </main>
  `;
}

function renderForm() {
  const o = state.opportunity;
  const links = (o.links || []).map(linkRowHtml).join("");
  return `
    <main class="view-submit">
      <div class="dir-heading">
        <h1>Manage your listing</h1>
        <p>${escapeHtml(o.name)} &mdash; edits here go live immediately.</p>
      </div>
      <form id="editForm" class="submit-form">
        <div>
          <label for="editDescription">Description *</label>
          <textarea id="editDescription" rows="5" maxlength="4000" required>${escapeHtml(o.description)}</textarea>
        </div>
        <div>
          <label for="editTags">Tags <span class="submit-links-hint">(comma separated tag slugs)</span></label>
          <input id="editTags" type="text" placeholder="e.g. robotics, python" autocomplete="off" value="${escapeAttr((o.tagSlugs || []).join(", "))}" />
        </div>
        <div>
          <label for="editLink">How to apply <span class="submit-links-hint">(primary application link)</span></label>
          <input id="editLink" type="url" placeholder="https://..." autocomplete="off" value="${escapeAttr(o.link || "")}" />
        </div>
        <div>
          <label for="editIconUrl">Icon URL</label>
          <input id="editIconUrl" type="url" placeholder="https://..." autocomplete="off" value="${escapeAttr(o.iconUrl || "")}" />
        </div>
        <div class="submit-links-block">
          <div class="submit-links-head">
            <label>Additional links <span class="submit-links-hint">(homepage, socials, apply-adjacent, etc.)</span></label>
            <button type="button" class="add-link-row-btn" data-action="add-link-row">+ Add a link</button>
          </div>
          <div id="linkRows">${links}</div>
        </div>
        ${state.error ? `<div class="form-error">${escapeHtml(state.error)}</div>` : ""}
        ${state.saveMessage ? `<div class="utility-feedback">${escapeHtml(state.saveMessage)}</div>` : ""}
        <button type="submit" class="submit-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving&hellip;" : "Save changes"}</button>
      </form>
    </main>
  `;
}

function render() {
  const app = el("#app");
  if (state.loading) {
    app.innerHTML = renderLoading();
    return;
  }
  if (state.sessionExpired) {
    app.innerHTML = renderSessionExpired();
    const form = el("#recoverForm");
    if (form) form.addEventListener("submit", handleLoginRequest);
    return;
  }
  if (!state.opportunity) {
    app.innerHTML = `<main class="view-submit"><div class="form-error">${escapeHtml(state.error || "Unable to load your listing.")}</div></main>`;
    return;
  }
  app.innerHTML = renderForm();
  const form = el("#editForm");
  form.addEventListener("submit", handleSave);
  form.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "add-link-row") {
      el("#linkRows").insertAdjacentHTML("beforeend", linkRowHtml(null));
    } else if (btn.dataset.action === "remove-link-row") {
      btn.closest(".link-row").remove();
    }
  });
}

// ---- Boot: consume a ?token= from an emailed claim/login link, if present ----
async function consumeUrlTokenThenLoad() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    const { res } = await apiFetch("/leader/verify", { method: "POST", body: JSON.stringify({ token }) });
    // Strip the token from the URL either way — single-use, so leaving it
    // there would replay a dead token on every reload/bookmark and is one
    // more copy of a credential sitting around in browser history for no
    // reason.
    params.delete("token");
    const clean = window.location.pathname + (params.toString() ? `?${params}` : "");
    window.history.replaceState({}, "", clean);
    if (!res.ok) {
      // Invalid/expired/already-used token: fall through to the normal
      // session check below, which will 401 and show the recovery form.
      console.warn("[leader-edit] claim/login link could not be verified:", res.status);
    }
  }
  loadOpportunity();
}

consumeUrlTokenThenLoad();
