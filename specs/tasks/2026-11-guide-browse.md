# Browse filtered, paged catalog lists with /guide browse

Status: implemented (pending review)
Project: specs/project.yaml
Constitution: specs/constitution.yaml
Related domains: specs/discord-integration.spec.yaml, specs/catalog-sync.spec.yaml, specs/data-storage.spec.yaml
Target files: _gg_data/migrations/023_catalog_browse_columns.mjs, tests/helpers/fake-mysql.mjs, catalog/catalogReader.js, discord_modules/guide.js, tests/catalog-sync/catalog-reader.test.mjs, tests/discord-integration/guide.test.mjs, tests/data-storage/catalog-browse-columns.test.mjs, tests/data-storage/operations.test.mjs, tests/data-storage/catalog-store.test.mjs, tests/discord-integration/bot.test.mjs, specs/discord-integration.spec.yaml, specs/catalog-sync.spec.yaml, docs/deployment.md, CHANGELOG.md, specs/tasks/2026-11-guide-browse.md

## Outcome and non-goals

A guild member runs `/guide browse item rarity:Epic type:Helmet min-level:1000` (or creature,
realm, master-realm, relic or quest, each with its own filters). They privately get one page of
matching catalog entries, can page through the list with ◀ ▶, open any listed entry as a private card,
and can **Share** the page to the channel with working navigation. The data comes from GoGon's MySQL
catalog only.

Owner decisions, 2026-11-04:
- All six kinds get browse. Item: rarity, type, min/max level. Creature: class, min/max level. Realm:
  master realm, min/max level. Quest: realm, min/max level. Relic: realm. Master realm: min/max level.
- Fixed sort, level ascending. Item and creature by level, realm, master realm and quest by min
  level, each then by name. Relic by realm name, then name. Entries without a level go last.
- 10 entries per page, ◀ ▶ buttons, and a select that opens one of the listed entries as a card.
- Lists are shareable like cards. Share posts the page publicly with working ◀ ▶ and select. Clicks on
  the shared post open a private list or card for whoever clicked, and the post never changes.
- Item type and level, and creature class and level, are filtered through indexed virtual generated
  columns (migration 023), not JSON functions in browse queries.

Non-goals:
- free-text name filters in browse (name look-up stays on `/guide <kind> name:`);
- user-selectable sort;
- shop inventories;
- editing catalog data;
- role gating (commands stay ungated, owner decision 2026-09-24);
- any request to guide.fallensword.com or the game.

Depends on `2026-11-discord-guide.md` (live) and `2026-11-guide-catalog-reader.md`.

## Current contracts and impact

- `catalog/catalogReader.js` (`createCatalogReader({ db })`) exposes `search`, `findExact`, `card`,
  `SEARCH_SQL` per kind, `searchHint(kind, row)`, `INCOMPLETE_REASON_LABELS` and `servingKey`. The
  serving tables are `items`, `creatures`, `realms`, `master_realms`, `relics` and `quests`. Item
  `stats.type`/`stats.level` and creature `stats.class`/`stats.level` live in the `stats` LONGTEXT JSON
  column, which has no JSON_VALID check. Rows like `'{not json'` exist in the reader tests.
  `items.rarity`, `realms.min_level`, `master_realms.min_level`, `quests.min_level` and `realm_id` are
  real columns. The tables use the `utf8mb4_bin` collation.
- Writers: catalogStore inserts and snapshots through explicit column lists (`SCHEMAS[kind].columns`).
  `bulkUpdateDatabase` uses the caller's object keys; its callers pass scraper rows, never `SELECT *`
  output. `getItemById`/`getCreatureById` use `SELECT *` and spread the row. Two extra read-only fields
  are harmless there, and the AC-DATA-005 test checks only `stats`. No code inserts positionally into
  `items` or `creatures`.
