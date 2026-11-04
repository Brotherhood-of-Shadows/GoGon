import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';

/** Private debug volume shared with the SSO failure screenshot (compose.yaml). */
export const ITEM_TOOLTIP_DEBUG_DIRECTORY = '/var/lib/gogon-sso-debug';
export const ITEM_TOOLTIP_DEBUG_FILE = 'last-item-tooltip.html';

// Tooltip fragments carry public item data only, but a misrouted full game page could embed
// session tokens in scripts, forms or links. Keep only markup structure and visible text.
function sanitize(html) {
    const $ = load(html);
    $('script, style, link, meta, iframe, form, input, noscript').remove();
    $('*').each((_, element) => {
        for (const name of Object.keys(element.attribs ?? {})) {
            if (!['class', 'colspan', 'width', 'color', 'size'].includes(name)) $(element).removeAttr(name);
        }
    });
    return $.html();
}

/** Keeps the latest unrecognized item tooltip as an owner-only file in the private debug volume.
 * Retention failures are reported but never change the scan outcome.
 * @param {{directory?: string, log?: (line: string) => void}} [options] Destination and logger.
 * @returns {(id: number, html: string) => Promise<void>} Retention callback for item discovery.
 */
export function createItemTooltipRetention({ directory = ITEM_TOOLTIP_DEBUG_DIRECTORY, log = console.warn } = {}) {
    return async (id, html) => {
        const target = path.join(directory, ITEM_TOOLTIP_DEBUG_FILE);
        const temporary = `${target}.tmp`;
        try {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(temporary, `<!-- item ${id}, sanitized unrecognized response -->\n${sanitize(html)}\n`, { mode: 0o600 });
            await rename(temporary, target);
            log(`[Catalog Items] ID ${id}: sanitized unrecognized tooltip saved at ${target}.`);
        } catch (error) {
            log(`[Catalog Items] ID ${id}: could not save unrecognized tooltip (${error?.code ?? 'error'}).`);
        }
    };
}
