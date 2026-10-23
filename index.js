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
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  REST,
  Routes,
  time
} from 'discord.js';
import readline from 'readline';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import logger from './src/logger.js';
import { getConfig, setConfig } from './src/configStore.js';

const execAsync = promisify(exec);

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  logger.error('❌ TOKEN missing in .env');
  process.exit(1);
}

// ----- Configuration constants -----
const OPEN_CODEX_CHANNEL_NAME = 'opencodex';
const TEMP_VC_NAME = 'Join to Create VCs';
const TEMP_TEXT_CHANNEL_NAME = 'session-logs';
const LEGACY_LOG_CHANNEL_NAME = 'bot-logs';
const WAITING_ROOM_VC_NAME = '🔐 Waiting Room (Enter Password)';
const DEFAULT_CATEGORY_NAME = "Summoner’s Hall";
const GUILD_COMMANDS = true; // set false for global registration (may take 1h)

// ----- Client with required intents -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // needed for permission edits & member fetches
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// -------------------------------------------------
// Helper UI builders (buttons & embeds)
// -------------------------------------------------
function createControlRows(hasPassword = false, isLocked = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lock').setLabel('Toggle Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('allow_users').setLabel('Allow Users').setStyle(ButtonStyle.Secondary).setEmoji('✅'),
    new ButtonBuilder().setCustomId('limit').setLabel('Set Limit').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('rename_vc').setLabel('Rename').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('hide_vc').setLabel('Hide/Show').setStyle(ButtonStyle.Secondary).setEmoji('👻')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('invite').setLabel('Invite').setStyle(ButtonStyle.Secondary).setEmoji('📥'),
    new ButtonBuilder().setCustomId('kick').setLabel('Kick').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
    new ButtonBuilder().setCustomId('ban').setLabel('Ban').setStyle(ButtonStyle.Secondary).setEmoji('🚫'),
    new ButtonBuilder().setCustomId('transfer').setLabel('Transfer').setStyle(ButtonStyle.Secondary).setEmoji('👑'),
    new ButtonBuilder().setCustomId('mute_all').setLabel('Mute All').setStyle(ButtonStyle.Secondary).setEmoji('🔇')
  );
  const row3Components = [
    new ButtonBuilder().setCustomId('claim_vc').setLabel('Claim VC').setStyle(ButtonStyle.Success).setEmoji('🙋‍♂️')
  ];
  if (isLocked) {
    row3Components.push(
      new ButtonBuilder().setCustomId('knock_vc').setLabel('Request to Join').setStyle(ButtonStyle.Secondary).setEmoji('🔔')
    );
  }
  if (hasPassword) {
    row3Components.push(
      new ButtonBuilder().setCustomId('enter_password').setLabel('Enter Password').setStyle(ButtonStyle.Primary).setEmoji('🔑')
    );
  }
  const row3 = new ActionRowBuilder().addComponents(...row3Components);
  return [row1, row2, row3];
}

function createControlEmbed(ownerId, displayName, isLocked = false, hasPassword = false, isHidden = false) {
  const lockText = isLocked
    ? (hasPassword ? '🔐 **Locked (Password Protected)**' : '🔒 **Locked (Private)**')
    : '🔓 **Unlocked (Public)**';
  const visibilityText = isHidden ? ' | 👻 **Hidden (Ghost Mode)**' : '';
  return new EmbedBuilder()
    .setTitle(`${displayName}'s Voice Channel Tools`)
    .setDescription(
      `<@${ownerId}>, use this panel to manage your voice channel.\n` +
      `${lockText}${visibilityText}\n\n` +
      '🛠️ **Tools available:**\n' +
      '- **Toggle Lock** (optional password protection)\n' +
      '- **Allow Users** (searchable multi‑select whitelist)\n' +
      '- **Set Limit** (0 = unlimited) & **Rename** VC\n' +
      '- **Hide/Show** (Ghost Mode) & **Mute All** (Party Mode)\n' +
      '- **Invite / Kick / Ban / Transfer**\n' +
      '- **Claim VC** (if owner left) & **Request to Join / Enter Password**'
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
  { name: 'setup', description: 'Initial bot setup (owner only)' },
  {
    name: 'channelmsg',
    description: 'Set the target text channel for console messages (owner only)',
    options: [
      {
        name: 'channel',
        type: 7, // CHANNEL
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        description: 'Select the text channel where console messages will be sent',
        required: true
      }
    ]
  },
  {
    name: 'movechannel',
    description: 'Move a text channel right below another channel (owner only)'
  },
  {
    name: 'say',
    description: 'Make the bot send a message to a text channel (owner only)',
    options: [
      {
        name: 'message',
        type: 3, // STRING
        description: 'The message to send',
        required: true
      },
      {
        name: 'channel',
        type: 7, // CHANNEL
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        description: 'Optional target channel (defaults to /channelmsg channel)',
        required: false
      }
    ]
  },
  { name: 'rename', description: 'Rename your temporary VC', options: [{ name: 'name', type: 3, description: 'New VC name', required: true }] },
  { name: 'hide', description: 'Toggle Ghost Mode (hide/show VC from channel list)' },
  { name: 'claim', description: 'Claim ownership of the current temporary VC if the owner left' },
  { name: 'muteall', description: 'Server-mute or unmute everyone inside this VC' },
  {
    name: 'embed',
    description: 'Open an interactive Embed Announcement builder (owner only)',
    options: [
      {
        name: 'channel',
        type: 7, // CHANNEL
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        description: 'Target text channel (defaults to /channelmsg or current channel)',
        required: false
      }
    ]
  },
  {
    name: 'purge',
    description: 'Bulk delete 1–100 messages in this channel (owner only)',
    options: [
      {
        name: 'amount',
        type: 4, // INTEGER
        description: 'Number of messages to delete (1–100)',
        required: true
      }
    ]
  },
  { name: 'updatebot', description: 'Pull latest code from GitHub and restart the bot (owner only)' },
  { name: 'vcleaderboard', description: 'Show the Top 10 most active members in Voice Channels' },
  {
    name: 'vcstats',
    description: 'View voice channel activity stats for a user',
    options: [
      {
        name: 'user',
        type: 6, // USER
        description: 'User to check (defaults to yourself)',
        required: false
      }
    ]
  },
  {
    name: 'autorole',
    description: 'Set or disable an automatic role for new members joining the server (owner only)',
    options: [
      {
        name: 'role',
        type: 8, // ROLE
        description: 'Role to automatically give (leave empty to disable)',
        required: false
      }
    ]
  },
  {
    name: 'cleanvirus',
    description: 'Wipe spam/virus messages from a user across ALL channels in 1 click (owner only)',
    options: [
      {
        name: 'user',
        type: 6, // USER
        description: 'The compromised/spamming user whose messages will be wiped across all channels',
        required: true
      },
      {
        name: 'action',
        type: 3, // STRING
        description: 'Optional punishment to stop the spammer immediately',
        required: false,
        choices: [
          { name: 'Timeout for 24 Hours (Recommended)', value: 'timeout' },
          { name: 'Kick from Server', value: 'kick' },
          { name: 'Ban from Server', value: 'ban' },
          { name: 'Delete Messages Only', value: 'none' }
        ]
      }
    ]
  }
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
const moveChannelState = new Map(); // userId -> { channelToMoveId, afterChannelId }
const vcSessionJoinTimes = new Map(); // `${guildId}:${userId}` -> timestamp ms

function formatDuration(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// Helper: Wipe all recent messages from a compromised/virus user across EVERY text-based channel in the guild
async function wipeUserMessagesAcrossGuild(guild, userId, action = 'timeout') {
  let totalDeleted = 0;
  let channelsCleaned = 0;

  await guild.channels.fetch().catch(() => {});
  const textChannels = guild.channels.cache.filter(c => c && typeof c.isTextBased === 'function' && c.isTextBased());

  for (const channel of textChannels.values()) {
    try {
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) continue;

      const userMsgs = messages.filter(m => m.author?.id === userId);
      if (userMsgs.size === 0) continue;

      let deletedInChannel = 0;
      const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
      const bulkEligible = userMsgs.filter(m => (Date.now() - m.createdTimestamp) < twoWeeksMs);
      const olderMsgs = userMsgs.filter(m => (Date.now() - m.createdTimestamp) >= twoWeeksMs);

      if (bulkEligible.size >= 2) {
        const deleted = await channel.bulkDelete(bulkEligible, true).catch(() => null);
        if (deleted) {
          deletedInChannel += deleted.size;
        } else {
          // Fallback to single delete if bulkDelete fails
          for (const msg of bulkEligible.values()) {
            const ok = await msg.delete().then(() => true).catch(() => false);
            if (ok) deletedInChannel++;
          }
        }
      } else if (bulkEligible.size === 1) {
        const singleMsg = bulkEligible.first();
        const ok = await singleMsg.delete().then(() => true).catch(() => false);
        if (ok) deletedInChannel++;
      }

      for (const msg of olderMsgs.values()) {
        const ok = await msg.delete().then(() => true).catch(() => false);
        if (ok) deletedInChannel++;
      }

      if (deletedInChannel > 0) {
        totalDeleted += deletedInChannel;
        channelsCleaned++;
      }
    } catch (_) {}
  }

  let actionResult = 'None (messages deleted only)';
  if (action !== 'none') {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      actionResult = 'User is no longer in the server';
    } else if (member.id === guild.ownerId) {
      actionResult = 'Skipped (User is Server Owner)';
    } else {
      try {
        if (action === 'timeout') {
          if (member.permissions.has(PermissionFlagsBits.Administrator)) {
            actionResult = '⚠️ Cannot timeout an Administrator (Discord limitation)';
          } else if (!member.moderatable) {
            actionResult = '⚠️ Bot role is below this user’s role (Move the Bot role higher in Server Settings → Roles)';
          } else {
            await member.timeout(24 * 60 * 60 * 1000, 'OpenCodeX Anti-Virus / Cross-Channel Spam Cleanup');
            actionResult = '⏳ Timed out for 24 hours';
          }
        } else if (action === 'kick') {
          if (!member.kickable) {
            actionResult = '⚠️ Bot role is below this user’s role (Move the Bot role higher in Server Settings → Roles)';
          } else {
            await member.kick('OpenCodeX Anti-Virus / Cross-Channel Spam Cleanup');
            actionResult = '👢 Kicked from server';
          }
        } else if (action === 'ban') {
          if (!member.bannable) {
            actionResult = '⚠️ Bot role is below this user’s role (Move the Bot role higher in Server Settings → Roles)';
          } else {
            await member.ban({ deleteMessageSeconds: 7 * 24 * 60 * 60, reason: 'OpenCodeX Anti-Virus / Cross-Channel Spam Cleanup' });
            actionResult = '🔨 Banned from server (and wiped 7 days of messages)';
          }
        }
      } catch (err) {
        actionResult = `⚠️ Failed to ${action}: ${err.message} (Check Bot Role position & permissions)`;
      }
    }
  }

  return { totalDeleted, channelsCleaned, actionResult };
}

// Track cross-channel spam (userId -> { text, channels: Set, firstTimestamp })
const spamTracker = new Map();

// -------------------------------------------------
// Ready & Guild Join events
// -------------------------------------------------
let initialReadyDone = false;

client.once('ready', async () => {
  logger.info(`✅ Bot logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      const openChannel = await ensureOpenCodeXChannel(guild);
      const cfg = await getConfig(guild.id);

      // Immediately notify #opencodex that the bot is online (before slash command registration)
      if (openChannel) {
        const onlineEmbed = new EmbedBuilder()
          .setTitle('🟢 Bot Connected & Online!')
          .setDescription(
            `**${client.user.tag}** is now online and ready.\n` +
            `• **Default \`/channelmsg\` Target:** ${cfg.consoleChannelId ? `<#${cfg.consoleChannelId}>` : '*Not set*'}`
          )
          .setColor(0x2ecc71);
        openChannel.send({ embeds: [onlineEmbed] }).catch(() => {});
      }

      // Register slash commands in background without blocking startup
      registerGuildCommands(guild).catch(err => logger.error(`Command reg error: ${err}`));

      if (cfg.setupCategoryName) {
        let category = guild.channels.cache.find(
          c => c.type === ChannelType.GuildCategory && c.name === cfg.setupCategoryName
        );
        if (!category) {
          category = await guild.channels.create({ name: cfg.setupCategoryName, type: ChannelType.GuildCategory });
        }

        let logChannel = guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && (c.name === TEMP_TEXT_CHANNEL_NAME || c.name === LEGACY_LOG_CHANNEL_NAME) && c.parentId === category.id
        ) || guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && (c.name === TEMP_TEXT_CHANNEL_NAME || c.name === LEGACY_LOG_CHANNEL_NAME)
        );
        if (!logChannel) {
          logChannel = await guild.channels.create({
            name: 'Session-logs',
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
              { id: guild.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions], allow: [PermissionFlagsBits.ViewChannel] },
              { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
            ]
          });
        } else if (logChannel.name === LEGACY_LOG_CHANNEL_NAME) {
          await logChannel.setName('Session-logs').catch(() => {});
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

  initialReadyDone = true;
});

