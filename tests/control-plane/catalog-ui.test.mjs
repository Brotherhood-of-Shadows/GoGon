// tests/control-plane/catalog-ui.test.mjs - CAT-TASK-006 / AC-CAT-007, AC-CAT-008, AC-CAT-009
// The real dashboard page and script in a linkedom DOM, with fetch and EventSource doubles. Checks
// that catalog text is rendered as text (never markup), that coverage and guide status are shown,
// and that a destructive plan needs the exact server phrase before its button is enabled.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { manualRecordFields } from '../../catalog/guideNormalizers.js';

const PUBLIC = path.resolve('control-plane/public');
const APP = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const HOSTILE = '<img src=x onerror=alert(1)>Golem';

const requests = [];
let ui;
let rejectEdit = false;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

const STATE = {
    generatedAt: '2026-09-28T12:00:00.000Z', engine: { paused: false }, account: { state: 'idle', activeLabel: null },
    modules: [], intervalBounds: { min: 5000, max: 86400000 }, sections: {}, settings: [], profiles: [], validation: null, audit: [],
    catalog: {
        jobs: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'guide_discovery', state: 'queued', requestBudget: 50, cursor: {}, lastResult: null }],
        guide: [
            { entityKind: 'item', display: 'waiting_for_browser', status: 'idle', statusReason: null, overdue: true, lastSuccessfulCheckAt: null, lastSeenId: 0, sweepMode: null, nextPage: 0, sweepPagesChecked: 0, orderState: 'attested' },
            { entityKind: 'creature', display: 'challenged', status: 'challenged', statusReason: 'cloudflare challenge', overdue: false, lastSuccessfulCheckAt: '2026-09-27T12:00:00.000Z', lastSeenId: 7002, sweepMode: 'incremental', nextPage: 3, sweepPagesChecked: 3, orderState: 'verified' },
        ],
        available: { observe_realm: 'contract_unverified', item_frontier: 'contract_unverified', guide_discovery: null },
    },
};
const SUMMARY = {
    ...STATE.catalog,
    kinds: { item: { rows: 2, tracked: 2, incomplete: 1, complete: 1 }, creature: { rows: 1, tracked: 1, incomplete: 1, complete: 0 } },
    coverage: { item: { ok: 1, pending: 1, failed: 0, missing: 0 }, creature: { ok: 0, pending: 1, failed: 0, missing: 0 } },
    guideRequestsToday: 12, relayLastSeenAt: null,
    policy: { guide: { checkIntervalMs: 86400000, minDelayMs: 3000, maxRequestsPerExecution: 50, dailyRequestCap: 2000 }, ordering: { order: 'newest_first', firstIndex: 0 }, fullSweep: { indexPages: 1279 } },
};
const PLAN = { id: '22222222-2222-4222-8222-222222222222', action: 'rollback', targetRunId: '33333333-3333-4333-8333-333333333333', expectedCounts: { entities: 1, remove: 1, rows: { items: -1 } }, confirmation: 'ROLLBACK 33333333 1', expiresAt: '2026-09-28T12:10:00.000Z' };
const ITEM_DISCOVERY = { enabled: true, webhookConfigured: true, status: 'scheduled', recommendedStartId: 17069, lastValidId: 17069,
    lastCheckedId: 17079, nextItemId: 17080, lookahead: 10, discoveredTotal: 1, lastCompletedAt: null, nextCheckAt: null,
    recent: [{ id: 17069, record: { name: HOSTILE }, firstSeenAt: '2026-11-03T12:00:00.000Z' }] };

