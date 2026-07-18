// Minimal placeholder entrypoint so `npm run dev` has something to run.
// Route implementations land in Phase 3 (backend-review-queue agent) under
// src/routes/ — this file is intentionally not part of this agent's scope
// beyond keeping the workspace script from breaking.
import express from "express";

const app = express();
const port = process.env.PORT ?? 3000;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`backend placeholder listening on :${port}`);
});
