"use client";

import { useMemo } from "react";
import { PlayingCard } from "./PlayingCard";
import { Seat, EmptySeat } from "./Seat";
import type { ClientTableState } from "@/lib/engine/types";

interface PokerTableProps {
  table: ClientTableState;
  onSitDown?: () => void;
  onKick?: (playerId: string) => void;
}

function lamportsToSol(l: number) {
  return (l / 1e9).toFixed(4);
}

function seatPosition(seatIndex: number, myIndex: number, totalSeats: number) {
  // Rotate so "my" seat is always at the bottom center
  const rotated = (seatIndex - myIndex + totalSeats) % totalSeats;
  const angle = (270 + (360 / totalSeats) * rotated) * (Math.PI / 180);
  return {
    left: `${50 + 44 * Math.cos(angle)}%`,
    top: `${52 + 40 * Math.sin(angle)}%`,
  };
}

export function PokerTableView({ table, onSitDown, onKick }: PokerTableProps) {
  const myIndex = table.you?.seat ?? 0;
  const maxSeats = table.maxSeats;

  const winCards = useMemo(() => {
    const wc = table.lastResult?.winCards;
    return wc?.length ? new Set(wc) : null;
  }, [table.lastResult]);

  const street = table.street?.toUpperCase() ?? "";

  return (
    <div className="relative w-full" style={{ paddingBottom: "60%" }}>
      {/* Felt surface */}
      <div className="absolute inset-0 rounded-[40%] overflow-hidden
        bg-gradient-to-b from-emerald-900 to-emerald-950
        border-[12px] border-yellow-900/60 shadow-2xl shadow-black/60">

        {/* Felt texture overlay */}
        <div className="absolute inset-0 opacity-20"
          style={{ backgroundImage: "radial-gradient(circle at 50% 50%, rgba(255,255,255,0.03) 0%, transparent 70%)" }} />

        {/* Rail inner shadow */}
        <div className="absolute inset-0 rounded-[36%] shadow-inner shadow-black/40" />

        {/* Table center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">

          {/* Street badge */}
          {table.handActive && street && (
            <div className="px-3 py-0.5 bg-black/30 rounded-full
              text-emerald-300/60 text-xs font-mono tracking-widest">
              {street}
            </div>
          )}

          {/* Community cards */}
          <div className="flex items-center gap-2">
            {(table.board || []).map((card, i) => (
              <div key={i} className="animate-[dealCard_0.3s_ease-out]" style={{ animationDelay: `${i * 80}ms` }}>
                <PlayingCard
                  card={card}
                  highlight={winCards?.has(card.r + card.s)}
                />
              </div>
            ))}
            {/* Placeholders */}
            {Array.from({ length: 5 - (table.board?.length ?? 0) }).map((_, i) => (
              <div key={`ph${i}`}
                className="w-14 h-20 rounded-lg border border-emerald-700/20 bg-emerald-900/20" />
            ))}
          </div>

          {/* Pot */}
          {table.pot > 0 && (
            <div className="flex items-center gap-2">
              {table.pots?.length > 1 ? (
                table.pots.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5 px-3 py-1 bg-black/40 rounded-full">
                    <PotChips />
                    <div className="flex flex-col">
                      <span className="text-[10px] text-emerald-400/60 font-mono">{p.label}</span>
                      <span className="text-xs text-yellow-300 font-mono font-bold">
                        {lamportsToSol(p.amount)} SOL
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-black/40 rounded-full">
                  <PotChips />
                  <span className="text-sm text-yellow-300 font-mono font-bold">
                    {lamportsToSol(table.pot)} SOL
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Watermark */}
          {!table.handActive && (
            <div className="text-emerald-700/20 text-3xl font-black tracking-widest select-none">
              {table.seated >= 2 ? "NEXT HAND SOON" : "WAITING FOR PLAYERS"}
            </div>
          )}
        </div>
      </div>

      {/* Seats positioned around the table */}
      <div className="absolute inset-0">
        {table.seats.map((seat, i) => {
          const pos = seatPosition(i, myIndex, maxSeats);
          const isMe = i === table.you?.seat;
          const isWinner = !!(table.lastResult?.winners.some(w => w.seat === i));

          if (!seat) {
            return (
              <EmptySeat
                key={i}
                style={pos}
                canSit={!!table.you === false && !!onSitDown}
                onClick={onSitDown}
              />
            );
          }

          return (
            <Seat
              key={i}
              seat={seat}
              seatIndex={i}
              isMe={isMe}
              isWinner={isWinner}
              winCards={winCards ?? undefined}
              bb={table.bb}
              canKick={!isMe && !seat.isBot && !!table.you}
              onKick={() => onKick?.(seat.id)}
              style={pos}
            />
          );
        })}
      </div>

      {/* Hand result overlay */}
      {table.lastResult && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full pt-3
          flex flex-col items-center gap-1 z-30">
          <div className="px-4 py-2 bg-slate-900/95 border border-slate-700 rounded-xl
            text-sm text-slate-100 text-center max-w-sm shadow-xl">
            <span className="text-xs text-slate-400 font-mono mr-2">
              {table.lastResult.reveal ? "SHOWDOWN" : "WINNER"}
            </span>
            {table.lastResult.winners.map((w, i) => (
              <span key={i} className="text-yellow-300 font-medium">
                {w.name} +{lamportsToSol(w.amount)} SOL
                {w.hand && w.hand !== "win" && w.hand !== "(everyone folded)" &&
                  <span className="text-slate-400 ml-1">· {w.hand}</span>}
              </span>
            )).reduce((a, b) => <>{a} &nbsp; {b}</>)}
            {table.lastResult.rake > 0 && (
              <span className="ml-2 text-[10px] text-orange-400/70 font-mono">
                BURN {lamportsToSol(table.lastResult.rake)} SOL
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PotChips() {
  return (
    <div className="relative w-6 h-6">
      {[0, 1, 2].map(i => (
        <div key={i}
          className="absolute w-5 h-5 rounded-full bg-gradient-to-b from-yellow-300 to-yellow-500
            border border-yellow-200/50 shadow"
          style={{ bottom: `${i * 2}px`, left: `${i}px` }} />
      ))}
    </div>
  );
}
