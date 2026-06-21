/**
 * WebSocket Game Server
 *
 * Wraps PokerTable instances and manages WebSocket connections.
 * Each connected client gets real-time state pushes instead of polling.
 *
 * Message flow:
 *   Client connects → ws://host/ws
 *   Client sends:  { type: "join", tableId, lamports, signature, name, playerSeed }
 *   Server pushes: { type: "state", table: ClientTableState } on every change
 */

import WebSocketLib from "ws";
const { WebSocketServer, WebSocket } = WebSocketLib;
import { IncomingMessage } from "http";
import { PokerTable } from "../lib/engine/table";
import { TABLE_CONFIGS } from "../lib/engine/types";
import type { ClientMessage, ServerMessage, HandResult } from "../lib/engine/types";

interface ConnectedClient {
  ws: WebSocket;
  playerId: string | null;  // wallet pubkey once identified
  tableId: string | null;
  isSpectator: boolean;
  connectedAt: number;
  lastPing: number;
}

export class PokerServer {
  private wss: WebSocketServer;
  private tables: Map<string, PokerTable>;
  private clients: Map<WebSocket, ConnectedClient>;
  private dynamicRooms: Map<string, { tableId: string; createdAt: number; startingChips: number; currency: string }>; // roomId → tableId
  private disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // playerId → timer
  private pingInterval: ReturnType<typeof setInterval>;

  // Injected dependencies
  onVerifyBuyIn?: (sig: string, walletAddress: string, tableId: string, lamports: number) => Promise<boolean>;
  onCashOut?: (walletAddress: string, chips: number, tableId: string) => Promise<{ signature?: string; solPaid: number }>;
  onHandComplete?: (result: HandResult, tableId: string) => Promise<void>;

  constructor(port: number) {
    this.tables = new Map();
    this.clients = new Map();
    this.dynamicRooms = new Map();
    this.disconnectTimers = new Map();
    this.startWatchdog();

    // Initialize tables
    for (const cfg of TABLE_CONFIGS) {
      const table = new PokerTable(cfg);
      table.onStateChange = (t) => this.broadcastTableState(t);
      table.onHandComplete = (result, tableId) => {
        if (this.onHandComplete) this.onHandComplete(result, tableId).catch(console.error);
      };
      this.tables.set(cfg.id, table);
    }

    // Create HTTP server so Railway healthcheck passes and WS upgrades work
    const http = require("http");
    const httpServer = http.createServer((_req: any, res: any) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Decent Poker WS Server OK");
    });
    this.wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(port);
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    // Heartbeat to detect dead connections
    this.pingInterval = setInterval(() => this.heartbeat(), 30_000);

