# dc-openCodeX-bot

OpenCodeX temporary voice channel management Discord bot.

## Features

- **Join to Create:** Automatically creates temporary, user-owned voice channels when members join the generator channel.
- **In-Channel Management:** Interactive button panel in the voice channel chat:
  - 🔒 Toggle Lock (private / public)
  - 👥 Set user limits (0 for unlimited)
  - 📥 Generate 1-use invite links
  - ❌ Kick users
  - 🚫 Ban users from rejoining and disconnect active occupants
  - 👑 Transfer ownership
- **Auto Cleanup & Logging:** Deletes channels when empty and logs session stats to `#bot-logs`.
- **Zero-Bloat:** Built with `discord.js` and Node.js standard runtime.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your environment:
   Create a `.env` file in the root directory:
   ```env
   TOKEN=your_discord_bot_token_here
   ```

3. Start the bot:
   ```bash
   npm start
   ```
