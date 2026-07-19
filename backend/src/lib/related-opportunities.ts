// Recompute logic for the "related organizations" cache
// (`related_opportunities` table — see schema.ts). Precomputed on
// create/edit/reclassify (VIP scrape upsert, Engage classify, admin
// approve/edit — see the call sites in vip.ts, engage-classify.ts, and
// data-access.ts), NEVER computed live per page view.
//
// Cross-category matching is a hard requirement: a VIP robotics team and an
// Engage robotics club must be able to surface each other even with zero
// tag overlap, because tagging vocabulary differs across the VIP scraper,
// Engage scraper, and crowdsourced submissions. `type` (vip/lab/club) is
// NEVER used as a scoring signal here — no same-type bonus, no same-type
// filter. Tag overlap is only ever a small additive *boost* on top of
// embedding similarity, never a filter, so a zero-tag-overlap cross-category
// match is still eligible for the top N.
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { relatedOpportunities } from "../db/schema.js";

// Top-N related orgs kept per opportunity (requested range was 5-8).
const TOP_N = 6;
// How many nearest-by-embedding candidates to pull before re-ranking with
// the tag-overlap boost — wider than TOP_N so a candidate with weaker raw
// similarity but strong tag overlap still has a chance to make the cut.
const CANDIDATE_POOL_SIZE = 20;
// Additive boost per overlapping tag, capped at 5 tags (+0.25 max) so tag
// overlap can nudge the ranking but can never dominate embedding similarity.
const TAG_OVERLAP_BOOST_PER_TAG = 0.05;
const TAG_OVERLAP_BOOST_CAP_TAGS = 5;

type CandidateRow = {
  id: number;
  cosine_distance: number;
};

/**
 * Recomputes and persists the top-N related opportunities for one
 * opportunity. No-ops (logs and returns) if the target row has no embedding
 * yet — i.e. OPENAI_API_KEY isn't configured, or embedOpportunity() failed
 * for this row. Safe/cheap to call repeatedly; always fully replaces this
 * opportunity's cached rows rather than patching them.
 */
export async function recomputeRelated(opportunityId: number): Promise<void> {
  const targetRows = await db.execute<{ embedding: string | null }>(
    sql`SELECT embedding::text as embedding FROM opportunities WHERE id = ${opportunityId}`
  );
  const targetEmbedding = targetRows.rows[0]?.embedding;
  if (!targetEmbedding) {
    console.log(
      `recomputeRelated(${opportunityId}): no embedding on this row yet (OPENAI_API_KEY not set, or embedding ` +
        `generation failed) — skipping.`
    );
    return;
  }

  // Nearest neighbors by cosine distance (`<=>`, ascending = most similar
  // first) among OTHER approved opportunities that also have an embedding.
  // Brute-force scan is fine at current row counts (~112 VIP + ~600 Engage,
  // roughly 700 rows total) — see BUILD_NOTES.md for the ANN-index TODO.
  const candidates = await db.execute<CandidateRow>(
    sql`SELECT id, embedding <=> ${targetEmbedding}::vector as cosine_distance
        FROM opportunities
        WHERE id != ${opportunityId}
          AND status = 'approved'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${targetEmbedding}::vector
        LIMIT ${CANDIDATE_POOL_SIZE}`
  );

  if (candidates.rows.length === 0) {
    await db.delete(relatedOpportunities).where(eq(relatedOpportunities.opportunityId, opportunityId));
    return;
  }

  const candidateIds = candidates.rows.map((c) => c.id);

  // Postgres array literal built by hand rather than interpolating the JS
  // array directly (`ANY(${candidateIds})`) — Drizzle's `sql` tag expands a
  // bare array parameter into a parenthesized parameter LIST, e.g.
  // `ANY(($1, $2))`, not an array expression. Postgres reads that as a row
  // constructor for 2+ candidates ("op ANY/ALL (array) requires array on
  // right side" — every recomputeRelated() call after the first opportunity
  // failed with exactly this in production) and, for exactly 1 candidate,
  // collapses the parens and coerces the bare scalar as array-literal text
  // ("malformed array literal: '852'", also observed). Verified against
  // drizzle-orm's actual PgDialect().sqlToQuery() output before/after this
  // fix. The explicit `{...}` literal + `::int[]` cast sidesteps both.
  const candidateIdsLiteral = `{${candidateIds.join(",")}}`;

  // Tag overlap between the target and each candidate — a soft boost only,
  // never a filter or a same-type bonus. Deliberately does NOT reference
  // `type` anywhere: a VIP team and an Engage club with zero shared tags
  // must still be eligible for the top N purely on embedding similarity.
  const overlapRows = await db.execute<{ related_id: number; overlap_count: number }>(
    sql`SELECT ot2.opportunity_id as related_id, COUNT(*)::int as overlap_count
        FROM opportunity_tags ot1
        JOIN opportunity_tags ot2 ON ot2.tag_id = ot1.tag_id
        WHERE ot1.opportunity_id = ${opportunityId}
          AND ot2.opportunity_id = ANY(${candidateIdsLiteral}::int[])
        GROUP BY ot2.opportunity_id`
  );
  const overlapByCandidateId = new Map(overlapRows.rows.map((r) => [Number(r.related_id), Number(r.overlap_count)]));

  const scored = candidates.rows.map((c) => {
    const similarity = 1 - Number(c.cosine_distance);
    const overlapCount = overlapByCandidateId.get(c.id) ?? 0;
    const tagBoost = TAG_OVERLAP_BOOST_PER_TAG * Math.min(overlapCount, TAG_OVERLAP_BOOST_CAP_TAGS);
    return { id: c.id, score: similarity + tagBoost };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, TOP_N);

  await db.transaction(async (tx) => {
    await tx.delete(relatedOpportunities).where(sql`opportunity_id = ${opportunityId}`);
    for (let i = 0; i < top.length; i++) {
      await tx.insert(relatedOpportunities).values({
        opportunityId,
        relatedOpportunityId: top[i].id,
        score: top[i].score,
        rank: i + 1,
      });
    }
  });
}
