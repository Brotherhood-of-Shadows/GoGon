import { load } from 'cheerio';
import { MAX_TOOLTIP_ITEM_ID, itemTooltipUrl } from './contracts/itemTooltip.js';
import { MAX_RESPONSE_BYTES } from './contracts/classify.js';
import { itemStatField, parseItemType } from './guideParsers.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** A malformed tooltip is never interpreted as an unused ID. `detail` is a bounded, code-built
 * structural summary (public item names/types and layout only), never response HTML. */
export class ItemTooltipError extends Error {
    constructor(message = 'Unrecognized item tooltip.', code = 'invalid_tooltip', detail = null) { super(message); this.name = 'ItemTooltipError'; this.code = code; this.detail = detail; }
}

const MAX_DETAIL_LENGTH = 480;
const printable = (value, max) => {
    const text = clean(value).replace(/\p{C}/gu, '');
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

// Describes each item-tip table so an owner can see why a live response was ambiguous without
// retaining HTML: its name/type, enclosing element path and nearest preceding label text.
function describeTables($, tables) {
    const parts = tables.toArray().slice(0, 4).map((element, index) => {
        const node = $(element);
        const path = node.parents().toArray().reverse().filter(parent => !['html', 'tbody'].includes(parent.tagName))
            .map(parent => `${parent.tagName}${parent.attribs?.class ? `.${parent.attribs.class.trim().split(/\s+/)[0]}` : ''}`).join('>');
        const label = printable(node.prevAll().not('script, style, link').first().text(), 40);
        return `#${index + 1} "${printable(node.find('.item-tip-name').first().text(), 60)}" ${printable(node.find('.item-tip-type').first().text(), 40) || '-'}`
            + ` in ${printable(path, 60) || '-'}${node.parents('table').length ? ' (nested)' : ''}${label ? ` after "${label}"` : ''}`;
    });
    return printable(`${tables.length} item-tip tables: ${parts.join('; ')}`, MAX_DETAIL_LENGTH);
}

// One top-level tooltip table, or several byte-identical copies of it once whitespace is
// collapsed. Distinct or nested tables stay rejected: choosing one could announce a different
// item (for example an equipped comparison) under the requested ID.
function singleItemTable($) {
    const tables = $('table.item-tip');
    if (tables.length <= 1) return tables;
    if (tables.filter((_, element) => $(element).parents('table.item-tip').length > 0).length)
        throw new ItemTooltipError('Nested item tables.', 'nested_item_tables', describeTables($, tables));
    const copies = new Set(tables.toArray().map(element => clean($.html(element)).replace(/>\s+</g, '><')));
    if (copies.size === 1) return tables.first();
    throw new ItemTooltipError('Multiple item tables.', 'multiple_item_tables', describeTables($, tables));
}

function numeric(value) {
    const normalized = value.replace(/,/g, '').replace(/\u2212/g, '-');
    if (!/^[+-]?\d+(?:\.\d+)?%?$/.test(normalized)) throw new ItemTooltipError('Invalid item tooltip number.', 'invalid_number');
    const result = Number(normalized.replace(/%$/, ''));
    if (!Number.isFinite(result) || Math.abs(result) > 1e12) throw new ItemTooltipError('Item tooltip number is out of range.', 'number_out_of_range');
    return result;
}

// Per-account state shown by the game, not item data; never stored or announced.
const ACCOUNT_STATE_LABELS = /^recipe known$/i;
const MAX_COMPACT_DETAIL_TABLES = 8;

// Visible lines of one cell: paragraphs/blocks become separate lines; a line break inside one
// joins its parts ("Egg (Rare Potion): Conserve [300, 60m]") so names keep their descriptions.
function cellLines($, cell) {
    const node = $(cell).clone();
    node.find('br').replaceWith(': ');
    node.find('p, div, li').each((_, element) => { $(element).prepend('\n').append('\n'); });
    return node.text().split('\n').map(clean).filter(Boolean);
}

// A two-cell "Label:" / value row stays one entry; any other row lists each cell's lines.
function rowEntries($, row) {
    const cells = $(row).children('td').toArray().map(cell => cellLines($, cell)).filter(lines => lines.length);
    if (cells.length === 2 && cells[0].length === 1 && /:$/.test(cells[0][0])) {
        const label = cells[0][0].replace(/:$/, '').trim();
        const value = cells[1].join(' ');
        return [{ text: `${label}: ${value}`, label, value }];
    }
    return cells.flat().map(text => ({ text }));
}

// Quest, resource, recipe, component, container and stash tooltips use the compact legacy table
// rather than the equipment item-tip classes, with details either in its own rows or in detail
// tables one level deep. Require one isolated table, a named font header and a type row so full
// login/error pages cannot be mistaken for items. Keep descriptive rows; only Min Level becomes a
// stat, and no equipment stats or rarity are invented.
function compactTooltip($, id) {
    const content = $('body').children().not('script, link, style');
    if (!content.filter('table').length) throw new ItemTooltipError('Item table is missing.', 'tooltip_table_missing');
    const roots = content;
    const headerRow = roots.children('tbody').children('tr').first();
    const detailTables = roots.find('table');
    if (content.length !== 1 || !content.is('table') || headerRow.find('table').length || detailTables.find('table').length || detailTables.length > MAX_COMPACT_DETAIL_TABLES)
        throw new ItemTooltipError('Ambiguous compact item document.', 'compact_layout_invalid');
    const header = headerRow.children('td');
    const blocks = header.children('center').children('div');
    const nameNode = blocks.first().find('nobr > font > b');
    const name = clean(nameNode.text());
    const typeText = clean(blocks.eq(1).text());
    const { type, rarity } = parseItemType(typeText);
    if (header.length !== 1 || nameNode.length !== 1 || !name || name.length > 191 || !type || type.length > 64 || (rarity?.length ?? 0) > 64 || typeText.length > 131) throw new ItemTooltipError('Invalid compact item header.', 'compact_header_invalid');
    const entries = roots.find('tr').toArray().filter(row => row !== headerRow[0] && !$(row).find('table').length)
        .flatMap(row => rowEntries($, row)).filter(entry => !ACCOUNT_STATE_LABELS.test(entry.label ?? ''));
    const rows = entries.map(entry => entry.text);
    const headerDetails = blocks.toArray().slice(2).map(block => clean($(block).text())).filter(Boolean);
    if (rows.length > 100 || rows.some(text => text.length > 8192) || headerDetails.length > 16 || headerDetails.some(text => text.length > 512)) throw new ItemTooltipError();
    const record = { id, name, imageUrl: `https://cdn2.fallensword.com/items/${id}.gif`, stats: { type },
        details: { tooltipRows: rows } };
    const level = entries.find(entry => entry.label && itemStatField(entry.label) === 'level');
    if (level) {
        if (!/^\d{1,9}$/.test(level.value)) throw new ItemTooltipError('Invalid compact item level.', 'invalid_number');
        record.stats.level = Number(level.value);
    }
    if (rarity) record.rarity = rarity;
    const color = nameNode.parent().attr('color');
    if (/^#[0-9a-f]{6}$/i.test(color ?? '')) record.details.nameColor = color;
    if (headerDetails.length) record.details.typeDetails = headerDetails;
    const notes = [...new Set(roots.find('.item-tip-note').toArray().map(node => clean($(node).text())).filter(Boolean))];
    if (notes.length) record.details.notes = notes;
    return { found: true, record };
}

/** Parses the owner's fetchitem HTML, preserving extra tooltip fields without inventing Guide data.
 * @param {string} html Raw successful response.
 * @param {number} id Requested item ID.
 * @returns {{found: false}|{found: true, record: object}} Typed provisional item.
 */
export function parseItemTooltip(html, id) {
    if (!Number.isInteger(id) || id < 1 || id > MAX_TOOLTIP_ITEM_ID || typeof html !== 'string' || Buffer.byteLength(html) > MAX_RESPONSE_BYTES) throw new ItemTooltipError('Invalid item input or size.', 'input_invalid');
    if (html.trim() === 'Invalid Request') return { found: false };
    const $ = load(html);
    const table = singleItemTable($);
    if (table.length === 0) return compactTooltip($, id);
    const name = clean(table.find('.item-tip-name').text());
    const typeText = clean(table.find('.item-tip-type').first().text());
    const { type, rarity } = parseItemType(typeText);
    if (!name || name.length > 191 || !type || type.length > 64 || (rarity?.length ?? 0) > 64 || typeText.length > 131) throw new ItemTooltipError('Invalid item header.', 'item_header_invalid');
    const record = { id, name, imageUrl: `https://cdn2.fallensword.com/items/${id}.gif`, stats: { type }, enhancements: [], details: { tooltipSections: [] } };
    if (rarity) record.rarity = rarity;
    const typeDetails = table.find('.item-tip-type').toArray().slice(1).map(element => clean($(element).text())).filter(Boolean);
    if (typeDetails.length > 16 || typeDetails.some(value => value.length > 512)) throw new ItemTooltipError();
    if (typeDetails.length) record.details.typeDetails = typeDetails;
    const color = table.find('.item-tip-name font').attr('color');
    if (/^#[0-9a-f]{6}$/i.test(color ?? '')) record.details.nameColor = color;
    const notes = table.find('.item-tip-note').toArray().map(node => clean($(node).text())).filter(Boolean);
    if (notes.length > 100 || notes.some(text => text.length > 8192)) throw new ItemTooltipError();
    if (notes.length) record.details.notes = [...new Set(notes)];
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
        if (!label) {
            const text = clean(cells.not('.item-tip-section').text());
            if (text && section && !(piece && /^Set Details/i.test(section.heading))) {
                if (text.length > 8192 || section.entries.length >= 100) throw new ItemTooltipError();
                section.entries.push({ text });
            }
            continue;
        }
        if (!value || label.length > 191 || value.length > 512 || (section?.entries.length ?? 0) >= 100) throw new ItemTooltipError('Invalid item row.', 'item_row_invalid');
        section?.entries.push({ label, value });
        if (!section) {
            record.details.otherFields ??= [];
            if (record.details.otherFields.length >= 100) throw new ItemTooltipError();
            record.details.otherFields.push({ label, value });
        }
        const field = itemStatField(label);
        if (field === 'type' && value.length <= 64) record.stats.type = parseItemType(value).type;
        else if (field && (!section || /^Bonuses$/i.test(section.heading) || field === 'level')) {
            const number = numeric(value);
            if (!Number.isSafeInteger(number)) throw new ItemTooltipError();
            record.stats[field] = number;
        } else if (/^Enhancements$/i.test(section?.heading ?? '')) {
            const number = numeric(value);
            if (record.enhancements.length >= 64 || number < 0 || number > 100000) throw new ItemTooltipError();
            record.enhancements.push({ name: label, value: number });
        } else if (/^Durability$/i.test(label)) {
            const durability = value.match(/^(\d+)\s*\/\s*(\d+)$/);
            if (!durability || !durability.slice(1).every(part => Number.isSafeInteger(Number(part))) || Number(durability[1]) > Number(durability[2])) throw new ItemTooltipError('Invalid item durability.', 'durability_invalid');
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
    if (record.enhancements?.length) fields.push({ name: 'Enhancements', value: truncate(record.enhancements.map(entry => `${markdown(entry.name)}: +${entry.value}`).join('\n'), 1024) });
    if (record.details.setPieces?.length) fields.push({ name: 'Set pieces', value: truncate(record.details.setPieces.map(markdown).join('\n'), 1024) });
    if (record.details.tooltipRows?.length) {
        // Min Level already has its own field.
        const rows = record.details.tooltipRows.filter(row => record.stats.level == null || itemStatField(row.split(':')[0]) !== 'level');
        if (rows.length) fields.push({ name: 'Item details', value: truncate([...new Set(rows)].map(markdown).join('\n'), 1024) });
    } else {
        const extra = (record.details.tooltipSections ?? []).filter(section => !/^(Bonuses|Enhancements|Set Details)/i.test(section.heading))
            .map(section => `${section.heading}: ${section.entries.map(entry => entry.text ?? `${entry.label}: ${entry.value}`).join('; ')}`);
        extra.push(...record.details.notes ?? []);
        if (extra.length) fields.push({ name: 'Item details', value: truncate([...new Set(extra)].map(markdown).join('\n'), 1024) });
    }
    return { allowed_mentions: { parse: [] }, embeds: [{
        title: truncate(`New item discovered: ${record.name}`, 256), url: itemTooltipUrl(record.id),
        description: `${[record.stats.type, record.rarity].filter(Boolean).map(markdown).join(' • ')}\nGuide verification pending.`,
        color: record.details.nameColor ? Number.parseInt(record.details.nameColor.slice(1), 16) : 0x2f6fde,
        thumbnail: { url: record.imageUrl }, fields, timestamp: discoveredAt,
        footer: { text: `Upcoming item #${record.id}` },
    }] };
}
