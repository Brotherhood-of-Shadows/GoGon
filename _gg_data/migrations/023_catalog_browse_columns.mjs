// 023_catalog_browse_columns.mjs - specs/tasks/2026-11-guide-browse.md (AC-9)
// /guide browse filters items by type and level and creatures by class and level. Those values live
// inside the `stats` JSON text, so they are exposed as read-only VIRTUAL columns with indexes. Each
// expression is total: NULL unless `stats` is valid JSON and the value has the expected JSON type, so
// no stored or future row can make an INSERT, UPDATE or this migration fail. Nothing writes these
// columns; MySQL keeps them current on every write path.

const level = `BIGINT AS (CASE WHEN JSON_VALID(stats) THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(stats, '$.level')) = 'INTEGER' THEN JSON_VALUE(stats, '$.level' RETURNING SIGNED) END END) VIRTUAL`;
const text = path => `VARCHAR(64) AS (CASE WHEN JSON_VALID(stats) THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(stats, '${path}')) = 'STRING' THEN SUBSTR(JSON_VALUE(stats, '${path}'), 1, 64) END END) VIRTUAL`;

export const COLUMNS = Object.freeze([
    ['items', 'stat_type', text('$.type')],
    ['items', 'stat_level', level],
    ['creatures', 'stat_class', text('$.class')],
    ['creatures', 'stat_level', level],
]);

export const INDEXES = Object.freeze([
    ['items_browse_type', 'items', 'stat_type, stat_level'],
    ['items_browse_level', 'items', 'stat_level'],
    ['items_browse_rarity', 'items', 'rarity'],
    ['creatures_browse_class', 'creatures', 'stat_class, stat_level'],
    ['creatures_browse_level', 'creatures', 'stat_level'],
]);

/** Adds the browse columns and indexes; safe to run again.
 * @param {{query: Function}} client Migration connection.
 * @returns {Promise<void>}
 */
export async function up(client) {
    for (const [table, column, definition] of COLUMNS) {
        try { await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
        catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
    }
    for (const [name, table, columns] of INDEXES) {
        try { await client.query(`CREATE INDEX ${name} ON ${table} (${columns})`); }
        catch (error) { if (error?.code !== 'ER_DUP_KEYNAME') throw error; }
    }
}
