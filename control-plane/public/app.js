// control-plane/public/app.js - GoGon owner dashboard (AC-CTRL-002, AC-CTRL-003, AC-CTRL-004, AC-CTRL-006).
// All server data is rendered with textContent / element properties, never parsed as HTML markup.
'use strict';

let csrf = null;
let state = null;
const settingForms = new Map();   // key -> { form, notifForm }
let formCounter = 0;              // notification settings appear in two tabs; element IDs stay unique

// --- utilities -------------------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) node[k] = v;
    }
    for (const c of children) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
}

function fmtTime(value) {
    if (!value) return '-';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

function fmtAgo(ms) {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

function showBanner(message, kind = 'error') {
    const b = document.getElementById('banner');
    b.textContent = message;
    b.className = `banner banner-${kind}`;
    b.hidden = !message;
    if (message && kind !== 'error') setTimeout(() => { if (b.textContent === message) b.hidden = true; }, 4000);
}

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { window.location.assign('/login'); throw new Error('Signed out.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status}).`);
        err.fields = data.fields || {};
        throw err;
    }
    return data;
}

function fieldMessage(err) {
    const f = err.fields || {};
    return Object.values(f)[0] || err.message;
}

// --- rendering ---------------------------------------------------------------------------------------
function renderHeader() {
    const engine = document.getElementById('engine-indicator');
    engine.textContent = state.engine.paused ? 'engine paused' : 'engine running';
    engine.className = `pill ${state.engine.paused ? 'pill-warn' : 'pill-ok'}`;

    const acct = document.getElementById('account-indicator');
    const a = state.account;
    acct.textContent = a.state === 'switching' ? 'switching account...'
        : a.state === 'failed-closed' ? 'no active account'
        : `account: ${a.activeLabel ?? '.env credentials'}`;
    acct.className = `pill ${a.state === 'failed-closed' ? 'pill-bad' : a.state === 'switching' ? 'pill-warn' : ''}`;
    if (a.state === 'failed-closed' && a.lastError) showBanner(a.lastError);
}

function renderModules() {
    const body = document.getElementById('modules-body');
    const focused = document.activeElement?.closest?.('#modules-body tr')?.dataset.id;
    const rows = [];
    for (const m of state.modules) {
        if (m.id === focused) { rows.push(body.querySelector(`tr[data-id="${CSS.escape(m.id)}"]`)); continue; }
        const toggle = el('input', { type: 'checkbox', checked: m.enabled, disabled: state.engine.paused, title: m.enabled ? 'Disable' : 'Enable' });
        toggle.addEventListener('change', async () => {
            toggle.disabled = true;
            try { await api('PATCH', `/api/modules/${encodeURIComponent(m.id)}`, { enabled: toggle.checked }); showBanner(`${m.id} ${toggle.checked ? 'enabled' : 'disabled'}.`, 'ok'); }
            catch (e) { toggle.checked = !toggle.checked; showBanner(fieldMessage(e)); }
            finally { toggle.disabled = false; }
        });
        const interval = el('input', {
            type: 'number', min: state.intervalBounds.min / 1000, max: state.intervalBounds.max / 1000, step: 1,
            value: Math.round(m.intervalMs / 1000), class: 'interval', title: `Default ${m.defaultIntervalMs / 1000}s`,
        });
        interval.addEventListener('change', async () => {
            const ms = Math.round(Number(interval.value) * 1000);
            try { await api('PATCH', `/api/modules/${encodeURIComponent(m.id)}`, { intervalMs: ms }); showBanner(`${m.id} interval set to ${ms / 1000}s (applies after the current run).`, 'ok'); }
            catch (e) { interval.value = Math.round(m.intervalMs / 1000); showBanner(fieldMessage(e)); }
        });
        const last = m.lastRun;
        const result = !last ? '-' : last.outcome === 'ok' ? `ok in ${last.durationMs} ms` : last.outcome === 'aborted' ? 'stopped' : `error: ${last.error ?? ''}`;
        rows.push(el('tr', { dataset: { id: m.id } },
            el('td', {}, el('strong', {}, m.id)),
            el('td', {}, el('span', { class: `pill pill-${m.health}` }, m.running ? 'running' : m.health)),
            el('td', {}, toggle),
            el('td', {}, interval),
            el('td', {}, last ? fmtAgo(last.startedAt) : 'never'),
            el('td', { class: last?.outcome === 'error' ? 'error' : '' }, result),
        ));
    }
    body.replaceChildren(...rows);
}

function badge(text, cls = '') { return el('span', { class: `badge ${cls}` }, text); }

function buildSettingForm(def) {
    const form = document.getElementById('setting-template').content.firstElementChild.cloneNode(true);
    const input = form.querySelector('.setting-input');
    const id = `setting-${def.key}-${++formCounter}`;
    input.id = id;
    form.querySelector('.setting-label').htmlFor = id;
    form.querySelector('.setting-label').textContent = def.label;
    form.querySelector('.setting-desc').textContent = `${def.key} - ${def.description}`;
    input.name = 'value';
    if (def.sensitivity === 'secret') { input.type = 'password'; input.autocomplete = 'new-password'; }
    if (def.type === 'boolean') { input.inputMode = 'numeric'; input.maxLength = 1; }
    const error = form.querySelector('.field-error');
    const revert = form.querySelector('.revert');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        try {
            const r = await api('PUT', `/api/config/${def.key}`, { value: input.value });
            if (def.sensitivity === 'secret') input.value = '';
            input.dataset.dirty = '';
            showBanner(`${def.label} saved (${r.applied}).`, 'ok');
        } catch (e) {
            error.textContent = fieldMessage(e);
            error.hidden = false;
        }
    });
    input.addEventListener('input', () => { input.dataset.dirty = '1'; });
    revert.addEventListener('click', async () => {
        error.hidden = true;
        try {
            await api('DELETE', `/api/config/${def.key}`);
            input.dataset.dirty = '';
            showBanner(`${def.label} now uses the .env/default value.`, 'ok');
        } catch (e) { error.textContent = fieldMessage(e); error.hidden = false; }
    });
    return form;
}

function updateSettingForm(form, def) {
    const input = form.querySelector('.setting-input');
    const badges = form.querySelector('.badges');
    const save = form.querySelector('.save');
    const revert = form.querySelector('.revert');
    badges.replaceChildren(
        badge(def.reloadMode, `reload-${def.reloadMode}`),
        badge(`source: ${def.source}`),
        def.sensitivity === 'secret' ? badge(def.isSet ? 'set' : 'not set', def.isSet ? 'ok' : 'warn') : null,
    );
    input.disabled = !def.editable;
    save.hidden = !def.editable;
    revert.hidden = !def.editable || def.source !== 'override';
    if (def.reloadMode === 'controlled-session-switch') input.placeholder = 'Use the Accounts tab';
    else if (def.sensitivity === 'secret') input.placeholder = def.isSet ? 'set (enter a new value to replace)' : 'not set';
    else if (def.options) input.placeholder = def.options.join(' | ');
    if (def.sensitivity !== 'secret' && document.activeElement !== input && !input.dataset.dirty) input.value = def.value ?? '';
}

