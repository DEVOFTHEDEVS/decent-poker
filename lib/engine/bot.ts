/**
 * Bot Player AI
 *
 * Simple but believable poker bots with distinct personalities.
 * Each bot evaluates its hand strength and picks an action with
 * some randomness to avoid being predictable.
 *
 * Personalities:
 * - Tight:     folds weak hands, bets strong ones, rarely bluffs
 * - Loose:     calls a lot, sees many flops, moderate aggression
 * - Aggressive: raises frequently, puts pressure on opponents
 * - Maniac:    raises and bluffs constantly, hard to read
 */

import { evaluateHand, getHandHint } from "./evaluator";
import type { Card } from "./dealer";

export type BotPersonality = "tight" | "loose" | "aggressive" | "maniac";

export interface BotDecision {
  type: "fold" | "check" | "call" | "raise" | "allin";
  amount?: number;
}

export interface BotContext {
  holeCards: Card[];
  board: Card[];
  pot: number;
  toCall: number;
  minRaise: number;
  maxRaise: number;
  canCheck: boolean;
  myChips: number;
  myBet: number;
  currentBet: number;
  bb: number;
  activePlayers: number;    // players still in hand
  position: "early" | "middle" | "late" | "blinds";
  street: string;
}

// ── Hand Strength ─────────────────────────────────────────────────────────────

/** Returns 0-1 score of hand strength */
function handStrength(ctx: BotContext): number {
  const { holeCards, board } = ctx;
  if (holeCards.length < 2) return 0;

  if (board.length === 0) {
    // Pre-flop: use hole card rankings
    return preFlopStrength(holeCards);
  }

  // Post-flop: evaluate actual hand
  try {
    const result = evaluateHand([...holeCards, ...board]);
    // rank 0-8, normalize to 0-1 with curve
    const base = result.rank / 8;
    // Boost for strong made hands
    if (result.rank >= 6) return 0.9 + base * 0.1;
    if (result.rank >= 4) return 0.65 + (result.rank - 4) / 2 * 0.25;
    if (result.rank >= 2) return 0.35 + (result.rank - 2) / 2 * 0.3;
    if (result.rank === 1) return 0.2 + result.tiebreakers[0] / 12 * 0.15;
    return 0.05 + result.tiebreakers[0] / 12 * 0.15; // high card
  } catch {
    return 0.2;
  }
}

function preFlopStrength(cards: Card[]): number {
  const [a, b] = cards;
  const RANKS = "23456789TJQKA";
  const r1 = RANKS.indexOf(a.r);
  const r2 = RANKS.indexOf(b.r);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const paired = r1 === r2;
  const suited = a.s === b.s;
  const gap = hi - lo;

  // Premium hands
  if (paired && hi >= 10) return 0.9 + hi / 120; // AA, KK, QQ, JJ
  if (paired && hi >= 7)  return 0.7 + hi / 130; // 99 down to 88
  if (paired)             return 0.5 + hi / 130; // small pairs
  if (hi === 12 && lo >= 9) return 0.75;          // AK, AQ, AJ suited/off
  if (hi === 12 && suited)  return 0.65;          // Axs
  if (suited && gap <= 1 && lo >= 8) return 0.6;  // connected broadway suited
  if (hi >= 11 && lo >= 9) return 0.55;           // KQ, KJ, QJ
  if (suited && gap <= 2)  return 0.45;
  if (gap === 0)           return 0.35;
  if (hi >= 10)            return 0.3;
  return 0.15 + lo / 130;
}

// ── Pot Odds ──────────────────────────────────────────────────────────────────

function potOdds(ctx: BotContext): number {
  if (ctx.toCall === 0) return 1;
  return ctx.pot / (ctx.pot + ctx.toCall);
}

// ── Bot Decision ─────────────────────────────────────────────────────────────

