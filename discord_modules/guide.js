// discord_modules/guide.js - specs/tasks/2026-11-discord-guide.md (AC-DISC-007)
// /guide looks entries up in GoGon's own MySQL catalog (catalog/catalogReader.js); it never
// requests guide.fallensword.com or the game. Replies are ephemeral to the requester; Share posts
// the whole card publicly with its menus and stage buttons (owner request 2026-11-04). On a shared
// message those open a private card for whoever clicks, so nobody changes the public post for
// everyone. Every menu and button carries its target in its custom_id or option value, so
// navigation needs no session state and survives a restart.
import { SlashCommandBuilder, MessageFlags, ComponentType, ButtonStyle, escapeMarkdown } from 'discord.js';
import { WARN, ERR } from '../app_modules/core.js';
import { getConnection } from '../_gg_data/handler/gg_database.js';
import { createCatalogReader, INCOMPLETE_REASON_LABELS, MAX_QUERY_LENGTH } from '../catalog/catalogReader.js';

const SUBCOMMANDS = Object.freeze({ item: 'item', creature: 'creature', realm: 'realm', 'master-realm': 'master_realm', relic: 'relic', quest: 'quest' });
const LABELS = Object.freeze({ item: 'Item', creature: 'Creature', realm: 'Realm', master_realm: 'Master realm', relic: 'Relic', quest: 'Quest' });
const KIND_PATTERN = 'item|creature|realm|master_realm|relic|quest';
const VALUE = new RegExp(`^(${KIND_PATTERN}):([1-9]\\d{0,17})$`);
const CUSTOM_ID = new RegExp(`^guide:(?:go:([0-3])|open:(${KIND_PATTERN}):([1-9]\\d{0,17})|stage:([1-9]\\d{0,17}):([1-9]\\d?)|share:(${KIND_PATTERN}):([1-9]\\d{0,17}):(0|[1-9]\\d?))$`);
const AUTOCOMPLETE_DEADLINE_MS = 2500;
// Discord drops a component interaction that is not acknowledged within 3 s of the click. If the
// catalog read has not finished 2 s after the click, the click is acknowledged first and the card
// follows as an edit. Clicks answered more than 1.5 s after they were made are logged with timings.
const ACK_DEADLINE_MS = 2000;
const SLOW_RESPONSE_MS = 1500;
const DEFER = Symbol('defer');
const MAX_MENUS = 4;

export const MESSAGES = Object.freeze({
    unavailable: 'Guide data is unavailable right now. Please try again later.',
    expired: 'This menu has expired. Run /guide again.',
    gone: 'That entry is no longer in the catalog.',
    shared: 'Shared to the channel.',
});

const RARITY_COLORS = { common: 0xffffff, rare: 0x00cccc, unique: 0xcc00cc, legendary: 0xffcc00, epic: 0x00cc00, crystalline: 0xfa9221, 'super elite': 0xcc0000 };
const KIND_COLORS = { item: 0x2f6fde, creature: 0xb04a4a, realm: 0x3f9e5a, master_realm: 0x2e7d6e, relic: 0x8e6cc4, quest: 0xd59a2c };
const STAT_LABELS = { attack: 'Attack', defense: 'Defense', armor: 'Armor', damage: 'Damage', hp: 'HP', xpGain: 'XP Gain', stamina: 'Stamina', staminaGain: 'Stamina Gain', goldGain: 'Gold Gain', gold: 'Gold', xp: 'XP' };
const RELATION_LABELS = { droppedBy: 'Dropped by', setPieces: 'Set pieces', drops: 'Drops', realms: 'Realms', creatures: 'Creatures', quests: 'Quests', relics: 'Relics', stairways: 'Stairways' };
const RELATION_ORDER = { item: ['droppedBy', 'setPieces'], creature: ['drops', 'realms'], realm: ['creatures', 'quests', 'relics', 'stairways'], master_realm: ['realms'], relic: [], quest: [] };

const truncate = (text, max) => { const value = String(text ?? ''); return value.length <= max ? value : `${value.slice(0, max - 1)}…`; };
const md = value => escapeMarkdown(String(value ?? ''));
const signed = value => `${value >= 0 ? '+' : ''}${value}`;

/** The /guide slash command: one subcommand per catalog kind, each with an autocompleted name. */
export const guideCommand = new SlashCommandBuilder()
    .setName('guide')
    .setDescription('Look up items, creatures, realms, relics and quests in the GoGon catalog.');
