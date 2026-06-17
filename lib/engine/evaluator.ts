/**
 * 7-Card Hand Evaluator
 *
 * Evaluates the best 5-card poker hand from any 7 cards (hole + board).
 * Returns a numeric score for comparison and a human-readable label.
 *
 * Hand rankings (higher = better):
 * 8 = Straight Flush
 * 7 = Four of a Kind
 * 6 = Full House
 * 5 = Flush
 * 4 = Straight
 * 3 = Three of a Kind
 * 2 = Two Pair
 * 1 = One Pair
 * 0 = High Card
 */

import type { Card } from "./dealer";

export interface HandResult {
  rank: number;          // 0-8
  label: string;         // "Full House", "Flush", etc.
  score: number;         // numeric score for comparison (higher = better)
  bestFive: Card[];      // the 5 cards that make the best hand
  tiebreakers: number[]; // for breaking ties within same rank
}

const RANK_ORDER = "23456789TJQKA";
const RANK_LABELS = [
  "High Card",
  "One Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
];

/** Evaluate the best hand from 7 cards */
export function evaluateHand(cards: Card[]): HandResult {
  if (cards.length < 5) throw new Error("Need at least 5 cards");

  const combos = choose5(cards);
  let best: HandResult | null = null;

  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || result.score > best.score) {
      best = result;
    }
  }

  return best!;
}

/** Get all C(n,5) combinations of 5 cards from n cards */
function choose5(cards: Card[]): Card[][] {
  const result: Card[][] = [];
  const n = cards.length;

  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++)
            result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);

  return result;
}

/** Evaluate exactly 5 cards */
function evaluate5(cards: Card[]): HandResult {
  const ranks = cards.map(c => RANK_ORDER.indexOf(c.r)).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);

  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(ranks);

  // count rank frequencies
  const freq: Record<number, number> = {};
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
  const counts = Object.values(freq).sort((a, b) => b - a); // e.g. [3,1,1] for trips
  const sortedByFreq = Object.entries(freq)
    .sort((a, b) => b[1] - a[1] || parseInt(b[0]) - parseInt(a[0]))
    .flatMap(([r, count]) => Array(count as number).fill(parseInt(r)))
    .slice(0, 5);

  let handRank: number;
  let tiebreakers: number[];

  if (isFlush && isStraight) {
    handRank = 8; // Straight Flush
    tiebreakers = [isStraight.highCard];
  } else if (counts[0] === 4) {
    handRank = 7; // Four of a Kind
    tiebreakers = sortedByFreq;
  } else if (counts[0] === 3 && counts[1] === 2) {
    handRank = 6; // Full House
    tiebreakers = sortedByFreq;
  } else if (isFlush) {
    handRank = 5; // Flush
    tiebreakers = ranks;
  } else if (isStraight) {
    handRank = 4; // Straight
    tiebreakers = [isStraight.highCard];
  } else if (counts[0] === 3) {
    handRank = 3; // Three of a Kind
    tiebreakers = sortedByFreq;
  } else if (counts[0] === 2 && counts[1] === 2) {
    handRank = 2; // Two Pair
    tiebreakers = sortedByFreq;
  } else if (counts[0] === 2) {
    handRank = 1; // One Pair
    tiebreakers = sortedByFreq;
  } else {
    handRank = 0; // High Card
    tiebreakers = ranks;
  }

  // encode score: rank * 10^10 + tiebreaker chain
  const score = encodeScore(handRank, tiebreakers);

  return {
    rank: handRank,
    label: RANK_LABELS[handRank],
    score,
    bestFive: cards,
    tiebreakers,
  };
}

function checkStraight(sortedRanks: number[]): { highCard: number } | null {
  // Check for A-2-3-4-5 (wheel) — ace plays low
  const ranks = [...new Set(sortedRanks)];
  
  // Normal straight check
  if (ranks.length >= 5) {
    for (let i = 0; i <= ranks.length - 5; i++) {
      const slice = ranks.slice(i, i + 5);
      if (slice[0] - slice[4] === 4) {
        return { highCard: slice[0] };
      }
    }
  }

  // Wheel: A-2-3-4-5 (A=12, 2=0, 3=1, 4=2, 5=3)
  if (ranks.includes(12) && ranks.includes(0) && ranks.includes(1) &&
      ranks.includes(2) && ranks.includes(3)) {
    return { highCard: 3 }; // 5-high straight
  }

  return null;
}

