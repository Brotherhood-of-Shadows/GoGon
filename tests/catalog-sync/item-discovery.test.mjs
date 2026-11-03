import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshClient, closeClients } from '../helpers/db-client.mjs';
import { createCatalogStore } from '../../_gg_data/handler/catalogStore.js';
import { createItemDiscoveryStore } from '../../_gg_data/handler/itemDiscoveryStore.js';
import { createItemDiscovery } from '../../catalog/itemDiscovery.js';
import { GAME_POLICY } from '../../catalog/contracts/policy.js';
import { setAccountScope } from '../../config/accountScope.mjs';
import { createCatalogService } from '../../catalog/catalogService.js';
import { createGuideDiscoveryStore } from '../../_gg_data/handler/guideDiscoveryStore.js';
import { mapGuideRecord } from '../../catalog/guideNormalizers.js';
import { GUIDE_POLICY } from '../../catalog/contracts/policy.js';

after(closeClients);
const sample = readFileSync('tests/catalog-sync/fixtures/item-tooltip.html', 'utf8');
const hook = 'https://discord.com/api/webhooks/0/fixture-upcoming';
const tooltip = id => sample.replaceAll('Cuirass of Encillious', `Discovered item ${id}`);
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

async function setup({ budget = 50, baseline = 17069 } = {}) {
    setAccountScope('env');
    const db = await freshClient();
    const clock = { t: Date.parse('2026-11-03T12:00:00.000Z') };
    const now = () => clock.t;
    const fault = { outbox: false };
    const catalogDb = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => {
        if (fault.outbox && /INSERT.*notification_outbox/i.test(sql)) throw new Error('Simulated outbox write failure');
        return tx.query(sql, params);
    } })) };
    const catalog = createCatalogStore(catalogDb, { now, invalidateCaches: () => {} });
    if (baseline) await catalog.ingest({ mode: 'observe_realm', source: 'game_session', observations: [{ kind: 'item', payload: { id: baseline, name: 'Existing item' } }] });
    const store = createItemDiscoveryStore(db, catalog, { now });
    const calls = [], valid = new Set(baseline ? [baseline] : []);
    const env = { webhook: hook, ready: true, intercept: null };
    const makeWorker = () => createItemDiscovery({ store, now, getWebhook: () => env.webhook, sessionReady: () => env.ready,
        policy: { ...GAME_POLICY, maxRequestsPerExecution: budget }, queue: { run: fn => fn() },
        fetchFn: async (url, options) => {
            assert.equal(options.method, 'GET');
            const id = Number(new URL(url).searchParams.get('item_id'));
            calls.push(id);
            return await env.intercept?.(id, options) ?? response(valid.has(id) ? tooltip(id) : 'Invalid Request');
        } });
    return { db, clock, catalog, store, calls, valid, env, fault, makeWorker, worker: makeWorker() };
}

