import {
  ActionRowBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  type Message,
  type StringSelectMenuInteraction,
} from "discord.js";
import { isConfiguredDiscordLocation, parseThreadName, threadName, truncate } from "./helpers.ts";
import { ScottyApi, type SessionSnapshot, type WarmSession } from "./scotty-api.ts";

const SELECT_CUSTOM_ID = "scotty-session";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

const command = new SlashCommandBuilder()
  .setName("scotty")
  .setDescription("Work with Scotty sessions")
  .addSubcommand((subcommand) =>
    subcommand.setName("sessions").setDescription("List warm Scotty sessions"),
  );

interface BotEnvironment {
  readonly discordToken: string;
  readonly applicationId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly scottyUrl: string;
  readonly scottyToken: string;
}

type EnvironmentResult =
  | { readonly ok: true; readonly value: BotEnvironment }
  | { readonly ok: false; readonly message: string };

function readEnvironment(environment: NodeJS.ProcessEnv): EnvironmentResult {
  const names = [
    "DISCORD_TOKEN",
    "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID",
    "DISCORD_CHANNEL_ID",
    "SCOTTY_URL",
    "SCOTTY_DISCORD_TOKEN",
  ] as const;
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Missing required environment variables: ${missing.join(", ")}`,
    };
  }
  return {
    ok: true,
    value: {
      discordToken: environment.DISCORD_TOKEN ?? "",
      applicationId: environment.DISCORD_APPLICATION_ID ?? "",
      guildId: environment.DISCORD_GUILD_ID ?? "",
      channelId: environment.DISCORD_CHANNEL_ID ?? "",
      scottyUrl: environment.SCOTTY_URL ?? "",
      scottyToken: environment.SCOTTY_DISCORD_TOKEN ?? "",
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transcriptText(snapshot: SessionSnapshot): string {
  const recent = snapshot.messages.slice(-10);
  if (recent.length === 0) {
    return "_No recent messages._";
  }
  return recent
    .map((message) => `**${message.role === "assistant" ? "Scotty" : "User"}:** ${message.text}`)
    .join("\n\n");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function discordContent(content: string) {
  return { content, allowedMentions: { parse: [] } };
}

async function registerCommand(environment: BotEnvironment): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(environment.discordToken);
  await rest.put(Routes.applicationGuildCommands(environment.applicationId, environment.guildId), {
    body: [command.toJSON()],
  });
}

async function handleSessionsCommand(
  interaction: ChatInputCommandInteraction,
  api: ScottyApi,
  environment: BotEnvironment,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  if (
    !isConfiguredDiscordLocation(
      interaction.guildId,
      interaction.channelId,
      environment.guildId,
      environment.channelId,
    )
  ) {
    await interaction.editReply("Use Scotty from its configured Discord channel.");
    return;
  }
  const sessions = (await api.listSessions())
    .filter((session) => session.id.length <= 100)
    .slice(0, 25);
  if (sessions.length === 0) {
    await interaction.editReply("No warm Scotty sessions are available.");
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_CUSTOM_ID)
    .setPlaceholder("Choose a Scotty session")
    .addOptions(
      sessions.map((session) => ({
        label: truncate(`${session.repo} · ${session.branch}`, 100),
        description: truncate(`Updated ${session.updatedAt}`, 100),
        value: session.id,
      })),
    );
  await interaction.editReply({
    content: "Choose a warm session:",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

async function findOrCreateThread(
  interaction: StringSelectMenuInteraction,
  session: WarmSession,
  environment: BotEnvironment,
): Promise<AnyThreadChannel> {
  const channel = interaction.channel;
  if (
    channel?.type !== ChannelType.GuildText ||
    !interaction.guild ||
    !isConfiguredDiscordLocation(
      interaction.guildId,
      channel.id,
      environment.guildId,
      environment.channelId,
    )
  ) {
    throw new Error("Select a Scotty session from a guild text channel");
  }
  const name = threadName(session.id);
  const active = await interaction.guild.channels.fetchActiveThreads();
  const existing = active.threads.find(
    (thread) => thread.parentId === channel.id && thread.name === name,
  );
  if (existing) {
    return existing;
  }
  return channel.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    reason: `Scotty session ${session.id}`,
  });
}

async function handleSessionSelect(
  interaction: StringSelectMenuInteraction,
  api: ScottyApi,
  threadSessions: Map<string, string>,
  environment: BotEnvironment,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  if (
    !isConfiguredDiscordLocation(
      interaction.guildId,
      interaction.channelId,
      environment.guildId,
      environment.channelId,
    )
  ) {
    await interaction.editReply("Use Scotty from its configured Discord channel.");
    return;
  }
  const sessionId = interaction.values[0];
  if (!sessionId) {
    await interaction.editReply("No session was selected.");
    return;
  }
  const sessions = await api.listSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    await interaction.editReply("That Scotty session is no longer warm.");
    return;
  }
  const [thread, snapshot] = await Promise.all([
    findOrCreateThread(interaction, session, environment),
    api.getSession(session.id),
  ]);
  threadSessions.set(thread.id, session.id);
  await thread.members.add(interaction.user.id);
  const header = `Scotty session for **${session.repo}** on \`${session.branch}\`\n${snapshot.session.url}`;
  await thread.send(discordContent(truncate(`${header}\n\n${transcriptText(snapshot)}`, 2_000)));
  await interaction.editReply(`Continue in <#${thread.id}>.`);
}

