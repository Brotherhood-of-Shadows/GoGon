// Owner-provided passive endpoint and positive/negative fixtures, 2026-11-03.
export const ITEM_DISCOVERY_LOOKAHEAD = 10;
export const ITEM_DISCOVERY_INTERVAL_MS = 24 * 3600_000;
export const ITEM_DISCOVERY_WEBHOOK = 'GG_UPCOMING_WEBHOOK';
export const ITEM_DISCOVERY_SOURCE = 'catalog_upcoming';
export const MAX_TOOLTIP_ITEM_ID = 10_000_000;

/** Builds the fixed passive item tooltip request from a validated ID.
 * @param {number} id Game item ID.
 * @returns {string} HTTPS tooltip URL.
 */
export function itemTooltipUrl(id) {
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_TOOLTIP_ITEM_ID) throw new Error('Invalid item ID.');
    return `https://www.fallensword.com/fetchitem.php?item_id=${id}&inv_id=-1&t=0&extra=0`;
}

/** Permits only the owner's exact, read-only tooltip URL shape.
 * @param {string} value Request URL.
 * @returns {string} Validated URL.
 */
export function assertItemTooltipUrl(value) {
    const url = new URL(value);
    const id = url.searchParams.get('item_id');
    if (!id || !/^[1-9]\d{0,7}$/.test(id) || value !== itemTooltipUrl(Number(id))) throw new Error('Item discovery URL is not an allowed passive tooltip read.');
    return value;
}
