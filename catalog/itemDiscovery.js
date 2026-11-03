import { classifyResponse } from './contracts/classify.js';
import { GAME_POLICY } from './contracts/policy.js';
import { ITEM_DISCOVERY_LOOKAHEAD, ITEM_DISCOVERY_WEBHOOK, MAX_TOOLTIP_ITEM_ID, assertItemTooltipUrl, itemTooltipUrl } from './contracts/itemTooltip.js';
import { gameQueue } from './requestPolicy.js';
import { ItemTooltipError, itemReleaseMessage, parseItemTooltip } from './itemTooltip.js';
import { bindAccount, isCurrentAccount } from '../config/accountScope.mjs';
import { CatalogError } from '../_gg_data/handler/catalogStore.js';

/** Daily discovery in resumable, rate-limited CatalogSync batches; never submits game actions.
 * @param {object} dependencies Injected persistence, authenticated GET transport and settings.
 * @returns {object} Worker and owner controls.
 */
export function createItemDiscovery({ store, fetchFn, getWebhook, sessionReady = () => true, queue = gameQueue, now = Date.now, policy = GAME_POLICY }) {
    let running = false;
    async function request(id, signal) {
        return queue.run(async () => {
            signal?.throwIfAborted();
            const timeout = AbortSignal.timeout(policy.requestTimeoutMs);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let response, body;
            try {
                response = await fetchFn(assertItemTooltipUrl(itemTooltipUrl(id)), { method: 'GET', redirect: 'follow', signal: combined, headers: { accept: 'text/html', 'cache-control': 'no-cache' } });
                body = await response.text();
            } catch (error) {
                if (signal?.aborted) throw signal.reason ?? error;
                return { ok: false, reason: timeout.aborted ? 'timeout' : 'network_error' };
            }
            signal?.throwIfAborted();
            const classification = classifyResponse({ status: response.status, contentType: response.headers.get('content-type') ?? '', cfMitigated: response.headers.get('cf-mitigated'), body }, 'html');
            const explicitNegative = response.status >= 200 && response.status < 300 && body.trim() === 'Invalid Request';
            if (classification.class !== 'ok' && !(classification.class === 'malformed' && explicitNegative)) return { ok: false, reason: classification.class };
            try { return { ok: true, ...parseItemTooltip(body, id) }; }
            catch (error) { if (error instanceof ItemTooltipError) return { ok: false, reason: 'unrecognized_tooltip' }; throw error; }
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
            const probe = async () => {
                current();
                const result = await request(state.lastValidId, signal);
                requests++;
                current();
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
                    const result = await request(id, signal);
                    requests++;
                    current();
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
