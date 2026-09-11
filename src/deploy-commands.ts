import { REST, Routes } from "discord.js";
import * as ping from "./commands/ping.ts";
import * as ask from "./commands/ask.ts";
import * as fetchBook from "./commands/fetch.ts";

const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
const clientId = process.env.CLIENT_ID ?? process.env.CLIENTID;
const guildId = process.env.GUILD_ID ?? process.env.GUILDID;

if (!token) throw new Error("Missing DISCORD_TOKEN (or TOKEN) in environment (.env)");
if (!clientId) throw new Error("Missing CLIENT_ID (or CLIENTID) in environment (.env)");

const commands = [ping.data.toJSON(), ask.data.toJSON(), fetchBook.data.toJSON()];

const rest = new REST().setToken(token);

try {
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  console.log(
    `Deploying ${commands.length} command(s) ${guildId ? `to guild ${guildId}` : "globally"}...`,
  );

  await rest.put(route, { body: commands });

  console.log("Successfully deployed commands.");
} catch (error) {
  console.error(error);
}