function respond(url, init) {
    const u = new URL(url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/api/session') return { csrf: 'csrf-token' };
    if (p === '/api/catalog/summary') return SUMMARY;
    if (p === '/api/catalog/guide-scan') return { ok: true };
    if (p === '/api/catalog/item-discovery') return init.method === 'POST' ? { ok: true } : ITEM_DISCOVERY;
    if (p === '/api/catalog/item-discovery/run') return { ok: true };
    if (p === '/api/catalog/manual-fields') return { kinds: manualRecordFields() };
    if (p === '/api/catalog/manual-entries') return { ok: true, key: String(JSON.parse(init.body).record.id) };
    if (p === '/api/catalog/entities/creature/7001/edit') {
        if (init.method === 'POST') return rejectEdit ? { error: 'This entry changed since you opened it.' } : { ok: true, key: '7001' };
        return { version: 'a'.repeat(64), fieldStates: { 'stats.level': 'do_not_check' }, record: { id: 7001, name: HOSTILE, description: 'Clear this', stats: { level: 5 },
            realms: [{ realmId: 1200, realmName: 'Forest' }, { realmId: 1201, realmName: 'Desert' }], enhancements: ['Piercing Strike'], droppedItems: [] } };
    }
    if (p === '/api/catalog/entities') return { kind: u.searchParams.get('kind'), page: 1, pageSize: 25, total: 1, items: [{ key: '7001', id: 7001, name: HOSTILE, catalog: { completeness: 'incomplete', incompleteReasons: ['known_drop_unresolved'], lastSeenAt: '2026-09-28T11:00:00.000Z' } }] };
    if (p === '/api/catalog/entities/creature/7001') {
        return { kind: 'creature', key: '7001', fields: { id: 7001, name: HOSTILE, description: '<script>steal()</script>', stats: { level: 5 } }, relations: { realms: [{ id: 1200, name: '<b>Path</b>' }], drops: [] },
            provenance: [{ source: 'guide_baseline', hash: 'abcdef012345', runId: 'r', observedAt: '2026-09-28T11:00:00.000Z', mode: 'guide_discovery', runStatus: 'succeeded' }],
            catalog: { completeness: 'incomplete', incompleteReasons: ['known_drop_unresolved'], firstSeenAt: null, lastSeenAt: null, verifiedAt: null }, guide: null };
    }
    if (p === '/api/catalog/runs') return { page: 1, pageSize: 25, runs: [{ id: PLAN.targetRunId, mode: 'guide_discovery', source: 'guide_baseline', status: 'succeeded', startedAt: '2026-09-28T11:00:00.000Z', summary: { observations: 1 } }] };
    if (p.endsWith('/rollback-plan')) return { ok: true, plan: PLAN };
    if (p.endsWith('/execute')) return { ok: true, result: { runId: PLAN.targetRunId, status: 'reverted' } };
    return { error: 'unexpected' };
}

before(async () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/, '');
    const dom = parseHTML(html);
    // Native HTMLTextAreaElement.type is read-only. Linkedom allows assignment, which previously
    // hid a browser exception when rendering the creature description and left item fields visible.
    Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'type', { configurable: true, get: () => 'textarea', set: undefined });
    const sources = [];
    const location = { assign: url => { location.assigned = url; } };
    const fetch = async (url, init = {}) => {
        requests.push({ url, method: init.method ?? 'GET', body: init.body ?? null, headers: init.headers ?? {} });
        const json = respond(url, init);
        return { ok: !json.error, status: json.error ? 404 : 200, json: async () => json };
    };
    class EventSource { constructor(url) { this.url = url; this.handlers = {}; sources.push(this); } addEventListener(type, fn) { this.handlers[type] = fn; } }
    Object.assign(dom.window, { location, confirm: () => true, EventSource, fetch });
    const context = vm.createContext({
        window: dom.window, document: dom.document, fetch, EventSource, Node: dom.Node, CSS: { escape: s => s },
        URLSearchParams, setTimeout, clearTimeout, console, Date, JSON, Math, Number, String, Object, Array, Promise, Error, Map, Set,
    });
    vm.runInContext(APP, context);
    await flush();
    sources[0].handlers.state({ data: JSON.stringify(STATE) });
    ui = { dom, document: dom.document, sources, Event: dom.Event ?? dom.window.Event };
});

