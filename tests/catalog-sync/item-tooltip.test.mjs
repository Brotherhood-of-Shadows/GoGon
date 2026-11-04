import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseItemTooltip, ItemTooltipError, itemReleaseMessage } from '../../catalog/itemTooltip.js';
import { itemTooltipUrl, assertItemTooltipUrl } from '../../catalog/contracts/itemTooltip.js';
import { parseItemDetail, itemStatField } from '../../catalog/guideParsers.js';
import { parseHTML } from 'linkedom';

const html = readFileSync('tests/catalog-sync/fixtures/item-tooltip.html', 'utf8');
const quest = readFileSync('tests/catalog-sync/fixtures/item-tooltip-quest.html', 'utf8');
const epic = readFileSync('tests/catalog-sync/fixtures/item-tooltip-epic-weapon.html', 'utf8');

test('owner 17070 Twangy’s Axe parses its actual equipment HTML, full document and helper-injected tags', () => {
    const helperTags = '<link type="text/css" rel="stylesheet" href="https://fallenswordhelper.github.io/fallenswordhelper/resources/prod/1524/calfSystem.min.css"><script async="" src="https://www.googletagmanager.com/gtag/js?id=G-14Y99WX8XL"></script>';
    assert.deepEqual(parseItemTooltip(epic.replace('</body>', `${helperTags}</body>`), 17070), parseItemTooltip(epic, 17070));
    const { found, record } = parseItemTooltip(epic, 17070);
    assert.equal(found, true);
    assert.equal(record.name, 'Twangy’s Axe');
    assert.equal(record.rarity, 'Epic');
    assert.deepEqual(record.stats, { type: 'Weapon', attack: 16940, damage: 7260, stamina: 400, staminaGain: 9, xpGain: 8, level: 6000 });
    assert.equal(record.enhancements.length, 12);
    assert.ok(record.enhancements.every(enhancement => enhancement.value === 100));
    assert.deepEqual(record.details.durability, { current: 160, max: 160 });
    assert.equal(itemReleaseMessage(record, '2026-11-03T00:00:00.000Z').embeds[0].title, 'New item discovered: Twangy’s Axe');
});

test('compact tooltips accept the same harmless trailing helper tags as equipment without executing scripts', () => {
    const wrapper = `<html><body>${quest}<link rel="stylesheet" href="https://example.invalid/a.css"><script>throw new Error('must never execute')</script></body></html>`;
    assert.deepEqual(parseItemTooltip(wrapper, 17069), parseItemTooltip(quest, 17069));
    assert.throws(() => parseItemTooltip(`<main>Please sign in</main>${wrapper}`, 17069), error => error.code === 'compact_layout_invalid');
});

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
    for (const body of ['', '<html>Maintenance</html>', '<html>Please log in</html>', '<p>Invalid Request</p>', html.replace('+8803', 'unknown'), html.replace('160&nbsp;/&nbsp;160', '161/160'), html + html.replace('Cuirass of Encillious', 'Other item'), 'x'.repeat(2_100_000)]) {
        assert.throws(() => parseItemTooltip(body, 17060), ItemTooltipError);
    }
    assert.deepEqual(parseItemTooltip(html.repeat(2), 17060), parseItemTooltip(html, 17060), 'identical copies describe one item');
    for (const id of [0, -1, 1.5, 10_000_001]) assert.throws(() => parseItemTooltip(html, id), ItemTooltipError);
});

test('tooltip transport permits only the exact read-only item URL', () => {
    assert.equal(assertItemTooltipUrl(itemTooltipUrl(17060)), 'https://www.fallensword.com/fetchitem.php?item_id=17060&inv_id=-1&t=0&extra=0');
    for (const url of ['https://evil.example/fetchitem.php?item_id=1', itemTooltipUrl(1) + '&action=buy', itemTooltipUrl(1).replace('inv_id=-1', 'inv_id=1'), itemTooltipUrl(1).replace('https:', 'http:')]) assert.throws(() => assertItemTooltipUrl(url));
});