- `discord_modules/guide.js`:
  - `guideCommand` has six subcommands.
  - `parseGuideCustomId` accepts `guide:go|open|stage|share`.
  - `createGuideHandlers` provides `autocomplete`, `command` and `component`. `component` has the
    early-acknowledgement path (2 s), the slow WARN (1.5 s) and three modes: `update` on the
    requester's ephemeral message, `ephemeral` on a shared post, and `public` for Share.
  - `discordBot.mjs` routes every `guide:` component and `guide` autocomplete to these handlers. It
    needs no change.
- Discord limits (owner-provided 2026-11-04, consistent with the sources cited in
  `2026-11-discord-guide.md`, accessed 2026-11-03):
  - `custom_id` holds 1-100 characters;
  - a select holds 25 options of up to 100 characters;
  - a message has 5 action rows, with up to 5 buttons per row;
  - embeds allow a 4096-character description and 6000 characters in total;
  - the first response is due within 3 s;
  - subcommand groups and subcommands may be mixed at the top level of one command.
- Measured on a local `mysql:8.4` container with 17,000 synthetic items, 2026-11-04:
  - Guarded `JSON_VALUE` filters, counts and DISTINCT queries take about 30 ms each, all full scans.
  - Indexed virtual columns take under 7 ms. Building both indexes took about 0.5 s.
  - `CASE WHEN JSON_VALID(stats) THEN JSON_VALUE(... RETURNING SIGNED) END` returns NULL for invalid
    JSON, NULL, strings and out-of-range values. It never fails an INSERT or ALTER.
  - `->>` returns the string `'null'` for a JSON null on MySQL but NULL on SQLite, so it is not used.
- Test fake: `tests/helpers/fake-mysql.mjs` runs node:sqlite 3.50.4 in the Node 22 container. It has
  `json_valid`, `json_type` and `json_extract`, but not `JSON_VALUE` or MySQL's `JSON_TYPE`
  return values. CI runs `tests/catalog-sync/*` and `tests/data-storage/*` on real MySQL 8.4.

## Acceptance criteria

- AC-1: `setupDiscord()` registers `/guide` with the six existing subcommands, unchanged, plus a
  `browse` subcommand group. Its subcommands and their optional options:

  | Subcommand | Options |
  | --- | --- |
  | `item` | `rarity` (string, autocomplete), `type` (string, autocomplete), `min-level`, `max-level` |
  | `creature` | `class` (string, autocomplete), `min-level`, `max-level` |
  | `realm` | `master-realm` (string, autocomplete), `min-level`, `max-level` |
  | `master-realm` | `min-level`, `max-level` |
  | `relic` | `realm` (string, autocomplete) |
  | `quest` | `realm` (string, autocomplete), `min-level`, `max-level` |

  `min-level` and `max-level` are integers from 0 to 1,000,000.
- AC-2: Autocomplete on `rarity`, `type` or `class` returns at most 25 distinct stored values of that
  field whose text contains the typed text, case-insensitively, in alphabetical order. Each choice's
  name and value is the stored spelling, at most 100 characters. Autocomplete on `realm` or
  `master-realm` returns the reader's `search()` results as `name — hint` with value `<kind>:<id>`. A
  catalog failure or the 2.5 s deadline returns no choices and logs one WARN naming the kind and option
  only, never the typed text.
- AC-3: The command replies ephemerally with page 1. The embed has:
  - title `<Kind>s`, for example "Items";
  - a description that starts with the active filters in italics, for example "*Epic • Helmet •
    Level 1000–3000*", or "*All entries*" when there are none;
  - one line per entry: `**<n>.** <name> — <hint>`. The hint matches the autocomplete hint and n is
    the entry's position in the whole list. Incomplete entries add ` • ⚠️ Incomplete`, the badge
    wording without reasons; the reasons stay on the card;
  - footer `GoGon catalog • Page p of P • N matches`.

  Each page lists at most 10 entries, in the AC-4 order.
- AC-4: Matching and order:
  - Rarity, type and class match the stored value exactly. A typed value not picked from autocomplete
    is first resolved to the stored spelling case-insensitively. If no stored value matches, the reply
    is "No <kind> has the <field> “<value>”.".
  - A realm or master-realm filter accepts a picked `<kind>:<id>` or an exact name. No match replies
    "No realm named …". Several matches reply "Several realms are named …; pick one from the list.".
  - Level bounds are inclusive. Swapped bounds are treated as min ≤ max. Entries without a level never
    match a level bound.
  - Entries with no name are never listed.
  - Order is level (or min level) ascending, entries without a level last, then name, then ID. Relics
    are ordered by realm name (unknown realm last), then name, then ID.
