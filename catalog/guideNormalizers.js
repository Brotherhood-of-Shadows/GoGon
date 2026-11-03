// catalog/guideNormalizers.js - CAT-TASK-010 / AC-CAT-011, AC-CAT-013, AC-CAT-014 (catalog-sync-v1 1.3.0)
// Server-side validation of what the guide relay sends. The relay runs catalog/guideParsers.js in the
// owner's browser, but nothing it sends is trusted: every record is checked against a strict wire
// schema (allowed keys, types, lengths, counts, https image URLs on fallensword.com) and mapped to
// catalog observations here. A record that fails is an invalid detail, never stored.
import { canonicalJson, sha256 } from '../_gg_data/handler/catalogStore.js';
import { MAX_GUIDE_ID } from './contracts/guide.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const S = {
    id: v => Number.isSafeInteger(v) && v > 0 && v <= MAX_GUIDE_ID,
    int: v => Number.isSafeInteger(v) && Math.abs(v) <= 1e12,
    num: (lo, hi) => v => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi,
    str: max => v => typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL.test(v),
    opt: f => Object.assign(v => v === null || v === undefined || f(v), f.shape ? { shape: f.shape } : {}),
    arr: (f, max) => v => Array.isArray(v) && v.length <= max && v.every(f),
    obj: (shape, required = []) => Object.assign(v => isPlain(v) && Object.keys(v).every(k => Object.hasOwn(shape, k))
        && required.every(k => v[k] !== undefined) && Object.entries(v).every(([k, x]) => shape[k](x)), { shape }),
    url: v => {
        if (typeof v !== 'string' || v.length > 512) return false;
        try { const u = new URL(v); return u.protocol === 'https:' && /(^|\.)fallensword\.com$/i.test(u.hostname) && !u.username && !u.password; } catch { return false; }
    },
};

const range = S.obj({ min: S.int, max: S.int }, ['min', 'max']);
const itemStats = { type: S.opt(S.str(64)), level: S.opt(S.int), attack: S.opt(S.int), defense: S.opt(S.int), armor: S.opt(S.int), damage: S.opt(S.int), hp: S.opt(S.int), xpGain: S.opt(S.int), stamina: S.opt(S.int), staminaGain: S.opt(S.int), goldGain: S.opt(S.int) };
const enhancement = S.obj({ name: S.str(191), value: S.num(0, 100000) }, ['name', 'value']);
const locatedDetail = S.obj({ id: S.id, name: S.str(191), minLevel: S.opt(S.int), realmId: S.id, realmName: S.opt(S.str(191)),
    sections: v => Array.isArray(v) && v.length > 0 && S.arr(S.obj({ heading: S.str(191), text: S.str(8192) }, ['heading', 'text']), 64)(v),
}, ['id', 'name', 'realmId', 'sections']);

export const RECORD_SCHEMAS = Object.freeze({
    relic: locatedDetail,
    quest: locatedDetail,
    item: S.obj({
        id: S.id, name: S.str(191), rarity: S.opt(S.str(64)), imageUrl: S.opt(S.url),
        stats: S.obj(itemStats), enhancements: S.arr(enhancement, 64),
        droppedBy: S.arr(S.obj({ creatureName: S.str(191), dropRate: S.num(0, 100) }, ['creatureName', 'dropRate']), 200),
        setId: S.opt(S.id), setName: S.opt(S.str(191)),
        setBonuses: S.opt(S.obj({ ...itemStats, enhancements: S.arr(enhancement, 64) })),
    }, ['id', 'name', 'stats', 'enhancements', 'droppedBy']),
    creature: S.obj({
        id: S.id, name: S.str(191), description: S.opt(S.str(8192)), imageUrl: S.opt(S.url),
        stats: S.obj({ class: S.opt(S.str(64)), level: S.opt(S.int), attack: range, defense: range, armor: range, damage: range, hp: range, gold: range, xp: range }),
        enhancements: S.arr(S.str(256), 64),
        droppedItems: S.arr(S.obj({ itemId: S.id, itemName: S.opt(S.str(191)) }, ['itemId']), 200),
        realms: S.arr(S.obj({ realmId: S.id, realmName: S.opt(S.str(191)) }, ['realmId']), 200),
    }, ['id', 'name', 'stats', 'enhancements', 'droppedItems', 'realms']),
    realm: S.obj({
        id: S.id, name: S.str(191), minLevel: S.opt(S.int),
        shops: S.arr(S.obj({ shopId: S.id, shopName: S.opt(S.str(191)) }, ['shopId']), 200),
        relics: S.arr(v => S.str(191)(v) || S.obj({ relicId: S.id, relicName: S.str(191) }, ['relicId', 'relicName'])(v), 200),
        quests: S.arr(S.obj({ questId: S.id, questName: S.str(191) }, ['questId', 'questName']), 200),
        creatures: S.arr(S.obj({ creatureId: S.id, creatureName: S.opt(S.str(191)) }, ['creatureId']), 200),
        stairways: S.arr(S.obj({ targetRealmId: S.id, targetRealmName: S.opt(S.str(191)) }, ['targetRealmId']), 200),
    }, ['id', 'name', 'shops', 'relics', 'quests', 'creatures', 'stairways']),
    master_realm: S.obj({
        id: S.id, name: S.str(191), minLevel: S.opt(S.int), imageUrl: S.opt(S.url),
        realms: S.arr(S.obj({ realmId: S.id, realmName: S.opt(S.str(191)), minLevel: S.opt(S.int) }, ['realmId']), 200),
    }, ['id', 'name', 'realms']),
});

