// Admin routes. All mutation/read paths here go through getForAdmin() /
// the admin-only mutation helpers in data-access.ts — never getPublic().
import { Router } from "express";
import { ADMIN_USERNAME, ADMIN_PASSWORD, createToken, requireAdmin } from "../lib/auth.js";
import {
  getForAdmin,
  approveOpportunity,
  rejectOpportunity,
  updateOpportunity,
} from "../db/data-access.js";
import type { OpportunityStatus, OpportunityType } from "../db/schema.js";

const VALID_STATUSES: OpportunityStatus[] = ["approved", "pending", "rejected"];
const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export const adminRouter = Router();

adminRouter.post("/admin/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = createToken(username);
  res.json({ token });
});

// Everything below requires a valid admin session.
adminRouter.use("/admin", requireAdmin);

adminRouter.get("/admin/opportunities", (req, res) => {
  const { status, type, search } = req.query;
  const statusFilter = typeof status === "string" && VALID_STATUSES.includes(status as OpportunityStatus)
    ? (status as OpportunityStatus)
    : undefined;
  const typeFilter = typeof type === "string" && VALID_TYPES.includes(type as OpportunityType)
    ? (type as OpportunityType)
    : undefined;
  const searchFilter = typeof search === "string" && search.length > 0 ? search : undefined;

  const results = getForAdmin({ status: statusFilter, type: typeFilter, search: searchFilter });
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/opportunities/:id/approve", (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = approveOpportunity(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.post("/admin/opportunities/:id/reject", (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const result = rejectOpportunity(id, reviewedBy, reason);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.patch("/admin/opportunities/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;

  const details: string[] = [];
  if (body.name !== undefined && typeof body.name !== "string") details.push("name must be a string");
  if (body.description !== undefined && typeof body.description !== "string") details.push("description must be a string");
  if (body.majors !== undefined && !Array.isArray(body.majors)) details.push("majors must be an array");
  if (body.tagSlugs !== undefined && !Array.isArray(body.tagSlugs)) details.push("tagSlugs must be an array");
  if (body.type !== undefined && !VALID_TYPES.includes(body.type)) details.push("type must be one of vip|lab|club");

  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  const result = updateOpportunity(
    id,
    {
      name: body.name,
      description: body.description,
      majors: body.majors,
      link: body.link,
      tagSlugs: body.tagSlugs,
      type: body.type,
    },
    body.approve === true,
    reviewedBy
  );

  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});
