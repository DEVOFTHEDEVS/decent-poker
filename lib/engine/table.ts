/**
 * Texas Hold'em Game Engine
 *
 * A self-contained state machine for a single poker table.
 * No I/O, no WebSockets — pure game logic.
 * The WebSocket server wraps this and handles network concerns.
 */

import { randomBytes } from "crypto";
import { dealProvablyFair, generateServerSeed } from "./dealer";
import { runShowdown, calculateSidePots } from "./evaluator";
import { makeBotDecision, type BotPersonality } from "./bot";
import type {
  TableConfig, TableState, Seat, Action, ActionLogEntry,
  HandResult, WinnerInfo, Pot, ChatMessage, Reaction,
  ClientTableState, ClientSeat, YouState, Street, LobbyTable,
} from "./types";

const LAMPORTS = 1_000_000_000; // per SOL
const TURN_TIME_MS = 20_000;
const IDLE_KICK_MS = 90_000;
const BETWEEN_HAND_DELAY_MS = 2_000;
const RESULT_SHOW_MS = 3_000;

export class PokerTable {
  private cfg: TableConfig;
  private seats: (Seat | null)[];
  private board: import("./dealer").Card[];
  private deck: import("./dealer").Card[];
  private pot: number;
  private street: Street | null;
  private handActive: boolean;
  private handNonce: number;
  private buttonSeat: number;
  private actionSeat: number | null;
  private currentBet: number;
  private actionLog: ActionLogEntry[];
  private lastResult: HandResult | null;
  private chat: ChatMessage[];
  private reactions: Reaction[];
  private serverSeed: string;
  private serverSeedHash: string;
  private playerSeeds: Map<string, string>; // playerId → seed
  private botPersonalities: Map<string, BotPersonality>; // playerId → personality
  private botTimer: ReturnType<typeof setTimeout> | null;
  private dealtCount: number; // number of players dealt hole cards this hand
  private handEnding: boolean; // true during result display, prevents double endHand
  private resultTimer: ReturnType<typeof setTimeout> | null; // tracks the resetHand timer
  private handId: number; // increments each hand, used to detect stale timers
  private endHandTimer: ReturnType<typeof setTimeout> | null;
  private turnTimer: ReturnType<typeof setTimeout> | null;
  private handTimer: ReturnType<typeof setTimeout> | null;
  private version: number; // increments on every state change

  // Callbacks
  onStateChange?: (table: PokerTable) => void;
  onKick?: (playerId: string, reason: string) => void;
  onHandComplete?: (result: HandResult, tableId: string) => void;