function encodeScore(handRank: number, tiebreakers: number[]): number {
  // Use base-13 encoding (ranks 0-12) with enough slots for 5 tiebreakers
  // hand rank * 13^5 ensures hand category always dominates
  let score = handRank * Math.pow(13, 5);
  for (let i = 0; i < Math.min(tiebreakers.length, 5); i++) {
    score += tiebreakers[i] * Math.pow(13, 4 - i);
  }
  return score;
}

/** Compare two hand results. Returns positive if a wins, negative if b wins, 0 for tie. */
export function compareHands(a: HandResult, b: HandResult): number {
  return a.score - b.score;
}

/**
 * Determine winners from a set of active players at showdown.
 * Handles split pots (ties).
 */
export interface ShowdownPlayer {
  id: string;
  name: string;
  holeCards: Card[];
  chips: number;
  bet: number; // total bet this hand (for side pot calculation)
}

export interface ShowdownResult {
  winners: Array<{
    id: string;
    name: string;
    hand: HandResult;
    amount: number; // chips won
  }>;
  everyoneFolded: boolean;
}

export function runShowdown(
  players: ShowdownPlayer[],
  board: Card[],
  pot: number
): ShowdownResult {
  if (players.length === 0) throw new Error("No players in showdown");

  if (players.length === 1) {
    return {
      winners: [{ id: players[0].id, name: players[0].name, hand: { rank: -1, label: "Everyone folded", score: -1, bestFive: [], tiebreakers: [] }, amount: pot }],
      everyoneFolded: true,
    };
  }

  // Evaluate each player's best hand
  const evaluated = players.map(p => ({
    ...p,
    result: evaluateHand([...p.holeCards, ...board]),
  }));

  // Sort by score descending
  evaluated.sort((a, b) => compareHands(b.result, a.result));

  // Find all winners (could be a tie)
  const topScore = evaluated[0].result.score;
  const winners = evaluated.filter(p => p.result.score === topScore);

  const amountPerWinner = Math.floor(pot / winners.length);
  const remainder = pot - amountPerWinner * winners.length;

  return {
    winners: winners.map((w, i) => ({
      id: w.id,
      name: w.name,
      hand: w.result,
      amount: amountPerWinner + (i === 0 ? remainder : 0), // odd chip to first winner
    })),
    everyoneFolded: false,
  };
}

/**
 * Calculate side pots when players are all-in for different amounts.
 * Returns an array of pots with eligible players for each.
 */
export interface SidePot {
  amount: number;
  eligiblePlayerIds: string[];
  label: string;
}

export function calculateSidePots(
  players: Array<{ id: string; totalBet: number; folded: boolean }>
): SidePot[] {
  const active = players.filter(p => !p.folded || p.totalBet > 0);
  const bets = [...new Set(active.map(p => p.totalBet))].sort((a, b) => a - b);

  const pots: SidePot[] = [];
  let prevLevel = 0;

  for (let i = 0; i < bets.length; i++) {
    const level = bets[i];
    const contribution = level - prevLevel;
    if (contribution === 0) continue;

    const eligible = active.filter(p => p.totalBet >= level && !p.folded);
    const contributors = active.filter(p => p.totalBet >= level);

    const amount = contribution * contributors.length;
    if (amount > 0) {
      pots.push({
        amount,
        eligiblePlayerIds: eligible.map(p => p.id),
        label: i === 0 ? "Main Pot" : `Side Pot ${i}`,
      });
    }

    prevLevel = level;
  }

  return pots;
}

/** Quick hand strength hint for the UI (pre-showdown, client-side) */
export function getHandHint(holeCards: Card[], board: Card[]): string {
  if (holeCards.length < 2) return "";

  const all = [...holeCards, ...board];
  if (all.length < 2) return "";

  if (board.length === 0) {
    // Pre-flop hints
    const [a, b] = holeCards;
    if (a.r === b.r) return "Pocket Pair";
    const suited = a.s === b.s ? " Suited" : "";
    const ri = RANK_ORDER.indexOf(a.r);
    const rj = RANK_ORDER.indexOf(b.r);
    if (Math.abs(ri - rj) === 1) return `Connectors${suited}`;
    if (ri >= 10 || rj >= 10) return `High Cards${suited}`;
    return suited ? "Suited" : "";
  }

  // Post-flop — return best current hand
  try {
    const result = evaluateHand(all);
    return result.label;
  } catch {
    return "";
  }
}
