-- ID-only relics/quests wait here until their Guide realm/name identity is known.
CREATE TABLE IF NOT EXISTS catalog_manual_entries (
    entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('relic', 'quest')),
    entity_id BIGINT NOT NULL CHECK (entity_id > 0 AND entity_id <= 10000000),
    payload LONGTEXT NOT NULL,
    name VARCHAR(191),
    realm_id BIGINT,
    min_level INT,
    run_id CHAR(36) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    PRIMARY KEY (entity_kind, entity_id),
    FOREIGN KEY (run_id) REFERENCES catalog_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
