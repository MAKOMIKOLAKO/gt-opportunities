// Vercel serverless function entry point. Vercel's Node.js runtime invokes
// this with a plain (req, res) pair -- the same shape as Node's own
// http.createServer((req, res) => ...) -- not an AWS Lambda-style
// event/context/callback. An Express app IS ALREADY a valid (req, res)
// handler on its own (that's what app.listen() hands to Node's http
// server internally), so it can be exported directly with no adapter.
//
// This previously went through `serverless-http`, a library built
// specifically to bridge AWS Lambda's event/context/callback invocation
// model into an Express-compatible request. Passing Vercel's real (req,
// res) into that Lambda-shaped adapter doesn't fail loudly -- it just never
// correctly completes the response, so every single /api/* request hung
// until Vercel's function timeout killed it, regardless of what the route
// handler itself did (confirmed: this reproduced even for a route with zero
// DB or async work involved). Exporting the Express app directly fixes it.
//
// This is a single catch-all function (not one file per route) to reuse
// backend/src/routes/* unchanged — see BUILD_NOTES.md for why. vercel.json
// routes every /api/* request here (see rewrites), and the app's own
// routes are already mounted under /api (backend/src/app.ts), so req.url
// arrives already correct.
import { app } from "../backend/src/app.js";

export default app;
