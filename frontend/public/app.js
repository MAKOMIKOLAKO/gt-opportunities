// GT Campus Opportunity Finder — frontend logic.
// Everything rendered on this page comes from live fetch() calls against
// the backend API (see API-CONTRACT.md). No local seed/demo data arrays.

const API_BASE = "/api"; // same-origin; frontend/server.js proxies this to the backend

const state = {
  type: "",
  search: "",
  tags: new Set(),
  allTags: [], // [{id,slug,label,category}] from GET /api/tags
};

let searchDebounce = null;

const el = (sel) => document.querySelector(sel);

function buildQuery() {
  const params = new URLSearchParams();
  if (state.type) params.set("type", state.type);
  if (state.search.trim()) params.set("search", state.search.trim());
  if (state.tags.size) params.set("tags", Array.from(state.tags).join(","));
  return params.toString();
}

async function fetchOpportunities() {
  const grid = el("#grid");
  grid.innerHTML = '<div class="mono loading-msg">loading opportunities...</div>';
  try {
    const qs = buildQuery();
    const res = await fetch(`${API_BASE}/opportunities${qs ? "?" + qs : ""}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // { results: [...], count }
    renderGrid(data.results);
    el("#resultCount").textContent = `${data.count} result${data.count === 1 ? "" : "s"}`;
  } catch (err) {
    grid.innerHTML = `<div class="mono error-msg">Failed to load opportunities: ${escapeHtml(err.message)}</div>`;
    el("#resultCount").textContent = "-- results";
  }
}

function renderGrid(results) {
  const grid = el("#grid");
  grid.innerHTML = "";
  if (!results || results.length === 0) {
    grid.innerHTML = '<div class="mono empty-msg">No opportunities match these filters.</div>';
    return;
  }
  for (const opp of results) {
    grid.appendChild(renderCard(opp));
  }
}

function renderCard(opp) {
  const card = document.createElement("article");
  card.className = "opp-card card-tick";
  card.tabIndex = 0;

  const tagsHtml = (opp.tags || [])
    .map((t) => `<span class="card-tag">${escapeHtml(t.label)}</span>`)
    .join("");

  const majorsHtml = (opp.majors && opp.majors.length)
    ? `<div class="card-majors">majors: ${opp.majors.map(escapeHtml).join(", ")}</div>`
    : "";

  card.innerHTML = `
    <div class="tick-bl"></div><div class="tick-br"></div>
    <div class="card-top">
      <span class="type-badge ${escapeHtml(opp.type)}">${escapeHtml(opp.type)}</span>
      <span class="card-id">#${opp.id}</span>
    </div>
    <h3>${escapeHtml(opp.name)}</h3>
    <p class="opp-desc">${escapeHtml(opp.description || "")}</p>
    <div class="card-tags">${tagsHtml}</div>
    ${majorsHtml}
  `;
  card.addEventListener("click", () => openDetail(opp.id));
  card.addEventListener("keypress", (e) => { if (e.key === "Enter") openDetail(opp.id); });
  return card;
}

async function openDetail(id) {
  const modal = el("#detailModal");
  const content = el("#detailContent");
  content.innerHTML = '<div class="mono loading-msg">loading...</div>';
  modal.classList.remove("hidden");
  try {
    const res = await fetch(`${API_BASE}/opportunities/${id}`);
    if (!res.ok) throw new Error(res.status === 404 ? "not found" : `HTTP ${res.status}`);
    const data = await res.json();
    const opp = data.result;
    const tagsHtml = (opp.tags || []).map((t) => `<span class="card-tag">${escapeHtml(t.label)}</span>`).join("");
    content.innerHTML = `
      <div class="detail-header">
        <h2>${escapeHtml(opp.name)}</h2>
        <span class="type-badge ${escapeHtml(opp.type)}">${escapeHtml(opp.type)}</span>
      </div>
      <div class="detail-meta">
        #${opp.id} &middot; source: ${escapeHtml(opp.source)} &middot; last verified: ${escapeHtml(opp.lastVerified || "unknown")}
        ${opp.majors && opp.majors.length ? " &middot; majors: " + opp.majors.map(escapeHtml).join(", ") : ""}
      </div>
      <div class="card-tags" style="margin-bottom:16px">${tagsHtml}</div>
      <p class="detail-desc">${escapeHtml(opp.description || "")}</p>
      ${opp.link ? `<div class="detail-link"><a href="${escapeHtml(opp.link)}" target="_blank" rel="noopener">${escapeHtml(opp.link)}</a></div>` : ""}
    `;
  } catch (err) {
    content.innerHTML = `<div class="mono error-msg">Could not load this opportunity: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadTags() {
  const container = el("#tagFilters");
  try {
    const res = await fetch(`${API_BASE}/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.allTags = data.results || [];
    renderTagFilters();
    renderSubmitTagChips();
  } catch (err) {
    container.innerHTML = `<div class="mono error-msg">Could not load tags: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTagFilters() {
  const container = el("#tagFilters");
  container.innerHTML = "";
  const byCategory = groupByCategory(state.allTags);
  for (const [category, tags] of Object.entries(byCategory)) {
    const group = document.createElement("div");
    group.className = "tag-group";
    group.innerHTML = `<span class="tag-group-label mono">${escapeHtml(category)}:</span>`;
    for (const tag of tags) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = tag.label;
      chip.dataset.slug = tag.slug;
      chip.addEventListener("click", () => toggleTag(tag.slug, chip));
      group.appendChild(chip);
    }
    container.appendChild(group);
  }
}

function groupByCategory(tags) {
  const out = {};
  for (const t of tags) {
    if (!out[t.category]) out[t.category] = [];
    out[t.category].push(t);
  }
  return out;
}

function toggleTag(slug, chipEl) {
  if (state.tags.has(slug)) {
    state.tags.delete(slug);
    chipEl.classList.remove("selected");
  } else {
    state.tags.add(slug);
    chipEl.classList.add("selected");
  }
  fetchOpportunities();
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// --- controls wiring ---
el("#searchInput").addEventListener("input", (e) => {
  state.search = e.target.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(fetchOpportunities, 300);
});

el("#typeTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll("#typeTabs .tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  state.type = btn.dataset.type;
  fetchOpportunities();
});

// --- modals ---
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModals());
});
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModals();
  });
});
function closeModals() {
  el("#detailModal").classList.add("hidden");
  el("#submitModal").classList.add("hidden");
}