const $ = sel => ui.document.querySelector(sel);
const click = node => node.dispatchEvent(new ui.Event('click', { bubbles: true }));

test('Item releases shows progress and text-safe discoveries; typed controls save with CSRF without resetting the cursor on toggle', async () => {
    click($('.tabs button[data-tab="catalog"]'));
    click($('.subtabs button[data-subtab="upcoming"]'));
    await flush();
    assert.equal($('#catalog-upcoming').hidden, false);
    assert.match($('#item-discovery-progress').textContent, /Last checked ID: 17079/);
    assert.match($('#item-discovery-recent').textContent, /Golem/);
    assert.equal($('#item-discovery-recent img'), null);
    assert.equal($('#id-start').value, '17069');
    $('#id-enabled').checked = false;
    $('#item-discovery-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    let sent = requests.filter(r => r.url === '/api/catalog/item-discovery' && r.method === 'POST').at(-1);
    assert.deepEqual(JSON.parse(sent.body), { enabled: false });
    assert.equal(sent.headers['X-CSRF-Token'], 'csrf-token');
    $('#id-start').value = '17080';
    $('#id-start').dispatchEvent(new ui.Event('input', { bubbles: true }));
    click($('#item-discovery-refresh'));
    await flush();
    assert.equal($('#id-start').value, '17080', 'refresh preserves an unsaved starting ID');
    $('#item-discovery-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    sent = requests.filter(r => r.url === '/api/catalog/item-discovery' && r.method === 'POST').at(-1);
    assert.equal(JSON.parse(sent.body).startAfterId, 17080);
    click($('#item-discovery-run'));
    await flush();
    sent = requests.filter(r => r.url === '/api/catalog/item-discovery/run').at(-1);
    assert.deepEqual(JSON.parse(sent.body), {});
    assert.equal(sent.headers['X-CSRF-Token'], 'csrf-token');
});

test('manual section switches Guide fields, requires only ID and sends optional typed values with CSRF', async () => {
    click(ui.document.querySelector('.tabs button[data-tab="catalog"]'));
    click(ui.document.querySelector('.subtabs button[data-subtab="manual"]'));
    await flush();
    assert.equal($('#catalog-manual').hidden, false);
    assert.equal($('#mf-id').required, true);
    assert.equal($('#mf-name').required, false);
    assert.deepEqual([...ui.document.querySelectorAll('#manual-entry-fields > *')].map(node => node.dataset.field), manualRecordFields().item);
    assert.equal($('#manual-entry-fields [data-field="realms"]'), null);
    $('#mf-id').value = '456';
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    let sent = requests.filter(r => r.url === '/api/catalog/manual-entries').at(-1);
    assert.deepEqual(JSON.parse(sent.body), { kind: 'item', record: { id: 456 } });
    assert.equal(sent.headers['X-CSRF-Token'], 'csrf-token');
    [...ui.document.querySelectorAll('#mf-kind option')].find(o => o.value === 'creature').selected = true;
    $('#mf-kind').dispatchEvent(new ui.Event('change'));
    assert.ok($('#mf-description'));
    assert.deepEqual([...ui.document.querySelectorAll('#manual-entry-fields > *')].map(node => node.dataset.field), manualRecordFields().creature);
    assert.equal($('#mf-rarity'), null);
    assert.equal($('#mf-setBonuses'), null);
    assert.equal($('#mf-droppedBy'), null);
    assert.ok($('#manual-entry-fields [data-field="droppedItems"]'));
    assert.ok($('#manual-entry-fields [data-field="realms"]'));
    assert.doesNotMatch($('#manual-entry-fields').textContent, /JSON/);
    $('#mf-id').value = '457';
    $('#mf-name').value = HOSTILE;
    const realmRows = () => [...ui.document.querySelectorAll('[data-field="realms"] > .manual-rows > .manual-row')];
    realmRows()[0].querySelector('input[name$=".realmId"]').value = '1200';
    realmRows()[0].querySelector('input[name$=".realmName"]').value = 'Forest';
    click($('button[data-add="realms"]'));
    realmRows()[1].querySelector('input[name$=".realmId"]').value = '1201';
    realmRows()[1].querySelector('input[name$=".realmName"]').value = 'Glacier';
    click($('button[data-add="realms"]'));
    click(realmRows()[2].querySelector('button.danger'));
    $('input[data-field="stats.level"]').value = '10';
    $('input[data-field="stats.attack.min"]').value = '20';
    const count = requests.filter(r => r.url === '/api/catalog/manual-entries').length;
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    assert.equal(requests.filter(r => r.url === '/api/catalog/manual-entries').length, count);
    assert.match($('#manual-entry-form .field-error').textContent, /both minimum and maximum/);
    $('input[data-field="stats.attack.max"]').value = '30';
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    sent = requests.filter(r => r.url === '/api/catalog/manual-entries').at(-1);
    assert.deepEqual(JSON.parse(sent.body), { kind: 'creature', record: { id: 457, name: HOSTILE, stats: { level: 10, attack: { min: 20, max: 30 } }, realms: [{ realmId: 1200, realmName: 'Forest' }, { realmId: 1201, realmName: 'Glacier' }] } });
    assert.equal($('#manual-entry-save').disabled, false);
    assert.equal($('#mf-id').value, '', 'ready for another creature');
    for (const kind of ['realm', 'master_realm', 'relic', 'quest', 'creature', 'item']) {
        [...ui.document.querySelectorAll('#mf-kind option')].find(o => o.value === kind).selected = true;
        $('#mf-kind').dispatchEvent(new ui.Event('change'));
        assert.deepEqual([...ui.document.querySelectorAll('#manual-entry-fields > *')].map(node => node.dataset.field), manualRecordFields()[kind]);
        assert.deepEqual([...ui.document.querySelectorAll('#manual-entry-fields [name]')].filter(input => input.required).map(input => input.name), ['id']);
    }
});

test('CAT-TASK-006: the dashboard script never parses markup', () => {
    for (const sink of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/]) assert.doesNotMatch(APP, sink);
});

test('Scan Guide now uses the existing scheduler and describes incomplete-only detail fetching', async () => {
    click(ui.document.querySelector('.tabs button[data-tab="catalog"]'));
    await flush();
    assert.match($('#guide-policy').textContent, /Completed details are skipped/);
    click($('#guide-scan-now'));
    await flush();
    const request = requests.find(r => r.url === '/api/catalog/guide-scan');
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), {});
    assert.equal(request.headers['X-CSRF-Token'], 'csrf-token');
});

