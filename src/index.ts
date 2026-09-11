import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import * as ping from "./commands/ping.ts";
import * as ask from "./commands/ask.ts";
import * as fetchBook from "./commands/fetch.ts";

const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
if (!token) {
  throw new Error("Missing DISCORD_TOKEN (or TOKEN) in environment (.env)");
}

type Command = {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
};

const commands = new Collection<string, Command>();
commands.set(ping.data.name, ping);
commands.set(ask.data.name, ask);
commands.set(fetchBook.data.name, fetchBook);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error(`Error in autocomplete for ${interaction.commandName}:`, error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) {
    console.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing ${interaction.commandName}:`, error);
    const reply = { content: "There was an error executing this command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(token);
