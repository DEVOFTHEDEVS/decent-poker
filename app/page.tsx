"use client";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Card { r: string; s: string; red: boolean; }
interface Seat { id: string; name: string; chips: number; bet: number; cards: Card[]|"back"|null; folded: boolean; allIn: boolean; inHand: boolean; isButton: boolean; isTurn: boolean; isBot: boolean; idleMs: number; lastAction?: { label: string; amount?: number; ts: number }; sittingOut?: boolean; }
interface YouState { seat: number; chips: number; myTurn: boolean; canCheck: boolean; toCall: number; minRaiseTo: number; maxRaiseTo: number; inHand: boolean; allIn: boolean; sittingOut?: boolean; }
interface TableState { id: string; name: string; sb: number; bb: number; blindLevel?: number; blindSchedule?: any; nextBlindTime?: number; maxSeats: number; seats: (Seat|null)[]; board: Card[]; pot: number; currentBet: number; street: string|null; handActive: boolean; seated: number; actionLog: { name: string; label: string; amount?: number }[]; lastResult?: { winners: { name: string; amount: number; hand: string; seat: number }[]; rake: number; reveal: boolean; winCards?: string[] }; chat: { id: string; seat: number; name: string; text: string }[]; pots?: { amount: number; label: string }[]; you: YouState|null; }
interface LobbyTable { id: string; name: string; seated: number; maxSeats: number; inHand: boolean; sb: number; bb: number; minSol: number; maxSol: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────
const sol = (l: number) => (l / 1e9).toFixed(3);
// Display amount based on explicit mode
// chip mode: values stored as plain numbers (1 chip = 1 lamport)
// sol mode: values stored as lamports (1 SOL = 1_000_000_000)
// usd mode: same as chip mode but shows $ prefix
// Global currency cache - persisted in both sessionStorage and localStorage
function _initCurrency(): string {
  if (typeof sessionStorage === "undefined") return "chips";
  return sessionStorage.getItem("table_currency") 
    || (typeof localStorage !== "undefined" ? localStorage.getItem("table_currency") : null)
    || sessionStorage.getItem("room_currency")
    || "chips";
}
let _currentCurrency = _initCurrency();
function setCurrencyCache(c: string) {
  if (!c || c === "undefined") return;
  _currentCurrency = c;
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem("table_currency", c);
  if (typeof localStorage !== "undefined") localStorage.setItem("table_currency", c); // persist across kicks
}

function displayAmount(l: number, mode?: string): string {
  const m = mode || _currentCurrency || "chips";
  if (m === "chips") {
    return l >= 1000 ? l.toLocaleString() : l.toString();
  }
  if (m === "usd") {
    const v = l / 100; // 1 cent = 1 lamport in USD mode
    return "$" + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
  }
  // SOL mode
  return (l / 1e9).toFixed(3);
}
const SUIT_COLOR: Record<string, string> = { "♥":"#dc2626","♦":"#dc2626","♠":"#1e293b","♣":"#1e293b" };
function genSeed() { const a = new Uint8Array(16); if (typeof crypto!=="undefined") crypto.getRandomValues(a); return Array.from(a).map(b=>b.toString(16).padStart(2,"0")).join(""); }
function getPlayerName() { return (typeof sessionStorage!=="undefined" && sessionStorage.getItem("player_name")) || "Player"; }

// Button styles are in globals.css

// ── Sound Engine ──────────────────────────────────────────────────────────────
let audioCtx: AudioContext|null = null;
function getAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext||(window as any).webkitAudioContext)(); } catch(e) { return null; } }
  if (audioCtx.state==="suspended") audioCtx.resume().catch(()=>{});
  return audioCtx;
}
function playTone(freq: number, dur: number, vol=0.12, type: OscillatorType="sine", delay=0) {
  const ctx=getAudio(); if(!ctx) return;
  const osc=ctx.createOscillator(), gain=ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type=type; osc.frequency.value=freq;
  const t=ctx.currentTime+delay;
  gain.gain.setValueAtTime(0.001,t); gain.gain.exponentialRampToValueAtTime(vol,t+0.005); gain.gain.exponentialRampToValueAtTime(0.001,t+dur);
  osc.start(t); osc.stop(t+dur+0.01);
}
function playNoise(dur: number, vol=0.08, hi=2000, lo=20000, delay=0) {
  const ctx=getAudio(); if(!ctx) return;
  const buf=ctx.createBuffer(1,Math.floor(ctx.sampleRate*(dur+0.05)),ctx.sampleRate);
  const data=buf.getChannelData(0);
  for(let i=0;i<data.length;i++){const env=Math.min(1,i/(ctx.sampleRate*0.003))*Math.pow(1-i/data.length,0.5);data[i]=(Math.random()*2-1)*env;}
  const src=ctx.createBufferSource(); src.buffer=buf;
  const hf=ctx.createBiquadFilter(); hf.type="highpass"; hf.frequency.value=hi;
  const lf=ctx.createBiquadFilter(); lf.type="lowpass"; lf.frequency.value=lo;
  const gain=ctx.createGain();
  const t=ctx.currentTime+delay;
  gain.gain.setValueAtTime(vol,t); gain.gain.exponentialRampToValueAtTime(0.001,t+dur);
  src.connect(hf); hf.connect(lf); lf.connect(gain); gain.connect(ctx.destination);
  src.start(t); src.stop(t+dur+0.06);
}
const Sounds = {
  deal(i=0) { const d=i*0.13; playNoise(0.025,0.35,2000,8000,d); playNoise(0.07,0.18,800,4000,d+0.008); playTone(110+i*8,0.06,0.07,"sine",d+0.01); },
  shuffle() { for(let i=0;i<8;i++){playNoise(0.03,0.12,1500,6000,i*0.055); playTone(800+i*40,0.02,0.04,"sine",i*0.055+0.005);} },
  chips() { playNoise(0.04,0.18,1800,5000,0); playNoise(0.035,0.14,2200,6000,0.05); playTone(380,0.07,0.06,"sine",0.03); },
  check() { playNoise(0.05,0.20,300,1200,0); playTone(160,0.08,0.10,"sine",0); },
  fold() { playNoise(0.06,0.22,500,3000,0); playTone(140,0.07,0.08,"sine",0.01); },
  win() { [523,659,784,1047].forEach((f,i)=>playTone(f,0.22,0.12,"triangle",i*0.1)); },
  yourTurn() { playTone(660,0.10,0.09,"sine",0); playTone(880,0.12,0.09,"sine",0.11); },
  beep(urgent=false) { playTone(urgent?880:660,urgent?0.10:0.07,urgent?0.16:0.09,"sine",0); },
};