test('AC-CAT-008: guide status, overdue checks, and job availability come from the state stream', () => {
    const rows = [...ui.document.querySelectorAll('#guide-status tr')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /waiting for browser/);
    assert.match(rows[0].textContent, /overdue/);
    assert.match(rows[1].textContent, /challenged cloudflare challenge/);
    const options = [...ui.document.querySelectorAll('#jf-kind option')];
    assert.deepEqual(options.map(o => [o.value, o.disabled]), [['observe_realm', true], ['item_frontier', true], ['guide_discovery', false]]);
    assert.match(options[0].textContent, /needs a verified game read contract/);
    assert.match($('#catalog-jobs').textContent, /guide_discovery/);
});

test('AC-CAT-007: browse renders hostile names and details as text, with coverage reasons', async () => {
    click(ui.document.querySelector('.tabs button[data-tab="catalog"]'));
    await flush();
    assert.equal($('#tab-catalog').hidden, false);
    const row = $('#catalog-entities tr');
    assert.equal(row.children[1].textContent, HOSTILE);
    assert.equal($('#catalog-entities img'), null, 'no element was created from the name');
    assert.match(row.textContent, /a known drop is not in the catalog/);
    assert.match($('#catalog-kinds').textContent, /item: 2 rows, 2 tracked, 1 incomplete/);
    assert.match($('#guide-policy').textContent, /12 requests today; no daily limit/);
    assert.match($('#relay-tokens').textContent, /set gogonRelayToken to a token issued here/, 'relay setup is explained; no token is shown');
    // Switch the filter to creatures and search through the form.
    [...ui.document.querySelectorAll('#cf-kind option')].find(o => o.getAttribute('value') === 'creature').selected = true;
    $('#cf-q').value = 'Golem';
    $('#catalog-filter').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    const search = requests.filter(r => r.url.startsWith('/api/catalog/entities?')).at(-1).url;
    assert.equal(new URLSearchParams(search.split('?')[1]).get('kind'), 'creature');
    assert.equal(new URLSearchParams(search.split('?')[1]).get('q'), 'Golem');
    click($('#catalog-entities tr'));
    await flush();
    const detail = $('#catalog-detail');
    assert.equal(detail.hidden, false);
    assert.equal(detail.querySelector('img'), null);
    assert.equal(detail.querySelector('script'), null);
    assert.equal(detail.querySelector('b'), null);
    assert.match(detail.textContent, /<script>steal\(\)<\/script>/);
    assert.match(detail.textContent, /<b>Path<\/b> \(#1200\)/);
    assert.ok(requests.some(r => r.url === '/api/catalog/entities/creature/7001'));
});

test('existing entries open prefilled structured fields, retain failed edits, and submit only changed fields', async () => {
    const edit = [...ui.document.querySelectorAll('#catalog-detail button')].find(button => button.textContent === 'Edit entry');
    assert.ok(edit);
    click(edit);
    await flush();
    assert.equal($('#catalog-manual').hidden, false);
    assert.equal($('#mf-id').readOnly, true);
    assert.equal($('#mf-kind').disabled, true);
    assert.equal($('#mf-name').value, HOSTILE);
    assert.equal($('input[data-field="stats.level"]').value, '5');
    assert.equal($('#manual-entry-title').textContent, 'Edit creature');
    assert.equal($('#manual-entry-fields img'), null);
    const group = $('[data-field="realms"]');
    assert.equal(group.querySelectorAll('.manual-row').length, 2);
    click(group.querySelector('.manual-row button.danger'));
    click(group.querySelector('[data-add="realms"]'));
    const last = [...group.querySelectorAll('.manual-row')].at(-1);
    last.querySelector('input[name$=".realmId"]').value = '7071';
    last.querySelector('input[name$=".realmName"]').value = 'PONNATION GLACIER (GRAVE)';
    $('#mf-description').value = '';
    const choosePolicy = (path, value) => [...ui.document.querySelectorAll(`select[data-policy="${path}"] option`)].find(option => option.value === value).selected = true;
    choosePolicy('realms', 'do_not_check');
    choosePolicy('description', 'complete');
    assert.equal($('select[data-policy="stats.level"]').value, 'do_not_check');
    rejectEdit = true;
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    assert.match($('#manual-entry-form .field-error').textContent, /changed since you opened/);
    assert.equal(last.querySelector('input[name$=".realmId"]').value, '7071', 'a failed save preserves entered data');
    assert.equal($('#manual-entry-save').disabled, false);
    rejectEdit = false;
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    const request = requests.filter(r => r.url.endsWith('/creature/7001/edit') && r.method === 'POST').at(-1);
    assert.deepEqual(JSON.parse(request.body), { version: 'a'.repeat(64), record: { description: null, realms: [{ realmId: 1201, realmName: 'Desert' }, { realmId: 7071, realmName: 'PONNATION GLACIER (GRAVE)' }] }, fieldStates: { description: 'complete', realms: 'do_not_check' } });
    assert.equal(request.headers['X-CSRF-Token'], 'csrf-token');
    assert.equal($('#mf-id').readOnly, false);
    assert.equal($('#mf-kind').disabled, false);
    assert.equal($('#manual-entry-cancel').hidden, true);
});

test('a single stat can be unlocked for Guide updates without rewriting the record', async () => {
    $('#mf-id').value = '7001';
    click($('#manual-entry-open'));
    await flush();
    const select = $('select[data-policy="stats.level"]');
    assert.equal(select.value, 'do_not_check');
    [...select.querySelectorAll('option')].find(option => option.value === 'incomplete').selected = true;
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    const request = requests.filter(r => r.url.endsWith('/creature/7001/edit') && r.method === 'POST').at(-1);
    assert.deepEqual(JSON.parse(request.body), { version: 'a'.repeat(64), record: {}, fieldStates: { 'stats.level': 'incomplete' } });
});

test('structured item stats, enhancements, set bonuses and section rows build valid Guide records', async () => {
    const selectKind = async kind => {
        [...ui.document.querySelectorAll('#mf-kind option')].find(option => option.value === kind).selected = true;
        $('#mf-kind').dispatchEvent(new ui.Event('change'));
    };
    await selectKind('item');
    $('#mf-id').value = '800';
    $('input[data-field="stats.attack"]').value = '20';
    $('input[data-field="stats.type"]').value = 'Weapon';
    $('[data-field="enhancements"] input[name$=".name"]').value = 'Piercing Strike';
    $('[data-field="enhancements"] input[name$=".value"]').value = '5';
    $('input[data-field="setBonuses.hp"]').value = '30';
    $('[data-field="droppedBy"] input[name$=".creatureName"]').value = 'Golem';
    $('[data-field="droppedBy"] input[name$=".dropRate"]').value = '0.5';
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    let sent = requests.filter(r => r.url === '/api/catalog/manual-entries').at(-1);
    assert.deepEqual(JSON.parse(sent.body), { kind: 'item', record: { id: 800, stats: { attack: 20, type: 'Weapon' }, enhancements: [{ name: 'Piercing Strike', value: 5 }], setBonuses: { hp: 30 }, droppedBy: [{ creatureName: 'Golem', dropRate: 0.5 }] } });
    await selectKind('quest');
    $('#mf-id').value = '801';
    $('[data-field="sections"] input[name$=".heading"]').value = 'Rewards';
    $('[data-field="sections"] textarea').value = '100 XP';
    $('#manual-entry-form').dispatchEvent(new ui.Event('submit', { cancelable: true }));
    await flush();
    sent = requests.filter(r => r.url === '/api/catalog/manual-entries').at(-1);
    assert.deepEqual(JSON.parse(sent.body), { kind: 'quest', record: { id: 801, sections: [{ heading: 'Rewards', text: '100 XP' }] } });
    await selectKind('item');
});

test('AC-CAT-009: a rollback shows the server plan and stays disabled until the exact phrase is typed', async () => {
    click(ui.document.querySelector('.subtabs button[data-subtab="history"]'));
    await flush();
    const preview = [...ui.document.querySelectorAll('#catalog-runs button')].find(b => b.textContent === 'Preview rollback');
    click(preview);
    await flush();
    const panel = $('#plan-panel');
    assert.equal(panel.hidden, false);
    assert.equal(panel.querySelector('code').textContent, PLAN.confirmation);
    const input = panel.querySelector('input');
    const execute = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Roll back');
    assert.equal(execute.disabled, true);
    input.value = 'ROLLBACK 33333333';
    input.dispatchEvent(new ui.Event('input'));
    assert.equal(execute.disabled, true);
    input.value = PLAN.confirmation;
    input.dispatchEvent(new ui.Event('input'));
    assert.equal(execute.disabled, false);
    click(execute);
    await flush();
    const exec = requests.find(r => r.url.endsWith('/execute'));
    assert.equal(exec.method, 'POST');
    assert.deepEqual(JSON.parse(exec.body), { confirmation: PLAN.confirmation });
    assert.equal(exec.headers['X-CSRF-Token'], 'csrf-token');
    assert.equal(panel.hidden, true);
});