  constructor(cfg: TableConfig) {
    this.cfg = cfg;
    this.seats = Array(cfg.maxSeats).fill(null);
    this.board = [];
    this.deck = [];
    this.pot = 0;
    this.street = null;
    this.handActive = false;
    this.handNonce = 0;
    this.buttonSeat = 0;
    this.actionSeat = null;
    this.currentBet = 0;
    this.actionLog = [];
    this.lastResult = null;
    this.chat = [];
    this.reactions = [];
    this.playerSeeds = new Map();
    this.botPersonalities = new Map();
    this.botTimer = null;
    this.dealtCount = 0;
    this.handEnding = false;
    this.resultTimer = null;
    this.handId = 0;
    this.endHandTimer = null;
    this.turnTimer = null;
    this.handTimer = null;
    this.version = 0;
    const { serverSeed, serverSeedHash } = generateServerSeed();
    this.serverSeed = serverSeed;
    this.serverSeedHash = serverSeedHash;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Add a player to the table after their buy-in is verified on-chain */
  sitDown(playerId: string, name: string, chips: number, playerSeed: string, avatarUrl?: string): boolean {
    if (this.seats.some(s => s?.id === playerId)) return false; // already seated
    const emptySeat = this.seats.findIndex(s => s === null);
    if (emptySeat === -1) return false; // full

    this.playerSeeds.set(playerId, playerSeed);
    const seat = this.makeSeat(playerId, name, chips, avatarUrl);
    // If a hand is in progress, sit them out until next hand
    if (this.handActive || this.handEnding) {
      seat.sittingOut = true;
      seat.inHand = false;
    }
    this.seats[emptySeat] = seat;
    this.emit();

    // Try to start a hand if we have enough players
    if (!this.handActive && !this.handEnding) this.maybeStartHand();
    return true;
  }

  /** Process a player action (fold/check/call/bet/raise/allin) */
  act(playerId: string, action: Action): { ok: boolean; error?: string } {
    if (!this.handActive || this.handEnding) return { ok: false, error: "No hand in progress" };

    const seat = this.seats.findIndex(s => s?.id === playerId);
    if (seat === -1) return { ok: false, error: "Not at table" };
    if (seat !== this.actionSeat) return { ok: false, error: "Not your turn" };

    const player = this.seats[seat]!;
    if (player.folded) return { ok: false, error: "Already folded" };

    this.clearTurnTimer();

    switch (action.type) {
      case "fold":
        return this.doFold(seat);
      case "check":
        return this.doCheck(seat);
      case "call":
        return this.doCall(seat);
      case "bet":
      case "raise":
        return this.doRaise(seat, action.amount!);
      case "allin":
        return this.doAllIn(seat);
      default:
        return { ok: false, error: "Unknown action" };
    }
  }

  /** Remove a player from the table and return their chips */
  leave(playerId: string): number {
    const seat = this.seats.findIndex(s => s?.id === playerId);
    if (seat === -1) return 0;

    const player = this.seats[seat]!;
    const chips = player.chips;

    if (player.inHand && this.handActive) {
      // Auto-fold if in hand
      player.folded = true;
      player.inHand = false;
      if (seat === this.actionSeat) {
        this.clearTurnTimer();
        this.advance();
      }
    }

    this.seats[seat] = null;
    this.playerSeeds.delete(playerId);
    this.emit();

    if (!this.handActive) this.maybeStartHand();
    return chips;
  }

  /** Add chips to a player's stack (rebuy) */
  rebuy(playerId: string, chips: number): boolean {
    const seat = this.seats.find(s => s?.id === playerId);
    if (!seat) return false;
    seat.chips += chips;
    seat.sittingOut = false; // unsit them so they get dealt in
    this.emit();
    if (!this.handActive) this.maybeStartHand();
    return true;
  }

  /** Add chat message */
  chat_(playerId: string, text: string): void {
    const seat = this.seats.findIndex(s => s?.id === playerId);
    if (seat === -1) return;
    const player = this.seats[seat]!;
    const msg: ChatMessage = {
      id: randomBytes(4).toString("hex"),
      seat,
      playerId,
      name: player.name,
      text: text.slice(0, 140),
      ts: Date.now(),
    };
    this.chat = [...this.chat.slice(-49), msg]; // keep last 50
    this.emit();
  }

  /** Add reaction */
  react(playerId: string, emoji: string): void {
    const seat = this.seats.findIndex(s => s?.id === playerId);
    if (seat === -1) return;
    const reaction: Reaction = {
      id: randomBytes(4).toString("hex"),
      seat,
      emoji,
      ts: Date.now(),
    };
    this.reactions = [...this.reactions.slice(-19), reaction]; // keep last 20
    this.emit();
  }

  /** Kick idle player */
  kickIdle(playerId: string): void {
    const seat = this.seats.findIndex(s => s?.id === playerId);
    if (seat === -1) return;
    const player = this.seats[seat]!;
    if (Date.now() - player.lastActionTs < IDLE_KICK_MS) return;
    this.leave(playerId);
  }

  /** Get client-visible state for a specific player */
  getClientState(playerId: string | null): ClientTableState {
    const mySeat = playerId ? this.seats.findIndex(s => s?.id === playerId) : -1;

    const seats: (ClientSeat | null)[] = this.seats.map((seat, i) => {
      if (!seat) return null;
      return {
        ...seat,
        idleMs: Date.now() - seat.lastActionTs,
        // Hide other players' hole cards unless showdown
        cards: i === mySeat
          ? seat.cards
          : this.shouldRevealCards(seat, i)
            ? seat.cards
            : seat.cards === null ? null : "back",
      };
    });

    let you: YouState | null = null;
    if (mySeat !== -1 && this.seats[mySeat]) {
      const p = this.seats[mySeat]!;
      const toCall = Math.max(0, this.currentBet - p.bet);
      you = {
        seat: mySeat,
        chips: p.chips,
        myTurn: mySeat === this.actionSeat,
        canCheck: toCall === 0,
        toCall,
        minRaiseTo: this.minRaise(),
        maxRaiseTo: p.chips + p.bet, // can go all in
        inHand: p.inHand,
        allIn: p.allIn,
      };
    }

    const pots = this.buildPots();
    const seated = this.seats.filter(Boolean).length;

    return {
      id: this.cfg.id,
      name: this.cfg.name,
      sb: this.cfg.sb,
      bb: this.cfg.bb,
      minBuyIn: this.cfg.minBuyIn,
      maxBuyIn: this.cfg.maxBuyIn,
      maxSeats: this.cfg.maxSeats,
      seats,
      board: this.board,
      pot: this.pot,
      pots,
      currentBet: this.currentBet,
      street: this.street,
      handActive: this.handActive,
      handNonce: this.handNonce,
      buttonSeat: this.buttonSeat,
      actionSeat: this.actionSeat,
      actionLog: this.actionLog.slice(-20),
      lastResult: this.lastResult,
      chat: this.chat,
      reactions: this.reactions.filter(r => Date.now() - r.ts < 5000),
      seated,
      inHand: this.seats.filter(s => s?.inHand).length,
      sbSol: this.cfg.sb / LAMPORTS,
      bbSol: this.cfg.bb / LAMPORTS,
      minSol: this.cfg.minBuyIn / LAMPORTS,
      you,
      currentSeedHash: this.serverSeedHash,
    };
  }

  getLobbyInfo(): LobbyTable {
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      seated: this.seats.filter(Boolean).length,
      maxSeats: this.cfg.maxSeats,
      inHand: this.handActive,
      sb: this.cfg.sb,
      bb: this.cfg.bb,
      sbSol: this.cfg.sb / LAMPORTS,
      bbSol: this.cfg.bb / LAMPORTS,
      minSol: this.cfg.minBuyIn / LAMPORTS,
      maxSol: this.cfg.maxBuyIn / LAMPORTS,
    };
  }

