import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { parseRelicDetail, parseQuestDetail } from '../../catalog/guideParsers.js';
import { normalizeGuideRecord } from '../../catalog/guideNormalizers.js';

// Live Guide pages captured 2026-11-03 with scripts removed: relic 600 and quest 160.
const page = name => readFileSync(`tests/catalog-sync/fixtures/${name}`, 'utf8');
const doc = html => parseHTML(html).document;

test('live relic page yields location, label/value statistics and enhancements that pass server validation', () => {
    const record = parseRelicDetail(doc(page('guide-relic-live.html')), 600);
    assert.deepEqual(record, { id: 600, name: 'Kanarak Magic Circle', minLevel: null, realmId: 7096, realmName: 'Kanarak Forest (Frenzy)', sections: [
        { heading: 'Location', text: 'Kanarak Forest (Frenzy) (2,13)' },
        { heading: 'Statistics', text: 'Attack: 0; Defense: 0; Armour: 0; Damage: 0; HP: 0; Stamina: 250; Stamina Gain: 1; Gold Gain: 0; XP Gain: 0' },
        { heading: 'Enhancements', text: 'Protection: 10%; Protect Gold: 10%' },
    ] });
    const normalized = normalizeGuideRecord('relic', record, 600);
    assert.equal(normalized.entityKey, '7096:Kanarak Magic Circle');
});

test('live quest page yields one section per stage with requirements, story, lowest level and first realm', () => {
    const record = parseQuestDetail(doc(page('guide-quest-live.html')), 160);
    assert.equal(record.name, 'Angry Bandits');
    assert.equal(record.minLevel, 1);
    assert.deepEqual([record.realmId, record.realmName], [9, 'Mountain Path']);
    assert.deepEqual(record.sections.map(section => section.heading), Array.from({ length: 9 }, (_, n) => `Stage ${n + 1}`));
    assert.match(record.sections[2].text, /^Minimum Level: 1\. Location: Mountain Path \(17, 11\)\. Required Item: None\. Required Kills: 10 x Bandit — 'Who ar/);
    assert.match(record.sections[8].text, /^Minimum Level: 4\. .*Required Kills: 1 x Lesser Goblin Sham/);
    assert.equal(normalizeGuideRecord('quest', record, 160).entityKey, '9:Angry Bandits');
});

test('long quest stories are shortened to the record budget instead of rejecting the quest', () => {
    const html = page('guide-quest-live.html').replace(/(<td width="600" valign="top">\s*<table width="600">\s*<tbody><tr><td colspan="10" height="10">)/g, `$1${'A very long tale. '.repeat(400)}`);
    const record = parseQuestDetail(doc(html), 160);
    assert.equal(record.sections.length, 9);
    assert.ok(new TextEncoder().encode(JSON.stringify(record.sections)).length <= 12000);
    assert.ok(record.sections.every(section => section.text.startsWith('Minimum Level:') && section.text.endsWith('…')));
    assert.ok(normalizeGuideRecord('quest', record, 160));
});

test('relic and quest parsers reject pages without their name, realm or content', () => {
    const relic = page('guide-relic-live.html');
    const quest = page('guide-quest-live.html');
    assert.equal(parseRelicDetail(doc(relic.replace(/realm_id=\d+/g, 'realm_id=0')), 600), null, 'no realm link');
    assert.equal(parseRelicDetail(doc(relic.replace('class="tHeader"', 'class="x"')), 600), null, 'no name header');
    assert.equal(parseQuestDetail(doc(quest.replace(/id="stage_/g, 'id="other_')), 160), null, 'no stages');
    assert.equal(parseQuestDetail(doc(quest.replace(/realm_id=\d+/g, 'realm_id=0')), 160), null, 'no stage location');
    assert.equal(parseQuestDetail(doc('<html><body><a href="index.php?cmd=quests">Quests</a></body></html>'), 160), null);
});
