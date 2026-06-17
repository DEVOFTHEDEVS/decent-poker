"use client";

import { useState } from "react";
import type { LobbyTable } from "@/lib/engine/types";

interface BuyInModalProps {
  table: LobbyTable;
  onConfirm: (lamports: number) => void;
  onCancel: () => void;
  isProcessing?: boolean;
  error?: string | null;
}

export function BuyInModal({ table, onConfirm, onCancel, isProcessing, error }: BuyInModalProps) {
  const [amount, setAmount] = useState(table.minSol.toString());

  const parsed = parseFloat(amount);
  const valid = !isNaN(parsed) && parsed >= table.minSol && parsed <= table.maxSol;
  const lamports = Math.round(parsed * 1_000_000_000);

  const quick = [
    { label: "Min",   val: table.minSol },
    { label: "2×",    val: table.minSol * 2 },
    { label: "5×",    val: table.minSol * 5 },
    { label: "Max",   val: table.maxSol },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center
      bg-black/70 backdrop-blur-sm px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl
          p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-slate-100 mb-1">BUY IN</h2>
        <p className="text-sm text-slate-400 mb-4">
          {table.name} · {table.minSol}–{table.maxSol} SOL
        </p>

        {/* Quick amounts */}
        <div className="flex gap-2 mb-3">
          {quick.map(q => (
            <button
              key={q.label}
              onClick={() => setAmount(q.val.toString())}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all
                ${amount === q.val.toString()
                  ? "bg-indigo-700 text-white border border-indigo-600"
                  : "bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600"
                }`}
            >
              {q.label}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 mb-2">
          <input
            type="number"
            min={table.minSol}
            max={table.maxSol}
            step="0.01"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-xl
              px-4 py-3 text-slate-100 text-lg font-mono
              focus:outline-none focus:border-indigo-500/70"
            placeholder={table.minSol.toString()}
          />
          <span className="text-slate-400 font-medium">SOL</span>
        </div>

        {error && (
          <p className="text-red-400 text-xs mb-3">{error}</p>
        )}

        <p className="text-xs text-slate-500 mb-4">
          Min: {table.minSol} SOL · Max: {table.maxSol} SOL
        </p>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-slate-700
              text-slate-400 hover:text-slate-200 hover:border-slate-600
              text-sm transition-all"
          >
            CANCEL
          </button>
          <button
            onClick={() => valid && onConfirm(lamports)}
            disabled={!valid || isProcessing}
            className="flex-1 py-2.5 rounded-xl bg-indigo-700 text-white font-bold text-sm
              hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed
              active:scale-95 transition-all"
          >
            {isProcessing ? "SENDING…" : "CONFIRM BUY-IN"}
          </button>
        </div>

        <p className="text-center text-xs text-slate-600 mt-3">
          Buy-ins are non-refundable once confirmed on-chain
        </p>
      </div>
    </div>
  );
}
