"use client";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "wss://decent-poker-production.up.railway.app";

export default function TablePage() {
  const params = useParams();
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [currency, setCurrency] = useState("chips");
  const [buyIn, setBuyIn] = useState("");
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [wasHere, setWasHere] = useState(false); // returning player

  useEffect(() => {
    if (!params?.roomId) return;
    const rid = (params.roomId as string).toLowerCase();
    setRoomId(rid);

    // Check if this player was previously at this table
    const savedName = typeof localStorage !== "undefined" ? localStorage.getItem(`room_${rid}_name`) : null;
    if (savedName) {
      setName(savedName);
      setWasHere(true);
    } else {
      // Pre-fill from last used name
      const lastName = typeof localStorage !== "undefined" ? localStorage.getItem("player_name") : null;
      if (lastName) setName(lastName);
    }

    // Fetch room currency
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "room_info", roomId: rid }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "room_info") {
          setCurrency(m.currency || "chips");
          if (typeof sessionStorage !== "undefined") sessionStorage.setItem("room_currency", m.currency || "chips");
        }
      } catch(e) {}
      ws.close();
      setLoadingRoom(false);
    };
    ws.onerror = () => { ws.close(); setLoadingRoom(false); };
    ws.onclose = () => setLoadingRoom(false);
    setTimeout(() => { ws.close(); setLoadingRoom(false); }, 3000);
  }, [params]);

  const isUSD = currency === "usd";
  const isSOL = currency === "sol";
  const isChips = currency === "chips";
  const presets = isUSD ? ["10","20","50","100","200"] : isSOL ? ["0.5","1","2","5","10"] : ["500","1000","2000","5000"];
  const prefix = isUSD ? "$" : isSOL ? "◎" : "";

  const handleJoin = () => {
    if (!name.trim()) { setError("Enter your name first"); return; }
    if (typeof localStorage !== "undefined") {
      // Save name for this room so they can return
      localStorage.setItem(`room_${roomId}_name`, name.trim());
      localStorage.setItem("player_name", name.trim());
    }
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("player_name", name.trim());
      sessionStorage.setItem("join_room_id", roomId);
      sessionStorage.setItem("join_room_name", name.trim());
      if (buyIn && !isChips) sessionStorage.setItem("join_room_buyin", buyIn);
    }
    setJoining(true);
    window.location.href = "/";
  };

  return (
    <div style={{ minHeight:"100dvh", background:"#0a0a0f", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif", padding:16 }}>
      <div style={{ width:"100%", maxWidth:400, padding:32, background:"rgba(15,23,42,0.95)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:20, boxShadow:"0 20px 60px rgba(0,0,0,0.8)" }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:36, marginBottom:10 }}>🃏</div>
          <h1 style={{ margin:0, fontSize:24, fontWeight:800, color:"#f1f5f9" }}>
            {wasHere ? "Welcome back!" : "You're invited!"}
          </h1>
          <p style={{ margin:"10px 0 0", color:"#64748b", fontSize:14 }}>
            Room <code style={{ background:"rgba(99,102,241,0.15)", color:"#a5b4fc", padding:"3px 10px", borderRadius:5, fontFamily:"monospace", fontSize:18, fontWeight:700, letterSpacing:3 }}>
              {roomId ? roomId.toUpperCase() : "…"}
            </code>
          </p>
          {wasHere && <p style={{ margin:"8px 0 0", color:"#22c55e", fontSize:13 }}>Your seat is waiting for you</p>}
          {!loadingRoom && !isChips && (
            <div style={{ marginTop:6, fontSize:12, color:"#f59e0b" }}>
              {isUSD ? "💵 USD Cash Game" : "◎ SOL Game"}
            </div>
          )}
        </div>

        <label style={{ display:"block", fontSize:11, color:"#475569", fontWeight:600, letterSpacing:1, marginBottom:6 }}>YOUR NAME</label>
        <input
          autoFocus={!wasHere}
          value={name}
          onChange={e => { setName(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && handleJoin()}
          placeholder="Enter your name…"
          maxLength={20}
          style={{ width:"100%", background:"rgba(30,41,59,0.8)", border:`1px solid ${error ? "#ef4444" : wasHere ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.1)"}`, borderRadius:12, padding:"14px 16px", fontSize:16, color:"#f1f5f9", outline:"none", boxSizing:"border-box" as any, marginBottom: error ? 6 : 18 }}
        />
        {error && <p style={{ color:"#ef4444", fontSize:12, margin:"0 0 14px" }}>{error}</p>}

        {/* Only show buy-in for new players on money games */}
        {!wasHere && !isChips && !loadingRoom && (
          <div style={{marginBottom:16}}>
            <label style={{display:"block",fontSize:11,color:"#475569",fontWeight:600,letterSpacing:1,marginBottom:8}}>YOUR BUY-IN</label>
            <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
              {presets.map(v=>(
                <button key={v} onClick={()=>setBuyIn(v)} style={{padding:"6px 12px",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",
                  background:buyIn===v?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.6)",
                  border:buyIn===v?"1px solid #4338ca":"1px solid rgba(255,255,255,0.06)",
                  color:buyIn===v?"#a5b4fc":"#64748b"}}>{prefix}{v}</button>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <input type="number" value={buyIn} onChange={e=>setBuyIn(e.target.value)} placeholder="Custom amount…" min="1" step={isUSD?"1":"0.1"}
                style={{flex:1,background:"rgba(30,41,59,0.7)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:9,padding:"10px 12px",fontSize:15,color:"#f1f5f9",outline:"none",fontFamily:"monospace"}}/>
              <span style={{color:"#64748b",fontSize:13,fontWeight:600}}>{isUSD?"USD":isSOL?"SOL":""}</span>
            </div>
          </div>
        )}

        <button onClick={handleJoin} disabled={joining || loadingRoom}
          style={{ width:"100%", padding:"15px 0", background: (joining||loadingRoom) ? "rgba(67,56,202,0.5)" : wasHere ? "#166534" : "#4338ca", border:"none", borderRadius:13, color:"#fff", fontSize:16, fontWeight:700, cursor:"pointer" }}>
          {loadingRoom ? "Loading room…" : joining ? "Joining…" : wasHere ? "▶ REJOIN TABLE" : "JOIN TABLE →"}
        </button>

        <p style={{ textAlign:"center", color:"#334155", fontSize:10, marginTop:14 }}>Link expires if the host closes their tab</p>
      </div>
    </div>
  );
}
