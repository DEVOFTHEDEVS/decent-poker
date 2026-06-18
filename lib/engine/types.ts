import type { Card } from "./dealer";

// ── Table Config ──────────────────────────────────────────────────────────────

export interface TableConfig {
  id: string;
  name: string;
  sb: number;        // small blind in lamports
  bb: number;        // big blind in lamports
  minBuyIn: number;  // lamports
  maxBuyIn: number;  // lamports
  maxSeats: number;
  rakePercent: number; // e.g. 5 = 5%
}

export const TABLE_CONFIGS: TableConfig[] = [
  { id: "table1", name: "The Micro Felt",   sb: 1_000_000,   bb: 2_000_000,   minBuyIn: 100_000_000,   maxBuyIn: 1_000_000_000,  maxSeats: 9, rakePercent: 5 },
  { id: "table2", name: "Main Event",       sb: 5_000_000,   bb: 10_000_000,  minBuyIn: 500_000_000,   maxBuyIn: 5_000_000_000,  maxSeats: 9, rakePercent: 4 },
  { id: "table3", name: "High Roller Room", sb: 10_000_000,  bb: 20_000_000,  minBuyIn: 1_000_000_000, maxBuyIn: 10_000_000_000, maxSeats: 9, rakePercent: 3 },
  { id: "table4", name: "Whale Table",      sb: 50_000_000,  bb: 100_000_000, minBuyIn: 5_000_000_000, maxBuyIn: 50_000_000_000, maxSeats: 9, rakePercent: 2 },
];

// ── Player & Seat ─────────────────────────────────────────────────────────────

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export interface Player {
  id: string;           // wallet pubkey
  name: string;
  avatarUrl?: string;
  seed: string;         // player's provably fair seed
}

export interface Seat {
  id: string;           // wallet pubkey
  name: string;
  avatarUrl?: string;
  chips: number;        // current stack in lamports
  bet: number;          // current bet this street
  totalBet: number;     // total bet this hand (for side pots)
  cards: Card[] | "back" | null; // hole cards (null = not in hand)
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  inHand: boolean;
  isButton: boolean;
  isTurn: boolean;
  isBot: boolean;
  idleMs: number;
  lastActionTs: number;
  lastAction?: { label: string; amount?: number; ts: number };
}

// ── Action ────────────────────────────────────────────────────────────────────

export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface Action {
  type: ActionType;
  amount?: number; // for bet/raise, in lamports
}

export interface ActionLogEntry {
  playerId: string;
  name: string;
  seat: number;
  label: string;        // "FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL-IN"
  amount?: number;
  ts: number;
}

// ── Hand Result ───────────────────────────────────────────────────────────────

export interface WinnerInfo {
  playerId: string;
  name: string;
  seat: number;
  amount: number;       // lamports won
  hand: string;         // hand label or "win" (everyone folded)
  cards?: Card[];       // hole cards at showdown
}

export interface HandResult {
  ts: number;
  winners: WinnerInfo[];
  rake: number;         // lamports taken as rake
  reveal: boolean;      // true if went to showdown
  winCards?: string[];  // "Rs" keys of winning cards for highlighting
  proof?: {             // provably fair proof
    serverSeedHash: string;
    serverSeed: string; // revealed after hand
    combinedHash: string;
    handNonce: number;
  };
}

// ── Pot ───────────────────────────────────────────────────────────────────────

export interface Pot {
  amount: number;
  eligiblePlayerIds: string[];
  label: string;
}

// ── Table State ───────────────────────────────────────────────────────────────

export interface TableState {
  id: string;
  name: string;
  sb: number;
  bb: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxSeats: number;
  seats: (Seat | null)[];
  board: Card[];
  pot: number;
  pots: Pot[];
  currentBet: number;
  street: Street | null;
  handActive: boolean;
  handNonce: number;
  buttonSeat: number;
  actionSeat: number | null;
  actionLog: ActionLogEntry[];
  lastResult: HandResult | null;
  chat: ChatMessage[];
  reactions: Reaction[];
  seated: number;
  inHand: number;
  sbSol: number;      // for display
  bbSol: number;
  minSol: number;
  // serverSeedHash published before each hand for provably fair
  currentSeedHash: string;
}

// ── Client View (player-specific) ────────────────────────────────────────────

export interface YouState {
  seat: number;
  chips: number;
  myTurn: boolean;
  canCheck: boolean;
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  inHand: boolean;
  allIn: boolean;
}

// What each client receives — their own cards visible, others hidden
export interface ClientTableState extends Omit<TableState, "seats"> {
  seats: (ClientSeat | null)[];
  you: YouState | null;
}

export interface ClientSeat extends Omit<Seat, "cards"> {
  cards: Card[] | "back" | null;
}

// ── Chat & Reactions ──────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  seat: number;
  playerId: string;
  name: string;
  text: string;
  ts: number;
}

export interface Reaction {
  id: string;
  seat: number;
  emoji: string;
  ts: number;
}

// ── WebSocket Messages ────────────────────────────────────────────────────────

// Server → Client
export type ServerMessage =
  | { type: "state";      table: ClientTableState }
  | { type: "lobby";      tables: LobbyTable[] }
  | { type: "error";      message: string }
  | { type: "joined";     table: ClientTableState }
  | { type: "kicked";     reason: "chips" | "idle"; lastWinner?: WinnerInfo }
  | { type: "cashout";    solPaid: number; signature?: string }
  | { type: "pong" }
  | { type: "room_created"; roomId: string; url: string; table: ClientTableState }

// Client → Server
export type ClientMessage =
  | { type: "join";       tableId: string; lamports: number; signature: string; name: string; playerSeed: string }
  | { type: "act";        tableId: string; action: Action }
  | { type: "chat";       tableId: string; text: string }
  | { type: "react";      tableId: string; emoji: string }
  | { type: "watch";      tableId: string }
  | { type: "cashout";    tableId: string }
  | { type: "lobby" }
  | { type: "ping" }
  | { type: "rebuy"; tableId: string; chips: number; playerSeed: string }
  | { type: "rejoin"; tableId: string; playerSeed: string }
  | { type: "practice";    tableId: string; name: string; playerSeed: string }
  | { type: "create_room"; name: string; playerSeed: string; sb: number; bb: number; maxPlayers: number; roomName: string }
  | { type: "join_room";   roomId: string; name: string; playerSeed: string }

// ── Lobby ─────────────────────────────────────────────────────────────────────

export interface LobbyTable {
  id: string;
  name: string;
  seated: number;
  maxSeats: number;
  inHand: boolean;
  sb: number;
  bb: number;
  sbSol: number;
  bbSol: number;
  minSol: number;
  maxSol: number;
}
