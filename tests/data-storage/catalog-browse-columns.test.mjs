// tests/data-storage/catalog-browse-columns.test.mjs - specs/tasks/2026-11-guide-browse.md (AC-9)
// Migration 023's virtual browse columns, on the in-process fake and (CI) on real MySQL 8.4: total
// expressions that never reject a write, idempotent re-runs, and the fake's guarded translation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { translate } from '../helpers/fake-mysql.mjs';
import { up } from '../../_gg_data/migrations/023_catalog_browse_columns.mjs';

after(closeClients);

test('AC-9: browse columns hold the typed JSON value or NULL, and no stats value can reject a write', async () => {
    const db = await freshClient();
    const rows = [
        [1, '{not json'],
        [2, null],
        [3, JSON.stringify({ type: null, level: null })],
        [4, JSON.stringify({ type: 5, level: 'x' })],
        [5, JSON.stringify({ type: ['Helmet'], level: 1.5 })],
        [6, JSON.stringify({ type: 'Helmet', level: 6000 })],
        [7, JSON.stringify({ type: 'T'.repeat(80), level: -3 })],
        [8, '{}'],
    ];
    for (const [id, stats] of rows) await db.query('INSERT INTO items (id, name, stats) VALUES (?, ?, ?)', [id, `Item ${id}`, stats]);
    await db.query('INSERT INTO creatures (id, name, stats) VALUES (?, ?, ?), (?, ?, ?)',
        [1, 'Rat', JSON.stringify({ class: 'Beast', level: 12 }), 2, 'Broken', 'garbage']);
    const items = (await db.query('SELECT id, stat_type, stat_level FROM items ORDER BY id'))
        .map(row => [Number(row.id), row.stat_type, row.stat_level === null ? null : Number(row.stat_level)]);
    assert.deepEqual(items, [
        [1, null, null], [2, null, null], [3, null, null], [4, null, null], [5, null, null],
        [6, 'Helmet', 6000], [7, 'T'.repeat(64), -3], [8, null, null],
    ]);
    const creatures = (await db.query('SELECT id, stat_class, stat_level FROM creatures ORDER BY id'))
        .map(row => [Number(row.id), row.stat_class, row.stat_level === null ? null : Number(row.stat_level)]);
    assert.deepEqual(creatures, [[1, 'Beast', 12], [2, null, null]]);

    // Updates recompute the columns; writers never name them.
    await db.query('UPDATE items SET stats = ? WHERE id = ?', [JSON.stringify({ type: 'Ring', level: 10 }), 1]);
    await db.query('UPDATE items SET stats = ? WHERE id = ?', ['{broken', 6]);
    const [one] = await db.query('SELECT stat_type, stat_level FROM items WHERE id = 1');
    const [six] = await db.query('SELECT stat_type, stat_level FROM items WHERE id = 6');
    assert.deepEqual([one.stat_type, Number(one.stat_level), six.stat_type, six.stat_level], ['Ring', 10, null, null]);
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM items WHERE stat_type = ? AND stat_level BETWEEN ? AND ?', ['Ring', 1, 100]))[0].n == 1, true);
});

test('AC-9: migration 023 is safe to run again', async () => {
    const db = await freshClient();
    await up(db);
    await up(db);
    await db.query('INSERT INTO items (id, name, stats) VALUES (?, ?, ?)', [9, 'Again', JSON.stringify({ type: 'Boots', level: 2 })]);
    const [row] = await db.query('SELECT stat_type FROM items WHERE id = 9');
    assert.equal(row.stat_type, 'Boots');
});

test('the fake translates only the guarded JSON_TYPE/JSON_VALUE forms', () => {
    const [sql] = translate("SELECT CASE WHEN JSON_VALID(stats) THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(stats, '$.level')) = 'INTEGER' THEN JSON_VALUE(stats, '$.level' RETURNING SIGNED) END END FROM items");
    assert.equal(sql, "SELECT CASE WHEN JSON_VALID(stats) THEN CASE WHEN json_type(stats, '$.level') = 'integer' THEN json_extract(stats, '$.level') END END FROM items");
    assert.throws(() => translate('SELECT JSON_TYPE(stats) FROM items'), /cannot translate/);
    assert.throws(() => translate("SELECT JSON_VALUE(stats, '$.a' RETURNING DECIMAL) FROM items"), /cannot translate/);
});
