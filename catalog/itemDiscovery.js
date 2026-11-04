import { classifyResponse } from './contracts/classify.js';
import { GAME_POLICY } from './contracts/policy.js';
import { ITEM_DISCOVERY_LOOKAHEAD, ITEM_DISCOVERY_WEBHOOK, MAX_TOOLTIP_ITEM_ID, assertItemTooltipUrl, itemTooltipUrl } from './contracts/itemTooltip.js';
import { gameQueue } from './requestPolicy.js';
import { ItemTooltipError, itemReleaseMessage, parseItemTooltip } from './itemTooltip.js';
import { bindAccount, isCurrentAccount } from '../config/accountScope.mjs';
import { CatalogError } from '../_gg_data/handler/catalogStore.js';
import { createHash } from 'node:crypto';

function responseRoute(value) {
    try {
        const url = new URL(value);
        if (url.hostname === 'www.fallensword.com' && url.pathname === '/fetchitem.php') return 'item_tooltip';
        if (url.hostname === 'www.fallensword.com' && ['/', '/index.php'].includes(url.pathname)) return 'game_page';
        if (['huntedcow.com', 'account.huntedcow.com'].includes(url.hostname)) return 'huntedcow_page';
        return 'other';
    } catch { return 'unknown'; }
}

/** Daily discovery in resumable, rate-limited CatalogSync batches; never submits game actions.
 * @param {object} dependencies Injected persistence, authenticated GET transport, settings and
 *     `retainUnrecognized(id, html)`, which keeps the latest unrecognized tooltip for the owner.
 * @returns {object} Worker and owner controls.
 */
