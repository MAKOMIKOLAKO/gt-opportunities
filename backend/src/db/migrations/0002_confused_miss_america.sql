ALTER TABLE `opportunities` ADD `details` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `search_blob` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Full-text search index over `search_blob` (name + description + majors +
-- tag labels + flattened `details` values) — the SQLite equivalent of a
-- Postgres tsvector generated column. `search_blob` itself is recomputed and
-- kept current by application code (see refreshSearchBlob in data-access.ts);
-- these triggers only mirror that column into the FTS index whenever it changes.
CREATE VIRTUAL TABLE `opportunities_fts` USING fts5(
	`search_blob`,
	content=`opportunities`,
	content_rowid=`id`
);--> statement-breakpoint
CREATE TRIGGER `opportunities_ai` AFTER INSERT ON `opportunities` BEGIN
	INSERT INTO `opportunities_fts`(rowid, search_blob) VALUES (new.id, new.search_blob);
END;--> statement-breakpoint
CREATE TRIGGER `opportunities_ad` AFTER DELETE ON `opportunities` BEGIN
	INSERT INTO `opportunities_fts`(`opportunities_fts`, rowid, search_blob) VALUES('delete', old.id, old.search_blob);
END;--> statement-breakpoint
CREATE TRIGGER `opportunities_au` AFTER UPDATE ON `opportunities` BEGIN
	INSERT INTO `opportunities_fts`(`opportunities_fts`, rowid, search_blob) VALUES('delete', old.id, old.search_blob);
	INSERT INTO `opportunities_fts`(rowid, search_blob) VALUES (new.id, new.search_blob);
END;