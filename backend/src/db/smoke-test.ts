// One-off smoke test (not a permanent test suite): inserts one approved, one
// pending, one rejected opportunity, then proves getPublic() only returns the
// approved row while getForAdmin() sees all three. Run with `tsx
// src/db/smoke-test.ts` against a migrated + seeded DB.
import { db, sqlite } from "./client.js";
import { opportunities } from "./schema.js";
import { setMajors, setMeta } from "./json-columns.js";
import { getPublic, getForAdmin } from "./data-access.js";

// Clean slate for repeatable runs.
db.delete(opportunities).run();

db.insert(opportunities)
  .values([
    {
      type: "vip",
      name: "Approved VIP Team",
      description: "An approved test row.",
      majors: setMajors(["CS", "EE"]),
      link: "https://vip.gatech.edu/approved",
      meta: setMeta({ semester: "Fall 2026" }),
      source: "curated",
      status: "approved",
    },
    {
      type: "lab",
      name: "Pending Lab Row",
      description: "A pending test row.",
      majors: setMajors(["ME"]),
      link: "https://labs.gatech.edu/pending",
      meta: setMeta({}),
      source: "user_submitted",
      status: "pending",
      submittedBy: "student@gatech.edu",
    },
    {
      type: "club",
      name: "Rejected Club Row",
      description: "A rejected test row.",
      majors: setMajors([]),
      link: "https://clubs.gatech.edu/rejected",
      meta: setMeta({}),
      source: "scraped",
      status: "rejected",
      reviewedBy: "admin",
      reviewedAt: new Date().toISOString(),
    },
  ])
  .run();

const publicResults = getPublic();
const adminResults = getForAdmin();

console.log("=== getPublic() ===");
console.log(JSON.stringify(publicResults, null, 2));

console.log("\n=== getForAdmin() ===");
console.log(JSON.stringify(adminResults, null, 2));

console.log("\n=== ASSERTIONS ===");
console.assert(publicResults.length === 1, `expected 1 public row, got ${publicResults.length}`);
console.assert(
  publicResults[0]?.status === "approved",
  `expected public row status 'approved', got ${publicResults[0]?.status}`
);
console.assert(adminResults.length === 3, `expected 3 admin rows, got ${adminResults.length}`);
console.assert(
  adminResults.some((r) => r.status === "pending"),
  "expected admin results to include a pending row"
);
console.assert(
  adminResults.some((r) => r.status === "rejected"),
  "expected admin results to include a rejected row"
);

const allAssertionsHeld =
  publicResults.length === 1 &&
  publicResults[0]?.status === "approved" &&
  adminResults.length === 3 &&
  adminResults.some((r) => r.status === "pending") &&
  adminResults.some((r) => r.status === "rejected");

console.log(allAssertionsHeld ? "\nSMOKE TEST PASSED" : "\nSMOKE TEST FAILED");
sqlite.close();
process.exit(allAssertionsHeld ? 0 : 1);
