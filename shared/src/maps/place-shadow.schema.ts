import { z } from 'zod';

/**
 * Place shadow log — the corpus behind the "is our own index good enough"
 * question, recorded on this instance and nowhere else.
 *
 * The measurement we actually need is narrow: when someone searched for a place
 * and then picked one of the results, would a different index have offered that
 * same place near the top? Answering it needs the query, the pick, and nothing
 * else — so nothing else is recorded. In particular there is no user id, no
 * session, no trip, and no result list: the corpus is about queries, not about
 * who typed them.
 *
 * Deliberately decoupled from the search endpoint. Correlating a search
 * response with a later pick would mean handing out a ticket on
 * POST /api/maps/search and threading it through every one of the fifteen call
 * sites; the client already holds everything the row needs at the moment of the
 * pick, so it posts the row itself and the search path stays untouched.
 *
 * Evaluation happens offline and afterwards. Export the corpus, run it against
 * a candidate index, count how often the pick came back in the top five. That
 * is why collection can start before any such index exists, which is the whole
 * point: the corpus needs weeks of real use, the index needs a server, and
 * these two waits should not be serial.
 */

/** Where the live result the user picked came from, as the provider named it. */
export const placeShadowSourceSchema = z.string().min(1).max(40);

export const placeShadowPickRequestSchema = z.object({
  /** What the user typed. Trimmed by the client; stored verbatim. */
  query: z.string().min(1).max(200),
  /** UI language at the time, because result ranking is language-dependent. */
  lang: z.string().max(35).optional(),
  /**
   * The map centre the search was biased toward, when there was one. Rounded to
   * three decimals (about 100 m) client-side: the bias only has to reproduce
   * the ranking, and a coarser value is a weaker fingerprint of where someone
   * was looking.
   */
  biasLat: z.number().optional(),
  biasLng: z.number().optional(),
  /** 'nominatim', 'google', 'photon', … — whatever the search envelope said. */
  source: placeShadowSourceSchema,
  /** Zero-based position of the picked result in the live list. */
  liveRank: z.number().int().min(0).max(500),
  /** How many results the live provider returned for that query. */
  liveCount: z.number().int().min(1).max(500),
  /** Name of the picked place, as the provider spelled it. */
  pickedName: z.string().min(1).max(300),
  pickedLat: z.number().min(-90).max(90),
  pickedLng: z.number().min(-180).max(180),
  /**
   * Provider id of the pick when there is one (`osm:node/123`, a Google place
   * id). Not required: it is a convenience for matching, and coordinates plus
   * name are what the evaluation actually compares on.
   */
  pickedPlaceId: z.string().max(300).nullable().optional(),
});
export type PlaceShadowPickRequest = z.infer<typeof placeShadowPickRequestSchema>;

/** Answered even when the log is switched off, so the client never has to care. */
export const placeShadowPickResultSchema = z.object({
  recorded: z.boolean(),
});
export type PlaceShadowPickResult = z.infer<typeof placeShadowPickResultSchema>;

export const placeShadowRowSchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  query: z.string(),
  lang: z.string().nullable(),
  biasLat: z.number().nullable(),
  biasLng: z.number().nullable(),
  source: z.string(),
  liveRank: z.number().int(),
  liveCount: z.number().int(),
  pickedName: z.string(),
  pickedLat: z.number(),
  pickedLng: z.number(),
  pickedPlaceId: z.string().nullable(),
});
export type PlaceShadowRow = z.infer<typeof placeShadowRowSchema>;

export const placeShadowExportResultSchema = z.object({
  /** Bumped when the row shape changes, so an evaluator can refuse an old dump. */
  version: z.literal(1),
  generatedAt: z.string(),
  rows: z.array(placeShadowRowSchema),
  /** Present when the page was capped; pass it back as `after` for the next one. */
  nextAfter: z.number().int().nullable(),
});
export type PlaceShadowExportResult = z.infer<typeof placeShadowExportResultSchema>;

export const placeShadowSummaryResultSchema = z.object({
  enabled: z.boolean(),
  total: z.number().int(),
  oldest: z.string().nullable(),
  newest: z.string().nullable(),
  /** How many days a row survives before the nightly job removes it. */
  retentionDays: z.number().int(),
  bySource: z.array(z.object({ source: z.string(), count: z.number().int() })),
  /**
   * Where the picked result sat in the live list. This is the baseline the
   * candidate index has to beat, and it is worth having on its own: if the live
   * provider already puts the pick outside the top five most of the time, the
   * users are working around the search rather than using it.
   */
  liveRankBuckets: z.array(z.object({ bucket: z.string(), count: z.number().int() })),
  /** Share of picks the live provider had at position 0. */
  liveTopOneShare: z.number(),
  /** Share of picks the live provider had within the first five. */
  liveTopFiveShare: z.number(),
});
export type PlaceShadowSummaryResult = z.infer<typeof placeShadowSummaryResultSchema>;
