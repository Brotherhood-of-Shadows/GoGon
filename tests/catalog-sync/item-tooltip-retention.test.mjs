import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createItemTooltipRetention, ITEM_TOOLTIP_DEBUG_FILE } from '../../catalog/itemTooltipRetention.js';

test('unrecognized tooltip is saved owner-only without scripts, forms or token-bearing attributes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gogon-tooltip-'));
    try {
        const logs = [];
        const retain = createItemTooltipRetention({ directory, log: line => logs.push(line) });
        await retain(17070, `<table class="item-tip" width="250" data-token="abc-secret"><tr><td colspan="2"><a href="/index.php?fsRequestToken=href-secret">Twangy’s Axe</a></td></tr></table>
            <script>var fsRequestToken = 'script-secret';</script><form><input name="token" value="form-secret"></form>`);
        const file = path.join(directory, ITEM_TOOLTIP_DEBUG_FILE);
        const saved = readFileSync(file, 'utf8');
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.match(saved, /^<!-- item 17070, sanitized unrecognized response -->/);
        assert.match(saved, /<table class="item-tip" width="250"><tbody><tr><td colspan="2"><a>Twangy’s Axe<\/a><\/td><\/tr><\/tbody><\/table>/);
        assert.doesNotMatch(saved, /secret/);
        assert.deepEqual(logs, [`[Catalog Items] ID 17070: sanitized unrecognized tooltip saved at ${file}.`]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('retention failures are logged and never thrown into the scan', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gogon-tooltip-'));
    try {
        const blocker = path.join(directory, 'not-a-directory');
        writeFileSync(blocker, '');
        const logs = [];
        await createItemTooltipRetention({ directory: blocker, log: line => logs.push(line) })(17070, '<table class="item-tip"></table>');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /^\[Catalog Items\] ID 17070: could not save unrecognized tooltip \(E[A-Z]+\)\.$/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
