// Shared admin auth/API client. Any admin view (review queue, reports,
// reviews moderation, ...) should call AdminAPI.request() instead of raw
// fetch() so the bearer token is always attached and a 401/expired session
// always bounces back to the login screen — no view has to handle auth itself.

const TOKEN_KEY = "gt_admin_token";

const AdminAPI = {
  getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  },

  setToken(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  },

  clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  // POST /api/admin/login is unauthenticated by definition, so it bypasses
  // the token-attaching path below.
  async login(username, password) {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body && body.error === "invalid_credentials"
        ? "Incorrect username or password."
        : "Login failed. Please try again.";
      throw new Error(message);
    }
    this.setToken(body.token);
    return body.token;
  },

  logout() {
    this.clearToken();
    location.hash = "#/login";
  },

  // Wraps fetch for every /api/admin/* call: attaches Authorization,
  // and on 401 clears the stale token and redirects to the login view
  // instead of letting the caller render a broken/empty admin page.
  async request(path, options = {}) {
    const token = this.getToken();
    if (!token) {
      location.hash = "#/login";
      throw new Error("not_authenticated");
    }

    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.status === 401) {
      this.clearToken();
      location.hash = "#/login";
      throw new Error("unauthorized");
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = Array.isArray(body.details) && body.details.length
        ? body.details.join(", ")
        : body.error || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return body;
  },
};
