// tests/discord-integration/guide.test.mjs - specs/tasks/2026-11-discord-guide.md (AC-DISC-007)
// /guide handlers and rendering with fixture interactions and a fake catalog reader, plus one pass
// through the real reader on the test database. Nothing reaches Discord, the game or the guide site.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, MessageFlagsBitField, ComponentType } from 'discord.js';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createGuideHandlers, renderCard, parseGuideCustomId, splitStageText, MESSAGES } from '../../discord_modules/guide.js';
import { parseQuestDetail } from '../../catalog/guideParsers.js';
import { createCatalogReader } from '../../catalog/catalogReader.js';
import { freshClient, closeClients } from '../helpers/db-client.mjs';

after(closeClients);

const relation = (kind, total, names) => ({ kind, total, entries: names.map((name, i) => ({ kind, id: 100 + i, name, known: true })) });
const CARDS = {
    item: {
        kind: 'item', id: 17070, name: 'Twangy’s Axe', imageUrl: 'https://cdn2.fallensword.com/items/17070.gif', completeness: 'incomplete',
        reasons: ['guide_detail_missing'], rarity: 'Epic', type: 'Weapon', level: 6000, stats: { attack: 16940, damage: 7260 },
        enhancements: [{ name: 'Dodge', value: 100 }], set: null, tooltip: { rows: [], notes: [], typeDetails: [], durability: { current: 160, max: 160 } },
        relations: { droppedBy: relation('creature', 3, ['Glacial Rat', 'Bandit', 'Goblin']) },
    },
    realm: {
        kind: 'realm', id: 9, name: 'Mountain Path', imageUrl: null, completeness: 'complete', reasons: [], minLevel: 1,
        masterRealm: { kind: 'master_realm', id: 5, name: 'Elya Desert', known: true }, shops: ['Trader Outpost'],
        relations: {
            creatures: relation('creature', 140, Array.from({ length: 25 }, (_, n) => `Creature ${n}`)),
            quests: { kind: 'quest', total: 1, entries: [{ kind: 'quest', id: 51, name: 'Angry Bandits', known: true, minLevel: 1 }] },
            relics: relation('relic', 1, ['Blue Chasm']),
            stairways: { kind: 'realm', total: 2, entries: [{ kind: 'realm', id: 7096, name: 'Kanarak Forest', known: true }, { kind: 'realm', id: 9999, name: 'Hidden Vale', known: false }] },
        },
    },
    quest: {
        kind: 'quest', id: 51, name: 'Angry Bandits', imageUrl: null, completeness: null, reasons: [], minLevel: 1,
        realm: { kind: 'realm', id: 9, name: 'Mountain Path', known: true },
        stages: [{ heading: 'Stage 1', text: 'Minimum Level: 1. Kill rats.' }, { heading: 'Stage 2', text: 'Report back.' }],
    },
};

function fakeReader(overrides = {}) {
    const calls = [];
    const reader = {
        search: async (kind, query) => { calls.push(['search', kind, query]); return []; },
        findExact: async (kind, name) => { calls.push(['findExact', kind, name]); return []; },
        card: async (kind, id) => { calls.push(['card', kind, id]); return Object.values(CARDS).find(c => c.kind === kind && c.id === id) ?? null; },
        ...overrides,
    };
    return { reader, calls };
}

function handlers(reader, extra = {}) {
    const logs = [];
    const h = createGuideHandlers({ getReader: async () => reader, log: { warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]) }, ...extra });
    return { ...h, logs };
}