for (const [sub, kind] of Object.entries(SUBCOMMANDS)) {
    guideCommand.addSubcommand(command => command.setName(sub).setDescription(`Find a ${LABELS[kind].toLowerCase()} in the catalog.`)
        .addStringOption(option => option.setName('name').setDescription(`${LABELS[kind]} name`).setRequired(true).setAutocomplete(true).setMaxLength(100)));
}

// --- rendering ------------------------------------------------------------------------------------

function listText(relation, { minLevel = false } = {}) {
    const names = relation.entries.map(e => `${md(e.name)}${minLevel && e.minLevel != null ? ` (Lvl ${e.minLevel})` : ''}`);
    const more = relation.total > relation.entries.length ? `\n+${relation.total - relation.entries.length} more` : '';
    return truncate(names.join('\n'), 1024 - more.length) + more;
}

function badge(card) {
    if (card.completeness !== 'incomplete') return null;
    const reasons = card.reasons.map(reason => INCOMPLETE_REASON_LABELS[reason]).filter(Boolean);
    return `⚠️ **Incomplete**${reasons.length ? ` — ${reasons.join('; ')}` : ''}`;
}

// --- quest stages -----------------------------------------------------------------------------------
// The Guide parser stores a stage as "Label: value. Label: value — story", and the story usually ends
// with its reward ("You receive 163,379,702 XP", "Gain 10 XP."). Stages are split back into those
// parts for display; text that does not have this shape is shown as it is.
const REQUIREMENT_STYLE = [
    [/^location$/i, '📍', 'Location'],
    [/^minimum level$/i, '🔰', 'Minimum level'],
    [/^required items?$/i, '📦', 'Required item'],
    [/^required kills$/i, '⚔️', 'Required kills'],
];
const REQUIREMENT = /^([A-Z][A-Za-z ]{0,30}):\s*(.*)$/;
const REWARD = /(?:\byou\s+(?:have\s+)?)?\b(?:gain(?:ed|s)?|receive[ds]?|earn(?:ed|s)?|are\s+rewarded\s+with)\s+\d[\d,]*\b[^.!?]{0,120}[.!]?\s*$/i;
const REWARD_VERB = /^(?:you\s+(?:have\s+)?)?(?:gain(?:ed|s)?|receive[ds]?|earn(?:ed|s)?|are\s+rewarded\s+with)\s+/i;
const MAX_PROGRESS_DOTS = 20;
const MAX_STORY = 3200; // leaves room in the 4096-character description for the rest of the stage

/** Splits stored stage text into requirements, story and reward, or returns null for other text.
 * @param {string} text Stored stage text.
 * @returns {{requirements: {label: string, value: string}[], story: string, reward: string|null}|null} Stage parts.
 */
export function splitStageText(text) {
    const value = String(text ?? '').trim();
    const cut = value.indexOf(' — ');
    const head = cut >= 0 ? value.slice(0, cut) : value;
    const requirements = head.split(/\.\s+(?=[A-Z][A-Za-z ]{0,30}:)/).map(part => part.match(REQUIREMENT));
    if (!head || requirements.some(match => !match || /\.\s+\S/.test(match[2]))) return null;
    let story = cut >= 0 ? value.slice(cut + 3).trim() : '';
    const reward = story.match(REWARD);
    if (reward && reward.index > 0) story = story.slice(0, reward.index).trim();
    return {
        requirements: requirements.map(([, label, item]) => ({ label: label.trim(), value: item.replace(/\.$/, '').trim() })),
        story,
        reward: reward && reward.index > 0 ? reward[0].trim().replace(/[.!]$/, '').replace(REWARD_VERB, '') : null,
    };
}

function requirementLine({ label, value }) {
    const [, icon, name] = REQUIREMENT_STYLE.find(([pattern]) => pattern.test(label)) ?? [null, '▫️', label];
    const shown = /^minimum level$/i.test(label) && /^\d{4,}$/.test(value) ? Number(value).toLocaleString('en-US') : value;
    return `${icon} **${md(name)}:** ${/^none$/i.test(shown) ? '*None*' : md(shown || '—')}`;
}

