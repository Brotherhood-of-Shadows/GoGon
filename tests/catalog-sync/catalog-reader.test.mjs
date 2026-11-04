// tests/catalog-sync/catalog-reader.test.mjs - specs/tasks/2026-11-guide-catalog-reader.md
// The read model behind Discord /guide, on the fake MySQL (real MySQL in CI). Serving rows are
// inserted directly; catalog state comes from the real ingest path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createCatalogStore, CatalogError } from '../../_gg_data/handler/catalogStore.js';
import { createCatalogReader, INCOMPLETE_REASON_LABELS } from '../../catalog/catalogReader.js';
import { parseQuestDetail, parseRelicDetail } from '../../catalog/guideParsers.js';

after(closeClients);

const json = value => JSON.stringify(value);
const doc = name => parseHTML(readFileSync(`tests/catalog-sync/fixtures/${name}`, 'utf8')).document;

async function setup() {
    const db = await freshClient();
    const store = createCatalogStore(db, { invalidateCaches: () => {} });
    const relic = parseRelicDetail(doc('guide-relic-live.html'), 600);
    const quest = parseQuestDetail(doc('guide-quest-live.html'), 160);
    await db.query('INSERT INTO master_realms (id, name, min_level, connected_realms) VALUES (?, ?, ?, ?)',
        [5, 'Elya Desert', 5, json([{ realmId: 9, realmName: 'Mountain Path', minLevel: 1 }, { realmId: 4444, realmName: 'Unread Realm', minLevel: 9 }])]);
    await db.query('INSERT INTO realms (id, name, min_level, master_realm_id, shops, connections) VALUES (?, ?, ?, ?, ?, ?)',
        [9, 'Mountain Path', 1, 5, json([{ shopId: 3, shopName: 'Trader Outpost' }]), json([{ targetRealmId: 7096, targetRealmName: 'Kanarak Forest (Frenzy)' }, { targetRealmId: 9999, targetRealmName: 'Hidden Vale' }])]);
    await db.query('INSERT INTO realms (id, name, min_level, master_realm_id) VALUES (?, ?, ?, ?)', [7096, 'Kanarak Forest (Frenzy)', 3500, 5]);
    await db.query('INSERT INTO items (id, name, rarity, imageUrl, stats, enhancements, setId, setName, setBonuses, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        17070, 'Twangy’s Axe', 'Epic', 'https://cdn2.fallensword.com/items/17070.gif',
        json({ type: 'Weapon', level: 6000, attack: 16940, damage: 7260 }), json([{ name: 'Dodge', value: 100 }]), 77, 'Twangy Set',
        json({ attack: 50, enhancements: [{ name: 'Duelist', value: 5 }] }), json({ durability: { current: 160, max: 160 }, notes: ['Used in recipes'] })]);
    await db.query('INSERT INTO items (id, name, rarity, stats, setId) VALUES (?, ?, ?, ?, ?)', [17071, 'Twangy Helm', 'Epic', json({ type: 'Helmet', level: 6000 }), 77]);
    await db.query('INSERT INTO items (id, name, stats) VALUES (?, ?, ?)', [17069, 'Twangy Core', json({ type: 'Quest' })]);
    await db.query('INSERT INTO items (id, name, stats) VALUES (?, ?, ?)', [12, 'Broken Data', '{not json']);
    await db.query('INSERT INTO creatures (id, name, stats, enhancements, description) VALUES (?, ?, ?, ?, ?)', [
        2277, 'Glacial Rat', json({ class: 'Beast', level: 1, attack: { min: 1, max: 3 }, hp: { min: 5, max: 9 } }), json(['Dodge 5%']), 'A small rat.']);
    await db.query('INSERT INTO realm_creatures (realm_id, creature_id) VALUES (?, ?)', [9, 2277]);
    await db.query('INSERT INTO creature_drops (creature_id, item_id) VALUES (?, ?)', [2277, 17070]);
    await db.query('INSERT INTO relics (id, realm_id, name, details) VALUES (?, ?, ?, ?)', [41, 7096, relic.name, json({ sections: relic.sections })]);
    await db.query('INSERT INTO quests (id, realm_id, name, min_level, details) VALUES (?, ?, ?, ?, ?)', [51, 9, quest.name, quest.minLevel, json({ sections: quest.sections })]);
    await store.ingest({ mode: 'observe_realm', source: 'game_session', observations: [{ kind: 'item', payload: { id: 17070, name: 'Twangy’s Axe' } }] });
    return { db, store, reader: createCatalogReader({ db }), relic, quest };
}