// Notify #opencodex if the bot disconnects and reconnects to Discord gateway
client.on('shardReady', async () => {
  if (!initialReadyDone) return;
  for (const guild of client.guilds.cache.values()) {
    const openChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name.toLowerCase() === OPEN_CODEX_CHANNEL_NAME
    );
    if (openChannel) {
      const reconEmbed = new EmbedBuilder()
        .setTitle('🟢 Bot Reconnected!')
        .setDescription(`**${client.user.tag}** re-established connection to Discord.`)
        .setColor(0x2ecc71);
      openChannel.send({ embeds: [reconEmbed] }).catch(() => {});
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

client.on('guildMemberAdd', async member => {
  try {
    const cfg = await getConfig(member.guild.id);
    if (cfg.autoRoleId) {
      const role = member.guild.roles.cache.get(cfg.autoRoleId) ||
        await member.guild.roles.fetch(cfg.autoRoleId).catch(() => null);
      if (role) {
        await member.roles.add(role);
        logger.info(`🎭 Assigned auto-role @${role.name} to ${member.user.tag} in ${member.guild.name}`);
      }
    }
  } catch (err) {
    logger.error(`Auto-role error in ${member.guild.name}: ${err.message}`);
  }
});

// -------------------------------------------------
// Voice state handling – create temporary VCs & track VC leaderboard stats
// -------------------------------------------------
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Track VC time for /vcleaderboard and /vcstats
  const userObj = newState.member?.user || oldState.member?.user;
  if (userObj && !userObj.bot) {
    const guildId = newState.guild.id;
    const key = `${guildId}:${userObj.id}`;
    if (!oldState.channelId && newState.channelId) {
      vcSessionJoinTimes.set(key, Date.now());
    } else if (oldState.channelId && !newState.channelId) {
      const joinedAt = vcSessionJoinTimes.get(key);
      if (joinedAt) {
        vcSessionJoinTimes.delete(key);
        const elapsedSec = Math.floor((Date.now() - joinedAt) / 1000);
        if (elapsedSec > 0) {
          const cfg = await getConfig(guildId);
          const vcStats = cfg.vcStats || {};
          vcStats[userObj.id] = (vcStats[userObj.id] || 0) + elapsedSec;
          await setConfig(guildId, { vcStats });
        }
      }
    }
  }
  // Track members in active VCs & intercept unauthorized joins on password-protected VCs
  if (newState.channelId && activeVcs.has(newState.channelId)) {
    const data = activeVcs.get(newState.channelId);
    const member = newState.member;
    const guild = newState.guild;

    // Check if this VC has a password and the joining user is not authorized yet
    const isAuthorized =
      member.id === data.ownerId ||
      member.id === guild.ownerId ||
      data.allowedUsers?.has(member.id) ||
      newState.channel.permissionOverwrites.cache.get(member.id)?.allow.has(PermissionFlagsBits.Connect);

    if (data.password && !isAuthorized && !member.user.bot) {
      // Create or find a Waiting Room VC to hold the user while they enter the password
      let waitingVc = guild.channels.cache.find(
        c => c.type === ChannelType.GuildVoice && c.name === WAITING_ROOM_VC_NAME && c.parentId === newState.channel.parentId
      );
      if (!waitingVc) {
        waitingVc = await guild.channels.create({
          name: WAITING_ROOM_VC_NAME,
          type: ChannelType.GuildVoice,
          parent: newState.channel.parentId,
          permissionOverwrites: [
            { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect], deny: [PermissionFlagsBits.Speak] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages, PermissionFlagsBits.MoveMembers] }
          ]
        }).catch(() => null);
      }

      if (waitingVc) {
        await member.voice.setChannel(waitingVc).catch(() => {});
      } else {
        await member.voice.disconnect().catch(() => {});
      }

      const passRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`enter_password:${newState.channelId}`)
          .setLabel(`Enter Password for ${newState.channel.name}`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔑')
      );

      const promptEmbed = new EmbedBuilder()
        .setTitle(`🔐 Password Required — ${newState.channel.name}`)
        .setDescription(
          `Hey <@${member.id}>! **${newState.channel.name}** is protected with a password.\n\n` +
          `Click the **🔑 Enter Password** button below and type the password to get pulled into the voice channel automatically!`
        )
        .setColor(0xf1c40f);

      if (waitingVc) {
        await waitingVc.send({ content: `<@${member.id}>`, embeds: [promptEmbed], components: [passRow] }).catch(() => {});
      }
      await newState.channel.send({ content: `<@${member.id}>`, embeds: [promptEmbed], components: [passRow] }).catch(() => {});
      await member.send({ embeds: [promptEmbed], components: [passRow] }).catch(() => {});
      return;
    }

    data.members.add(member.displayName);
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

    // Record state & send control panel
    const panelMsg = await tempVc.send({ embeds: [createControlEmbed(member.id, displayName, false, false)], components: createControlRows(false) })
      .catch(() => null);

    activeVcs.set(tempVc.id, {
      ownerId: member.id,
      creatorId: member.id,
      startTime: new Date(),
      members: new Set([displayName]),
      password: null,
      allowedUsers: new Set([member.id]),
      panelMessageId: panelMsg?.id || null
    });
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

      const logChannel = oldState.guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && (c.name === TEMP_TEXT_CHANNEL_NAME || c.name === LEGACY_LOG_CHANNEL_NAME)
      );
      if (logChannel) await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      await leftChannel.delete().catch(() => {});
    }

    // Also auto-delete the Waiting Room VC when it becomes empty
    if (leftChannel.name === WAITING_ROOM_VC_NAME && leftChannel.members.size === 0) {
      await leftChannel.delete().catch(() => {});
    }
  }
});