function stageText(stage, number, count) {
    const progress = count > 1 && count <= MAX_PROGRESS_DOTS ? `  ${'●'.repeat(number)}${'○'.repeat(count - number)}` : '';
    const heading = `**📜 ${md(stage.heading)} of ${count}**${progress}`;
    const parts = splitStageText(stage.text);
    if (!parts) return `${heading}\n\n${md(stage.text)}`;
    const quote = text => md(text).split('\n').map(line => `> ${line}`).join('\n');
    return [
        heading,
        `__**Requirements**__\n${parts.requirements.map(requirementLine).join('\n')}`,
        parts.story ? `__**Story**__\n${quote(truncate(parts.story, MAX_STORY))}` : null,
        parts.reward ? `__**Reward**__\n🏆 **${md(parts.reward)}**` : null,
    ].filter(Boolean).join('\n\n');
}

function kindBody(card, stage) {
    const fields = [];
    const add = (name, value, inline = false) => { if (value) fields.push({ name: truncate(name, 256), value: truncate(value, 1024), inline }); };
    const relationField = (key, options) => { const relation = card.relations?.[key]; if (relation?.total) add(`${RELATION_LABELS[key]} (${relation.total})`, listText(relation, options)); };
    let subtitle = null;
    let text = null;
    if (card.kind === 'item') {
        subtitle = [card.type, card.rarity, card.level != null ? `Level ${card.level}` : null].filter(Boolean).map(md).join(' • ');
        add('Stats', Object.entries(card.stats).map(([key, value]) => `${STAT_LABELS[key] ?? md(key)}: ${signed(value)}`).join('\n'), true);
        add('Enhancements', card.enhancements.map(e => `${md(e.name)}: ${signed(e.value)}`).join('\n'), true);
        if (card.set) {
            const bonuses = Object.entries(card.set.bonuses ?? {}).filter(([key, value]) => key !== 'enhancements' && Number.isFinite(value)).map(([key, value]) => `${STAT_LABELS[key] ?? md(key)}: ${signed(value)}`);
            const setEnhancements = Array.isArray(card.set.bonuses?.enhancements) ? card.set.bonuses.enhancements.map(e => `${md(e.name)}: ${signed(e.value)}`) : [];
            add(`Set: ${card.set.name ?? `#${card.set.id}`}`, [...bonuses, ...setEnhancements].join('\n') || '​');
        }
        if (card.tooltip.durability) add('Durability', `${card.tooltip.durability.current ?? '?'} / ${card.tooltip.durability.max}`, true);
        add('Item details', [...card.tooltip.typeDetails, ...card.tooltip.rows, ...card.tooltip.notes].map(md).join('\n'));
        relationField('droppedBy');
        relationField('setPieces');
    } else if (card.kind === 'creature') {
        subtitle = [card.class, card.level != null ? `Level ${card.level}` : null].filter(Boolean).map(md).join(' • ');
        text = card.description ? md(card.description) : null;
        add('Stats', Object.entries(card.stats).map(([key, range]) => `${STAT_LABELS[key] ?? md(key)}: ${range.min === range.max ? range.min : `${range.min}–${range.max}`}`).join('\n'), true);
        add('Enhancements', card.enhancements.map(md).join('\n'), true);
        relationField('drops');
        relationField('realms');
    } else if (card.kind === 'realm') {
        subtitle = card.minLevel != null ? `Level ${card.minLevel}` : null;
        if (card.masterRealm) add('Master realm', md(card.masterRealm.name), true);
        add('Shops', card.shops.map(md).join('\n'), true);
        relationField('creatures');
        relationField('quests', { minLevel: true });
        relationField('relics');
        relationField('stairways');
    } else if (card.kind === 'master_realm') {
        subtitle = card.minLevel != null ? `Level ${card.minLevel}` : null;
        relationField('realms', { minLevel: true });
    } else if (card.kind === 'relic') {
        subtitle = ['Relic', card.realm?.name].filter(Boolean).map(md).join(' • ');
        for (const section of card.sections.slice(0, 20)) add(section.heading, md(section.text));
    } else if (card.kind === 'quest') {
        subtitle = ['Quest', card.realm?.name, card.minLevel != null ? `Level ${card.minLevel}` : null].filter(Boolean).map(md).join(' • ');
        const current = card.stages[stage - 1];
        text = current ? stageText(current, stage, card.stages.length) : 'No stages recorded yet.';
    }
    return { subtitle, text, fields };
}

// Keeps every embed inside Discord's limits: description 4096, 25 fields, 6000 characters in total.
function fitEmbed(embed) {
    embed.fields = (embed.fields ?? []).slice(0, 25);
    const size = () => (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0)
        + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    if (embed.description) embed.description = truncate(embed.description, 4096);
    if (size() > 6000 && embed.description) embed.description = truncate(embed.description, Math.max(200, embed.description.length - (size() - 6000)));
    while (size() > 6000 && embed.fields.length) embed.fields.pop();
    if (!embed.fields.length) delete embed.fields;
    return embed;
}

/** Renders a card as a Discord message body. Pure: no I/O.
 * @param {object} card catalogReader.card() result.
 * @param {{stage?: number, shared?: boolean}} [options] Quest stage (1-based); shared copies keep their
 *     menus and stage buttons but have no Share button.
 * @returns {{embeds: object[], components: object[]}} Message body.
 */
export function renderCard(card, { stage = 1, shared = false } = {}) {
    const stageCount = card.kind === 'quest' ? card.stages.length : 0;
    const currentStage = stageCount ? Math.min(Math.max(1, stage), stageCount) : 0;
    const { subtitle, text, fields } = kindBody(card, currentStage || 1);
    const description = [badge(card), subtitle ? `*${subtitle}*` : null, text].filter(Boolean).join('\n\n');
    const rarity = card.kind === 'item' ? String(card.rarity ?? '').toLowerCase() : '';
    const embed = fitEmbed({
        title: truncate(card.name, 256),
        ...(description ? { description } : {}),
        color: RARITY_COLORS[rarity] ?? KIND_COLORS[card.kind],
        ...(card.imageUrl ? { thumbnail: { url: card.imageUrl } } : {}),
        fields,
        footer: { text: `GoGon catalog • ${LABELS[card.kind]} #${card.id}${shared ? ' • shared from /guide' : ''}` },
    });
    const components = [];
    for (const key of RELATION_ORDER[card.kind]) {
        const relation = card.relations?.[key];
        const options = (relation?.entries ?? []).filter(e => e.known).slice(0, 25).map(e => ({
            label: truncate(e.name, 100), value: `${e.kind}:${e.id}`,
            ...(e.minLevel != null ? { description: `Level ${e.minLevel}` } : {}),
        }));
        if (!options.length || components.length >= MAX_MENUS) continue;
        const counted = relation.total > options.length ? `${options.length} of ${relation.total}` : String(relation.total);
        components.push({ type: ComponentType.ActionRow, components: [{
            type: ComponentType.StringSelect, custom_id: `guide:go:${components.length}`,
            placeholder: truncate(`${RELATION_LABELS[key]} (${counted})`, 150), options,
        }] });
    }
    const buttons = [];
    if (stageCount > 1) {
        buttons.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, label: '◀ Stage', custom_id: `guide:stage:${card.id}:${Math.max(1, currentStage - 1)}`, disabled: currentStage <= 1 });
        buttons.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Stage ▶', custom_id: `guide:stage:${card.id}:${Math.min(stageCount, currentStage + 1)}`, disabled: currentStage >= stageCount });
    }
    const link = card.kind === 'realm' ? card.masterRealm : ['relic', 'quest'].includes(card.kind) ? card.realm : null;
    if (link?.known) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, label: truncate(`${LABELS[link.kind]}: ${link.name}`, 80), custom_id: `guide:open:${link.kind}:${link.id}` });
    if (!shared) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Primary, label: 'Share', custom_id: `guide:share:${card.kind}:${card.id}:${currentStage}` });
    if (buttons.length) components.push({ type: ComponentType.ActionRow, components: buttons });
    return { embeds: [embed], components };
}

