// dc-opencodex-bot – cleaned & optimized version
// -------------------------------------------------
// Node >=20, ES‑module (package.json already has "type": "module")
// Dependencies: discord.js ^14, dotenv, winston

import { config } from 'dotenv';
config(); // loads .env into process.env safely

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  REST,
  Routes,
  time
} from 'discord.js';
import logger from './src/logger.js';
import { getConfig, setConfig } from './src/configStore.js';

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  logger.error('❌ TOKEN missing in .env');
  process.exit(1);
}

// ----- Configuration constants -----
const OPEN_CODEX_CHANNEL_NAME = 'opencodex';
const TEMP_VC_NAME = 'Join to Create VCs';
const TEMP_TEXT_CHANNEL_NAME = 'bot-logs';
const DEFAULT_CATEGORY_NAME = "Summoner’s Hall";
const GUILD_COMMANDS = true; // set false for global registration (may take 1h)

// ----- Client with required intents -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers // needed for permission edits & member fetches
  ]
});

// -------------------------------------------------
// Helper UI builders (buttons & embeds)
// -------------------------------------------------
function createControlRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lock').setLabel('Toggle Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('limit').setLabel('Set Limit').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('invite').setLabel('Invite').setStyle(ButtonStyle.Secondary).setEmoji('📥')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('kick').setLabel('Kick').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
    new ButtonBuilder().setCustomId('ban').setLabel('Ban').setStyle(ButtonStyle.Secondary).setEmoji('🚫'),
    new ButtonBuilder().setCustomId('transfer').setLabel('Transfer').setStyle(ButtonStyle.Secondary).setEmoji('👑')
  );
  return [row1, row2];
}

function createControlEmbed(ownerId, displayName) {
  return new EmbedBuilder()
    .setTitle(`${displayName}'s Voice Channel Tools`)
    .setDescription(
      `<@${ownerId}>, use this panel to manage your voice channel.\n\n` +
      '🛠️ **Tools available:**\n' +
      '- Lock / Unlock\n' +
      '- Set user limit (0 = unlimited)\n' +
      '- Generate one‑use invite\n' +
      '- Kick members\n' +
      '- Ban members (prevent re‑join)\n' +
      '- Transfer ownership'
    )
    .setColor(0x5865f2);
}

// -------------------------------------------------
// Helper to ensure OpenCodeX owner-only channel exists
// -------------------------------------------------
const commands = [
  { name: 'lock', description: 'Toggle lock (private/public) for this VC' },
  { name: 'limit', description: 'Set a user limit for this VC' },
  { name: 'invite', description: 'Create a one‑use, 5‑minute temporary invite' },
  { name: 'kick', description: 'Kick a member from this VC', options: [{ name: 'user', type: 6, description: 'User to kick', required: true }] },
  { name: 'ban', description: 'Ban a member from re‑joining this VC', options: [{ name: 'user', type: 6, description: 'User to ban', required: true }] },
  { name: 'transfer', description: 'Transfer ownership to another member', options: [{ name: 'user', type: 6, description: 'New owner', required: true }] },
  { name: 'setup', description: 'Initial bot setup (owner only)' }
];

async function registerGuildCommands(guild) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const route = GUILD_COMMANDS ? Routes.applicationGuildCommands(client.user.id, guild.id) : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: commands });
    logger.info(`✅ Commands registered for guild ${guild.name}`);
  } catch (err) {
    logger.error(`❌ Command registration failed for ${guild.name}: ${err}`);
  }
}

