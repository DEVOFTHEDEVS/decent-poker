"use client";

import { PlayingCard } from "./PlayingCard";
import type { ClientSeat } from "@/lib/engine/types";
import type { Card } from "@/lib/engine/dealer";

interface SeatProps {
  seat: ClientSeat;
  seatIndex: number;
  isMe: boolean;
  isWinner: boolean;
  winCards?: Set<string>;
  bb: number;
  onKick?: () => void;
  canKick?: boolean;
  style?: React.CSSProperties;
}

function lamportsToSol(l: number) {
  return (l / 1e9).toFixed(4);
}

export function Seat({
  seat, seatIndex, isMe, isWinner, winCards, bb, onKick, canKick, style
}: SeatProps) {
  const cards = seat.cards;
  const isActive = seat.isTurn;

  return (
    <div
      className={`absolute transform -translate-x-1/2 -translate-y-1/2
        flex flex-col items-center gap-1 transition-all duration-200
        ${isActive ? "z-20" : "z-10"}
        ${seat.folded ? "opacity-40" : "opacity-100"}
      `}
      style={style}
    >
      {/* Bet stack above seat */}
      {seat.bet > 0 && (
        <div className="flex flex-col items-center mb-1">
          <div className="flex gap-0.5">
            {Array.from({ length: Math.min(5, Math.max(1, Math.ceil(seat.bet / (bb * 5)))) }).map((_, i) => (
              <div key={i} className="w-3 h-3 rounded-full bg-yellow-400 border border-yellow-300 shadow" />
            ))}
          </div>
          <span className="text-[10px] text-yellow-300 font-mono mt-0.5">
            {lamportsToSol(seat.bet)} SOL
          </span>
        </div>
      )}

      {/* Last action badge */}
      {seat.lastAction && Date.now() - seat.lastAction.ts < 3500 && (
        <div className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide mb-1
          ${seat.lastAction.label === "FOLD" ? "bg-red-900/80 text-red-300" :
            seat.lastAction.label === "CHECK" ? "bg-slate-700/80 text-slate-300" :
            seat.lastAction.label === "ALL-IN" ? "bg-orange-900/80 text-orange-300" :
            "bg-indigo-900/80 text-indigo-300"}`}>
          {seat.lastAction.label}
          {seat.lastAction.amount ? ` ${lamportsToSol(seat.lastAction.amount)}` : ""}
        </div>
      )}

      {/* Cards */}
      <div className="flex gap-1">
        {cards === "back" ? (
          <>
            <PlayingCard card="back" small />
            <PlayingCard card="back" small />
          </>
        ) : Array.isArray(cards) ? (
          cards.map((c, i) => (
            <PlayingCard
              key={i}
              card={c}
              small
              highlight={winCards?.has(c.r + c.s)}
            />
          ))
        ) : (
          <>
            <div className="w-9 h-12 rounded border border-slate-700/30" />
            <div className="w-9 h-12 rounded border border-slate-700/30" />
          </>
        )}
      </div>

      {/* Player pod */}
      <div className={`flex items-center gap-2 px-2 py-1 rounded-lg
        ${isActive
          ? "bg-indigo-950 border-2 border-indigo-400 shadow-lg shadow-indigo-500/30"
          : isWinner
            ? "bg-emerald-950 border-2 border-emerald-400 shadow-lg shadow-emerald-500/30"
            : isMe
              ? "bg-slate-800 border border-slate-500"
              : "bg-slate-900 border border-slate-700/50"}
        min-w-[90px]`}>

        {/* Avatar */}
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
          flex-shrink-0 relative
          ${isMe ? "bg-indigo-700 text-indigo-100" : "bg-slate-700 text-slate-300"}`}>
          {seat.avatarUrl ? (
            <img src={seat.avatarUrl} alt={seat.name} className="w-full h-full rounded-full object-cover" />
          ) : (
            (seat.name || "?")[0].toUpperCase()
          )}
          {seat.isButton && (
            <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full
              bg-yellow-400 text-yellow-900 text-[9px] font-black flex items-center justify-center">
              D
            </span>
          )}
          {/* Timer ring */}
          {isActive && (
            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="16" fill="none" stroke="rgba(99,102,241,0.3)" strokeWidth="2" />
              <circle cx="18" cy="18" r="16" fill="none" stroke="#818cf8" strokeWidth="2"
                strokeDasharray="100.5" strokeDashoffset="0"
                className="animate-[countdown_45s_linear_forwards]" />
            </svg>
          )}
        </div>

        {/* Name + chips */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1">
            <span className={`text-[11px] font-semibold truncate max-w-[60px]
              ${isMe ? "text-indigo-300" : "text-slate-200"}`}>
              {seat.name}
            </span>
            {seat.isBot && (
              <span className="text-[9px] text-slate-500 font-mono">BOT</span>
            )}
          </div>
          <span className="text-[10px] text-yellow-300/80 font-mono">
            {lamportsToSol(seat.chips)} SOL
          </span>
        </div>
      </div>

      {/* Badges */}
      <div className="flex gap-1">
        {seat.allIn && (
          <span className="px-1.5 py-0.5 bg-orange-500/20 text-orange-300 text-[9px] font-bold rounded">
            ALL-IN
          </span>
        )}
        {seat.sittingOut && !seat.inHand && (
          <span className="px-1.5 py-0.5 bg-slate-700/50 text-slate-400 text-[9px] rounded">
            AWAY
          </span>
        )}
      </div>

      {/* Kick idle player */}
      {canKick && seat.idleMs > 20_000 && (
        <button
          onClick={onKick}
          className="px-2 py-0.5 text-[9px] bg-red-900/50 text-red-400 rounded
            hover:bg-red-800/70 transition-colors"
        >
          KICK
        </button>
      )}
    </div>
  );
}

export function EmptySeat({
  style, onClick, canSit
}: {
  style?: React.CSSProperties;
  onClick?: () => void;
  canSit?: boolean;
}) {
  return (
    <div
      className="absolute transform -translate-x-1/2 -translate-y-1/2 z-10"
      style={style}
    >
      {canSit ? (
        <button
          onClick={onClick}
          className="w-16 h-16 rounded-full border-2 border-dashed border-indigo-500/40
            text-indigo-400/60 text-xs hover:border-indigo-400 hover:text-indigo-300
            transition-all hover:scale-105 active:scale-95"
        >
          SIT
        </button>
      ) : (
        <div className="w-12 h-12 rounded-full border border-slate-700/30 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-slate-700/50" />
        </div>
      )}
    </div>
  );
}