// Component interactions come from the requester's ephemeral card unless `onShared` is set.
function interaction({ sub = 'item', name, focused, customId, values, onShared = false, createdTimestamp, failOn } = {}) {
    const out = [];
    const record = method => async body => {
        out.push(body === undefined ? [method] : [method, body]);
        if (method === failOn) throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
    };
    return {
        out, customId, values, createdTimestamp,
        message: { flags: new MessageFlagsBitField(onShared ? 0 : MessageFlags.Ephemeral) },
        options: { getSubcommand: () => sub, getString: () => name, getFocused: () => focused },
        respond: record('respond'),
        deferReply: record('deferReply'),
        deferUpdate: record('deferUpdate'),
        deleteReply: record('deleteReply'),
        editReply: record('editReply'),
        reply: record('reply'),
        followUp: record('followUp'),
        update: record('update'),
    };
}

const customIds = body => body.components.flatMap(row => row.components.map(c => c.custom_id));

test('cards render per kind with an incomplete badge, relation menus, stage buttons and Share', () => {
    const item = renderCard(CARDS.item);
    assert.match(item.embeds[0].description, /^⚠️ \*\*Incomplete\*\* — guide detail not read yet\n\n\*Weapon • Epic • Level 6000\*$/);
    assert.deepEqual(item.embeds[0].fields.map(f => f.name), ['Stats', 'Enhancements', 'Durability', 'Dropped by (3)']);
    assert.equal(item.embeds[0].color, 0x00cc00);
    assert.deepEqual(customIds(item), ['guide:go:0', 'guide:share:item:17070:0']);
    assert.equal(item.components[0].components[0].placeholder, 'Dropped by (3)');

    const realm = renderCard(CARDS.realm);
    assert.ok(!/Incomplete/.test(realm.embeds[0].description ?? ''), 'complete entries have no badge');
    assert.deepEqual(customIds(realm), ['guide:go:0', 'guide:go:1', 'guide:go:2', 'guide:go:3', 'guide:open:master_realm:5', 'guide:share:realm:9:0']);
    assert.equal(realm.components[0].components[0].placeholder, 'Creatures (25 of 140)');
    assert.deepEqual(realm.components[3].components[0].options.map(o => o.value), ['realm:7096'], 'unknown stairways are listed, not offered');
    assert.match(realm.embeds[0].fields.find(f => f.name === 'Creatures (140)').value, /\+115 more$/);

    const stage1 = renderCard(CARDS.quest);
    assert.match(stage1.embeds[0].description, /\*\*📜 Stage 1 of 2\*\*  ●○\n\nMinimum Level: 1\. Kill rats\./, 'text without the stored stage shape is shown as it is');
    assert.deepEqual(stage1.components.at(-1).components.map(b => [b.custom_id, b.disabled ?? false]), [
        ['guide:stage:51:1', true], ['guide:stage:51:2', false], ['guide:open:realm:9', false], ['guide:share:quest:51:1', false]]);
    assert.match(renderCard(CARDS.quest, { stage: 2 }).embeds[0].description, /Stage 2 of 2\*\*  ●●\n\nReport back\./);

    const shared = renderCard(CARDS.item, { shared: true });
    assert.deepEqual(customIds(shared), ['guide:go:0'], 'shared cards keep their menus but not Share');
    assert.match(shared.embeds[0].footer.text, /shared from \/guide$/);
    assert.deepEqual(customIds(renderCard(CARDS.quest, { stage: 2, shared: true })), ['guide:stage:51:1', 'guide:stage:51:2', 'guide:open:realm:9']);
    assert.deepEqual(renderCard({ ...CARDS.quest, stages: [], realm: null }, { shared: true }).components, [], 'no empty button row');
});