async function resolveThreadSession(
  message: Message,
  api: ScottyApi,
  threadSessions: Map<string, string>,
): Promise<string | undefined> {
  if (!message.channel.isThread()) {
    return undefined;
  }
  const known = threadSessions.get(message.channel.id);
  if (known) {
    return known;
  }
  const fragment = parseThreadName(message.channel.name);
  if (!fragment) {
    return undefined;
  }
  const matches = (await api.listSessions()).filter(
    (session) => session.id.slice(0, 12) === fragment,
  );
  if (matches.length !== 1) {
    return undefined;
  }
  const sessionId = matches[0]?.id;
  if (sessionId) {
    threadSessions.set(message.channel.id, sessionId);
  }
  return sessionId;
}

async function waitForAssistant(
  api: ScottyApi,
  sessionId: string,
  previousAssistantIds: ReadonlySet<string>,
): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let sawRunning = false;
  let idleChecks = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await api.isRunning(sessionId)) {
      sawRunning = true;
      idleChecks = 0;
      continue;
    }
    idleChecks += 1;
    if (!sawRunning && idleChecks < 2) continue;
    const snapshot = await api.getSession(sessionId);
    const response = snapshot.messages.findLast(
      (entry) => entry.role === "assistant" && !previousAssistantIds.has(entry.id),
    );
    if (response) return response.text;
    return "Scotty stopped without a new response. Open the Pican link above to inspect the session.";
  }
  return "Scotty timed out after 5 minutes. Send another message to check the session.";
}

async function handleThreadMessage(
  message: Message,
  api: ScottyApi,
  busySessions: Set<string>,
  threadSessions: Map<string, string>,
  environment: BotEnvironment,
): Promise<void> {
  if (
    message.author.bot ||
    !message.channel.isThread() ||
    !parseThreadName(message.channel.name) ||
    !isConfiguredDiscordLocation(
      message.guildId,
      message.channel.parentId,
      environment.guildId,
      environment.channelId,
    )
  ) {
    return;
  }
  const content = message.content.trim();
  if (!content) return;
  const sessionId = await resolveThreadSession(message, api, threadSessions);
  if (!sessionId) return;
  if (busySessions.has(sessionId)) {
    await message.reply(discordContent("Scotty is already working in this session."));
    return;
  }
  busySessions.add(sessionId);
  let working: Message | undefined;
  try {
    const before = await api.getSession(sessionId);
    if (before.running) {
      await message.reply(discordContent("Scotty is already working in this session."));
      return;
    }
    const previousAssistantIds = new Set(
      before.messages.filter((entry) => entry.role === "assistant").map((entry) => entry.id),
    );
    await api.sendMessage(sessionId, content);
    working = await message.reply(discordContent("Working…"));
    const response = await waitForAssistant(api, sessionId, previousAssistantIds);
    await working.edit(discordContent(truncate(response, 2_000)));
  } catch (error) {
    const failure = truncate(`Scotty request failed: ${errorText(error)}`, 2_000);
    if (working) {
      await working.edit(discordContent(failure));
    } else {
      await message.reply(discordContent(failure));
    }
  } finally {
    busySessions.delete(sessionId);
  }
}

async function main(environment: BotEnvironment): Promise<void> {
  const api = new ScottyApi(environment.scottyUrl, environment.scottyToken);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const busySessions = new Set<string>();
  const threadSessions = new Map<string, string>();

  client.on(Events.InteractionCreate, (interaction) => {
    let operation: Promise<void> | undefined;
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "scotty" &&
      interaction.options.getSubcommand() === "sessions"
    ) {
      operation = handleSessionsCommand(interaction, api, environment);
    } else if (interaction.isStringSelectMenu() && interaction.customId === SELECT_CUSTOM_ID) {
      operation = handleSessionSelect(interaction, api, threadSessions, environment);
    }
    void operation?.then(undefined, async (error: unknown) => {
      console.error(errorText(error));
      if (interaction.isRepliable()) {
        const content = truncate(`Scotty request failed: ${errorText(error)}`, 2_000);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(discordContent(content));
        } else {
          await interaction.reply({ ...discordContent(content), ephemeral: true });
        }
      }
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleThreadMessage(message, api, busySessions, threadSessions, environment).then(
      undefined,
      (error) => {
        console.error(errorText(error));
      },
    );
  });

  await registerCommand(environment);
  await client.login(environment.discordToken);
}

const environment = readEnvironment(process.env);
if (!environment.ok) {
  console.error(environment.message);
  process.exitCode = 1;
} else {
  void main(environment.value).then(undefined, (error) => {
    console.error(`Discord bot failed to start: ${errorText(error)}`);
    process.exitCode = 1;
  });
}
