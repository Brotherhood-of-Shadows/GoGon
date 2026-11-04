// discord_modules/about.js - /about: what GoGon is, who runs it, and where its source code is.
// GoGon is licensed under the GNU AGPL-3.0-or-later. Section 13 asks a network service to offer its
// users the Corresponding Source; /about is that offer for Discord users (see TERMS.md section 9).
import { readFileSync } from 'node:fs';
import { SlashCommandBuilder, MessageFlags, ComponentType, ButtonStyle } from 'discord.js';

export const REPOSITORY_URL = 'https://github.com/Brotherhood-of-Shadows/GoGon';
export const OPERATOR_URL = 'https://github.com/Brotherhood-of-Shadows';
const DOCUMENT_URL = name => `${REPOSITORY_URL}/blob/main/${name}`;

const VERSION = (() => {
    try {
        const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof version === 'string' && /^[\w.+-]{1,32}$/.test(version) ? version : null;
    } catch {
        return null;
    }
})();

/** The /about slash command. */
export const aboutCommand = new SlashCommandBuilder()
    .setName('about')
    .setDescription('About GoGon: source code, license, Terms of Use and Privacy Policy.');

/** Renders the /about reply body. Pure: no I/O.
 * @param {{version?: string|null}} [options] Running GoGon version, when known.
 * @returns {{embeds: object[], components: object[]}} Message body.
 */
export function renderAbout({ version = VERSION } = {}) {
    const embed = {
        title: 'GoGon',
        description: [
            'A FallenSword companion bot: buffs, GvG cooldowns, game notifications and the `/guide` catalog.',
            `Run by [Brotherhood of Shadows](${OPERATOR_URL}).`,
            '',
            `GoGon is free software under the [GNU Affero General Public License v3.0 or later](${DOCUMENT_URL('LICENSE')}). `
                + `You can get the source code of the version we run from the [GoGon repository](${REPOSITORY_URL}), `
                + 'and you may study, change and share it under that license.',
        ].join('\n'),
        color: 0x2f6fde,
        fields: [
            { name: 'Version', value: version ?? 'unknown', inline: true },
            { name: 'License', value: 'AGPL-3.0-or-later', inline: true },
        ],
        footer: { text: 'Using GoGon means you accept its Terms of Use. Questions: ask the administrators on Discord.' },
    };
    const link = (label, url) => ({ type: ComponentType.Button, style: ButtonStyle.Link, label, url });
    return {
        embeds: [embed],
        components: [{ type: ComponentType.ActionRow, components: [
            link('Source code', REPOSITORY_URL),
            link('Terms of Use', DOCUMENT_URL('TERMS.md')),
            link('Privacy Policy', DOCUMENT_URL('PRIVACY.md')),
            link('License', DOCUMENT_URL('LICENSE')),
        ] }],
    };
}

/** Replies to /about, visible only to the requester.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction The /about interaction.
 * @returns {Promise<unknown>} The reply.
 */
export function handleAboutCommand(interaction) {
    return interaction.reply({ ...renderAbout(), flags: MessageFlags.Ephemeral });
}
