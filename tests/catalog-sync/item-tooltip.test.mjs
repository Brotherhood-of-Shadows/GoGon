import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseItemTooltip, ItemTooltipError, itemReleaseMessage } from '../../catalog/itemTooltip.js';
import { itemTooltipUrl, assertItemTooltipUrl } from '../../catalog/contracts/itemTooltip.js';
import { parseItemDetail, itemStatField } from '../../catalog/guideParsers.js';
import { parseHTML } from 'linkedom';

const html = readFileSync('tests/catalog-sync/fixtures/item-tooltip.html', 'utf8');
const quest = readFileSync('tests/catalog-sync/fixtures/item-tooltip-quest.html', 'utf8');

test('owner Twangy Core compact tooltip preserves Quest type and usage without inventing rarity or equipment fields', () => {
    const { found, record } = parseItemTooltip(quest, 17069);
    assert.equal(found, true);
    assert.deepEqual(record, { id: 17069, name: 'Twangy Core', imageUrl: 'https://cdn2.fallensword.com/items/17069.gif', stats: { type: 'Quest' },
        details: { tooltipRows: ['Quest Usage', 'No quests found', 'Used in recipes', 'Used in recipes'], nameColor: '#00CC00', notes: ['Used in recipes'] } });
    const embed = itemReleaseMessage(record, '2026-11-03T00:00:00.000Z').embeds[0];
    assert.equal(embed.description, 'Quest\nGuide verification pending.');
    assert.equal(embed.color, 0x00cc00);
    assert.deepEqual(embed.fields, [{ name: 'Item details', value: 'Quest Usage\nNo quests found\nUsed in recipes' }]);
    assert.doesNotMatch(JSON.stringify(embed), /undefined|NaN/);
});

test('compact layout rejects full pages, ambiguous tables, missing name/type and oversized data', () => {
    for (const body of [quest + quest, `<h1>Maintenance</h1>${quest}`, quest.replace('Twangy Core', ''), quest.replace('<div>Quest</div>', '<div></div>'), quest.replace('Twangy Core', 'x'.repeat(192)), quest.replace('No quests found', 'x'.repeat(8193)), '<table><tr><td>Maintenance</td></tr></table>']) {
        assert.throws(() => parseItemTooltip(body, 17069), ItemTooltipError);
    }
});

test('Guide and both game tooltip layouts accept resources, quest items, consumables and equipment through shared type handling', () => {
    const guide = readFileSync('tests/catalog-sync/fixtures/guide-item-detail.html', 'utf8');
    for (const type of ['Resource', 'Quest', 'Quest Item', 'Potion', 'Recipe', 'Component', 'Fragment', 'Rune', 'Weapon', 'Ring', 'Amulet', 'Helmet', 'Armor', 'Shield', 'Boots', 'Gloves', 'Future item type']) {
        const game = parseItemTooltip(html.replace('Armor - Rare', type), 17060).record;
        const compact = parseItemTooltip(quest.replace('<div>Quest</div>', `<div>${type}</div>`), 17069).record;
        const fromGuide = parseItemDetail(parseHTML(guide.replace('<td>Helmet</td>', `<td>${type}</td>`)).document, 17060);
        assert.equal(game.stats.type, type);
        assert.equal(compact.stats.type, fromGuide.stats.type);
        assert.equal(game.rarity, undefined, 'rarity is optional for every item type');
        assert.equal(compact.rarity, undefined);
    }
    assert.equal(parseItemTooltip(quest.replace('<div>Quest</div>', '<div>Resource - Unique</div>'), 17069).record.rarity, 'Unique');
    for (const label of ['Armor:', 'armour', 'HP', 'Min Level', 'Level:', 'XP Gain']) assert.ok(itemStatField(label), label);
});

test('resource/recipe descriptive sections and usage notes survive without equipment-only assumptions', () => {
    const resource = html.replace('Armor - Rare', 'Resource').replace('</table>', '<tr><td class="item-tip-section" colspan=2>Extractable Components</td></tr><tr><td colspan=2>Adamantine Shard</td></tr><tr><td class="item-tip-section" colspan=2>Ingredients</td></tr><tr><td colspan=2>Core x 2</td></tr><tr><td class="item-tip-note" colspan=2>Used in recipes</td></tr></table>');
    const record = parseItemTooltip(resource, 17070).record;
    assert.deepEqual(record.details.tooltipSections.find(section => section.heading === 'Extractable Components').entries, [{ text: 'Adamantine Shard' }]);
    assert.deepEqual(record.details.notes, ['Used in recipes']);
    const payload = itemReleaseMessage(record, '2026-11-03T00:00:00.000Z');
    assert.match(payload.embeds[0].fields.find(field => field.name === 'Item details').value, /Extractable Components: Adamantine Shard/);
    assert.match(JSON.stringify(payload), /Core x 2/);
});

test('owner tooltip extracts every bonus, enhancement, set piece, level and durability', () => {
    const { found, record } = parseItemTooltip(html, 17060);
    assert.equal(found, true);
    assert.equal(record.name, 'Cuirass of Encillious');
    assert.equal(record.rarity, 'Rare');
    assert.deepEqual(record.stats, { type: 'Armor', armor: 8803, hp: 3773, level: 6284 });
    assert.deepEqual(record.enhancements, ['Protection', 'Protect Gold', 'Dodge', 'Disarm'].map(name => ({ name, value: 30 })));
    assert.deepEqual(record.details.durability, { current: 160, max: 160 });
    assert.deepEqual(record.details.setPieces, ['Shield of Encillious', 'Cuirass of Encillious']);
    assert.equal(record.imageUrl, 'https://cdn2.fallensword.com/items/17060.gif');
    const payload = itemReleaseMessage(record, '2026-11-03T00:00:00.000Z');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.embeds[0].color, 0x00cccc);
    assert.equal(payload.embeds[0].fields.find(field => field.name === 'Bonuses').value, 'Armor: +8803\nHp: +3773');
});

test('only explicit Invalid Request marks an ID as absent; malformed numbers, pages and oversized data fail closed', () => {
    assert.deepEqual(parseItemTooltip(' \nInvalid Request\n', 17060), { found: false });
    for (const body of ['', '<html>Maintenance</html>', '<html>Please log in</html>', '<p>Invalid Request</p>', html.replace('+8803', 'unknown'), html.replace('160&nbsp;/&nbsp;160', '161/160'), html.repeat(2), 'x'.repeat(2_100_000)]) {
        assert.throws(() => parseItemTooltip(body, 17060), ItemTooltipError);
    }
    for (const id of [0, -1, 1.5, 10_000_001]) assert.throws(() => parseItemTooltip(html, id), ItemTooltipError);
});

test('tooltip transport permits only the exact read-only item URL', () => {
    assert.equal(assertItemTooltipUrl(itemTooltipUrl(17060)), 'https://www.fallensword.com/fetchitem.php?item_id=17060&inv_id=-1&t=0&extra=0');
    for (const url of ['https://evil.example/fetchitem.php?item_id=1', itemTooltipUrl(1) + '&action=buy', itemTooltipUrl(1).replace('inv_id=-1', 'inv_id=1'), itemTooltipUrl(1).replace('https:', 'http:')]) assert.throws(() => assertItemTooltipUrl(url));
});
