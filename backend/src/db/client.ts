import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// backend/data/db.sqlite — kept out of git (see .gitignore *.sqlite / *.db).
const DATA_DIR = path.resolve(__dirname, "../../data");
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "db.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
