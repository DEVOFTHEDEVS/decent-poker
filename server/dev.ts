import { PokerServer } from "./server";
import { BOT_ROSTER } from "../lib/engine/bot";
import { TABLE_CONFIGS } from "../lib/engine/types";

const WS_PORT = parseInt(process.env.WS_PORT || "3001");
const server = new PokerServer(WS_PORT);

console.log(`
╔══════════════════════════════════════════╗
║   $ALLIN Poker — Dev Server              ║
║   WS:   ws://localhost:${WS_PORT}              ║
║   Mode: Dev (no on-chain verification)   ║
╚══════════════════════════════════════════╝
`);

// Bypass on-chain verification in dev
server.onVerifyBuyIn = async (sig, wallet, tableId, lamports) => {
  console.log(`[BUY-IN] ${wallet.slice(0, 12)} → ${tableId} (${(lamports / 1e9).toFixed(3)} SOL)`);
  return true;
};

server.onCashOut = async (wallet, chips, tableId) => {
  const solPaid = chips / 1e9;
  console.log(`[CASHOUT] ${wallet.slice(0, 12)} ← ${solPaid.toFixed(4)} SOL from ${tableId}`);
  return { solPaid, signature: `dev_cashout_${Date.now()}` };
};

server.onHandComplete = async (result, tableId) => {
  const winners = result.winners.map((w: any) => `${w.name} +${(w.amount/1e9).toFixed(4)} SOL`).join(", ");
  console.log(`[HAND] ${tableId} → ${winners}`);
};

// Spawn bots on each table after a short delay
setTimeout(() => {
  TABLE_CONFIGS.forEach((cfg, tableIdx) => {
    const table = server.getTable(cfg.id);
    if (!table) return;

    // 3 bots per table, rotating through the roster
    const botsForTable = 3;
    for (let i = 0; i < botsForTable; i++) {
      const bot = BOT_ROSTER[(tableIdx * botsForTable + i) % BOT_ROSTER.length];
      const botId = `bot_${cfg.id}_${i}`;
      const chips = cfg.minBuyIn * (2 + Math.floor(Math.random() * 4)); // 2-5x min buy-in
      const ok = table.sitDownBot(botId, bot.name, chips, bot.personality);
      if (ok) console.log(`[BOT] ${bot.name} (${bot.personality}) joined ${cfg.name}`);
    }
  });
  console.log("[BOT] All bots seated — open http://localhost:3000 to play!\n");
}, 1500);

process.on("SIGINT", () => {
  console.log("\n[WS] Shutting down…");
  server.close();
  process.exit(0);
});
