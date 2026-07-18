// The Express app itself, with no `listen()` call — shared by:
//   - src/index.ts (local dev / any long-running host, e.g. Railway): calls
//     app.listen(port).
//   - /api/index.ts at the repo root (Vercel serverless function): wraps
//     this same app with serverless-http instead of listening on a port.
// Keeping route wiring in one place means neither entry point can drift
// from the other.
import express from "express";
import { publicRouter } from "./routes/public.js";
import { submitRouter } from "./routes/submit.js";
import { adminRouter } from "./routes/admin.js";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", publicRouter);
app.use("/api", submitRouter);
app.use("/api", adminRouter);
