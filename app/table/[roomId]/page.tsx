"use client";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";

export default function TablePage() {
  const params = useParams();
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  // Wait for params to hydrate
  useEffect(() => {
    if (params?.roomId) setRoomId((params.roomId as string).toLowerCase());
  }, [params]);

  const handleJoin = () => {
    if (!name.trim()) { setError("Enter your name first"); return; }
    if (!roomId) { setError("Invalid room code"); return; }
    sessionStorage.setItem("join_room_id", roomId);
    sessionStorage.setItem("join_room_name", name.trim());
    window.location.href = "/";
  };

  return (
    <div style={{ minHeight:"100vh", background:"#0a0a0f", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ width:"100%", maxWidth:400, padding:32, background:"rgba(15,23,42,0.95)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:20, boxShadow:"0 20px 60px rgba(0,0,0,0.8)" }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🃏</div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:800, color:"#f1f5f9" }}>You're invited!</h1>
          <p style={{ margin:"8px 0 0", color:"#64748b", fontSize:14 }}>
            Room{" "}
            <code style={{ background:"rgba(99,102,241,0.15)", color:"#a5b4fc", padding:"2px 10px", borderRadius:4, fontFamily:"monospace", fontSize:18, fontWeight:700, letterSpacing:3 }}>
              {roomId ? roomId.toUpperCase() : "…"}
            </code>
          </p>
        </div>

        <label style={{ display:"block", fontSize:11, color:"#475569", fontWeight:600, letterSpacing:1, marginBottom:6 }}>YOUR NAME</label>
        <input
          autoFocus
          value={name}
          onChange={e => { setName(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && handleJoin()}
          placeholder="Enter your name…"
          maxLength={20}
          style={{ width:"100%", background:"rgba(30,41,59,0.8)", border:`1px solid ${error ? "#ef4444" : "rgba(255,255,255,0.1)"}`, borderRadius:12, padding:"12px 16px", fontSize:16, color:"#f1f5f9", outline:"none", boxSizing:"border-box", marginBottom: error ? 6 : 16 }}
        />
        {error && <p style={{ color:"#ef4444", fontSize:12, margin:"0 0 12px" }}>{error}</p>}

        <button
          onClick={handleJoin}
          style={{ width:"100%", padding:"13px 0", background:"#4338ca", border:"none", borderRadius:12, color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer" }}>
          JOIN TABLE →
        </button>
        <p style={{ textAlign:"center", color:"#1e293b", fontSize:11, marginTop:14 }}>No wallet required · Play money only</p>
      </div>
    </div>
  );
}
