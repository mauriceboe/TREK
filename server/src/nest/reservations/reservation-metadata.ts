/**
 * Metadata keys on a reservation that the booking forms do not own.
 *
 * `price` and `priceCurrency` are written by the expense side
 * (BudgetService.syncReservationPrice) and by the booking importer, never by a
 * booking form. The forms rebuild metadata from their own fields on every save
 * and carry only `transit` and `airtrail_ids` across, so an ordinary edit used
 * to drop the price and the card lost it until the expense was saved again
 * (#2233). The same happened unattended on the AirTrail poll, which updates a
 * reservation with a mapped metadata object that never contains a price.
 *
 * Kept out of the reservations service so it can be exercised on its own.
 */

/** Read a stored metadata column into an object, or null if it is not one. */
function parseStored(stored: string | null | undefined): Record<string, unknown> | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Carry `price` / `priceCurrency` from the stored metadata into an incoming
 * object that does not name them.
 *
 * Everything else passes through untouched, which is what keeps the caller in
 * control: `undefined` (no metadata on the payload) leaves the row alone, `null`
 * clears the column, and naming the key — including setting it to null — is
 * taken at face value, so a price can still be removed deliberately.
 *
 * There is deliberately no "only while an expense is linked" condition. The
 * importer stamps a price onto the booking whether or not the Costs addon is
 * enabled, and an MCP booking created with a price of 0 gets no linked item
 * either, so that condition would drop a real price on the first edit. What
 * stops a stale price from outliving its expense is the other end:
 * BudgetService.deleteBudgetItem clears the mirror when the expense goes away.
 */
export function keepMirroredPrice(incoming: unknown, stored: string | null | undefined): unknown {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const next = incoming as Record<string, unknown>;
  if ('price' in next) return incoming;

  const prev = parseStored(stored);
  if (!prev || prev.price === undefined) return incoming;

  const kept: Record<string, unknown> = { ...next, price: prev.price };
  if (prev.priceCurrency !== undefined && !('priceCurrency' in next)) kept.priceCurrency = prev.priceCurrency;
  return kept;
}
