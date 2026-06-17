"use client";

import type { LobbyTable } from "@/lib/engine/types";

interface LobbyProps {
  tables: LobbyTable[];
  onJoin: (tableId: string) => void;
  onWatch: (tableId: string) => void;
  isConnected: boolean;
  error?: string | null;
  cashoutMsg?: string | null;
}

const TIER_STYLES: Record<string, { accent: string; badge: string }> = {
  table1: { accent: "border-emerald-500/40 hover:border-emerald-400/70", badge: "bg-emerald-900/50 text-emerald-300" },
  table2: { accent: "border-cyan-500/40 hover:border-cyan-400/70",       badge: "bg-cyan-900/50 text-cyan-300" },
  table3: { accent: "border-violet-500/40 hover:border-violet-400/70",   badge: "bg-violet-900/50 text-violet-300" },
  table4: { accent: "border-yellow-500/40 hover:border-yellow-400/70",   badge: "bg-yellow-900/50 text-yellow-300" },
};

const TIER_LABELS: Record<string, string> = {
  table1: "ENTRY",
  table2: "STANDARD",
  table3: "HIGH ROLLER",
  table4: "WHALES ONLY",
};

function lamportsToSol(l: number) { return (l / 1e9).toFixed(3); }

export function Lobby({ tables, onJoin, onWatch, isConnected, error, cashoutMsg }: LobbyProps) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-100 mb-1">
          PICK A TABLE
        </h1>
        <p className="text-slate-400 text-sm">
          Real SOL on the line. Provably fair. WebSocket real-time.
        </p>
      </div>

      {cashoutMsg && (
        <div className="mb-4 px-4 py-3 bg-emerald-900/30 border border-emerald-700/40
          rounded-xl text-emerald-300 text-sm text-center">
          {cashoutMsg}
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-900/30 border border-red-700/40
          rounded-xl text-red-300 text-sm text-center">
          {error}
        </div>
      )}

      {!isConnected && (
        <div className="mb-4 px-4 py-2 bg-slate-800/60 border border-slate-700/40
          rounded-xl text-slate-400 text-xs text-center animate-pulse">
          Connecting to game server…
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {tables.length === 0 && isConnected && (
          [1,2,3,4].map(i => (
            <div key={i} className="h-44 rounded-2xl bg-slate-800/30 border border-slate-700/30 animate-pulse" />
          ))
        )}

        {tables.map((table) => {
          const style = TIER_STYLES[table.id] ?? TIER_STYLES.table1;
          const full = table.seated >= table.maxSeats;

          return (
            <div
              key={table.id}
              className={`relative flex flex-col p-5 rounded-2xl
                bg-slate-900 border ${style.accent} transition-all duration-200`}
            >
              {/* Tier badge */}
              <span className={`absolute top-4 right-4 px-2 py-0.5 rounded text-[10px] font-bold
                tracking-widest ${style.badge}`}>
                {TIER_LABELS[table.id] ?? ""}
              </span>

              <h3 className="text-lg font-bold text-slate-100 mb-1">{table.name}</h3>

              <div className="flex items-center gap-3 mb-3">
                <div className="text-xs text-slate-400 font-mono">
                  Blinds {lamportsToSol(table.sb)}/{lamportsToSol(table.bb)} SOL
                </div>
                {table.inHand && (
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                    <span className="text-[10px] text-red-400 font-medium">LIVE</span>
                  </div>
                )}
              </div>

              {/* Seat pips */}
              <div className="flex items-center gap-1.5 mb-4">
                {Array.from({ length: table.maxSeats }).map((_, i) => (
                  <div
                    key={i}
                    className={`w-2 h-2 rounded-full transition-colors
                      ${i < table.seated ? "bg-indigo-400" : "bg-slate-700"}`}
                  />
                ))}
                <span className="text-xs text-slate-500 ml-1">
                  {table.seated}/{table.maxSeats}
                </span>
              </div>

              <div className="text-xs text-slate-500 mb-4">
                Buy-in: {table.minSol}–{table.maxSol} SOL
              </div>

              <div className="flex gap-2 mt-auto">
                <button
                  onClick={() => onJoin(table.id)}
                  disabled={full || !isConnected}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all
                    active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed
                    ${full
                      ? "bg-slate-800 text-slate-500 border border-slate-700"
                      : "bg-indigo-700 text-white hover:bg-indigo-600 border border-indigo-600"
                    }`}
                >
                  {full ? "FULL" : `BUY IN FROM ${table.minSol} SOL`}
                </button>
                <button
                  onClick={() => onWatch(table.id)}
                  disabled={!isConnected}
                  className="px-3 py-2 rounded-lg text-sm text-slate-400
                    border border-slate-700 hover:border-slate-500 hover:text-slate-200
                    transition-all disabled:opacity-40"
                >
                  WATCH
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-slate-600 mt-6">
        Buy-ins are non-refundable. Winnings paid on cashout. 5% rake burned as $ALLIN.
      </p>
    </div>
  );
}
