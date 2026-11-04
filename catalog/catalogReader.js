// catalog/catalogReader.js - specs/tasks/2026-11-guide-catalog-reader.md
// Read-only views of the local catalog for the Discord guide and the owner dashboard. Search and
// cards read serving rows through code-owned column lists and relation queries; caller text is
// only ever a bound parameter. Nothing here reaches the game or guide.fallensword.com, and no
// provenance, run or Guide-attempt state leaves this module.
import { CatalogError } from '../_gg_data/handler/catalogStore.js';

export const BROWSE_KINDS = Object.freeze(['item', 'creature', 'realm', 'master_realm', 'relic', 'quest']);
export const MAX_SEARCH_RESULTS = 25;
export const MAX_RELATED = 25;
export const MAX_QUERY_LENGTH = 64;
const SEARCH_CANDIDATES = 200;
const MAX_JSON_OUT = 16 * 1024;
const MAX_ID = Number.MAX_SAFE_INTEGER;

/** Plain-language incomplete reasons; keep identical to REASON_LABELS in control-plane/public/app.js. */
export const INCOMPLETE_REASON_LABELS = Object.freeze({
    manual_field_incomplete: 'some fields are awaiting Guide updates',
    guide_detail_missing: 'guide detail not read yet',
    guide_detail_failed: 'guide detail failed validation',
    required_field_missing: 'a required field is missing',
    known_drop_unresolved: 'a known drop is not in the catalog',
});

/** Serving columns each kind may return. JSON columns are parsed and size-bounded on the way out. */
export const SERVING = Object.freeze({
    item: { table: 'items', list: ['id', 'name', 'rarity', 'imageUrl'], detail: ['id', 'name', 'rarity', 'imageUrl', 'stats', 'enhancements', 'droppedBy', 'setBonuses', 'setId', 'setName', 'details'], json: ['stats', 'enhancements', 'droppedBy', 'setBonuses', 'details'] },
    creature: { table: 'creatures', list: ['id', 'name', 'imageUrl'], detail: ['id', 'name', 'imageUrl', 'description', 'stats', 'enhancements', 'droppedItems'], json: ['stats', 'enhancements', 'droppedItems'] },
    realm: { table: 'realms', list: ['id', 'name', 'min_level', 'master_realm_id'], detail: ['id', 'name', 'min_level', 'master_realm_id', 'shops', 'connections', 'map_objects'], json: ['shops', 'connections', 'map_objects'] },
    master_realm: { table: 'master_realms', list: ['id', 'name'], detail: ['id', 'name', 'min_level', 'imageUrl', 'connected_realms'], json: ['connected_realms'] },
    relic: { table: 'relics', list: ['id', 'name', 'realm_id'], detail: ['id', 'name', 'realm_id', 'details'], json: ['details'], natural: true },
    quest: { table: 'quests', list: ['id', 'name', 'realm_id', 'min_level'], detail: ['id', 'name', 'realm_id', 'min_level', 'details'], json: ['details'], natural: true },
});
const INT_COLUMNS = new Set(['id', 'min_level', 'master_realm_id', 'setId', 'realm_id']);

/** A LIKE substring pattern for `ESCAPE '!'`; % and _ in the text match literally. */
export const likePattern = (text, { prefix = false } = {}) => `${prefix ? '' : '%'}${text.replace(/[!%_]/g, m => `!${m}`)}%`;

/** One serving column as returned to callers: integers as numbers, JSON parsed (bounded), text capped. */
export function cellValue(col, value, spec) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint' || INT_COLUMNS.has(col)) return Number(value);
    if (spec.json.includes(col)) {
        if (typeof value !== 'string' || value.length > MAX_JSON_OUT) return { truncated: true };
        try { return JSON.parse(value); } catch { return null; }
    }
    return typeof value === 'string' ? value.slice(0, 8192) : value;
}

/** The catalog_entities key of a serving row. */
export const servingKey = (kind, row) => (SERVING[kind].natural ? `${row.realm_id}:${row.name}` : String(row.id));

