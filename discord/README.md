# Scotty Discord bot

This is the smallest Discord interface for existing Scotty sessions:

1. Run `/scotty sessions` in a guild text channel.
2. Pick a warm session.
3. Continue the Pican conversation in the created `scotty-…` thread.

The bot does not create, resume, or delete Scotty sessions.

## Setup

Create a Discord application and bot, enable the **Message Content** intent, and give the bot
permission to view the target channel, send messages, create public threads, send messages in
threads, and manage threads.

Treat access to the configured channel as access to Scotty: the bot will show session transcripts
and accept prompts only in that guild and channel. Run one bot process for this MVP.

Set a dedicated Worker secret. Do not reuse `SCOTTY_TOKEN`.

```sh
npx wrangler secret put SCOTTY_DISCORD_TOKEN --name scotty-worker
```

Run the bot with the same value:

```sh
export DISCORD_TOKEN=...
export DISCORD_APPLICATION_ID=...
export DISCORD_GUILD_ID=...
export DISCORD_CHANNEL_ID=...
export SCOTTY_URL=https://your-scotty-worker.example
export SCOTTY_DISCORD_TOKEN=...
npm run start --workspace @scotty/discord
```

The slash command is registered in `DISCORD_GUILD_ID` at startup, so it is available without a
global-command propagation delay.