test('quest stages show requirements, story and reward as separate sections', () => {
    const text = 'Minimum Level: 5501. Location: Lackter Forest (Copse) (15, 14). Required Item: None. Required Kills: None — '
        + 'You return to the farm and see Mikhail. "Greetings [USERNAME]!" He beckons you towards the house. You receive 163,379,702 XP';
    assert.deepEqual(splitStageText(text), {
        requirements: [
            { label: 'Minimum Level', value: '5501' },
            { label: 'Location', value: 'Lackter Forest (Copse) (15, 14)' },
            { label: 'Required Item', value: 'None' },
            { label: 'Required Kills', value: 'None' },
        ],
        story: 'You return to the farm and see Mikhail. "Greetings [USERNAME]!" He beckons you towards the house.',
        reward: '163,379,702 XP',
    });
    const quest = { ...CARDS.quest, stages: [CARDS.quest.stages[0], { heading: 'Stage 2', text }, CARDS.quest.stages[1]] };
    const description = renderCard(quest, { stage: 2 }).embeds[0].description;
    assert.equal(description.split('\n\n').slice(1).join('\n\n'), [
        '**📜 Stage 2 of 3**  ●●○',
        '__**Requirements**__\n🔰 **Minimum level:** 5,501\n📍 **Location:** Lackter Forest \\(Copse\\) \\(15, 14\\)\n📦 **Required item:** *None*\n⚔️ **Required kills:** *None*',
        '__**Story**__\n> You return to the farm and see Mikhail. "Greetings [USERNAME]!" He beckons you towards the house.',
        '__**Reward**__\n🏆 **163,379,702 XP**',
    ].join('\n\n').replace(/\\\(/g, '(').replace(/\\\)/g, ')'));
    assert.equal(splitStageText('Required Kills: 10 x Bandit — Slay them. Gain 200 XP.').reward, '200 XP');
    assert.equal(splitStageText('Location: Mountain Path (2, 6) — The guard nods.').reward, null, 'no reward sentence, no reward section');
    assert.equal(splitStageText('Kill rats. Then report back.'), null);
});

test('every stage of the live quest page splits into requirements, story and reward', () => {
    const html = readFileSync(new URL('../catalog-sync/fixtures/guide-quest-live.html', import.meta.url), 'utf8');
    const { sections } = parseQuestDetail(parseHTML(html).document, 160);
    for (const section of sections) {
        const parts = splitStageText(section.text);
        assert.deepEqual(parts?.requirements.map(r => r.label), ['Minimum Level', 'Location', 'Required Item', 'Required Kills'], section.heading);
        assert.ok(parts.story.length > 20, section.heading);
        assert.match(parts.reward ?? '', /^\d[\d,]* XP\b/, `${section.heading}: ${section.text.slice(-60)}`);
    }
    assert.equal(splitStageText(sections[6].text).reward, "10 XP + 'Stinking Rat Brew'", 'item rewards stay with the XP');
});

test('oversized cards stay within every Discord limit', () => {
    const huge = {
        ...CARDS.item, name: 'N'.repeat(400),
        enhancements: Array.from({ length: 60 }, (_, n) => ({ name: `Enhancement ${n} ${'x'.repeat(40)}`, value: n })),
        tooltip: { rows: Array.from({ length: 100 }, () => 'y'.repeat(200)), notes: [], typeDetails: [], durability: null },
        relations: { droppedBy: relation('creature', 900, Array.from({ length: 25 }, (_, n) => `${'C'.repeat(150)}${n}`)) },
    };
    const quest = { ...CARDS.quest, stages: [{ heading: 'Stage 1', text: 'z'.repeat(8192) }] };
    const longStory = { ...CARDS.quest, stages: [{ heading: 'Stage 1', text: `Minimum Level: 1 — ${'A long tale. '.repeat(600)}You gain 10 XP` }] };
    assert.match(renderCard(longStory).embeds[0].description, /…\n\n__\*\*Reward\*\*__\n🏆 \*\*10 XP\*\*$/, 'a long story is shortened, not the reward');
    for (const body of [renderCard(huge), renderCard(quest), renderCard(longStory)]) {
        const [embed] = body.embeds;
        const total = embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
        assert.ok(embed.title.length <= 256 && (embed.description?.length ?? 0) <= 4096 && total <= 6000, `total ${total}`);
        assert.ok((embed.fields ?? []).every(f => f.value.length <= 1024) && (embed.fields ?? []).length <= 25);
        for (const row of body.components) for (const c of row.components) {
            assert.ok(c.custom_id.length <= 100);
            for (const option of c.options ?? []) assert.ok(option.label.length <= 100 && option.value.length <= 100);
        }
    }
});

