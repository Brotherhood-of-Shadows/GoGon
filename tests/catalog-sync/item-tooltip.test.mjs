import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseItemTooltip, ItemTooltipError, itemReleaseMessage } from '../../catalog/itemTooltip.js';
import { itemTooltipUrl, assertItemTooltipUrl } from '../../catalog/contracts/itemTooltip.js';

const html = readFileSync('tests/catalog-sync/fixtures/item-tooltip.html', 'utf8');

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