    console.log(`[WS] Poker server listening on ws://localhost:${port}`);
  }

  // ── Connection Lifecycle ────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: ConnectedClient = {
      ws,
      playerId: null,
      tableId: null,
      isSpectator: false,
      connectedAt: Date.now(),
      lastPing: Date.now(),
    };
    this.clients.set(ws, client);

    ws.on("message", (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        this.handleMessage(client, msg);
      } catch (e) {
        this.send(ws, { type: "error", message: "Invalid message format" });
      }
    });

    ws.on("close", () => this.handleDisconnect(client));
    ws.on("error", (err) => {
      console.error("[WS] Client error:", err.message);
      this.handleDisconnect(client);
    });

    // Send lobby on connect
    this.sendLobby(ws);
  }

  private handleDisconnect(client: ConnectedClient): void {
    this.clients.delete(client.ws);

    if (client.tableId && client.playerId && !client.isSpectator) {
      const playerId = client.playerId;
      const tableId = client.tableId;

      // Grace period: keep player seated for 60s so they can reconnect
      // If they reconnect within 60s, cancel the timer
      const timer = setTimeout(() => {
        this.disconnectTimers.delete(playerId);
        const table = this.tables.get(tableId);
        if (table) {
          // Only remove if they haven't reconnected (no active client with this playerId)
          const stillConnected = Array.from(this.clients.values()).some(c => c.playerId === playerId);
          if (!stillConnected) {
            console.log(`[DISCONNECT] Removing ${playerId} from ${tableId} after grace period`);
            const chips = table.leave(playerId);
            if (chips > 0 && this.onCashOut) {
              this.onCashOut(playerId, chips, tableId).catch(console.error);
            }
          }
        }
      }, 60_000); // 60 second grace period

      this.disconnectTimers.set(playerId, timer);
      console.log(`[DISCONNECT] ${playerId} disconnected — waiting 60s for reconnect`);
    }
  }

  // ── Message Handling ────────────────────────────────────────────────────────

  private async handleMessage(client: ConnectedClient, msg: ClientMessage): Promise<void> {
    switch (msg.type) {

      case "ping":
        client.lastPing = Date.now();
        this.send(client.ws, { type: "pong" });
        break;

      case "lobby":
        this.sendLobby(client.ws);
        break;

      case "watch": {
        const table = this.tables.get(msg.tableId);
        if (!table) { this.send(client.ws, { type: "error", message: "Table not found" }); return; }
        client.tableId = msg.tableId;
        client.isSpectator = true;
        this.send(client.ws, { type: "state", table: table.getClientState(null) });
        break;
      }

      case "join": {
        const { tableId, lamports, signature, name, playerSeed } = msg;
        const table = this.tables.get(tableId);
        if (!table) { this.send(client.ws, { type: "error", message: "Table not found" }); return; }

        // Verify buy-in on-chain
        if (this.onVerifyBuyIn && !(await this.onVerifyBuyIn(signature, client.playerId || msg.name, tableId, lamports))) {
          this.send(client.ws, { type: "error", message: "Buy-in verification failed" });
          return;
        }

        // Use name+seed combo as stable playerId in dev mode
        // In prod this would be the verified wallet pubkey
        const playerId = `player_${playerSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = tableId;
        client.isSpectator = false;

        const ok = table.sitDown(playerId, name, lamports, playerSeed);
        if (!ok) {
          this.send(client.ws, { type: "error", message: "Could not sit down — table may be full" });
          return;
        }

        this.send(client.ws, { type: "joined", table: table.getClientState(playerId) });
        break;
      }

      case "act": {
        // Auto-recover session if lost on reconnect
        if ((!client.playerId || !client.tableId) && (msg as any).playerSeed && (msg as any).tableId) {
          const recSeed = (msg as any).playerSeed;
          const recTableId = (msg as any).tableId;
          const recTable = this.tables.get(recTableId);
          if (recTable) {
            for (const prefix of ["practice", "room", "player"]) {
              const pid = `${prefix}_${recSeed.slice(0, 12)}`;
              if (recTable.getClientState(pid).you) {
                client.playerId = pid; client.tableId = recTableId;
                console.log("[ACT RECOVER] restored session:", pid);
                break;
              }
            }
          }
        }
        if (!client.playerId || !client.tableId) {
          console.log("[ACT FAILED] no playerId or tableId");
          return;
        }
        const table = this.tables.get(client.tableId);
        if (!table) {
          console.log("[ACT FAILED] table not found:", client.tableId);
          return;
        }
        const result = table.act(client.playerId, msg.action);
        if (!result.ok) {
          console.log("[ACT FAILED]", client.playerId, msg.action?.type, result.error);
          this.send(client.ws, { type: "error", message: result.error || "Action failed" });
        }
        break;
      }

      case "chat": {
        if (!client.playerId || !client.tableId) return;
        const table = this.tables.get(client.tableId);
        if (!table) return;
        const text = msg.text?.trim().slice(0, 140);
        if (text) table.chat_(client.playerId, text);
        break;
      }

      case "react": {
        if (!client.playerId || !client.tableId) return;
        const table = this.tables.get(client.tableId);
        if (!table) return;
        table.react(client.playerId, msg.emoji);
        break;
      }

      case "practice": {
        // Join a table with fake chips, no wallet needed
        const { tableId: ptid, name: pname, playerSeed: pseed } = msg;
        const ptCustomChips = (msg as any).chips;
        const ptable = this.tables.get(ptid);
        if (!ptable) { this.send(client.ws, { type: "error", message: "Table not found" }); return; }
        const playerId = `practice_${pseed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = ptid;
        client.isSpectator = false;
        const PRACTICE_CHIPS = ptCustomChips || 1000;
        // Check if already seated (rejoin)
        const existingSeat = ptable.getClientState(playerId).you;
        if (!existingSeat) {
          const ok = ptable.sitDown(playerId, pname || "Player", PRACTICE_CHIPS, pseed);
          if (!ok) { this.send(client.ws, { type: "error", message: "Table full" }); return; }
        }
        this.send(client.ws, { type: "joined", table: ptable.getClientState(playerId) });
        break;
      }

      case "create_room": {
        const { name: crName, playerSeed: crSeed, sb: crSb, bb: crBb, maxPlayers: crMax, roomName: crRoomName, chips: crChips } = msg as any;
        const startChips = crChips || 1000; // default 1000 chips
        const { roomId, table: crTable } = this.createRoom(crSb || 10_000_000, crBb || 20_000_000, crMax || 6, crRoomName);
        // Store starting chips on the room record so joiners get the same amount
        const roomRecord = this.dynamicRooms.get(roomId);
        if (roomRecord) {
          roomRecord.startingChips = startChips;
          roomRecord.currency = (msg as any).currency || 'chips';
        }
        const playerId = `room_${crSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = crTable["cfg"].id;
        client.isSpectator = false;
        crTable.sitDown(playerId, crName || "Host", startChips, crSeed);
        const roomUrl = `/table/${roomId}`;
        this.send(client.ws, { type: "room_created", roomId, url: roomUrl, table: crTable.getClientState(playerId), currency: (msg as any).currency || 'chips' });
        break;
      }

      case "join_room": {
        const { roomId: jrId, name: jrName, playerSeed: jrSeed } = msg;
        const jrChips = (msg as any).chips;
        // Cancel any pending disconnect timer
        const jrCancelId = `room_${jrSeed.slice(0, 12)}`;
        const jrTimer = this.disconnectTimers.get(jrCancelId);
        if (jrTimer) { clearTimeout(jrTimer); this.disconnectTimers.delete(jrCancelId); }
        const roomInfo = this.dynamicRooms.get(jrId);
        if (!roomInfo) { this.send(client.ws, { type: "error", message: "Room not found — ask the host to share a new link, or the server may have restarted." }); return; }
        const jrTable = this.tables.get(roomInfo.tableId);
        if (!jrTable) { this.send(client.ws, { type: "error", message: "Room expired" }); return; }
        const playerId = `room_${jrSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = roomInfo.tableId;
        client.isSpectator = false;
        const ROOM_CHIPS = 1_000_000_000_000;
        const tableChips = roomInfo.startingChips || jrChips || 1000;
        const ok = jrTable.sitDown(playerId, jrName || "Player", tableChips, jrSeed);
        if (!ok) { this.send(client.ws, { type: "error", message: "Room is full" }); return; }
        this.send(client.ws, { type: "joined", table: jrTable.getClientState(playerId), currency: roomInfo.currency || 'chips' });
        break;
      }

      case "rejoin": {
        const { tableId: rjTableId, playerSeed: rjSeed } = msg;
        const rjTable = this.tables.get(rjTableId);
        if (!rjTable) { this.send(client.ws, { type: "lobby" }); this.sendLobby(client.ws); return; }

        // Try all possible playerId prefixes
        const prefixes = ["practice", "room", "player", "bot"];
        let foundId: string | null = null;
        for (const prefix of prefixes) {
          const pid = `${prefix}_${rjSeed.slice(0, 12)}`;
          const pendingTimer = this.disconnectTimers.get(pid);
          if (pendingTimer) { clearTimeout(pendingTimer); this.disconnectTimers.delete(pid); }
          const state = rjTable.getClientState(pid);
          if (state.you) { foundId = pid; break; }
        }
        // Fallback: search all connected clients for matching seed
        if (!foundId) {
          for (const [, c2] of this.clients) {
            if (c2.tableId === rjTableId && c2.playerId) {
              const seedMatch = c2.playerId.includes(rjSeed.slice(0, 8));
              if (seedMatch) { foundId = c2.playerId; break; }
            }
          }
        }

        if (foundId) {
          client.playerId = foundId;
          client.tableId = rjTableId;
          client.isSpectator = false;
          console.log(`[RECONNECT] ${foundId} rejoined ${rjTableId}`);
          // Send current state immediately - captures mid-runout board state
          const currency = this.dynamicRooms.get(rjTableId)?.currency || 'chips';
          this.send(client.ws, { type: "joined", table: rjTable.getClientState(foundId), currency });
        } else {
          // Not found — send lobby instead of error so they can rejoin
          this.sendLobby(client.ws);
          this.send(client.ws, { type: "lobby", tables: [] });
        }
        break;
      }

      case "sit_out": {
        if (!client.playerId || !client.tableId) return;
        const soTable = this.tables.get(client.tableId);
        if (soTable) soTable.sitOut(client.playerId);
        break;
      }

      case "sit_in": {
        if (!client.playerId || !client.tableId) return;
        const siTable = this.tables.get(client.tableId);
        if (siTable) siTable.sitIn(client.playerId);
        break;
      }

      case "pause": {
        if (!client.playerId || !client.tableId) return;
        const table = this.tables.get(client.tableId);
        if (!table) return;
        table.pause(client.playerId);
        console.log(`[PAUSE] ${client.playerId}`);
        break;
      }

      case "resume": {
        if (!client.playerId || !client.tableId) return;
        const table = this.tables.get(client.tableId);
        if (!table) return;
        table.resume(client.playerId);
        console.log(`[RESUME] ${client.playerId}`);
        break;
      }

      case "rebuy": {
        // Try to find player even if playerId got lost on reconnect
        const rebuyChips = (msg as any).chips || 1000;
        const rebuySeed = (msg as any).playerSeed;
        let rebuyPlayerId = client.playerId;
        let rebuyTableId = client.tableId;

        // If we lost the session, try to find by seed
        if ((!rebuyPlayerId || !rebuyTableId) && rebuySeed && (msg as any).tableId) {
          rebuyTableId = (msg as any).tableId;
          const prefixes = ["practice", "room", "player"];
          const tbl = this.tables.get(rebuyTableId);
          if (tbl) {
            for (const prefix of prefixes) {
              const pid = `${prefix}_${rebuySeed.slice(0, 12)}`;
              const state = tbl.getClientState(pid);
              if (state.you) { rebuyPlayerId = pid; client.playerId = pid; client.tableId = rebuyTableId; break; }
            }
          }
        }

        if (!rebuyPlayerId || !rebuyTableId) return;
        const rebuyTable = this.tables.get(rebuyTableId);
        if (!rebuyTable) return;
        const ok = rebuyTable.rebuy(rebuyPlayerId, rebuyChips);
        if (ok) {
          this.send(client.ws, { type: "joined", table: rebuyTable.getClientState(rebuyPlayerId) });
        }
        break;
      }

      case "cashout": {
        if (!client.playerId || !client.tableId) return;
        const table = this.tables.get(client.tableId);
        if (!table) return;
        const chips = table.leave(client.playerId);
        client.tableId = null;
        client.isSpectator = false;

        if (chips > 0 && this.onCashOut) {
          try {
            const result = await this.onCashOut(client.playerId, chips, msg.tableId);
            this.send(client.ws, { type: "cashout", ...result });
          } catch (e: any) {
            this.send(client.ws, { type: "error", message: `Cashout failed: ${e.message}` });
          }
        } else {
          this.send(client.ws, { type: "cashout", solPaid: 0 });
        }

        this.sendLobby(client.ws);
        break;
      }
    }
  }

  // ── Broadcasting ────────────────────────────────────────────────────────────

  private broadcastTableState(table: PokerTable): void {
    const tableId = (table as any).cfg.id;

    for (const [ws, client] of this.clients) {
      if (client.tableId !== tableId) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;

      const state = table.getClientState(client.isSpectator ? null : client.playerId);
      this.send(ws, { type: "state", table: state });
    }
  }

  private sendLobby(ws: WebSocket): void {
    const tables = Array.from(this.tables.values()).map(t => t.getLobbyInfo());
    this.send(ws, { type: "lobby", tables });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────────

  private heartbeat(): void {
    const now = Date.now();
    for (const [ws, client] of this.clients) {
      if (now - client.lastPing > 60_000) {
        // Dead connection
        ws.terminate();
        this.handleDisconnect(client);
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }

  // ── Admin / Testing ──────────────────────────────────────────────────────────

  getTable(id: string): PokerTable | undefined {
    return this.tables.get(id);
  }

  getStats() {
    return {
      connectedClients: this.clients.size,
      tables: Array.from(this.tables.values()).map(t => t.getLobbyInfo()),
    };
  }

  /** Generate a short random room ID */
  private genRoomId(): string {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }

  /** Create a dynamic room table */
  private createRoom(sb: number, bb: number, maxPlayers: number, roomName: string): { roomId: string; table: import("../lib/engine/table").PokerTable } {
    const roomId = this.genRoomId();
    const tableId = `room_${roomId}`;
    const cfg = {
      id: tableId, name: roomName || `Room ${roomId.toUpperCase()}`,
      sb, bb, minBuyIn: bb * 20, maxBuyIn: bb * 200,
      maxSeats: Math.min(9, Math.max(2, maxPlayers)),
      rakePercent: 0, // no rake on friend tables
    };
    const { PokerTable } = require("../lib/engine/table");
    const table = new PokerTable(cfg);
    table.onStateChange = (t: any) => this.broadcastTableState(t);
    this.tables.set(tableId, table);
    this.dynamicRooms.set(roomId, { tableId, createdAt: Date.now(), startingChips: 1000, currency: 'chips' });
    // Clean up empty rooms after 2 hours
    setTimeout(() => {
      const info = this.dynamicRooms.get(roomId);
      if (info) { const t = this.tables.get(info.tableId); t?.destroy(); this.tables.delete(info.tableId); this.dynamicRooms.delete(roomId); }
    }, 7_200_000);
    return { roomId, table };
  }

  private startWatchdog(): void {
    setInterval(() => {
      for (const table of this.tables.values()) {
        table.healthCheck();
      }
    }, 10_000);
  }

  close(): void {
    clearInterval(this.pingInterval);
    for (const table of this.tables.values()) {
      table.destroy();
    }
    this.wss.close();
  }
}
