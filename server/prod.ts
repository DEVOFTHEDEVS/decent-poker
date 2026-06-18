import { PokerServer } from "./server";
import { BOT_ROSTER } from "../lib/engine/bot";
import { TABLE_CONFIGS } from "../lib/engine/types";

// Railway assigns PORT dynamically — must use it or connections fail
const WS_PORT = parseInt(process.env.PORT || "3001");
const server = new PokerServer(WS_PORT);

console.log(`DECENT POKER production server running on port ${WS_PORT}`);

server.onVerifyBuyIn = async (sig, wallet, tableId, lamports) => {
  console.log(`[BUY-IN] ${wallet.slice(0, 12)} → ${tableId} (${(lamports / 1e9).toFixed(3)} SOL)`);
  return true;
};

server.onCashOut = async (wallet, chips, tableId) => {
  const solPaid = chips / 1e9;
  console.log(`[CASHOUT] ${wallet.slice(0, 12)} ← ${solPaid.toFixed(4)} SOL from ${tableId}`);
  return { solPaid, signature: `cashout_${Date.now()}` };
};

server.onHandComplete = async (result, tableId) => {
  const winners = result.winners.map((w: any) => `${w.name} +${(w.amount/1e9).toFixed(4)} SOL`).join(", ");
  console.log(`[HAND] ${tableId} → ${winners}`);
};

setTimeout(() => {
  TABLE_CONFIGS.forEach((cfg, tableIdx) => {
    const table = server.getTable(cfg.id);
    if (!table) return;
    for (let i = 0; i < 3; i++) {
      const bot = BOT_ROSTER[(tableIdx * 3 + i) % BOT_ROSTER.length];
      const botId = `bot_${cfg.id}_${i}`;
      const chips = cfg.minBuyIn * (2 + Math.floor(Math.random() * 4));
      table.sitDownBot(botId, bot.name, chips, bot.personality);
    }
    console.log(`[BOT] 3 bots seated at ${cfg.name}`);
  });
}, 2000);

// Keep-alive ping every 4 minutes to prevent Railway from sleeping
const KEEPALIVE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : "https://decent-poker-production.up.railway.app";

setInterval(async () => {
  try {
    const r = await fetch(KEEPALIVE_URL);
    console.log("[KEEPALIVE] ping", r.status);
  } catch(e) {
    console.log("[KEEPALIVE] failed", (e as any)?.message);
  }
}, 4 * 60 * 1000);

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT",  () => { server.close(); process.exit(0); });
