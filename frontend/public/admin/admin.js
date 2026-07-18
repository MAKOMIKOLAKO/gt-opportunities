// Admin SPA: login gate + review queue. Hash-routed (#/login, #/queue) so
// the URL reflects state without needing server-side routes.

const root = document.getElementById("admin-app");

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (!AdminAPI.isLoggedIn()) {
    if (hash !== "login") location.hash = "#/login";
    renderLogin();
    return;
  }
  if (hash === "login" || hash === "") {
    location.hash = "#/queue";
    return;
  }
  renderQueue();
}

window.addEventListener("hashchange", route);
document.addEventListener("DOMContentLoaded", route);

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
      location.hash = "#/queue";
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
// Review queue view
// ---------------------------------------------------------------------

let currentStatus = "pending";
let editingId = null;

async function renderQueue() {
  root.innerHTML = `
    <div class="admin-shell">
      <header class="admin-topbar">
        <div class="admin-brand">Georgia Tech <span>Admin</span></div>
        <button class="admin-btn admin-btn-ghost" id="logout-btn">Log Out</button>
      </header>
      <main class="admin-main">
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
      </main>
    </div>
  `;

  document.getElementById("logout-btn").addEventListener("click", () => AdminAPI.logout());
  document.getElementById("status-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    currentStatus = btn.dataset.status;
    renderQueue();
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
      </div>
      ${isEditing ? editFormHtml(opp) : ""}
    </div>
  `;
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
  const opp = results.find((r) => r.id === id);
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

function showQueueError(message) {
  const errorEl = document.getElementById("queue-error");
  errorEl.textContent = message || "Something went wrong.";
  errorEl.hidden = false;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
