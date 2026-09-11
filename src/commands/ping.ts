import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Replies with Pong! and the current latency");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply("Pinging...");
  const roundtrip = Date.now() - interaction.createdTimestamp;

  await interaction.editReply(
    `Pong! Roundtrip: ${roundtrip}ms · WebSocket: ${interaction.client.ws.ping}ms`,
  );
}