export function makeBotDecision(ctx: BotContext, personality: BotPersonality): BotDecision {
  const strength = handStrength(ctx);
  const odds = potOdds(ctx);
  const rand = Math.random();

  // Position bonus
  const posMult = ctx.position === "late" ? 1.1 :
                  ctx.position === "blinds" ? 0.95 : 1.0;
  const adjStrength = Math.min(1, strength * posMult);

  // Personality-based thresholds
  const thresholds = getThresholds(personality, ctx.street);

  // Add some randomness based on personality
  const noise = () => (rand - 0.5) * thresholds.noiseFactor;
  const effectiveStr = Math.max(0, Math.min(1, adjStrength + noise()));

  // --- Can check (no bet to call) ---
  if (ctx.canCheck) {
    if (effectiveStr >= thresholds.betStrong) {
      // Value bet
      const amount = calcBetSize(ctx, effectiveStr, thresholds, personality);
      return { type: "raise", amount };
    }
    if (effectiveStr >= thresholds.betMedium && rand < thresholds.betFreq) {
      const amount = calcBetSize(ctx, effectiveStr, thresholds, personality);
      return { type: "raise", amount };
    }
    // Bluff occasionally
    if (rand < thresholds.bluffFreq) {
      const amount = Math.min(ctx.maxRaise, ctx.pot);
      return { type: "raise", amount };
    }
    return { type: "check" };
  }

  // --- Facing a bet ---
  const callRatio = ctx.toCall / ctx.myChips;

  // Strong hand — raise or call
  if (effectiveStr >= thresholds.raiseStr) {
    if (rand < thresholds.raiseFreq) {
      const amount = calcBetSize(ctx, effectiveStr, thresholds, personality);
      return { type: "raise", amount };
    }
    return { type: "call" };
  }

  // Medium hand — call if pot odds are right
  if (effectiveStr >= thresholds.callStr) {
    if (effectiveStr >= odds || callRatio < thresholds.maxCallRatio) {
      return { type: "call" };
    }
  }

  // Bluff raise
  if (rand < thresholds.bluffFreq && ctx.activePlayers <= 2) {
    const amount = Math.min(ctx.maxRaise, Math.floor(ctx.pot * 0.75));
    if (amount >= ctx.minRaise) return { type: "raise", amount };
  }

  // Fold
  return { type: "fold" };
}

function getThresholds(p: BotPersonality, street: string) {
  const base = {
    tight:      { betStrong: 0.7, betMedium: 0.55, betFreq: 0.4, raiseStr: 0.65, callStr: 0.45, raiseFreq: 0.5, bluffFreq: 0.05, maxCallRatio: 0.15, betSizeMult: 0.75, noiseFactor: 0.08 },
    loose:      { betStrong: 0.55, betMedium: 0.4, betFreq: 0.5, raiseStr: 0.5,  callStr: 0.3,  raiseFreq: 0.4, bluffFreq: 0.1,  maxCallRatio: 0.3,  betSizeMult: 0.6,  noiseFactor: 0.12 },
    aggressive: { betStrong: 0.5, betMedium: 0.35, betFreq: 0.65, raiseStr: 0.45, callStr: 0.35, raiseFreq: 0.7, bluffFreq: 0.15, maxCallRatio: 0.25, betSizeMult: 1.0,  noiseFactor: 0.1 },
    maniac:     { betStrong: 0.35, betMedium: 0.2, betFreq: 0.8, raiseStr: 0.3,  callStr: 0.2,  raiseFreq: 0.8, bluffFreq: 0.3,  maxCallRatio: 0.5,  betSizeMult: 1.2,  noiseFactor: 0.15 },
  };
  return base[p];
}

function calcBetSize(ctx: BotContext, strength: number, thresholds: any, personality: BotPersonality): number {
  // Size bet proportional to hand strength and pot
  const potFraction = 0.5 + strength * thresholds.betSizeMult;
  const amount = Math.floor(ctx.currentBet + ctx.pot * potFraction);
  return Math.max(ctx.minRaise, Math.min(ctx.maxRaise, amount));
}

// ── Bot Names & Personalities ─────────────────────────────────────────────────

export const BOT_ROSTER: Array<{ name: string; personality: BotPersonality; emoji: string }> = [
  { name: "Nitro",    personality: "tight",      emoji: "🧊" },
  { name: "Fishbowl", personality: "loose",      emoji: "🐟" },
  { name: "Blaze",    personality: "aggressive", emoji: "🔥" },
  { name: "Chaos",    personality: "maniac",     emoji: "🌪️" },
  { name: "Grinder",  personality: "tight",      emoji: "⚙️" },
  { name: "Gambit",   personality: "aggressive", emoji: "♟️" },
  { name: "Lucky",    personality: "loose",      emoji: "🍀" },
  { name: "Wild",     personality: "maniac",     emoji: "🎰" },
];
