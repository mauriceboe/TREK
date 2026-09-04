/**
 * Ask the browser for persistent storage so our offline data — prefetched map
 * tiles, cached file blobs, the IndexedDB caches — is exempt from eviction under
 * storage pressure. Without this the browser may purge tiles right when a
 * traveler goes offline and needs them (audit H8 / M6).
 *
 * Best-effort and idempotent: returns whether persistence is (now) granted.
 */

/**
 * Last known answer, so callers that have to size a download against it do not
 * each re-ask. `null` until the request at app init has resolved.
 *
 * The answer matters: a browser that refuses persistence evicts this origin's
 * WHOLE bucket under pressure (the Workbox precache with it), and since sw.js
 * is byte-identical between releases, Workbox never re-installs and never
 * refills what was evicted. The PWA then cannot start offline at all, and
 * reinstalling does not help because it does not clear or restore site data
 * (#2228).
 */
let _persisted: boolean | null = null

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
      _persisted = false
      return false
    }
    // Already persisted? Avoid re-prompting where the API distinguishes.
    if (navigator.storage.persisted && (await navigator.storage.persisted())) {
      _persisted = true
      return true
    }
    _persisted = await navigator.storage.persist()
    return _persisted
  } catch {
    _persisted = false
    return false
  }
}

/**
 * Whether this origin's storage is exempt from eviction. Treats "not asked yet"
 * as not granted, so a caller sizing a download errs on the small side.
 */
export function isStoragePersisted(): boolean {
  return _persisted === true
}

/** Test helper: forget the cached answer. */
export function _resetPersistentStorage(): void {
  _persisted = null
}