- AC-5: Components:
  - The list shows a select (`guide:bo`) with one option per listed entry: the name as the label, the
    hint as the description, and `<kind>:<id>` as the value.
  - When there is more than one page, ◀ and ▶ buttons are shown; ◀ is disabled on page 1 and ▶ on the
    last page. A private list also shows **Share**.
  - ◀ ▶ on the requester's private list update that message in place.
  - Choosing an entry always opens its card as a new private reply and leaves the list unchanged. The
    card is the existing card, with Share.
  - An empty result shows no components.
- AC-6: Share posts the current page publicly with ◀ ▶ and the select but no Share button,
  `allowed_mentions: { parse: [] }` and footer suffix ` • shared from /guide`, then confirms
  privately. ◀ ▶ on a shared post reply to the clicker with a private list at that page, which has
  Share. The select on a shared post opens a private card. The shared post is never edited.
- AC-7: Navigation is stateless and survives a restart. List state is encoded as
  `guide:b:<code>:<page>:<fields>` for paging and `guide:bs:<code>:<page>:<fields>` for Share:
  - `<code>` is `i`, `c`, `r`, `m`, `l` or `q`;
  - `<page>` is 1-9999;
  - `<fields>` are the kind's filters in fixed order, separated by `;`, empty when unset;
  - text is stored with `%`, `;` and `:` percent-encoded;
  - IDs are 1-18 digits and levels 0-1,000,000.

  Everything is validated before use. A malformed or foreign ID, or one longer than 100 characters,
  answers "This menu has expired" without a catalog read. A page beyond the current last page shows the
  last page. If a list's state cannot fit in 100 characters, page 1 is shown without ◀ ▶ and Share,
  with the note "Paging is unavailable for these filters.".
- AC-8: Responses:
  - A list read still running 2 s after the click is acknowledged early, with the mode's
    acknowledgement as for cards: `deferUpdate`, ephemeral `deferReply` or public `deferReply`. The
    list follows as an edit.
  - A click answered more than 1.5 s after it was made, or one Discord rejects, logs the existing
    `[guide]` WARN with timings and labels `page <kind>`, `share <kind>` or `open <kind>`.
  - A database outage replies "Guide data is unavailable right now" and logs one ERR with the operation
    (`Browse`) and kind only.
  - No filter value, typed text or payload appears in any log (RULE-002).
  - No browse path makes a network request.
- AC-9: Migration `023_catalog_browse_columns.mjs` adds read-only virtual columns and indexes:
  - columns `items.stat_type` (VARCHAR(64)), `items.stat_level` (BIGINT), `creatures.stat_class`
    (VARCHAR(64)) and `creatures.stat_level` (BIGINT);
  - indexes `items (stat_type, stat_level)`, `items (stat_level)`, `items (rarity)`,
    `creatures (stat_class, stat_level)` and `creatures (stat_level)`.

  A column is the JSON value only when `stats` is valid JSON and the value has the expected JSON type:
  a string for type and class, an integer for level. Otherwise it is NULL. Rows with invalid JSON,
  JSON nulls or wrong types still insert and update. The migration can run again safely: a duplicate
  column or index is ignored. Existing writes, catalog projection, rollback, `getItemById` and
  `bulkUpdateDatabase` behave as before.
- AC-10: Embeds stay within Discord's limits: names are truncated with "…", there are at most 10
  lines, and the existing `fitEmbed` applies. Select options and button labels stay within 100
  characters.

## Design and ordered work