function renderSettings() {
    const notif = document.getElementById('notifications-settings');
    const all = document.getElementById('all-settings');
    const bySection = new Map();
    for (const def of state.settings) {
        let entry = settingForms.get(def.key);
        if (!entry) { entry = { form: buildSettingForm(def), notifForm: null }; settingForms.set(def.key, entry); }
        updateSettingForm(entry.form, def);
        if (!bySection.has(def.section)) bySection.set(def.section, []);
        bySection.get(def.section).push(entry.form);
        if (def.section === 'notifications' || def.section === 'webhooks') {
            if (!entry.notifForm) entry.notifForm = buildSettingForm(def);
            updateSettingForm(entry.notifForm, def);
        }
    }
    const order = ['GG_CONFLICT_PING_MENTION'];
    const notifForms = state.settings.filter(d => d.section === 'notifications' || d.section === 'webhooks')
        .sort((a, b) => (order.includes(b.key) - order.includes(a.key)))
        .map(d => settingForms.get(d.key).notifForm);
    if (notif.children.length !== notifForms.length) notif.replaceChildren(...notifForms);

    if (all.childElementCount === 0) {
        for (const [section, forms] of bySection) {
            all.append(el('h3', {}, state.sections[section] ?? section), el('div', { class: 'settings-grid' }, ...forms));
        }
    }

    const v = state.validation;
    const box = document.getElementById('validation');
    const problems = v ? [...(v.details?.errors ?? []), ...(v.details?.warnings ?? [])] : [];
    box.hidden = problems.length === 0;
    box.replaceChildren(el('strong', {}, 'Configuration validation'), ...problems.map(p => el('pre', {}, p)));
}

function renderAccounts() {
    const a = state.account;
    document.getElementById('account-state').replaceChildren(
        el('div', {}, el('strong', {}, 'Active account: '), a.activeLabel ?? (a.state === 'failed-closed' ? 'none (tasks paused)' : '.env credentials')),
        el('div', { class: 'muted' }, `Switch state: ${a.state}`),
        a.lastError ? el('div', { class: 'error' }, a.lastError) : null,
    );
    const body = document.getElementById('profiles-body');
    body.replaceChildren(...state.profiles.map(p => {
        const activate = el('button', { type: 'button', disabled: p.active || a.state === 'switching' }, p.active ? 'Active' : 'Switch to');
        activate.addEventListener('click', async () => {
            if (!window.confirm(`Switch the game account to "${p.label}"? All modules pause until the sign-in succeeds.`)) return;
            activate.disabled = true;
            try { const r = await api('POST', `/api/profiles/${p.id}/activate`); showBanner(`Now using "${r.activeLabel}". Resumed ${r.resumed.length} module(s).`, 'ok'); }
            catch (e) { showBanner(fieldMessage(e)); }
        });
        const rotateForm = el('form', { class: 'inline-form', hidden: true, autocomplete: 'off' },
            el('input', { name: 'email', type: 'email', placeholder: 'new email', maxLength: 254, required: true, autocomplete: 'off' }),
            el('input', { name: 'password', type: 'password', placeholder: 'new password', maxLength: 256, required: true, autocomplete: 'new-password' }),
            el('button', { type: 'submit' }, 'Save'));
        rotateForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            try {
                await api('PUT', `/api/profiles/${p.id}/credentials`, { email: rotateForm.email.value, password: rotateForm.password.value });
                rotateForm.reset(); rotateForm.hidden = true;
                showBanner(`Credentials for "${p.label}" replaced.`, 'ok');
            } catch (e) { showBanner(fieldMessage(e)); }
        });
        const rotate = el('button', { type: 'button', class: 'ghost' }, 'Replace credentials');
        rotate.addEventListener('click', () => { rotateForm.hidden = !rotateForm.hidden; });
        const del = el('button', { type: 'button', class: 'ghost danger', disabled: p.active }, 'Delete');
        del.addEventListener('click', async () => {
            if (!window.confirm(`Delete profile "${p.label}"?`)) return;
            try { await api('DELETE', `/api/profiles/${p.id}`); showBanner(`Deleted "${p.label}".`, 'ok'); }
            catch (e) { showBanner(fieldMessage(e)); }
        });
        return el('tr', {},
            el('td', {}, p.label),
            el('td', {}, p.active ? el('span', { class: 'pill pill-ok' }, 'active') : 'inactive'),
            el('td', {}, fmtTime(p.updatedAt)),
            el('td', { class: 'actions' }, activate, rotate, del, rotateForm));
    }));
}

function renderAudit() {
    document.getElementById('audit-body').replaceChildren(...state.audit.map(e => el('tr', {},
        el('td', {}, fmtTime(e.occurredAt)),
        el('td', {}, e.actor),
        el('td', {}, e.action),
        el('td', {}, e.subject),
        el('td', { class: e.outcome === 'success' ? '' : 'error' }, e.outcome))));
}