async function ensureOpenCodeXChannel(guild, parentCategoryId = null) {
  const cfg = await getConfig(guild.id);
  let targetParentId = parentCategoryId;

  if (!targetParentId && cfg.setupCategoryName) {
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === cfg.setupCategoryName
    );
    if (!category) {
      category = await guild.channels.create({
        name: cfg.setupCategoryName,
        type: ChannelType.GuildCategory
      });
    }
    targetParentId = category.id;
  }

  let openChannel = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === OPEN_CODEX_CHANNEL_NAME
  );

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels] }
  ];

  if (!openChannel) {
    openChannel = await guild.channels.create({
      name: 'OpenCodeX',
      type: ChannelType.GuildText,
      parent: targetParentId || undefined,
      permissionOverwrites: overwrites
    });
    const welcomeEmbed = new EmbedBuilder()
      .setTitle('👋 Welcome to OpenCodeX!')
      .setDescription(
        `Hello <@${guild.ownerId}>! Only you (the Server Owner) and the bot can see this channel.\n\n` +
        `Use **/setup** right here in this channel to configure your Voice Channel category, \`${TEMP_TEXT_CHANNEL_NAME}\`, and \`${TEMP_VC_NAME}\`.`
      )
      .setColor(0x5865f2);
    await openChannel.send({ content: `<@${guild.ownerId}>`, embeds: [welcomeEmbed] }).catch(() => {});
  } else {
    if (targetParentId && openChannel.parentId !== targetParentId) {
      await openChannel.setParent(targetParentId, { lockPermissions: false });
    }
    await openChannel.permissionOverwrites.set(overwrites).catch(() => {});
  }

  if (targetParentId || openChannel.parentId) {
    await openChannel.setPosition(0).catch(() => {});
  }

  return openChannel;
}

// -------------------------------------------------
// In‑memory state for temporary VCs
// -------------------------------------------------
const activeVcs = new Map(); // vcId -> {ownerId, creatorId, startTime, members:Set}

// -------------------------------------------------
// Ready & Guild Join events
// -------------------------------------------------
client.once('ready', async () => {
  logger.info(`✅ Bot logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    await registerGuildCommands(guild);
    try {
      await ensureOpenCodeXChannel(guild);

      const cfg = await getConfig(guild.id);
      if (cfg.setupCategoryName) {
        let category = guild.channels.cache.find(
          c => c.type === ChannelType.GuildCategory && c.name === cfg.setupCategoryName
        );
        if (!category) {
          category = await guild.channels.create({ name: cfg.setupCategoryName, type: ChannelType.GuildCategory });
        }

        let logChannel = guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && c.name === TEMP_TEXT_CHANNEL_NAME && c.parentId === category.id
        ) || guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && c.name === TEMP_TEXT_CHANNEL_NAME
        );
        if (!logChannel) {
          logChannel = await guild.channels.create({
            name: TEMP_TEXT_CHANNEL_NAME,
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
              { id: guild.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions], allow: [PermissionFlagsBits.ViewChannel] },
              { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
            ]
          });
        }

        let genVc = guild.channels.cache.find(
          c => c.type === ChannelType.GuildVoice && c.name === TEMP_VC_NAME && c.parentId === category.id
        ) || guild.channels.cache.find(
          c => c.type === ChannelType.GuildVoice && c.name === TEMP_VC_NAME
        );
        if (!genVc) {
          await guild.channels.create({ name: TEMP_VC_NAME, type: ChannelType.GuildVoice, parent: category.id });
        }
      }
    } catch (err) {
      logger.error(`Setup error in guild ${guild.name}: ${err}`);
    }
  }
});

client.on('guildCreate', async guild => {
  logger.info(`➕ Joined new guild: ${guild.name}`);
  await registerGuildCommands(guild);
  try {
    await ensureOpenCodeXChannel(guild);
  } catch (err) {
    logger.error(`Failed creating OpenCodeX channel in ${guild.name}: ${err}`);
  }
});

// -------------------------------------------------
// Voice state handling – create temporary VCs
// -------------------------------------------------
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Track members in active VCs
  if (newState.channelId && activeVcs.has(newState.channelId)) {
    const data = activeVcs.get(newState.channelId);
    data.members.add(newState.member.displayName);
  }

  // User joins the generator channel
  if (newState.channel && newState.channel.name === TEMP_VC_NAME) {
    const { guild, member } = newState;
    const displayName = member.displayName;
    const cfg = await getConfig(guild.id);
    const catName = cfg.setupCategoryName || DEFAULT_CATEGORY_NAME;
    const category = newState.channel.parent || guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === catName);
    let tempVc;
    try {
      tempVc = await guild.channels.create({
        name: `${displayName}'s VC`,
        type: ChannelType.GuildVoice,
        parent: category?.id,
        permissionOverwrites: [
          { id: guild.id, allow: [PermissionFlagsBits.Connect] },
          { id: member.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }
        ]
      });

      // Ensure the member is still in the generator before moving
      if (member.voice.channelId === newState.channelId) {
        await member.voice.setChannel(tempVc);
      } else {
        await tempVc.delete().catch(() => {});
        return;
      }
    } catch (err) {
      logger.error(`VC creation error: ${err}`);
      if (tempVc) await tempVc.delete().catch(() => {});
      return;
    }

    // Record state
    activeVcs.set(tempVc.id, {
      ownerId: member.id,
      creatorId: member.id,
      startTime: new Date(),
      members: new Set([displayName])
    });

    // Send control panel
    await tempVc.send({ embeds: [createControlEmbed(member.id, displayName)], components: createControlRows() })
      .catch(() => {});
  }

  // Cleanup when a temporary VC becomes empty
  const leftChannel = oldState.channel;
  if (leftChannel) {
    const cfg = await getConfig(oldState.guild.id);
    const catName = cfg.setupCategoryName || DEFAULT_CATEGORY_NAME;
    const isTemp = activeVcs.has(leftChannel.id) ||
      (leftChannel.parent?.name === catName && leftChannel.name.endsWith("'s VC"));

    if (isTemp && leftChannel.members.size === 0) {
      const data = activeVcs.get(leftChannel.id);
      activeVcs.delete(leftChannel.id);

      const duration = data ? Math.floor((Date.now() - data.startTime) / 60000) : 0;
      const participants = data?.members?.size ? Array.from(data.members).join(', ') : 'None';

      const logEmbed = new EmbedBuilder()
        .setTitle(`📘 Session Log – ${leftChannel.name}`)
        .setColor(0x008080)
        .setTimestamp()
        .addFields({ name: 'Voice Channel ID', value: leftChannel.id })
        .addFields({ name: 'Participants', value: participants })
        .addFields({ name: 'Session End', value: time(new Date(), 'F') })
        .addFields({ name: 'Session Duration', value: `${duration} mins` });

      if (data?.creatorId) {
        let ownerLine = `<@${data.creatorId}>`;
        if (data.ownerId && data.ownerId !== data.creatorId) ownerLine += ` (transferred to <@${data.ownerId}>)`;
        logEmbed.addFields({ name: 'Created by', value: ownerLine });
      }

      const logChannel = oldState.guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === TEMP_TEXT_CHANNEL_NAME);
      if (logChannel) await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      await leftChannel.delete().catch(() => {});
    }
  }
});