1. **Migration 023**, following the `022` pattern: `up(client)` runs one statement per change and
   ignores `ER_DUP_FIELDNAME` and `ER_DUP_KEYNAME`.
   - `stat_level BIGINT AS (CASE WHEN JSON_VALID(stats) THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(stats, '$.level')) = 'INTEGER' THEN JSON_VALUE(stats, '$.level' RETURNING SIGNED) END END) VIRTUAL`
   - `stat_type VARCHAR(64) AS (CASE WHEN JSON_VALID(stats) THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(stats, '$.type')) = 'STRING' THEN SUBSTR(JSON_VALUE(stats, '$.type'), 1, 64) END END) VIRTUAL`
   - The creature columns are the same, using `$.class`.
   - Each index is a separate `CREATE INDEX` statement: `items_browse_type`, `items_browse_level`,
     `items_browse_rarity`, `creatures_browse_class` and `creatures_browse_level`.

   Verify the exact expressions on `mysql:8.4` before committing.
2. **Fake translation** (`tests/helpers/fake-mysql.mjs`), with explicit, anchored rewrites and a
   header note:
   - `JSON_TYPE(JSON_EXTRACT(x, 'p')) = 'INTEGER'|'STRING'` becomes `json_type(x, 'p') = 'integer'|'text'`;
   - `JSON_VALUE(x, 'p' RETURNING SIGNED)` and `JSON_VALUE(x, 'p')` become `json_extract(x, 'p')`.

   Any other `JSON_VALUE` or `JSON_TYPE` form keeps throwing as untranslatable. Add a fake unit test
   covering invalid JSON, NULL, wrong-type and valid rows.
3. **Reader** (`catalog/catalogReader.js`):
   - `BROWSE_PAGE_SIZE = 10` and `MAX_BROWSE_PAGE = 9999`.
   - `BROWSE_FILTERS`, a frozen per-kind list of `{ key, type: 'text' | 'id' | 'level' }` in custom_id
     order.
   - `BROWSE_SQL` per kind holds the columns, the FROM clause (relic and quest join realms), a
     code-owned WHERE fragment per filter key with one `?`, a level column and the ORDER BY. Level
     bounds use `>= ?` / `<= ?`.
   - `browse(kind, filters, page)` validates kind, filters (shape and bounds) and page. It runs a
     COUNT with the same WHERE, clamps the page to `[1, max(1, pages)]`, then runs `LIMIT 10 OFFSET ?`.
     It looks up completeness for the page's `servingKey`s with one `IN (...)` query on
     `catalog_entities`. It returns
     `{ kind, filters, page, pages, total, entries: [{ kind, id, name, hint, incomplete }] }`.
   - `filterValues(kind, key, typed)` returns DISTINCT stored values (`LOWER(col) LIKE ? ESCAPE '!'`,
     non-null, `ORDER BY col`, `LIMIT 25`).
   - `resolveFilterValue(kind, key, text)` returns the stored spelling of a case-insensitive exact
     match, or null.

   Every value is a bound parameter. The SQL fragments come only from these code-owned maps.
4. **Discord** (`discord_modules/guide.js`):
   - Add the `browse` subcommand group with option builders from a code-owned per-kind table.
   - `encodeBrowseId` and `decodeBrowseId` implement the custom_id grammar. Extend
     `parseGuideCustomId` with `browse` (`guide:b`), `browseShare` (`guide:bs`) and `browseOpen`
     (`guide:bo` with a value of `<kind>:<id>`).
   - `renderBrowse(list, { shared })` is a pure function returning `{ embeds, components }`.
   - Autocomplete branches on `getSubcommandGroup(false) === 'browse'` and the focused option.
   - `command` handles the browse group: resolve text, ID and level options, then read page 1.
   - `component` reads a list or a card for the parsed action and reuses the acknowledgement, modes,
     notices and timing log. `browseOpen` always uses mode `ephemeral`; `browse` uses `update` or
     `ephemeral` by the message's Ephemeral flag; `browseShare` uses `public`.
5. **Tests**:
   - Reader browse tests on the fake, which CI also runs on MySQL: filters, order, NULL levels last,
     invalid-JSON rows excluded from type and level filters but listed unfiltered, page clamp, counts,
     incomplete marker, values and resolve.
   - guide.test.mjs: command JSON, autocomplete branches, renderBrowse limits, the custom_id round
     trip and rejection cases, paging and update, shared-post clicks, Share, open, early
     acknowledgement, outage and no logged text.
   - An end-to-end case on the catalog database.
