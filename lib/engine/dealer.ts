/**
 * Provably Fair Dealer
 *
 * How it works:
 * 1. Before a hand, server generates a secret seed and publishes its SHA-256 hash
 * 2. Each player submits their own seed when joining
 * 3. Deck = deterministic shuffle of sha256(serverSeed + sortedPlayerSeeds + handNonce)
 * 4. After hand ends, server reveals serverSeed — anyone can verify the shuffle
 *
 * This makes it impossible for the server to cheat post-commitment, and impossible
 * for players to predict the deck before they submit their seed.
 */

import { createHash, randomBytes } from "crypto";

export interface Card {
  r: string; // rank: 2-9, T, J, Q, K, A
  s: string; // suit: ♠ ♥ ♦ ♣
  red: boolean;
}

export interface DeckSeed {
  serverSeed: string;       // secret, revealed after hand
  serverSeedHash: string;   // published before hand starts
  playerSeeds: string[];    // submitted by players
  handNonce: number;        // increments each hand at this table
  combinedHash: string;     // final hash used to shuffle
}

const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];
const RED_SUITS = new Set(["♥","♦"]);

/** Build a fresh 52-card deck in canonical order */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ r, s, red: RED_SUITS.has(s) });
    }
  }
  return deck;
}

/** Generate a new server seed for a hand */
export function generateServerSeed(): { serverSeed: string; serverSeedHash: string } {
  const serverSeed = randomBytes(32).toString("hex");
  const serverSeedHash = sha256(serverSeed);
  return { serverSeed, serverSeedHash };
}

/** Combine server seed + player seeds + nonce into the shuffle seed */
export function buildCombinedSeed(
  serverSeed: string,
  playerSeeds: string[],
  handNonce: number
): string {
  const sorted = [...playerSeeds].sort(); // order-independent
  const combined = [serverSeed, ...sorted, handNonce.toString()].join("|");
  return sha256(combined);
}

/**
 * Fisher-Yates shuffle using HMAC-derived bytes for randomness.
 * Each swap uses a fresh hash slice so we never run out of entropy.
 */
export function shuffleDeck(deck: Card[], combinedSeed: string): Card[] {
  const shuffled = [...deck];
  const n = shuffled.length;

  for (let i = n - 1; i > 0; i--) {
    // derive a random index in [0, i] from the seed + position
    const bytes = sha256(`${combinedSeed}:${i}`);
    const rand = hexToUint32(bytes) % (i + 1);
    [shuffled[i], shuffled[rand]] = [shuffled[rand], shuffled[i]];
  }

  return shuffled;
}

/** Full provably fair deal — returns shuffled deck + proof material */
export function dealProvablyFair(
  serverSeed: string,
  playerSeeds: string[],
  handNonce: number
): { deck: Card[]; proof: DeckSeed } {
  const serverSeedHash = sha256(serverSeed);
  const combinedHash = buildCombinedSeed(serverSeed, playerSeeds, handNonce);
  const deck = shuffleDeck(buildDeck(), combinedHash);

  return {
    deck,
    proof: {
      serverSeed,         // revealed now (post-commitment)
      serverSeedHash,
      playerSeeds,
      handNonce,
      combinedHash,
    },
  };
}

/**
 * Client-side verification — anyone can call this after the hand
 * to confirm the deck was dealt fairly.
 */
export function verifyDeal(proof: DeckSeed): {
  valid: boolean;
  reason?: string;
  deck?: Card[];
} {
  // 1. Verify server seed matches its pre-committed hash
  if (sha256(proof.serverSeed) !== proof.serverSeedHash) {
    return { valid: false, reason: "Server seed does not match published hash" };
  }

  // 2. Reconstruct the combined hash
  const expectedCombined = buildCombinedSeed(
    proof.serverSeed,
    proof.playerSeeds,
    proof.handNonce
  );
  if (expectedCombined !== proof.combinedHash) {
    return { valid: false, reason: "Combined hash mismatch" };
  }

  // 3. Re-shuffle and return the deck for comparison
  const deck = shuffleDeck(buildDeck(), proof.combinedHash);
  return { valid: true, deck };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hexToUint32(hex: string): number {
  return parseInt(hex.slice(0, 8), 16);
}
