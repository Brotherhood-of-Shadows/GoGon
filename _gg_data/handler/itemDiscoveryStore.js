import crypto from 'node:crypto';
import { CatalogError, canonicalJson } from './catalogStore.js';
import { insertOutboxRows, outboxEvents } from './notificationOutbox.js';
import { mapGuideRecord } from '../../catalog/guideNormalizers.js';
import { ITEM_DISCOVERY_INTERVAL_MS, ITEM_DISCOVERY_LOOKAHEAD, ITEM_DISCOVERY_SOURCE, ITEM_DISCOVERY_WEBHOOK, MAX_TOOLTIP_ITEM_ID } from '../../catalog/contracts/itemTooltip.js';

const conflict = () => new CatalogError('conflict', 'Item discovery changed while this request was running.');
const invalid = message => new CatalogError('invalid', message, { field: 'startAfterId' });
const at = time => new Date(time).toISOString();

function stateOf(row) {
    return { enabled: Number(row.enabled) === 1, baselineId: row.baseline_id == null ? null : Number(row.baseline_id),
        lastValidId: row.last_valid_id == null ? null : Number(row.last_valid_id), lastCheckedId: row.last_checked_id == null ? null : Number(row.last_checked_id),
        nextItemId: row.next_item_id == null ? null : Number(row.next_item_id), scanId: row.scan_id, scanStartedAt: row.scan_started_at,
        lastCompletedAt: row.last_completed_at, nextCheckAt: row.next_check_at, lastError: row.last_error,
        checkedInScan: Number(row.checked_in_scan), foundInScan: Number(row.found_in_scan), discoveredTotal: Number(row.discovered_total),
        updatedAt: row.updated_at };
}

/** Durable daily frontier, announcement dedupe, and atomic catalog/outbox checkpoints.
 * @param {{query: Function, transaction: Function}} db Migrated database.
 * @param {{ingestAtomic: Function}} catalog Catalog transaction boundary.
 * @param {{now?: () => number}} options Clock seam.
 * @returns {object} Item discovery persistence API.
 */