// -------------------------------------------------
// Slash command & interaction handling (single listener)
// -------------------------------------------------
client.on('interactionCreate', async interaction => {
  try {
  if (!interaction.inGuild()) return;

  // Helper to resolve the user's target Voice Channel (works even if command is used in another chat or if channel is uncached)
  const getTargetVc = () => {
    if (interaction.channel?.isVoiceBased?.()) return interaction.channel;
    return interaction.member?.voice?.channel || null;
  };

  // Modal submit for user‑limit (shared between slash & button)
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_limit')) {
    const val = parseInt(interaction.fields.getTextInputValue('limit_input'), 10);
    if (isNaN(val) || val < 0 || val > 99) {
      return interaction.reply({ content: '❌ Number must be between 0 and 99.', ephemeral: true });
    }
    const explicitId = interaction.customId.split(':')[1];
    const targetVc = (explicitId && interaction.guild.channels.cache.get(explicitId)) || getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ You must be inside your temporary voice channel to set a limit.', ephemeral: true });
    }
    try {
      await targetVc.setUserLimit(val);
      return interaction.reply({ content: val === 0 ? `👥 Limit removed (unlimited) for <#${targetVc.id}>.` : `👥 Limit set to **${val}** for <#${targetVc.id}>.`, ephemeral: true });
    } catch (err) {
      logger.error(`Failed to set user limit: ${err}`);
      return interaction.reply({ content: `❌ Failed to set limit: ${err.message}`, ephemeral: true });
    }
  }

  // Modal submit for /setup
  if (interaction.isModalSubmit() && interaction.customId === 'modal_setup') {
    await interaction.deferReply({ ephemeral: true });
    const categoryName = interaction.fields.getTextInputValue('category_input').trim();
    const guild = interaction.guild;
    await setConfig(guild.id, { setupCategoryName: categoryName });

    // Create or find the category
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === categoryName);
    if (!category) {
      category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
    }

    // Move or create OpenCodeX text channel (owner‑only) at the top
    const openChannel = await ensureOpenCodeXChannel(guild, category.id);

    // Create or move bot‑logs channel beneath it
    let logChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === TEMP_TEXT_CHANNEL_NAME);
    if (!logChannel) {
      logChannel = await guild.channels.create({
        name: TEMP_TEXT_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions], allow: [PermissionFlagsBits.ViewChannel] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
        ]
      });
    } else if (logChannel.parentId !== category.id) {
      await logChannel.setParent(category.id, { lockPermissions: false });
    }

    // Ensure OpenCodeX is above bot-logs (position 0, bot-logs position 1)
    await openChannel.setPosition(0).catch(() => {});
    await logChannel.setPosition(1).catch(() => {});

    // Create or move the temporary voice channel
    let genVc = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.name === TEMP_VC_NAME);
    if (!genVc) {
      genVc = await guild.channels.create({ name: TEMP_VC_NAME, type: ChannelType.GuildVoice, parent: category.id });
    } else if (genVc.parentId !== category.id) {
      await genVc.setParent(category.id, { lockPermissions: false });
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Setup Complete')
      .setDescription(
        `Category **${categoryName}** is ready with channels:\n` +
        `- <#${openChannel.id}> (owner‑only, top of category)\n` +
        `- <#${logChannel.id}>\n` +
        `- <#${genVc.id}>`
      )
      .setColor(0x00ff00);
    return interaction.editReply({ embeds: [embed] });
  }

  // Command handling
  if (interaction.isCommand()) {
    // Owner‑only /setup command (only works inside OpenCodeX channel)
    if (interaction.commandName === 'setup') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/setup`.', ephemeral: true });
      }
      if (interaction.channel.name.toLowerCase() !== OPEN_CODEX_CHANNEL_NAME) {
        const openChannel = interaction.guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && c.name.toLowerCase() === OPEN_CODEX_CHANNEL_NAME
        );
        const chanMention = openChannel ? `<#${openChannel.id}>` : `**#OpenCodeX**`;
        return interaction.reply({ content: `❌ \`/setup\` can only be used inside the ${chanMention} channel.`, ephemeral: true });
      }
      const modal = new ModalBuilder()
        .setCustomId('modal_setup')
        .setTitle('Setup Bot Category')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('category_input')
              .setLabel('Category name')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. Summoner’s Hall')
              .setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    const targetVc = getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Join your temporary voice channel first before using this command.', ephemeral: true });
    }

    const vcData = activeVcs.get(targetVc.id);
    const isServerOwner = interaction.user.id === interaction.guild.ownerId;
    const isOwner = isServerOwner || (vcData
      ? interaction.user.id === vcData.ownerId
      : targetVc.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ManageChannels));
    if (!isOwner) {
      return interaction.reply({ content: '❌ Only the voice channel owner or server owner can use this command.', ephemeral: true });
    }

    switch (interaction.commandName) {
      case 'lock': {
        const everyoneOverwrite = targetVc.permissionOverwrites.cache.get(interaction.guildId);
        const currentlyLocked = everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect);
        await targetVc.permissionOverwrites.edit(interaction.guildId, {
          Connect: currentlyLocked ? null : false
        });
        return interaction.reply({ content: currentlyLocked ? `🔓 <#${targetVc.id}> unlocked.` : `🔒 <#${targetVc.id}> is now private.`, ephemeral: true });
      }
      case 'limit': {
        const modal = new ModalBuilder()
          .setCustomId(`modal_limit:${targetVc.id}`)
          .setTitle('Set VC User Limit')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('limit_input')
                .setLabel('Limit (0‑99, 0 = unlimited)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(2)
                .setPlaceholder('e.g. 5 or 0')
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }
      case 'invite': {
        const invite = await targetVc.createInvite({ maxAge: 300, maxUses: 1, unique: true });
        const embed = new EmbedBuilder()
          .setTitle('🔗 Temporary VC Invite Created')
          .setDescription('Share this link; it expires in **5 minutes** or after **1 use**.')
          .addFields({ name: 'Link', value: `\`${invite.url}\`` })
          .setColor(0x5865f2);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Join Voice Channel').setStyle(ButtonStyle.Link).setURL(invite.url)
        );
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }
      case 'kick': {
        const userId = interaction.options.getUser('user').id;
        const member = await interaction.guild.members.fetch(userId);
        await member.voice.disconnect().catch(() => {});
        return interaction.reply({ content: `👢 <@${userId}> has been kicked.`, ephemeral: true });
      }
      case 'ban': {
        const userId = interaction.options.getUser('user').id;
        await targetVc.permissionOverwrites.edit(userId, { Connect: false });
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member && member.voice.channelId === targetVc.id) await member.voice.disconnect().catch(() => {});
        return interaction.reply({ content: `🚫 <@${userId}> banned from <#${targetVc.id}>.`, ephemeral: true });
      }
      case 'transfer': {
        const newOwnerId = interaction.options.getUser('user').id;
        const oldOwnerId = vcData?.ownerId;
        if (oldOwnerId) await targetVc.permissionOverwrites.delete(oldOwnerId).catch(() => {});
        await targetVc.permissionOverwrites.edit(newOwnerId, { Connect: true, ManageChannels: true });
        const newOwner = await interaction.guild.members.fetch(newOwnerId);
        await targetVc.setName(`${newOwner.displayName}'s VC`).catch(() => {});
        if (vcData) vcData.ownerId = newOwnerId;
        await targetVc.send({ embeds: [createControlEmbed(newOwnerId, newOwner.displayName)], components: createControlRows() }).catch(() => {});
        return interaction.reply({ content: `👑 Ownership transferred to <@${newOwnerId}>.`, ephemeral: true });
      }
    }
  }

  // Button handling
  if (interaction.isButton()) {
    const targetVc = getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Join the voice channel first to use these controls.', ephemeral: true });
    }
    const vcData = activeVcs.get(targetVc.id);
    const isServerOwner = interaction.user.id === interaction.guild.ownerId;
    const isOwner = isServerOwner || (vcData
      ? interaction.user.id === vcData.ownerId
      : targetVc.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ManageChannels));
    if (!isOwner) {
      return interaction.reply({ content: '❌ Only the channel owner or server owner can use these controls.', ephemeral: true });
    }
    switch (interaction.customId) {
      case 'vc_lock':
      case 'lock': {
        const everyoneOverwrite = targetVc.permissionOverwrites.cache.get(interaction.guildId);
        const currentlyLocked = everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect);
        await targetVc.permissionOverwrites.edit(interaction.guildId, {
          Connect: currentlyLocked ? null : false
        });
        return interaction.reply({ content: currentlyLocked ? `🔓 <#${targetVc.id}> unlocked.` : `🔒 <#${targetVc.id}> is now private.`, ephemeral: true });
      }
      case 'vc_limit':
      case 'limit': {
        const modal = new ModalBuilder()
          .setCustomId(`modal_limit:${targetVc.id}`)
          .setTitle('Set VC User Limit')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('limit_input')
                .setLabel('Limit (0‑99, 0 = unlimited)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(2)
                .setPlaceholder('e.g. 5 or 0')
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }
      case 'vc_invite':
      case 'invite': {
        const invite = await targetVc.createInvite({ maxAge: 300, maxUses: 1, unique: true });
        const embed = new EmbedBuilder()
          .setTitle('🔗 Temporary VC Invite Created')
          .setDescription('Share this link; it expires in **5 minutes** or after **1 use**.')
          .addFields({ name: 'Link', value: `\`${invite.url}\`` })
          .setColor(0x5865f2);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Join Voice Channel').setStyle(ButtonStyle.Link).setURL(invite.url)
        );
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }
      case 'vc_kick':
      case 'kick': {
        const otherMembers = Array.from(targetVc.members.values()).filter(m => m.id !== interaction.user.id);
        const options = otherMembers.map(m => ({ label: m.displayName.slice(0, 100), value: m.id }));
        if (options.length > 0) options.push({ label: 'Kick All', value: 'all' });
        if (options.length === 0) options.push({ label: 'No users to kick', value: 'none', default: true });
        const select = new StringSelectMenuBuilder()
          .setCustomId('vc_select_kick')
          .setPlaceholder('Kick who?')
          .addOptions(options);
        return interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
      case 'vc_ban':
      case 'ban': {
        const otherMembers = Array.from(targetVc.members.values()).filter(m => m.id !== interaction.user.id);
        const options = otherMembers.map(m => ({ label: m.displayName.slice(0, 100), value: m.id }));
        if (options.length > 0) options.push({ label: 'Ban All', value: 'all' });
        if (options.length === 0) options.push({ label: 'No users to ban', value: 'none', default: true });
        const select = new StringSelectMenuBuilder()
          .setCustomId('vc_select_ban')
          .setPlaceholder('Ban who?')
          .addOptions(options);
        return interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
      case 'vc_transfer':
      case 'transfer': {
        const otherMembers = Array.from(targetVc.members.values()).filter(m => m.id !== interaction.user.id);
        const options = otherMembers.map(m => ({ label: m.displayName.slice(0, 100), value: m.id }));
        if (options.length === 0) options.push({ label: 'No eligible members', value: 'none', default: true });
        const select = new StringSelectMenuBuilder()
          .setCustomId('vc_select_transfer')
          .setPlaceholder('Transfer to?')
          .addOptions(options);
        return interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
    }
  }

  // Select‑menu handling for kick/ban/transfer
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('vc_select_')) {
    const targetVc = getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    }
    const action = interaction.customId.replace('vc_select_', '');
    const choice = interaction.values[0];
    if (choice === 'none') {
      return interaction.reply({ content: '❌ No eligible members to process.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    if (choice === 'all') {
      for (const m of targetVc.members.values()) {
        if (m.id !== interaction.user.id) {
          if (action === 'kick') {
            await m.voice.disconnect().catch(() => {});
          } else if (action === 'ban') {
            await targetVc.permissionOverwrites.edit(m.id, { Connect: false });
            await m.voice.disconnect().catch(() => {});
          }
        }
      }
      return interaction.followUp({ content: `✅ All users ${action}ed.`, ephemeral: true });
    }
    const member = await interaction.guild.members.fetch(choice).catch(() => null);
    if (!member) return interaction.followUp({ content: '❌ Member not found.', ephemeral: true });
    if (action === 'kick') {
      await member.voice.disconnect().catch(() => {});
      return interaction.followUp({ content: `👢 ${member.displayName} has been kicked.`, ephemeral: true });
    }
    if (action === 'ban') {
      await targetVc.permissionOverwrites.edit(member.id, { Connect: false });
      if (targetVc.members.has(member.id)) await member.voice.disconnect().catch(() => {});
      return interaction.followUp({ content: `🚫 ${member.displayName} has been banned from this channel.`, ephemeral: true });
    }
    if (action === 'transfer') {
      const oldOwnerId = vcData?.ownerId || interaction.user.id;
      await targetVc.permissionOverwrites.delete(oldOwnerId).catch(() => {});
      await targetVc.permissionOverwrites.edit(member.id, { Connect: true, ManageChannels: true });
      await targetVc.setName(`${member.displayName}'s VC`).catch(() => {});
      if (vcData) vcData.ownerId = member.id;
      await targetVc.send({ embeds: [createControlEmbed(member.id, member.displayName)], components: createControlRows() }).catch(() => {});
      return interaction.followUp({ content: `👑 Ownership transferred to ${member.displayName}.`, ephemeral: true });
    }
  }
  } catch (err) {
    logger.error(`Interaction error: ${err}`);
  }
});

// -------------------------------------------------
// Auto‑recreate OpenCodeX if deleted
// -------------------------------------------------
client.on('channelDelete', async channel => {
  if (channel.type === ChannelType.GuildText && channel.name.toLowerCase() === OPEN_CODEX_CHANNEL_NAME) {
    try {
      await ensureOpenCodeXChannel(channel.guild);
      logger.info(`♻️ Recreated OpenCodeX channel in ${channel.guild.name}`);
    } catch (err) {
      logger.error(`Failed to recreate OpenCodeX channel: ${err}`);
    }
  }
});

// -------------------------------------------------
// Graceful shutdown – delete any orphaned temp VCs
// -------------------------------------------------
process.on('SIGINT', async () => {
  logger.info('🛑 Shutting down, cleaning up temp VCs...');
  for (const [vcId] of activeVcs) {
    const channel = client.channels.cache.get(vcId);
    if (channel) await channel.delete().catch(() => {});
  }
  process.exit(0);
});

client.login(TOKEN);
