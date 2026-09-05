import { Injectable } from '@nestjs/common';
import { ADDON_IDS } from '../../addons';
import { DatabaseService } from '../database/database.service';
import type { Addon } from '../../types';
import { getPhotoProviderConfig } from '../memories/memories.helpers';

/**
 * Thin wrapper around the enabled-addons + photo-provider read that the legacy
 * inline `GET /api/addons` handler performed (server/src/app.ts). The SQL,
 * ordering, boolean coercions and the merged photo-provider entries are
 * reproduced 1:1 so the body is byte-identical for the client.
 *
 * Also the single owner of addon/feature-flag enablement state (moved verbatim
 * from services/adminService.ts, finding `admin-1`): isAddonEnabled plus the
 * bag-tracking and collab-features flags. The boolean polarities differ on
 * purpose — bag tracking is opt-in (`=== 'true'`, default OFF), the collab
 * sub-features are opt-out (`!== 'false'`, default ON). Reads are uncached
 * per-call queries so admin toggles stay immediately visible.
 */
@Injectable()
export class AddonsService {
  constructor(private readonly dbs: DatabaseService) {}

  private get db() {
    return this.dbs.connection;
  }

  isAddonEnabled(addonId: string): boolean {
    const addon = this.db.prepare('SELECT enabled FROM addons WHERE id = ?').get(addonId) as
      | { enabled: number }
      | undefined;
    return !!addon?.enabled;
  }

  getBagTracking() {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'bag_tracking_enabled'").get() as
      | { value: string }
      | undefined;
    return { enabled: row?.value === 'true' };
  }

