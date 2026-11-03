/** Adds durable daily item discovery and preserves extra tooltip data.
 * @param {{query: Function}} client Migration connection.
 * @returns {Promise<void>}
 */
export async function up(client) {
    try { await client.query('ALTER TABLE items ADD COLUMN details LONGTEXT'); }
    catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
    await client.query(`CREATE TABLE IF NOT EXISTS catalog_item_discovery (
        id TINYINT NOT NULL PRIMARY KEY CHECK (id = 1),
        enabled TINYINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        baseline_id BIGINT,
        last_valid_id BIGINT,
        last_checked_id BIGINT,
        next_item_id BIGINT,
        scan_id CHAR(36),
        scan_started_at VARCHAR(30),
        last_completed_at VARCHAR(30),
        next_check_at VARCHAR(30),
        last_error VARCHAR(64),
        checked_in_scan INT NOT NULL DEFAULT 0,
        found_in_scan INT NOT NULL DEFAULT 0,
        discovered_total INT NOT NULL DEFAULT 0,
        updated_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
    await client.query("INSERT IGNORE INTO catalog_item_discovery (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z')");
    await client.query(`CREATE TABLE IF NOT EXISTS catalog_discovered_items (
        item_id BIGINT NOT NULL PRIMARY KEY CHECK (item_id > 0 AND item_id <= 10000000),
        payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
        run_id CHAR(36) NOT NULL,
        first_seen_at VARCHAR(30) NOT NULL,
        last_seen_at VARCHAR(30) NOT NULL,
        announced TINYINT NOT NULL CHECK (announced IN (0, 1)),
        FOREIGN KEY (run_id) REFERENCES catalog_runs (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}