6. **Docs**:
   - `specs/discord-integration.spec.yaml` 1.9.0: changelog, AC-DISC-001 registers the browse group,
     new AC-DISC-008.
   - `specs/catalog-sync.spec.yaml`: a patch changelog line for migration 023.
   - `docs/deployment.md`: the `/guide` section gains browse.
   - `CHANGELOG.md`: an entry.
   - This spec: Status set to implemented.

## Verification

| Criterion | Check and expected result |
| --- | --- |
| AC-1 | Command JSON: the six subcommands are unchanged, and the `browse` group has six subcommands with the listed options, types, bounds and autocomplete flags. The bot wiring test still passes. |
| AC-2 | A fake reader with 30 values returns 25 choices of at most 100 characters. A failing or slow reader returns `respond([])` and one WARN without the typed text. On the database, `filterValues('item', 'type', 'hel')` returns `['Helmet']`. |
| AC-3 | `renderBrowse` fixture: title, filter line, numbered lines with hints, ⚠️ only on incomplete entries, footer counts. |
| AC-4 | Database tests: rarity, type and level filters, swapped bounds, NULL level last, relic realm order, unknown typed value message, realm resolution with zero, one or several matches. |
| AC-5 | Paging calls `update()` with page 2. The select calls `reply` (ephemeral) with the card, and the list is not updated. ◀ is disabled on page 1. Single-page lists have no ◀ ▶. Empty lists have no components. |
| AC-6 | Share sends a public reply with ◀ ▶ and the select, no Share, empty mention parse and an ephemeral confirmation. ◀ ▶ on a non-ephemeral message reply ephemerally and never call `update`. |
| AC-7 | Round trip for every kind. These fail with "expired" and no reader call: `guide:b:x:1:`, page 0, page 10000, a 101-character ID, an encoded value with a control character, too many fields, a non-digit ID. A page past the end clamps. Over-long state shows the note and no paging. |
| AC-8 | A slow fake read gets an early acknowledgement and then an edit. A rejected response logs once. An outage sends the unavailable notice and one ERR containing only `Browse` and the kind. The log spy never sees filter values. The fetch spy is never called. |
| AC-9 | Fake and MySQL (CI) tests: after migrating, insert rows with invalid JSON, a JSON null, `"level":"x"` and valid data; the columns are NULL, NULL, NULL and the values. Running `up()` twice is a no-op. The existing data-storage and catalog-store suites pass. Run the probe on a local `mysql:8.4` container before committing. |
| AC-10 | An oversized fixture (100-character names, 64-character hints) stays within every limit. |

Full suite: `docker run --rm --network none -v "$PWD":/work:ro -w /work --entrypoint npm gogon-sso-smoke:local test`.

## Change safety

- **Migration 023 is additive.**
  - Adding a virtual column is metadata-only (INSTANT). Each index build reads `items` once, about
    0.3 s for 17,000 rows locally.
  - The expressions cannot fail on any stored value, as probed, so catalog writes cannot be rejected
    by the new columns.
  - Rollback: revert the code. The columns and indexes may stay, since nothing writes them. To remove
    them, drop the five indexes and the four columns; no data is lost because the values are derived.
- **Command registration:**
  - The guild `PUT` re-sends `/guide` with the added group.
  - Old cards' custom_ids are unchanged.
  - Rolling back the code removes the group at the next startup. Old `guide:b…` buttons then answer
    "This menu has expired".
- **Monitoring:** watch the first deployment for `[guide]` slow and ERR lines labelled `page`,
  `share` or `open`.

## Open decisions and sources

None blocking; all five owner decisions are recorded above (2026-11-04). Sources: Discord limits as
cited in `specs/tasks/2026-11-discord-guide.md` (docs.discord.com, accessed 2026-11-03), and the
local MySQL 8.4 probe of 2026-11-04 described above.
