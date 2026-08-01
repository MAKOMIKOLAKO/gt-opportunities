// Tiny static file server + same-origin API proxy for the frontend.
//
// Why a proxy at all: the backend (backend/src/index.ts) does not send
// CORS headers, and this is a separate workspace (frontend/) — out of
// scope to edit backend/. Serving the static files AND proxying certain
// paths to the backend from the same origin/port means the browser never
// sees a cross-origin request, so app.js can just call fetch("/api/...").
//
// Beyond /api, this also proxies the server-rendered SEO routes
// (backend/src/routes/seo.ts: /opportunities/:slug, /categories/:type,
// /sitemap.xml, /robots.txt) so they resolve to real, crawlable HTML in
// every hosting configuration — not just the Vercel one, where vercel.json
// rewrites those same paths to the API function directly. Two-service
// Railway deploys (this frontend service + a separate backend service) need
// this proxy for those paths to work at all.
//
// Usage: BACKEND_URL=http://localhost:35500 PORT=8080 node server.js
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";
const backend = new URL(BACKEND_URL);

const app = express();

app.use(express.static(path.join(__dirname, "public")));

function proxyTo(backendPathPrefix) {
  return (req, res) => {
    const proxyReq = http.request(
      {
        hostname: backend.hostname,
        port: backend.port,
        path: backendPathPrefix + req.url,
        method: req.method,
        // Deliberately keep the ORIGINAL client-facing Host header (not
        // backend.host) rather than the previous /api-only proxy's
        // behavior — routes/seo.ts derives canonical/OG absolute URLs from
        // req.get("host") on the backend, so overwriting it here would bake
        // the backend's internal host into every canonical/OG tag instead
        // of the public one.
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "backend_unreachable", details: [String(err.message)] }));
    });
    req.pipe(proxyReq);
  };
}

app.use("/api", proxyTo("/api"));
// These are mounted at the Express app's root on the backend (see
// backend/src/app.ts), so the proxied path prefix is empty — req.url
// already includes the leading "/opportunities/..." etc.
app.use("/opportunities", proxyTo("/opportunities"));
app.use("/categories", proxyTo("/categories"));
app.get("/sitemap.xml", proxyTo(""));
app.get("/robots.txt", proxyTo(""));

app.listen(PORT, () => {
  console.log(`frontend listening on :${PORT} (proxying /api, /opportunities, /categories, /sitemap.xml, /robots.txt -> ${BACKEND_URL})`);
});
