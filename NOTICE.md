# GoGon licensing notice

GoGon — FallenSword monitoring, catalog and Discord notification service.
Copyright (C) 2024-2026 Brotherhood of Shadows (https://github.com/Brotherhood-of-Shadows) and GoGon contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
Affero General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program
(see [`LICENSE`](LICENSE)). If not, see <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later

## Network use (AGPL section 13)

If you run a modified version of GoGon so that other people interact with it over a network — for
example, members using its Discord commands — you must offer those people the Corresponding Source
of your modified version, as section 13 of the license requires.

## Earlier code under the ISC license

GoGon was published under the ISC license up to and including commit `18dcf39`
(2026-11-03). Code from that history, including contributions by ColonelReaper and other
contributors, remains available under the ISC license below and is incorporated into this
AGPL-3.0-or-later work as the ISC license permits. Changes made after that commit are licensed
under AGPL-3.0-or-later only.

```text
ISC License

Copyright (c) 2024-2026 CrazyWest Notifications INC and GoGon contributors

Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Third-party components

Dependencies keep their own licenses (see `package-lock.json` and
`scripts/control-plane/guide-requirements.txt`), including discord.js (Apache-2.0), cheerio,
mysql2 and node-fetch (MIT), fetch-cookie (Unlicense), tough-cookie (BSD-3-Clause), dotenv
(BSD-2-Clause), linkedom (ISC), nodriver (AGPL-3.0) and OpenCV (Apache-2.0).

## Trademarks

FallenSword and Hunted Cow are trademarks of Hunted Cow Studios Ltd. Discord is a trademark of
Discord Inc. GoGon is an independent community project and is not affiliated with, endorsed or
sponsored by either company.
