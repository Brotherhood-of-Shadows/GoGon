# GoGon Privacy Policy

Effective date: 3 November 2026 · Last updated: 4 November 2026

This policy explains how **Brotherhood of Shadows** (<https://github.com/Brotherhood-of-Shadows>),
"we" or "us", processes personal data when operating GoGon: the Discord bot, its commands and menus,
the game notifications it posts to Discord, and its private operator dashboard. We act as the
**controller** under Brazil's General Data Protection Law (Lei Geral de Proteção de Dados,
Law 13.709/2018, "LGPD"). Use of the service is also governed by our [Terms of Use](TERMS.md).

## 1. Data we process

| Data | Source | Purpose | LGPD legal basis |
| --- | --- | --- | --- |
| Discord interaction data: your user ID, username, server and channel IDs, and what you type into a GoGon command or select in its menus | Discord, when you use a command, menu or button | To answer your request and to make sure only you can operate your own reply's buttons | Legitimate interest in providing the service you request (art. 7, IX) |
| FallenSword character names you enter (for example in `/buff`, `/bebuff`, `/checkbuffs`) | You | To perform the requested game action or look-up | Legitimate interest (art. 7, IX) |
| FallenSword game content: character and guild names, shoutbox and guild chat messages, ladder, conflict, bounty, Titan, Super Elite, relic and crate events, game updates | FallenSword, read by our game character | To post community notifications to the Discord channels chosen by the server administrators | Legitimate interest of the guild community (art. 7, IX), limited to content already visible to that character in the game |
| Game catalog data (items, creatures, realms, relics, quests) | Public FallenSword Guide and game tooltips | Catalog look-ups and new-item announcements | Not personal data |
| Operator data: game-account credentials, dashboard administrator name, an audit log of operator actions and denied dashboard requests (including the requesting network address) | Brotherhood of Shadows administrators | To run, secure and audit the service | Legitimate interest in security (art. 7, IX) |

We do not process sensitive personal data on purpose, do not sell or rent personal data, do not use
it for advertising or profiling, and do not read Discord message content outside GoGon's own
commands. The bot uses no tracking cookies; the operator dashboard uses a session cookie only for
signed-in administrators.

## 2. Retention

| Data | How long |
| --- | --- |
| Discord interaction data and character names typed in commands | Only while the request is handled; not stored in GoGon's database |
| Notifications waiting to be sent to Discord | Until sent, then deleted 7 days after delivery; failed notifications stay until an administrator retries or discards them |
| Lists of already-posted game events | Event identifiers only, the most recent 100 to 500 per notification type |
| Messages GoGon has posted in Discord | Kept by Discord until deleted by the server's moderators or by us |
| Application logs | Rotated automatically (at most three files of 10 MB each). Logs record operational events and errors, not the content of game pages or Discord messages |
| Game-account credentials | Until an administrator removes the account profile; stored encrypted (AES-256-GCM) |
| Operator audit log | Until an administrator deletes it |

## 3. Sharing and international transfers

We share data only as needed to run the service:

- **Discord Inc.** (United States) receives the replies and notifications GoGon posts and processes
  your interactions with the bot under Discord's own Privacy Policy.
- **Hunted Cow Studios Ltd.** (United Kingdom) receives the game requests GoGon makes, including
  character names you enter in commands.
- **Our hosting provider** stores GoGon's server, database and logs.

Transfers to these countries happen because the service runs on their platforms, as allowed by
LGPD art. 33 (including transfers needed to perform the service you request). We may also disclose
data when required by law or a competent authority.

## 4. Security

GoGon's database is reachable only from inside its private container network, the operator dashboard
listens only on the server's local interface, game-account credentials are encrypted at rest, and
logs and dashboard responses are designed to exclude passwords, cookies, tokens and webhook
addresses. No system is perfectly secure; we will notify affected people and the ANPD of a security
incident when LGPD art. 48 requires it.

## 5. Your rights

Under LGPD art. 18 you may ask us to: confirm whether we process your data; access it; correct
incomplete, inaccurate or outdated data; anonymize, block or delete unnecessary or excessive data;
port it; learn with whom we share it; and object to processing based on legitimate interest. We
answer within 15 days (LGPD art. 19). Because GoGon stores almost no data about Discord users, many
requests will concern notifications already posted in Discord, which server moderators can remove.
You may also complain to the National Data Protection Authority (ANPD, <https://www.gov.br/anpd>).

## 6. Contact

The Brotherhood of Shadows administrators on the Discord server where GoGon operates are the
contact channel for data subjects (LGPD art. 41; as a small processing agent we provide this channel
under ANPD Resolution CD/ANPD No. 2/2022). Send your request to an administrator there.

## 7. Children

GoGon is not directed at children. Discord requires users to meet its minimum age, and we do not
knowingly process children's data. If you believe a child's data was processed, contact us and we
will delete what we hold.

## 8. Changes

We may update this policy. The current version and its effective date are published in the GoGon
repository, and significant changes are announced on the Discord server where GoGon operates.
