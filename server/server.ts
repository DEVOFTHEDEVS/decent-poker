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
  private dynamicRooms: Map<string, { tableId: string; createdAt: number }>; // roomId → tableId
  private pingInterval: ReturnType<typeof setInterval>;

  // Injected dependencies
  onVerifyBuyIn?: (sig: string, walletAddress: string, tableId: string, lamports: number) => Promise<boolean>;
  onCashOut?: (walletAddress: string, chips: number, tableId: string) => Promise<{ signature?: string; solPaid: number }>;
  onHandComplete?: (result: HandResult, tableId: string) => Promise<void>;

  constructor(port: number) {
    this.tables = new Map();
    this.clients = new Map();
    this.dynamicRooms = new Map();

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
    if (client.tableId && client.playerId && !client.isSpectator) {
      const table = this.tables.get(client.tableId);
      if (table) {
        // Return chips via cashout
        const chips = table.leave(client.playerId);
        if (chips > 0 && this.onCashOut) {
          this.onCashOut(client.playerId, chips, client.tableId).catch(console.error);
        }
      }
    }
    this.clients.delete(client.ws);
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
        if (!client.playerId || !client.tableId) return;
        const table = this.tables.get(client.tableId);
        if (!table) return;
        const result = table.act(client.playerId, msg.action);
        if (!result.ok) {
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
        const ptable = this.tables.get(ptid);
        if (!ptable) { this.send(client.ws, { type: "error", message: "Table not found" }); return; }
        const playerId = `practice_${pseed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = ptid;
        client.isSpectator = false;
        const PRACTICE_CHIPS = 1_000_000_000_000; // 1000 "chips" in lamports (display as chips not SOL)
        const ok = ptable.sitDown(playerId, pname || "Player", PRACTICE_CHIPS, pseed);
        if (!ok) { this.send(client.ws, { type: "error", message: "Table full" }); return; }
        this.send(client.ws, { type: "joined", table: ptable.getClientState(playerId) });
        break;
      }

      case "create_room": {
        const { name: crName, playerSeed: crSeed, sb: crSb, bb: crBb, maxPlayers: crMax, roomName: crRoomName } = msg;
        const { roomId, table: crTable } = this.createRoom(crSb || 10_000_000, crBb || 20_000_000, crMax || 6, crRoomName);
        const playerId = `room_${crSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = crTable["cfg"].id;
        client.isSpectator = false;
        const ROOM_CHIPS = 1_000_000_000_000;
        crTable.sitDown(playerId, crName || "Host", ROOM_CHIPS, crSeed);
        const roomUrl = `/table/${roomId}`;
        this.send(client.ws, { type: "room_created", roomId, url: roomUrl, table: crTable.getClientState(playerId) });
        break;
      }

      case "join_room": {
        const { roomId: jrId, name: jrName, playerSeed: jrSeed } = msg;
        const roomInfo = this.dynamicRooms.get(jrId);
        if (!roomInfo) { this.send(client.ws, { type: "error", message: "Room not found — it may have expired" }); return; }
        const jrTable = this.tables.get(roomInfo.tableId);
        if (!jrTable) { this.send(client.ws, { type: "error", message: "Room expired" }); return; }
        const playerId = `room_${jrSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = roomInfo.tableId;
        client.isSpectator = false;
        const ROOM_CHIPS = 1_000_000_000_000;
        const ok = jrTable.sitDown(playerId, jrName || "Player", ROOM_CHIPS, jrSeed);
        if (!ok) { this.send(client.ws, { type: "error", message: "Room is full" }); return; }
        this.send(client.ws, { type: "joined", table: jrTable.getClientState(playerId) });
        break;
      }

      case "rejoin": {
        // Client reconnected and wants to resume their session
        const { tableId: rjTableId, playerSeed: rjSeed } = msg;
        const rjTable = this.tables.get(rjTableId);
        if (!rjTable) { this.send(client.ws, { type: "error", message: "Table not found" }); return; }
        const rjPlayerId = `player_${rjSeed.slice(0, 12)}`;
        const rjSeat = rjTable.getClientState(rjPlayerId);
        if (rjSeat.you) {
          // Player is still seated
          client.playerId = rjPlayerId;
          client.tableId = rjTableId;
          client.isSpectator = false;
          this.send(client.ws, { type: "joined", table: rjTable.getClientState(rjPlayerId) });
        } else {
          this.send(client.ws, { type: "error", message: "Session expired" });
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
    this.dynamicRooms.set(roomId, { tableId, createdAt: Date.now() });
    // Clean up empty rooms after 2 hours
    setTimeout(() => {
      const info = this.dynamicRooms.get(roomId);
      if (info) { const t = this.tables.get(info.tableId); t?.destroy(); this.tables.delete(info.tableId); this.dynamicRooms.delete(roomId); }
    }, 7_200_000);
    return { roomId, table };
  }

  close(): void {
    clearInterval(this.pingInterval);
    for (const table of this.tables.values()) {
      table.destroy();
    }
    this.wss.close();
  }
}
