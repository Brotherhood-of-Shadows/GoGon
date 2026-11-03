import { load } from 'cheerio';
import { MAX_TOOLTIP_ITEM_ID, itemTooltipUrl } from './contracts/itemTooltip.js';
import { MAX_RESPONSE_BYTES } from './contracts/classify.js';

const STATS = Object.freeze({ attack: 'attack', defense: 'defense', armour: 'armor', armor: 'armor', damage: 'damage', hp: 'hp',
    'xp gain': 'xpGain', stamina: 'stamina', 'stamina gain': 'staminaGain', 'gold gain': 'goldGain', 'min level': 'level', level: 'level' });
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** A malformed tooltip is never interpreted as an unused ID. */
export class ItemTooltipError extends Error {
    constructor(message = 'Unrecognized item tooltip.') { super(message); this.name = 'ItemTooltipError'; }
}

function numeric(value) {
    const normalized = value.replace(/,/g, '').replace(/\u2212/g, '-');
    if (!/^[+-]?\d+(?:\.\d+)?%?$/.test(normalized)) throw new ItemTooltipError('Invalid item tooltip number.');
    const result = Number(normalized.replace(/%$/, ''));
    if (!Number.isFinite(result) || Math.abs(result) > 1e12) throw new ItemTooltipError('Item tooltip number is out of range.');
    return result;
}

/** Parses the owner's fetchitem HTML, preserving extra tooltip fields without inventing Guide data.
 * @param {string} html Raw successful response.
 * @param {number} id Requested item ID.
 * @returns {{found: false}|{found: true, record: object}} Typed provisional item.
 */
export function parseItemTooltip(html, id) {
    if (!Number.isInteger(id) || id < 1 || id > MAX_TOOLTIP_ITEM_ID || typeof html !== 'string' || Buffer.byteLength(html) > MAX_RESPONSE_BYTES) throw new ItemTooltipError();
    if (html.trim() === 'Invalid Request') return { found: false };
    const $ = load(html);
    const table = $('table.item-tip');
    if (table.length !== 1) throw new ItemTooltipError();
    const name = clean(table.find('.item-tip-name').text());
    const type = clean(table.find('.item-tip-type').first().text());
    const match = type.match(/^(.+?)\s+-\s+(.+)$/);
    if (!name || name.length > 191 || !match || match[1].length > 64 || match[2].length > 64) throw new ItemTooltipError();
    const record = { id, name, rarity: match[2], imageUrl: `https://cdn2.fallensword.com/items/${id}.gif`, stats: { type: match[1] }, enhancements: [], details: { tooltipSections: [] } };
    const typeDetails = table.find('.item-tip-type').toArray().slice(1).map(element => clean($(element).text())).filter(Boolean);
    if (typeDetails.length > 16 || typeDetails.some(value => value.length > 512)) throw new ItemTooltipError();
    if (typeDetails.length) record.details.typeDetails = typeDetails;
    const color = table.find('.item-tip-name font').attr('color');
    if (/^#[0-9a-f]{6}$/i.test(color ?? '')) record.details.nameColor = color;
    let section = null;
    const pieces = [];
    for (const row of table.find('tr').toArray()) {
        const cells = $(row).children('td');
        const heading = clean(cells.filter('.item-tip-section').text());
        if (cells.filter('.item-tip-divider-row').length) section = null;
        if (heading) {
            if (record.details.tooltipSections.length >= 32 || heading.length > 191) throw new ItemTooltipError();
            section = { heading, entries: [] };
            record.details.tooltipSections.push(section);
        }
        const piece = clean(cells.filter('.item-tip-muted').text());
        if (piece && /^Set Details/i.test(section?.heading ?? '')) {
            if (pieces.length >= 200 || piece.length > 191) throw new ItemTooltipError();
            pieces.push(piece);
        }
        const label = clean(cells.filter('.item-tip-label').text());
        const value = clean(cells.filter('.item-tip-value').text());
        if (!label) continue;
        if (!value || label.length > 191 || value.length > 512 || (section?.entries.length ?? 0) >= 100) throw new ItemTooltipError();
        section?.entries.push({ label, value });
        if (!section) {
            record.details.otherFields ??= [];
            if (record.details.otherFields.length >= 100) throw new ItemTooltipError();
            record.details.otherFields.push({ label, value });
        }
        const field = STATS[label.toLowerCase()];
        if (field && (!section || /^Bonuses$/i.test(section.heading) || field === 'level')) {
            const number = numeric(value);
            if (!Number.isSafeInteger(number)) throw new ItemTooltipError();
            record.stats[field] = number;
        } else if (/^Enhancements$/i.test(section?.heading ?? '')) {
            const number = numeric(value);
            if (record.enhancements.length >= 64 || number < 0 || number > 100000) throw new ItemTooltipError();
            record.enhancements.push({ name: label, value: number });
        } else if (/^Durability$/i.test(label)) {
            const durability = value.match(/^(\d+)\s*\/\s*(\d+)$/);
            if (!durability || !durability.slice(1).every(part => Number.isSafeInteger(Number(part))) || Number(durability[1]) > Number(durability[2])) throw new ItemTooltipError();
            record.details.durability = { current: Number(durability[1]), max: Number(durability[2]) };
        }
    }
    if (pieces.length) record.details.setPieces = pieces;
    return { found: true, record };
}

const truncate = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const markdown = value => String(value).replace(/([\\`*_{}[\]()<>])/g, '\\$1');

/** Builds a bounded, mention-free release announcement from actual tooltip data.
 * @param {object} record Parsed item record.
 * @param {string} discoveredAt ISO discovery timestamp.
 * @returns {object} Discord webhook body.
 */
export function itemReleaseMessage(record, discoveredAt) {
    const fields = [];
    if (record.stats.level != null) fields.push({ name: 'Min level', value: String(record.stats.level), inline: true });
    if (record.details.durability) fields.push({ name: 'Durability', value: `${record.details.durability.current} / ${record.details.durability.max}`, inline: true });
    const bonuses = Object.entries(record.stats).filter(([key]) => !['type', 'level'].includes(key)).map(([key, value]) => `${key.replace(/^./, c => c.toUpperCase())}: ${value >= 0 ? '+' : ''}${value}`).join('\n');
    if (bonuses) fields.push({ name: 'Bonuses', value: truncate(bonuses, 1024) });
    if (record.enhancements.length) fields.push({ name: 'Enhancements', value: truncate(record.enhancements.map(entry => `${markdown(entry.name)}: +${entry.value}`).join('\n'), 1024) });
    if (record.details.setPieces?.length) fields.push({ name: 'Set pieces', value: truncate(record.details.setPieces.map(markdown).join('\n'), 1024) });
    return { allowed_mentions: { parse: [] }, embeds: [{
        title: truncate(`New item discovered: ${record.name}`, 256), url: itemTooltipUrl(record.id),
        description: `${markdown(record.stats.type)} • ${markdown(record.rarity)}\nGuide verification pending.`,
        color: record.details.nameColor ? Number.parseInt(record.details.nameColor.slice(1), 16) : 0x2f6fde,
        thumbnail: { url: record.imageUrl }, fields, timestamp: discoveredAt,
        footer: { text: `Upcoming item #${record.id}` },
    }] };
}
