# Browse the local catalog from Discord with /guide

Status: implemented (pending review)
Project: specs/project.yaml
Constitution: specs/constitution.yaml
Related domains: specs/discord-integration.spec.yaml, specs/catalog-sync.spec.yaml
Target files: discord_modules/guide.js, discordBot.mjs, specs/discord-integration.spec.yaml, docs/deployment.md, CHANGELOG.md, tests/discord-integration/guide.test.mjs

## Outcome and non-goals

A guild member types `/guide item name:` (or creature, realm, master-realm, relic, quest), picks an
autocompleted entry, and privately sees a card built from GoGon's MySQL catalog. Menus on the card
open related entries in place (item → dropped by → creature → realms → quests/relics), and **Share**
posts the whole card publicly, menus and stage buttons included. Owner decisions, 2026-11-03: search
with autocomplete and linked cards; replies visible only to the requester with a Share button;
incomplete entries shown with a badge. Owner request, 2026-11-04: Share must not post a static
snapshot of the current view; others must be able to page through every quest stage and follow the
card's links.

Non-goals: reading guide.fallensword.com or the game; filter/browse lists (a later spec may add
`/guide browse`); shop inventories; editing catalog data; role gating (commands stay ungated,
owner decision 2026-09-24).

Depends on `2026-11-guide-catalog-reader.md` (`createCatalogReader`).

## Current contracts and impact

- `discordBot.mjs` registers `/buff`, `/bebuff`, `/checkbuffs`, `/gvgcooldown` as guild commands
  (AC-DISC-001) and returns early for every non-chat-input interaction. The old live-scraper `/guide`
  in `discord_modules/guide.js` is fully commented out ("Cloudflare blocking"), including its
  in-memory `SESSIONS` map.
- discord.js `^14.25.1`: ephemeral replies use `flags: MessageFlags.Ephemeral`; autocomplete uses
  `interaction.respond(choices)`; component interactions on the ephemeral message use
  `interaction.update()`; a non-ephemeral `followUp()` posts a public message.
- Discord limits (docs, accessed 2026-11-03): autocomplete at most 25 choices, choice name and string
  value 1-100 characters, initial interaction response within 3 seconds; `custom_id` 1-100
  characters; a string select holds at most 25 options with label/value/description of at most 100
  characters; one select or up to 5 buttons per action row, 5 action rows per message; embed
  description 4096, field value 1024, 25 fields, 6000 characters in total.
- Tests: `tests/discord-integration/*.test.mjs` use fixture interactions; `bot.test.mjs` covers
  `discordBot.mjs` wiring.

## Acceptance criteria

- AC-1: Given valid Discord settings, `setupDiscord()` registers `/guide` with subcommands `item`,
  `creature`, `realm`, `master-realm`, `relic`, `quest`, each with a required autocompleted `name`
  string option, alongside the four existing commands, which keep their names and behavior.
- AC-2: Given a user typing in a `name` option, the bot responds with at most 25 choices from
  `search()` labelled `name — hint` (truncated to 100 characters) whose value is `kind:id`. If the
  catalog query fails or exceeds 2.5 seconds, it responds with no choices and logs one bounded WARN
  without the typed text.