  getSeatedPlayerIds(): string[] {
    return this.seats.filter(Boolean).map(s => s!.id);
  }

  /** Add a bot player to the table */
  sitDownBot(botId: string, name: string, chips: number, personality: BotPersonality): boolean {
    const ok = this.sitDown(botId, name, chips, `bot_seed_${botId}`);
    if (ok) {
      const seat = this.seats.find(s => s?.id === botId);
      if (seat) seat.isBot = true;
      this.botPersonalities.set(botId, personality);
    }
    return ok;
  }

  /** Schedule a bot action with a human-like delay */
  private scheduleBotAction(seatIdx: number): void {
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    const seat = this.seats[seatIdx];
    if (!seat || !seat.isBot) return;

    const personality = this.botPersonalities.get(seat.id) || "loose";
    const thinkMs = personality === "maniac" ? 400 + Math.random() * 400
                  : personality === "aggressive" ? 500 + Math.random() * 600
                  : personality === "loose" ? 600 + Math.random() * 700
                  : 700 + Math.random() * 800;

    this.botTimer = setTimeout(() => {
      if (this.actionSeat !== seatIdx) return;
      if (!this.handActive) return;
      const s = this.seats[seatIdx];
      if (!s || !s.isBot || !s.inHand || s.folded) return;

      const holeCards = Array.isArray(s.cards) ? s.cards : [];
      const inHandSeats = this.seats.filter(x => x?.inHand && !x.folded).length;
      const posRatio = (seatIdx - this.buttonSeat + this.cfg.maxSeats) % this.cfg.maxSeats / this.cfg.maxSeats;
      const position = posRatio < 0.33 ? "early" : posRatio < 0.66 ? "middle" : "late";
      const toCall = Math.max(0, this.currentBet - s.bet);

      const decision = makeBotDecision({
        holeCards,
        board: this.board,
        pot: this.pot,
        toCall,
        minRaise: this.minRaise(),
        maxRaise: s.chips + s.bet,
        canCheck: toCall === 0,
        myChips: s.chips,
        myBet: s.bet,
        currentBet: this.currentBet,
        bb: this.cfg.bb,
        activePlayers: inHandSeats,
        position,
        street: this.street || "preflop",
      }, personality);

      this.act(s.id, decision);
    }, thinkMs);
  }