test('search ranks prefix matches, then shorter names, caps at 25 and disambiguates with hints', async () => {
    const { db, reader } = await setup();
    for (let n = 0; n < 30; n++) await db.query('INSERT INTO items (id, name, stats) VALUES (?, ?, ?)', [20000 + n, `Old Twangy Relic ${n}`, json({ type: 'Ring' })]);
    const results = await reader.search('item', 'TWANGY');
    assert.equal(results.length, 25);
    assert.deepEqual(results.slice(0, 4), [
        { kind: 'item', id: 17069, name: 'Twangy Core', hint: 'Quest' },
        { kind: 'item', id: 17070, name: 'Twangy’s Axe', hint: 'Weapon • Epic • Lvl 6000' },
        { kind: 'item', id: 17071, name: 'Twangy Helm', hint: 'Helmet • Epic • Lvl 6000' },
        { kind: 'item', id: 20000, name: 'Old Twangy Relic 0', hint: 'Ring' },
    ].sort((a, b) => Number(!a.name.toLowerCase().startsWith('twangy')) - Number(!b.name.toLowerCase().startsWith('twangy')) || a.name.length - b.name.length || a.id - b.id));
    assert.deepEqual((await reader.search('relic', 'circle')).map(r => [r.id, r.hint]), [[41, 'Kanarak Forest (Frenzy)']]);
    assert.deepEqual((await reader.search('quest', 'bandits')).map(r => [r.id, r.hint]), [[51, 'Mountain Path • Lvl 1']]);
    assert.deepEqual((await reader.search('creature', 'rat')).map(r => r.hint), ['Beast • Lvl 1']);
    assert.deepEqual((await reader.search('item', '')).slice(0, 2).map(r => r.id), [20029, 20028], 'empty query lists newest IDs');
    assert.deepEqual(await reader.search('item', '%'), [], 'LIKE wildcards match literally');
    assert.deepEqual((await reader.findExact('item', 'twangy core')).map(r => r.id), [17069]);
});