- AC-3: Given a chosen entry, the reply is ephemeral and shows the kind's card (title, level/type
  line, stats, enhancements, sections or stages, image when present). An incomplete entry shows a
  visible badge naming its reasons in plain words (for example "Incomplete — guide detail not read
  yet"); complete entries show no badge.
- AC-4: Given a card with related entries, it shows up to four select menus (one per relation, at most
  25 options, placeholder "Dropped by (3)" or "Creatures (25 of 140)") plus a **Share** button; a quest
  card with stages also shows **◀ Stage** / **Stage ▶** buttons. Choosing an option or stage updates
  the same ephemeral message to that card or stage. Entries flagged `known: false` are listed in the
  card text but not offered in menus.
- AC-5: Given **Share**, the bot posts the card publicly in the channel at the requester's current
  stage, with the same relation menus, stage buttons and realm/master-realm button but no Share
  button, and with `allowed_mentions: { parse: [] }`, then confirms ephemerally. Nothing is shared
  without the button. A menu or stage button used on the shared post replies to that member with an
  ephemeral card (which has Share again) and never edits the shared post. A component counts as
  "on the requester's card" only when its message carries the Ephemeral flag.
- AC-6: Given a typed name not chosen from autocomplete, the bot resolves an exact case-insensitive
  match of that kind; if several match it shows an ephemeral picker; if none match it replies
  ephemerally "No <kind> named …" with up to 5 suggestions. Given a menu or button for an entry that
  no longer exists, it replies ephemerally that the entry is no longer in the catalog.
- AC-7: Navigation survives a bot restart: every `custom_id` and option value is stateless
  (`guide:go:<slot>` with option value `<kind>:<id>`, `guide:open:<kind>:<id>`,
  `guide:stage:<questId>:<n>`, `guide:share:<kind>:<id>:<n>`; at most 100 characters) and is validated
  before use; a malformed or foreign `custom_id` is answered with an ephemeral "This menu has expired".
- AC-8: Given card text over Discord limits, fields and stage text are truncated with "…" so every
  embed stays within 4096/1024/25-field/6000-character limits; a card never fails to send because of
  length.
- AC-9: Given a database outage, the command and components reply ephemerally "Guide data is
  unavailable right now" and log one ERR with operation and kind only. No `/guide` path makes an HTTP
  request to the game or guide.fallensword.com.

## Design and ordered work

1. Replace `discord_modules/guide.js` with: `guideCommand` (SlashCommandBuilder with six
   subcommands), `handleGuideAutocomplete`, `handleGuideCommand`, `handleGuideComponent`, and pure
   renderers `renderCard(card, { stage })` → `{ embeds, components }` per kind, using
   `createCatalogReader({ db: await getConnection() })`. Keep rendering pure for tests.
2. `custom_id` grammar (AC-7): relation and picker menus are `guide:go:<slot 0-3>` with option
   values `<kind>:<id>`; single-target buttons (a relic's or quest's realm, a realm's master realm) are
   `guide:open:<kind>:<id>`; quest stages `guide:stage:<id>:<n>`; Share `guide:share:<kind>:<id>:<n>`
   (`n = 0` without stages). Parse with one anchored regex; kinds from `BROWSE_KINDS` (subcommand
   `master-realm` ↔ `master_realm`), IDs 1-18 digits, stage 1-99.
3. Card layout: embed colour from item/creature rarity or a kind default; footer "GoGon catalog •
   <kind> #<id>"; relation lists in fields (names, "+N more"); quest stage n in the description with
   "Stage n of N"; relic sections as fields. Badge as the first description line. Reason wording
   comes from `INCOMPLETE_REASON_LABELS` exported by `catalog/catalogReader.js`, with the same text as
   the dashboard's `REASON_LABELS` in `control-plane/public/app.js` (a static browser file that cannot
   import server modules); a test asserts both maps have identical keys and text so they cannot drift.
4. `discordBot.mjs`: register `guideCommand.toJSON()`; route `isAutocomplete()` and components whose
   `customId` starts with `guide:` before the existing early return; slash command `guide` to
   `handleGuideCommand`. Errors follow the existing ephemeral error pattern.
5. Autocomplete deadline: race `search()` against 2.5 s; respond once.
6. Update `specs/discord-integration.spec.yaml` (version 1.7.0): AC-DISC-001 lists `/guide`; add
   AC-DISC-007 for these criteria and the owner decisions with provenance; `docs/deployment.md`
   gains a short `/guide` section; `CHANGELOG.md` entry.
7. Tests in `tests/discord-integration/guide.test.mjs` with a fake reader and fixture interactions
   (no network: `tests/helpers/no-network.mjs` already blocks requests).

## Verification

| Criterion | Check and expected result |
| --- | --- |
| AC-1 | Command JSON snapshot: six subcommands, required autocomplete `name`; bot wiring test lists five commands. |
| AC-2 | Fake reader returning 30 rows → 25 choices, labels ≤100; rejecting/slow reader → `respond([])` once, WARN without typed text. |
| AC-3 | `renderCard` per kind: ephemeral flag, fields present, badge text only for incomplete. |
| AC-4 | Relations >25 → placeholder "(25 of N)", 25 options; select/stage interactions call `update()` with the target card. |
| AC-5 | Share → public reply with menus and stage buttons, no Share button, empty mention parse; ephemeral confirmation. Stage/menu on a non-ephemeral message → ephemeral `reply`, no `update`. |
| AC-6 | Free text exact/multiple/none cases; deleted entry from a menu → ephemeral notice. |
| AC-7 | Fresh module instance handles old `custom_id`s; malformed IDs (`guide:open:item:abc`, 101 chars, unknown kind) → expired notice, no reader call. |
| AC-8 | Oversized fixture (8 KB stage, 60 enhancements) renders within every limit. |
| AC-9 | Reader throwing → ephemeral unavailable message, one ERR; fetch spy never called. |

## Change safety

No schema change. Registering a new guild command is additive; existing commands are re-sent
unchanged in the same `PUT`. Rollback: revert, then the next startup re-registers the four previous
commands (the guild `PUT` replaces the list). Watch the first deployment for autocomplete WARNs
(latency) and ERRs.

## Open decisions and sources

None blocking. Sources (accessed 2026-11-03):
https://docs.discord.com/developers/interactions/application-commands (autocomplete choice limits,
subcommands), https://docs.discord.com/developers/components/reference (custom_id, select and
action row limits), https://docs.discord.com/developers/interactions/receiving-and-responding
(3-second initial response, autocomplete result of up to 25 choices).