test('daily discovery bootstraps catalog max, jumps gaps, extends last-valid + 10, and rechecks negatives next day', async () => {
    const { db, store, worker, valid, calls, clock } = await setup();
    valid.add(17074); valid.add(17078);
    const result = await worker.run();
    assert.equal(result.status, 'complete');
    assert.equal(result.announced, 2);
    assert.equal(result.lastValidId, 17078);
    assert.equal(result.lastCheckedId, 17088);
    assert.deepEqual(calls, [17069, ...Array.from({ length: 19 }, (_, n) => 17070 + n), 17078]);
    let state = await store.state();
    assert.equal(state.baselineId, 17069);
    assert.equal(state.discoveredTotal, 2);
    assert.equal(Date.parse(state.nextCheckAt) - clock.t, 24 * 3600_000);
    const { up } = await import('../../_gg_data/migrations/021_item_discovery.mjs');
    await up(db); await up(db);
    assert.deepEqual(await store.state(), state, 'migration reruns preserve a populated checkpoint and announcement history');
    assert.equal((await worker.run()).status, 'not_due');
    const [item] = await db.query('SELECT name, stats, details FROM items WHERE id = 17074');
    assert.equal(item.name, 'Discovered item 17074');
    assert.equal(JSON.parse(item.stats).armor, 8803);
    assert.equal(JSON.parse(item.details).durability.max, 160);
    const [entity] = await db.query("SELECT completeness, incomplete_reason FROM catalog_entities WHERE entity_kind = 'item' AND entity_key = '17074'");
    assert.equal(entity.completeness, 'incomplete');
    assert.match(entity.incomplete_reason, /guide_detail_missing/);
    const [guide] = await db.query("SELECT detail_status FROM catalog_guide_ids WHERE entity_kind = 'item' AND entity_id = 17074");
    assert.equal(guide.detail_status, 'pending');
    const rows = await db.query('SELECT source, account_scope, setting_key, payload FROM notification_outbox ORDER BY event_id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, 'catalog_upcoming');
    assert.equal(rows[0].account_scope, 'global');
    assert.equal(rows[0].setting_key, 'GG_UPCOMING_WEBHOOK');
    assert.equal(JSON.parse(rows[0].payload).embeds[0].thumbnail.url, 'https://cdn2.fallensword.com/items/17074.gif');
    calls.length = 0;
    clock.t += 24 * 3600_000;
    valid.add(17079);
    assert.equal((await worker.run()).announced, 1);
    assert.equal(calls[1], 17079, 'revisit yesterday\'s negative IDs instead of skipping to lastChecked + 1');
    assert.equal((await store.state()).lastCheckedId, 17089);
    assert.equal((await db.query('SELECT * FROM notification_outbox')).length, 3);
    // A rewind remains useful for backfilling and never resends an earlier release, even after outbox pruning.
    await db.query('DELETE FROM notification_outbox');
    await store.configure({ startAfterId: 17069 });
    assert.equal((await worker.run()).announced, 0);
    assert.equal((await db.query('SELECT * FROM notification_outbox')).length, 0);
});

test('bounded scans resume persisted progress across worker restarts and finish without duplicates', async () => {
    const { worker, makeWorker, valid, store, db } = await setup({ baseline: 100, budget: 5 });
    valid.add(103); valid.add(108);
    assert.equal((await worker.run()).status, 'partial');
    assert.equal((await store.state()).nextItemId, 105);
    let result;
    for (let n = 0; n < 10; n++) { result = await makeWorker().run(); if (result.status === 'complete') break; }
    assert.equal(result.status, 'complete');
    assert.equal(result.lastCheckedId, 118);
    assert.equal((await store.state()).discoveredTotal, 2);
    assert.equal((await db.query('SELECT * FROM notification_outbox')).length, 2);
});

test('maintenance, auth, challenge, network and malformed replies preserve the cursor and use backoff', async () => {
    for (const fault of [() => response('Invalid Request', 503), () => response('<html>Maintenance</html>'), () => response('<form action="login.php"><input name="password"></form>'), () => response('challenge', 403, { 'cf-mitigated': 'challenge' }), () => { throw new Error('offline'); }]) {
        const { env, worker, store, clock } = await setup({ baseline: 100 });
        env.intercept = id => id === 101 ? fault() : null;
        const result = await worker.run();
        assert.equal(result.status, 'backoff');
        const state = await store.state();
        assert.equal(state.lastValidId, 100);
        assert.equal(state.nextItemId, 101);
        assert.equal(state.lastCompletedAt, null);
        assert.ok(Date.parse(state.nextCheckAt) > clock.t);
        assert.equal((await worker.run()).status, 'not_due');
    }
});

test('known-item end probe catches misleading Invalid Request during maintenance and rechecks the uncertain tail', async () => {
    const { env, worker, store } = await setup({ baseline: 100 });
    let probes = 0;
    env.intercept = id => id === 100 && ++probes > 1 ? response('Invalid Request') : null;
    assert.equal((await worker.run()).reason, 'known_item_unavailable');
    const state = await store.state();
    assert.equal(state.lastCompletedAt, null);
    assert.equal(state.nextItemId, 101);
    assert.equal(state.lastValidId, 100);
});

test('setup gates requests, cancellation/account changes discard fetched data, and paused discovery fences stale writes', async () => {
    const { worker, env, calls, store, db } = await setup({ baseline: 100 });
    env.webhook = '';
    assert.equal((await worker.run()).status, 'waiting_for_webhook');
    assert.equal((await worker.status()).webhookConfigured, false);
    env.webhook = hook; env.ready = false;
    assert.equal((await worker.run()).status, 'waiting_for_session');
    env.ready = true;
    assert.equal(calls.length, 0);
    const controller = new AbortController();
    env.intercept = id => { if (id === 101) { controller.abort(); return response(tooltip(id)); } };
    assert.equal((await worker.run({ signal: controller.signal })).status, 'aborted');
    assert.equal((await store.state()).nextItemId, 101);
    env.intercept = async id => { if (id === 101) { await store.configure({ enabled: false }); return response(tooltip(id)); } };
    assert.equal((await worker.run()).status, 'interrupted');
    assert.equal((await db.query('SELECT id FROM items WHERE id = 101')).length, 0);
    await store.configure({ enabled: true });
    env.intercept = id => { if (id === 101) { setAccountScope('profile:other'); return response(tooltip(id)); } };
    assert.equal((await worker.run()).status, 'aborted');
    assert.equal((await db.query('SELECT id FROM items WHERE id = 101')).length, 0);
    setAccountScope('env');
});

test('empty catalogs require a valid explicit baseline and settings reject unsafe IDs', async () => {
    const { worker, store, valid } = await setup({ baseline: null });
    assert.equal((await worker.status()).status, 'waiting_for_start_id');
    assert.equal((await worker.run()).status, 'not_due');
    for (const startAfterId of [0, -1, 1.1, '100', 10_000_001]) await assert.rejects(store.configure({ startAfterId }), error => error.code === 'invalid');
    await assert.rejects(store.configure({ enabled: 'true' }), error => error.code === 'invalid');
    await store.configure({ startAfterId: 100 }); valid.add(100);
    assert.equal((await worker.run()).lastCheckedId, 110);
});

test('failed notification write rolls back item, provenance, dedupe and cursor; retry commits them once', async () => {
    const { db, worker, valid, fault, store } = await setup({ baseline: 100 });
    valid.add(101); fault.outbox = true;
    assert.equal((await worker.run()).reason, 'storage_error');
    assert.equal((await store.state()).nextItemId, 101);
    assert.equal((await db.query('SELECT id FROM items WHERE id = 101')).length, 0);
    assert.equal((await db.query('SELECT * FROM catalog_discovered_items WHERE item_id = 101')).length, 0);
    assert.equal((await db.query('SELECT * FROM notification_outbox')).length, 0);
    assert.equal((await db.query("SELECT * FROM catalog_runs WHERE status = 'running'")).length, 0);
    fault.outbox = false;
    await store.requestScan();
    assert.equal((await worker.run()).announced, 1);
    assert.equal((await db.query('SELECT * FROM notification_outbox')).length, 1);
});

test('tooltip discoveries respect owner field protection and accept authoritative Guide completion later', async () => {
    const { db, catalog, worker, valid } = await setup({ baseline: 100 });
    const guide = createGuideDiscoveryStore(db);
    const service = createCatalogService({ db, store: catalog, guideStore: guide });
    await service.addManualEntry({ kind: 'item', record: { id: 101, name: 'Owner draft', stats: { armor: 999 } }, fieldStates: { 'stats.armor': 'do_not_check' } });
    valid.add(101);
    await worker.run();
    let entity = await service.getEntity('item', '101');
    assert.equal(entity.catalog.completeness, 'incomplete');
    assert.equal(entity.fields.stats.armor, 999);
    const authoritative = { id: 101, name: 'Verified Guide item', rarity: 'Epic', stats: { type: 'Armor', armor: 1, hp: 222, level: 6284 }, enhancements: [], droppedBy: [] };
    const prepared = await catalog.prepareGuideFields('item', 101, authoritative, '101');
    await guide.markDetail('item', 101, { outcome: 'ok', hash: 'a'.repeat(64) }, GUIDE_POLICY);
    await catalog.ingestAtomic({ mode: 'guide_discovery', source: 'guide_baseline', observations: mapGuideRecord('item', prepared.record).observations }, {
        onRecorded: async (tx, runId) => {
            const update = prepared.update;
            await tx.query('INSERT INTO catalog_guide_field_updates (run_id, entity_kind, entity_key, source_key, alias_from, payload) VALUES (?, ?, ?, ?, ?, ?)',
                [runId, update.kind, update.key, update.sourceKey, update.aliasFrom, JSON.stringify(update.record)]);
        },
    });
    entity = await service.getEntity('item', '101');
    assert.equal(entity.fields.name, authoritative.name);
    assert.equal(entity.fields.rarity, 'Epic');
    assert.equal(entity.fields.stats.armor, 999);
    assert.equal(entity.fields.stats.hp, 222);
    assert.equal(entity.catalog.completeness, 'complete');
    assert.deepEqual(entity.fields.details.setPieces, ['Shield of Encillious', 'Discovered item 101']);
});

test('provisional data fills unknown legacy columns while preserving known fields and rollback', async () => {
    const { db, worker, store, catalog, valid } = await setup({ baseline: 100, budget: 2 });
    await db.query('INSERT INTO items (id, name) VALUES (?, ?)', [101, 'Legacy name']);
    await store.configure({ startAfterId: 100 }); valid.add(101);
    await worker.run();
    let [item] = await db.query('SELECT name, stats, details FROM items WHERE id = 101');
    assert.equal(item.name, 'Legacy name');
    assert.equal(JSON.parse(item.stats).armor, 8803);
    assert.ok(item.details);
    const [discovery] = await db.query('SELECT run_id FROM catalog_discovered_items WHERE item_id = 101');
    const plan = await catalog.planRollback(discovery.run_id);
    await catalog.executePlan(plan.id, { confirmation: plan.confirmation });
    [item] = await db.query('SELECT name, stats, details FROM items WHERE id = 101');
    assert.deepEqual(item, { name: 'Legacy name', stats: null, details: null });
});