export const indexEntry = S.obj({ id: S.id, name: S.opt(S.str(191)) }, ['id']);

/** Validates optional manual fields with the Guide validators; only ID is required.
 * @param {string} kind Guide entity kind.
 * @param {object} record User-supplied Guide fields.
 * @returns {boolean} Whether the manual record is valid.
 */
export function validManualRecord(kind, record) {
    return Boolean(RECORD_SCHEMAS[kind] && S.obj(manualShape(kind), ['id'])(record)
        && (!['relic', 'quest'].includes(kind) || record.name == null || record.name.trim() === record.name)
        && (record.minLevel == null || record.minLevel >= -2147483648 && record.minLevel <= 2147483647));
}

const manualShape = kind => ({ ...RECORD_SCHEMAS[kind]?.shape,
    ...(kind === 'realm' ? { masterRealmId: S.opt(S.id), mapObjects: () => true } : {}),
    ...(['item', 'relic', 'quest'].includes(kind) ? { details: () => true } : {}),
});

/** Validates a patch without requiring unchanged fields or allowing identity-ID changes.
 * @param {string} kind Catalog kind.
 * @param {object} record Partial fields.
 * @returns {boolean} Whether the patch is well formed.
 */
export function validEditRecord(kind, record) {
    if (!RECORD_SCHEMAS[kind] || !isPlain(record)) return false;
    const shape = manualShape(kind);
    for (const [field, value] of Object.entries(record)) {
        if (!Object.hasOwn(shape, field)) return false;
        if (field === 'id') { if (!Number.isSafeInteger(value) || value <= 0) return false; continue; }
        if (value === null) {
            continue;
        }
        if (field === 'sections' && Array.isArray(value) && value.length === 0) continue;
        if (field === 'minLevel' && (!S.int(value) || value < -2147483648 || value > 2147483647)) return false;
        if (kind === 'realm' && field === 'quests') {
            if (!S.arr(S.obj({ questId: S.id, questName: S.str(191) }, ['questName']), 200)(value)) return false;
        } else if (kind === 'realm' && field === 'relics') {
            if (!S.arr(v => S.str(191)(v) || S.obj({ relicId: S.id, relicName: S.str(191) }, ['relicName'])(v), 200)(value)) return false;
        } else if (field === 'droppedBy') {
            if (!S.arr(S.obj({ creatureName: S.str(191), dropRate: S.num(0, 100) }, ['creatureName']), 200)(value)) return false;
        } else if (!shape[field](value)) return false;
    }
    return true;
}

/** Field names accepted by the manual form, kept in sync with Guide validation.
 * @returns {object} Fields grouped by Guide entity kind.
 */
export function manualRecordFields() {
    return Object.fromEntries(Object.keys(RECORD_SCHEMAS).map(kind => [kind, Object.keys(manualShape(kind))]));
}

/** Lists valid field-state paths, including individual stats and range endpoints.
 * @param {string} kind Guide kind.
 * @returns {string[]} Valid owner policy paths.
 */
export function manualPolicyFields(kind) {
    if (!RECORD_SCHEMAS[kind]) return [];
    const paths = [];
    const walk = (shape, prefix = '') => {
        for (const [field, validator] of Object.entries(shape)) {
            if (field === 'id' && !prefix) continue;
            const path = prefix ? `${prefix}.${field}` : field;
            paths.push(path);
            if (validator.shape) walk(validator.shape, path);
        }
    };
    walk(manualShape(kind));
    return paths;
}

