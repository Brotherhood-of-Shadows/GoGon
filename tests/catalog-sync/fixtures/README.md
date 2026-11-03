# Catalog-sync fixtures (CAT-TASK-001)

Every guide HTML file here is **synthetic**. It was written from the selectors the supplied userscripts
in `reconciliation/scrappers/` rely on (`.tHeader b`, `td.tHeader[colspan="10"]`, `a[href*="item_id="]`,
`.creatureImg img`, `img[src*="stairways"]` and similar), not captured from guide.fallensword.com.
If a live page stops matching these shapes, capture a redacted page, add it here, and fix
`catalog/guideParsers.js` against it.

`cloudflare-challenge.html`, `game-login.html`, and `game-logged-out.json` use the published
Cloudflare interstitial markers, the game login signature `utils.js` already checks
(`id="hc-account-link"`), and the `{"s":false,"e":{...}}` envelope `secureFetch` treats as logged out.

No `fetchLocation` (game current-location) fixture exists: that response has never been captured,
so `catalog/contracts/gameLocation.js` stays unverified and observe_realm is refused (owner decision
2026-09-28). A captured fixture must strip player names, IDs, coordinates, and any account data.

## Item discovery tooltip

`item-tooltip.html` is the owner-provided `fetchitem.php?item_id=17060&inv_id=-1&t=0&extra=0`
response (Cuirass of Encillious), formatted for readability. The owner also supplied the exact
negative response `Invalid Request`. These attest the dedicated HTML Item releases reader;
they do not attest the legacy JSON game frontier. Tests use fixtures and block live game/Discord
requests.

`item-tooltip-quest.html` is the owner's follow-up response for item 17069, Twangy Core.
Its compact table has a Quest type and usage/recipe notes, with no `item-tip` table class,
rarity or equipment fields. It covers both the known-item probe and new item discovery.

`item-tooltip-epic-weapon.html` is the owner's item 17070 (Twangy’s Axe) document, with whitespace
formatted for readability and its helper stylesheet/analytics tags retained. It covers all twelve
enhancements, stamina/XP bonuses, the equipment divider, and the actual 17069 → 17070 workflow.