export function createItemDiscovery({ store, fetchFn, getWebhook, getHeaders = () => ({}), log = console.warn, retainUnrecognized = async () => {}, sessionReady = () => true, queue = gameQueue, now = Date.now, policy = GAME_POLICY }) {
    let running = false;
    async function request(id, signal, phase) {
        return queue.run(async () => {
            signal?.throwIfAborted();
            const timeout = AbortSignal.timeout(policy.requestTimeoutMs);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let response, body;
            const diagnostic = { itemId: id, phase, at: new Date(now()).toISOString(), httpStatus: null, route: 'unknown', contentType: null, bytes: null, fingerprint: null, parserCode: null, parserDetail: null };
            const finish = result => ({ ...result, diagnostic: { ...diagnostic, outcome: result.ok ? result.found ? 'found' : 'missing' : result.reason } });
            try {
                response = await fetchFn(assertItemTooltipUrl(itemTooltipUrl(id)), { method: 'GET', redirect: 'follow', signal: combined, headers: { ...getHeaders(), accept: 'text/html', 'cache-control': 'no-cache' } });
                diagnostic.httpStatus = response.status;
                diagnostic.route = responseRoute(response.url);
                body = await response.text();
            } catch (error) {
                if (signal?.aborted) throw signal.reason ?? error;
                return finish({ ok: false, reason: timeout.aborted ? 'timeout' : 'network_error' });
            }
            signal?.throwIfAborted();
            const classification = classifyResponse({ status: response.status, contentType: response.headers.get('content-type') ?? '', cfMitigated: response.headers.get('cf-mitigated'), body }, 'html');
            const contentType = response.headers.get('content-type') ?? '';
            diagnostic.contentType = /html/i.test(contentType) ? 'html' : /json/i.test(contentType) ? 'json' : /text/i.test(contentType) ? 'text' : 'other';
            diagnostic.bytes = Buffer.byteLength(body);
            diagnostic.fingerprint = createHash('sha256').update(body).digest('hex');
            const explicitNegative = response.status >= 200 && response.status < 300 && body.trim() === 'Invalid Request';
            if (classification.class !== 'ok' && !(classification.class === 'malformed' && explicitNegative)) return finish({ ok: false, reason: classification.class });
            try { return finish({ ok: true, ...parseItemTooltip(body, id) }); }
            catch (error) {
                if (!(error instanceof ItemTooltipError)) throw error;
                diagnostic.parserCode = error.code;
                diagnostic.parserDetail = error.detail;
                if (!['game_page', 'huntedcow_page'].includes(diagnostic.route)) await retainUnrecognized(id, body);
                return finish({ ok: false, reason: 'unrecognized_tooltip' });
            }
        }, signal);
    }

    return {
        /** Safe progress and setup readiness for Catalog.
         * @returns {Promise<object>} Progress, configuration flags and recent items.
         */
        async status() {
            const state = await store.state();
            const webhookConfigured = Boolean(getWebhook());
            return { ...state, webhookConfigured, webhookSetting: ITEM_DISCOVERY_WEBHOOK,
                status: !state.enabled ? 'disabled' : !webhookConfigured ? 'waiting_for_webhook' : !state.recommendedStartId ? 'waiting_for_start_id'
                    : state.lastError ? 'backoff' : state.scanId ? 'scanning' : state.nextCheckAt && Date.parse(state.nextCheckAt) > now() ? 'scheduled' : 'due' };
        },
        /** Existing settings and scheduling controls keep network work in the engine lifecycle. */
        configure: patch => store.configure(patch),
        recent: () => store.recent(),
        async requestScan() {
            if (!getWebhook()) throw new CatalogError('conflict', 'Configure the Upcoming items (#upcoming) webhook in Settings first.');
            return store.requestScan();
        },
        /** Executes one bounded batch; all progress resumes safely after a restart.
         * @param {{signal?: AbortSignal}} options Engine cancellation.
         * @returns {Promise<object>} Redacted execution outcome.
         */
        async run({ signal } = {}) {
            if (running) return { status: 'busy', requests: 0 };
            const binding = bindAccount();
            if (!binding.scope || !sessionReady()) return { status: 'waiting_for_session', requests: 0 };
            if (!getWebhook()) return { status: 'waiting_for_webhook', requests: 0 };
            running = true;
            let state;
            let requests = 0;
            let announced = 0;
            const current = () => { signal?.throwIfAborted(); if (!isCurrentAccount(binding)) throw Object.assign(new Error('Account changed.'), { code: 'account_changed' }); };
            const failure = async (reason, resetTail = false) => {
                await store.fail(state.scanId, reason, reason === 'challenge' ? policy.backoffMs.at(-1) : policy.backoffMs[1], { resetTail });
                return { status: 'backoff', reason, requests, announced };
            };
            const read = async (id, phase) => {
                current();
                const result = await request(id, signal, phase);
                requests++;
                current();
                await store.recordRequest(state.scanId, result.diagnostic);
                if (!result.ok) log(`[Catalog Items] ID ${id} (${phase}): ${result.reason}; HTTP ${result.diagnostic.httpStatus ?? '-'}; route ${result.diagnostic.route}; parser ${result.diagnostic.parserCode ?? '-'}; bytes ${result.diagnostic.bytes ?? '-'}${result.diagnostic.parserDetail ? `; ${result.diagnostic.parserDetail}` : ''}.`);
                return result;
            };
            const probe = async () => {
                const result = await read(state.lastValidId, 'probe');
                if (!result.ok) return result.reason;
                if (!result.found) return 'known_item_unavailable';
                await store.found(state.scanId, result.record, itemReleaseMessage(result.record, new Date(now()).toISOString()), { probe: true });
                return null;
            };
            try {
                current();
                state = await store.begin();
                if (!state) return { status: 'not_due', requests: 0 };
                const unavailable = await probe();
                if (unavailable) return await failure(unavailable, true);
                while (requests < policy.maxRequestsPerExecution) {
                    current();
                    const horizon = Math.min(MAX_TOOLTIP_ITEM_ID, state.lastValidId + ITEM_DISCOVERY_LOOKAHEAD);
                    if (state.nextItemId > horizon) {
                        const endFailure = await probe();
                        if (endFailure) return await failure(endFailure, true);
                        state = await store.complete(state.scanId);
                        return { status: 'complete', requests, announced, lastValidId: state.lastValidId, lastCheckedId: state.lastCheckedId };
                    }
                    const id = state.nextItemId;
                    const result = await read(id, 'scan');
                    if (!result.ok) return await failure(result.reason);
                    if (result.found) {
                        state = await store.found(state.scanId, result.record, itemReleaseMessage(result.record, new Date(now()).toISOString()));
                        if (state.announced) announced++;
                    } else state = await store.missing(state.scanId, id);
                }
                return { status: 'partial', requests, announced, lastValidId: state.lastValidId, lastCheckedId: state.lastCheckedId };
            } catch (error) {
                if (signal?.aborted || error?.code === 'account_changed') return { status: 'aborted', requests, announced };
                if (error?.code === 'conflict') return { status: 'interrupted', requests, announced };
                if (state?.scanId) return await failure('storage_error');
                throw error;
            } finally { running = false; }
        },
    };
}