export function createItemDiscoveryStore(db, catalog, { now = Date.now } = {}) {
    const read = async (q = db, lock = false) => {
        const [row] = await q.query(`SELECT * FROM catalog_item_discovery WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
        return stateOf(row);
    };
    const maxId = async q => Number((await q.query('SELECT MAX(id) AS id FROM items WHERE id > 0 AND id <= ?', [MAX_TOOLTIP_ITEM_ID]))[0]?.id ?? 0);
    const active = async (tx, scanId, itemId = null) => {
        const state = await read(tx, true);
        if (!state.enabled || state.scanId !== scanId || itemId !== null && state.nextItemId !== itemId) throw conflict();
        return state;
    };
    return {
        /** Current cursor and the initial catalog-derived starting point.
         * @returns {Promise<object>} Safe public progress fields.
         */
        async state() {
            const state = await read();
            return { ...state, recommendedStartId: state.lastValidId ?? (await maxId(db) || null), lookahead: ITEM_DISCOVERY_LOOKAHEAD };
        },
        /** Latest discoveries, including data not yet available in the Guide.
         * @returns {Promise<object[]>} Up to twenty typed item records.
         */
        async recent() {
            return (await db.query('SELECT item_id, payload, first_seen_at, last_seen_at, announced FROM catalog_discovered_items ORDER BY first_seen_at DESC, item_id DESC LIMIT 20'))
                .map(row => ({ id: Number(row.item_id), record: JSON.parse(row.payload), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, announced: Number(row.announced) === 1 }));
        },
        /** Pauses/resumes discovery or sets an owner-chosen starting point without clearing dedupe.
         * @param {{enabled?: boolean, startAfterId?: number}} patch Owner settings.
         * @returns {Promise<object>} Saved progress.
         */
        async configure({ enabled, startAfterId } = {}) {
            if (enabled !== undefined && typeof enabled !== 'boolean') throw new CatalogError('invalid', 'Enabled must be true or false.', { field: 'enabled' });
            if (startAfterId !== undefined && (!Number.isInteger(startAfterId) || startAfterId < 1 || startAfterId > MAX_TOOLTIP_ITEM_ID)) throw invalid(`Starting ID must be 1–${MAX_TOOLTIP_ITEM_ID}.`);
            await db.transaction(async tx => {
                const state = await read(tx, true);
                if (enabled !== undefined) await tx.query('UPDATE catalog_item_discovery SET enabled = ?, updated_at = ? WHERE id = 1', [enabled ? 1 : 0, at(now())]);
                if (startAfterId !== undefined) await tx.query('UPDATE catalog_item_discovery SET baseline_id = ?, last_valid_id = ?, last_checked_id = NULL, next_item_id = ?, scan_id = NULL, scan_started_at = NULL, next_check_at = NULL, last_error = NULL, checked_in_scan = 0, found_in_scan = 0, updated_at = ? WHERE id = 1',
                    [Math.max(state.baselineId ?? 0, startAfterId), startAfterId, startAfterId + 1, at(now())]);
            });
            return this.state();
        },
        /** Schedules a pass on the next CatalogSync tick without starting untracked network work.
         * @returns {Promise<void>}
         */
        async requestScan() {
            await db.transaction(async tx => {
                const state = await read(tx, true);
                if (!state.enabled) throw new CatalogError('conflict', 'Enable item discovery first.');
                await tx.query('UPDATE catalog_item_discovery SET next_check_at = NULL, last_error = NULL, updated_at = ? WHERE id = 1', [at(now())]);
            });
        },
        /** Begins a due daily scan or resumes its durable cursor.
         * @returns {Promise<object|null>} Active scan, or null if disabled/not due/uninitialized.
         */
        async begin() {
            return db.transaction(async tx => {
                let state = await read(tx, true);
                if (!state.enabled || state.nextCheckAt && Date.parse(state.nextCheckAt) > now()) return null;
                if (state.lastValidId === null) {
                    const initial = await maxId(tx);
                    if (!initial) return null;
                    await tx.query('UPDATE catalog_item_discovery SET baseline_id = ?, last_valid_id = ?, next_item_id = ? WHERE id = 1', [initial, initial, initial + 1]);
                    state = await read(tx);
                }
                if (!state.scanId) await tx.query('UPDATE catalog_item_discovery SET scan_id = ?, scan_started_at = ?, next_item_id = ?, checked_in_scan = 0, found_in_scan = 0, last_error = NULL, next_check_at = NULL, updated_at = ? WHERE id = 1',
                    [crypto.randomUUID(), at(now()), state.lastValidId + 1, at(now())]);
                return read(tx);
            });
        },
        /** Checkpoints only an explicit Invalid Request response.
         * @param {string} scanId Active scan identity.
         * @param {number} id Requested ID.
         * @returns {Promise<object>} Updated cursor.
         */
        async missing(scanId, id) {
            return db.transaction(async tx => {
                await active(tx, scanId, id);
                await tx.query('UPDATE catalog_item_discovery SET last_checked_id = ?, next_item_id = ?, checked_in_scan = checked_in_scan + 1, last_error = NULL, next_check_at = NULL, updated_at = ? WHERE id = 1', [id, id + 1, at(now())]);
                return read(tx);
            });
        },
        /** Projects provisional item data and persists its notification/cursor in the same commit.
         * @param {string} scanId Active scan.
         * @param {object} record Parsed public item data.
         * @param {object} payload Discord announcement.
         * @param {{probe?: boolean}} options A probe validates the known frontier without advancing it.
         * @returns {Promise<object>} Updated cursor and announcement flag.
         */
        async found(scanId, record, payload, { probe = false } = {}) {
            const observation = mapGuideRecord('item', record).observations[0];
            let announced = false;
            await catalog.ingestAtomic({ mode: 'item_frontier', source: 'manual_import', observations: [observation], summary: { manualEntry: true, itemDiscovery: true } }, {
                onRecorded: async (tx, runId) => {
                    const state = await active(tx, scanId, probe ? null : record.id);
                    if (probe && state.lastValidId !== record.id) throw conflict();
                    const [{ n }] = await tx.query('SELECT COUNT(*) AS n FROM catalog_discovered_items WHERE item_id = ?', [record.id]);
                    announced = Number(n) === 0 && record.id > state.baselineId;
                    const json = canonicalJson(record);
                    await tx.query('INSERT INTO catalog_discovered_items (item_id, payload, run_id, first_seen_at, last_seen_at, announced) VALUES (?, ?, ?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE payload = new.payload, run_id = new.run_id, last_seen_at = new.last_seen_at',
                        [record.id, json, runId, at(now()), at(now()), announced ? 1 : 0]);
                    await tx.query("INSERT IGNORE INTO catalog_guide_ids (entity_kind, entity_id, first_seen_at, next_detail_at) VALUES ('item', ?, ?, ?)", [record.id, at(now()), at(now())]);
                    if (announced) await insertOutboxRows(tx, { source: ITEM_DISCOVERY_SOURCE, eventId: String(record.id), accountScope: 'global', notifications: [{ settingKey: ITEM_DISCOVERY_WEBHOOK, payload }], ignoreExisting: true });
                    if (!probe) await tx.query('UPDATE catalog_item_discovery SET last_valid_id = ?, last_checked_id = ?, next_item_id = ?, checked_in_scan = checked_in_scan + 1, found_in_scan = found_in_scan + 1, discovered_total = discovered_total + ?, last_error = NULL, next_check_at = NULL, updated_at = ? WHERE id = 1',
                        [record.id, record.id, record.id + 1, announced ? 1 : 0, at(now())]);
                },
            });
            if (announced) outboxEvents.emit('enqueued');
            return { ...await read(), announced };
        },
        /** Ends a successful scan only after covering last valid ID plus ten.
         * @param {string} scanId Active scan.
         * @returns {Promise<object>} Next daily check.
         */
        async complete(scanId) {
            return db.transaction(async tx => {
                const state = await active(tx, scanId);
                if (state.nextItemId <= Math.min(MAX_TOOLTIP_ITEM_ID, state.lastValidId + ITEM_DISCOVERY_LOOKAHEAD)) throw conflict();
                await tx.query('UPDATE catalog_item_discovery SET scan_id = NULL, last_completed_at = ?, next_check_at = ?, last_error = NULL, updated_at = ? WHERE id = 1', [at(now()), at(now() + ITEM_DISCOVERY_INTERVAL_MS), at(now())]);
                return read(tx);
            });
        },
        /** Keeps the same frontier after a transient failure; a failed end probe rechecks its tail.
         * @param {string} scanId Active scan.
         * @param {string} reason Redacted code-owned reason.
         * @param {number} delayMs Retry delay.
         * @param {{resetTail?: boolean}} options Recheck uncertain negatives after a failed probe.
         * @returns {Promise<void>}
         */
        async fail(scanId, reason, delayMs, { resetTail = false } = {}) {
            if (!/^[a-z_]{1,40}$/.test(reason)) throw invalid('Invalid discovery failure reason.');
            await db.query(`UPDATE catalog_item_discovery SET last_error = ?, next_check_at = ?, updated_at = ?${resetTail ? ', next_item_id = last_valid_id + 1' : ''} WHERE id = 1 AND scan_id = ?`, [reason, at(now() + delayMs), at(now()), scanId]);
        },
    };
}