  updateBagTracking(enabled: boolean) {
    this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bag_tracking_enabled', ?)").run(
      enabled ? 'true' : 'false',
    );
    return { enabled: !!enabled };
  }

  getCollabFeatures() {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM app_settings WHERE key IN ('collab_chat_enabled', 'collab_notes_enabled', 'collab_polls_enabled', 'collab_whatsnext_enabled')",
      )
      .all() as { key: string; value: string }[];
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return {
      chat: map['collab_chat_enabled'] !== 'false',
      notes: map['collab_notes_enabled'] !== 'false',
      polls: map['collab_polls_enabled'] !== 'false',
      whatsnext: map['collab_whatsnext_enabled'] !== 'false',
    };
  }

  updateCollabFeatures(features: { chat?: boolean; notes?: boolean; polls?: boolean; whatsnext?: boolean }) {
    const mapping: Record<string, string> = {
      chat: 'collab_chat_enabled',
      notes: 'collab_notes_enabled',
      polls: 'collab_polls_enabled',
      whatsnext: 'collab_whatsnext_enabled',
    };
    const before = this.getCollabFeatures();
    const stmt = this.db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
    for (const [feat, key] of Object.entries(mapping)) {
      if (features[feat] !== undefined) stmt.run(key, features[feat] ? 'true' : 'false');
    }
    const after = this.getCollabFeatures();
    // Collab flags gate MCP tool/resource registration, so callers must know
    // whether anything actually flipped — a no-op save must not tear down every
    // live MCP session (#1414).
    const changed = (Object.keys(after) as Array<keyof typeof after>).some((k) => after[k] !== before[k]);
    return { features: after, changed };
  }

  list() {
    const addons = this.db
      .prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order')
      .all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
    // Photo providers surface only inside journeys, so with the journey addon
    // off they are unavailable no matter what their own rows say. Deriving that
    // here (instead of a migration) also covers installs that still hold an
    // enabled provider under a disabled journey from before updateAddon
    // cascaded the disable.
    const providers = !this.isAddonEnabled(ADDON_IDS.JOURNEY)
      ? []
      : (this.db
          .prepare(
            `SELECT id, name, icon, enabled, sort_order
             FROM photo_providers
             WHERE enabled = 1
             ORDER BY sort_order, id`,
          )
          .all() as Array<{ id: string; name: string; icon: string; enabled: number; sort_order: number }>);
    const fields = this.db
      .prepare(
        `SELECT provider_id, field_key, label, input_type, placeholder, hint, required, secret, settings_key, payload_key, sort_order
         FROM photo_provider_fields
         ORDER BY sort_order, id`,
      )
      .all() as Array<{
      provider_id: string;
      field_key: string;
      label: string;
      input_type: string;
      placeholder?: string | null;
      hint?: string | null;
      required: number;
      secret: number;
      settings_key?: string | null;
      payload_key?: string | null;
      sort_order: number;
    }>;

    const fieldsByProvider = new Map<string, typeof fields>();
    for (const field of fields) {
      const arr = fieldsByProvider.get(field.provider_id) || [];
      arr.push(field);
      fieldsByProvider.set(field.provider_id, arr);
    }

    return {
      collabFeatures: this.getCollabFeatures(),
      bagTracking: this.getBagTracking().enabled,
      addons: [
        ...addons.map((a) => ({ ...a, enabled: !!a.enabled })),
        ...providers.map((p) => ({
          id: p.id,
          name: p.name,
          type: 'photo_provider',
          icon: p.icon,
          enabled: !!p.enabled,
          config: getPhotoProviderConfig(p.id),
          fields: (fieldsByProvider.get(p.id) || []).map((f) => ({
            key: f.field_key,
            label: f.label,
            input_type: f.input_type,
            placeholder: f.placeholder || '',
            hint: f.hint || null,
            required: !!f.required,
            secret: !!f.secret,
            settings_key: f.settings_key || null,
            payload_key: f.payload_key || null,
            sort_order: f.sort_order,
          })),
        })),
      ],
    };
  }

  // ── Places provider flags ──────────────────────────────────────────────────
  // These three sat as raw app_settings SQL on AdminService, next to the
  // bag-tracking and collab flags it already delegated here. They read
  // `=== 'true'` — fail-closed, matching getBagTracking(). They read
  // `!== 'false'` (fail-open) before the 2026-08 quirk fix; a migration
  // backfills 'true' for installs that never touched the switches, so nobody
  // loses a feature on upgrade.

  private readFlag(key: string) {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return { enabled: row?.value === 'true' };
  }

  private writeFlag(key: string, enabled: boolean) {
    this.db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, enabled ? 'true' : 'false');
    return { enabled: !!enabled };
  }

  getPlacesPhotos() { return this.readFlag('places_photos_enabled'); }
  updatePlacesPhotos(enabled: boolean) { return this.writeFlag('places_photos_enabled', enabled); }
  getPlacesAutocomplete() { return this.readFlag('places_autocomplete_enabled'); }
  updatePlacesAutocomplete(enabled: boolean) { return this.writeFlag('places_autocomplete_enabled', enabled); }
  getPlacesDetails() { return this.readFlag('places_details_enabled'); }
  updatePlacesDetails(enabled: boolean) { return this.writeFlag('places_details_enabled', enabled); }

  /**
   * The shadow log, fail-CLOSED like the three above but for the opposite
   * reason: they read `=== 'true'` because a migration backfilled a row for
   * installs that were already using the feature. Nothing is using this one,
   * so there is nothing to backfill and an absent row correctly means off.
   * PlaceShadowService.enabled() reads the same key the same way.
   */
  getPlaceShadow() { return this.readFlag('place_shadow_enabled'); }
  updatePlaceShadow(enabled: boolean) { return this.writeFlag('place_shadow_enabled', enabled); }

  /**
   * Enrichment reads fail-OPEN, unlike the three switches above.
   *
   * Those needed migration 185 to backfill 'true' precisely because they read
   * `=== 'true'`: without a row, an install that had been happily using the
   * feature would have lost it on upgrade. This switch is new, so there is no
   * row to backfill anywhere and no migration worth writing for one boolean —
   * reading it the other way round gets the same outcome for free.
   *
   * It has to agree with PlaceEnrichmentService.enrichDisabled(), which reads
   * the same key the same way. If these two ever disagree the admin panel shows
   * "off" while the feature runs, which is worse than either default.
   */
  getPlacesEnrich() {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'places_enrich_enabled'").get() as
      | { value: string }
      | undefined;
    return { enabled: row?.value !== 'false' };
  }

  updatePlacesEnrich(enabled: boolean) { return this.writeFlag('places_enrich_enabled', enabled); }
}
