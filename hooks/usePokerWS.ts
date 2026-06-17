"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type {
  ClientTableState,
  LobbyTable,
  ServerMessage,
  ClientMessage,
  Action,
} from "@/lib/engine/types";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

interface UsePokerWSReturn {
  connectionState: ConnectionState;
  lobby: LobbyTable[];
  table: ClientTableState | null;
  lastError: string | null;
  // Actions
  joinTable: (tableId: string, lamports: number, signature: string, name: string, playerSeed: string) => void;
  watchTable: (tableId: string) => void;
  act: (tableId: string, action: Action) => void;
  chat: (tableId: string, text: string) => void;
  react: (tableId: string, emoji: string) => void;
  cashout: (tableId: string) => void;
  requestLobby: () => void;
}

export function usePokerWS(wsUrl: string): UsePokerWSReturn {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [lobby, setLobby] = useState<LobbyTable[]>([]);
  const [table, setTable] = useState<ClientTableState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;

    setConnectionState("connecting");
    const socket = new WebSocket(wsUrl);
    ws.current = socket;

    socket.onopen = () => {
      setConnectionState("connected");
      setLastError(null);
      // Request lobby immediately
      socket.send(JSON.stringify({ type: "lobby" } as ClientMessage));
      // Start ping
      pingTimer.current = setInterval(() => {
        socket.send(JSON.stringify({ type: "ping" } as ClientMessage));
      }, 25_000);
    };

    socket.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        switch (msg.type) {
          case "lobby":
            setLobby(msg.tables);
            break;
          case "state":
          case "joined":
            setTable(msg.table);
            break;
          case "error":
            setLastError(msg.message);
            break;
          case "cashout":
            setTable(null);
            break;
          case "kicked":
            setTable(null);
            setLastError(
              msg.reason === "chips"
                ? `You were knocked out${msg.lastWinner ? ` by ${msg.lastWinner.name}` : ""}`
                : "You were removed for being idle too long."
            );
            break;
          case "pong":
            break;
        }
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    socket.onclose = () => {
      setConnectionState("disconnected");
      if (pingTimer.current) clearInterval(pingTimer.current);
      // Reconnect after 2s
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    socket.onerror = () => {
      setConnectionState("error");
      socket.close();
    };
  }, [wsUrl]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  return {
    connectionState,
    lobby,
    table,
    lastError,
    joinTable: (tableId, lamports, signature, name, playerSeed) =>
      send({ type: "join", tableId, lamports, signature, name, playerSeed }),
    watchTable: (tableId) => send({ type: "watch", tableId }),
    act: (tableId, action) => send({ type: "act", tableId, action }),
    chat: (tableId, text) => send({ type: "chat", tableId, text }),
    react: (tableId, emoji) => send({ type: "react", tableId, emoji }),
    cashout: (tableId) => send({ type: "cashout", tableId }),
    requestLobby: () => send({ type: "lobby" }),
  };
}