// --- notification outbox (specs/tasks/2026-10-notification-outbox.md) -------------------------------
// Rows carry no payload or webhook URL; failed rows can be retried or discarded.
async function loadOutbox() {
    let view;
    try {
        view = await api('GET', '/api/notifications');
    } catch (e) { showBanner(fieldMessage(e)); return; }
    const c = view.counts;
    document.getElementById('outbox-counts').textContent =
        `${c.pending - c.held} pending, ${c.held} held, ${c.failed} failed, ${c.delivered} delivered (kept 7 days)` +
        (view.oldestPendingAt ? `; oldest pending since ${fmtTime(view.oldestPendingAt)}` : '') +
        `; sending for ${view.activeAccount ?? 'no account'}`;
    const action = (row, what) => el('button', { type: 'button', class: 'ghost', onclick: async () => {
        try { await api('POST', `/api/notifications/${row.id}/${what}`); showBanner(`Notification ${row.id}: ${what} done.`, 'ok'); }
        catch (e) { showBanner(fieldMessage(e)); }
        loadOutbox();
    } }, what === 'retry' ? 'Retry' : 'Discard');
    const stateCell = row => row.state === 'failed' ? el('span', { class: 'pill pill-bad' }, 'failed')
        : el('span', { class: 'pill pill-warn' }, row.held ? 'held' : 'retrying');
    document.getElementById('outbox-body').replaceChildren(...view.rows.map(row => el('tr', {},
        el('td', {}, row.id),
        el('td', {}, row.source),
        el('td', {}, `${row.eventId}${row.part ? ` #${row.part}` : ''}`),
        el('td', {}, row.account),
        el('td', {}, row.settingKey),
        el('td', {}, stateCell(row)),
        el('td', {}, row.attempts),
        el('td', {}, row.lastError ?? '-'),
        el('td', {}, row.state === 'pending' ? fmtTime(row.nextAttemptAt) : '-'),
        el('td', { class: 'actions' }, ...(row.state === 'failed' ? [action(row, 'retry'), action(row, 'discard')] : [])))));
}

// --- catalog (CAT-TASK-006 / AC-CAT-007, AC-CAT-008, AC-CAT-009) --------------------------------------
// Every catalog value is data from the game or guide: it is rendered with textContent (el()), never as
// markup. Destructive actions show the server's plan and need its exact confirmation phrase.
const catalogView = { kind: 'item', q: '', completeness: '', page: 1, pageSize: 25, total: 0, runsPage: 1, summary: null };
let manualFields = null;
let manualEdit = null;
let manualReaders = new Map();
let manualStateReaders = new Map();
let manualControlId = 0;
const manualLabel = name => name === 'id' ? 'ID' : name.replace(/([A-Z])/g, ' $1').replace(/\bId\b/g, 'ID').replace(/^./, c => c.toUpperCase());
const textField = (max = 191) => ({ type: 'text', max });
const numberField = (min = -1e12, max = 1e12, step = 1) => ({ type: 'number', min, max, step });
const idField = () => numberField(1, 10000000);
const objectFields = fields => ({ type: 'object', fields });
const listFields = (fields, required = [], max = 200) => ({ type: 'list', fields, required, max });
const ITEM_STAT_FIELDS = Object.fromEntries(['level', 'attack', 'defense', 'armor', 'damage', 'hp', 'xpGain', 'stamina', 'staminaGain', 'goldGain'].map(name => [name, numberField()]));
ITEM_STAT_FIELDS.type = textField(64);
const ENHANCEMENT_FIELDS = { name: textField(), value: numberField(0, 100000, 'any') };
const enhancementRows = () => listFields(ENHANCEMENT_FIELDS, ['name', 'value'], 64);

function manualDefinition(kind, name) {
    if (name === 'stats') return objectFields(kind === 'creature'
        ? { class: textField(64), level: numberField(), ...Object.fromEntries(['attack', 'defense', 'armor', 'damage', 'hp', 'gold', 'xp'].map(key => [key, { ...objectFields({ min: numberField(), max: numberField() }), required: ['min', 'max'] }])) }
        : ITEM_STAT_FIELDS);
    if (name === 'setBonuses') return objectFields({ ...ITEM_STAT_FIELDS, enhancements: enhancementRows() });
    if (name === 'enhancements') return kind === 'creature' ? listFields({ value: textField(256) }, ['value'], 64) : enhancementRows();
    if (name === 'realms') return listFields({ realmId: idField(), realmName: textField(), ...(kind === 'master_realm' ? { minLevel: numberField(0, 2147483647) } : {}) }, ['realmId']);
    if (name === 'droppedItems') return listFields({ itemId: idField(), itemName: textField() }, ['itemId']);
    if (name === 'droppedBy') return listFields({ creatureName: textField(), dropRate: numberField(0, 100, 'any') }, manualEdit ? ['creatureName'] : ['creatureName', 'dropRate']);
    if (name === 'mapObjects' || name === 'details') return { type: 'tree' };
    if (name === 'shops') return listFields({ shopId: idField(), shopName: textField() }, ['shopId']);
    if (name === 'relics') return listFields({ relicId: idField(), relicName: textField() }, ['relicName']);
    if (name === 'quests') return listFields({ questId: idField(), questName: textField() }, manualEdit ? ['questName'] : ['questId', 'questName']);
    if (name === 'creatures') return listFields({ creatureId: idField(), creatureName: textField() }, ['creatureId']);
    if (name === 'stairways') return listFields({ targetRealmId: idField(), targetRealmName: textField() }, ['targetRealmId']);
    if (name === 'sections') return listFields({ heading: textField(), text: { type: 'textarea', max: 8192 } }, ['heading', 'text'], 64);
    if (name === 'description') return { type: 'textarea', max: 8192 };
    if (['id', 'setId', 'realmId', 'masterRealmId'].includes(name)) return idField();
    if (name === 'minLevel') return numberField(0, 2147483647);
    return textField(name === 'imageUrl' ? 512 : name === 'rarity' ? 64 : 191);
}

function attachManualState(node, path, group = false) {
    if (path === 'id' || path.split('.').some(part => /^\d+$/.test(part))) return;
    let inherited = path;
    while (inherited && !manualEdit?.fieldStates?.[inherited]) inherited = inherited.split('.').slice(0, -1).join('.');
    const initial = manualEdit?.fieldStates?.[inherited] ?? manualEdit?.defaultFieldState ?? 'incomplete';
    const id = `mf-state-${++manualControlId}`;
    const select = el('select', { id, dataset: { policy: path } }, ...[
        ['incomplete', 'Incomplete'], ['do_not_check', 'Do not check'], ['complete', 'Complete'],
    ].map(([value, label]) => el('option', { value, selected: value === initial }, label)));
    node.append(el('label', { class: 'manual-state', htmlFor: id }, 'Guide updates ', select));
    manualStateReaders.set(path, { initial, group, read: () => select.value });
}

// Each control reads typed values directly; optional empty rows never create invented data.
function manualControl(def, value, path, label = manualLabel(path.split('.').at(-1))) {
    const id = `mf-${path.replaceAll('.', '-')}-${++manualControlId}`;
    if (def.type === 'tree') { const control = manualTreeControl(value, path, label); attachManualState(control.node, path); return control; }
    if (def.type === 'object') {
        const readers = Object.entries(def.fields).map(([key, child]) => [key, manualControl(child, value?.[key], `${path}.${key}`)]);
        const node = el('fieldset', { class: 'manual-group', dataset: { field: path } }, el('legend', {}, label), ...readers.map(([, child]) => child.node));
        attachManualState(node, path, true);
        return { node, read: () => {
            const result = { ...(value ?? {}) };
            for (const [key, child] of readers) {
                const next = child.read();
                if (next === undefined) delete result[key]; else result[key] = next;
            }
            if (Object.keys(result).length && def.required?.some(key => result[key] === undefined)) throw new Error(`${label}: enter both minimum and maximum.`);
            if (def.required && result.min > result.max) throw new Error(`${label}: minimum cannot exceed maximum.`);
            return Object.keys(result).length || value && !Object.keys(value).length ? result : undefined;
        } };
    }
    if (def.type === 'list') {
        const rows = el('div', { class: 'manual-rows' });
        const entries = [];
        const add = el('button', { type: 'button', class: 'ghost', dataset: { add: path } }, `Add ${label.toLowerCase()} row`);
        const append = (initial = {}) => {
            if (entries.length >= def.max) return;
            const index = ++manualControlId;
            const readers = Object.entries(def.fields).map(([key, child]) => [key, manualControl(child, initial[key], `${path}.${index}.${key}`)]);
            const remove = el('button', { type: 'button', class: 'ghost danger', title: `Remove ${label.toLowerCase()} row` }, 'Remove');
            const row = el('div', { class: 'manual-row' }, ...readers.map(([, child]) => child.node), remove);
            const entry = { row, readers };
            entries.push(entry);
            remove.addEventListener('click', () => { entries.splice(entries.indexOf(entry), 1); row.remove(); add.disabled = false; });
            rows.append(row);
            add.disabled = entries.length >= def.max;
        };
        for (const entry of value ?? []) append(typeof entry === 'string'
            ? { [Object.hasOwn(def.fields, 'relicName') ? 'relicName' : 'value']: entry } : entry);
        if (!entries.length) append();
        add.addEventListener('click', () => append());
        const node = el('fieldset', { class: 'manual-group', dataset: { field: path } }, el('legend', {}, label), rows, add);
        attachManualState(node, path);
        return { node, read: () => {
            const result = [];
            for (const entry of entries) {
                const values = Object.fromEntries(entry.readers.map(([key, child]) => [key, child.read()]).filter(([, next]) => next !== undefined));
                if (!Object.keys(values).length) continue;
                for (const key of def.required) if (values[key] === undefined) throw new Error(`${label}: enter ${manualLabel(key).toLowerCase()} for each filled row.`);
                if (path === 'enhancements' && Object.hasOwn(values, 'value') && !Object.hasOwn(def.fields, 'name')) result.push(values.value);
                else if (path === 'relics' && values.relicId === undefined) result.push(values.relicName);
                else result.push(values);
            }
            return result.length || Array.isArray(value) ? result : undefined;
        } };
    }
    const input = el(def.type === 'textarea' ? 'textarea' : 'input', {
        id, name: path, value: value ?? '', dataset: { field: path },
        ...(def.type === 'textarea' ? { rows: 3, maxLength: def.max }
            : def.type === 'number' ? { type: 'number', min: def.min, max: def.max, step: def.step }
                : { type: 'text', maxLength: def.max }),
    });
    if (!path.includes('.')) input.id = `mf-${path}`;
    input.required = path === 'id' && !manualEdit;
    input.readOnly = path === 'id' && Boolean(manualEdit);
    const node = el('div', { class: 'manual-field' }, el('label', { htmlFor: input.id }, label + (input.required ? ' *' : '')), input);
    if (!def.noState) attachManualState(node, path);
    return { node, read: () => {
        const raw = input.value.trim();
        if (!raw) return value === '' ? '' : undefined;
        if (def.type !== 'number') return raw;
        const number = Number(raw);
        if (!Number.isFinite(number) || number < def.min || number > def.max || def.step === 1 && !Number.isInteger(number)) throw new Error(`${label} must be a valid number between ${def.min} and ${def.max}.`);
        return number;
    } };
}

function manualTreeControl(value, path, label) {
    const initialType = value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value === 'object' || value === undefined ? 'object' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';
    const typeId = `mf-tree-type-${++manualControlId}`;
    const type = el('select', { id: typeId }, ...['object', 'list', 'text', 'number', 'boolean', 'null'].map(name => el('option', { value: name, selected: name === initialType }, name)));
    const body = el('div', { class: 'manual-rows' });
    let read;
    const render = initial => {
        const selected = type.value;
        const entries = [];
        const append = (key = '', data) => {
            const child = manualTreeControl(data === undefined ? '' : data, `${path}.${++manualControlId}`, selected === 'list' ? 'Value' : 'Field value');
            const name = el('input', { type: 'text', value: key, placeholder: 'Field name', maxLength: 191, ariaLabel: 'Field name' });
            const remove = el('button', { type: 'button', class: 'ghost danger' }, 'Remove');
            const row = el('div', { class: 'manual-row' }, ...(selected === 'object' ? [name] : []), child.node, remove);
            const entry = { name, child };
            entries.push(entry);
            remove.addEventListener('click', () => { entries.splice(entries.indexOf(entry), 1); row.remove(); });
            body.append(row);
        };
        body.replaceChildren();
        if (selected === 'object' || selected === 'list') {
            const add = el('button', { type: 'button', class: 'ghost' }, selected === 'list' ? 'Add value' : 'Add field');
            add.addEventListener('click', () => { if (entries.length < 200) append(); });
            for (const [key, data] of Object.entries(initial ?? {})) append(key, data);
            body.append(add);
            read = () => {
                const pairs = entries.map(entry => [entry.name.value.trim(), entry.child.read()]).filter(([, data]) => data !== undefined);
                if (!pairs.length && value === undefined) return undefined;
                if (selected === 'list') return pairs.map(([, data]) => data);
                if (pairs.some(([key]) => !key)) throw new Error(`${label}: enter a name for each field.`);
                if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error(`${label}: field names must be unique.`);
                return Object.fromEntries(pairs);
            };
        } else if (selected === 'null') read = () => null;
        else if (selected === 'boolean') {
            const input = el('input', { type: 'checkbox', checked: initial === true });
            body.append(el('label', {}, input, ' Yes'));
            read = () => input.checked;
        } else {
            const control = manualControl({ ...(selected === 'number' ? numberField(-1e12, 1e12, 'any') : textField(8192)), noState: true }, typeof initial === 'object' ? '' : initial, `${path}.value`, 'Value');
            body.append(control.node);
            read = control.read;
        }
    };
    type.addEventListener('change', () => render(undefined));
    render(value);
    return { node: el('fieldset', { class: 'manual-group' }, el('legend', {}, label), el('label', { htmlFor: typeId }, 'Value type'), type, body), read: () => read() };
}

async function loadManualForm() {
    try {
        if (!manualFields) manualFields = (await api('GET', '/api/catalog/manual-fields')).kinds;
        renderManualFields();
    } catch (e) { showBanner(fieldMessage(e)); }
}

function renderManualFields() {
    const kind = document.getElementById('mf-kind').value;
    if (!manualFields?.[kind]) return;
    manualReaders = new Map();
    manualStateReaders = new Map();
    document.getElementById('manual-entry-fields').replaceChildren(...manualFields[kind].map(name => {
        const control = manualControl(manualDefinition(kind, name), manualEdit?.record[name], name);
        control.node.dataset.field = name;
        manualReaders.set(name, control.read);
        return control.node;
    }));
    document.getElementById('manual-entry-save').textContent = manualEdit ? 'Save changes' : 'Add incomplete entry';
    document.getElementById('manual-entry-cancel').hidden = !manualEdit;
    document.getElementById('manual-entry-open').hidden = Boolean(manualEdit);
    document.getElementById('mf-kind').disabled = Boolean(manualEdit);
    document.getElementById('manual-entry-title').textContent = manualEdit ? `Edit ${kind.replace('_', ' ')}` : 'Add a catalog entry';
    document.querySelector('#manual-entry-form .field-error').hidden = true;
}

async function editCatalogEntity(kind, key) {
    try {
        const entry = await api('GET', `/api/catalog/entities/${encodeURIComponent(kind)}/${encodeURIComponent(key)}/edit`);
        manualEdit = { kind, key, ...entry };
        [...document.querySelectorAll('#mf-kind option')].find(option => option.value === kind).selected = true;
        await openCatalogTab('manual');
        document.getElementById('mf-name')?.focus();
    } catch (e) { showBanner(fieldMessage(e)); }
}
const REASON_LABELS = {
    manual_field_incomplete: 'some fields are awaiting Guide updates',
    guide_detail_missing: 'guide detail not read yet',
    guide_detail_failed: 'guide detail failed validation',
    required_field_missing: 'a required field is missing',
    known_drop_unresolved: 'a known drop is not in the catalog',
};
const UNAVAILABLE_LABELS = { contract_unverified: 'needs a verified game read contract' };
const GUIDE_STATUS_CLASS = { ok: 'pill-ok', running: 'pill-ok', due: 'pill-warn', partial: 'pill-warn', waiting_for_browser: 'pill-warn', challenged: 'pill-bad', failed: 'pill-bad', idle: '' };

function coverageCell(c) {
    if (!c) return el('span', { class: 'muted' }, 'not tracked');
    if (!c.completeness) return el('span', { class: 'muted' }, '-');
    return el('span', {},
        el('span', { class: `pill ${c.completeness === 'complete' ? 'pill-ok' : 'pill-warn'}` }, c.completeness),
        c.incompleteReasons.length ? el('span', { class: 'muted' }, ` ${c.incompleteReasons.map(r => REASON_LABELS[r] ?? r).join('; ')}`) : null);
}

function jsonBlock(value) {
    return el('pre', {}, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function loadCatalogSummary() {
    try {
        catalogView.summary = await api('GET', '/api/catalog/summary');
    } catch (e) { showBanner(fieldMessage(e)); return; }
    const s = catalogView.summary;
    document.getElementById('catalog-kinds').replaceChildren(...Object.entries(s.kinds).map(([kind, k]) =>
        el('span', { class: 'stat' }, `${kind}: ${k.rows} rows, ${k.tracked} tracked${kind === 'item' || kind === 'creature' ? `, ${k.incomplete} incomplete` : ''}`)));
    const g = s.policy.guide;
    document.getElementById('guide-policy').textContent =
        `Checked every ${g.checkIntervalMs % 86_400_000 ? `${Math.round(g.checkIntervalMs / 3600_000)} h` : `${g.checkIntervalMs / 86_400_000} days`}; ` +
        `${g.minDelayMs / 1000} s between requests, ${g.maxRequestsPerExecution} per batch, ${s.guideRequestsToday} requests today; no daily limit. ` +
        `Each check scans all index pages and checks every listed ID for missing stored data. Completed details are skipped; incomplete creature details take priority.`;
    renderRelayTokens(s.relayTokens ?? []);
    renderCatalogState();
}

let itemDiscoveryLoading = false;
let itemDiscoveryTotal = null;
const ITEM_DISCOVERY_ERRORS = {
    known_item_unavailable: 'The last known valid item is unavailable. Waiting before retrying; no IDs were skipped.',
    unrecognized_tooltip: 'The item response was not recognized. The cursor has been kept for retry.',
    challenge: 'The game returned a browser challenge. Waiting before retrying.',
    storage_error: 'The database checkpoint failed. The item and announcement will be retried together.',
};

function renderItemDiscoveryState(data) {
    if (!data) return;
    document.getElementById('item-discovery-status').textContent = `Status: ${data.status.replaceAll('_', ' ')}.`
        + (data.lastError ? ` ${ITEM_DISCOVERY_ERRORS[data.lastError] ?? `Last request: ${data.lastError.replaceAll('_', ' ')}.`}` : '');
    document.getElementById('item-discovery-progress').replaceChildren(...[
        ['Last valid ID', data.lastValidId ?? 'not started'], ['Last checked ID', data.lastCheckedId ?? '-'],
        ['Next ID', data.nextItemId ?? '-'], ['Check through', data.lastValidId == null ? '-' : data.lastValidId + data.lookahead],
        ['New discoveries', data.discoveredTotal], ['Last complete scan', fmtTime(data.lastCompletedAt)], ['Next check', fmtTime(data.nextCheckAt)],
    ].map(([label, value]) => el('span', { class: 'stat' }, `${label}: ${value}`)));
    document.getElementById('item-discovery-run').disabled = !data.enabled || !data.webhookConfigured || !data.recommendedStartId;
    const changed = itemDiscoveryTotal !== null && itemDiscoveryTotal !== data.discoveredTotal;
    itemDiscoveryTotal = data.discoveredTotal;
    if (changed && !document.getElementById('catalog-upcoming').hidden) loadItemDiscovery();
}

async function loadItemDiscovery() {
    if (itemDiscoveryLoading) return;
    itemDiscoveryLoading = true;
    try {
        const data = await api('GET', '/api/catalog/item-discovery');
        itemDiscoveryTotal = data.discoveredTotal;
        renderItemDiscoveryState(data);
        const form = document.getElementById('item-discovery-form');
        if (!form.dataset.dirty) {
            document.getElementById('id-enabled').checked = data.enabled;
            const input = document.getElementById('id-start');
            input.value = data.lastValidId ?? data.recommendedStartId ?? '';
            input.dataset.saved = input.value;
        }
        document.getElementById('item-discovery-recent').replaceChildren(...data.recent.map(item => el('tr', {},
            el('td', {}, item.id), el('td', {}, item.record.name), el('td', {}, fmtTime(item.firstSeenAt)),
            el('td', {}, el('button', { type: 'button', class: 'ghost', onclick: async () => {
                catalogView.kind = 'item';
                [...document.querySelectorAll('#cf-kind option')].find(option => option.value === 'item').selected = true;
                await openCatalogTab('browse');
                await showEntity('item', String(item.id));
            } }, 'View in Catalog')))));
    } catch (error) { showBanner(fieldMessage(error)); }
    finally { itemDiscoveryLoading = false; }
}

/** CAT-TASK-010: stage-only relay tokens. A new token is shown once and never again. */
function renderRelayTokens(tokens, issued = null) {
    const box = document.getElementById('relay-tokens');
    const rows = tokens.map(t => {
        const revoke = el('button', { type: 'button', class: 'ghost danger', disabled: !t.active }, 'Revoke');
        revoke.addEventListener('click', async () => {
            if (!window.confirm(`Revoke relay token "${t.label}"? The browser using it stops at its next request.`)) return;
            try { await api('POST', `/api/catalog/relay-tokens/${t.id}/revoke`); showBanner('Relay token revoked.', 'ok'); loadCatalogSummary(); } catch (e) { showBanner(fieldMessage(e)); }
        });
        return el('tr', {}, el('td', {}, t.label), el('td', {}, t.active ? 'active' : (t.revokedAt ? 'revoked' : 'expired')),
            el('td', {}, fmtTime(t.expiresAt)), el('td', {}, fmtTime(t.lastUsedAt)), el('td', { class: 'actions' }, revoke));
    });
    const label = el('input', { maxLength: 64, placeholder: 'browser label', value: 'my browser', id: 'rt-label' });
    const days = el('input', { type: 'number', min: 1, max: 7, value: 7, class: 'interval', id: 'rt-days' });
    const issue = el('button', { type: 'submit' }, 'Issue relay token');
    const form = el('form', { class: 'toolbar', autocomplete: 'off' }, el('label', { htmlFor: 'rt-label' }, 'Relay token'), label,
        el('label', { htmlFor: 'rt-days' }, 'days'), days, issue);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const r = await api('POST', '/api/catalog/relay-tokens', { label: label.value.trim(), ttlDays: Number(days.value) });
            renderRelayTokens((await api('GET', '/api/catalog/summary')).relayTokens, r);
        } catch (e) { showBanner(fieldMessage(e)); }
    });
    box.replaceChildren(
        el('h3', {}, 'Guide relay'),
        el('p', { class: 'muted' }, 'Install reconciliation/scrappers/gogon_guide_relay.user.js in Tampermonkey. In the script\'s Storage tab, set gogonRelayToken to a token issued here. Open the SSH tunnel, open a guide page, and press Start. The token can only fetch leases and return guide results.'),
        issued ? el('div', { class: 'card' }, el('strong', {}, 'Copy this token now; it is not shown again: '), el('code', {}, issued.token),
            el('div', { class: 'muted' }, `Expires ${fmtTime(issued.expiresAt)}.`)) : null,
        tokens.length ? el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, 'Label'), el('th', {}, 'State'), el('th', {}, 'Expires'), el('th', {}, 'Last used'), el('th', {}, ''))),
            el('tbody', {}, ...rows))) : null,
        form);
}