el("#openSubmitBtn").addEventListener("click", () => {
  el("#submitModal").classList.remove("hidden");
});

// --- submission form ---
const selectedSubmitTags = new Set();

function renderSubmitTagChips() {
  const container = el("#submitTagChips");
  container.innerHTML = "";
  for (const tag of state.allTags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = tag.label;
    chip.dataset.slug = tag.slug;
    chip.addEventListener("click", () => {
      if (selectedSubmitTags.has(tag.slug)) {
        selectedSubmitTags.delete(tag.slug);
        chip.classList.remove("selected");
      } else {
        selectedSubmitTags.add(tag.slug);
        chip.classList.add("selected");
      }
    });
    container.appendChild(chip);
  }
}

el("#submitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const statusEl = el("#formStatus");
  statusEl.textContent = "submitting...";
  statusEl.className = "form-status mono";

  const majorsRaw = form.majors.value.trim();
  const body = {
    type: form.type.value,
    name: form.name.value.trim(),
    description: form.description.value.trim(),
    majors: majorsRaw ? majorsRaw.split(",").map((m) => m.trim()).filter(Boolean) : [],
    link: form.link.value.trim() || undefined,
    tagSlugs: Array.from(selectedSubmitTags),
    submittedBy: form.submittedBy.value.trim() || undefined,
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
    statusEl.textContent = `Submitted! Pending review (id #${data.result.id}).`;
    statusEl.className = "form-status mono success";
    form.reset();
    selectedSubmitTags.clear();
    document.querySelectorAll("#submitTagChips .chip").forEach((c) => c.classList.remove("selected"));
    setTimeout(() => { closeModals(); statusEl.textContent = ""; }, 1800);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = "form-status mono error";
  }
});

// --- init ---
loadTags();
fetchOpportunities();
