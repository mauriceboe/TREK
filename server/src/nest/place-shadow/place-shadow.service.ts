import { Injectable } from '@nestjs/common';
import type {
  PlaceShadowExportResult,
  PlaceShadowPickRequest,
  PlaceShadowRow,
  PlaceShadowSummaryResult,
} from '@trek/shared';
import { DatabaseService } from '../database/database.service';

/** Rows older than this are removed nightly. */
export const RETENTION_DAYS = 180;

/** Cap on one export page, so a large corpus cannot be pulled in one response. */
export const EXPORT_PAGE_SIZE = 2000;

/**
 * Coordinates are stored at three decimals, matching what the client sends for
 * the bias. That is about 100 m, which is far finer than any ranking decision
 * and far coarser than a home address.
 */
const COORD_DECIMALS = 3;

function round(value: number, decimals = COORD_DECIMALS): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

interface DbRow {
  id: number;
  created_at: string;
  query: string;
  lang: string | null;
  bias_lat: number | null;
  bias_lng: number | null;
  source: string;
  live_rank: number;
  live_count: number;
  picked_name: string;
  picked_lat: number;
  picked_lng: number;
  picked_place_id: string | null;
}

function toRow(r: DbRow): PlaceShadowRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    query: r.query,
    lang: r.lang,
    biasLat: r.bias_lat,
    biasLng: r.bias_lng,
    source: r.source,
    liveRank: r.live_rank,
    liveCount: r.live_count,
    pickedName: r.picked_name,
    pickedLat: r.picked_lat,
    pickedLng: r.picked_lng,
    pickedPlaceId: r.picked_place_id,
  };
}

/**
 * Records which search result a user actually picked, so a different index can
 * be judged against real queries later.
 *
 * Off unless an admin switches it on, and it reads `=== 'true'` rather than
 * `!== 'false'`: an absent row means off. That is the opposite of the three
 * older places switches, which had to fail open because installs were already
 * using those features when the switches arrived. Nothing is using this one, so
 * the safe default is the silent one — an instance that upgrades and never
 * visits the admin panel logs nothing.
 */
@Injectable()
export class PlaceShadowService {
  constructor(private readonly db: DatabaseService) {}

  enabled(): boolean {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'place_shadow_enabled'",
    );
    return row?.value === 'true';
  }

  /**
   * Returns whether the row was written. A disabled log is not an error: the
   * client fires this and forgets it, and a 403 in the console every time
   * somebody adds a place would be noise about a feature that is off on
   * purpose.
   */
  record(pick: PlaceShadowPickRequest): boolean {
    if (!this.enabled()) return false;
    // A rank outside the returned list means the client and the server disagree
    // about what was on screen. Storing it would poison the very number the
    // corpus exists to produce, so the row is dropped instead.
    if (pick.liveRank >= pick.liveCount) return false;

    this.db.run(
      `INSERT INTO place_shadow_picks
         (query, lang, bias_lat, bias_lng, source, live_rank, live_count,
          picked_name, picked_lat, picked_lng, picked_place_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pick.query,
      pick.lang ?? null,
      pick.biasLat === undefined ? null : round(pick.biasLat),
      pick.biasLng === undefined ? null : round(pick.biasLng),
      pick.source,
      pick.liveRank,
      pick.liveCount,
      pick.pickedName,
      round(pick.pickedLat),
      round(pick.pickedLng),
      pick.pickedPlaceId ?? null,
    );
    return true;
  }

  /**
   * One page of the corpus, oldest first. `after` is the last id of the
   * previous page; paging by id rather than by offset keeps the pages stable
   * while new rows arrive underneath.
   */
  export(after?: number, limit = EXPORT_PAGE_SIZE): PlaceShadowExportResult {
    const size = Math.min(Math.max(1, limit), EXPORT_PAGE_SIZE);
    const rows = this.db.all<DbRow>(
      `SELECT * FROM place_shadow_picks
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
      after ?? 0,
      size + 1,
    );
    const page = rows.slice(0, size);
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      rows: page.map(toRow),
      nextAfter: rows.length > size && page.length > 0 ? page[page.length - 1].id : null,
    };
  }

  summary(): PlaceShadowSummaryResult {
    const enabled = this.enabled();
    const totals = this.db.get<{ total: number; oldest: string | null; newest: string | null }>(
      'SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM place_shadow_picks',
    );
    const total = totals?.total ?? 0;

    const bySource = this.db.all<{ source: string; count: number }>(
      `SELECT source, COUNT(*) AS count FROM place_shadow_picks
        GROUP BY source ORDER BY count DESC`,
    );

    // Buckets rather than a mean: the question is "did the user find it near
    // the top", and an average rank is dragged around by the rare query that
    // scrolled to result 40.
    const ranks = this.db.all<{ live_rank: number; count: number }>(
      'SELECT live_rank, COUNT(*) AS count FROM place_shadow_picks GROUP BY live_rank',
    );
    const counted = (test: (rank: number) => boolean): number =>
      ranks.filter(r => test(r.live_rank)).reduce((sum, r) => sum + r.count, 0);

    const topOne = counted(r => r === 0);
    const topFive = counted(r => r < 5);

    return {
      enabled,
      total,
      oldest: totals?.oldest ?? null,
      newest: totals?.newest ?? null,
      retentionDays: RETENTION_DAYS,
      bySource,
      liveRankBuckets: [
        { bucket: '1', count: topOne },
        { bucket: '2-5', count: counted(r => r >= 1 && r < 5) },
        { bucket: '6-10', count: counted(r => r >= 5 && r < 10) },
        { bucket: '11+', count: counted(r => r >= 10) },
      ],
      liveTopOneShare: total ? topOne / total : 0,
      liveTopFiveShare: total ? topFive / total : 0,
    };
  }

  /** Admin wipe. Returns how many rows went. */
  clear(): number {
    return this.db.run('DELETE FROM place_shadow_picks').changes;
  }

  /** Nightly retention. Returns how many rows went. */
  purgeExpired(retentionDays = RETENTION_DAYS): number {
    return this.db.run(
      `DELETE FROM place_shadow_picks
        WHERE created_at < datetime('now', ?)`,
      `-${retentionDays} days`,
    ).changes;
  }
}