test('identical repeated tooltip tables parse once; distinct or nested tables are rejected with a safe structural summary', () => {
    const table = epic.match(/<table[\s\S]*<\/table>/)[0];
    const repeated = `<html><body>${table}\n  ${table.replace(/> </g, '>\n    <')}</body></html>`;
    assert.deepEqual(parseItemTooltip(repeated, 17070), parseItemTooltip(epic, 17070));

    const equipped = table.replace('Twangy’s Axe', 'Equipped Blade').replace('Weapon - Epic', 'Weapon - Rare');
    const compare = `<html><body>${table}<div class="compare"><b>Currently Equipped</b>${equipped}</div><script>var fsRequestToken = 'secret-token';</script></body></html>`;
    assert.throws(() => parseItemTooltip(compare, 17070), error => {
        assert.equal(error.code, 'multiple_item_tables');
        assert.equal(error.detail, '2 item-tip tables: #1 "Twangy’s Axe" Weapon - Epic in body; #2 "Equipped Blade" Weapon - Rare in body>div.compare after "Currently Equipped"');
        return true;
    });

    const nested = table.replace('<td colspan="2" class="item-tip-section">Bonuses</td>', `<td colspan="2">${equipped}</td>`);
    assert.throws(() => parseItemTooltip(nested, 17070), error => error.code === 'nested_item_tables' && /\(nested\)/.test(error.detail));

    const many = `<body>${Array.from({ length: 9 }, (_, n) => table.replace('Twangy’s Axe', `Item ${n} ${'x'.repeat(80)}\u0007`)).join('')}</body>`;
    assert.throws(() => parseItemTooltip(many, 17070), error => error.detail.length <= 480 && !/\p{C}/u.test(error.detail) && error.detail.startsWith('9 item-tip tables'));
});

const compact = name => readFileSync(`tests/catalog-sync/fixtures/item-tooltip-compact-${name}.html`, 'utf8');

test('owner compact tooltips with nested detail tables parse recipes, components, containers, stashes and resources', () => {
    const image = id => `https://cdn2.fallensword.com/items/${id}.gif`;
    assert.deepEqual(parseItemTooltip(compact('recipe'), 17071).record, { id: 17071, name: 'Recipe of Twangy’s Axe', imageUrl: image(17071), rarity: 'Epic',
        stats: { type: 'Recipe', level: 5900 }, details: { tooltipRows: ['Min Level: 5900'], nameColor: '#00CC00' } });
    assert.deepEqual(parseItemTooltip(compact('component'), 17072).record, { id: 17072, name: 'Shimmering Blue Feathers', imageUrl: image(17072), rarity: 'Unique',
        stats: { type: 'Component' }, details: { tooltipRows: ['Used in recipes:', 'Peacock Headdress', 'Peacock Collared Cloak', 'Peacock Gloves'], nameColor: '#CC00CC' } });
    assert.deepEqual(parseItemTooltip(compact('container'), 17073).record, { id: 17073, name: 'Average Easter Basket', imageUrl: image(17073), rarity: 'Rare',
        stats: { type: 'Container' }, details: { tooltipRows: ['Open this container to choose one of the items below.', 'Items:',
            'Average Dark Choco Egg (Rare Potion): Coordinated Defense [325, 60m], Flinch [325, 60m], Last Ditch [200, 60m]',
            'Average White Choco Egg (Rare Potion): Conserve [300, 60m], Animal Magnetism [350, 60m], Doubler [700, 60m]',
            'Simple Dark Choco Egg (Common Potion): Coordinated Defense [225, 30m], Flinch [225, 30m]',
            'Simple White Choco Egg (Common Potion): Conserve [200, 30m], Animal Magnetism [300, 30m]'], nameColor: '#00CCCC', typeDetails: ['Bound (Non-Tradable)'] } });
    assert.deepEqual(parseItemTooltip(compact('fragment-stash'), 17074).record, { id: 17074, name: 'Bunnies Discarded Egg Wrapper', imageUrl: image(17074), rarity: 'Rare',
        stats: { type: 'Fragment Stash' }, details: { tooltipRows: ['Open this fragment stash to add its contents to your current Composing Fragments. This stash can contain the following:',
            'Common: 10 - 15', 'Rare: 5 - 10', 'Unique: 1 - 5', 'Legendary: 0 - 1', 'Crystalline: 0 - 1'], nameColor: '#00CCCC', typeDetails: ['Bound (Non-Tradable)'] } });
    assert.deepEqual(parseItemTooltip(compact('resource'), 17075).record, { id: 17075, name: 'Abomination Corpse', imageUrl: image(17075), rarity: 'Legendary',
        stats: { type: 'Resource' }, details: { tooltipRows: ['Used in recipes:'], nameColor: '#FFCC00' } });
});

