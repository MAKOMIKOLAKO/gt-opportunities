// The Express app itself, with no `listen()` call — shared by:
//   - src/index.ts (local dev / any long-running host, e.g. Railway): calls
//     app.listen(port).
//   - /api/index.ts at the repo root (Vercel serverless function): wraps
//     this same app with serverless-http instead of listening on a port.
// Keeping route wiring in one place means neither entry point can drift
// from the other.
// express-async-errors patches Router methods so a rejected promise inside
// an async handler is forwarded to Express's error middleware instead of
// being silently dropped — Express 4 does not do this on its own, and
// without it a thrown/rejected error in any async route handler here just
// hangs the request with no response until the platform's function timeout
// kills it (this is what was happening on Vercel: 300s hangs with no error
// surfaced anywhere). Must be imported before the routers below.
import "express-async-errors";
import express from "express";
import { publicRouter } from "./routes/public.js";
import { submitRouter } from "./routes/submit.js";
import { adminRouter } from "./routes/admin.js";
import { seoRouter } from "./routes/seo.js";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Server-rendered, crawlable pages (/opportunities/:slug, /categories/:type,
// /robots.txt, /sitemap.xml). Mounted at root, NOT under /api, so the paths
// are the same real URLs a search engine (or a person) would visit — see
// routes/seo.ts. vercel.json and frontend/server.js both route these exact
// paths to this same Express app in every hosting configuration.
app.use("/", seoRouter);

app.use("/api", publicRouter);
app.use("/api", submitRouter);
app.use("/api", adminRouter);

// Must be registered last and take 4 args (err, req, res, next) — that
// signature is how Express identifies error-handling middleware.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return;
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
});