async function loadEntities() {
    const v = catalogView;
    const params = new URLSearchParams({ kind: v.kind, page: String(v.page), pageSize: String(v.pageSize) });
    if (v.q) params.set('q', v.q);
    if (v.completeness) params.set('completeness', v.completeness);
    let data;
    try { data = await api('GET', `/api/catalog/entities?${params}`); } catch (e) { showBanner(fieldMessage(e)); return; }
    v.total = data.total;
    document.getElementById('catalog-entities').replaceChildren(...data.items.map(item => {
        const row = el('tr', { class: 'clickable', tabIndex: 0, title: 'Show details' },
            el('td', {}, item.key),
            el('td', {}, item.name ?? '-'),
            el('td', {}, coverageCell(item.catalog)),
            el('td', {}, item.catalog ? fmtTime(item.catalog.lastSeenAt) : '-'));
        const open = () => showEntity(v.kind, item.key);
        row.addEventListener('click', open);
        row.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
        return row;
    }));
    const pages = Math.max(1, Math.ceil(v.total / v.pageSize));
    document.getElementById('cf-page').textContent = `page ${v.page} of ${pages} (${v.total})`;
    document.getElementById('cf-prev').disabled = v.page <= 1;
    document.getElementById('cf-next').disabled = v.page >= pages;
}

