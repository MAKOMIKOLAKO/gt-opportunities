// POST /api/admin/login — establishes an admin session (opaque bearer token).
// Ported from backend/src/routes/admin.ts (adminRouter.post("/admin/login")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ADMIN_USERNAME, ADMIN_PASSWORD, createToken } from "../../backend/src/lib/auth.js";
import { methodNotAllowed, sendJson } from "../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const { username, password } = req.body ?? {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }
  const token = createToken(username);
  sendJson(res, 200, { token });
}
