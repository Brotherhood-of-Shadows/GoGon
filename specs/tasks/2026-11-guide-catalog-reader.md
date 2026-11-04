# Read guide cards and search results from the local catalog

Status: implemented (pending review)
Project: specs/project.yaml
Constitution: specs/constitution.yaml
Related domains: specs/catalog-sync.spec.yaml, specs/data-storage.spec.yaml, specs/discord-integration.spec.yaml
Target files: catalog/catalogReader.js, catalog/catalogService.js, tests/catalog-sync/catalog-reader.test.mjs

## Outcome and non-goals

A read-only module returns name search results and display-ready "card" data for every catalog kind
(item, creature, realm, master realm, relic, quest) from MySQL alone, so the Discord guide
(`2026-11-discord-guide.md`) and the owner dashboard show the same relations without reaching
guide.fallensword.com or the game.

Non-goals: Discord rendering, writes of any kind, shop inventories (the catalog stores shop names
only), map objects, owner-only provenance, and pending manual entries without a serving row.

## Current contracts and impact

- Serving tables (migrations 001, 003, 011, 016, 019, 021): `items`, `creatures`, `realms`,
  `master_realms`, `relics` (auto-increment `id`, natural key `realm_id:name`), `quests` (same), plus
  `realm_creatures` and `creature_drops`. JSON text columns: item `stats`, `enhancements`,
  `droppedBy`, `setBonuses`, `details`; creature `stats`, `enhancements`, `droppedItems`; realm
  `shops` (`[{shopId, shopName}]`), `connections` (`[{targetRealmId, targetRealmName}]`);
  master realm `connected_realms` (`[{realmId, realmName, minLevel}]`); relic/quest `details`
  (`{sections: [{heading, text}]}`, quest stages are `Stage N` sections since 18dcf39).
- Completeness lives in `catalog_entities.completeness` / `incomplete_reason` (comma-separated
  `INCOMPLETE_REASONS` from `_gg_data/handler/catalogStore.js`), keyed by ID or `realm_id:name`.
  Provisional Item releases (`catalog/itemDiscovery.js`) are `incomplete` until a Guide read.
- `catalog/catalogService.js` `getEntity()` already queries realm creatures/relics/quests, creature
  realms/drops and item dropped-by for the owner dashboard (`tests/control-plane/catalog-*.test.mjs`).
  Its output contract must not change.
- The bot process (`app.mjs`, `discordBot.mjs`) has the migrated client through
  `getConnection()` in `_gg_data/handler/gg_database.js`; the catalog service exists only inside the
  control plane, so the reader takes an injected `db` (`{ query(sql, params) }`).

## Acceptance criteria

- AC-1: Given a kind and query text of 1-64 characters, `search()` returns at most 25 entries whose
  names contain the text case-insensitively, names starting with the text first, then shorter names,
  then ID. Each entry has `kind`, `id` (serving-table ID, also for relics/quests), `name` and a
  disambiguating `hint` of at most 100 characters (item: type, rarity, level; creature: class, level;
  realm: level; master realm: level; relic: realm name; quest: realm name and level). An empty query
  returns the 25 newest entries by ID. `findExact()` returns up to 25 entries whose whole name equals
  the text case-insensitively (a name typed without picking an autocomplete choice).
- AC-2: Given a kind and serving-table ID, `card()` returns a display model with the kind's fields and
  related entries: item stats, enhancements, set name/bonuses, other set pieces (same `setId`),
  dropped-by creatures, provisional tooltip rows/notes; creature class, level, stat ranges,
  enhancements, description, drops, realms; realm level, master realm, creatures, relics, quests,
  shop names, stairways; master realm level, image and member realms (`connected_realms` merged with
  `realms.master_realm_id`); relic realm and its Location/Statistics/Enhancements sections; quest
  realm, minimum level and ordered stages. Every relation is `{ total, entries }` with at most 25
  `{ kind, id, name }` entries, so callers can say "+N more".