test('cards carry each kind\'s fields and bounded relations without provenance or Guide state', async () => {
    const { reader, relic, quest } = await setup();
    const item = await reader.card('item', 17070);
    assert.deepEqual({ ...item, relations: undefined }, {
        kind: 'item', id: 17070, name: 'Twangy’s Axe', imageUrl: 'https://cdn2.fallensword.com/items/17070.gif',
        completeness: 'incomplete', reasons: ['guide_detail_missing', 'required_field_missing'], rarity: 'Epic', type: 'Weapon', level: 6000,
        stats: { attack: 16940, damage: 7260 }, enhancements: [{ name: 'Dodge', value: 100 }],
        set: { id: 77, name: 'Twangy Set', bonuses: { attack: 50, enhancements: [{ name: 'Duelist', value: 5 }] } },
        tooltip: { rows: [], notes: ['Used in recipes'], typeDetails: [], durability: { current: 160, max: 160 } }, relations: undefined,
    });
    assert.deepEqual(item.relations, {
        droppedBy: { kind: 'creature', total: 1, entries: [{ kind: 'creature', id: 2277, name: 'Glacial Rat', known: true }] },
        setPieces: { kind: 'item', total: 1, entries: [{ kind: 'item', id: 17071, name: 'Twangy Helm', known: true }] },
    });
    assert.doesNotMatch(JSON.stringify(item), /runId|provenance|attempts|observation|hash/i);

    const creature = await reader.card('creature', 2277);
    assert.deepEqual([creature.class, creature.level, creature.stats, creature.enhancements, creature.description],
        ['Beast', 1, { attack: { min: 1, max: 3 }, hp: { min: 5, max: 9 } }, ['Dodge 5%'], 'A small rat.']);
    assert.deepEqual(creature.relations.drops.entries.map(e => e.id), [17070]);
    assert.deepEqual(creature.relations.realms.entries.map(e => e.id), [9]);
    assert.equal(creature.completeness, null, 'no catalog row');

    const realm = await reader.card('realm', 9);
    assert.deepEqual([realm.minLevel, realm.masterRealm, realm.shops], [1, { kind: 'master_realm', id: 5, name: 'Elya Desert', known: true }, ['Trader Outpost']]);
    assert.deepEqual(realm.relations.stairways.entries, [
        { kind: 'realm', id: 7096, name: 'Kanarak Forest (Frenzy)', known: true },
        { kind: 'realm', id: 9999, name: 'Hidden Vale', known: false },
    ]);
    assert.deepEqual(realm.relations.quests.entries, [{ kind: 'quest', id: 51, name: 'Angry Bandits', known: true, minLevel: 1 }]);
    assert.deepEqual(realm.relations.creatures.entries.map(e => e.id), [2277]);

    const master = await reader.card('master_realm', 5);
    assert.deepEqual(master.relations.realms.entries.map(e => [e.id, e.known]), [[9, true], [4444, false], [7096, true]]);

    const relicCard = await reader.card('relic', 41);
    assert.deepEqual([relicCard.realm, relicCard.sections], [{ kind: 'realm', id: 7096, name: 'Kanarak Forest (Frenzy)', known: true }, relic.sections]);
    const questCard = await reader.card('quest', 51);
    assert.equal(questCard.minLevel, 1);
    assert.deepEqual(questCard.stages.map(s => s.heading), quest.sections.map(s => s.heading));
    assert.equal(questCard.stages.length, 9);
});

test('relations over 25 report the total; completeness labels match the dashboard wording', async () => {
    const { db, reader } = await setup();
    for (let n = 0; n < 40; n++) {
        await db.query('INSERT INTO creatures (id, name) VALUES (?, ?)', [3000 + n, `Bandit ${n}`]);
        await db.query('INSERT INTO realm_creatures (realm_id, creature_id) VALUES (?, ?)', [9, 3000 + n]);
    }
    const { creatures } = (await reader.card('realm', 9)).relations;
    assert.equal(creatures.total, 41);
    assert.equal(creatures.entries.length, 25);
    await db.query("UPDATE catalog_entities SET completeness = 'complete', incomplete_reason = NULL WHERE entity_kind = 'item'");
    assert.deepEqual((({ completeness, reasons }) => ({ completeness, reasons }))(await reader.card('item', 17070)), { completeness: 'complete', reasons: [] });
    const dashboard = readFileSync('control-plane/public/app.js', 'utf8').match(/const REASON_LABELS = (\{[\s\S]*?\});/)[1];
    assert.deepEqual(INCOMPLETE_REASON_LABELS, Function(`return (${dashboard});`)(), 'Discord and dashboard reason wording stay identical');
});

test('invalid input is refused before SQL; missing rows are null and corrupt JSON degrades to empty', async () => {
    const { reader } = await setup();
    for (const call of [() => reader.search('shop', 'x'), () => reader.search('item', 'x'.repeat(65)), () => reader.search('item', null),
        () => reader.card('item', '1 OR 1=1'), () => reader.card('item', 0), () => reader.card('item', 1.5), () => reader.findExact('item', '')]) {
        await assert.rejects(call(), error => error instanceof CatalogError && error.code === 'invalid');
    }
    assert.equal(await reader.card('item', 999999), null);
    const broken = await reader.card('item', 12);
    assert.deepEqual([broken.name, broken.stats, broken.type, broken.level], ['Broken Data', {}, null, null]);
});