async function showEntity(kind, key) {
    const box = document.getElementById('catalog-detail');
    let d;
    try { d = await api('GET', `/api/catalog/entities/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`); } catch (e) { showBanner(fieldMessage(e)); return; }
    const fields = el('dl', { class: 'kv' });
    for (const [k, value] of Object.entries(d.fields)) {
        if (kind === 'master_realm' && k === 'connected_realms') continue;
        fields.append(el('dt', {}, k), el('dd', {}, value !== null && typeof value === 'object' ? jsonBlock(value) : (value ?? '-')));
    }
    const relations = Object.entries(d.relations).map(([name, list]) => el('div', {},
        el('strong', {}, `${name}: `),
        list.length ? list.map(r => (typeof r === 'string' ? r : `${r.name ?? r.id}${r.id ? ` (#${r.id})` : ''}${r.minLevel == null ? '' : `, level ${r.minLevel}`}`)).join('; ') : 'none known'));
    const provenance = el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Observed'), el('th', {}, 'Source'), el('th', {}, 'Run'), el('th', {}, 'Hash'))),
        el('tbody', {}, ...d.provenance.map(p => el('tr', {},
            el('td', {}, fmtTime(p.observedAt)), el('td', {}, p.source), el('td', {}, `${p.mode} (${p.runStatus})`), el('td', {}, p.hash)))));
    box.replaceChildren(
        el('h3', {}, `${kind} ${d.key}`),
        el('button', { type: 'button', onclick: () => editCatalogEntity(kind, d.key) }, 'Edit entry'),
        el('div', {}, el('strong', {}, 'Coverage: '), coverageCell(d.catalog)),
        d.catalog ? el('div', { class: 'muted' }, `First seen ${fmtTime(d.catalog.firstSeenAt)}; last seen ${fmtTime(d.catalog.lastSeenAt)}; verified ${fmtTime(d.catalog.verifiedAt)}`) : null,
        d.guide ? el('div', { class: 'muted' }, `Guide detail: ${d.guide.status}; checked ${fmtTime(d.guide.checkedAt)}; next check ${fmtTime(d.guide.nextCheckAt)}`) : null,
        fields, ...relations, el('h3', {}, 'Provenance (newest first)'), el('div', { class: 'table-wrap' }, provenance));
    box.hidden = false;
}

/** Guide status and jobs come with every dashboard state update (SSE). */
function renderCatalogState() {
    const c = state?.catalog;
    if (!c) return;
    renderItemDiscoveryState(c.itemDiscovery);
    document.getElementById('guide-status').replaceChildren(...c.guide.map(g => el('tr', {},
        el('td', {}, g.entityKind),
        el('td', {}, el('span', { class: `pill ${GUIDE_STATUS_CLASS[g.display] ?? ''}` }, g.display.replace(/_/g, ' ')), g.statusReason ? el('span', { class: 'muted' }, ` ${g.statusReason}`) : null,
            g.overdue ? el('span', { class: 'error' }, ' overdue') : null),
        el('td', {}, fmtTime(g.lastSuccessfulCheckAt)),
        el('td', {}, String(g.lastSeenId || '-')),
        el('td', {}, g.sweepMode ? `${g.sweepMode}: next page ${g.nextPage}, ${g.sweepPagesChecked} checked` : '-'),
        el('td', {}, g.orderState),
        el('td', {}, catalogView.summary ? (() => { const k = catalogView.summary.coverage[g.entityKind]; return `${k.ok} read, ${k.pending} pending, ${k.failed} failed`; })() : '-'))));

    document.getElementById('catalog-jobs').replaceChildren(...c.jobs.map(j => {
        const actions = el('td', { class: 'actions' });
        const act = (label, action, cls = 'ghost') => {
            const b = el('button', { type: 'button', class: cls }, label);
            b.addEventListener('click', async () => {
                b.disabled = true;
                try { await api('POST', `/api/catalog/jobs/${j.id}/${action}`); showBanner(`Job ${action}d.`, 'ok'); }
                catch (e) { showBanner(fieldMessage(e)); b.disabled = false; }
            });
            return b;
        };
        if (j.state === 'queued' || j.state === 'running') actions.append(act('Pause', 'pause'));
        if (j.state === 'paused') actions.append(act('Resume', 'resume'));
        if (['queued', 'running', 'paused'].includes(j.state)) actions.append(act('Cancel', 'cancel', 'ghost danger'));
        const r = j.lastResult;
        return el('tr', {},
            el('td', {}, j.kind), el('td', {}, j.state), el('td', {}, String(j.requestBudget)),
            el('td', {}, Object.keys(j.cursor).length ? JSON.stringify(j.cursor) : '-'),
            el('td', { class: r && r.outcome !== 'ok' ? 'error' : '' }, r ? `${r.outcome}${r.reason ? `: ${r.reason}` : ''} (${fmtTime(r.at)})` : '-'),
            actions);
    }));

    const select = document.getElementById('jf-kind');
    if (select.options.length === 0) {
        for (const [kind, why] of Object.entries(c.available)) {
            const usable = why === null;
            const option = el('option', { disabled: !usable }, usable ? kind : `${kind} (${UNAVAILABLE_LABELS[why] ?? why})`);
            option.setAttribute('value', kind);
            select.append(option);
        }
        const first = [...select.options].find(o => !o.disabled);
        if (first) first.selected = true;
    }
}

function showPlan(plan, onDone) {
    const panel = document.getElementById('plan-panel');
    const input = el('input', { autocomplete: 'off', spellcheck: false, placeholder: 'type the phrase exactly' });
    const execute = el('button', { type: 'button', class: 'danger', disabled: true }, plan.action === 'promote' ? 'Promote' : 'Roll back');
    const cancel = el('button', { type: 'button', class: 'ghost' }, 'Cancel');
    input.addEventListener('input', () => { execute.disabled = input.value !== plan.confirmation; });
    cancel.addEventListener('click', () => { panel.hidden = true; panel.replaceChildren(); });
    execute.addEventListener('click', async () => {
        execute.disabled = true;
        try {
            const r = await api('POST', `/api/catalog/plans/${plan.id}/execute`, { confirmation: input.value });
            showBanner(`${plan.action === 'promote' ? 'Promoted' : 'Rolled back'} run ${r.result.runId.slice(0, 8)}.`, 'ok');
            panel.hidden = true;
            panel.replaceChildren();
            if (onDone) onDone();
        } catch (e) { showBanner(fieldMessage(e)); }
    });
    panel.replaceChildren(
        el('h3', {}, plan.action === 'promote' ? 'Promotion preview' : 'Rollback preview'),
        el('p', { class: 'muted' }, `Nothing has changed yet. This preview expires ${fmtTime(plan.expiresAt)} and can be used once.`),
        jsonBlock(plan.expectedCounts),
        el('p', {}, 'To continue, type ', el('code', {}, plan.confirmation)),
        el('div', { class: 'toolbar' }, input, execute, cancel));
    panel.hidden = false;
    input.focus?.();
}

async function loadRuns() {
    let data;
    try { data = await api('GET', `/api/catalog/runs?page=${catalogView.runsPage}&pageSize=25`); } catch (e) { showBanner(fieldMessage(e)); return; }
    document.getElementById('catalog-runs').replaceChildren(...data.runs.map(run => {
        const actions = el('td', { class: 'actions' });
        if (run.status === 'succeeded' && run.mode !== 'baseline_snapshot') {
            const b = el('button', { type: 'button', class: 'ghost danger' }, 'Preview rollback');
            b.addEventListener('click', async () => {
                try { showPlan((await api('POST', `/api/catalog/runs/${run.id}/rollback-plan`)).plan, loadRuns); } catch (e) { showBanner(fieldMessage(e)); }
            });
            actions.append(b);
        }
        return el('tr', {},
            el('td', {}, fmtTime(run.startedAt)), el('td', {}, run.mode), el('td', {}, run.source), el('td', {}, run.status),
            el('td', {}, run.summary ? JSON.stringify(run.summary).slice(0, 160) : '-'), actions);
    }));
    document.getElementById('runs-page').textContent = `page ${catalogView.runsPage}`;
    document.getElementById('runs-prev').disabled = catalogView.runsPage <= 1;
    document.getElementById('runs-next').disabled = data.runs.length < 25;
}

async function loadSeeds() {
    let sources;
    let runs;
    try {
        sources = (await api('GET', '/api/catalog/seed-sources')).sources;
        runs = (await api('GET', '/api/catalog/runs?page=1&pageSize=100')).runs;
    } catch (e) { showBanner(fieldMessage(e)); return; }
    document.getElementById('seed-sources').replaceChildren(...sources.map(s => {
        const b = el('button', { type: 'button' }, `Stage ${s.key}`);
        b.addEventListener('click', async () => {
            if (!window.confirm(`Download and stage "${s.label}"? Nothing reaches the serving tables until you promote each part.`)) return;
            b.disabled = true;
            try {
                const r = (await api('POST', '/api/catalog/seeds', { sourceKey: s.key })).staged;
                showBanner(`Staged ${r.observations} records in ${r.parts} part(s).`, 'ok');
                loadSeeds();
            } catch (e) { showBanner(fieldMessage(e)); } finally { b.disabled = false; }
        });
        return el('div', { class: 'card' }, el('strong', {}, s.label), el('div', { class: 'muted' }, `Kinds: ${s.kinds.join(', ')}; from ${s.hosts.join(', ')}`), b);
    }));
    const staged = runs.filter(r => r.mode === 'seed' && r.status === 'running' && r.summary?.seed)
        .sort((a, b) => (a.summary.seed.batchId === b.summary.seed.batchId ? a.summary.seed.part - b.summary.seed.part : 0));
    document.getElementById('seed-runs').replaceChildren(...staged.map(run => {
        const seed = run.summary.seed;
        const preview = el('button', { type: 'button' }, 'Preview promotion');
        preview.addEventListener('click', async () => {
            try { showPlan((await api('POST', `/api/catalog/runs/${run.id}/promote-plan`)).plan, loadSeeds); } catch (e) { showBanner(fieldMessage(e)); }
        });
        const discard = el('button', { type: 'button', class: 'ghost danger' }, 'Discard');
        discard.addEventListener('click', async () => {
            if (!window.confirm(`Discard staged part ${seed.part} of ${seed.parts}? It will never be promoted.`)) return;
            try { await api('POST', `/api/catalog/runs/${run.id}/discard`); loadSeeds(); } catch (e) { showBanner(fieldMessage(e)); }
        });
        return el('tr', {},
            el('td', {}, `${seed.part} of ${seed.parts}`), el('td', {}, seed.kinds.join(', ')),
            el('td', {}, fmtTime(run.startedAt)), el('td', { class: 'actions' }, preview, discard));
    }));
}

const CATALOG_LOADERS = { browse: () => loadEntities(), manual: () => loadManualForm(), upcoming: () => loadItemDiscovery(), sync: () => loadCatalogSummary(), seed: () => loadSeeds(), history: () => loadRuns() };

function openCatalogTab(name) {
    document.querySelectorAll('.subtabs button').forEach(b => b.classList.toggle('active', b.dataset.subtab === name));
    document.querySelectorAll('#tab-catalog .subtab').forEach(s => { s.hidden = s.id !== `catalog-${name}`; });
    document.getElementById('plan-panel').hidden = true;
    return CATALOG_LOADERS[name]();
}

function render() {
    if (!state) return;
    renderHeader();
    renderModules();
    renderSettings();
    renderAccounts();
    renderAudit();
    renderCatalogState();
}

// --- wiring ------------------------------------------------------------------------------------------
function connectEvents() {
    const live = document.getElementById('live-indicator');
    const source = new EventSource('/api/events');
    source.addEventListener('state', (event) => {
        state = JSON.parse(event.data);
        live.textContent = 'live';
        live.className = 'pill pill-ok';
        render();
    });
    source.addEventListener('error', () => {
        live.textContent = 'reconnecting';
        live.className = 'pill pill-warn';
        fetch('/api/session', { credentials: 'same-origin' }).then(r => { if (r.status === 401) window.location.assign('/login'); }).catch(() => {});
    });
}

document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${button.dataset.tab}`; });
    if (button.dataset.tab === 'catalog') { loadCatalogSummary(); loadEntities(); }
    if (button.dataset.tab === 'notifications') loadOutbox();
}));

document.querySelectorAll('.subtabs button').forEach(button => button.addEventListener('click', () => openCatalogTab(button.dataset.subtab)));

const fieldValue = id => document.getElementById(id).value;

document.getElementById('item-discovery-form').addEventListener('input', event => { event.currentTarget.dataset.dirty = '1'; });
document.getElementById('item-discovery-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.field-error');
    error.hidden = true;
    try {
        const input = document.getElementById('id-start');
        const body = { enabled: document.getElementById('id-enabled').checked };
        if (input.value.trim() && input.value !== input.dataset.saved) body.startAfterId = Number(input.value);
        await api('POST', '/api/catalog/item-discovery', body);
        form.dataset.dirty = '';
        await loadItemDiscovery();
        showBanner('Item discovery settings saved.', 'ok');
    } catch (e) { error.textContent = fieldMessage(e); error.hidden = false; }
});
document.getElementById('item-discovery-run').addEventListener('click', async () => {
    try {
        await api('POST', '/api/catalog/item-discovery/run', {});
        showBanner('Item discovery queued for the next CatalogSync tick.', 'ok');
        await loadItemDiscovery();
    } catch (e) { showBanner(fieldMessage(e)); }
});
document.getElementById('item-discovery-refresh').addEventListener('click', () => loadItemDiscovery());

document.getElementById('mf-kind').addEventListener('change', () => { manualEdit = null; renderManualFields(); });
document.getElementById('manual-entry-cancel').addEventListener('click', () => { manualEdit = null; renderManualFields(); });
document.getElementById('manual-entry-open').addEventListener('click', async () => {
    const id = fieldValue('mf-id').trim();
    if (!/^[1-9]\d{0,17}$/.test(id)) { showBanner('Enter the existing entry ID first.'); return; }
    await editCatalogEntity(fieldValue('mf-kind'), id);
});
document.getElementById('manual-entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = event.currentTarget.querySelector('.field-error');
    const save = document.getElementById('manual-entry-save');
    error.hidden = true;
    save.disabled = true;
    try {
        const kind = fieldValue('mf-kind');
        const record = {};
        for (const [name, read] of manualReaders) {
            if (manualEdit && name === 'id') continue;
            const value = read();
            if (manualEdit) {
                const previous = manualEdit.record[name];
                const next = value === undefined && Array.isArray(previous) ? [] : value;
                if (name !== 'id' && JSON.stringify(next) !== JSON.stringify(previous)) record[name] = next === undefined ? null : next;
            } else if (value !== undefined) record[name] = value;
        }
        const editing = manualEdit;
        const fieldStates = {};
        const atPath = (value, path) => path.split('.').reduce((current, part) => current && typeof current === 'object' && Object.hasOwn(current, part) ? current[part] : undefined, value);
        for (const [path, control] of manualStateReaders) {
            const state = control.read();
            const submitted = Object.hasOwn(record, path.split('.')[0]);
            const changed = editing && submitted && JSON.stringify(atPath(record, path)) !== JSON.stringify(atPath(editing.record, path));
            const ancestorChanged = [...manualStateReaders].some(([parent, ancestor]) => path.startsWith(`${parent}.`) && ancestor.read() !== ancestor.initial);
            if (state !== control.initial || changed && !ancestorChanged && (!control.group || editing.fieldStates?.[path])) fieldStates[path] = state;
        }
        const labels = Object.keys(fieldStates).length ? { fieldStates } : {};
        if (editing) {
            const result = await api('POST', `/api/catalog/entities/${encodeURIComponent(kind)}/${encodeURIComponent(editing.key)}/edit`, { record, version: editing.version, ...labels });
            manualEdit = null;
            await showEntity(kind, result.key);
        } else await api('POST', '/api/catalog/manual-entries', { kind, record, ...labels });
        renderManualFields();
        document.getElementById('mf-id')?.focus();
        showBanner(editing ? 'Changes saved.' : `${kind.replace('_', ' ')} #${record.id} added as incomplete. Ready for the next entry.`, 'ok');
        await loadCatalogSummary();
    } catch (e) { error.textContent = fieldMessage(e); error.hidden = false; }
    finally { save.disabled = false; }
});

document.getElementById('catalog-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    Object.assign(catalogView, { kind: fieldValue('cf-kind'), q: fieldValue('cf-q').trim(), completeness: fieldValue('cf-completeness'), page: 1 });
    document.getElementById('catalog-detail').hidden = true;
    loadEntities();
});
document.getElementById('cf-prev').addEventListener('click', () => { catalogView.page = Math.max(1, catalogView.page - 1); loadEntities(); });
document.getElementById('cf-next').addEventListener('click', () => { catalogView.page += 1; loadEntities(); });
document.getElementById('runs-prev').addEventListener('click', () => { catalogView.runsPage = Math.max(1, catalogView.runsPage - 1); loadRuns(); });
document.getElementById('runs-next').addEventListener('click', () => { catalogView.runsPage += 1; loadRuns(); });

