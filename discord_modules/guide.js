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
        text = current ? `**${md(current.heading)} of ${card.stages.length}**\n${md(current.text)}` : 'No stages recorded yet.';
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

function withDeadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'deadline' })), ms); })])
        .finally(() => clearTimeout(timer));
}

/** Builds the /guide handlers around a catalog reader.
 * @param {{getReader?: () => Promise<object>, log?: {warn: Function, error: Function}, autocompleteDeadlineMs?: number}} [deps]
 *     Reader factory, logger and autocomplete deadline (Discord allows 3 s for the first response).
 * @returns {{autocomplete: Function, command: Function, component: Function}} Interaction handlers.
 */
export function createGuideHandlers({
    getReader = async () => createCatalogReader({ db: await getConnection() }),
    log = { warn: message => WARN('guide', message), error: message => ERR('guide', message) },
    autocompleteDeadlineMs = AUTOCOMPLETE_DEADLINE_MS,
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

    async function component(interaction) {
        const parsed = parseGuideCustomId(interaction.customId, interaction.values);
        if (!parsed) return interaction.reply(ephemeral({ content: MESSAGES.expired }));
        let card;
        try {
            card = await (await getReader()).card(parsed.kind, parsed.id);
        } catch (error) {
            log.error(`Navigation failed for ${parsed.kind} (${error?.code ?? 'error'}).`);
            return interaction.reply(ephemeral({ content: MESSAGES.unavailable }));
        }
        if (!card) return interaction.reply(ephemeral({ content: MESSAGES.gone }));
        if (parsed.action === 'share') {
            await interaction.reply({ ...renderCard(card, { stage: parsed.stage, shared: true }), ...noMentions });
            return interaction.followUp(ephemeral({ content: MESSAGES.shared }));
        }
        const body = renderCard(card, { stage: parsed.stage });
        return onPrivateCard(interaction) ? interaction.update({ content: '', ...body }) : interaction.reply(ephemeral(body));
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
