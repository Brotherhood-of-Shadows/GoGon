// tests/helpers/db-client.mjs - DATA-TASK-005 / AC-DATA-008
// freshClient(): a migrated MySQL client on its own, empty database, for tests that need isolation
// from the shared gg_database connection (control-plane store, account switch, server).
// Works on the in-process fake and on a real MySQL (GG_TEST_MYSQL_URL); see test-database.mjs.
//
// Lifetime: a client created while a test runs (including its beforeEach hooks) is closed when that
// test ends, so anything still using it afterwards fails loudly. A client created outside a test
// (a before() hook) stays open until closeClients().
//
// Real MySQL: a migrated database is cloned from the run's template (mysql-template.mjs) the first
// time a process needs one; afterwards databases whose test has ended are reset and reused (~0.2 s
// instead of ~7 s of migration DDL). A database whose schema a test changed (its column, index or
// constraint fingerprint no longer matches the template) is never reused. migrate: false always
// yields a new, empty database. The fake needs none of this: a fake database is in memory and its
// migrations take ~20 ms.
import path from 'node:path';
import { beforeEach, afterEach } from 'node:test';
import { createMysqlClient, mysqlOptions } from '../../_gg_data/handler/mysqlClient.js';
import { runMigrations } from '../../_gg_data/handler/migrationRunner.js';
import { cloneTemplate, createDatabase, fingerprint, quietly, resetDatabase, session, template } from './mysql-template.mjs';

const MIGRATIONS = path.resolve('_gg_data/migrations');
const REAL_MYSQL = globalThis.__GG_TEST_DATABASE__ === 'mysql';

const open = [];          // every client freshClient() handed out and not yet closed
const testScoped = [];    // { client, database, pooled } created during the running test
const free = [];          // real MySQL: databases with an unchanged schema, ready to reset and reuse
let inTest = false;
let n = 0;

/** Created databases, dropped by test-database.mjs when the process ends (real MySQL only). */
globalThis.__GG_TEST_DATABASES__ ??= [];

beforeEach(() => { inTest = true; });
afterEach(async () => {
    inTest = false;
    while (testScoped.length) await release(testScoped.pop());
});

// --- clients ---------------------------------------------------------------------------------------

async function release(entry) {
    const index = open.indexOf(entry.client);
    if (index >= 0) open.splice(index, 1);
    await entry.client.close().catch(() => {}); // the test may have closed it already
    if (!entry.pooled) return;
    const client = session(entry.database);
    try {
        const tpl = await template();
        if (await fingerprint(client, entry.database) === tpl.fingerprint) free.push(entry.database);
    } finally { await client.close(); }
}

/** A client on its own database: migrated (default) or empty (`migrate: false`).
 * @param {{migrate?: boolean}} [options] Whether the database has every migration applied.
 * @returns {Promise<{query: Function, transaction: Function, close: Function}>} Client.
 */
export async function freshClient({ migrate = true } = {}) {
    const base = mysqlOptions();
    const pooled = REAL_MYSQL && migrate;
    let database = pooled ? free.pop() : undefined;
    if (database) await resetDatabase(database);
    else {
        database = `${base.database}_c${++n}`;
        await createDatabase(database);
        if (pooled) await cloneTemplate(database);
    }
    const client = createMysqlClient({ ...base, database });
    if (migrate && !pooled) await quietly(() => runMigrations(client, MIGRATIONS));
    open.push(client);
    if (inTest) testScoped.push({ client, database, pooled });
    return client;
}

/** Closes every client created by freshClient() (call from after()). */
export async function closeClients() {
    testScoped.length = 0;
    while (open.length) await open.pop().close();
}