// ── Card ──────────────────────────────────────────────────────────────────────
function PlayingCard({ card, small, highlight }: { card: Card|"back"|null; small?: boolean; highlight?: boolean }) {
  if (!card) return null;
  const w=small?41:92; const h=small?57:128; const fs=small?11:19;
  if (card==="back") return (
    <div style={{width:w,height:h,borderRadius:5,background:"linear-gradient(135deg,#1e1b4b,#312e81)",border:"1px solid #4338ca",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{width:"78%",height:"78%",borderRadius:3,border:"1px solid rgba(99,102,241,0.3)",background:"repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(99,102,241,0.08) 3px,rgba(99,102,241,0.08) 6px)"}}/>
    </div>
  );
  const color=SUIT_COLOR[card.s]||"#1e293b";
  return (
    <div style={{width:w,height:h,borderRadius:5,background:"#f8fafc",border:highlight?"2px solid #facc15":"1px solid #e2e8f0",flexShrink:0,padding:2,display:"flex",flexDirection:"column",justifyContent:"space-between",boxShadow:highlight?"0 0 10px rgba(250,204,21,0.5)":"0 2px 6px rgba(0,0,0,0.5)"}}>
      <div style={{color,fontSize:card.r==="T"?fs-1:fs,fontWeight:800,lineHeight:1.1}}>{card.r==="T"?"10":card.r}<br/><span style={{fontSize:fs-1}}>{card.s}</span></div>
      <div style={{color,fontSize:small?18:32,textAlign:"center",lineHeight:1}}>{card.s}</div>
      <div style={{color,fontSize:card.r==="T"?fs-1:fs,fontWeight:800,lineHeight:1.1,transform:"rotate(180deg)"}}>{card.r==="T"?"10":card.r}<br/><span style={{fontSize:fs-1}}>{card.s}</span></div>
    </div>
  );
}

// ── Seat Pod ──────────────────────────────────────────────────────────────────
function SeatPod({ seat, isMe, isWinner, winCards, pos, small }: { seat: Seat; isMe: boolean; isWinner: boolean; winCards?: Set<string>; pos: {left:string;top:string}; small?: boolean; }) {
  const showAction = seat.lastAction && Date.now()-seat.lastAction.ts < 3000;
  const cardW = small ? 22 : 26;
  const cardH = small ? 31 : 36;
  const aC: Record<string,string> = {FOLD:"#ef4444",CHECK:"#94a3b8","ALL-IN":"#f97316",CALL:"#6366f1",RAISE:"#8b5cf6",BET:"#8b5cf6",SB:"#64748b",BB:"#64748b"};
  return (
    <div style={{position:"absolute",left:pos.left,top:pos.top,transform:"translate(-50%,-50%)",display:"flex",flexDirection:"column",alignItems:"center",gap:2,zIndex:seat.isTurn?20:10,opacity:seat.folded?0.3:1,pointerEvents:"none"}}>
      {seat.bet>0&&<div style={{display:"flex",gap:1,marginBottom:1}}>{Array.from({length:Math.min(4,Math.max(1,Math.ceil(seat.bet/20000000)))}).map((_,i)=><div key={i} style={{width:7,height:7,borderRadius:"50%",background:"linear-gradient(#facc15,#ca8a04)"}}/>)}</div>}
      {showAction&&<div style={{padding:"1px 5px",borderRadius:3,background:aC[seat.lastAction!.label]||"#374151",color:"#fff",fontSize:8,fontWeight:700}}>{seat.lastAction!.label}</div>}
      <div style={{display:"flex",gap:2}}>
        {seat.cards==="back"?<><PlayingCard card="back" small={!isMe}/><PlayingCard card="back" small={!isMe}/></>:
         Array.isArray(seat.cards)?seat.cards.map((c,i)=><PlayingCard key={i} card={c} small={!isMe} highlight={winCards?.has(c.r+c.s)}/>):
         <><div style={{width:cardW,height:cardH,borderRadius:5,border:"1px solid rgba(255,255,255,0.06)"}}/><div style={{width:cardW,height:cardH,borderRadius:5,border:"1px solid rgba(255,255,255,0.06)"}}/></>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:5,padding:"5px 8px",borderRadius:8,background:seat.isTurn?"#1e1b4b":isWinner?"#052e16":isMe?"#1e293b":"rgba(15,23,42,0.92)",border:`2px solid ${seat.isTurn?"#818cf8":isWinner?"#34d399":isMe?"#6366f1":"rgba(255,255,255,0.12)"}`,boxShadow:seat.isTurn?"0 0 14px rgba(129,140,248,0.6)":isWinner?"0 0 14px rgba(52,211,153,0.6)":"none",minWidth:80}}>
        <div style={{width:24,height:24,borderRadius:"50%",background:isMe?"#4338ca":"#334155",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,flexShrink:0,position:"relative",color:"#fff"}}>
          {(seat.name||"?")[0].toUpperCase()}
          {seat.isButton&&<span style={{position:"absolute",bottom:-3,right:-3,width:13,height:13,borderRadius:"50%",background:"#facc15",color:"#713f12",fontSize:7,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center"}}>D</span>}
        </div>
        <div>
          <div style={{fontSize:13,fontWeight:800,color:isMe?"#c7d2fe":"#ffffff",maxWidth:80,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{seat.name}{seat.isBot&&<span style={{color:"#64748b",marginLeft:2,fontSize:10}}>·bot</span>}</div>
          <div style={{fontSize:13,color:"#facc15",fontFamily:"monospace",fontWeight:700}}>{displayAmount(seat.chips)}</div>
        </div>
      </div>
      {seat.allIn&&<span style={{fontSize:7,padding:"1px 4px",background:"rgba(249,115,22,0.2)",color:"#fb923c",borderRadius:3,fontWeight:700}}>ALL-IN</span>}
      {seat.sittingOut&&!seat.allIn&&<span style={{fontSize:7,padding:"1px 4px",background:"rgba(100,116,139,0.2)",color:"#94a3b8",borderRadius:3,fontWeight:700}}>BREAK</span>}
    </div>
  );
}

function EmptySeat({ pos, canSit, onClick, seatIdx }: {pos:{left:string;top:string};canSit:boolean;onClick?:(idx:number)=>void;seatIdx:number}) {
  return (
    <div style={{position:"absolute",left:pos.left,top:pos.top,transform:"translate(-50%,-50%)",zIndex:5}}>
      {canSit
        ? <button onClick={()=>onClick?.(seatIdx)}
            style={{width:46,height:46,borderRadius:"50%",background:"rgba(99,102,241,0.1)",border:"2px dashed rgba(99,102,241,0.5)",color:"rgba(129,140,248,0.8)",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
            <span style={{fontSize:14}}>👤</span>
            <span style={{fontSize:8}}>SIT</span>
          </button>
        : <div style={{width:30,height:30,borderRadius:"50%",border:"1px solid rgba(255,255,255,0.04)"}}/>}
    </div>
  );
}

// ── WS Hook ───────────────────────────────────────────────────────────────────
function useWS(url: string, onMessage?: (m: any) => void) {
  const ws = useRef<WebSocket|null>(null);
  const [connected, setConnected] = useState(false);
  const [lobby, setLobby] = useState<LobbyTable[]>([]);
  const [table, setTable] = useState<TableState|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [roomId, setRoomId] = useState<string|null>(null);

  const send = useCallback((msg: object) => {
    if (ws.current?.readyState===WebSocket.OPEN) { ws.current.send(JSON.stringify(msg)); return true; }
    return false;
  }, []);

  useEffect(() => {
    let dead = false;
    function connect() {
      if (dead) return;
      const s = new WebSocket(url);
      ws.current = s;
      s.onopen = () => {
        setConnected(true); setError(null);

        // Check for room invite first (highest priority)
        const joinRoomId = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("join_room_id") : null;
        const joinRoomName = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("join_room_name") : null;
        if (joinRoomId && joinRoomName) {
          // Spectate first so player can pick seat and buy-in amount
          const joinCurrency = typeof sessionStorage!=="undefined" ? (sessionStorage.getItem("room_currency") || "chips") : "chips";
          if (typeof sessionStorage!=="undefined") {
            sessionStorage.setItem("table_currency", joinCurrency);
            sessionStorage.setItem("pending_join_name", joinRoomName);
            sessionStorage.setItem("pending_join_room", joinRoomId);
          }
          // Also save to localStorage so it survives tab close
          if (typeof localStorage!=="undefined") {
            localStorage.setItem("pending_join_name", joinRoomName);
            localStorage.setItem("pending_join_room", joinRoomId);
          }
          s.send(JSON.stringify({ type:"spectate_room", roomId:joinRoomId }));
          return;
        }

        // Try to rejoin - check sessionStorage first, then localStorage backup
        let prevTableId = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("current_table_id") : null;
        let prevSeed = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("player_seed") : null;
        // Restore from localStorage if sessionStorage was cleared (tab close)
        if (!prevTableId && typeof localStorage!=="undefined") {
          prevTableId = localStorage.getItem("last_table_id");
          prevSeed = localStorage.getItem("last_player_seed");
          if (prevTableId && prevSeed && typeof sessionStorage!=="undefined") {
            sessionStorage.setItem("current_table_id", prevTableId);
            sessionStorage.setItem("player_seed", prevSeed);
          }
        }
        // Restore pending room join from localStorage
        if (typeof sessionStorage!=="undefined" && typeof localStorage!=="undefined") {
          if (!sessionStorage.getItem("pending_join_room") && localStorage.getItem("pending_join_room")) {
            sessionStorage.setItem("pending_join_room", localStorage.getItem("pending_join_room")!);
            sessionStorage.setItem("pending_join_name", localStorage.getItem("pending_join_name") || "");
          }
        }
        if (prevTableId && prevSeed) {
          const mySavedSeat = typeof sessionStorage!=="undefined" ? localStorage.getItem("my_seat_index") : null;
          s.send(JSON.stringify({ type:"rejoin", tableId:prevTableId, playerSeed:prevSeed, ...(mySavedSeat!==null?{preferredSeat:parseInt(mySavedSeat)}:{}) }));
        } else {
          s.send(JSON.stringify({type:"lobby"}));
        }
      };
      s.onmessage = e => {
        try {
          const m = JSON.parse(e.data);
          if (onMessage) onMessage(m);
          if (m.type==="lobby") setLobby(m.tables);
          else if (m.type==="state"||m.type==="joined") {
            setTable({...m.table});
            if (m.table?.you && typeof sessionStorage!=="undefined") {
              sessionStorage.setItem("current_table_id", m.table.id);
              localStorage.setItem("my_seat_index", String(m.table.you.seat));
              sessionStorage.removeItem("join_room_id");
              sessionStorage.removeItem("join_room_name");
            }
            if (m.currency) setCurrencyCache(m.currency);
            else if (typeof sessionStorage!=="undefined" && sessionStorage.getItem("table_currency")) setCurrencyCache(sessionStorage.getItem("table_currency")!);
          }
          else if (m.type==="room_created") {
            setRoomId(m.roomId); setTable({...m.table});
            if (typeof sessionStorage!=="undefined") {
              sessionStorage.setItem("current_table_id", m.table.id);
              sessionStorage.setItem("last_room_id", m.roomId);
              setCurrencyCache(m.currency || "chips");
            }
          }
          else if (m.type==="cashout") { setTable(null); if (typeof sessionStorage!=="undefined") sessionStorage.removeItem("current_table_id"); }
          else if (m.type==="error") {
            if (m.message?.includes("Room not found") || m.message?.includes("expired")) {
              // Clear pending join state
              if (typeof sessionStorage!=="undefined") {
                sessionStorage.removeItem("pending_join_room");
                sessionStorage.removeItem("pending_join_name");
                sessionStorage.removeItem("join_room_id");
                sessionStorage.removeItem("join_room_name");
              }
              setError("Room not found — the host needs to create a new room and share a fresh link.");
            } else if (m.message?.includes("Session expired")) {
              setError(null);
            } else {
              setError(m.message);
            }
            s.send(JSON.stringify({type:"lobby"}));
          }
          else if (m.type==="kicked") {
            // Save currency before clearing table state
            if (m.currency) setCurrencyCache(m.currency);
            setTable(null);
            setError("You were removed from the table by the host.");
            if (typeof sessionStorage!=="undefined") sessionStorage.removeItem("current_table_id");
          }
          else if (m.type==="spectating") {
            // Show table as spectator - user will click a seat to join
            setTable({...m.table});
            if (typeof sessionStorage!=="undefined") {
              if (m.currency) setCurrencyCache(m.currency);
              // DON'T clear join_room_id yet - needed for when they sit down
            }
          }
        } catch(e) { console.error("WS parse error",e); }
      };
      s.onclose = () => { setConnected(false); if (!dead) setTimeout(connect, 2000); };
      s.onerror = () => s.close();
    }
    connect();
    return () => { dead=true; ws.current?.close(); };
  }, [url]);

  return { connected, lobby, table, error, roomId, setRoomId, send, setTable };
}

// ── Table View ────────────────────────────────────────────────────────────────
function BlindTimer({ table }: { table: TableState }) {
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const schedule = (table as any).blindSchedule as {sb:number;bb:number;durationMs:number}[]|null;
  const nextTime = (table as any).nextBlindTime as number|null;
  const level = ((table as any).blindLevel as number) || 0;

  useEffect(()=>{
    if (!nextTime) return;
    const iv = setInterval(()=>{
      const left = Math.max(0, nextTime - Date.now());
      setTimeLeft(left);
    }, 1000);
    return ()=>clearInterval(iv);
  }, [nextTime]);

  if (!schedule || !nextTime) return null;
  const nextLevel = schedule[level+1];
  const mins = Math.floor(timeLeft/60000);
  const secs = Math.floor((timeLeft%60000)/1000);
  const pct = nextTime ? (timeLeft / (schedule[level]?.durationMs||1)) * 100 : 0;

  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:5,padding:"1px 5px",fontSize:9,color:"#f59e0b",fontWeight:700,cursor:"default"}} title={nextLevel?`Next: ${nextLevel.sb}/${nextLevel.bb}`:""}>
      ⏱ L{level+1} {mins}:{secs.toString().padStart(2,"0")}
    </span>
  );
}

function AdminPanel({ table, onAdminAction, onClose }: {
  table: TableState;
  onAdminAction: (action: string, targetName: string, amount?: number, newSeat?: number) => void;
  onClose: () => void;
}) {
  const [chipAmt, setChipAmt] = useState<Record<string,string>>({});
  const [tab, setTab] = useState<"players"|"game">("players");
  const [newSb, setNewSb] = useState(String((table.sb||25)));
  const [newBb, setNewBb] = useState(String((table.bb||50)));
  const [newAnte, setNewAnte] = useState(String((table as any).ante||0));
  const cur = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("table_currency")||"chips" : "chips";
  const isUSD = cur==="usd";
  const isPaused = (table as any).gamePaused;
  const seated = table.seats.filter((s): s is Seat => s!==null);

  function toL(v: number) { return isUSD ? Math.round(v*100) : Math.round(v); }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div style={{background:"#0f172a",border:"1px solid rgba(245,158,11,0.35)",borderRadius:16,padding:20,width:"100%",maxWidth:440,maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <span style={{color:"#f59e0b",fontWeight:800,fontSize:16}}>⚙ Host Controls</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#64748b",fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:4,marginBottom:14}}>
          {(["players","game"] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"7px 0",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
              background:tab===t?"rgba(245,158,11,0.2)":"rgba(30,41,59,0.5)",
              border:tab===t?"1px solid #f59e0b":"1px solid rgba(255,255,255,0.06)",
              color:tab===t?"#f59e0b":"#64748b"}}>
              {t==="players"?"👥 Players":"🎮 Game Settings"}
            </button>
          ))}
        </div>

        {tab==="players" && (
          <div>
            {seated.length===0 ? <p style={{color:"#64748b",textAlign:"center",fontSize:13}}>No players seated yet</p> :
            seated.map(seat=>(
              <div key={seat.id} style={{background:"rgba(30,41,59,0.6)",borderRadius:10,padding:12,marginBottom:8,border:"1px solid rgba(255,255,255,0.05)"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{color:"#f1f5f9",fontWeight:700}}>{seat.name}</span>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{color:"#22c55e",fontWeight:600,fontSize:13}}>{displayAmount(seat.chips)}</span>
                    {seat.sittingOut && <button onClick={()=>onAdminAction("sit_player",seat.name)} style={{padding:"2px 7px",background:"rgba(34,197,94,0.15)",border:"1px solid #22c55e",borderRadius:4,color:"#86efac",fontSize:10,cursor:"pointer"}}>SIT IN</button>}
                  </div>
                </div>
                <div style={{display:"flex",gap:3,marginBottom:6,flexWrap:"wrap"}}>
                  {(isUSD?[10,25,50,100]:[500,1000,2000,5000]).map(v=>(
                    <button key={v} onClick={()=>onAdminAction("give_chips",seat.name,toL(v))}
                      style={{padding:"3px 8px",background:"rgba(34,197,94,0.12)",border:"1px solid rgba(34,197,94,0.25)",borderRadius:5,color:"#86efac",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                      +{isUSD?"$":""}{v}
                    </button>
                  ))}
                  {(isUSD?[10,25]:[500,1000]).map(v=>(
                    <button key={-v} onClick={()=>onAdminAction("give_chips",seat.name,-toL(v))}
                      style={{padding:"3px 8px",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5,color:"#fca5a5",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                      -{isUSD?"$":""}{v}
                    </button>
                  ))}
                </div>
                <div style={{display:"flex",gap:5}}>
                  <input type="number" placeholder={isUSD?"Set $…":"Set chips…"} value={chipAmt[seat.name]||""} onChange={e=>setChipAmt(p=>({...p,[seat.name]:e.target.value}))}
                    style={{flex:1,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:6,padding:"6px 9px",fontSize:12,color:"#f1f5f9",outline:"none"}}/>
                  <button onClick={()=>{const r=parseFloat(chipAmt[seat.name]||"0");if(r)onAdminAction("set_chips",seat.name,toL(r));setChipAmt(p=>({...p,[seat.name]:""}));}}
                    style={{padding:"6px 10px",background:"rgba(99,102,241,0.25)",border:"1px solid rgba(99,102,241,0.35)",borderRadius:6,color:"#a5b4fc",fontWeight:700,fontSize:11,cursor:"pointer"}}>SET</button>
                  <button onClick={()=>onAdminAction("remove_player",seat.name)}
                    style={{padding:"6px 10px",background:"rgba(127,29,29,0.3)",border:"1px solid rgba(127,29,29,0.4)",borderRadius:6,color:"#fca5a5",fontWeight:700,fontSize:11,cursor:"pointer"}}>KICK</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab==="game" && (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {/* Invite Link */}
            {(()=>{
              const rid = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("last_room_id") : null;
              if (!rid) return null;
              const link = `${window.location.origin}/table/${rid}`;
              return (
                <div style={{background:"rgba(30,41,59,0.6)",borderRadius:10,padding:12}}>
                  <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:8,letterSpacing:1}}>INVITE LINK</div>
                  <div style={{fontSize:12,color:"#a5b4fc",wordBreak:"break-all",marginBottom:8,padding:"6px 10px",background:"rgba(15,23,42,0.6)",borderRadius:6,fontFamily:"monospace"}}>{link}</div>
                  <button onClick={()=>navigator.clipboard.writeText(link).then(()=>alert("Link copied!"))}
                    style={{width:"100%",padding:"8px 0",background:"rgba(99,102,241,0.2)",border:"1px solid rgba(99,102,241,0.4)",borderRadius:8,color:"#a5b4fc",fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    📋 COPY LINK
                  </button>
                </div>
              );
            })()}
            {/* Pause/Resume */}
            <div style={{background:"rgba(30,41,59,0.6)",borderRadius:10,padding:12}}>
              <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:8,letterSpacing:1}}>GAME STATUS</div>
              <button onClick={()=>onAdminAction(isPaused?"resume_game":"pause_game","")}
                style={{width:"100%",padding:"11px 0",background:isPaused?"rgba(34,197,94,0.15)":"rgba(239,68,68,0.12)",border:`1px solid ${isPaused?"#22c55e":"#ef4444"}`,borderRadius:9,color:isPaused?"#86efac":"#fca5a5",fontWeight:800,fontSize:14,cursor:"pointer"}}>
                {isPaused?"▶ RESUME GAME":"⏸ PAUSE GAME"}
              </button>
              {isPaused && <div style={{textAlign:"center",color:"#64748b",fontSize:11,marginTop:6}}>Game is paused — no new hands will start</div>}
            </div>

            {/* Blinds */}
            <div style={{background:"rgba(30,41,59,0.6)",borderRadius:10,padding:12}}>
              <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:8,letterSpacing:1}}>BLINDS {isUSD?"(USD)":"(CHIPS)"}</div>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:3}}>SMALL BLIND</div>
                  <input type="number" value={newSb} onChange={e=>setNewSb(e.target.value)} step={isUSD?"0.05":"1"}
                    style={{width:"100%",background:"rgba(15,23,42,0.8)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"8px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:3}}>BIG BLIND</div>
                  <input type="number" value={newBb} onChange={e=>setNewBb(e.target.value)} step={isUSD?"0.05":"1"}
                    style={{width:"100%",background:"rgba(15,23,42,0.8)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"8px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
                </div>
              </div>
              <div style={{marginBottom:8}}>
                <div style={{fontSize:10,color:"#475569",marginBottom:3}}>ANTE (0 = no ante)</div>
                <input type="number" value={newAnte} onChange={e=>setNewAnte(e.target.value)} step={isUSD?"0.05":"1"} min="0"
                  style={{width:"100%",background:"rgba(15,23,42,0.8)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"8px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
              </div>
              <button onClick={()=>{
                const sb=isUSD?Math.round(parseFloat(newSb)*100):Math.round(parseFloat(newSb));
                const bb=isUSD?Math.round(parseFloat(newBb)*100):Math.round(parseFloat(newBb));
                const ante=isUSD?Math.round(parseFloat(newAnte||"0")*100):Math.round(parseFloat(newAnte||"0"));
                if(sb>0&&bb>0) onAdminAction("set_blinds","",sb,ante);
                // Send bb separately via a hack - pass in amount field for bb
                // Actually let's use a different approach
              }} style={{display:"none"}}/>
              <button onClick={()=>{
                const sb=isUSD?Math.round(parseFloat(newSb)*100):parseInt(newSb)||25;
                const bb=isUSD?Math.round(parseFloat(newBb)*100):parseInt(newBb)||50;
                const ante=isUSD?Math.round(parseFloat(newAnte||"0")*100):parseInt(newAnte||"0");
                onAdminAction("set_blinds","",ante,sb*100000+bb); // encode sb/bb in newSeat
              }} style={{width:"100%",padding:"9px 0",background:"rgba(99,102,241,0.25)",border:"1px solid rgba(99,102,241,0.4)",borderRadius:8,color:"#a5b4fc",fontWeight:700,fontSize:13,cursor:"pointer"}}>
                APPLY BLINDS
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TableView({ table, onAct, onChat, onLeave, onSitDown, onRebuy, onPause, isHost, onAdminAction }: {
  table: TableState; onAct:(a:any)=>void; onChat:(t:string)=>void; onLeave:()=>void; onSitDown?:(seatIdx?:number)=>void; onRebuy:()=>void; onPause:()=>void; isHost?:boolean; onAdminAction?:(action:string,name:string,amount?:number,newSeat?:number)=>void;
}) {
  const [chatText, setChatText] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [raiseAmt, setRaiseAmt] = useState(0);
  const [timeLeft, setTimeLeft] = useState(20);
  const [autoAction, setAutoAction] = useState<"checkFold"|"callAny"|"check"|null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const prevTable = useRef<TableState|null>(null);
  const lastCompletedNonce = useRef<number>(-1);
  const lastKnownChips = useRef<number>(-1);
  const wasSeated = useRef<boolean>(false);
  const beeped = useRef<Set<number>>(new Set());

  const myIndex = table.you?.seat ?? 0;
  // Track if we were seated and busted (for reconnect scenarios)
  if (table.you) { lastKnownChips.current = table.you.chips; wasSeated.current = true; }
  // Stable seat reference - don't let join events affect current player's state
  const youSeat = table.you;
  const you = table.you;
  const bb = table.bb;
  const pot = table.pot;

  const winCards = useMemo(() => {
    const wc = table.lastResult?.winCards;
    return wc?.length ? new Set(wc) : null;
  }, [table.lastResult]);

  // Turn timer
  useEffect(() => {
    if (!you?.myTurn) { setTimeLeft(20); return; }
    // Default to 2x pot raise, clamped to valid range
    const twoPot = table.currentBet + (table.pot * 2);
    const defaultRaise = Math.max(you.minRaiseTo, Math.min(you.maxRaiseTo, twoPot));
    setRaiseAmt(defaultRaise);
    beeped.current = new Set();
    const start = Date.now();
    const iv = setInterval(() => {
      const t = Math.max(0, 20-Math.floor((Date.now()-start)/1000));
      setTimeLeft(t);
      if ([5,4,3,2,1].includes(t) && !beeped.current.has(t)) { beeped.current.add(t); Sounds.beep(t<=3); }
    }, 200);
    return () => clearInterval(iv);
  }, [you?.myTurn, you?.seat]);

  // Auto-action
  useEffect(() => {
    if (!you?.myTurn || !autoAction) return;
    const timer = setTimeout(() => {
      if (autoAction==="checkFold") onAct(you.canCheck?{type:"check"}:{type:"fold"});
      else if (autoAction==="callAny") onAct(you.canCheck?{type:"check"}:{type:"call"});
      else if (autoAction==="check" && you.canCheck) onAct({type:"check"});
      setAutoAction(null);
    }, 400);
    return () => clearTimeout(timer);
  }, [you?.myTurn]);

  // Sound effects
  useEffect(() => {
    const prev = prevTable.current;
    prevTable.current = table;
    if (!prev) return;
    if (!prev.handActive && table.handActive) { Sounds.shuffle(); if (Array.isArray(table.seats[myIndex]?.cards)) { Sounds.deal(0); Sounds.deal(1); } }
    if ((table.board?.length||0) > (prev.board?.length||0)) { for(let i=prev.board?.length||0; i<(table.board?.length||0); i++) Sounds.deal(i-(prev.board?.length||0)); }
    const prevActs = prev.actionLog?.length||0, curActs = table.actionLog?.length||0;
    if (curActs > prevActs) {
      const label = table.actionLog[curActs-1]?.label?.toUpperCase();
      if (label==="FOLD") Sounds.fold();
      else if (label==="CHECK") Sounds.check();
      else if (["CALL","RAISE","BET","ALL-IN"].includes(label||"")) Sounds.chips();
    }
    if (table.you?.myTurn && !prev.you?.myTurn) Sounds.yourTurn();
    if (table.lastResult && !prev.lastResult && table.lastResult.winners.some(w=>w.seat===myIndex)) Sounds.win();
    if (!table.handActive && prev.handActive) setAutoAction(null);
  }, [table]);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop=chatRef.current.scrollHeight; }, [table.chat?.length]);

  function seatPos(idx: number) {
    const n = table.maxSeats;
    const rotated = (idx - myIndex + n) % n;

    // Pre-defined positions for each player count to avoid overlap
    // Positions are percentages of the felt container (left%, top%)
    // Optimized for oval felt with my seat always at bottom center
    // Position 0 = my seat (bottom center), rest arranged clockwise around table
    const positions: Record<number, [number, number][]> = {
      2: [[50,88],[50,10]],
      3: [[50,88],[20,12],[80,12]],
      4: [[50,88],[12,50],[50,8],[88,50]],
      5: [[50,88],[15,62],[25,15],[75,15],[85,62]],
      6: [[50,88],[15,62],[20,15],[50,8],[80,15],[85,62]],
      7: [[50,88],[15,68],[12,35],[30,8],[70,8],[88,35],[85,68]],
      8: [[50,88],[18,72],[10,45],[22,15],[50,6],[78,15],[90,45],[82,72]],
      9: [[50,88],[20,78],[10,52],[15,22],[38,6],[62,6],[85,22],[90,52],[80,78]],
    };

    const pts = positions[Math.min(n, 9)] || positions[9];
    const [l, t] = pts[rotated] || [50, 50];
    return { left: `${l}%`, top: `${t}%` };
  }

  const canRaise = you && !you.allIn && !you.allIn ? you.chips > 0 && you.maxRaiseTo > you.toCall : false;
  const rMin = you ? Math.max(1, Math.min(you.minRaiseTo, you.maxRaiseTo)) : 0;
  const rMax = you ? you.maxRaiseTo : 0;
  const presets = [
    {l:"Min",v:rMin},
    {l:"½P", v:Math.max(rMin,Math.min(rMax,table.currentBet+Math.floor(pot*0.5)))},
    {l:"¾P", v:Math.max(rMin,Math.min(rMax,table.currentBet+Math.floor(pot*0.75)))},
    {l:"Pot",v:Math.max(rMin,Math.min(rMax,table.currentBet+pot))},
    {l:"All",v:rMax},
  ];

  const unread = chatOpen ? 0 : (table.chat?.length || 0);

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100dvh",background:"#0a0a0f",overflow:"hidden"}}>
      {adminOpen && isHost && onAdminAction && <AdminPanel table={table} onAdminAction={onAdminAction} onClose={()=>setAdminOpen(false)} />}

      {/* TOP BAR */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 10px",background:"rgba(15,23,42,0.95)",borderBottom:"1px solid rgba(255,255,255,0.06)",flexShrink:0}}>
        <div>
          <span style={{fontWeight:700,color:"#e2e8f0",fontSize:13}}>{table.name}</span>
          <span style={{fontSize:10,color:"#64748b",marginLeft:8,fontFamily:"monospace"}}>{displayAmount(table.sb)}/{displayAmount(table.bb)}</span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {table.handActive&&<div style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:5,height:5,borderRadius:"50%",background:"#ef4444"}}/><span style={{fontSize:9,color:"#ef4444"}}>LIVE</span></div>}
          <button onClick={()=>setChatOpen(o=>!o)} style={{padding:"4px 8px",background:"rgba(30,41,59,0.6)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,color:"#94a3b8",fontSize:11,cursor:"pointer",position:"relative"}}>
            💬{table.chat?.length>0&&<span style={{marginLeft:3}}>{table.chat.length}</span>}
          </button>
          {you && !you.sittingOut && !you.inHand && (
            <button onClick={()=>onAct({type:'sit_out'} as any)} style={{padding:"4px 8px",background:"transparent",border:"1px solid #475569",borderRadius:6,color:"#64748b",fontSize:10,fontWeight:600,cursor:"pointer"}}>⏸</button>
          )}
          {you && (
            <button onClick={()=>onPause()} style={{padding:"4px 8px",background:you.sittingOut?"rgba(34,197,94,0.2)":"rgba(30,41,59,0.6)",border:you.sittingOut?"1px solid #22c55e":"1px solid rgba(255,255,255,0.08)",borderRadius:6,color:you.sittingOut?"#86efac":"#94a3b8",fontSize:10,fontWeight:700,cursor:"pointer"}}>
              {you.sittingOut?"▶ BACK":"⏸ BREAK"}
            </button>
          )}
          {isHost && onAdminAction && (
            <button onClick={()=>setAdminOpen(v=>!v)} style={{padding:"4px 8px",background:adminOpen?"rgba(245,158,11,0.3)":"rgba(245,158,11,0.15)",border:`1px solid ${adminOpen?"#f59e0b":"rgba(245,158,11,0.3)"}`,borderRadius:6,color:"#f59e0b",fontSize:10,fontWeight:700,cursor:"pointer"}}>
              ⚙ ADMIN
            </button>
          )}
          <button onClick={onLeave} style={{padding:"4px 10px",background:"rgba(127,29,29,0.5)",border:"1px solid #7f1d1d",borderRadius:6,color:"#fca5a5",fontSize:11,fontWeight:700,cursor:"pointer"}}>LEAVE</button>
        </div>
      </div>

      {/* FELT — takes remaining space */}
      <div style={{position:"relative",flex:"1 1 0",minHeight:0,overflow:"hidden"}}>
        {/* Oval background */}
        <div style={{position:"absolute",inset:"4px",borderRadius:"45%",background:"radial-gradient(ellipse at 50% 40%,#166534,#14532d,#052e16)",border:"8px solid rgba(120,53,15,0.5)",boxShadow:"inset 0 0 40px rgba(0,0,0,0.5)",overflow:"hidden"}}>
          {/* Center content */}
          <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,pointerEvents:"none",zIndex:2}}>
            {table.handActive&&table.street&&<div style={{padding:"1px 8px",background:"rgba(0,0,0,0.35)",borderRadius:12,color:"rgba(134,239,172,0.7)",fontSize:9,fontFamily:"monospace",letterSpacing:3}}>{table.street.toUpperCase()}</div>}
            {/* Community cards */}
            <div style={{display:"flex",gap:4}}>
              {(table.board||[]).map((c,i)=><PlayingCard key={i} card={c} highlight={winCards?.has(c.r+c.s)}/>)}
              {Array.from({length:5-(table.board?.length||0)}).map((_,i)=><div key={i} style={{width:92,height:128,borderRadius:5,border:"1px solid rgba(255,255,255,0.07)",background:"rgba(0,0,0,0.15)"}}/>)}
            </div>
            {/* Pot */}
            {pot>0&&(
              <div style={{display:"flex",gap:4}}>
                {(table.pots?.length?table.pots:[{amount:pot,label:"POT"}]).map((p,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:4,padding:"2px 10px",background:"rgba(0,0,0,0.45)",borderRadius:12}}>
                    <div style={{width:12,height:12,borderRadius:"50%",background:"linear-gradient(#facc15,#ca8a04)"}}/>
                    <span style={{fontSize:9,color:"rgba(134,239,172,0.6)",fontFamily:"monospace"}}>{p.label}</span>
                    <span style={{fontSize:12,color:"#fde68a",fontWeight:700,fontFamily:"monospace"}}>{displayAmount(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            {!table.handActive&&<div style={{color:"rgba(134,239,172,0.12)",fontSize:11,fontWeight:900,letterSpacing:3}}>{table.seated>=2?"NEXT HAND SOON":"WAITING FOR PLAYERS"}</div>}
          </div>
          {/* Seats */}
          <div style={{position:"absolute",inset:0,zIndex:10}}>
            {table.seats.map((seat,i)=>{
              const pos=seatPos(i);
              if(!seat) return <EmptySeat key={i} pos={pos} canSit={!you&&!!onSitDown} onClick={(idx)=>onSitDown?.(idx)} seatIdx={i}/>;
              return <SeatPod key={i} seat={seat} isMe={i===myIndex} isWinner={!!(table.lastResult?.winners.some(w=>w.seat===i))} winCards={winCards??undefined} pos={pos} small={table.maxSeats>=7}/>;
            })}
          </div>
          {/* Win banner */}
          {table.lastResult&&(
            <div style={{position:"absolute",bottom:4,left:"50%",transform:"translateX(-50%)",zIndex:20,whiteSpace:"nowrap",pointerEvents:"none"}}>
              <div style={{padding:"4px 14px",background:"rgba(15,23,42,0.97)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,fontSize:11}}>
                {table.lastResult.winners.map((w,i)=><span key={i} style={{color:"#fde68a",fontWeight:600}}>{w.name} +{displayAmount(w.amount)}{w.hand&&w.hand!=="win"&&w.hand!=="(everyone folded)"&&<span style={{color:"#94a3b8",marginLeft:3}}>· {w.hand}</span>}</span>)}
              </div>
            </div>
          )}
        </div>
      </div>



      {/* ACTION PANEL - fixed bottom right */}
      <div style={{position:"fixed",bottom:16,right:16,zIndex:100,width:320,background:"rgba(10,10,20,0.97)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:14,padding:"12px",boxShadow:"0 8px 32px rgba(0,0,0,0.7)",backdropFilter:"blur(8px)"}}>
        {(table as any).gamePaused && (
          <div style={{textAlign:"center",padding:"10px",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,color:"#fca5a5",fontWeight:700,fontSize:13,marginBottom:4}}>
            ⏸ Game paused by host
          </div>
        )}
        {you?.myTurn && !you.allIn ? (
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {/* Timer bar */}
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
              <span style={{fontSize:10,color:"#f59e0b",fontWeight:700,letterSpacing:1}}>● YOUR TURN</span>
              <div style={{flex:1,height:2,background:"rgba(255,255,255,0.07)",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${(timeLeft/20)*100}%`,background:timeLeft>8?"#f59e0b":timeLeft>4?"#f97316":"#ef4444",transition:"width 0.2s linear"}}/>
              </div>
              <span style={{fontSize:10,fontFamily:"monospace",color:timeLeft<=4?"#ef4444":"#64748b",fontWeight:700}}>{timeLeft}s</span>
            </div>
            {/* Main action buttons - horizontal row like PokerNow */}
            <div style={{display:"flex",gap:6}}>
              {!you.canCheck && (
                <button className="btn-call" onClick={()=>onAct({type:"call"})}>
                  CALL<br/><span style={{fontSize:13,fontWeight:700}}>{displayAmount(you.toCall)}</span>
                </button>
              )}
              {canRaise && (
                <button className="btn-raise" onClick={()=>onAct({type:raiseAmt>=rMax?"allin":"raise",amount:raiseAmt})}>
                  RAISE<br/><span style={{fontSize:13,fontWeight:700}}>{displayAmount(raiseAmt)}</span>
                </button>
              )}
              {you.canCheck && (
                <button className="btn-check" onClick={()=>onAct({type:"check"})}>
                  CHECK ✓
                </button>
              )}
              {you && !you.allIn && you.chips > 0 && you.toCall >= you.chips && (
                <button className="btn-allin" onClick={()=>onAct({type:"allin"})}>
                  ALL-IN<br/><span style={{fontSize:13,fontWeight:700}}>{displayAmount(you.chips)}</span>
                </button>
              )}
              <button className="btn-fold" onClick={()=>{
                if(you.canCheck){
                  if(window.confirm("You can check for free — sure you want to fold?")) onAct({type:"fold"});
                } else {
                  onAct({type:"fold"});
                }
              }}>
                FOLD
              </button>
            </div>
            {/* Raise slider */}
            {canRaise&&(
              <div id="raise-slider" style={{display:"flex",flexDirection:"column",gap:4,marginTop:2}}>
                <div style={{display:"flex",gap:3}}>
                  {presets.map(p=><button key={p.l} onClick={()=>setRaiseAmt(p.v)} style={{flex:1,padding:"3px 0",borderRadius:5,fontSize:10,fontWeight:600,cursor:"pointer",border:raiseAmt===p.v?"1px solid #f59e0b":"1px solid rgba(255,255,255,0.08)",background:raiseAmt===p.v?"rgba(245,158,11,0.2)":"transparent",color:raiseAmt===p.v?"#f59e0b":"#64748b"}}>{p.l}</button>)}
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <input type="range" min={rMin} max={rMax} step={Math.max(1,Math.floor(bb/2))} value={raiseAmt} onChange={e=>setRaiseAmt(+e.target.value)} style={{flex:1,accentColor:"#f59e0b"}}/>
                  <button onClick={()=>onAct({type:raiseAmt>=rMax?"allin":"raise",amount:raiseAmt})}
                    style={{padding:"8px 12px",background:"transparent",border:`2px solid ${raiseAmt>=rMax?"#f97316":"#f59e0b"}`,borderRadius:7,color:raiseAmt>=rMax?"#f97316":"#f59e0b",fontWeight:800,fontSize:12,cursor:"pointer",whiteSpace:"nowrap",minWidth:90}}>
                    {raiseAmt>=rMax?"ALL-IN":"RAISE"}<br/><span style={{fontSize:12,fontWeight:700}}>{displayAmount(raiseAmt)}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : you?.inHand ? (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{textAlign:"center",color:"#64748b",fontSize:12}}>Waiting for your turn…</div>
            <div style={{display:"flex",gap:6}}>
              {(["checkFold","callAny","check"] as const).map(a=>(
                <button key={a} onClick={()=>setAutoAction(autoAction===a?null:a)}
                  style={{flex:1,padding:"8px 0",borderRadius:8,fontSize:11,fontWeight:600,cursor:"pointer",
                    background:autoAction===a?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.6)",
                    border:autoAction===a?"1px solid #6366f1":"1px solid rgba(255,255,255,0.08)",
                    color:autoAction===a?"#a5b4fc":"#64748b"}}>
                  {a==="checkFold"?"✓/✗ Chk/Fold":a==="callAny"?"📞 Call Any":"✓ Check"}
                </button>
              ))}
            </div>
          </div>
        ) : ((you && you.chips <= 0) || (!you && wasSeated.current && lastKnownChips.current <= 0)) && !table.handActive ? (
          <div style={{display:"flex",flexDirection:"column",gap:8,alignItems:"center",padding:"8px 0"}}>
            <div style={{fontSize:22}}>💸</div>
            <div style={{color:"#ef4444",fontWeight:800,fontSize:15}}>You're busted!</div>
            <div style={{display:"flex",gap:8,width:"100%"}}>
              <button onClick={()=>onRebuy()} style={{flex:2,padding:"13px 0",background:"rgba(67,56,202,0.7)",border:"2px solid #6366f1",borderRadius:12,color:"#e0e7ff",fontWeight:800,fontSize:15,cursor:"pointer"}}>💰 REBUY</button>
              <button onClick={()=>onLeave()} style={{flex:1,padding:"13px 0",background:"rgba(127,29,29,0.4)",border:"1px solid #7f1d1d",borderRadius:12,color:"#fca5a5",fontWeight:700,fontSize:13,cursor:"pointer"}}>LEAVE</button>
            </div>
          </div>
        ) : you?.allIn && table.handActive && !table.lastResult ? (
          <div style={{textAlign:"center",color:"#f97316",fontSize:13,padding:"8px 0",fontWeight:600}}>🔥 All-in — waiting for board…</div>
        ) : you && you.sittingOut ? (
          <div style={{display:"flex",flexDirection:"column",gap:8,alignItems:"center",padding:"6px 0"}}>
            <div style={{color:"#64748b",fontSize:12}}>⏸ On a break</div>
            <button onClick={()=>onPause()}
              style={{padding:"10px 24px",background:"rgba(34,197,94,0.2)",border:"2px solid #22c55e",borderRadius:10,color:"#22c55e",fontWeight:700,fontSize:14,cursor:"pointer"}}>
              ▶ COME BACK
            </button>
          </div>
        ) : you && !you.inHand ? (
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0"}}>
            <div style={{color:"#64748b",fontSize:12}}>⏳ Dealt next hand</div>
            <button onClick={()=>onAct({type:"sit_out"} as any)}
              style={{padding:"6px 14px",background:"transparent",border:"1px solid #475569",borderRadius:8,color:"#64748b",fontWeight:600,fontSize:11,cursor:"pointer"}}>
              ⏸ BREAK
            </button>
          </div>
        ) : (
          <div style={{textAlign:"center"}}>{onSitDown&&<button onClick={()=>onSitDown?.()} style={{padding:"10px 24px",background:"#4338ca",color:"#fff",border:"none",borderRadius:9,fontSize:14,fontWeight:700,cursor:"pointer"}}>SIT DOWN</button>}</div>
        )}
      </div>

      {/* ACTION LOG — compact strip */}
      {(table.actionLog?.length||0)>0&&(
        <div style={{padding:"4px 10px",background:"rgba(10,10,15,0.9)",borderTop:"1px solid rgba(255,255,255,0.04)",flexShrink:0,display:"flex",gap:6,overflowX:"auto"}}>
          {[...table.actionLog].slice(-6).map((e,i)=>(
            <div key={i} style={{display:"flex",gap:3,fontSize:10,whiteSpace:"nowrap",flexShrink:0}}>
              <span style={{color:"#475569"}}>{e.name.slice(0,6)}</span>
              <span style={{color:e.label==="FOLD"?"#ef4444":e.label==="CHECK"?"#64748b":e.label==="ALL-IN"?"#f97316":"#818cf8",fontWeight:600}}>{e.label}{e.amount?` ${displayAmount(e.amount)}`:""}</span>
            </div>
          ))}
        </div>
      )}

      {/* CHAT SLIDE-UP */}
      {chatOpen&&(
        <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(15,23,42,0.98)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"16px 16px 0 0",zIndex:40,maxHeight:"50vh",display:"flex",flexDirection:"column"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
            <span style={{fontSize:12,fontWeight:600,color:"#94a3b8"}}>Table Chat</span>
            <button onClick={()=>setChatOpen(false)} style={{background:"none",border:"none",color:"#64748b",fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
          </div>
          <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"8px 12px",display:"flex",flexDirection:"column",gap:5}}>
            {!table.chat?.length?<div style={{color:"#1e293b",textAlign:"center",fontSize:12,padding:16}}>No messages yet</div>:
              table.chat.map(m=>(
                <div key={m.id} style={{display:"flex",flexDirection:"column",alignItems:m.seat===you?.seat?"flex-end":"flex-start"}}>
                  <span style={{fontSize:9,color:"#475569",marginBottom:1}}>{m.name}</span>
                  <div style={{padding:"4px 10px",borderRadius:10,fontSize:12,maxWidth:"85%",background:m.seat===you?.seat?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.8)",color:m.seat===you?.seat?"#c7d2fe":"#cbd5e1"}}>{m.text}</div>
                </div>
              ))}
          </div>
          <div style={{display:"flex",gap:6,padding:"8px 12px",borderTop:"1px solid rgba(255,255,255,0.06)"}}>
            <input value={chatText} onChange={e=>setChatText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&chatText.trim()&&you){onChat(chatText.trim());setChatText("");}}} placeholder={you?"Message…":"Sit to chat"} disabled={!you} maxLength={140}
              style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"8px 10px",fontSize:13,color:"#e2e8f0",outline:"none"}}/>
            <button onClick={()=>{if(chatText.trim()&&you){onChat(chatText.trim());setChatText("");}}} style={{padding:"8px 14px",background:"#4338ca",border:"none",borderRadius:8,color:"#fff",fontWeight:700,cursor:"pointer"}}>→</button>
          </div>
          {/* Reactions */}
          {you&&<div style={{display:"flex",gap:6,padding:"6px 12px 10px",justifyContent:"center"}}>
            {["😂","😤","🤔","😭","🔥","💩","👋"].map(e=><button key={e} onClick={()=>{}} style={{fontSize:22,background:"none",border:"none",cursor:"pointer",padding:2}}>{e}</button>)}
          </div>}
        </div>
      )}
    </div>
  );
}

// ── Room Settings ────────────────────────────────────────────────────────────
function RoomSettings({ onConfirm, onCancel, playerName }: { onConfirm:(s:any)=>void; onCancel:()=>void; playerName:string }) {
  const [currency, setCurrency] = useState<'chips'|'usd'|'sol'>('chips');
  const [sbN, setSbN] = useState(currency==='usd'?0.25:currency==='sol'?0.05:5);
  const [bbN, setBbN] = useState(currency==='usd'?0.50:currency==='sol'?0.10:10);
  const [chipsN, setChipsN] = useState<number|string>(currency==='usd'?50:currency==='sol'?1:1000);
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [blindsMode, setBlindsMode] = useState<"fixed"|"schedule">("fixed");
  const [blindInterval, setBlindInterval] = useState(10); // minutes
  const [roomName, setRoomName] = useState(`${playerName}'s Table`);

  function toInternal(n: number) {
    if (currency === 'sol') return Math.round(n * 1e9);
    if (currency === 'usd') return Math.round(n * 100); // 1 cent = 1 lamport
    return Math.round(n); // chips: 1:1
  }

  const presetBlinds = currency === 'chips'
    ? [{sb:1,bb:2},{sb:5,bb:10},{sb:10,bb:20},{sb:25,bb:50},{sb:50,bb:100}]
    : currency === 'usd'
    ? [{sb:0.05,bb:0.10},{sb:0.10,bb:0.25},{sb:0.25,bb:0.50},{sb:0.50,bb:1},{sb:1,bb:2},{sb:2,bb:5},{sb:5,bb:10},{sb:10,bb:20}]
    : [{sb:0.01,bb:0.02},{sb:0.05,bb:0.10},{sb:0.10,bb:0.20},{sb:0.25,bb:0.50},{sb:1.00,bb:2.00}];

  const presetChipsList = currency === 'chips'
    ? [500,1000,2000,5000,10000]
    : currency === 'usd'
    ? [10,20,50,100,200,500]
    : [0.5,1,2,5,10];

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{fontSize:13,fontWeight:700,color:"#94a3b8",marginBottom:2}}>Room Settings</div>

      {/* Currency toggle */}
      <div>
        <div style={{fontSize:10,color:"#64748b",marginBottom:4,fontWeight:600,letterSpacing:1}}>CURRENCY</div>
        <div style={{display:"flex",gap:6}}>
          {(['chips','usd','sol'] as const).map(cur=>(
            <button key={cur} onClick={()=>{
              setCurrency(cur);
              if(cur==='chips'){setSbN(5);setBbN(10);setChipsN(1000);}
              else if(cur==='usd'){setSbN(0.25);setBbN(0.50);setChipsN(50);}
              else{setSbN(0.05);setBbN(0.10);setChipsN(1);}
            }}
              style={{flex:1,padding:"7px 0",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
                background:currency===cur?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.6)",
                border:currency===cur?"1px solid #6366f1":"1px solid rgba(255,255,255,0.08)",
                color:currency===cur?"#a5b4fc":"#64748b"}}>
              {cur==='chips'?'🎰 Chips':cur==='usd'?'💵 USD':'◎ SOL'}
            </button>
          ))}
        </div>
      </div>

      {/* Room name */}
      <div>
        <div style={{fontSize:10,color:"#64748b",marginBottom:4,fontWeight:600,letterSpacing:1}}>ROOM NAME</div>
        <input value={roomName} onChange={e=>setRoomName(e.target.value)} maxLength={30}
          style={{width:"100%",background:"rgba(30,41,59,0.7)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"7px 10px",fontSize:13,color:"#f1f5f9",outline:"none",boxSizing:"border-box"}}/>
      </div>

      {/* Blinds presets */}
      <div>
        <div style={{fontSize:10,color:"#64748b",marginBottom:4,fontWeight:600,letterSpacing:1}}>BLINDS</div>
        {currency==="chips" && (
          <div style={{display:"flex",gap:4,marginBottom:8}}>
            {(["fixed","schedule"] as const).map(m=>(
              <button key={m} onClick={()=>setBlindsMode(m)} style={{flex:1,padding:"5px 0",borderRadius:7,fontSize:11,fontWeight:700,cursor:"pointer",
                background:blindsMode===m?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.5)",
                border:blindsMode===m?"1px solid #6366f1":"1px solid rgba(255,255,255,0.06)",
                color:blindsMode===m?"#a5b4fc":"#64748b"}}>
                {m==="fixed"?"Fixed":"⏱ Increasing"}
              </button>
            ))}
          </div>
        )}
        {blindsMode==="schedule" && currency==="chips" ? (
          <div>
            <div style={{fontSize:10,color:"#475569",marginBottom:6}}>INCREASE EVERY</div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
              {[5,10,15,20,30].map(m=>(
                <button key={m} onClick={()=>setBlindInterval(m)} style={{padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                  background:blindInterval===m?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.5)",
                  border:blindInterval===m?"1px solid #6366f1":"1px solid rgba(255,255,255,0.06)",
                  color:blindInterval===m?"#a5b4fc":"#64748b"}}>{m}m</button>
              ))}
            </div>
            <div style={{fontSize:9,color:"#334155",padding:"4px 8px",background:"rgba(30,41,59,0.4)",borderRadius:6}}>
              25/50 → 50/100 → 100/200 → 200/400 → 300/600 → ...
            </div>
          </div>
        ) : (
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:5}}>
            {presetBlinds.map(p=>(
              <button key={p.sb} onClick={()=>{setSbN(p.sb);setBbN(p.bb);}}
                style={{padding:"4px 8px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                  background:sbN===p.sb?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.5)",
                  border:sbN===p.sb?"1px solid #6366f1":"1px solid rgba(255,255,255,0.06)",
                  color:sbN===p.sb?"#a5b4fc":"#64748b"}}>
                {p.sb}/{p.bb}
              </button>
            ))}
          </div>
        )}
        <div style={{display:"flex",gap:6}}>
          <div style={{flex:1}}>
            <div style={{fontSize:9,color:"#475569",marginBottom:2}}>SB</div>
            <input type="number" value={sbN} onChange={e=>setSbN(e.target.value===''?0:parseFloat(e.target.value)||1)} step={currency==='chips'?1:currency==='usd'?0.05:0.01} min={currency==='chips'?1:currency==='usd'?0.05:0.01}
              style={{width:"100%",background:"rgba(30,41,59,0.7)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"6px 8px",fontSize:13,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:9,color:"#475569",marginBottom:2}}>BB</div>
            <input type="number" value={bbN} onChange={e=>setBbN(e.target.value===''?0:parseFloat(e.target.value)||2)} step={currency==='chips'?1:currency==='usd'?0.05:0.01} min={currency==='chips'?2:currency==='usd'?0.10:0.02}
              style={{width:"100%",background:"rgba(30,41,59,0.7)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"6px 8px",fontSize:13,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
          </div>
        </div>
      </div>

      {/* Starting chips */}
      <div>
        <div style={{fontSize:10,color:"#64748b",marginBottom:4,fontWeight:600,letterSpacing:1}}>STARTING STACK</div>
        <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:5}}>
          {presetChipsList.map(p=>(
            <button key={p} onClick={()=>setChipsN(p)} 
              style={{padding:"4px 8px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                background:chipsN===p?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.5)",
                border:chipsN===p?"1px solid #6366f1":"1px solid rgba(255,255,255,0.06)",
                color:chipsN===p?"#a5b4fc":"#64748b"}}>
              {p}
            </button>
          ))}
        </div>
        <input type="number" value={chipsN} onChange={e=>setChipsN(e.target.value===''?'':parseFloat(e.target.value))} min={0.01} placeholder={currency==='chips'?'Enter chips...':'Enter amount...'}
          style={{width:"100%",background:"rgba(30,41,59,0.7)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:7,padding:"6px 8px",fontSize:13,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
      </div>

      {/* Max players */}
      <div>
        <div style={{fontSize:10,color:"#64748b",marginBottom:4,fontWeight:600,letterSpacing:1}}>MAX PLAYERS</div>
        <div style={{display:"flex",gap:4}}>
          {[2,3,4,5,6,8,9].map(n=>(
            <button key={n} onClick={()=>setMaxPlayers(n)}
              style={{flex:1,padding:"5px 0",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer",
                background:maxPlayers===n?"rgba(99,102,241,0.3)":"rgba(30,41,59,0.5)",
                border:maxPlayers===n?"1px solid #6366f1":"1px solid rgba(255,255,255,0.06)",
                color:maxPlayers===n?"#a5b4fc":"#64748b"}}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div style={{display:"flex",gap:8,marginTop:4}}>
        <button onClick={onCancel} style={{flex:1,padding:"9px 0",borderRadius:9,background:"transparent",border:"1px solid rgba(255,255,255,0.07)",color:"#64748b",fontWeight:700,fontSize:13,cursor:"pointer"}}>BACK</button>
        <button onClick={()=>onConfirm({sb:toInternal(sbN),bb:toInternal(bbN),chips:toInternal(parseFloat(String(chipsN))||1000),currency,name:roomName,maxPlayers})}
          style={{flex:2,padding:"9px 0",borderRadius:9,background:"#166534",border:"none",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>CREATE ROOM →</button>
      </div>
    </div>
  );
}

// ── Homepage ──────────────────────────────────────────────────────────────────
const CASH_TABLES = [
  {id:"table1",name:"Micro Felt",   sb:0.001,bb:0.002,min:0.1, max:1,  color:"#22c55e"},
  {id:"table2",name:"Main Event",   sb:0.005,bb:0.010,min:0.5, max:5,  color:"#06b6d4"},
  {id:"table3",name:"High Roller",  sb:0.010,bb:0.020,min:1,   max:10, color:"#a855f7"},
  {id:"table4",name:"Whale Table",  sb:0.050,bb:0.100,min:5,   max:50, color:"#f59e0b"},
  {id:"table5",name:"Nosebleed",    sb:0.100,bb:0.200,min:10,  max:100,color:"#ef4444"},
  {id:"table6",name:"Custom",       sb:0,    bb:0,    min:0,   max:0,  color:"#64748b"},
];

function HomePage({ onPractice, onRoom, onCash, lobby, connected }: { onPractice:()=>void; onRoom:(settings:{sb:number;bb:number;chips:number;currency:'chips'|'usd'|'sol';name:string;maxPlayers:number})=>void; onCash:(id:string,l:number,customSb?:number,customBb?:number)=>void; lobby:LobbyTable[]; connected:boolean; }) {
  const [name, setName] = useState(()=>typeof sessionStorage!=="undefined"?sessionStorage.getItem("player_name")||"":"");
  const [nameErr, setNameErr] = useState("");
  const [showRoom, setShowRoom] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [buyInTable, setBuyInTable] = useState<typeof CASH_TABLES[0]|null>(null);
  const [buyAmt, setBuyAmt] = useState("");
  const [customSb, setCustomSb] = useState("0.010");
  const [customBb, setCustomBb] = useState("0.020");

  function saveName(n: string) { setName(n); if(typeof sessionStorage!=="undefined") sessionStorage.setItem("player_name",n); }
  function requireName() { if(!name.trim()){setNameErr("Enter your name first");return false;} setNameErr("");return true; }

  return (
    <div style={{minHeight:"100dvh",background:"#0a0a0f",color:"#e2e8f0",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",overflowY:"auto"}}>
      <div style={{maxWidth:860,margin:"0 auto",padding:"24px 14px"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <h1 style={{fontSize:34,fontWeight:900,margin:0,letterSpacing:-1,color:"#f1f5f9"}}>DECENT POKER</h1>
          <p style={{color:"#475569",margin:"5px 0 0",fontSize:13}}>Texas Hold'em · Provably fair · Play with friends</p>
        </div>

        <div style={{maxWidth:300,margin:"0 auto 20px",textAlign:"center"}}>
          <input value={name} onChange={e=>{saveName(e.target.value);setNameErr("");}} placeholder="Enter your name…" maxLength={20}
            style={{width:"100%",background:"rgba(30,41,59,0.8)",border:`1px solid ${nameErr?"#ef4444":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"11px 16px",fontSize:15,color:"#f1f5f9",outline:"none",boxSizing:"border-box",textAlign:"center"}}/>
          {nameErr&&<p style={{color:"#ef4444",fontSize:12,margin:"4px 0 0"}}>{nameErr}</p>}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:12,marginBottom:20}}>
          {/* Practice */}
          <div style={{padding:20,borderRadius:16,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(99,102,241,0.2)"}}>
            <div style={{fontSize:26,marginBottom:8}}>🤖</div>
            <h2 style={{margin:"0 0 6px",fontSize:17,fontWeight:800,color:"#f1f5f9"}}>Practice</h2>
            <p style={{margin:"0 0 12px",color:"#64748b",fontSize:12}}>Play vs bots with 1,000 free chips. No wallet needed.</p>
            <button onClick={()=>{if(!requireName())return;onPractice();}} style={{width:"100%",padding:"10px 0",background:"#4338ca",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer"}}>PLAY NOW →</button>
          </div>

          {/* Friend Table */}
          <div style={{padding:20,borderRadius:16,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(34,197,94,0.2)"}}>
            <div style={{fontSize:26,marginBottom:8}}>🃏</div>
            <h2 style={{margin:"0 0 6px",fontSize:17,fontWeight:800,color:"#f1f5f9"}}>Friend Table</h2>
            <p style={{margin:"0 0 12px",color:"#64748b",fontSize:12}}>Private room with shareable link. No wallet needed.</p>
            {!showRoom ? (
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <button onClick={()=>{if(!requireName())return;setShowRoom(true);}} style={{width:"100%",padding:"10px 0",background:"#166534",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer"}}>CREATE ROOM →</button>
                <div style={{display:"flex",gap:6}}>
                  <input value={roomCode} onChange={e=>setRoomCode(e.target.value.toLowerCase())} placeholder="Have a code? Enter it…" maxLength={6}
                    style={{flex:1,background:"rgba(30,41,59,0.6)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:8,padding:"7px 10px",fontSize:13,color:"#f1f5f9",outline:"none",fontFamily:"monospace",letterSpacing:2}}/>
                  <button onClick={()=>{if(roomCode.trim().length===6)window.location.href=`/table/${roomCode.trim()}`;}} style={{padding:"7px 12px",background:"rgba(22,101,52,0.4)",border:"1px solid rgba(34,197,94,0.25)",borderRadius:8,color:"#86efac",fontSize:13,fontWeight:700,cursor:"pointer"}}>JOIN</button>
                </div>
              </div>
            ) : (
              <RoomSettings onCancel={()=>setShowRoom(false)} onConfirm={(s)=>{if(!requireName())return;onRoom(s);}} playerName={name}/>
            )}
          </div>
        </div>

        {/* Cash Games */}
        <div style={{padding:18,borderRadius:16,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(245,158,11,0.2)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <span style={{fontSize:22}}>💎</span>
            <div>
              <h2 style={{margin:0,fontSize:17,fontWeight:800,color:"#f1f5f9"}}>Cash Games</h2>
              <p style={{margin:0,color:"#64748b",fontSize:11}}>Real SOL · Multiple stake levels</p>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
            {CASH_TABLES.map(t=>{
              const live=lobby.find(l=>l.id===t.id);
              return (
                <div key={t.id} onClick={()=>{if(!requireName())return;setBuyInTable(t);setBuyAmt(t.min.toString());}}
                  style={{padding:"10px 12px",borderRadius:10,background:"rgba(10,10,15,0.6)",border:`1px solid ${t.color}22`,cursor:"pointer"}}
                  onMouseOver={e=>(e.currentTarget as any).style.borderColor=t.color+"66"}
                  onMouseOut={e=>(e.currentTarget as any).style.borderColor=t.color+"22"}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontWeight:700,color:"#e2e8f0",fontSize:13}}>{t.name}</span>
                    {live?.inHand&&<div style={{display:"flex",alignItems:"center",gap:2}}><div style={{width:4,height:4,borderRadius:"50%",background:"#ef4444"}}/><span style={{fontSize:9,color:"#ef4444"}}>LIVE</span></div>}
                  </div>
                  <div style={{fontSize:11,color:"#64748b",fontFamily:"monospace",marginBottom:4}}>{t.id==="table6"?"Custom blinds":`${t.sb}/${t.bb} SOL`}</div>
                  {live&&<div style={{display:"flex",gap:3}}>{Array.from({length:live.maxSeats}).map((_,i)=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:i<live.seated?"#818cf8":"#1e293b"}}/>)}<span style={{fontSize:9,color:"#475569",marginLeft:3}}>{live.seated}/{live.maxSeats}</span></div>}
                </div>
              );
            })}
          </div>
        </div>

        {!connected&&<div style={{textAlign:"center",color:"#334155",fontSize:12,marginTop:12}}>⟳ Connecting to game server…</div>}
      </div>

      {/* Buy-in modal */}
      {buyInTable&&(
        <div onClick={()=>setBuyInTable(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:100,padding:0}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,background:"#0f172a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"20px 20px 0 0",padding:24}}>
            <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:800,color:"#f1f5f9"}}>BUY IN — {buyInTable.name}</h2>
            {buyInTable.id==="table6"?(
              <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:14}}>
                <p style={{margin:0,color:"#64748b",fontSize:13}}>Set custom blinds</p>
                <div style={{display:"flex",gap:8}}>
                  <div style={{flex:1}}><label style={{fontSize:10,color:"#64748b",display:"block",marginBottom:3}}>SMALL BLIND</label><input type="number" value={customSb} onChange={e=>setCustomSb(e.target.value)} step="0.001" style={{width:"100%",background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"9px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/></div>
                  <div style={{flex:1}}><label style={{fontSize:10,color:"#64748b",display:"block",marginBottom:3}}>BIG BLIND</label><input type="number" value={customBb} onChange={e=>setCustomBb(e.target.value)} step="0.001" style={{width:"100%",background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"9px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/></div>
                </div>
                <div><label style={{fontSize:10,color:"#64748b",display:"block",marginBottom:3}}>BUY-IN (SOL)</label><input type="number" value={buyAmt} onChange={e=>setBuyAmt(e.target.value)} step="0.1" min="0.1" style={{width:"100%",background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"10px 12px",fontSize:16,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/></div>
              </div>
            ):(
              <div style={{marginBottom:14}}>
                <p style={{margin:"0 0 10px",color:"#64748b",fontSize:12}}>Blinds: {buyInTable.sb}/{buyInTable.bb} · Buy-in: {buyInTable.min}–{buyInTable.max} SOL</p>
                <div style={{display:"flex",gap:5,marginBottom:8}}>
                  {[buyInTable.min,buyInTable.min*2,buyInTable.min*5,buyInTable.max].map(v=>(
                    <button key={v} onClick={()=>setBuyAmt(v.toString())} style={{flex:1,padding:"5px 0",borderRadius:7,fontSize:11,fontWeight:600,cursor:"pointer",background:buyAmt===v.toString()?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.6)",border:buyAmt===v.toString()?"1px solid #4338ca":"1px solid rgba(255,255,255,0.06)",color:buyAmt===v.toString()?"#a5b4fc":"#64748b"}}>{v}</button>
                  ))}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <input type="number" min={buyInTable.min} max={buyInTable.max} step="0.01" value={buyAmt} onChange={e=>setBuyAmt(e.target.value)}
                    style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"11px 14px",fontSize:18,color:"#f1f5f9",fontFamily:"monospace",outline:"none"}}/>
                  <span style={{color:"#475569",fontWeight:600}}>SOL</span>
                </div>
              </div>
            )}
            <div style={{display:"flex",gap:9}}>
              <button onClick={()=>setBuyInTable(null)} style={{flex:1,padding:"12px 0",borderRadius:12,background:"transparent",border:"1px solid rgba(255,255,255,0.07)",color:"#64748b",fontWeight:700,fontSize:14,cursor:"pointer"}}>CANCEL</button>
              <button onClick={()=>{
                const amt=parseFloat(buyAmt);
                if(isNaN(amt)||amt<=0)return;
                const sb=buyInTable.id==="table6"?Math.round(parseFloat(customSb)*1e9):undefined;
                const bb=buyInTable.id==="table6"?Math.round(parseFloat(customBb)*1e9):undefined;
                onCash(buyInTable.id,Math.round(amt*1e9),sb,bb);
                setBuyInTable(null);
              }} style={{flex:1,padding:"12px 0",borderRadius:12,background:"#4338ca",border:"none",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>CONFIRM</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Share Modal ───────────────────────────────────────────────────────────────
function ShareModal({ roomId, onClose }: { roomId:string; onClose:()=>void }) {
  const url = typeof window!=="undefined" ? `${window.location.origin}/table/${roomId}` : `/table/${roomId}`;
  const [copied, setCopied] = useState(false);
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:100}}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:440,background:"#0f172a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"20px 20px 0 0",padding:28}}>
        <h2 style={{margin:"0 0 6px",fontSize:20,fontWeight:800,color:"#f1f5f9"}}>🎉 Room Created!</h2>
        <p style={{margin:"0 0 14px",color:"#64748b",fontSize:13}}>Share this link:</p>
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          <input readOnly value={url} style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"9px 12px",fontSize:11,color:"#a5b4fc",fontFamily:"monospace",outline:"none"}}/>
          <button onClick={()=>{navigator.clipboard?.writeText(url);setCopied(true);setTimeout(()=>setCopied(false),2000);}} style={{padding:"9px 14px",background:copied?"#166534":"#4338ca",border:"none",borderRadius:9,color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>{copied?"✓":"COPY"}</button>
        </div>
        <div style={{textAlign:"center",marginBottom:14}}>
          <div style={{fontSize:10,color:"#475569",marginBottom:3}}>Room code</div>
          <div style={{fontSize:28,fontWeight:900,fontFamily:"monospace",letterSpacing:6,color:"#f1f5f9"}}>{roomId.toUpperCase()}</div>
        </div>
        <button onClick={onClose} style={{width:"100%",padding:"12px 0",background:"#166534",border:"none",borderRadius:12,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"}}>START PLAYING</button>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "wss://decent-poker-production.up.railway.app";

export default function App() {
  const [isHost, setIsHost] = useState(()=>typeof sessionStorage!=="undefined"&&sessionStorage.getItem("is_host")==="1");
  const [showAdmin, setShowAdmin] = useState(false);
  const { connected, lobby, table, error, roomId, setRoomId, send, setTable } = useWS(WS_URL, (m) => {
    if (m.type === "room_created") {
      setIsHost(true);
      if (typeof sessionStorage!=="undefined") sessionStorage.setItem("is_host","1");
    } else if (m.type === "joined" && m.isHost === true) {
      setIsHost(true);
      if (typeof sessionStorage!=="undefined") sessionStorage.setItem("is_host","1");
    } else if ((m.type === "joined" || m.type === "state") && m.isHost === false) {
      setIsHost(false);
      if (typeof sessionStorage!=="undefined") sessionStorage.removeItem("is_host");
    }
  });
  const [view, setView] = useState<"home"|"table">("home");
  const [showRebuy, setShowRebuy] = useState(false);
  const [rebuyAmt, setRebuyAmt] = useState("1000");
  const [selectedSeat, setSelectedSeat] = useState<number|null>(null);
  const [sitConfirmAmt, setSitConfirmAmt] = useState("1000");
  // Always use the same seed from sessionStorage so playerId is stable
  const seed = (() => {
    if (typeof sessionStorage !== "undefined") {
      let s = sessionStorage.getItem("player_seed");
      if (!s) { s = genSeed(); sessionStorage.setItem("player_seed", s); }
      return s;
    }
    return genSeed();
  })();

  useEffect(() => { if (table) setView("table"); }, [!!table]);

  // Auto-prompt rebuy when player busts - only after hand ends
  useEffect(() => {
    if (table?.you && table.you.chips <= 0 && !table.handActive && !showRebuy) {
      const cur = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("table_currency")||"chips" : "chips";
      setRebuyAmt(cur==="usd"?"50":cur==="sol"?"1":"1000");
      setTimeout(() => setShowRebuy(true), 1500);
    }
  }, [table?.you?.chips, table?.handActive]);

  // join_room is handled in onopen above

  function handlePractice() {
    sessionStorage.setItem("player_seed", seed);
    sessionStorage.setItem("current_table_id", "table1");
    sessionStorage.setItem("table_currency", "chips");
    send({ type:"practice", tableId:"table1", name:getPlayerName(), playerSeed:seed });
  }

  function handleRoom(settings: {sb:number;bb:number;chips:number;currency:string;name:string;maxPlayers:number}) {
    sessionStorage.setItem("player_seed", seed);
    sessionStorage.setItem("room_currency", settings.currency);
    sessionStorage.setItem("table_currency", settings.currency);
    sessionStorage.setItem("room_chips_start", settings.chips.toString());
    sessionStorage.setItem("last_room_settings", JSON.stringify(settings));
    send({ type:"create_room", name:getPlayerName(), playerSeed:seed, sb:settings.sb, bb:settings.bb, maxPlayers:settings.maxPlayers, roomName:settings.name || `${getPlayerName()}'s Table`, chips:settings.chips, currency:settings.currency });
  }

  function handleCash(tableId: string, lamports: number) {
    sessionStorage.setItem("player_seed", seed);
    sessionStorage.setItem("current_table_id", tableId);
    sessionStorage.setItem("table_currency", "sol");
    const sig = `dev_${Date.now()}_${seed.slice(0,8)}`;
    send({ type:"join", tableId, lamports, signature:sig, name:getPlayerName(), playerSeed:seed });
  }

  function handleLeave() {
    if (table) send({ type:"cashout", tableId:table.id });
    sessionStorage.removeItem("current_table_id");
    if (typeof localStorage!=="undefined") {
      localStorage.removeItem("last_table_id");
      localStorage.removeItem("last_player_seed");
      localStorage.removeItem("my_seat_index");
    }
    setTable(null);
    setView("home");
    send({ type:"lobby" });
  }

  return (
    <>
      {/* Connection indicator when on home */}
      {view === "home" && (
        <div style={{position:"fixed",top:10,right:12,display:"flex",alignItems:"center",gap:5,zIndex:50}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:connected?"#34d399":"#ef4444"}}/>
          <span style={{fontSize:10,color:"#475569",fontFamily:"-apple-system,sans-serif"}}>{connected?"Live":"Connecting…"}</span>
        </div>
      )}

      {/* Nav on home */}
      {view === "home" && (
        <div style={{position:"fixed",top:8,left:12,zIndex:50}}>
          <span style={{fontSize:16,fontWeight:900,color:"#f1f5f9",fontFamily:"-apple-system,sans-serif",letterSpacing:-0.5}}>DECENT POKER</span>
        </div>
      )}

      {error && view==="home" && (
        <div style={{position:"fixed",top:40,left:"50%",transform:"translateX(-50%)",zIndex:60,padding:"8px 16px",background:"rgba(127,29,29,0.9)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:9,color:"#fca5a5",fontSize:13,whiteSpace:"nowrap"}}>
          {error}
        </div>
      )}

      {view==="table" && table ? (
        <TableView
          table={table}
          onAct={a=>send({type:"act",tableId:table.id,action:a,playerSeed:seed})}
          onChat={t=>send({type:"chat",tableId:table.id,text:t})}
          onLeave={handleLeave}
          onSitDown={(seatIdx)=>{
            setSelectedSeat(seatIdx??null);
            const cur = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("table_currency")||"chips" : "chips";
            setSitConfirmAmt(cur==="usd"?"50":cur==="sol"?"1":"1000");
          }}
          onRebuy={()=>setShowRebuy(true)}
          onPause={()=>{
            const mySeat = table.seats?.find((s:any)=>s?.id?.includes(seed.slice(0,8)));
            const isOut = mySeat?.sittingOut || table.you?.sittingOut;
            if(isOut) send({type:"resume",tableId:table.id,playerSeed:seed});
            else send({type:"pause",tableId:table.id,playerSeed:seed});
          }}
          isHost={isHost}
          onAdminAction={(action,targetName,amount,newSeat)=>send({type:"admin_action",tableId:table.id,action,targetName,amount,newSeat})}
        />
      ) : (
        <div style={{paddingTop:36}}>
          <HomePage onPractice={handlePractice} onRoom={(s)=>handleRoom(s)} onCash={handleCash} lobby={lobby} connected={connected}/>
        </div>
      )}

      {roomId && <ShareModal roomId={roomId} onClose={()=>setRoomId(null)}/>}

      {/* Seat selection confirm modal */}
      {selectedSeat !== null && !table?.you && (
        <div onClick={()=>setSelectedSeat(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:100}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:440,background:"#0f172a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"20px 20px 0 0",padding:24}}>
            <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:800,color:"#f1f5f9"}}>🪑 Sit at Seat {selectedSeat + 1}</h2>
            <p style={{margin:"0 0 14px",color:"#64748b",fontSize:13}}>Choose your starting stack</p>
            {(()=>{
              const currency = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("table_currency")||"chips" : "chips";
              const isUSD = currency === "usd";
              const isSOL = currency === "sol";
              const presets = isUSD ? ["10","20","50","100","200","500"] : isSOL ? ["0.5","1","2","5","10"] : ["500","1000","2000","5000","10000"];
              const unit = isUSD ? "USD ($)" : isSOL ? "SOL" : "chips";
              return (<>
                <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                  {presets.map(v=>(
                    <button key={v} onClick={()=>setSitConfirmAmt(v)} style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",
                      background:sitConfirmAmt===v?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.6)",
                      border:sitConfirmAmt===v?"1px solid #4338ca":"1px solid rgba(255,255,255,0.06)",
                      color:sitConfirmAmt===v?"#a5b4fc":"#64748b"}}>{isUSD?"$":""}{v}</button>
                  ))}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                  <input type="number" value={sitConfirmAmt} onChange={e=>setSitConfirmAmt(e.target.value)} min={isUSD?"1":isSOL?"0.1":"100"} step={isUSD?"1":isSOL?"0.1":"100"}
                    style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"11px 14px",fontSize:18,color:"#f1f5f9",fontFamily:"monospace",outline:"none"}}/>
                  <span style={{color:"#475569",fontWeight:600}}>{unit}</span>
                </div>
              </>);
            })()}
            <div style={{display:"flex",gap:9}}>
              <button onClick={()=>setSelectedSeat(null)} style={{flex:1,padding:"11px 0",borderRadius:12,background:"transparent",border:"1px solid rgba(255,255,255,0.07)",color:"#64748b",fontWeight:700,fontSize:14,cursor:"pointer"}}>CANCEL</button>
              <button onClick={()=>{
                if (!table) return;
                const cur = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("table_currency")||"chips" : "chips";
                const raw = parseFloat(sitConfirmAmt)||1000;
                // Convert to internal units
                const chips = cur==="usd" ? Math.round(raw*100) : cur==="sol" ? Math.round(raw*1e9) : Math.round(raw);
                const pendingRoom = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("pending_join_room") : null;
                const pendingName = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("pending_join_name") : null;
                const playerName = pendingName || getPlayerName();
                if (pendingRoom) {
                  // Joining via invite — use join_room with player's chosen buy-in
                  let joinSeed = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("player_seed") : null;
                  if (!joinSeed) { joinSeed = genSeed(); if (typeof sessionStorage!=="undefined") sessionStorage.setItem("player_seed", joinSeed); }
                  send({type:"join_room", roomId:pendingRoom, name:playerName, playerSeed:joinSeed, currency:cur, chips});
                  if (typeof sessionStorage!=="undefined") {
                    sessionStorage.removeItem("join_room_id");
                    sessionStorage.removeItem("join_room_name");
                    sessionStorage.removeItem("pending_join_room");
                    sessionStorage.removeItem("pending_join_name");
                  }
                  if (typeof localStorage!=="undefined") {
                    localStorage.removeItem("pending_join_room");
                    localStorage.removeItem("pending_join_name");
                  }
                } else if (cur === "sol") {
                  const sig = `dev_${Date.now()}_${seed.slice(0,8)}`;
                  send({type:"join", tableId:table.id, lamports:chips, signature:sig, name:playerName, playerSeed:seed});
                } else {
                  send({type:"practice", tableId:table.id, name:getPlayerName(), playerSeed:seed, chips});
                }
                setSelectedSeat(null);
              }} style={{flex:2,padding:"11px 0",borderRadius:12,background:"#4338ca",border:"none",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>SIT DOWN</button>
            </div>
          </div>
        </div>
      )}
      {showRebuy && table && (
        <div onClick={()=>setShowRebuy(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:100}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:440,background:"#0f172a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"20px 20px 0 0",padding:24}}>
            <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:800,color:"#f1f5f9"}}>💸 Rebuy</h2>
            {(()=>{
              const cur = _currentCurrency || "chips";
              const isUSD = cur==="usd"; const isSOL = cur==="sol";
              const presets = isUSD ? ["10","20","50","100","200"] : isSOL ? ["0.5","1","2","5"] : ["500","1000","2000","5000"];
              const unit = isUSD ? "USD ($)" : isSOL ? "SOL (◎)" : "chips";
              const prefix = isUSD ? "$" : isSOL ? "◎" : "";
              return (<>
                <p style={{margin:"0 0 10px",color:"#64748b",fontSize:13}}>Add {unit} to stay in the game</p>
                <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                  {presets.map(v=>(
                    <button key={v} onClick={()=>setRebuyAmt(v)} style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",background:rebuyAmt===v?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.6)",border:rebuyAmt===v?"1px solid #4338ca":"1px solid rgba(255,255,255,0.06)",color:rebuyAmt===v?"#a5b4fc":"#64748b"}}>{prefix}{v}</button>
                  ))}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                  <input type="number" value={rebuyAmt} onChange={e=>setRebuyAmt(e.target.value)} min="1" step={isUSD?"1":isSOL?"0.1":"100"}
                    style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"11px 14px",fontSize:18,color:"#f1f5f9",fontFamily:"monospace",outline:"none"}}/>
                  <span style={{color:"#475569",fontWeight:600}}>{unit}</span>
                </div>
              </>);
            })()}
            <div style={{display:"flex",gap:9}}>
              <button onClick={()=>setShowRebuy(false)} style={{flex:1,padding:"11px 0",borderRadius:12,background:"transparent",border:"1px solid rgba(255,255,255,0.07)",color:"#64748b",fontWeight:700,fontSize:14,cursor:"pointer"}}>CANCEL</button>
              <button onClick={()=>{
                const cur = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("table_currency")||"chips" : "chips";
                const rawAmt = parseFloat(rebuyAmt)||1000;
                let chips: number;
                if(cur==="usd") chips = Math.round(rawAmt * 100);
                else if(cur==="sol") chips = Math.round(rawAmt * 1e9);
                else chips = Math.round(rawAmt);
                send({type:"rebuy", tableId:table.id, chips, playerSeed:seed});
                setShowRebuy(false);
              }} style={{flex:2,padding:"11px 0",borderRadius:12,background:"#4338ca",border:"none",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>ADD CHIPS</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