test('autocomplete answers with at most 25 labelled choices, and with none when the catalog fails or is slow', async () => {
    const results = Array.from({ length: 30 }, (_, n) => ({ kind: 'item', id: n + 1, name: `Twangy ${'long '.repeat(30)}${n}`, hint: 'Weapon • Epic' }));
    const ok = handlers(fakeReader({ search: async () => results }).reader);
    const a = interaction({ focused: 'twa' });
    await ok.autocomplete(a);
    const [[, choices]] = a.out;
    assert.equal(choices.length, 25);
    assert.ok(choices.every(c => c.name.length <= 100 && /^item:\d+$/.test(c.value)));

    for (const search of [async () => { throw new Error('ECONNREFUSED'); }, () => new Promise(() => {})]) {
        const failing = handlers(fakeReader({ search }).reader, { autocompleteDeadlineMs: 20 });
        const b = interaction({ focused: 'secret typed text' });
        await failing.autocomplete(b);
        assert.deepEqual(b.out, [['respond', []]]);
        assert.equal(failing.logs.length, 1);
        assert.doesNotMatch(failing.logs[0][1], /secret typed text/);
    }
});

test('the command replies ephemerally with a picked card, an exact match, a picker or suggestions', async () => {
    const { reader, calls } = fakeReader({
        findExact: async (kind, name) => (name === 'twins' ? [{ kind, id: 17070, name: 'Twins', hint: 'A' }, { kind, id: 17071, name: 'Twins', hint: 'B' }]
            : name === 'Twangy’s Axe' ? [{ kind, id: 17070, name: 'Twangy’s Axe', hint: '' }] : []),
        search: async kind => [{ kind, id: 17070, name: 'Twangy’s Axe', hint: 'Weapon' }],
    });
    const h = handlers(reader);
    const picked = interaction({ name: 'item:17070' });
    await h.command(picked);
    assert.deepEqual(picked.out[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    assert.equal(picked.out[1][1].embeds[0].title, 'Twangy’s Axe');
    assert.deepEqual(calls.filter(c => c[0] !== 'card'), [], 'a picked choice needs no name search');

    const exact = interaction({ name: 'Twangy’s Axe' });
    await h.command(exact);
    assert.equal(exact.out[1][1].embeds[0].title, 'Twangy’s Axe');

    const several = interaction({ name: 'twins' });
    await h.command(several);
    assert.match(several.out[1][1].content, /Several items are named/);
    assert.deepEqual(several.out[1][1].components[0].components[0].options.map(o => o.value), ['item:17070', 'item:17071']);

    const none = interaction({ name: 'Nothing like this' });
    await h.command(none);
    assert.match(none.out[1][1].content, /^No item named “Nothing like this”\. Did you mean:$/);

    const gone = interaction({ name: 'item:424242' });
    await h.command(gone);
    assert.equal(gone.out[1][1].content, MESSAGES.gone);
});

test('menus, stage buttons and Share navigate statelessly; Share posts the navigable card publicly without mentions', async () => {
    const { reader } = fakeReader();
    const h = handlers(reader);
    const select = interaction({ customId: 'guide:go:2', values: ['realm:9'] });
    await h.component(select);
    assert.equal(select.out[0][0], 'update');
    assert.equal(select.out[0][1].embeds[0].title, 'Mountain Path');

    const stage = interaction({ customId: 'guide:stage:51:2' });
    await h.component(stage);
    assert.match(stage.out[0][1].embeds[0].description, /Stage 2 of 2/);

    const share = interaction({ customId: 'guide:share:quest:51:2' });
    await h.component(share);
    assert.equal(share.out[0][0], 'reply');
    assert.equal(share.out[0][1].flags, undefined, 'public');
    assert.deepEqual(customIds(share.out[0][1]), ['guide:stage:51:1', 'guide:stage:51:2', 'guide:open:realm:9']);
    assert.deepEqual(share.out[0][1].allowedMentions, { parse: [] });
    assert.match(share.out[0][1].embeds[0].description, /Stage 2 of 2/);
    assert.deepEqual(share.out[1], ['followUp', { content: MESSAGES.shared, flags: MessageFlags.Ephemeral }]);

    // On the shared post, stage buttons and menus open a private card for the clicker; the post stays as it is.
    const publicStage = interaction({ customId: 'guide:stage:51:1', onShared: true });
    await h.component(publicStage);
    assert.equal(publicStage.out.length, 1);
    assert.equal(publicStage.out[0][0], 'reply');
    assert.equal(publicStage.out[0][1].flags, MessageFlags.Ephemeral);
    assert.match(publicStage.out[0][1].embeds[0].description, /Stage 1 of 2/);
    assert.ok(customIds(publicStage.out[0][1]).includes('guide:share:quest:51:1'), 'the private copy can be shared again');
    const publicMenu = interaction({ customId: 'guide:go:0', values: ['realm:9'], onShared: true });
    await h.component(publicMenu);
    assert.deepEqual([publicMenu.out[0][0], publicMenu.out[0][1].flags, publicMenu.out[0][1].embeds[0].title], ['reply', MessageFlags.Ephemeral, 'Mountain Path']);

    const missing = interaction({ customId: 'guide:open:item:424242' });
    await h.component(missing);
    assert.deepEqual(missing.out, [['reply', { content: MESSAGES.gone, flags: MessageFlags.Ephemeral }]]);
});

test('a slow catalog read is acknowledged before Discord gives up on the click, then the card follows as an edit', async () => {
    const slow = (ms, result = undefined) => async (kind, id) => {
        await new Promise(resolve => setTimeout(resolve, ms));
        if (result instanceof Error) throw result;
        return Object.values(CARDS).find(c => c.kind === kind && c.id === id) ?? null;
    };
    const fast = { ackDeadlineMs: 10, slowResponseMs: 5 };
    const methods = i => i.out.map(entry => entry[0]);

    const own = handlers(fakeReader({ card: slow(40) }).reader, fast);
    const ownClick = interaction({ customId: 'guide:stage:51:2' });
    await own.component(ownClick);
    assert.deepEqual(methods(ownClick), ['deferUpdate', 'editReply']);
    assert.match(ownClick.out[1][1].embeds[0].description, /Stage 2 of 2/);
    assert.equal(own.logs.length, 1);
    assert.match(own.logs[0][1], /^Slow stage quest: reached GoGon \d+ ms after the click, catalog read \d+ ms, Discord answered in \d+ ms \(acknowledged early\), \d+ ms in total\.$/);

    const onPost = handlers(fakeReader({ card: slow(40) }).reader, fast);
    const postClick = interaction({ customId: 'guide:stage:51:1', onShared: true });
    await onPost.component(postClick);
    assert.deepEqual(postClick.out.slice(0, 1), [['deferReply', { flags: MessageFlags.Ephemeral }]]);
    assert.equal(postClick.out[1][0], 'editReply');

    const share = handlers(fakeReader({ card: slow(40) }).reader, fast);
    const shareClick = interaction({ customId: 'guide:share:quest:51:1' });
    await share.component(shareClick);
    assert.deepEqual(methods(shareClick), ['deferReply', 'editReply', 'followUp']);
    assert.deepEqual(shareClick.out[0], ['deferReply'], 'a deferred Share is public');
    assert.deepEqual(shareClick.out[1][1].allowedMentions, { parse: [] });

    const failing = handlers(fakeReader({ card: slow(40, new Error('down')) }).reader, fast);
    const failedShare = interaction({ customId: 'guide:share:quest:51:1' });
    await failing.component(failedShare);
    assert.deepEqual(failedShare.out, [['deferReply'], ['deleteReply'], ['followUp', { content: MESSAGES.unavailable, flags: MessageFlags.Ephemeral }]],
        'an outage after a public acknowledgement is reported privately');

    // A click that reached GoGon long after it was made is acknowledged at once.
    const late = handlers(fakeReader({ card: slow(20) }).reader, { ackDeadlineMs: 2000 });
    const lateClick = interaction({ customId: 'guide:stage:51:2', createdTimestamp: Date.now() - 2500 });
    await late.component(lateClick);
    assert.deepEqual(methods(lateClick), ['deferUpdate', 'editReply']);
    assert.match(late.logs[0][1], /reached GoGon (2[5-9]\d\d|\d{4,}) ms after the click/);
});

test('a response Discord rejects is logged once with its timings', async () => {
    const ok = handlers(fakeReader().reader);
    const rejected = interaction({ customId: 'guide:stage:51:2', failOn: 'update' });
    await ok.component(rejected);
    assert.deepEqual(rejected.out.map(entry => entry[0]), ['update']);
    assert.equal(ok.logs.length, 1);
    assert.match(ok.logs[0][1], /^Discord rejected the stage quest response \(10062; respond\): reached GoGon \d+ ms after the click/);
});

test('malformed or foreign custom IDs expire without touching the catalog; outages are reported once', async () => {
    for (const [customId, values] of [['guide:open:item:abc'], ['guide:open:shop:1'], [`guide:open:item:${'1'.repeat(101)}`], ['guide:go:0', ['item:0']],
        ['guide:go:9', ['item:1']], ['guide:stage:51:0'], ['guide:share:item:1'], ['guide:go:0', []]]) {
        assert.equal(parseGuideCustomId(customId, values), null, customId);
        const { reader, calls } = fakeReader();
        const h = handlers(reader);
        const i = interaction({ customId, values });
        await h.component(i);
        assert.deepEqual(i.out, [['reply', { content: MESSAGES.expired, flags: MessageFlags.Ephemeral }]]);
        assert.deepEqual(calls, []);
    }
    const down = handlers(fakeReader({ card: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); }, findExact: async () => { throw new Error('down'); } }).reader);
    const command = interaction({ name: 'item:17070' });
    await down.command(command);
    assert.equal(command.out[1][1].content, MESSAGES.unavailable);
    const menu = interaction({ customId: 'guide:open:item:17070' });
    await down.component(menu);
    assert.deepEqual(menu.out, [['reply', { content: MESSAGES.unavailable, flags: MessageFlags.Ephemeral }]]);
    assert.deepEqual(down.logs.map(l => l[0]), ['error', 'error']);
    assert.doesNotMatch(down.logs.join(), /17070|down/);
});

test('end to end on the catalog database: autocomplete, then the card, without any network request', async () => {
    const db = await freshClient();
    await db.query('INSERT INTO items (id, name, rarity, stats) VALUES (?, ?, ?, ?)', [17070, 'Twangy’s Axe', 'Epic', JSON.stringify({ type: 'Weapon', level: 6000, attack: 16940 })]);
    const fetches = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('network blocked'); };
    try {
        const h = handlers(createCatalogReader({ db }));
        const typing = interaction({ focused: 'twangy' });
        await h.autocomplete(typing);
        assert.deepEqual(typing.out, [['respond', [{ name: 'Twangy’s Axe — Weapon • Epic • Lvl 6000', value: 'item:17070' }]]]);
        const chosen = interaction({ name: 'item:17070' });
        await h.command(chosen);
        const [embed] = chosen.out[1][1].embeds;
        assert.equal(embed.title, 'Twangy’s Axe');
        assert.equal(embed.fields[0].value, 'Attack: +16940');
        assert.equal(chosen.out[1][1].components[0].components[0].type, ComponentType.Button);
    } finally { globalThis.fetch = realFetch; }
    assert.deepEqual(fetches, []);
});