  // ── Hand Flow ───────────────────────────────────────────────────────────────

  private maybeStartHand(): void {
    const active = this.activePlayers();
    if (active.length < 2 || this.handActive || this.handEnding) return;
    // Cancel any existing timer to prevent double-scheduling
    if (this.handTimer) { clearTimeout(this.handTimer); this.handTimer = null; }
    this.handTimer = setTimeout(() => this.startHand(), BETWEEN_HAND_DELAY_MS);
  }

  private startHand(): void {
    this.handTimer = null;

    // Cancel any pending timers from previous hand
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.endHandTimer) { clearTimeout(this.endHandTimer); this.endHandTimer = null; }
    if (this.resultTimer) { clearTimeout(this.resultTimer); this.resultTimer = null; }

    // Unsit waiting players BEFORE calling activePlayers so they get dealt in
    for (const seat of this.seats) {
      if (seat && seat.sittingOut && seat.chips > 0) {
        seat.sittingOut = false;
      }
    }

    const active = this.activePlayers();
    if (active.length < 2) return;

    this.lastResult = null; // clear previous result
    this.handId++; // new hand ID so stale resultTimer can detect it
    this.handActive = true;
    this.handNonce++;
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.actionLog = [];
    this.lastResult = null;
    this.street = "preflop";

    // Reset seats for new hand
    for (const seat of this.seats) {
      if (!seat) continue;
      seat.bet = 0;
      seat.totalBet = 0;
      seat.folded = false;
      seat.allIn = false;
      seat.inHand = active.includes(seat.id);
      seat.cards = seat.inHand ? null : null;
      seat.isButton = false;
      seat.isTurn = false;
      seat.lastAction = undefined;
    }

    // Advance button
    this.buttonSeat = this.nextActiveSeat(this.buttonSeat);
    const buttonPlayer = this.seats[this.buttonSeat]!;
    buttonPlayer.isButton = true;

    // Deal using provably fair shuffle
    const allSeeds = active.map(id => this.playerSeeds.get(id) || id);
    const { serverSeed, serverSeedHash } = generateServerSeed();
    this.serverSeed = serverSeed;
    this.serverSeedHash = serverSeedHash;
    const { deck } = dealProvablyFair(serverSeed, allSeeds, this.handNonce);
    this.deck = deck;

    // Deal 2 cards to each player
    let cardIdx = 0;
    for (const playerId of active) {
      const seat = this.seats.find(s => s?.id === playerId)!;
      seat.cards = [this.deck[cardIdx++], this.deck[cardIdx++]];
    }
    this.dealtCount = active.length; // store exactly how many were dealt to

    // Post blinds
    const sbSeat = this.nextActiveSeat(this.buttonSeat);
    const bbSeat = this.nextActiveSeat(sbSeat);

    this.postBlind(sbSeat, this.cfg.sb, "SB");
    this.postBlind(bbSeat, this.cfg.bb, "BB");
    this.currentBet = this.cfg.bb;

    // Action starts left of BB (or BB if heads up)
    const headsUp = active.length === 2;
    this.actionSeat = headsUp
      ? this.nextActiveSeat(bbSeat)
      : this.nextActiveSeat(bbSeat);

    this.seats[this.actionSeat]!.isTurn = true;
    this.emit();