const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/**
 * Maps one validated guide record to catalog observations.
 * @returns {null | { hash: string, observations: object[], references: Array<{ kind, id, name }>, relations: object[] }}
 *   null when the record fails its schema. references: entities the page links to (staged as
 *   minimal records only when unknown). relations: staged only when both ends exist.
 */
export function normalizeGuideRecord(kind, record, expectedId) {
    const schema = RECORD_SCHEMAS[kind];
    if (!schema || !schema(record) || record.id !== expectedId) return null;
    return mapGuideRecord(kind, record);
}

/** Maps a partial, validated manual record to serving observations.
 * @param {string} kind Guide entity kind.
 * @param {object} record Validated partial Guide record.
 * @returns {object} Observations and references; natural kinds require name and realmId.
 */
export function mapGuideRecord(kind, record) {
    const hash = sha256(canonicalJson(record));
    const observations = [];
    const references = [];
    const relations = [];
    if (kind === 'item') {
        observations.push({ kind: 'item', payload: compact({
            id: record.id, name: record.name, rarity: record.rarity, imageUrl: record.imageUrl, stats: record.stats,
            enhancements: record.enhancements, droppedBy: record.droppedBy, setId: record.setId, setName: record.setName, setBonuses: record.setBonuses,
            details: record.details,
        }) });
    } else if (kind === 'creature') {
        observations.push({ kind: 'creature', payload: compact({
            id: record.id, name: record.name, imageUrl: record.imageUrl, description: record.description, stats: record.stats,
            enhancements: record.enhancements, droppedItems: record.droppedItems,
        }) });
        for (const d of record.droppedItems ?? []) {
            references.push({ kind: 'item', id: d.itemId, name: d.itemName ?? null });
            relations.push({ type: 'creature_drop', creature_id: record.id, item_id: d.itemId });
        }
        for (const r of record.realms ?? []) {
            references.push({ kind: 'realm', id: r.realmId, name: r.realmName ?? null });
            relations.push({ type: 'realm_creature', realm_id: r.realmId, creature_id: record.id });
        }
    } else if (kind === 'realm') {
        observations.push({ kind: 'realm', payload: compact({
            id: record.id, name: record.name, min_level: record.minLevel, shops: record.shops, connections: record.stairways,
            master_realm_id: record.masterRealmId, map_objects: record.mapObjects,
        }) });
        if (record.masterRealmId) references.push({ kind: 'master_realm', id: record.masterRealmId });
        for (const relic of record.relics ?? []) {
            const name = typeof relic === 'string' ? relic : relic.relicName;
            observations.push({ kind: 'relic', payload: { realm_id: record.id, name } });
            if (typeof relic !== 'string' && relic.relicId) references.push({ kind: 'relic', id: relic.relicId, name, entityKey: `${record.id}:${name}`, realmId: record.id });
        }
        for (const q of record.quests ?? []) {
            observations.push({ kind: 'quest', payload: { realm_id: record.id, name: q.questName } });
            if (q.questId) references.push({ kind: 'quest', id: q.questId, name: q.questName, entityKey: `${record.id}:${q.questName}`, realmId: record.id });
        }
        for (const c of record.creatures ?? []) {
            references.push({ kind: 'creature', id: c.creatureId, name: c.creatureName ?? null });
            relations.push({ type: 'realm_creature', realm_id: record.id, creature_id: c.creatureId });
        }
        for (const target of record.stairways ?? []) references.push({ kind: 'realm', id: target.targetRealmId, name: target.targetRealmName ?? null });
    } else if (kind === 'master_realm') {
        observations.push({ kind: 'master_realm', payload: compact({
            id: record.id, name: record.name, connected_realms: record.realms,
            min_level: record.minLevel, imageUrl: record.imageUrl,
        }) });
        for (const r of record.realms ?? []) {
            observations.push({ kind: 'realm', payload: { id: r.realmId, master_realm_id: record.id } });
            references.push({ kind: 'realm', id: r.realmId, name: r.realmName ?? null });
        }
    } else {
        observations.push({ kind, payload: compact({ realm_id: record.realmId, name: record.name,
            ...(kind === 'quest' ? { min_level: record.minLevel } : {}), details: { sections: record.sections } }) });
        references.push({ kind: 'realm', id: record.realmId, name: record.realmName ?? null });
    }
    const entityKey = kind === 'relic' || kind === 'quest' ? `${record.realmId}:${record.name}` : String(record.id);
    return { hash, observations, references, relations, entityKey };
}
