"use client";

import { useState, useRef, useEffect } from "react";
import type { ChatMessage, ClientTableState } from "@/lib/engine/types";

interface TableChatProps {
  table: ClientTableState;
  onSend: (text: string) => void;
}

export function TableChat({ table, onSend }: TableChatProps) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const canChat = !!table.you;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [table.chat?.length, open]);

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || !canChat) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between px-3 py-2
          text-slate-400 hover:text-slate-200 transition-colors"
      >
        <span className="text-xs font-medium tracking-wide">TABLE CHAT</span>
        <span className="text-xs">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 max-h-48 min-h-[80px]"
          >
            {!table.chat?.length ? (
              <p className="text-slate-600 text-xs text-center py-4">
                No messages yet
              </p>
            ) : (
              table.chat.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.seat === table.you?.seat ? "items-end" : "items-start"}`}
                >
                  <span className="text-[10px] text-slate-500 mb-0.5">{msg.name}</span>
                  <div className={`px-2.5 py-1 rounded-xl text-xs max-w-[85%]
                    ${msg.seat === table.you?.seat
                      ? "bg-indigo-700/50 text-indigo-100"
                      : "bg-slate-800 text-slate-200"
                    }`}>
                    {msg.text}
                  </div>
                </div>
              ))
            )}
          </div>

          <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2 border-t border-slate-700/50">
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={canChat ? "Message the table…" : "Sit down to chat"}
              disabled={!canChat}
              maxLength={140}
              className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded-lg
                px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600
                focus:outline-none focus:border-indigo-500/50 disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!canChat || !text.trim()}
              className="p-1.5 rounded-lg bg-indigo-700/50 text-indigo-300
                hover:bg-indigo-700/70 disabled:opacity-40 transition-all"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          </form>
        </>
      )}
    </div>
  );
}
