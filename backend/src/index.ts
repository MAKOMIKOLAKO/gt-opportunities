import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { publicRouter } from "./routes/public.js";
import { submitRouter } from "./routes/submit.js";
import { adminRouter } from "./routes/admin.js";
import { ADMIN_USERNAME, ADMIN_PASSWORD } from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", publicRouter);
app.use("/api", submitRouter);
app.use("/api", adminRouter);

app.listen(port, () => {
  console.log(`backend listening on :${port}`);
  console.log(`admin username: ${ADMIN_USERNAME}`);
  console.log(`admin password: ${ADMIN_PASSWORD}`);
  writeAdminCredentialsToRunStatus();
});

// Writes the freshly generated admin password into RUN-STATUS.md (gitignored)
// so it's discoverable without ever being hardcoded/committed in source.
function writeAdminCredentialsToRunStatus(): void {
  try {
    const runStatusPath = path.resolve(__dirname, "../../RUN-STATUS.md");
    let content = fs.readFileSync(runStatusPath, "utf8");
    const marker = "## Admin credentials";
    const nextSection = "\n## How to run everything";
    const block = `${marker}\n- Username: \`${ADMIN_USERNAME}\`\n- Password: \`${ADMIN_PASSWORD}\`\n- Generated at: ${new Date().toISOString()} (regenerated on every server start — restart invalidates the old one)\n`;
    if (content.includes(marker) && content.includes(nextSection)) {
      const before = content.slice(0, content.indexOf(marker));
      const after = content.slice(content.indexOf(nextSection));
      content = `${before}${block}${after}`;
    } else {
      content += `\n${block}`;
    }
    fs.writeFileSync(runStatusPath, content, "utf8");
  } catch (err) {
    console.warn("could not write admin credentials to RUN-STATUS.md:", err);
  }
}