- AC-3: Given an entity whose `catalog_entities` row is `incomplete`, the card carries
  `completeness: 'incomplete'` and known reason codes (labels exported as
  `INCOMPLETE_REASON_LABELS`, matching the dashboard wording); a complete entity carries `'complete'`; an
  entity without a catalog row carries `null`. No provenance, run ID, Guide attempt or owner field
  state appears in any result.
- AC-4: Given an unknown kind, an ID that does not exist, query text over 64 characters or a
  non-integer ID, the reader returns `null` or throws `CatalogError('invalid')` respectively and never
  builds SQL from caller text. A malformed JSON column yields that field as empty, never an exception.
- AC-5: After the shared relation helpers replace the inline queries in `catalogService.getEntity()`,
  its existing output for realms, creatures and items is unchanged.

## Design and ordered work

1. Create `catalog/catalogReader.js` exporting `createCatalogReader({ db })` with
   `search(kind, query)`, `findExact(kind, name)` and `card(kind, id)`, plus `relatedRows()` and
   `dashboardRelations()` (the latter keeps `getEntity()`'s shape). `SERVING`, `cellValue` and
   `likePattern` move here from `catalogService.js`, which imports them. Kinds use the
   existing `BROWSE_KINDS`. Search uses `LOWER(name) LIKE ? ESCAPE '!'` with the escaped substring, prefix matches first,
   `LIMIT 200` candidates, then orders by prefix, name length and ID in JavaScript (portable across
   MySQL and the SQLite test fake) and keeps 25; the bound parameters are the only caller input. Relation queries use `LIMIT 26` plus a `COUNT(*)` only when 26 rows return.
2. Resolve related names in one query per relation (no N+1): set pieces by `setId`, dropped-by via
   `creature_drops`, member realms by ID list, quest/relic realm by `realm_id`. Unknown referenced IDs
   (e.g. a stairway target not in `realms`) are kept with their stored name and `id`, but flagged
   `known: false` so the UI does not offer to open them.
3. Completeness: one `catalog_entities` lookup per card with the kind's key
   (`String(id)` or `realm_id:name`).
4. Refactor `catalogService.getEntity()` to call `relationsFor()` while keeping its result shape.
5. Tests in `tests/catalog-sync/catalog-reader.test.mjs` on the existing fake MySQL / MySQL 8.4
   helpers (`tests/helpers/db-client.mjs`) with seeded rows for all six kinds, including the live
   relic/quest section shapes from `tests/catalog-sync/fixtures/guide-*-live.html` parses.

## Verification

| Criterion | Check and expected result |
| --- | --- |
| AC-1 | Seeded names (prefix, infix, case variants, >25 matches, empty query): exact order and 25 cap; hints match per kind. |
| AC-2 | One card per kind with every relation populated; >25 related rows report `total` and 25 entries; quest stages keep Stage order. |
| AC-3 | Complete, incomplete (with reasons) and missing catalog rows; deep-equal assertion shows no provenance or Guide-state keys. |
| AC-4 | Unknown kind/ID, 65-char query, `'1 OR 1=1'` ID, `%`/`_` literals in the query, corrupt JSON column. |
| AC-5 | Existing `npm test` catalog control-plane tests pass unchanged. |

## Change safety

Read-only; no schema change or migration. Search is a full scan of `LOWER(name)` on at most ~17k
items, bounded by `LIMIT 25`, acceptable for MySQL 8.4 at this size; revisit with a generated
lowercase column index only if autocomplete latency exceeds 500 ms in production logs. Rollback is a
revert.

## Open decisions and sources

None. Sources: `catalog/catalogService.js` (`SERVING`, `getEntity`), `_gg_data/handler/catalogStore.js`
(`SCHEMAS`, `INCOMPLETE_REASONS`), migrations listed above, `catalog/guideParsers.js` (relic/quest
sections).
