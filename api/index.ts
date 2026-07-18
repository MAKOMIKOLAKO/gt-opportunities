// Vercel serverless function entry point. Wraps the same Express app used
// by backend/src/index.ts (local dev / Railway) with serverless-http
// instead of calling app.listen() — Vercel functions are request-scoped,
// not a long-running process. vercel.json routes every /api/* request here
// (see rewrites), and the app's own routes are already mounted under /api
// (backend/src/app.ts), so req.url arrives already correct.
//
// This is a single catch-all function (not one file per route) to reuse
// backend/src/routes/* unchanged — see BUILD_NOTES.md for why.
import serverlessHttp from "serverless-http";
import { app } from "../backend/src/app.js";

const handler = serverlessHttp(app);

export default async function (req: unknown, res: unknown) {
  return handler(req as never, res as never);
}