// Relation queries shared by the dashboard (getEntity) and cards. `from`/`where` are code-owned;
// every value is a bound parameter. Rows expose id, name and optional extra columns.
const RELATIONS = Object.freeze({
    realmCreatures: { kind: 'creature', cols: 'c.id, c.name', from: 'realm_creatures rc JOIN creatures c ON c.id = rc.creature_id', where: 'rc.realm_id = ?', order: 'c.id' },
    realmRelics: { kind: 'relic', cols: 'id, name', from: 'relics', where: 'realm_id = ?', order: 'name' },
    realmQuests: { kind: 'quest', cols: 'id, name, min_level', from: 'quests', where: 'realm_id = ?', order: 'name' },
    creatureRealms: { kind: 'realm', cols: 'r.id, r.name', from: 'realm_creatures rc JOIN realms r ON r.id = rc.realm_id', where: 'rc.creature_id = ?', order: 'r.id' },
    creatureDrops: { kind: 'item', cols: 'i.id, i.name', from: 'creature_drops cd JOIN items i ON i.id = cd.item_id', where: 'cd.creature_id = ?', order: 'i.id' },
    itemDroppedBy: { kind: 'creature', cols: 'c.id, c.name', from: 'creature_drops cd JOIN creatures c ON c.id = cd.creature_id', where: 'cd.item_id = ?', order: 'c.id' },
    itemSetPieces: { kind: 'item', cols: 'id, name', from: 'items', where: 'setId = ? AND id <> ?', order: 'id' },
    masterRealmRealms: { kind: 'realm', cols: 'id, name, min_level', from: 'realms', where: 'master_realm_id = ?', order: 'min_level, id' },
});

/** Rows of one relation, at most `limit`, with the full count when more exist.
 * @param {{query: Function}} db Catalog connection.
 * @param {keyof RELATIONS} name Relation.
 * @param {Array<number>} params Bound IDs.
 * @param {number} limit Row cap.
 * @returns {Promise<{total: number, rows: object[]}>} Bounded rows.
 */
export async function relatedRows(db, name, params, limit) {
    const r = RELATIONS[name];
    const rows = await db.query(`SELECT ${r.cols} FROM ${r.from} WHERE ${r.where} ORDER BY ${r.order} LIMIT ${limit + 1}`, params);
    if (rows.length <= limit) return { total: rows.length, rows };
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${r.from} WHERE ${r.where}`, params);
    return { total: Number(n), rows: rows.slice(0, limit) };
}

/** The owner dashboard's relation lists (shape unchanged since CAT-TASK-005, 200 rows each).
 * @param {{query: Function}} db Catalog connection.
 * @param {string} kind Catalog kind.
 * @param {object} fields Parsed serving fields of the entity.
 * @returns {Promise<object>} Relations keyed as getEntity() returns them.
 */
export async function dashboardRelations(db, kind, fields) {
    const id = Number(fields.id);
    const rows = async (name, params = [id]) => (await relatedRows(db, name, params, 200)).rows;
    if (kind === 'master_realm') {
        return { connectedRealms: Array.isArray(fields.connected_realms)
            ? fields.connected_realms.map(realm => ({ id: realm.realmId, name: realm.realmName, minLevel: realm.minLevel })) : [] };
    }
    if (kind === 'realm') {
        return {
            creatures: (await rows('realmCreatures')).map(r => ({ id: Number(r.id), name: r.name })),
            relics: (await rows('realmRelics')).map(r => r.name),
            quests: (await rows('realmQuests')).map(r => ({ name: r.name, minLevel: r.min_level === null ? null : Number(r.min_level) })),
        };
    }
    if (kind === 'creature') {
        return {
            realms: (await rows('creatureRealms')).map(r => ({ id: Number(r.id), name: r.name })),
            drops: (await rows('creatureDrops')).map(r => ({ id: Number(r.id), name: r.name })),
        };
    }
    if (kind === 'item') return { droppedBy: (await rows('itemDroppedBy')).map(r => ({ id: Number(r.id), name: r.name })) };
    return {};
}

const asArray = value => (Array.isArray(value) ? value : []);
const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) && !value.truncated ? value : {});
const text = (value, max = 191) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const int = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const entry = (kind, id, name, extra = {}) => ({ kind, id: Number(id), name: text(name) ?? `#${id}`, known: true, ...extra });

function validKind(kind) {
    if (!BROWSE_KINDS.includes(kind)) throw new CatalogError('invalid', 'Unknown kind.', { field: 'kind' });
}
function validId(id) {
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ID) throw new CatalogError('invalid', 'ID must be a positive integer.', { field: 'id' });
}