function choicePicker(text, results) {
    return {
        content: text,
        embeds: [],
        components: results.length ? [{ type: ComponentType.ActionRow, components: [{
            type: ComponentType.StringSelect, custom_id: 'guide:go:0', placeholder: 'Choose an entry',
            options: results.slice(0, 25).map(r => ({ label: truncate(r.name, 100), value: `${r.kind}:${r.id}`, ...(r.hint ? { description: truncate(r.hint, 100) } : {}) })),
        }] }] : [],
    };
}

// --- interactions ---------------------------------------------------------------------------------

/** Parses a guide custom_id (and select value) into an action, or null when it is not valid.
 * @param {string} customId Component custom_id.
 * @param {string[]} [values] Selected values.
 * @returns {{action: string, kind: string, id: number, stage: number}|null} Parsed action.
 */
export function parseGuideCustomId(customId, values = []) {
    const m = typeof customId === 'string' && customId.length <= 100 ? customId.match(CUSTOM_ID) : null;
    if (!m) return null;
    if (m[1] !== undefined) {
        const value = typeof values?.[0] === 'string' ? values[0].match(VALUE) : null;
        return value ? { action: 'open', kind: value[1], id: Number(value[2]), stage: 1 } : null;
    }
    if (m[2]) return { action: 'open', kind: m[2], id: Number(m[3]), stage: 1 };
    if (m[4]) return { action: 'stage', kind: 'quest', id: Number(m[4]), stage: Number(m[5]) };
    return { action: 'share', kind: m[6], id: Number(m[7]), stage: Number(m[8]) || 1 };
}

