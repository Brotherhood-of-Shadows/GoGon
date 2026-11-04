// tests/helpers/mysql-template.mjs - real-MySQL test databases without re-running migrations.
// Running every migration costs ~7 s of DDL per database on MySQL, so the migrations run once per
// test run into a template database, gg_tpl_<hash of _gg_data/migrations>. The first test process
// builds it under GET_LOCK; the rest wait and reuse it, and later runs reuse it while the migrations
// are unchanged (a template for other migrations is dropped). Test databases are cloned from it
// (SHOW CREATE TABLE replayed, seed rows copied) or reset to it (rows deleted, seeds restored, moved
// AUTO_INCREMENT counters put back). Used by test-database.mjs (each process's own database) and
// db-client.mjs (freshClient). The template is built by the same runMigrations GoGon boots with, so
// the from-empty migration path still runs on MySQL once per run.
import path from 'node:path';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createMysqlClient, mysqlOptions } from '../../_gg_data/handler/mysqlClient.js';
import { runMigrations } from '../../_gg_data/handler/migrationRunner.js';

const MIGRATIONS = path.resolve('_gg_data/migrations');
const TEMPLATE_READY = '__gg_template_ready';

/** Runs fn with GoGon's [GG_DB] progress lines silenced. */
export const quietly = async fn => {
    const log = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
};

// One connection, so session settings (FOREIGN_KEY_CHECKS, GET_LOCK) apply to every statement.
export const session = database => createMysqlClient({ ...mysqlOptions(), database, connectionLimit: 1 });

function templateName() {
    const hash = crypto.createHash('sha256');
    for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') || f.endsWith('.mjs')).sort()) {
        hash.update(file).update('\0').update(readFileSync(path.join(MIGRATIONS, file))).update('\0');
    }
    return `gg_tpl_${hash.digest('hex').slice(0, 16)}`;
}

/** A schema fingerprint that ignores the database name and the template's ready marker: columns,
 * indexes, constraints and CHECK clauses. */
export async function fingerprint(client, database) {
    const where = [database, TEMPLATE_READY];
    const parts = await Promise.all([
        client.query(`SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION, COLLATION_NAME
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, where),
        client.query(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, where),
        client.query(`SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc
            LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME <> ? ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`, where),
    ]);
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function autoIncrements(client, database) {
    await client.query('SET SESSION information_schema_stats_expiry = 0');
    const rows = await client.query('SELECT TABLE_NAME AS t, AUTO_INCREMENT AS a FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND AUTO_INCREMENT IS NOT NULL', [database]);
    return new Map(rows.map(row => [row.t, Number(row.a)]));
}

async function buildTemplate(name) {
    const admin = session(undefined);
    try {
        const [lock] = await admin.query('SELECT GET_LOCK(?, 600) AS ok', [name]);
        if (Number(lock.ok) !== 1) throw new Error(`Timed out waiting for the test template ${name}.`);
        try {
            const [ready] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [name, TEMPLATE_READY]);
            if (Number(ready.n) === 1) return;
            // A template for older migrations is never used again; a half-built one is rebuilt.
            for (const { s } of await admin.query("SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gg!_tpl!_%' ESCAPE '!'")) {
                await admin.query(`DROP DATABASE \`${s}\``);
            }
            await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
            const template = session(name);
            try {
                await quietly(() => runMigrations(template, MIGRATIONS));
                await template.query(`CREATE TABLE ${TEMPLATE_READY} (id INT PRIMARY KEY)`);
            } finally { await template.close(); }
        } finally { await admin.query('SELECT RELEASE_LOCK(?)', [name]); }
    } finally { await admin.close(); }
}

let templatePromise = null;
/** The template's schema and seed rows, read once per process. */
export function template() {
    templatePromise ??= (async () => {
        const name = templateName();
        await buildTemplate(name);
        const client = session(name);
        try {
            const tables = (await client.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> ? ORDER BY TABLE_NAME", [name, TEMPLATE_READY])).map(row => row.t);
            const ddl = [];
            const seeds = [];
            for (const table of tables) {
                ddl.push((await client.query(`SHOW CREATE TABLE \`${table}\``))[0]['Create Table']);
                const [{ c }] = await client.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
                if (Number(c) === 0) continue;
                const columns = (await client.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION", [name, table]))
                    .map(row => `\`${row.c}\``).join(', ');
                seeds.push({ table, columns });
            }
            return { name, tables, ddl, seeds, fingerprint: await fingerprint(client, name), autoIncrements: await autoIncrements(client, name) };
        } finally { await client.close(); }
    })();
    return templatePromise;
}

async function copySeeds(client, tpl) {
    for (const { table, columns } of tpl.seeds) await client.query(`INSERT INTO \`${table}\` (${columns}) SELECT ${columns} FROM \`${tpl.name}\`.\`${table}\``);
}

/** Fills an existing, empty database with the template's tables and seed rows. */
export async function cloneTemplate(database) {
    const tpl = await template();
    const client = session(database);
    try {
        await client.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const statement of tpl.ddl) await client.query(statement);
        await copySeeds(client, tpl);
        await client.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { await client.close(); }
}

/** Puts a cloned database whose schema is unchanged back to the template's rows. */
export async function resetDatabase(database) {
    const tpl = await template();
    const client = session(database);
    try {
        await client.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const table of tpl.tables) await client.query(`DELETE FROM \`${table}\``);
        await copySeeds(client, tpl);
        for (const [table, value] of await autoIncrements(client, database)) {
            const original = tpl.autoIncrements.get(table);
            if (original !== undefined && value !== original) await client.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${original}`);
        }
        await client.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { await client.close(); }
}

/** Creates an empty test database, dropped by test-database.mjs when the process ends. */
export async function createDatabase(database) {
    const admin = createMysqlClient({ ...mysqlOptions(), database: undefined });
    try {
        await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    } finally { await admin.close(); }
    (globalThis.__GG_TEST_DATABASES__ ??= []).push(database);
}