// Short text that tells same-named entries apart in search results.
function searchHint(kind, row) {
    const stats = asObject(cellValue('stats', row.stats ?? null, { json: ['stats'] }));
    const level = value => (int(value) === null ? null : `Lvl ${int(value)}`);
    const parts = {
        item: [text(stats.type, 64), text(row.rarity, 64), level(stats.level)],
        creature: [text(stats.class, 64), level(stats.level)],
        realm: [level(row.min_level)],
        master_realm: [level(row.min_level)],
        relic: [text(row.realm_name)],
        quest: [text(row.realm_name), level(row.min_level)],
    }[kind];
    return parts.filter(Boolean).join(' • ').slice(0, 100);
}

const SEARCH_SQL = Object.freeze({
    item: { cols: 's.id, s.name, s.rarity, s.stats', from: 'items s' },
    creature: { cols: 's.id, s.name, s.stats', from: 'creatures s' },
    realm: { cols: 's.id, s.name, s.min_level', from: 'realms s' },
    master_realm: { cols: 's.id, s.name, s.min_level', from: 'master_realms s' },
    relic: { cols: 's.id, s.name, r.name AS realm_name', from: 'relics s LEFT JOIN realms r ON r.id = s.realm_id' },
    quest: { cols: 's.id, s.name, s.min_level, r.name AS realm_name', from: 'quests s LEFT JOIN realms r ON r.id = s.realm_id' },
});

/**
 * @param {{db: {query: Function}}} deps Migrated catalog connection (read-only use).
 * @returns {{search: Function, findExact: Function, card: Function}} Reader.
 */
