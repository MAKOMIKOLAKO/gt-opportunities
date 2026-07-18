// LOCAL DEV CONVENIENCE ONLY — not part of the deployed app. Production is a
// single Vercel project (see root vercel.json + DEPLOY.md): Vercel serves
// frontend/public as static output and routes /api/* to the serverless
// functions under /api directly, so this proxy server has no production
// role. Prefer `npx vercel dev` from the repo root for local dev that
// matches production routing; this file remains only for quickly serving
// the static frontend against a backend you're running some other way.
//
// Tiny static file server + same-origin API proxy for the frontend.
//
// Why a proxy at all: a bare `/api` Vercel function does not send CORS
// headers by default, and this is a separate workspace (frontend/).
// Serving the static files AND proxying /api/* to the backend from the
// same origin/port means the browser never sees a cross-origin request, so
// app.js can just call fetch("/api/...").
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

app.use("/api", (req, res) => {
  const proxyReq = http.request(
    {
      hostname: backend.hostname,
      port: backend.port,
      path: "/api" + req.url,
      method: req.method,
      headers: { ...req.headers, host: backend.host },
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
});

app.listen(PORT, () => {
  console.log(`frontend listening on :${PORT} (proxying /api -> ${BACKEND_URL})`);
});
