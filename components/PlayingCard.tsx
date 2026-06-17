"use client";

import type { Card } from "@/lib/engine/dealer";

interface CardProps {
  card: Card | "back" | null;
  small?: boolean;
  highlight?: boolean;
  className?: string;
}

const SUIT_COLOR: Record<string, string> = {
  "♥": "text-red-400",
  "♦": "text-red-400",
  "♠": "text-slate-100",
  "♣": "text-slate-100",
};

export function PlayingCard({ card, small, highlight, className = "" }: CardProps) {
  if (!card) return null;

  const base = small
    ? "w-9 h-12 rounded text-xs"
    : "w-14 h-20 rounded-lg text-sm";

  if (card === "back") {
    return (
      <div className={`${base} relative flex items-center justify-center
        bg-gradient-to-br from-indigo-900 to-indigo-700
        border border-indigo-500/40 shadow-md select-none ${className}`}>
        <div className="w-full h-full rounded-lg border-2 border-indigo-500/20
          bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(99,102,241,0.08)_3px,rgba(99,102,241,0.08)_6px)]" />
      </div>
    );
  }

  const suitColor = SUIT_COLOR[card.s] || "text-slate-100";
  const highlightRing = highlight ? "ring-2 ring-yellow-400 ring-offset-1 ring-offset-slate-900" : "";

  return (
    <div className={`${base} relative flex flex-col justify-between p-1
      bg-slate-50 border border-slate-200/10 shadow-lg select-none
      ${highlightRing} ${className}`}>
      {/* Top-left corner */}
      <div className={`flex flex-col leading-none ${suitColor}`}>
        <span className="font-bold">{card.r}</span>
        <span className={small ? "text-[10px]" : "text-xs"}>{card.s}</span>
      </div>
      {/* Center pip */}
      <div className={`absolute inset-0 flex items-center justify-center
        ${small ? "text-base" : "text-2xl"} ${suitColor} font-light`}>
        {card.s}
      </div>
      {/* Bottom-right (rotated) */}
      <div className={`flex flex-col leading-none items-end rotate-180 ${suitColor}`}>
        <span className="font-bold">{card.r}</span>
        <span className={small ? "text-[10px]" : "text-xs"}>{card.s}</span>
      </div>
    </div>
  );
}

export function CardBack({ small }: { small?: boolean }) {
  return <PlayingCard card="back" small={small} />;
}