document.getElementById('job-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.field-error');
    error.hidden = true;
    try {
        await api('POST', '/api/catalog/jobs', { kind: fieldValue('jf-kind'), requestBudget: Number(fieldValue('jf-budget')) });
        showBanner(`${fieldValue('jf-kind')} job created.`, 'ok');
    } catch (e) { error.textContent = fieldMessage(e); error.hidden = false; }
});
document.getElementById('sync-now').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/catalog/sync-now'); showBanner(`Ran ${r.ran.length} game job(s).`, 'ok'); }
    catch (e) { showBanner(fieldMessage(e)); }
});

document.getElementById('guide-scan-now').addEventListener('click', async () => {
    try {
        await api('POST', '/api/catalog/guide-scan', {});
        showBanner('Guide scan scheduled on CatalogSync. Active scans continue; completed details are skipped.', 'ok');
        await loadCatalogSummary();
    } catch (e) { showBanner(fieldMessage(e)); }
});
document.getElementById('outbox-refresh').addEventListener('click', loadOutbox);

document.getElementById('logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* already signed out */ }
    window.location.assign('/login');
});

document.getElementById('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.field-error');
    error.hidden = true;
    try {
        await api('POST', '/api/profiles', { label: form.label.value, email: form.email.value, password: form.password.value });
        form.reset();
        showBanner('Profile added.', 'ok');
    } catch (e) {
        error.textContent = fieldMessage(e);
        error.hidden = false;
    }
});

(async () => {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (!res.ok) { window.location.assign('/login'); return; }
    csrf = (await res.json()).csrf;
    connectEvents();
})();