    // Route to bot or start turn timer
    if (this.seats[this.actionSeat]?.isBot) {
      this.scheduleBotAction(this.actionSeat);
    } else {
      this.startTurnTimer();
    }
  }

  private postBlind(seatIdx: number, amount: number, label: string): void {
    const seat = this.seats[seatIdx];
    if (!seat) return;
    const actual = Math.min(amount, seat.chips);
    seat.chips -= actual;
    seat.bet += actual;
    seat.totalBet += actual;
    this.pot += actual;
    if (seat.chips === 0) seat.allIn = true;
    this.logAction(seatIdx, label, actual);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private doFold(seat: number): { ok: boolean } {
    const player = this.seats[seat]!;
    player.folded = true;
    player.inHand = false;
    player.isTurn = false;
    this.logAction(seat, "FOLD");
    this.emit();
    this.advance();
    return { ok: true };
  }

  private doCheck(seat: number): { ok: boolean; error?: string } {
    const player = this.seats[seat]!;
    const toCall = this.currentBet - player.bet;
    if (toCall > 0) return { ok: false, error: "Cannot check — there is a bet to call" };
    player.isTurn = false;
    this.logAction(seat, "CHECK");
    this.emit();
    this.advance();
    return { ok: true };
  }

  private doCall(seat: number): { ok: boolean } {
    const player = this.seats[seat]!;
    const toCall = Math.min(this.currentBet - player.bet, player.chips);
    player.chips -= toCall;
    player.bet += toCall;
    player.totalBet += toCall;
    this.pot += toCall;
    if (player.chips === 0) player.allIn = true;
    player.isTurn = false;
    this.logAction(seat, "CALL", toCall);
    this.emit();
    this.advance();
    return { ok: true };
  }

  private doRaise(seat: number, amount: number): { ok: boolean; error?: string } {
    const player = this.seats[seat]!;
    const min = this.minRaise();
    const max = player.chips + player.bet;

    if (amount < min && amount < max) {
      return { ok: false, error: `Minimum raise is ${min} lamports` };
    }

    const toAdd = Math.min(amount, max) - player.bet;
    player.chips -= toAdd;
    player.bet += toAdd;
    player.totalBet += toAdd;
    this.pot += toAdd;
    this.currentBet = player.bet;

    if (player.chips === 0) {
      player.allIn = true;
      this.logAction(seat, "ALL-IN", player.bet);
    } else {
      this.logAction(seat, amount >= this.currentBet ? "RAISE" : "BET", player.bet);
    }

    player.isTurn = false;
    this.emit();
    this.advance();
    return { ok: true };
  }

  private doAllIn(seat: number): { ok: boolean } {
    const player = this.seats[seat]!;
    return this.doRaise(seat, player.chips + player.bet);
  }

  // ── Advance Action ──────────────────────────────────────────────────────────

  private advance(): void {
    if (!this.handActive || this.handEnding) return; // Guard against stale callbacks
    // Count players still in hand (not folded, not all-in)
    const activePlayers = this.seats.filter(s => s?.inHand && !s.folded && !s.allIn);
    const inHandPlayers = this.seats.filter(s => s?.inHand && !s.folded);

    // Only one player left → they win
    if (inHandPlayers.length <= 1) {
      this.endHand(false);
      return;
    }

    // All remaining players are all-in → run the board out or end hand
    if (activePlayers.length === 0) {
      if (!this.endHandTimer) {
        if (this.street === "river" || this.board.length >= 5) {
          this.actionSeat = null;
          this.clearTurnTimer();
          if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
          this.emit();
          this.endHandTimer = setTimeout(() => { this.endHandTimer = null; this.endHand(true); }, 800);
        } else {
          this.runBoardOut();
        }
      }
      return;
    }

    // Find next player who needs to act
    const next = this.nextToAct();

    if (next === null) {
      // Everyone has acted → advance street
      this.nextStreet();
      return;
    }

    // Clear isTurn on all seats first
    for (const seat of this.seats) {
      if (seat) seat.isTurn = false;
    }
    this.actionSeat = next;
    this.seats[next]!.isTurn = true;
    this.emit();

    // If it's a bot's turn, schedule their action instead of starting turn timer
    if (this.seats[next]?.isBot) {
      this.scheduleBotAction(next);
    } else {
      this.startTurnTimer();
    }
  }

  private nextToAct(): number | null {
    // Find players who still need to act:
    // - in hand, not folded, not all-in
    // - haven't matched the current bet (or haven't acted this street)
    const start = this.actionSeat !== null ? this.actionSeat : this.buttonSeat;

    for (let i = 1; i <= this.cfg.maxSeats; i++) {
      const idx = (start + i) % this.cfg.maxSeats;
      const seat = this.seats[idx];
      if (!seat || !seat.inHand || seat.folded || seat.allIn) continue;
      const isBlindAction = seat.lastAction?.label === "SB" || seat.lastAction?.label === "BB";
      if (seat.bet < this.currentBet || !seat.lastAction || isBlindAction) return idx;
    }

    return null; // all players have acted and matched the bet
  }

  private nextStreet(): void {
    // Collect bets into pot
    for (const seat of this.seats) {
      if (seat) seat.bet = 0;
    }

    this.currentBet = 0;
    // Reset lastAction for new street
    for (const seat of this.seats) {
      if (seat?.inHand && !seat.folded) seat.lastAction = undefined;
    }

    const streets: Street[] = ["preflop", "flop", "turn", "river", "showdown"];
    const nextStreet = streets[streets.indexOf(this.street!) + 1];

    if (!nextStreet || nextStreet === "showdown") {
      this.endHand(true);
      return;
    }

    this.street = nextStreet;

    // Deal community cards from remaining deck positions
    this.dealCommunityCards(nextStreet);

    // Clear isTurn on ALL seats before setting new one
    for (const seat of this.seats) {
      if (seat) seat.isTurn = false;
    }

    // Action starts left of button, skip all-in players
    const firstToAct = this.nextActiveSeat(this.buttonSeat);
    this.actionSeat = firstToAct;
    this.seats[firstToAct]!.isTurn = true;
    this.emit();

    if (this.seats[firstToAct]?.isBot) {
      this.scheduleBotAction(firstToAct);
    } else {
      this.startTurnTimer();
    }
  }

  private dealCommunityCards(street: Street): void {
    // Community cards start after hole cards — use exact dealt count
    const holeCardCount = this.dealtCount * 2;

    if (street === "flop") {
      this.board = [
        this.deck[holeCardCount],
        this.deck[holeCardCount + 1],
        this.deck[holeCardCount + 2],
      ];
    } else if (street === "turn") {
      this.board = [
        this.deck[holeCardCount],
        this.deck[holeCardCount + 1],
        this.deck[holeCardCount + 2],
        this.deck[holeCardCount + 3],
      ];
    } else if (street === "river") {
      this.board = [
        this.deck[holeCardCount],
        this.deck[holeCardCount + 1],
        this.deck[holeCardCount + 2],
        this.deck[holeCardCount + 3],
        this.deck[holeCardCount + 4],
      ];
    }
  }

  private runBoardOut(): void {
    // Prevent double-scheduling
    if (this.endHandTimer) return;

    // Deal remaining board cards — use exact dealt count for offset
    const holeCardCount = this.dealtCount * 2;
    const fullBoard = [
      this.deck[holeCardCount],
      this.deck[holeCardCount + 1],
      this.deck[holeCardCount + 2],
      this.deck[holeCardCount + 3],
      this.deck[holeCardCount + 4],
    ];

    // Only replace board cards we haven't dealt yet
    this.board = fullBoard.slice(0, 5);
    this.street = "river";
    this.actionSeat = null;
    this.clearTurnTimer();
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    this.emit();

    this.endHandTimer = setTimeout(() => {
      this.endHandTimer = null;
      this.endHand(true);
    }, 1500);
  }

  private endHand(showdown: boolean): void {
    if (this.handEnding) return; // prevent double-call
    this.handEnding = true;
    this.clearTurnTimer();
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.endHandTimer) { clearTimeout(this.endHandTimer); this.endHandTimer = null; }
    this.handActive = false;
    this.actionSeat = null;

    for (const seat of this.seats) {
      if (seat) seat.isTurn = false;
    }

    const inHand = this.seats
      .map((s, i) => ({ seat: s, idx: i }))
      .filter(({ seat }) => seat?.inHand && !seat.folded);

    if (inHand.length === 0) {
      // Edge case — just reset
      this.resetHand();
      return;
    }

    // Rake rules:
    // - Only applied if hand saw a flop (3+ community cards)
    // - No rake on preflop folds — winner gets full pot back
    // - Capped at 3 BB to protect large pots
    const sawFlop = this.board.length >= 3;
    const rakeCap = this.cfg.bb * 3;
    const rake = sawFlop
      ? Math.min(rakeCap, Math.floor(this.pot * this.cfg.rakePercent / 100))
      : 0;
    const distributablePot = this.pot - rake;

    let winners: WinnerInfo[];
    let winCards: string[] = [];
    let reveal = false;

    if (inHand.length === 1 && !showdown) {
      // Everyone else folded
      const winner = inHand[0];
      const p = winner.seat!;
      p.chips += distributablePot;
      winners = [{
        playerId: p.id,
        name: p.name,
        seat: winner.idx,
        amount: distributablePot,
        hand: "(everyone folded)",
      }];
    } else {
      // Showdown — evaluate hands
      reveal = true;
      const showdownPlayers = inHand.map(({ seat: s, idx }) => ({
        id: s!.id,
        name: s!.name,
        holeCards: s!.cards as import("./dealer").Card[],
        chips: s!.chips,
        bet: s!.totalBet,
      }));

      // Handle side pots
      const sidePots = calculateSidePots(
        this.seats.map((s, i) => ({
          id: s?.id || `empty_${i}`,
          totalBet: s?.totalBet || 0,
          folded: !s?.inHand || (s.folded ?? true),
        })).filter(s => !s.id.startsWith("empty_"))
      );

      winners = [];
      let remaining = distributablePot;

      if (sidePots.length === 0) {
        // Simple case — single pot
        const result = runShowdown(showdownPlayers, this.board, distributablePot);
        for (const w of result.winners) {
          const seat = this.seats.find(s => s?.id === w.id);
          if (seat) seat.chips += w.amount;
          const seatIdx = this.seats.findIndex(s => s?.id === w.id);
          const handResult = w.hand;
          winners.push({ playerId: w.id, name: w.name, amount: w.amount, seat: seatIdx, hand: handResult.label || "win" });
          if (handResult.bestFive) {
            winCards = [...winCards, ...handResult.bestFive.map((c: any) => c.r + c.s)];
          }
        }
      } else {
        // Side pot resolution
        for (const pot of sidePots) {
          const eligible = showdownPlayers.filter(p => pot.eligiblePlayerIds.includes(p.id));
          if (eligible.length === 0) continue;
          const potAmount = Math.min(pot.amount, remaining);
          remaining -= potAmount;
          const result = runShowdown(eligible, this.board, potAmount);
          for (const w of result.winners) {
            const seat = this.seats.find(s => s?.id === w.id);
            if (seat) seat.chips += w.amount;
            const seatIdx = this.seats.findIndex(s => s?.id === w.id);
            const existing = winners.find(x => x.playerId === w.id);
            if (existing) {
              existing.amount += w.amount;
            } else {
              winners.push({ playerId: w.id, ...w, seat: seatIdx, hand: w.hand.label || "win" });
            }
          }
        }
      }
    }

    this.lastResult = {
      ts: Date.now(),
      winners: winners.map(w => ({
        ...w,
        hand: typeof w.hand === "object" ? (w.hand as any).label || "win" : w.hand,
        cards: inHand.find(p => p.idx === w.seat)?.seat?.cards as import("./dealer").Card[] | undefined,
      })),
      rake,
      reveal,
      winCards,
      proof: {
        serverSeedHash: this.serverSeedHash,
        serverSeed: this.serverSeed, // revealed now
        combinedHash: "",
        handNonce: this.handNonce,
      },
    };

    // Fire callback for on-chain settlement
    if (this.onHandComplete) {
      this.onHandComplete(this.lastResult, this.cfg.id);
    }

    this.emit();

    // Handle busted players (tracked timer so it can be cancelled)
    if (this.resultTimer) clearTimeout(this.resultTimer);
    const capturedHandId = this.handId;
    this.resultTimer = setTimeout(() => {
      this.resultTimer = null;
      // Only reset if this is still the same hand (no new hand started)
      if (this.handId !== capturedHandId) return;
      for (const seat of this.seats) {
        if (!seat) continue;
        if (seat.chips <= 0) {
          if (seat.isBot) {
            seat.chips = this.cfg.minBuyIn * 3;
          }
        }
      }
      this.resetHand();
    }, RESULT_SHOW_MS);
  }

  private resetHand(): void {
    this.handEnding = false;
    this.resultTimer = null;
    this.clearTurnTimer();
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    for (const seat of this.seats) {
      if (!seat) continue;
      seat.inHand = false;
      seat.cards = null;
      seat.bet = 0;
      seat.totalBet = 0;
      seat.isButton = false;
      seat.isTurn = false;
      seat.folded = false;
      seat.allIn = false;
      seat.lastAction = undefined;
    }
    this.pot = 0;
    this.board = [];
    this.street = null;
    this.handActive = false;
    this.actionSeat = null;
    this.currentBet = 0;
    // Generate new server seed for next hand
    const { serverSeed, serverSeedHash } = generateServerSeed();
    this.serverSeed = serverSeed;
    this.serverSeedHash = serverSeedHash;
    this.emit();
    this.maybeStartHand();
  }

  // ── Timers ───────────────────────────────────────────────────────────────────

  private startTurnTimer(): void {
    this.clearTurnTimer();
    this.turnTimer = setTimeout(() => {
      const seat = this.actionSeat;
      if (seat === null) return;
      const player = this.seats[seat];
      if (!player) return;
      // Auto-fold on timeout
      this.act(player.id, { type: "fold" });
    }, TURN_TIME_MS);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private activePlayers(): string[] {
    return this.seats
      .filter(s => s && !s.sittingOut && s.chips > 0)
      .map(s => s!.id);
  }

  private nextActiveSeat(from: number): number {
    for (let i = 1; i <= this.cfg.maxSeats; i++) {
      const idx = (from + i) % this.cfg.maxSeats;
      const seat = this.seats[idx];
      if (seat && seat.inHand && !seat.folded) return idx;
    }
    return from; // fallback
  }

  private minRaise(): number {
    const lastRaiseSize = this.currentBet - this.cfg.bb;
    return this.currentBet + Math.max(this.cfg.bb, lastRaiseSize);
  }

  private buildPots(): import("./types").Pot[] {
    if (this.pot === 0) return [];
    const activePlayers = this.seats
      .filter(s => s && s.inHand)
      .map(s => ({ id: s!.id, totalBet: s!.totalBet, folded: s!.folded }));
    const pots = calculateSidePots(activePlayers);
    if (pots.length === 0) return [{ amount: this.pot, eligiblePlayerIds: [], label: "Main Pot" }];
    return pots;
  }

  private shouldRevealCards(seat: Seat, seatIdx: number): boolean {
    // Reveal at showdown if player is still in hand
    return !!(this.lastResult?.reveal && seat.inHand && !seat.folded);
  }

  private makeSeat(id: string, name: string, chips: number, avatarUrl?: string): Seat {
    return {
      id, name, avatarUrl, chips,
      bet: 0, totalBet: 0,
      cards: null, folded: false, allIn: false,
      sittingOut: false, inHand: false,
      isButton: false, isTurn: false, isBot: false,
      idleMs: 0, lastActionTs: Date.now(),
    };
  }

  private logAction(seatIdx: number, label: string, amount?: number): void {
    const seat = this.seats[seatIdx];
    if (!seat) return;
    const entry: ActionLogEntry = {
      playerId: seat.id,
      name: seat.name,
      seat: seatIdx,
      label,
      amount,
      ts: Date.now(),
    };
    seat.lastAction = { label, amount, ts: Date.now() };
    seat.lastActionTs = Date.now();
    this.actionLog = [...this.actionLog.slice(-99), entry];
  }

  private emit(): void {
    this.version++;
    if (this.onStateChange) this.onStateChange(this);
  }

  destroy(): void {
    this.clearTurnTimer();
    if (this.handTimer) clearTimeout(this.handTimer);
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.endHandTimer) clearTimeout(this.endHandTimer);
  }
}
