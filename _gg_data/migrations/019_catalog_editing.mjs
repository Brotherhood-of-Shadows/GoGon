/** Adds identity redirects and preserves every editable master-realm Guide field.
 * @param {{query: Function}} client Migration connection.
 * @returns {Promise<void>}
 */
export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS catalog_entity_aliases (
        entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('relic', 'quest')),
        from_key VARCHAR(255) NOT NULL,
        to_key VARCHAR(255) NOT NULL,
        run_id CHAR(36) NOT NULL,
        PRIMARY KEY (entity_kind, from_key),
        FOREIGN KEY (run_id) REFERENCES catalog_runs (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
    for (const column of ['min_level INT', 'imageUrl TEXT']) {
        try { await client.query(`ALTER TABLE master_realms ADD COLUMN ${column}`); }
        catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
    }
}
