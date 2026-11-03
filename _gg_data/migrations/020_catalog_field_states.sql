CREATE TABLE IF NOT EXISTS catalog_field_states (
    entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('item', 'creature', 'realm', 'master_realm', 'relic', 'quest')),
    entity_key VARCHAR(255) NOT NULL,
    field_path VARCHAR(191) NOT NULL,
    state VARCHAR(16) NOT NULL CHECK (state IN ('do_not_check', 'incomplete', 'complete')),
    value_json LONGTEXT NOT NULL CHECK (JSON_VALID(value_json)),
    run_id CHAR(36) NOT NULL,
    PRIMARY KEY (entity_kind, entity_key, field_path),
    FOREIGN KEY (run_id) REFERENCES catalog_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Raw, validated Guide fields are staged with the run and applied in its projection transaction.
CREATE TABLE IF NOT EXISTS catalog_guide_field_updates (
    run_id CHAR(36) NOT NULL,
    entity_kind VARCHAR(16) NOT NULL CHECK (entity_kind IN ('item', 'creature', 'realm', 'master_realm', 'relic', 'quest')),
    entity_key VARCHAR(255) NOT NULL,
    source_key VARCHAR(255) NOT NULL,
    alias_from VARCHAR(255),
    before_manual LONGTEXT,
    before_alias LONGTEXT,
    payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
    before_states LONGTEXT,
    PRIMARY KEY (run_id, entity_kind, entity_key),
    FOREIGN KEY (run_id) REFERENCES catalog_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
