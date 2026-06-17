"use client";

import { useState, useEffect } from "react";
import type { YouState, ClientTableState } from "@/lib/engine/types";
import type { Action } from "@/lib/engine/types";

interface ActionPanelProps {
  you: YouState;
  table: ClientTableState;
  onAct: (action: Action) => void;
}

function lamportsToSol(l: number) {
  return (l / 1e9).toFixed(4);
}

export function ActionPanel({ you, table, onAct }: ActionPanelProps) {
  const [raiseAmount, setRaiseAmount] = useState(you.minRaiseTo);
  const [autoAction, setAutoAction] = useState<"checkfold" | "callany" | "check" | null>(null);
  const [timeLeft, setTimeLeft] = useState(45);
  const turnStartRef = useState(() => Date.now())[0];

  // Turn countdown
  useEffect(() => {
    if (!you.myTurn) { setTimeLeft(45); return; }
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      setTimeLeft(Math.max(0, 45 - elapsed));
    }, 500);
    return () => clearInterval(interval);
  }, [you.myTurn]);

  // Snap raise to valid range
  useEffect(() => {
    if (you.myTurn) {
      setRaiseAmount(Math.min(you.minRaiseTo, you.maxRaiseTo));
    }
  }, [you.myTurn, you.minRaiseTo, you.maxRaiseTo]);

  // Auto-act when it's our turn
  useEffect(() => {
    if (!you.myTurn || !autoAction) return;
    if (autoAction === "checkfold") {
      onAct(you.canCheck ? { type: "check" } : { type: "fold" });
    } else if (autoAction === "callany") {
      onAct(you.canCheck ? { type: "check" } : { type: "call" });
    } else if (autoAction === "check" && you.canCheck) {
      onAct({ type: "check" });
    }
    setAutoAction(null);
  }, [you.myTurn, autoAction]);

  const pot = table.pot;
  const currentBet = table.currentBet;
  const min = Math.min(you.minRaiseTo, you.maxRaiseTo);
  const max = you.maxRaiseTo;

  const presets = [
    { label: "Min",    amount: min },
    { label: "½ Pot",  amount: Math.max(min, Math.min(max, currentBet + Math.floor(pot * 0.5))) },
    { label: "¾ Pot",  amount: Math.max(min, Math.min(max, currentBet + Math.floor(pot * 0.75))) },
    { label: "Pot",    amount: Math.max(min, Math.min(max, currentBet + pot)) },
    { label: "All-in", amount: max },
  ];

  const canRaise = you.maxRaiseTo > currentBet;

  if (!you.myTurn) {
    // Waiting — show auto-action buttons
    return (
      <div className="flex flex-col items-center gap-3 py-3">
        <p className="text-slate-400 text-sm">
          {table.handActive ? "Waiting for your turn…" : "Next hand coming up…"}
        </p>
        {table.handActive && you.inHand && (
          <div className="flex gap-2">
            {(["checkfold", "callany", "check"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAutoAction(autoAction === a ? null : a)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-all
                  ${autoAction === a
                    ? "bg-indigo-600 text-white border border-indigo-500"
                    : "bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-500"
                  }`}
              >
                {a === "checkfold" ? "Check/Fold" : a === "callany" ? "Call Any" : "Check"}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      {/* Timer bar */}
      <div className="relative h-1 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000
            ${timeLeft > 15 ? "bg-indigo-500" : timeLeft > 5 ? "bg-yellow-500" : "bg-red-500"}`}
          style={{ width: `${(timeLeft / 45) * 100}%` }}
        />
        <span className="absolute right-0 -top-5 text-xs text-slate-400 font-mono">
          {timeLeft}s
        </span>
      </div>

      {/* Main action row */}
      <div className="flex gap-2">
        <button
          onClick={() => onAct({ type: "fold" })}
          className="flex-1 py-2.5 rounded-lg bg-red-900/50 text-red-300 font-bold text-sm
            border border-red-800/50 hover:bg-red-900/70 hover:border-red-700
            active:scale-95 transition-all"
        >
          FOLD
        </button>

        {you.canCheck ? (
          <button
            onClick={() => onAct({ type: "check" })}
            className="flex-1 py-2.5 rounded-lg bg-slate-700/50 text-slate-200 font-bold text-sm
              border border-slate-600/50 hover:bg-slate-700 hover:border-slate-500
              active:scale-95 transition-all"
          >
            CHECK
          </button>
        ) : (
          <button
            onClick={() => onAct({ type: "call" })}
            className="flex-1 py-2.5 rounded-lg bg-indigo-900/50 text-indigo-200 font-bold text-sm
              border border-indigo-700/50 hover:bg-indigo-900/70 hover:border-indigo-600
              active:scale-95 transition-all"
          >
            CALL {lamportsToSol(you.toCall)} SOL
          </button>
        )}
      </div>

      {/* Raise section */}
      {canRaise && (
        <div className="flex flex-col gap-2">
          {/* Preset buttons */}
          <div className="flex gap-1.5">
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => setRaiseAmount(p.amount)}
                className={`flex-1 py-1 rounded text-[11px] font-medium transition-all
                  ${raiseAmount === p.amount
                    ? "bg-violet-700/60 text-violet-200 border border-violet-500/60"
                    : "bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600"
                  }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Slider + raise button */}
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={min}
              max={max}
              step={Math.max(1, Math.floor(table.bb / 2))}
              value={raiseAmount}
              onChange={(e) => setRaiseAmount(Number(e.target.value))}
              className="flex-1 accent-violet-500 h-1.5 cursor-pointer"
            />
            <button
              onClick={() => onAct({ type: "raise", amount: raiseAmount })}
              className="px-4 py-2.5 rounded-lg bg-violet-700/60 text-violet-100 font-bold text-sm
                border border-violet-600/50 hover:bg-violet-700/80 hover:border-violet-500
                active:scale-95 transition-all whitespace-nowrap"
            >
              {raiseAmount >= max ? "ALL-IN" : "RAISE"}{" "}
              <span className="font-mono text-xs">{lamportsToSol(raiseAmount)} SOL</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