// -------------------------------------------------
// Slash command & interaction handling (single listener)
// -------------------------------------------------
client.on('interactionCreate', async interaction => {
  try {
  // Handle "🔑 Enter Password" button (works in VC chat, Waiting Room, OR Direct Messages)
  if (interaction.isButton() && (interaction.customId === 'enter_password' || interaction.customId.startsWith('enter_password:'))) {
    const explicitVcId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
    let targetVc = null;
    if (explicitVcId) {
      targetVc = client.channels.cache.get(explicitVcId) || await client.channels.fetch(explicitVcId).catch(() => null);
    } else if (interaction.channel?.isVoiceBased?.()) {
      targetVc = interaction.channel;
    } else if (interaction.member?.voice?.channel) {
      targetVc = interaction.member.voice.channel;
    }
    if (!targetVc) {
      return interaction.reply({ content: '❌ Voice channel no longer exists.', ephemeral: true });
    }
    const vcData = activeVcs.get(targetVc.id);
    if (!vcData || !vcData.password) {
      return interaction.reply({ content: 'ℹ️ This voice channel does not require a password right now.', ephemeral: true });
    }
    const modal = new ModalBuilder()
      .setCustomId(`modal_enter_password:${targetVc.id}`)
      .setTitle(`Enter Password for ${targetVc.name.slice(0, 25)}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('password_attempt')
            .setLabel('Voice Channel Password')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(32)
            .setPlaceholder('Enter the password...')
            .setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  // Modal submit for entering VC password (works in Guild or Direct Messages)
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_enter_password')) {
    const explicitId = interaction.customId.split(':')[1];
    const targetVc = (explicitId && (client.channels.cache.get(explicitId) || await client.channels.fetch(explicitId).catch(() => null))) ||
      (interaction.channel?.isVoiceBased?.() ? interaction.channel : null);
    if (!targetVc) {
      return interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    }
    const vcData = activeVcs.get(targetVc.id);
    if (!vcData || !vcData.password) {
      return interaction.reply({ content: 'ℹ️ This voice channel does not have an active password.', ephemeral: true });
    }
    const attempt = interaction.fields.getTextInputValue('password_attempt').trim();
    if (attempt !== vcData.password) {
      return interaction.reply({ content: '❌ **Incorrect password!** Access denied.', ephemeral: true });
    }

    if (!vcData.allowedUsers) vcData.allowedUsers = new Set();
    vcData.allowedUsers.add(interaction.user.id);

    await targetVc.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: true,
      Connect: true
    }).catch(() => {});

    // Fetch member in that guild and move them from Waiting Room (or any VC) into targetVc automatically!
    const guildMember = interaction.member?.voice
      ? interaction.member
      : await targetVc.guild.members.fetch(interaction.user.id).catch(() => null);
    if (guildMember?.voice?.channelId && guildMember.voice.channelId !== targetVc.id) {
      await guildMember.voice.setChannel(targetVc).catch(() => {});
    }

    return interaction.reply({
      content: `✅ **Password accepted!** You have been moved into <#${targetVc.id}>.`,
      ephemeral: true
    });
  }

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

  // Modal submit for locking VC with optional password
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_lock')) {
    const explicitId = interaction.customId.split(':')[1];
    const targetVc = (explicitId && interaction.guild.channels.cache.get(explicitId)) || getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    }
    const rawPassword = interaction.fields.getTextInputValue('password_input').trim();
    const hasPassword = rawPassword.length > 0;

    // If password is set, keep Connect: true on @everyone so clicking the VC triggers voiceStateUpdate
    // which immediately intercepts the user into the Waiting Room and sends them the password prompt!
    await targetVc.permissionOverwrites.edit(interaction.guildId, {
      Connect: hasPassword ? true : false
    });

    let vcData = activeVcs.get(targetVc.id);
    if (!vcData) {
      vcData = {
        ownerId: interaction.user.id,
        creatorId: interaction.user.id,
        startTime: new Date(),
        members: new Set(),
        password: null,
        allowedUsers: new Set([interaction.user.id]),
        panelMessageId: null
      };
      activeVcs.set(targetVc.id, vcData);
    }
    if (!vcData.allowedUsers) vcData.allowedUsers = new Set([vcData.ownerId]);
    vcData.password = hasPassword ? rawPassword : null;

    // Refresh control panel so the "🔑 Enter Password" and "🔔 Request to Join" buttons appear
    const ownerMember = await interaction.guild.members.fetch(vcData.ownerId).catch(() => interaction.member);
    const isHidden = Boolean(targetVc.permissionOverwrites.cache.get(interaction.guildId)?.deny.has(PermissionFlagsBits.ViewChannel));
    const updatedEmbed = createControlEmbed(vcData.ownerId, ownerMember?.displayName || 'Owner', true, hasPassword, isHidden);
    const updatedRows = createControlRows(hasPassword, true);

    if (vcData.panelMessageId) {
      const panelMsg = await targetVc.messages.fetch(vcData.panelMessageId).catch(() => null);
      if (panelMsg) await panelMsg.edit({ embeds: [updatedEmbed], components: updatedRows }).catch(() => {});
    } else if (interaction.message) {
      await interaction.message.edit({ embeds: [updatedEmbed], components: updatedRows }).catch(() => {});
    }

    return interaction.reply({
      content: hasPassword
        ? `🔐 <#${targetVc.id}> is now **locked with password** (\`${rawPassword}\`). Users can click **🔑 Enter Password** to unlock access!`
        : `🔒 <#${targetVc.id}> is now **private** (no password).`,
      ephemeral: true
    });
  }

  // Modal submit for renaming VC
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_rename')) {
    const explicitId = interaction.customId.split(':')[1];
    const targetVc = (explicitId && interaction.guild.channels.cache.get(explicitId)) || getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    }
    const newName = interaction.fields.getTextInputValue('rename_input').trim();
    if (!newName) {
      return interaction.reply({ content: '❌ Channel name cannot be empty.', ephemeral: true });
    }
    try {
      await targetVc.setName(newName);
      return interaction.reply({ content: `✏️ Voice channel renamed to **${newName}**!`, ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `❌ Failed to rename VC: ${err.message}`, ephemeral: true });
    }
  }

  // Modal submit for /embed builder
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_embed')) {
    const explicitChannelId = interaction.customId.split(':')[1];
    let targetChannel = explicitChannelId
      ? (interaction.guild.channels.cache.get(explicitChannelId) || await interaction.guild.channels.fetch(explicitChannelId).catch(() => null))
      : null;

    if (!targetChannel) {
      const cfg = await getConfig(interaction.guild.id);
      if (cfg.consoleChannelId) {
        targetChannel = interaction.guild.channels.cache.get(cfg.consoleChannelId) ||
          await interaction.guild.channels.fetch(cfg.consoleChannelId).catch(() => null);
      } else {
        targetChannel = interaction.channel;
      }
    }

    if (!targetChannel || !targetChannel.isTextBased()) {
      return interaction.reply({ content: '❌ Target text channel not found.', ephemeral: true });
    }

    const title = interaction.fields.getTextInputValue('embed_title').trim();
    const description = interaction.fields.getTextInputValue('embed_desc').trim();
    const colorInput = interaction.fields.getTextInputValue('embed_color').trim();
    const imageUrl = interaction.fields.getTextInputValue('embed_image').trim();
    const footerText = interaction.fields.getTextInputValue('embed_footer').trim();

    let colorHex = 0x5865f2;
    if (colorInput) {
      const parsed = parseInt(colorInput.replace(/^#/, ''), 16);
      if (!isNaN(parsed)) colorHex = parsed;
    }

    const embed = new EmbedBuilder()
      .setDescription(description)
      .setColor(colorHex)
      .setTimestamp();

    if (title) embed.setTitle(title);
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);
    if (footerText) embed.setFooter({ text: footerText });

    await targetChannel.send({ embeds: [embed] });
    return interaction.reply({ content: `✅ Embed announcement sent to <#${targetChannel.id}>!`, ephemeral: true });
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

    // Create or move Session-logs channel beneath it
    let logChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && (c.name === TEMP_TEXT_CHANNEL_NAME || c.name === LEGACY_LOG_CHANNEL_NAME)
    );
    if (!logChannel) {
      logChannel = await guild.channels.create({
        name: 'Session-logs',
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions], allow: [PermissionFlagsBits.ViewChannel] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
        ]
      });
    } else {
      if (logChannel.name === LEGACY_LOG_CHANNEL_NAME) {
        await logChannel.setName('Session-logs').catch(() => {});
      }
      if (logChannel.parentId !== category.id) {
        await logChannel.setParent(category.id, { lockPermissions: false });
      }
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

    // Owner‑only /channelmsg command
    if (interaction.commandName === 'channelmsg') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/channelmsg`.', ephemeral: true });
      }
      const selectedChannel = interaction.options.getChannel('channel');
      if (!selectedChannel || !selectedChannel.isTextBased()) {
        return interaction.reply({ content: '❌ Please select a valid text channel.', ephemeral: true });
      }
      await setConfig(interaction.guild.id, { consoleChannelId: selectedChannel.id });
      logger.info(`📢 Console message target set to #${selectedChannel.name} (${selectedChannel.id}) in ${interaction.guild.name}`);
      return interaction.reply({
        content: `✅ Console messages are now bound to <#${selectedChannel.id}>!\nType any message (or \`say <message>\`) in your server console to send it there.`,
        ephemeral: true
      });
    }

    // Owner‑only /movechannel command (2 dropdowns: 1st = channel to move, 2nd = after which channel)
    if (interaction.commandName === 'movechannel') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/movechannel`.', ephemeral: true });
      }
      moveChannelState.set(interaction.user.id, { channelToMoveId: null, afterChannelId: null });

      const row1 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('move_select_source')
          .setPlaceholder('1️⃣ Select text channel to move')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('move_select_after')
          .setPlaceholder('2️⃣ Place right after (below) which channel?')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      );

      const embed = new EmbedBuilder()
        .setTitle('🔀 Move Text Channel')
        .setDescription(
          'Select both channels from the dropdowns below; once both are selected, the channel will move automatically:\n\n' +
          '**1️⃣ Channel to Move:** *Not selected*\n' +
          '**2️⃣ Place After (Below):** *Not selected*'
        )
        .setColor(0x5865f2);

      return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
    }

    // Owner‑only /say command
    if (interaction.commandName === 'say') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/say`.', ephemeral: true });
      }
      const msgText = interaction.options.getString('message');
      let targetChannel = interaction.options.getChannel('channel');
      if (!targetChannel) {
        const cfg = await getConfig(interaction.guild.id);
        if (cfg.consoleChannelId) {
          targetChannel = interaction.guild.channels.cache.get(cfg.consoleChannelId) ||
            await interaction.guild.channels.fetch(cfg.consoleChannelId).catch(() => null);
        }
      }
      if (!targetChannel || !targetChannel.isTextBased()) {
        return interaction.reply({
          content: '❌ No target channel specified and no default set. Provide a `channel` option or run `/channelmsg` first.',
          ephemeral: true
        });
      }
      await targetChannel.send({ content: msgText });
      return interaction.reply({ content: `✅ Sent to <#${targetChannel.id}>!`, ephemeral: true });
    }

    // Owner‑only /embed interactive announcement builder
    if (interaction.commandName === 'embed') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/embed`.', ephemeral: true });
      }
      const chosenChannel = interaction.options.getChannel('channel');
      const customId = chosenChannel ? `modal_embed:${chosenChannel.id}` : 'modal_embed';
      const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle('Create Embed Announcement')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('embed_title')
              .setLabel('Title (Optional)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(256)
              .setPlaceholder('e.g. 📢 Server Announcement')
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('embed_desc')
              .setLabel('Message / Description')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(4000)
              .setPlaceholder('Write your announcement content here...')
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('embed_color')
              .setLabel('Hex Color (Optional, default #5865f2)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(7)
              .setPlaceholder('#5865f2 or #00ff00')
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('embed_image')
              .setLabel('Image / Banner URL (Optional)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('https://example.com/banner.png')
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('embed_footer')
              .setLabel('Footer Text (Optional)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(128)
              .setPlaceholder('e.g. KINGDOM Official')
              .setRequired(false)
          )
        );
      return interaction.showModal(modal);
    }

    // Owner‑only /purge bulk message delete
    if (interaction.commandName === 'purge') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/purge`.', ephemeral: true });
      }
      const amount = interaction.options.getInteger('amount');
      if (!amount || amount < 1 || amount > 100) {
        return interaction.reply({ content: '❌ Amount must be between 1 and 100.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const deleted = await interaction.channel.bulkDelete(amount, true).catch(err => {
        logger.error(`Purge error: ${err.message}`);
        return null;
      });
      if (!deleted) {
        return interaction.editReply({ content: '❌ Failed to delete messages (messages older than 14 days cannot be bulk-deleted).' });
      }
      return interaction.editReply({ content: `🧹 Successfully deleted **${deleted.size}** message(s) in <#${interaction.channel.id}>!` });
    }

    // Owner‑only /updatebot (1-click git pull & in-container restart)
    if (interaction.commandName === 'updatebot') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/updatebot`.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const { stdout, stderr } = await execAsync('git pull origin main');
        const output = (stdout || stderr || 'Already up to date.').slice(0, 1800);
        await interaction.editReply({
          content: `🔄 **Git Pull Complete:**\n\`\`\`\n${output}\n\`\`\`\n♻️ Restarting bot now (check **#OpenCodeX** for the online status)...`
        });
        setTimeout(() => restartBotProcess(), 1000);
        return;
      } catch (err) {
        return interaction.editReply({
          content: `❌ **Git Pull Failed:**\n\`\`\`\n${err.message.slice(0, 1800)}\n\`\`\``
        });
      }
    }

    // Public /vcleaderboard
    if (interaction.commandName === 'vcleaderboard') {
      const cfg = await getConfig(interaction.guild.id);
      const vcStats = { ...(cfg.vcStats || {}) };
      // Include live ongoing sessions
      const now = Date.now();
      for (const [key, startMs] of vcSessionJoinTimes.entries()) {
        const [gId, uId] = key.split(':');
        if (gId === interaction.guild.id) {
          vcStats[uId] = (vcStats[uId] || 0) + Math.floor((now - startMs) / 1000);
        }
      }
      const sorted = Object.entries(vcStats)
        .filter(([, sec]) => sec > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      if (sorted.length === 0) {
        return interaction.reply({ content: '📊 No voice channel activity recorded yet!', ephemeral: true });
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = sorted.map(([uId, sec], idx) => {
        const badge = medals[idx] || `**#${idx + 1}**`;
        return `${badge} <@${uId}> — \`${formatDuration(sec)}\``;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏆 ${interaction.guild.name} — Voice Channel Leaderboard`)
        .setDescription(lines.join('\n'))
        .setColor(0xf1c40f)
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // Public /vcstats
    if (interaction.commandName === 'vcstats') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const cfg = await getConfig(interaction.guild.id);
      const vcStats = cfg.vcStats || {};
      let totalSec = vcStats[targetUser.id] || 0;
      const activeKey = `${interaction.guild.id}:${targetUser.id}`;
      if (vcSessionJoinTimes.has(activeKey)) {
        totalSec += Math.floor((Date.now() - vcSessionJoinTimes.get(activeKey)) / 1000);
      }
      const embed = new EmbedBuilder()
        .setTitle('🎙️ Voice Channel Activity')
        .setDescription(`User: <@${targetUser.id}>\nTotal Time in VCs: **\`${formatDuration(totalSec)}\`**`)
        .setColor(0x5865f2)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Owner‑only /autorole
    if (interaction.commandName === 'autorole') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/autorole`.', ephemeral: true });
      }
      const role = interaction.options.getRole('role');
      if (!role) {
        await setConfig(interaction.guild.id, { autoRoleId: null });
        return interaction.reply({ content: '🚫 Auto-role on member join has been **disabled**.', ephemeral: true });
      }
      await setConfig(interaction.guild.id, { autoRoleId: role.id });
      return interaction.reply({ content: `✅ Auto-role set! New members joining the server will automatically receive <@&${role.id}>.`, ephemeral: true });
    }

    // Owner‑only /cleanvirus – wipe compromised user's recent messages across ALL channels
    if (interaction.commandName === 'cleanvirus') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Only the server owner can run `/cleanvirus`.', ephemeral: true });
      }
      const targetUser = interaction.options.getUser('user');
      const punishment = interaction.options.getString('action') || 'timeout';
      await interaction.deferReply();
      const { totalDeleted, channelsCleaned, actionResult } = await wipeUserMessagesAcrossGuild(
        interaction.guild,
        targetUser.id,
        punishment
      );
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Anti-Virus / Cross-Channel Spam Cleanup Complete')
        .setDescription(
          `**Target User:** <@${targetUser.id}> (\`${targetUser.tag}\`)\n` +
          `**Messages Deleted:** \`${totalDeleted}\` across \`${channelsCleaned}\` channel(s)\n` +
          `**Action Taken:** ${actionResult}`
        )
        .setColor(0xe74c3c)
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    const targetVc = getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Join your temporary voice channel first before using this command.', ephemeral: true });
    }

    const vcData = activeVcs.get(targetVc.id);

    // /claim can be used by any member inside the VC if the current owner is no longer in the VC
    if (interaction.commandName === 'claim') {
      const currentOwnerId = vcData?.ownerId;
      if (currentOwnerId && targetVc.members.has(currentOwnerId) && interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: `❌ The current VC owner (<@${currentOwnerId}>) is still inside this channel!`, ephemeral: true });
      }
      if (currentOwnerId) await targetVc.permissionOverwrites.delete(currentOwnerId).catch(() => {});
      await targetVc.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, Connect: true, ManageChannels: true });
      await targetVc.setName(`${interaction.member.displayName}'s VC`).catch(() => {});
      if (vcData) vcData.ownerId = interaction.user.id;
      return interaction.reply({ content: `🙋‍♂️ <@${interaction.user.id}> claimed ownership of <#${targetVc.id}>!` });
    }
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
        const currentlyLocked = Boolean(vcData?.password) || Boolean(everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect));
        if (currentlyLocked) {
          await targetVc.permissionOverwrites.edit(interaction.guildId, {
            Connect: null
          });
          if (vcData) vcData.password = null;
          const ownerMember = await interaction.guild.members.fetch(vcData?.ownerId || interaction.user.id).catch(() => interaction.member);
          const updatedEmbed = createControlEmbed(vcData?.ownerId || interaction.user.id, ownerMember?.displayName || 'Owner', false, false);
          if (vcData?.panelMessageId) {
            const panelMsg = await targetVc.messages.fetch(vcData.panelMessageId).catch(() => null);
            if (panelMsg) await panelMsg.edit({ embeds: [updatedEmbed], components: createControlRows(false, false) }).catch(() => {});
          }
          return interaction.reply({ content: `🔓 <#${targetVc.id}> unlocked (password cleared).`, ephemeral: true });
        }
        const modal = new ModalBuilder()
          .setCustomId(`modal_lock:${targetVc.id}`)
          .setTitle('Lock Voice Channel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('password_input')
                .setLabel('Optional Password (leave blank for none)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(32)
                .setPlaceholder('Leave empty for normal lock, or type a password')
                .setRequired(false)
            )
          );
        return interaction.showModal(modal);
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
        await targetVc.send({ embeds: [createControlEmbed(newOwnerId, newOwner.displayName)], components: createControlRows(Boolean(vcData?.password)) }).catch(() => {});
        return interaction.reply({ content: `👑 Ownership transferred to <@${newOwnerId}>.`, ephemeral: true });
      }
      case 'rename': {
        const newName = interaction.options.getString('name').trim();
        await targetVc.setName(newName);
        return interaction.reply({ content: `✏️ Voice channel renamed to **${newName}**!`, ephemeral: true });
      }
      case 'hide': {
        const everyoneOverwrite = targetVc.permissionOverwrites.cache.get(interaction.guildId);
        const currentlyHidden = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel);
        await targetVc.permissionOverwrites.edit(interaction.guildId, {
          ViewChannel: currentlyHidden ? null : false
        });
        return interaction.reply({
          content: currentlyHidden
            ? `👁️ <#${targetVc.id}> is now **visible** to the server.`
            : `👻 <#${targetVc.id}> is now **hidden (Ghost Mode)**!`,
          ephemeral: true
        });
      }
      case 'muteall': {
        const otherMembers = Array.from(targetVc.members.values()).filter(m => m.id !== interaction.user.id);
        if (otherMembers.length === 0) {
          return interaction.reply({ content: 'ℹ️ No other members inside this VC to mute/unmute.', ephemeral: true });
        }
        const anyUnmuted = otherMembers.some(m => !m.voice.serverMute);
        for (const m of otherMembers) {
          await m.voice.setMute(anyUnmuted).catch(() => {});
        }
        return interaction.reply({
          content: anyUnmuted
            ? `🔇 **Muted all** other members in <#${targetVc.id}>!`
            : `🔊 **Unmuted all** members in <#${targetVc.id}>!`,
          ephemeral: true
        });
      }
    }
  }

  // Button handling
  if (interaction.isButton()) {
    // Anyone can click "🔑 Enter Password" on a password-locked VC (in VC chat, Waiting Room, or DM)
    if (interaction.customId === 'enter_password' || interaction.customId.startsWith('enter_password:')) {
      const explicitVcId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
      let targetVc = null;
      if (explicitVcId) {
        targetVc = client.channels.cache.get(explicitVcId) || await client.channels.fetch(explicitVcId).catch(() => null);
      } else {
        targetVc = interaction.channel?.isVoiceBased?.() ? interaction.channel : getTargetVc();
      }
      if (!targetVc) {
        return interaction.reply({ content: '❌ Voice channel no longer exists.', ephemeral: true });
      }
      const vcData = activeVcs.get(targetVc.id);
      if (!vcData || !vcData.password) {
        return interaction.reply({ content: 'ℹ️ This voice channel does not require a password right now.', ephemeral: true });
      }
      const modal = new ModalBuilder()
        .setCustomId(`modal_enter_password:${targetVc.id}`)
        .setTitle(`Enter Password for ${targetVc.name.slice(0, 25)}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('password_attempt')
              .setLabel('Voice Channel Password')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(32)
              .setPlaceholder('Enter the password...')
              .setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    // Anyone can click "🔔 Request to Join" (Knock) on a locked VC
    if (interaction.customId === 'knock_vc') {
      const targetVc = interaction.channel?.isVoiceBased?.() ? interaction.channel : getTargetVc();
      if (!targetVc) {
        return interaction.reply({ content: '❌ Open the voice channel chat to click this button.', ephemeral: true });
      }
      const vcData = activeVcs.get(targetVc.id);
      const ownerId = vcData?.ownerId || interaction.guild.ownerId;
      const knockRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`knock_accept:${targetVc.id}:${interaction.user.id}`)
          .setLabel('Accept & Allow')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`knock_deny:${targetVc.id}:${interaction.user.id}`)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('✖️')
      );
      await targetVc.send({
        content: `🔔 <@${ownerId}>, **<@${interaction.user.id}>** is knocking and requesting to join <#${targetVc.id}>!`,
        components: [knockRow]
      }).catch(() => {});
      return interaction.reply({ content: `🔔 Knock sent! Waiting for the VC owner to accept your request.`, ephemeral: true });
    }

    // Handle Knock Accept / Deny buttons (VC owner or Server Owner)
    if (interaction.customId.startsWith('knock_accept:') || interaction.customId.startsWith('knock_deny:')) {
      const [actionType, vcId, requesterId] = interaction.customId.split(':');
      const targetVc = interaction.guild.channels.cache.get(vcId) || getTargetVc();
      if (!targetVc) {
        return interaction.reply({ content: '❌ Voice channel no longer exists.', ephemeral: true });
      }
      const vcData = activeVcs.get(targetVc.id);
      const isServerOwner = interaction.user.id === interaction.guild.ownerId;
      const isOwner = isServerOwner || (vcData ? interaction.user.id === vcData.ownerId : targetVc.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ManageChannels));
      if (!isOwner) {
        return interaction.reply({ content: '❌ Only the VC owner or server owner can accept/deny join requests.', ephemeral: true });
      }
      if (actionType === 'knock_accept') {
        if (vcData) {
          if (!vcData.allowedUsers) vcData.allowedUsers = new Set();
          vcData.allowedUsers.add(requesterId);
        }
        await targetVc.permissionOverwrites.edit(requesterId, {
          ViewChannel: true,
          Connect: true
        }).catch(() => {});
        const reqMember = await interaction.guild.members.fetch(requesterId).catch(() => null);
        if (reqMember?.voice?.channelId && reqMember.voice.channelId !== targetVc.id) {
          await reqMember.voice.setChannel(targetVc).catch(() => {});
        }
        return interaction.update({
          content: `✅ Allowed <@${requesterId}> to join <#${targetVc.id}>!`,
          components: []
        });
      } else {
        return interaction.update({
          content: `🚫 Denied join request from <@${requesterId}>.`,
          components: []
        });
      }
    }

    // Anyone inside the VC can click "🙋‍♂️ Claim VC" if the owner left
    if (interaction.customId === 'claim_vc') {
      const targetVc = getTargetVc();
      if (!targetVc) {
        return interaction.reply({ content: '❌ Join the voice channel first to claim it.', ephemeral: true });
      }
      const vcData = activeVcs.get(targetVc.id);
      const currentOwnerId = vcData?.ownerId;
      if (currentOwnerId && targetVc.members.has(currentOwnerId) && interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: `❌ The current VC owner (<@${currentOwnerId}>) is still inside this channel!`, ephemeral: true });
      }
      if (currentOwnerId) await targetVc.permissionOverwrites.delete(currentOwnerId).catch(() => {});
      await targetVc.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, Connect: true, ManageChannels: true });
      await targetVc.setName(`${interaction.member.displayName}'s VC`).catch(() => {});
      if (vcData) vcData.ownerId = interaction.user.id;
      return interaction.reply({ content: `🙋‍♂️ <@${interaction.user.id}> claimed ownership of <#${targetVc.id}>!` });
    }

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
        const currentlyLocked = Boolean(vcData?.password) || Boolean(everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect));
        if (currentlyLocked) {
          await targetVc.permissionOverwrites.edit(interaction.guildId, {
            Connect: null
          });
          if (vcData) vcData.password = null;
          const isHidden = Boolean(targetVc.permissionOverwrites.cache.get(interaction.guildId)?.deny.has(PermissionFlagsBits.ViewChannel));
          const ownerMember = await interaction.guild.members.fetch(vcData?.ownerId || interaction.user.id).catch(() => interaction.member);
          const updatedEmbed = createControlEmbed(vcData?.ownerId || interaction.user.id, ownerMember?.displayName || 'Owner', false, false, isHidden);
          if (interaction.message) {
            await interaction.message.edit({ embeds: [updatedEmbed], components: createControlRows(false, false) }).catch(() => {});
          }
          return interaction.reply({ content: `🔓 <#${targetVc.id}> unlocked (password cleared).`, ephemeral: true });
        }
        const modal = new ModalBuilder()
          .setCustomId(`modal_lock:${targetVc.id}`)
          .setTitle('Lock Voice Channel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('password_input')
                .setLabel('Optional Password (leave blank for none)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(32)
                .setPlaceholder('Leave empty for normal lock, or type a password')
                .setRequired(false)
            )
          );
        return interaction.showModal(modal);
      }
      case 'allow_users': {
        const userSelect = new UserSelectMenuBuilder()
          .setCustomId(`vc_select_allow:${targetVc.id}`)
          .setPlaceholder('Search & select users to allow into this VC...')
          .setMinValues(1)
          .setMaxValues(25);
        return interaction.reply({
          content: '✅ **Select users to whitelist (allow access even when locked):**\n*(Use the search bar or check multiple users below)*',
          components: [new ActionRowBuilder().addComponents(userSelect)],
          ephemeral: true
        });
      }
      case 'rename_vc': {
        const modal = new ModalBuilder()
          .setCustomId(`modal_rename:${targetVc.id}`)
          .setTitle('Rename Voice Channel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('rename_input')
                .setLabel('New Channel Name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(90)
                .setPlaceholder(`e.g. Valorant 5-Stack`)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }
      case 'hide_vc': {
        const everyoneOverwrite = targetVc.permissionOverwrites.cache.get(interaction.guildId);
        const currentlyHidden = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel);
        const currentlyLocked = Boolean(everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect));
        await targetVc.permissionOverwrites.edit(interaction.guildId, {
          ViewChannel: currentlyHidden ? null : false
        });
        const ownerMember = await interaction.guild.members.fetch(vcData?.ownerId || interaction.user.id).catch(() => interaction.member);
        const updatedEmbed = createControlEmbed(vcData?.ownerId || interaction.user.id, ownerMember?.displayName || 'Owner', currentlyLocked, Boolean(vcData?.password), !currentlyHidden);
        if (interaction.message) {
          await interaction.message.edit({ embeds: [updatedEmbed], components: createControlRows(Boolean(vcData?.password), currentlyLocked) }).catch(() => {});
        }
        return interaction.reply({
          content: currentlyHidden
            ? `👁️ <#${targetVc.id}> is now **visible** to the server.`
            : `👻 <#${targetVc.id}> is now **hidden (Ghost Mode)**!`,
          ephemeral: true
        });
      }
      case 'mute_all': {
        const otherMembers = Array.from(targetVc.members.values()).filter(m => m.id !== interaction.user.id);
        if (otherMembers.length === 0) {
          return interaction.reply({ content: 'ℹ️ No other members inside this VC to mute/unmute.', ephemeral: true });
        }
        const anyUnmuted = otherMembers.some(m => !m.voice.serverMute);
        for (const m of otherMembers) {
          await m.voice.setMute(anyUnmuted).catch(() => {});
        }
        return interaction.reply({
          content: anyUnmuted
            ? `🔇 **Muted all** other members in <#${targetVc.id}>!`
            : `🔊 **Unmuted all** members in <#${targetVc.id}>!`,
          ephemeral: true
        });
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
        const isServerOwner = interaction.user.id === interaction.guild.ownerId;
        const currentOwnerId = vcData?.ownerId;
        const eligibleMembers = Array.from(targetVc.members.values()).filter(m => {
          if (isServerOwner) return m.id !== currentOwnerId;
          return m.id !== interaction.user.id;
        });
        const options = eligibleMembers.map(m => ({ label: m.displayName.slice(0, 100), value: m.id }));
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
      const vcData = activeVcs.get(targetVc.id);
      const oldOwnerId = vcData?.ownerId || interaction.user.id;
      await targetVc.permissionOverwrites.delete(oldOwnerId).catch(() => {});
      await targetVc.permissionOverwrites.edit(member.id, { Connect: true, ManageChannels: true });
      await targetVc.setName(`${member.displayName}'s VC`).catch(() => {});
      if (vcData) vcData.ownerId = member.id;
      await targetVc.send({ embeds: [createControlEmbed(member.id, member.displayName)], components: createControlRows(Boolean(vcData?.password)) }).catch(() => {});
      return interaction.followUp({ content: `👑 Ownership transferred to ${member.displayName}.`, ephemeral: true });
    }
  }

  // UserSelectMenu handling for Allow Users (searchable multi-select whitelist)
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_select_allow')) {
    const explicitId = interaction.customId.split(':')[1];
    const targetVc = (explicitId && interaction.guild.channels.cache.get(explicitId)) || getTargetVc();
    if (!targetVc) {
      return interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const vcData = activeVcs.get(targetVc.id);
    const selectedUserIds = interaction.values;
    for (const userId of selectedUserIds) {
      if (vcData) {
        if (!vcData.allowedUsers) vcData.allowedUsers = new Set();
        vcData.allowedUsers.add(userId);
      }
      await targetVc.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        Connect: true
      }).catch(() => {});
    }
    const mentions = selectedUserIds.map(id => `<@${id}>`).join(', ');
    return interaction.followUp({
      content: `✅ Allowed ${mentions} to join <#${targetVc.id}> even while locked!`,
      ephemeral: true
    });
  }

  // ChannelSelectMenu handling for /movechannel
  if (interaction.isChannelSelectMenu() && (interaction.customId === 'move_select_source' || interaction.customId === 'move_select_after')) {
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: '❌ Only the server owner can use this menu.', ephemeral: true });
    }
    const state = moveChannelState.get(interaction.user.id) || { channelToMoveId: null, afterChannelId: null };
    if (interaction.customId === 'move_select_source') {
      state.channelToMoveId = interaction.values[0];
    } else {
      state.afterChannelId = interaction.values[0];
    }
    moveChannelState.set(interaction.user.id, state);

    if (state.channelToMoveId && state.afterChannelId) {
      if (state.channelToMoveId === state.afterChannelId) {
        return interaction.reply({ content: '❌ Please choose two different channels.', ephemeral: true });
      }
      await interaction.deferUpdate();
      const sourceChannel = interaction.guild.channels.cache.get(state.channelToMoveId) ||
        await interaction.guild.channels.fetch(state.channelToMoveId).catch(() => null);
      const afterChannel = interaction.guild.channels.cache.get(state.afterChannelId) ||
        await interaction.guild.channels.fetch(state.afterChannelId).catch(() => null);

      if (!sourceChannel || !afterChannel) {
        return interaction.followUp({ content: '❌ Could not find one of the selected channels.', ephemeral: true });
      }

      // Move into the same category as the reference channel if different
      if (sourceChannel.parentId !== afterChannel.parentId) {
        await sourceChannel.setParent(afterChannel.parentId, { lockPermissions: false });
      }

      // Reorder all text/announcement channels in that category so sourceChannel sits right below afterChannel
      const siblings = Array.from(
        interaction.guild.channels.cache
          .filter(c => c.parentId === afterChannel.parentId && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.id !== sourceChannel.id)
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .values()
      );

      const afterIndex = siblings.findIndex(c => c.id === afterChannel.id);
      siblings.splice(afterIndex + 1, 0, sourceChannel);

      await interaction.guild.channels.setPositions(
        siblings.map((ch, idx) => ({ channel: ch.id, position: idx }))
      );

      moveChannelState.delete(interaction.user.id);

      const doneEmbed = new EmbedBuilder()
        .setTitle('✅ Channel Moved')
        .setDescription(`Moved <#${sourceChannel.id}> right below <#${afterChannel.id}>!`)
        .setColor(0x00ff00);

      return interaction.editReply({ embeds: [doneEmbed], components: [] });
    } else {
      const updatedEmbed = new EmbedBuilder()
        .setTitle('🔀 Move Text Channel')
        .setDescription(
          'Select both channels from the dropdowns below; once both are selected, the channel will move automatically:\n\n' +
          `**1️⃣ Channel to Move:** ${state.channelToMoveId ? `<#${state.channelToMoveId}>` : '*Not selected*'}\n` +
          `**2️⃣ Place After (Below):** ${state.afterChannelId ? `<#${state.afterChannelId}>` : '*Not selected*'}`
        )
        .setColor(0x5865f2);
      return interaction.update({ embeds: [updatedEmbed] });
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
// Message handler:
// 1. Automatic Cross-Channel Virus/Flood Detector
// 2. #OpenCodeX Owner Commands:
//    - cleanvirus <@user or userId> [timeout|kick|ban|none]
//    - say <#channel or channel-name> <message>
//    - say <message> (uses /channelmsg default channel)
// -------------------------------------------------
client.on('messageCreate', async message => {
  try {
    if (!message.inGuild() || message.author.bot) return;

    // 1. Auto-detect virus cross-channel flooding (same message posted in 3+ channels within 15 seconds)
    if (message.author.id !== message.guild.ownerId && message.content.trim().length > 4) {
      const normalized = message.content.trim().toLowerCase();
      const now = Date.now();
      const trackerKey = `${message.guild.id}:${message.author.id}`;
      const prev = spamTracker.get(trackerKey);

      if (prev && prev.text === normalized && now - prev.firstTs < 15000) {
        prev.channels.add(message.channel.id);
        if (prev.channels.size >= 3 && !prev.triggered) {
          prev.triggered = true;
          logger.warn(`🚨 Auto-detected cross-channel virus flood from ${message.author.tag} in ${message.guild.name}`);
          const { totalDeleted, channelsCleaned, actionResult } = await wipeUserMessagesAcrossGuild(
            message.guild,
            message.author.id,
            'timeout'
          );
          const openChannel = message.guild.channels.cache.find(
            c => c.type === ChannelType.GuildText && c.name.toLowerCase() === OPEN_CODEX_CHANNEL_NAME
          );
          const alertEmbed = new EmbedBuilder()
            .setTitle('🚨 Auto Anti-Virus Flood Protection Triggered!')
            .setDescription(
              `**User:** <@${message.author.id}> (\`${message.author.tag}\`) flooded the same message across **${prev.channels.size}+ channels**.\n` +
              `**Cleaned:** Deleted \`${totalDeleted}\` message(s) across \`${channelsCleaned}\` channel(s).\n` +
              `**Action:** ${actionResult}`
            )
            .setColor(0xe74c3c)
            .setTimestamp();
          if (openChannel) await openChannel.send({ content: `<@${message.guild.ownerId}>`, embeds: [alertEmbed] }).catch(() => {});
          return;
        }
      } else {
        spamTracker.set(trackerKey, {
          text: normalized,
          channels: new Set([message.channel.id]),
          firstTs: now,
          triggered: false
        });
      }
    }

    // 2. Owner commands inside #OpenCodeX
    if (message.author.id !== message.guild.ownerId) return;
    if (message.channel.name.toLowerCase() !== OPEN_CODEX_CHANNEL_NAME) return;

    const raw = message.content.trim();

    // Command: cleanvirus <@user or userId> [timeout|kick|ban|none]
    if (/^(cleanvirus|virusclean|nukespam)\s+/i.test(raw)) {
      const args = raw.replace(/^(cleanvirus|virusclean|nukespam)\s+/i, '').trim().split(/\s+/);
      const userToken = args[0] || '';
      const actionArg = (args[1] || 'timeout').toLowerCase();
      const userIdMatch = userToken.match(/^<@!?(\d+)>$/) || userToken.match(/^(\d{17,20})$/);
      if (!userIdMatch) {
        await message.reply('❌ Usage: `cleanvirus @user [timeout|kick|ban|none]` o kaya `/cleanvirus`');
        return;
      }
      const targetUserId = userIdMatch[1];
      const validAction = ['timeout', 'kick', 'ban', 'none'].includes(actionArg) ? actionArg : 'timeout';
      const statusMsg = await message.reply(`🧹 Scanning all channels and wiping spam messages from <@${targetUserId}>...`);
      const { totalDeleted, channelsCleaned, actionResult } = await wipeUserMessagesAcrossGuild(
        message.guild,
        targetUserId,
        validAction
      );
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Anti-Virus / Cross-Channel Spam Cleanup Complete')
        .setDescription(
          `**Target User:** <@${targetUserId}>\n` +
          `**Messages Deleted:** \`${totalDeleted}\` across \`${channelsCleaned}\` channel(s)\n` +
          `**Action Taken:** ${actionResult}`
        )
        .setColor(0xe74c3c)
        .setTimestamp();
      await statusMsg.edit({ content: null, embeds: [embed] }).catch(() => {});
      return;
    }

    if (!/^say\s+/i.test(raw)) return;

    const restText = raw.replace(/^say\s+/i, '').trim();
    if (!restText) return;

    const firstSpaceIdx = restText.indexOf(' ');
    const firstToken = firstSpaceIdx === -1 ? restText : restText.slice(0, firstSpaceIdx);
    const afterFirstToken = firstSpaceIdx === -1 ? '' : restText.slice(firstSpaceIdx + 1).trim();

    let targetChannel = null;
    let finalMessage = restText;

    // Check if first token is a <#channelId> mention, raw channel ID, or exact channel name
    const mentionMatch = firstToken.match(/^<#(\d+)>$/) || firstToken.match(/^(\d{17,20})$/);
    if (mentionMatch && afterFirstToken) {
      const chId = mentionMatch[1];
      targetChannel = message.guild.channels.cache.get(chId) ||
        await message.guild.channels.fetch(chId).catch(() => null);
      if (targetChannel) {
        finalMessage = afterFirstToken;
      }
    } else if (afterFirstToken) {
      const cleanName = firstToken.replace(/^#/, '').toLowerCase();
      const byName = message.guild.channels.cache.find(
        c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === cleanName
      );
      if (byName) {
        targetChannel = byName;
        finalMessage = afterFirstToken;
      }
    }

    // Fallback to /channelmsg configured channel
    if (!targetChannel) {
      const cfg = await getConfig(message.guild.id);
      if (cfg.consoleChannelId) {
        targetChannel = message.guild.channels.cache.get(cfg.consoleChannelId) ||
          await message.guild.channels.fetch(cfg.consoleChannelId).catch(() => null);
      }
    }

    if (!targetChannel || !targetChannel.isTextBased()) {
      await message.reply('❌ Walang target channel! Gamitin ang `say #channel <message>` o mag-set muna ng default gamit ang `/channelmsg`.');
      return;
    }

    await targetChannel.send({ content: finalMessage });
    await message.react('✅').catch(() => {});
  } catch (err) {
    logger.error(`OpenCodeX say error: ${err.message}`);
  }
});

// -------------------------------------------------
// Console Input Handler – send messages to /channelmsg target
// -------------------------------------------------
process.stdin.resume();
process.stdin.setEncoding('utf8');

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('error', err => {
  logger.error(`Console input error: ${err.message}`);
});

rl.on('line', async line => {
  const input = line.trim();
  if (!input) return;

  // Strip optional "say " or "msg " prefix if the user types it
  const messageContent = input.replace(/^(say|msg)\s+/i, '').trim();
  if (!messageContent) return;

  let sentCount = 0;
  for (const guild of client.guilds.cache.values()) {
    let targetChannel = null;
    let finalMsg = messageContent;

    const spIdx = messageContent.indexOf(' ');
    const tok1 = spIdx === -1 ? '' : messageContent.slice(0, spIdx);
    const afterTok1 = spIdx === -1 ? '' : messageContent.slice(spIdx + 1).trim();

    if (tok1 && afterTok1) {
      const cleanName = tok1.replace(/^[#<]|>$/g, '').toLowerCase();
      targetChannel = guild.channels.cache.get(cleanName) ||
        guild.channels.cache.find(
          c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === cleanName
        );
      if (targetChannel) {
        finalMsg = afterTok1;
      }
    }

    if (!targetChannel) {
      const cfg = await getConfig(guild.id);
      if (cfg.consoleChannelId) {
        targetChannel = guild.channels.cache.get(cfg.consoleChannelId) ||
          await guild.channels.fetch(cfg.consoleChannelId).catch(() => null);
      }
    }

    if (targetChannel && targetChannel.isTextBased()) {
      try {
        await targetChannel.send({ content: finalMsg });
        logger.info(`💬 [Console -> #${targetChannel.name}]: ${finalMsg}`);
        sentCount++;
      } catch (err) {
        logger.error(`❌ Failed sending console message to #${targetChannel.name}: ${err.message}`);
      }
    }
  }

  if (sentCount === 0) {
    logger.warn('⚠️ No target channel configured yet. Use /channelmsg in your Discord server first.');
  }
});

// -------------------------------------------------
// Graceful shutdown & In-Container Hot Restart (/updatebot)
// -------------------------------------------------
async function restartBotProcess() {
  logger.info('♻️ Restarting bot process in-place after update...');
  try {
    rl.close();
    process.stdin.pause();
  } catch (_) {}
  try {
    await client.destroy();
  } catch (_) {}

  // If already running as a spawned child worker, exit with code 75 so parent supervisor respawns us
  if (process.env.IS_RESTARTED_CHILD === '1') {
    process.exit(75);
    return;
  }

  // Otherwise, this is PID 1 (main container process on bot-hosting.net):
  // Keep PID 1 alive so the Docker container never stops, and supervise the new child process!
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  const spawnWorker = () => {
    logger.info('🚀 Spawning updated bot instance...');
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, IS_RESTARTED_CHILD: '1' }
    });

    const forwardSignal = sig => {
      if (!child.killed) child.kill(sig);
    };
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);

    child.on('exit', code => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      if (code === 75) {
        logger.info('♻️ Update requested by child process, respawning...');
        setTimeout(spawnWorker, 500);
      } else {
        process.exit(code ?? 0);
      }
    });
  };

  spawnWorker();
}

async function handleShutdown(signal) {
  logger.info(`🛑 Received ${signal}, shutting down and cleaning up temp VCs...`);
  for (const guild of client.guilds.cache.values()) {
    const openChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name.toLowerCase() === OPEN_CODEX_CHANNEL_NAME
    );
    if (openChannel) {
      const offEmbed = new EmbedBuilder()
        .setTitle('🔴 Bot Disconnecting / Restarting...')
        .setDescription(`**${client.user?.tag || 'Bot'}** is shutting down or restarting.`)
        .setColor(0xe74c3c);
      await openChannel.send({ embeds: [offEmbed] }).catch(() => {});
    }
  }
  for (const [vcId] of activeVcs) {
    const channel = client.channels.cache.get(vcId);
    if (channel) await channel.delete().catch(() => {});
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

client.login(TOKEN);