test('compact recipe announcement shows Min Level once and never the bot account’s Recipe Known state', () => {
    const { record } = parseItemTooltip(compact('recipe'), 17071);
    assert.doesNotMatch(JSON.stringify(record), /Recipe Known|\bNo\b/);
    const embed = itemReleaseMessage(record, '2026-11-03T00:00:00.000Z').embeds[0];
    assert.equal(embed.description, 'Recipe • Epic\nGuide verification pending.');
    assert.deepEqual(embed.fields, [{ name: 'Min level', value: '5900', inline: true }]);
    const stash = itemReleaseMessage(parseItemTooltip(compact('fragment-stash'), 17074).record, '2026-11-03T00:00:00.000Z').embeds[0];
    assert.match(stash.fields.find(field => field.name === 'Item details').value, /^Open this fragment stash[\s\S]*\nCommon: 10 - 15\n[\s\S]*Crystalline: 0 - 1$/);
});

test('compact detail tables stay one level deep, outside the header, and keep a numeric Min Level', () => {
    const recipe = compact('recipe');
    const inner = '<table><tr><td>x</td></tr></table>';
    for (const body of [
        recipe.replace('<font color="#999999">Min Level:</font>', `<font color="#999999">Min Level:</font>${inner}`),
        recipe.replace('<div>Recipe - Epic</div>', `<div>Recipe - Epic</div>${inner}`),
        recipe.replace('</tbody></table></body>', `${`<tr><td>${inner}</td></tr>`.repeat(8)}</tbody></table></body>`),
    ]) assert.throws(() => parseItemTooltip(body, 17071), error => error.code === 'compact_layout_invalid');
    assert.throws(() => parseItemTooltip(recipe.replace('>5900<', '>about 5900<'), 17071), error => error.code === 'invalid_number');
    assert.throws(() => parseItemTooltip(`${recipe}${recipe}`, 17071), error => error.code === 'compact_layout_invalid');
});

const comparison = readFileSync('tests/catalog-sync/fixtures/item-tooltip-comparison.html', 'utf8');

test('equipped-item comparison yields the requested item only and never stores the equipped one', () => {
    assert.deepEqual(parseItemTooltip(comparison, 17070), parseItemTooltip(epic, 17070));
    assert.doesNotMatch(JSON.stringify(parseItemTooltip(comparison, 17070)), /Iklilian|Excellent|15210|148/);
    const [requested, equipped] = comparison.match(/<table width="250"[\s\S]*?<\/table>/g);
    const sameCell = `<html><body><table><tr><td>${requested}<br>${equipped}</td></tr></table></body></html>`;
    assert.equal(parseItemTooltip(sameCell, 17070).record.name, 'Twangy’s Axe');
    const labelled = comparison.replace(`<td valign="top">${equipped}`, `<td valign="top"><b>Currently Equipped</b>${equipped}`);
    assert.equal(parseItemTooltip(labelled, 17070).record.name, 'Twangy’s Axe');
});

test('only the exact two-cell comparison wrapper is accepted; other multi-item documents stay ambiguous', () => {
    const [requested, equipped] = comparison.match(/<table width="250"[\s\S]*?<\/table>/g);
    const cell = table => `<td>${table}</td>`;
    for (const body of [
        `<html><body><table><tr>${cell(requested)}${cell(equipped)}${cell(equipped.replace("Iklilian's", 'Third'))}</tr></table></body></html>`,
        `<html><body><table><tr>${cell(requested)}</tr></table><table><tr>${cell(equipped)}</tr></table></body></html>`,
        `<html><body><p>Market listing</p><table><tr>${cell(requested)}${cell(equipped)}</tr></table></body></html>`,
        `<html><body><table><tr>${cell(requested)}${cell(equipped)}<td><table><tr><td>Other</td></tr></table></td></tr></table></body></html>`,
        `<html><body><table><tr>${cell(requested)}${cell(equipped)}<td>${'Long page text '.repeat(10)}</td></tr></table></body></html>`,
        `<html><body><div>${requested}${equipped}</div></body></html>`,
    ]) assert.throws(() => parseItemTooltip(body, 17070), error => error.code === 'multiple_item_tables', body.slice(0, 80));
});
