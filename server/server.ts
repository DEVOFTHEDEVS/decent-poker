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
  private dynamicRooms: Map<string, { tableId: string; createdAt: number; startingChips: number; currency: string; seatMemory: Map<string, number>; hostId: string }>; // roomId → tableId
  private disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // playerId → timer
  private persistPath: string;
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
    this.persistPath = '/tmp/decent-poker-rooms.json';
    this.loadPersistedRooms();
    this.startWatchdog();
    // Save rooms every 30 seconds
    setInterval(() => this.persistRooms(), 30_000);

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
      const table = this.tables.get(tableId);

      // Mark player as disconnected but KEEP them seated
      // They stay at the table until they explicitly stand up
      // Their turn timer will auto-fold their hands while away
      if (table) {
        const seat = (table as any).seats?.find((s: any) => s?.id === playerId);
        if (seat) {
          seat.sittingOut = true; // sit them out so they skip hands
          (table as any).emit?.();
          console.log(`[DISCONNECT] ${playerId} disconnected — keeping seat, sitting out`);
        }
      }
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
        const ptPreferredSeat = (msg as any).preferredSeat;
        // Check if already seated (rejoin)
        const existingSeat = ptable.getClientState(playerId).you;
        if (!existingSeat) {
          const ok = ptable.sitDown(playerId, pname || "Player", PRACTICE_CHIPS, pseed, undefined, ptPreferredSeat);
          if (!ok) { this.send(client.ws, { type: "error", message: "Table full" }); return; }
        }
        const ptCurrency = this.dynamicRooms.get(ptid)?.currency || 'chips';
        this.send(client.ws, { type: "joined", table: ptable.getClientState(playerId), currency: ptCurrency });
        break;
      }

      case "create_room": {
        const { name: crName, playerSeed: crSeed, sb: crSb, bb: crBb, maxPlayers: crMax, roomName: crRoomName, chips: crChips } = msg as any;
        // Convert display amount to internal lamports
        const currency_cr = (msg as any).currency || 'chips';
        const rawChips = crChips || 1000;
        let startChips: number;
        if (currency_cr === 'usd') startChips = Math.min(Math.round(rawChips * 100), 1_000_000); // max $10,000
        else if (currency_cr === 'sol') startChips = Math.min(Math.round(rawChips * 1e9), 100 * 1e9); // max 100 SOL
        else startChips = Math.min(Math.round(rawChips), 10_000_000); // max 10M chips
        const { roomId, table: crTable } = this.createRoom(crSb || 10_000_000, crBb || 20_000_000, crMax || 6, crRoomName);
        // Store starting chips on the room record so joiners get the same amount
        const roomRecord = this.dynamicRooms.get(roomId);
        if (roomRecord) {
          roomRecord.startingChips = startChips;
          roomRecord.currency = (msg as any).currency || 'chips';
          if (!roomRecord.seatMemory) roomRecord.seatMemory = new Map();
        }
        // Also tag the table itself with currency for easy lookup
        (crTable as any)._currency = (msg as any).currency || 'chips';
        // Start blind schedule if provided
        const blindSchedule = (msg as any).blindSchedule;
        if (blindSchedule && Array.isArray(blindSchedule)) {
          crTable.startBlindSchedule(blindSchedule);
          console.log(`[BLINDS] Schedule started: ${blindSchedule.length} levels, ${blindSchedule[0].durationMs/60000}m each`);
        }
        // Persist immediately
        this.persistRooms();
        const playerId = `room_${crSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = crTable["cfg"].id;
        client.isSpectator = false;
        crTable.sitDown(playerId, crName || "Host", startChips, crSeed);
        // Remember host's seat and ID
        const hostState = crTable.getClientState(playerId);
        if (hostState.you && roomRecord) {
          if (!roomRecord.seatMemory) roomRecord.seatMemory = new Map();
          roomRecord.seatMemory.set((crName || "Host").toLowerCase().trim(), hostState.you.seat);
          roomRecord.hostId = playerId;
        }
        const roomUrl = `/table/${roomId}`;
        this.send(client.ws, { type: "room_created", roomId, url: roomUrl, table: crTable.getClientState(playerId), currency: (msg as any).currency || 'chips' });
        break;
      }

      case "spectate_room": {
        // Join as spectator so user can pick seat and buy-in
        const { roomId: srId } = msg as any;
        const srRoom = this.dynamicRooms.get(srId);
        if (!srRoom) { this.send(client.ws, { type: "error", message: "Room not found — ask the host for a new link." }); return; }
        const srTable = this.tables.get(srRoom.tableId);
        if (!srTable) { this.send(client.ws, { type: "error", message: "Room not found." }); return; }
        client.tableId = srRoom.tableId;
        client.isSpectator = true;
        // Send table state as spectator (no you state)
        this.send(client.ws, { type: "spectating", table: srTable.getClientState(null), currency: srRoom.currency || "chips", roomId: srId });
        break;
      }

      case "room_info": {
        // Lightweight query to get room currency before joining
        const { roomId: riId } = msg as any;
        const riRoom = this.dynamicRooms.get(riId);
        if (!riRoom) { this.send(client.ws, { type: "room_info", currency: "chips", found: false }); return; }
        this.send(client.ws, { type: "room_info", currency: riRoom.currency || "chips", found: true });
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
        if (!roomInfo) { this.send(client.ws, { type: "error", message: "Room not found — ask the host to share a new link, or the server may have restarted." }); return; }
        const jrTable = this.tables.get(roomInfo.tableId);
        if (!jrTable) { this.send(client.ws, { type: "error", message: "Room expired" }); return; }
        const playerId = `room_${jrSeed.slice(0, 12)}`;
        client.playerId = playerId;
        client.tableId = roomInfo.tableId;
        client.isSpectator = false;
        // Use player's chosen buy-in if provided, otherwise fall back to room default
        const tableChips = jrChips || roomInfo.startingChips || 1000;
        // Check if this name has a saved seat
        const jrName2 = jrName || "Player";
        const savedSeat = roomInfo.seatMemory?.get(jrName2.toLowerCase().trim());
        const jrPreferredSeat = savedSeat ?? (msg as any).preferredSeat;
        const ok = jrTable.sitDown(playerId, jrName2, tableChips, jrSeed, undefined, jrPreferredSeat);
        // Save seat for this name
        if (ok) {
          const seatIdx = jrTable.getClientState(playerId).you?.seat;
          if (seatIdx !== undefined && roomInfo.seatMemory) {
            roomInfo.seatMemory.set(jrName2.toLowerCase().trim(), seatIdx);
          }
        }
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
          // Unsit them - they're back
          const rjSeat = (rjTable as any).seats?.find((s: any) => s?.id === foundId);
          if (rjSeat) { rjSeat.sittingOut = false; (rjTable as any).emit?.(); }
          console.log(`[RECONNECT] ${foundId} rejoined ${rjTableId}`);
          let roomCurrency = (rjTable as any)._currency || 'chips';
          if (roomCurrency === 'chips') {
            for (const [, roomRecord] of this.dynamicRooms) {
              if (roomRecord.tableId === rjTableId) { roomCurrency = roomRecord.currency || 'chips'; break; }
            }
          }
          // Find if this player is the host
          let rjHostRoom: string | null = null;
          for (const [rid, r] of this.dynamicRooms) { if (r.tableId === rjTableId) { rjHostRoom = rid; break; } }
          const rjIsHost = rjHostRoom ? this.dynamicRooms.get(rjHostRoom)?.hostId === foundId : false;
          this.send(client.ws, { type: "joined", table: rjTable.getClientState(foundId), currency: roomCurrency, isHost: rjIsHost });
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

      case "admin_action": {
        if (!client.playerId || !client.tableId) return;
        // Find the room and verify this client is the host
        let hostRoom: string | null = null;
        for (const [rid, room] of this.dynamicRooms) {
          if (room.tableId === client.tableId) { hostRoom = rid; break; }
        }
        if (!hostRoom) return;
        const room = this.dynamicRooms.get(hostRoom)!;
        if (room.hostId !== client.playerId) {
          this.send(client.ws, { type: "error", message: "Only the host can do that." });
          return;
        }
        const table = this.tables.get(client.tableId);
        if (!table) return;
        const { action, targetName, amount, newSeat } = msg as any;

        if (action === "pause_game") {
          table.pauseGame();
        } else if (action === "resume_game") {
          table.resumeGame();
        } else if (action === "set_blinds") {
          // amount=ante, newSeat encodes sb*100000+bb
          const encoded = (msg as any).newSeat || 0;
          const sb = Math.floor(encoded / 100000);
          const bb = encoded % 100000;
          const ante = (msg as any).amount || 0;
          if (sb > 0 && bb > sb) {
            table.setBlinds(sb, bb);
            table.setAnte(ante);
            console.log(`[ADMIN] Blinds set to ${sb}/${bb} ante=${ante}`);
          }
        } else if (action === "sit_player") {
          // Unsit a sitting-out player by name
          const seat = (table as any).seats?.find((s: any) => s?.name?.toLowerCase() === targetName?.toLowerCase());
          if (seat) { seat.sittingOut = false; (table as any).emit?.(); }
        } else if (action === "give_chips") {
          // Give/take chips from a player by name
          const seat = (table as any).seats?.find((s: any) => s?.name?.toLowerCase() === targetName?.toLowerCase());
          if (seat) {
            seat.chips = Math.max(0, seat.chips + (amount || 0));
            (table as any).emit?.();
            console.log(`[ADMIN] Give chips: ${targetName} now has ${seat.chips}`);
          }
        } else if (action === "set_chips") {
          const seat = (table as any).seats?.find((s: any) => s?.name?.toLowerCase() === targetName?.toLowerCase());
          if (seat) {
            seat.chips = Math.max(0, amount || 0);
            (table as any).emit?.();
          }
        } else if (action === "move_seat") {
          // Move player to a different seat
          const seat = (table as any).seats?.find((s: any) => s?.name?.toLowerCase() === targetName?.toLowerCase());
          const targetSeatEmpty = (table as any).seats?.[newSeat] === null;
          if (seat && targetSeatEmpty && newSeat >= 0) {
            const oldIdx = (table as any).seats?.indexOf(seat);
            (table as any).seats[newSeat] = seat;
            (table as any).seats[oldIdx] = null;
            (table as any).emit?.();
          }
        } else if (action === "remove_player") {
          const seat = (table as any).seats?.find((s: any) => s?.name?.toLowerCase() === targetName?.toLowerCase());
          if (seat) {
            // Find the kicked player's WS client and notify them with currency
            let roomCurrency = (table as any)._currency || 'chips';
            for (const [, r] of this.dynamicRooms) { if (r.tableId === client.tableId) { roomCurrency = r.currency || 'chips'; break; } }
            const kickedClient = Array.from(this.clients.values()).find(cl => cl.playerId === seat.id);
            if (kickedClient) {
              this.send(kickedClient.ws, { type: "kicked", message: "You were removed by the host.", currency: roomCurrency });
            }
            table.leave(seat.id);
          }
        }
        break;
      }

      case "pause": {
        const pauseSeed = (msg as any).playerSeed;
        let pauseId = client.playerId;
        let pauseTableId = client.tableId || (msg as any).tableId;
        if (!pauseId && pauseSeed && pauseTableId) {
          const tbl = this.tables.get(pauseTableId);
          if (tbl) for (const px of ["practice","room","player"]) { const pid=`${px}_${pauseSeed.slice(0,12)}`; if(tbl.getClientState(pid).you){pauseId=pid;client.playerId=pid;client.tableId=pauseTableId;break;} }
        }
        if (!pauseId || !pauseTableId) return;
        const pauseTable = this.tables.get(pauseTableId);
        if (!pauseTable) return;
        pauseTable.pause(pauseId);
        console.log(`[PAUSE] ${pauseId}`);
        break;
      }

      case "resume": {
        const resSeed = (msg as any).playerSeed;
        let resId = client.playerId;
        let resTableId = client.tableId || (msg as any).tableId;
        if (!resId && resSeed && resTableId) {
          const tbl = this.tables.get(resTableId);
          if (tbl) for (const px of ["practice","room","player"]) { const pid=`${px}_${resSeed.slice(0,12)}`; if(tbl.getClientState(pid).you){resId=pid;client.playerId=pid;client.tableId=resTableId;break;} }
        }
        if (!resId || !resTableId) return;
        const resTable = this.tables.get(resTableId);
        if (!resTable) return;
        resTable.resume(resId);
        console.log(`[RESUME] ${resId}`);
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
    this.dynamicRooms.set(roomId, { tableId, createdAt: Date.now(), startingChips: 1000, currency: 'chips', seatMemory: new Map(), hostId: '' });
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

  private persistRooms(): void {
    try {
      const fs = require('fs');
      const data = Array.from(this.dynamicRooms.entries()).map(([roomId, room]) => {
        const tbl = this.tables.get(room.tableId);
        return {
          roomId,
          tableId: room.tableId,
          createdAt: room.createdAt,
          startingChips: room.startingChips,
          currency: room.currency,
          hostId: room.hostId || '',
          seatMemory: Array.from(room.seatMemory?.entries() || []),
          sb: tbl ? (tbl as any).cfg?.sb : 25,
          bb: tbl ? (tbl as any).cfg?.bb : 50,
          maxSeats: tbl ? (tbl as any).cfg?.maxSeats : 6,
          roomName: tbl ? (tbl as any).cfg?.name : '',
        };
      });
      fs.writeFileSync(this.persistPath, JSON.stringify(data));
    } catch(e) { /* ignore */ }
  }

  private loadPersistedRooms(): void {
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      let restored = 0;
      for (const r of data) {
        // Only restore rooms created in last 12 hours
        if (Date.now() - r.createdAt > 12 * 60 * 60 * 1000) continue;
        // Create table with the SAME tableId so existing links keep working
        const tableId = `room_${r.roomId}`;
        const sb = r.sb || 25;
        const bb = r.bb || 50;
        const cfg = {
          id: tableId,
          name: r.roomName || `Room ${r.roomId.toUpperCase()}`,
          sb, bb,
          minBuyIn: bb * 20,
          maxBuyIn: bb * 200,
          maxSeats: r.maxSeats || 6,
          rakePercent: 0,
        };
        const { PokerTable } = require('../lib/engine/table');
        const table = new PokerTable(cfg);
        table.onStateChange = (t: any) => this.broadcastTableState(t);
        this.tables.set(tableId, table);
        (table as any)._currency = r.currency || 'chips';
        const seatMemory = new Map(r.seatMemory || []);
        this.dynamicRooms.set(r.roomId, {
          tableId,
          createdAt: r.createdAt,
          startingChips: r.startingChips || 1000,
          currency: r.currency || 'chips',
          seatMemory,
          hostId: r.hostId || '',
        });
        restored++;
        console.log(`[RESTORE] Room ${r.roomId} → table ${tableId}`);
      }
      console.log(`[RESTORE] ${restored}/${data.length} rooms restored`);
    } catch(e) { console.log('[RESTORE] Failed:', (e as any).message); }
  }

  close(): void {
    clearInterval(this.pingInterval);
    for (const table of this.tables.values()) {
      table.destroy();
    }
    this.wss.close();
  }
}