export function createCatalogReader({ db }) {
    const searchResult = (kind, row) => ({ kind, id: Number(row.id), name: text(row.name) ?? `#${row.id}`, hint: searchHint(kind, row) });

    async function completenessOf(kind, row) {
        const [state] = await db.query('SELECT completeness, incomplete_reason FROM catalog_entities WHERE entity_kind = ? AND entity_key = ?', [kind, servingKey(kind, row)]);
        if (!state?.completeness) return { completeness: null, reasons: [] };
        const reasons = state.completeness === 'incomplete' && state.incomplete_reason
            ? String(state.incomplete_reason).split(',').filter(reason => Object.hasOwn(INCOMPLETE_REASON_LABELS, reason)) : [];
        return { completeness: state.completeness, reasons };
    }

    async function relation(name, params) {
        const { total, rows } = await relatedRows(db, name, params, MAX_RELATED);
        const kind = RELATIONS[name].kind;
        return { kind, total, entries: rows.map(row => entry(kind, row.id, row.name, row.min_level === undefined ? {} : { minLevel: int(row.min_level) })) };
    }

    // A related list taken from a JSON column: IDs present in `table` open their card; others are
    // listed by their stored name only.
    async function storedRelation(kind, table, list) {
        const items = list.filter(item => Number.isSafeInteger(item.id) && item.id > 0);
        const ids = [...new Set(items.map(item => item.id))].slice(0, 200);
        const known = ids.length
            ? new Map((await db.query(`SELECT id, name FROM ${table} WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)).map(row => [Number(row.id), row.name]))
            : new Map();
        const entries = items.map(item => (known.has(item.id)
            ? entry(kind, item.id, known.get(item.id) ?? item.name)
            : { ...entry(kind, item.id, item.name), known: false }));
        return { kind, total: entries.length, entries: entries.slice(0, MAX_RELATED) };
    }

    async function realmRef(realmId) {
        if (realmId === null) return null;
        const [realm] = await db.query('SELECT id, name FROM realms WHERE id = ?', [realmId]);
        return realm ? entry('realm', realm.id, realm.name) : { kind: 'realm', id: realmId, name: `Realm #${realmId}`, known: false };
    }

    const sections = details => asArray(asObject(details).sections)
        .filter(section => text(section?.heading) && typeof section.text === 'string')
        .map(section => ({ heading: text(section.heading), text: section.text.slice(0, 8192) }));

    const builders = {
        async item(f) {
            const stats = asObject(f.stats);
            const details = asObject(f.details);
            return {
                rarity: text(f.rarity, 64), type: text(stats.type, 64), level: int(stats.level),
                stats: Object.fromEntries(Object.entries(stats).filter(([key, value]) => !['type', 'level'].includes(key) && int(value) !== null).map(([key, value]) => [key, int(value)])),
                enhancements: asArray(f.enhancements).filter(e => text(e?.name) && int(e.value) !== null).map(e => ({ name: text(e.name), value: int(e.value) })),
                set: f.setId || text(f.setName) ? { id: int(f.setId), name: text(f.setName), bonuses: asObject(f.setBonuses) } : null,
                tooltip: {
                    rows: asArray(details.tooltipRows).filter(row => typeof row === 'string').slice(0, 100),
                    notes: asArray(details.notes).filter(note => typeof note === 'string').slice(0, 100),
                    typeDetails: asArray(details.typeDetails).filter(value => typeof value === 'string').slice(0, 16),
                    durability: details.durability && int(details.durability.max) !== null ? { current: int(details.durability.current), max: int(details.durability.max) } : null,
                },
                relations: {
                    droppedBy: await relation('itemDroppedBy', [f.id]),
                    ...(f.setId ? { setPieces: await relation('itemSetPieces', [f.setId, f.id]) } : {}),
                },
            };
        },
        async creature(f) {
            const stats = asObject(f.stats);
            const range = value => (value && int(value.min) !== null && int(value.max) !== null ? { min: int(value.min), max: int(value.max) } : null);
            return {
                class: text(stats.class, 64), level: int(stats.level), description: text(f.description, 4096),
                stats: Object.fromEntries(['attack', 'defense', 'armor', 'damage', 'hp', 'gold', 'xp'].map(key => [key, range(stats[key])]).filter(([, value]) => value)),
                enhancements: asArray(f.enhancements).map(value => text(typeof value === 'string' ? value : value?.name, 256)).filter(Boolean),
                relations: { drops: await relation('creatureDrops', [f.id]), realms: await relation('creatureRealms', [f.id]) },
            };
        },
        async realm(f) {
            const stairways = asArray(f.connections).map(target => ({ id: int(target?.targetRealmId), name: target?.targetRealmName }));
            return {
                minLevel: int(f.min_level),
                masterRealm: f.master_realm_id === null ? null : await (async () => {
                    const [master] = await db.query('SELECT id, name FROM master_realms WHERE id = ?', [f.master_realm_id]);
                    return master ? entry('master_realm', master.id, master.name) : null;
                })(),
                shops: asArray(f.shops).map(shop => text(shop?.shopName)).filter(Boolean).slice(0, 50),
                relations: {
                    creatures: await relation('realmCreatures', [f.id]),
                    relics: await relation('realmRelics', [f.id]),
                    quests: await relation('realmQuests', [f.id]),
                    stairways: await storedRelation('realm', 'realms', stairways),
                },
            };
        },
        async master_realm(f) {
            const linked = (await relatedRows(db, 'masterRealmRealms', [f.id], 200)).rows.map(row => ({ id: Number(row.id), name: row.name }));
            const listed = asArray(f.connected_realms).map(realm => ({ id: int(realm?.realmId), name: realm?.realmName }));
            const merged = [...new Map([...listed, ...linked].filter(realm => realm.id).map(realm => [realm.id, realm])).values()];
            return { minLevel: int(f.min_level), relations: { realms: await storedRelation('realm', 'realms', merged) } };
        },
        async relic(f) {
            return { realm: await realmRef(f.realm_id), sections: sections(f.details) };
        },
        async quest(f) {
            return { realm: await realmRef(f.realm_id), minLevel: int(f.min_level), stages: sections(f.details) };
        },
    };

    return {
        /** AC-1: up to 25 entries whose names contain the text; prefix matches first, then shorter names.
         * @param {string} kind Catalog kind.
         * @param {string} query 0-64 characters; empty returns the newest entries.
         * @returns {Promise<Array<{kind: string, id: number, name: string, hint: string}>>} Results.
         */
        async search(kind, query) {
            validKind(kind);
            if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) throw new CatalogError('invalid', `Query must be at most ${MAX_QUERY_LENGTH} characters.`, { field: 'query' });
            const sql = SEARCH_SQL[kind];
            const needle = query.trim().toLowerCase();
            if (!needle) {
                const rows = await db.query(`SELECT ${sql.cols} FROM ${sql.from} WHERE s.name IS NOT NULL ORDER BY s.id DESC LIMIT ${MAX_SEARCH_RESULTS}`);
                return rows.map(row => searchResult(kind, row));
            }
            const rows = await db.query(
                `SELECT ${sql.cols} FROM ${sql.from} WHERE LOWER(s.name) LIKE ? ESCAPE '!'
                 ORDER BY CASE WHEN LOWER(s.name) LIKE ? ESCAPE '!' THEN 0 ELSE 1 END, s.id LIMIT ${SEARCH_CANDIDATES}`,
                [likePattern(needle), likePattern(needle, { prefix: true })]);
            return rows
                .map(row => ({ row, name: String(row.name ?? '') }))
                .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle))
                    || a.name.length - b.name.length || Number(a.row.id) - Number(b.row.id))
                .slice(0, MAX_SEARCH_RESULTS)
                .map(({ row }) => searchResult(kind, row));
        },

        /** Entries whose whole name matches case-insensitively (a typed name not picked from autocomplete).
         * @param {string} kind Catalog kind.
         * @param {string} name 1-64 characters.
         * @returns {Promise<Array<{kind: string, id: number, name: string, hint: string}>>} At most 25.
         */
        async findExact(kind, name) {
            validKind(kind);
            const needle = typeof name === 'string' ? name.trim().toLowerCase() : '';
            if (!needle || needle.length > MAX_QUERY_LENGTH) throw new CatalogError('invalid', `Name must be 1-${MAX_QUERY_LENGTH} characters.`, { field: 'name' });
            const sql = SEARCH_SQL[kind];
            const rows = await db.query(`SELECT ${sql.cols} FROM ${sql.from} WHERE LOWER(s.name) = ? ORDER BY s.id LIMIT ${MAX_SEARCH_RESULTS}`, [needle]);
            return rows.map(row => searchResult(kind, row));
        },

        /** AC-2/AC-3: display model of one entity with bounded relations and its completeness.
         * @param {string} kind Catalog kind.
         * @param {number} id Serving-table ID.
         * @returns {Promise<object|null>} Card, or null when the entity does not exist.
         */
        async card(kind, id) {
            validKind(kind);
            validId(id);
            const spec = SERVING[kind];
            const [row] = await db.query(`SELECT ${spec.detail.map(c => `\`${c}\``).join(', ')} FROM ${spec.table} WHERE id = ?`, [id]);
            if (!row) return null;
            const fields = Object.fromEntries(spec.detail.map(c => [c, cellValue(c, row[c], spec)]));
            const imageUrl = typeof fields.imageUrl === 'string' && /^https:\/\/[^\s]+$/.test(fields.imageUrl) ? fields.imageUrl : null;
            return {
                kind, id: fields.id, name: text(fields.name) ?? `#${fields.id}`, imageUrl,
                ...await completenessOf(kind, row),
                ...await builders[kind](fields),
            };
        },
    };
}
