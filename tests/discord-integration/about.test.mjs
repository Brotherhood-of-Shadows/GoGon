// tests/discord-integration/about.test.mjs - /about offers the AGPL source, Terms and Privacy Policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageFlags, ComponentType, ButtonStyle } from 'discord.js';
import { aboutCommand, renderAbout, handleAboutCommand, REPOSITORY_URL } from '../../discord_modules/about.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('/about is a guild command without options', () => {
    assert.deepEqual(aboutCommand.toJSON().options, []);
    assert.equal(aboutCommand.toJSON().name, 'about');
});

test('/about links the source code, Terms, Privacy Policy and license, and names the running version', () => {
    const body = renderAbout();
    const [row] = body.components;
    assert.equal(row.type, ComponentType.ActionRow);
    assert.deepEqual(row.components.map(b => [b.style, b.label, b.url]), [
        [ButtonStyle.Link, 'Source code', REPOSITORY_URL],
        [ButtonStyle.Link, 'Terms of Use', `${REPOSITORY_URL}/blob/main/TERMS.md`],
        [ButtonStyle.Link, 'Privacy Policy', `${REPOSITORY_URL}/blob/main/PRIVACY.md`],
        [ButtonStyle.Link, 'License', `${REPOSITORY_URL}/blob/main/LICENSE`],
    ]);
    const [embed] = body.embeds;
    assert.deepEqual(embed.fields, [
        { name: 'Version', value: pkg.version, inline: true },
        { name: 'License', value: pkg.license, inline: true },
    ]);
    assert.match(embed.description, /GNU Affero General Public License v3\.0 or later/);
    assert.match(embed.description, /source code of the version we run/);
    assert.equal(renderAbout({ version: null }).embeds[0].fields[0].value, 'unknown');
});

test('/about replies only to the requester', async () => {
    const replies = [];
    await handleAboutCommand({ reply: async body => replies.push(body) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(replies[0].embeds[0].title, 'GoGon');
});