const ephemeral = body => ({ ...body, flags: MessageFlags.Ephemeral });
// Only the requester's own ephemeral card is updated in place; anything else (a shared post) is not.
const onPrivateCard = interaction => Boolean(interaction.message?.flags?.has?.(MessageFlags.Ephemeral));
const noMentions = { allowedMentions: { parse: [] } };

function describeTiming(timing, respond) {
    return `reached GoGon ${timing.delivered} ms after the click, catalog read ${timing.read} ms, `
        + `Discord answered in ${respond} ms${timing.deferred ? ' (acknowledged early)' : ''}`;
}

function withDeadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'deadline' })), ms); })])
        .finally(() => clearTimeout(timer));
}

/** Builds the /guide handlers around a catalog reader.
 * @param {{getReader?: () => Promise<object>, log?: {warn: Function, error: Function}, autocompleteDeadlineMs?: number,
 *     ackDeadlineMs?: number, slowResponseMs?: number, now?: () => number}} [deps]
 *     Reader factory, logger, autocomplete deadline, how long after a click a component is
 *     acknowledged early, when a response counts as slow, and the clock (Discord allows 3 s for the
 *     first response).
 * @returns {{autocomplete: Function, command: Function, component: Function}} Interaction handlers.
 */
export function createGuideHandlers({
    getReader = async () => createCatalogReader({ db: await getConnection() }),
    log = { warn: message => WARN('guide', message), error: message => ERR('guide', message) },
    autocompleteDeadlineMs = AUTOCOMPLETE_DEADLINE_MS,
    ackDeadlineMs = ACK_DEADLINE_MS,
    slowResponseMs = SLOW_RESPONSE_MS,
    now = Date.now,
} = {}) {
    const kindOf = interaction => SUBCOMMANDS[interaction.options.getSubcommand(false)] ?? null;

    async function autocomplete(interaction) {
        const kind = kindOf(interaction);
        let results = [];
        try {
            if (kind) {
                const typed = String(interaction.options.getFocused() ?? '').slice(0, MAX_QUERY_LENGTH);
                results = await withDeadline((async () => (await getReader()).search(kind, typed))(), autocompleteDeadlineMs);
            }
        } catch (error) {
            log.warn(`Autocomplete for ${kind ?? 'unknown kind'} returned no choices (${error?.code === 'deadline' ? 'deadline exceeded' : 'catalog unavailable'}).`);
            results = [];
        }
        await interaction.respond(results.slice(0, 25).map(r => ({
            name: truncate(r.hint ? `${r.name} — ${r.hint}` : r.name, 100), value: `${r.kind}:${r.id}`,
        })));
    }

    async function command(interaction) {
        const kind = kindOf(interaction);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const typed = String(interaction.options.getString('name', true)).trim();
            const reader = await getReader();
            const picked = typed.match(VALUE);
            if (picked && picked[1] === kind) {
                const card = await reader.card(kind, Number(picked[2]));
                return await interaction.editReply(card ? renderCard(card) : { content: MESSAGES.gone, embeds: [], components: [] });
            }
            const query = typed.slice(0, MAX_QUERY_LENGTH);
            const matches = query ? await reader.findExact(kind, query) : [];
            if (matches.length === 1) {
                const card = await reader.card(kind, matches[0].id);
                if (card) return await interaction.editReply(renderCard(card));
            }
            if (matches.length > 1) return await interaction.editReply(choicePicker(`Several ${LABELS[kind].toLowerCase()}s are named “${md(query)}”. Choose one:`, matches));
            const suggestions = (await reader.search(kind, query)).slice(0, 5);
            return await interaction.editReply(choicePicker(`No ${LABELS[kind].toLowerCase()} named “${md(truncate(query, 64))}”.${suggestions.length ? ' Did you mean:' : ''}`, suggestions));
        } catch (error) {
            log.error(`Lookup failed for ${kind ?? 'unknown kind'} (${error?.code ?? 'error'}).`);
            await interaction.editReply({ content: MESSAGES.unavailable, embeds: [], components: [] });
        }
    }

    // How a component is answered: 'update' edits the requester's private card, 'ephemeral' answers a
    // click on a shared post with a private card, 'public' is Share.
    const acknowledge = { update: i => i.deferUpdate(), ephemeral: i => i.deferReply({ flags: MessageFlags.Ephemeral }), public: i => i.deferReply() };

    function sendCard(interaction, mode, deferred, body) {
        if (mode === 'update') return deferred ? interaction.editReply({ content: '', ...body }) : interaction.update({ content: '', ...body });
        if (deferred) return interaction.editReply(body);
        return interaction.reply(mode === 'ephemeral' ? ephemeral(body) : body);
    }

    async function sendNotice(interaction, mode, deferred, content) {
        if (!deferred) return interaction.reply(ephemeral({ content }));
        if (mode === 'ephemeral') return interaction.editReply({ content, embeds: [], components: [] });
        // The requester's card stays as it was; a deferred public reply must not show the notice publicly.
        if (mode === 'public') await interaction.deleteReply().catch(() => {});
        return interaction.followUp(ephemeral({ content }));
    }

    async function component(interaction) {
        const clickedAt = Number.isFinite(interaction.createdTimestamp) ? interaction.createdTimestamp : now();
        const timing = { delivered: Math.max(0, now() - clickedAt), read: 0, respond: 0, deferred: false };
        const parsed = parseGuideCustomId(interaction.customId, interaction.values);
        if (!parsed) return interaction.reply(ephemeral({ content: MESSAGES.expired }));
        const mode = parsed.action === 'share' ? 'public' : onPrivateCard(interaction) ? 'update' : 'ephemeral';
        const label = `${parsed.action} ${parsed.kind}`;
        let phase = 'read';
        let started = now();
        let timer;
        try {
            const read = (async () => (await getReader()).card(parsed.kind, parsed.id))();
            read.catch(() => {}); // handled below; keeps an early acknowledgement from leaving it unobserved
            const first = await Promise.race([read, new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, ackDeadlineMs - timing.delivered), DEFER); })]);
            clearTimeout(timer);
            let card = first;
            if (first === DEFER) {
                phase = 'acknowledge';
                await acknowledge[mode](interaction);
                timing.deferred = true;
                phase = 'read';
                card = await read;
            }
            timing.read = now() - started;
            phase = 'respond';
            started = now();
            if (!card) await sendNotice(interaction, mode, timing.deferred, MESSAGES.gone);
            else if (mode === 'public') {
                await sendCard(interaction, mode, timing.deferred, { ...renderCard(card, { stage: parsed.stage, shared: true }), ...noMentions });
                await interaction.followUp(ephemeral({ content: MESSAGES.shared }));
            } else await sendCard(interaction, mode, timing.deferred, renderCard(card, { stage: parsed.stage }));
            timing.respond = now() - started;
        } catch (error) {
            clearTimeout(timer);
            if (phase === 'read') {
                log.error(`Navigation failed for ${parsed.kind} (${error?.code ?? 'error'}).`);
                return sendNotice(interaction, mode, timing.deferred, MESSAGES.unavailable).catch(() => {});
            }
            // 10062 (unknown interaction) means Discord had already given up on the click.
            log.warn(`Discord rejected the ${label} response (${error?.code ?? error?.name ?? 'error'}; ${phase}): ${describeTiming(timing, now() - started)}.`);
            return undefined;
        }
        const total = now() - clickedAt;
        if (total > slowResponseMs || timing.deferred) log.warn(`Slow ${label}: ${describeTiming(timing, timing.respond)}, ${total} ms in total.`);
        return undefined;
    }

    return { autocomplete, command, component };
}

const handlers = createGuideHandlers();
/** Discord autocomplete for /guide name options. */
export const handleGuideAutocomplete = interaction => handlers.autocomplete(interaction);
/** The /guide slash command. */
export const handleGuideCommand = interaction => handlers.command(interaction);
/** /guide menus and buttons (custom_id prefix "guide:"). */
export const handleGuideComponent = interaction => handlers.component(interaction);
