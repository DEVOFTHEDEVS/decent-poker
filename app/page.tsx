"use client";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Card { r: string; s: string; red: boolean; }
interface Seat { id: string; name: string; chips: number; bet: number; cards: Card[]|"back"|null; folded: boolean; allIn: boolean; inHand: boolean; isButton: boolean; isTurn: boolean; isBot: boolean; idleMs: number; lastAction?: { label: string; amount?: number; ts: number }; avatarUrl?: string; sittingOut?: boolean; }
interface YouState { seat: number; chips: number; myTurn: boolean; canCheck: boolean; toCall: number; minRaiseTo: number; maxRaiseTo: number; inHand: boolean; allIn: boolean; }
interface TableState { id: string; name: string; sb: number; bb: number; maxSeats: number; seats: (Seat|null)[]; board: Card[]; pot: number; currentBet: number; street: string|null; handActive: boolean; seated: number; actionLog: { name: string; label: string; amount?: number }[]; lastResult?: { winners: { name: string; amount: number; hand: string; seat: number }[]; rake: number; reveal: boolean; winCards?: string[]; proof?: any }; chat: { id: string; seat: number; name: string; text: string }[]; pots?: { amount: number; label: string }[]; you: YouState|null; currentSeedHash?: string; }
interface LobbyTable { id: string; name: string; seated: number; maxSeats: number; inHand: boolean; sb: number; bb: number; minSol: number; maxSol: number; }

const sol = (l: number) => (l / 1e9).toFixed(4);
const SUIT_COLOR: Record<string, string> = { "♥":"#dc2626","♦":"#dc2626","♠":"#1e293b","♣":"#1e293b" };
function genSeed() { const a = new Uint8Array(16); if (typeof crypto!=="undefined") crypto.getRandomValues(a); return Array.from(a).map(b=>b.toString(16).padStart(2,"0")).join(""); }
function getPlayerName() { return (typeof sessionStorage!=="undefined" && sessionStorage.getItem("player_name")) || "Player"; }

// ── Sound Engine ──────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
function getAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch(e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(()=>{});
  return audioCtx;
}

function playTone(freq: number, dur: number, vol = 0.12, type: OscillatorType = "sine", delay = 0) {
  const ctx = getAudio(); if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = type; osc.frequency.value = freq;
  const t = ctx.currentTime + delay;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.start(t); osc.stop(t + dur + 0.01);
}

function playNoise(dur: number, vol = 0.08, hipass = 2000, delay = 0) {
  const ctx = getAudio(); if (!ctx) return;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass"; filter.frequency.value = hipass;
  const gain = ctx.createGain();
  const t = ctx.currentTime + delay;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  src.start(t); src.stop(t + dur + 0.01);
}

const Sounds = {
  // Card dealing: crisp card snap/flick sound
  deal(cardIndex = 0) {
    const delay = cardIndex * 0.13;
    const ctx = getAudio(); if (!ctx) return;
    const t = ctx.currentTime + delay;
    // Transient click (card snap)
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.003), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random()*2-1) * Math.pow(1 - i/data.length, 2);
    const click = ctx.createBufferSource(); click.buffer = buf;
    const cGain = ctx.createGain(); cGain.gain.setValueAtTime(0.6, t); cGain.gain.exponentialRampToValueAtTime(0.001, t+0.003);
    click.connect(cGain); cGain.connect(ctx.destination); click.start(t);
    // Paper flutter body
    const fbuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.055), ctx.sampleRate);
    const fd = fbuf.getChannelData(0);
    for (let i = 0; i < fd.length; i++) fd[i] = (Math.random()*2-1) * Math.pow(1 - i/fd.length, 1.5);
    const flutter = ctx.createBufferSource(); flutter.buffer = fbuf;
    const hp = ctx.createBiquadFilter(); hp.type = "bandpass"; hp.frequency.value = 2800; hp.Q.value = 0.8;
    const fGain = ctx.createGain(); fGain.gain.setValueAtTime(0.22, t+0.002); fGain.gain.exponentialRampToValueAtTime(0.001, t+0.055);
    flutter.connect(hp); hp.connect(fGain); fGain.connect(ctx.destination); flutter.start(t+0.002);
  },
  // Chip sliding into pot
  chips() {
    playNoise(0.05, 0.14, 2400, 0);
    playNoise(0.04, 0.10, 2800, 0.06);
    playNoise(0.04, 0.08, 3200, 0.11);
    playTone(420, 0.08, 0.05, "sine", 0.04);
  },
  // Check tap on table
  check() {
    playNoise(0.04, 0.12, 800, 0);
    playTone(200, 0.07, 0.08, "square", 0);
  },
  // Fold — card slap down
  fold() {
    playNoise(0.08, 0.14, 600, 0);
    playTone(180, 0.06, 0.06, "sine", 0.02);
  },
  // Win — ascending chime
  win() {
    [523, 659, 784, 1047].forEach((f, i) => playTone(f, 0.2, 0.1, "triangle", i * 0.09));
  },
  // Your turn — soft ping
  yourTurn() {
    playTone(660, 0.12, 0.1, "sine", 0);
    playTone(880, 0.14, 0.1, "sine", 0.12);
  },
  // Timer warning beeps
  beep(urgent = false) {
    playTone(urgent ? 880 : 660, urgent ? 0.12 : 0.08, urgent ? 0.18 : 0.1, "sine", 0);
  },
  // New hand starting — realistic card riffle shuffle
  shuffle() {
    const ctx = getAudio(); if (!ctx) return;
    for (let i = 0; i < 8; i++) {
      const t = ctx.currentTime + i * 0.045;
      const dur = 0.035 + Math.random() * 0.02;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < d.length; j++) d[j] = (Math.random()*2-1) * Math.pow(1 - j/d.length, 1.2);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2200 + Math.random()*800; bp.Q.value = 1.2;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.18 + Math.random()*0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t+dur);
      src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t);
    }
  },
};

// ── Card ──────────────────────────────────────────────────────────────────────
function PlayingCard({ card, small, highlight }: { card: Card|"back"|null; small?: boolean; highlight?: boolean }) {
  if (!card) return null;
  const w = small ? 30 : 46; const h = small ? 42 : 64; const fs = small ? 9 : 12;
  if (card === "back") return (
    <div style={{width:w,height:h,borderRadius:6,background:"linear-gradient(135deg,#1e1b4b,#312e81)",border:"1px solid #4338ca",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{width:"80%",height:"80%",borderRadius:4,border:"1px solid rgba(99,102,241,0.3)",background:"repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(99,102,241,0.08) 3px,rgba(99,102,241,0.08) 6px)"}}/>
    </div>
  );
  const color = SUIT_COLOR[card.s]||"#1e293b";
  return (
    <div style={{width:w,height:h,borderRadius:6,background:"#f8fafc",border:highlight?"2px solid #facc15":"1px solid #e2e8f0",flexShrink:0,padding:3,display:"flex",flexDirection:"column",justifyContent:"space-between",boxShadow:highlight?"0 0 12px rgba(250,204,21,0.5)":"0 2px 6px rgba(0,0,0,0.4)"}}>
      <div style={{color,fontSize:fs,fontWeight:800,lineHeight:1.1}}>{card.r}<br/><span style={{fontSize:fs-1}}>{card.s}</span></div>
      <div style={{color,fontSize:small?14:20,textAlign:"center",lineHeight:1}}>{card.s}</div>
      <div style={{color,fontSize:fs,fontWeight:800,lineHeight:1.1,transform:"rotate(180deg)"}}>{card.r}<br/><span style={{fontSize:fs-1}}>{card.s}</span></div>
    </div>
  );
}

// ── Seat ──────────────────────────────────────────────────────────────────────
function SeatPod({ seat, isMe, isWinner, winCards, bb, pos }: { seat: Seat; isMe: boolean; isWinner: boolean; winCards?: Set<string>; bb: number; pos: {left:string;top:string}; }) {
  const showAction = seat.lastAction && Date.now() - seat.lastAction.ts < 3500;
  const aC: Record<string,string> = {FOLD:"#ef4444",CHECK:"#94a3b8","ALL-IN":"#f97316",CALL:"#6366f1",RAISE:"#8b5cf6",BET:"#8b5cf6",SB:"#64748b",BB:"#64748b"};
  return (
    <div style={{position:"absolute",left:pos.left,top:pos.top,transform:"translate(-50%,-50%)",display:"flex",flexDirection:"column",alignItems:"center",gap:3,zIndex:seat.isTurn?20:10,opacity:seat.folded?0.35:1,pointerEvents:"none"}}>
      {seat.bet > 0 && (
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
          <div style={{display:"flex",gap:2}}>{Array.from({length:Math.min(5,Math.max(1,Math.ceil(seat.bet/(bb*5))))}).map((_,i)=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:"linear-gradient(#facc15,#ca8a04)",border:"1px solid #fde68a"}}/>)}</div>
          <span style={{fontSize:9,color:"#fde68a",fontFamily:"monospace"}}>{sol(seat.bet)}</span>
        </div>
      )}
      {showAction && <div style={{padding:"2px 6px",borderRadius:3,background:aC[seat.lastAction!.label]||"#374151",color:"#fff",fontSize:9,fontWeight:700}}>{seat.lastAction!.label}</div>}
      <div style={{display:"flex",gap:3}}>
        {seat.cards==="back"?<><PlayingCard card="back" small/><PlayingCard card="back" small/></>:
         Array.isArray(seat.cards)?seat.cards.map((c,i)=><PlayingCard key={i} card={c} small highlight={winCards?.has(c.r+c.s)}/>):
         <><div style={{width:30,height:42,borderRadius:6,border:"1px solid rgba(255,255,255,0.08)"}}/><div style={{width:30,height:42,borderRadius:6,border:"1px solid rgba(255,255,255,0.08)"}}/></>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 8px",borderRadius:8,minWidth:88,background:seat.isTurn?"#1e1b4b":isWinner?"#052e16":isMe?"#1e293b":"#0f172a",border:`2px solid ${seat.isTurn?"#818cf8":isWinner?"#34d399":isMe?"#475569":"rgba(255,255,255,0.06)"}`,boxShadow:seat.isTurn?"0 0 14px rgba(129,140,248,0.5)":isWinner?"0 0 14px rgba(52,211,153,0.5)":"none"}}>
        <div style={{width:24,height:24,borderRadius:"50%",background:isMe?"#3730a3":"#334155",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0,position:"relative"}}>
          {(seat.name||"?")[0].toUpperCase()}
          {seat.isButton&&<span style={{position:"absolute",bottom:-3,right:-3,width:13,height:13,borderRadius:"50%",background:"#facc15",color:"#713f12",fontSize:7,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center"}}>D</span>}
        </div>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:3}}>
            <span style={{fontSize:10,fontWeight:600,color:isMe?"#a5b4fc":"#e2e8f0",maxWidth:60,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{seat.name}</span>
            {seat.isBot&&<span style={{fontSize:8,color:"#64748b"}}>BOT</span>}
          </div>
          <div style={{fontSize:9,color:"#fde68a",fontFamily:"monospace"}}>{sol(seat.chips)}</div>
        </div>
      </div>
      {seat.allIn&&<span style={{fontSize:8,padding:"1px 5px",background:"rgba(249,115,22,0.2)",color:"#fb923c",borderRadius:3,fontWeight:700}}>ALL-IN</span>}
    </div>
  );
}

function EmptySeat({ pos, canSit, onClick }: {pos:{left:string;top:string};canSit:boolean;onClick?:()=>void}) {
  return (
    <div style={{position:"absolute",left:pos.left,top:pos.top,transform:"translate(-50%,-50%)",zIndex:5}}>
      {canSit
        ? <button onClick={onClick} style={{width:48,height:48,borderRadius:"50%",background:"transparent",border:"2px dashed rgba(99,102,241,0.35)",color:"rgba(129,140,248,0.6)",fontSize:10,fontWeight:700,cursor:"pointer"}}>SIT</button>
        : <div style={{width:34,height:34,borderRadius:"50%",border:"1px solid rgba(255,255,255,0.05)"}}/>}
    </div>
  );
}

// ── WS Hook ───────────────────────────────────────────────────────────────────
function useWS(url: string) {
  const ws = useRef<WebSocket|null>(null);
  const [connected, setConnected] = useState(false);
  const [lobby, setLobby] = useState<LobbyTable[]>([]);
  const [table, setTable] = useState<TableState|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [roomId, setRoomId] = useState<string|null>(null);
  const tableRef = useRef<TableState|null>(null);

  const send = useCallback((msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    let dead = false;
    function connect() {
      if (dead) return;
      const s = new WebSocket(url);
      ws.current = s;
      s.onopen = () => { setConnected(true); setError(null); s.send(JSON.stringify({type:"lobby"})); };
      s.onmessage = e => {
        try {
          const m = JSON.parse(e.data);
          if (m.type==="lobby") setLobby(m.tables);
          else if (m.type==="state"||m.type==="joined") { tableRef.current=m.table; setTable({...m.table}); }
          else if (m.type==="room_created") { setRoomId(m.roomId); tableRef.current=m.table; setTable({...m.table}); }
          else if (m.type==="cashout") { setTable(null); tableRef.current=null; }
          else if (m.type==="error") setError(m.message);
          else if (m.type==="kicked") { setTable(null); tableRef.current=null; setError(m.reason==="chips"?"You busted out!":"Kicked for inactivity."); }
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

// ── Main Table View ───────────────────────────────────────────────────────────
function TableView({ table, onAct, onChat, onReact, onLeave, onSitDown }: {
  table: TableState;
  onAct: (a: any) => void;
  onChat: (t: string) => void;
  onReact: (e: string) => void;
  onLeave: () => void;
  onSitDown?: () => void;
}) {
  const [chatText, setChatText] = useState("");
  const [raiseAmt, setRaiseAmt] = useState(0);
  const [timeLeft, setTimeLeft] = useState(20);
  const chatRef = useRef<HTMLDivElement>(null);
  const prevTable = useRef<TableState|null>(null);
  const beeped = useRef<Set<number>>(new Set());


  const myIndex = table.you?.seat ?? 0;
  const you = table.you;
  const bb = table.bb;

  const winCards = useMemo(() => {
    const wc = table.lastResult?.winCards;
    return wc?.length ? new Set(wc) : null;
  }, [table.lastResult]);

  // Turn timer
  useEffect(() => {
    if (!you?.myTurn) { setTimeLeft(20); return; }
    setRaiseAmt(Math.min(you.minRaiseTo, you.maxRaiseTo));
    const start = Date.now();
    const iv = setInterval(() => {
      const t = Math.max(0, 30 - Math.floor((Date.now()-start)/1000));
      setTimeLeft(t);
    }, 250);
    return () => clearInterval(iv);
  }, [you?.myTurn, you?.seat]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [table.chat?.length]);

  // Sound effects based on state changes
  useEffect(() => {
    const prev = prevTable.current;
    prevTable.current = table;
    if (!prev) return;

    // Cards dealt — new hand started
    const prevBoard = prev.board?.length || 0;
    const curBoard = table.board?.length || 0;
    const prevHandActive = prev.handActive;
    const curHandActive = table.handActive;

    // New hand starting — shuffle then deal
    if (!prevHandActive && curHandActive) {
      Sounds.shuffle();
      // Deal hole cards with staggered sounds
      const myCards = table.you?.seat !== undefined ? table.seats[table.you.seat]?.cards : null;
      if (Array.isArray(myCards)) {
        Sounds.deal(0);
        Sounds.deal(1);
      }
    }

    // Community cards dealt
    if (curBoard > prevBoard) {
      for (let i = prevBoard; i < curBoard; i++) Sounds.deal(i - prevBoard);
    }

    // Action log changes — detect last action
    const prevActions = prev.actionLog?.length || 0;
    const curActions = table.actionLog?.length || 0;
    if (curActions > prevActions) {
      const last = table.actionLog[curActions - 1];
      const label = last?.label?.toUpperCase();
      if (label === "FOLD") Sounds.fold();
      else if (label === "CHECK") Sounds.check();
      else if (label === "CALL" || label === "RAISE" || label === "BET" || label === "ALL-IN") Sounds.chips();
    }

    // Your turn
    if (table.you?.myTurn && !prev.you?.myTurn) {
      Sounds.yourTurn();
      beeped.current = new Set();
    }

    // Win
    if (table.lastResult && !prev.lastResult) {
      const isWinner = table.lastResult.winners.some(w => w.seat === table.you?.seat);
      if (isWinner) Sounds.win();
    }
  }, [table]);

  function seatPos(idx: number) {
    const n = table.maxSeats;
    const rotated = (idx - myIndex + n) % n;
    const angle = (270 + (360/n) * rotated) * Math.PI / 180;
    return { left:`${50 + 44*Math.cos(angle)}%`, top:`${52 + 40*Math.sin(angle)}%` };
  }

  const pot = table.pot;
  const canRaise = you ? you.maxRaiseTo > table.currentBet : false;
  const rMin = you ? Math.min(you.minRaiseTo, you.maxRaiseTo) : 0;
  const rMax = you ? you.maxRaiseTo : 0;
  const presets = [
    {l:"Min", v:rMin},
    {l:"½P",  v:Math.max(rMin,Math.min(rMax, table.currentBet+Math.floor(pot*0.5)))},
    {l:"¾P",  v:Math.max(rMin,Math.min(rMax, table.currentBet+Math.floor(pot*0.75)))},
    {l:"Pot", v:Math.max(rMin,Math.min(rMax, table.currentBet+pot))},
    {l:"All", v:rMax},
  ];

  const s = { // shared styles
    panel: { background:"rgba(15,23,42,0.95)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12 } as React.CSSProperties,
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10,padding:"8px 10px",maxWidth:1200,margin:"0 auto"}}>
      {/* LEFT COLUMN */}
      <div style={{flex:1,display:"flex",flexDirection:"column",gap:8,minWidth:0}}>

        {/* Table bar */}
        <div style={{...s.panel,padding:"6px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontWeight:700,color:"#e2e8f0",fontSize:14}}>{table.name}</span>
            <span style={{fontSize:11,color:"#64748b",fontFamily:"monospace"}}>{sol(table.sb)}/{sol(table.bb)} SOL</span>
            {!you && <span style={{fontSize:11,color:"#64748b",fontStyle:"italic"}}>SPECTATING</span>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:11,color:"#64748b"}}>{table.seated}/{table.maxSeats}</span>
            {table.handActive && <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:6,height:6,borderRadius:"50%",background:"#ef4444"}}/><span style={{fontSize:10,color:"#ef4444",fontWeight:600}}>LIVE</span></div>}
            <button onClick={onLeave} style={{padding:"4px 12px",background:"rgba(127,29,29,0.5)",border:"1px solid #7f1d1d",borderRadius:7,color:"#fca5a5",fontSize:11,fontWeight:700,cursor:"pointer"}}>LEAVE</button>
          </div>
        </div>

        {/* FELT */}
        <div style={{position:"relative",width:"100%",paddingBottom:"55%",borderRadius:"40%",border:"12px solid rgba(120,53,15,0.55)",boxShadow:"0 0 50px rgba(0,0,0,0.8),inset 0 0 50px rgba(0,0,0,0.4)",background:"radial-gradient(ellipse at 50% 40%,#166534,#14532d,#052e16)",overflow:"hidden"}}>
          {/* center content */}
          <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6,zIndex:2,pointerEvents:"none"}}>
            {table.handActive && table.street && <div style={{padding:"2px 10px",background:"rgba(0,0,0,0.35)",borderRadius:20,color:"rgba(134,239,172,0.65)",fontSize:10,fontFamily:"monospace",letterSpacing:3}}>{table.street.toUpperCase()}</div>}
            {/* community cards */}
            <div style={{display:"flex",gap:6}}>
              {(table.board||[]).map((c,i)=><PlayingCard key={i} card={c} highlight={winCards?.has(c.r+c.s)}/>)}
              {Array.from({length:5-(table.board?.length||0)}).map((_,i)=><div key={i} style={{width:46,height:64,borderRadius:6,border:"1px solid rgba(255,255,255,0.07)",background:"rgba(0,0,0,0.15)"}}/>)}
            </div>
            {/* pot */}
            {pot > 0 && (
              <div style={{display:"flex",gap:6}}>
                {(table.pots?.length?table.pots:[{amount:pot,label:"POT"}]).map((p,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"3px 12px",background:"rgba(0,0,0,0.4)",borderRadius:20}}>
                    <div style={{width:14,height:14,borderRadius:"50%",background:"linear-gradient(#facc15,#ca8a04)"}}/>
                    <span style={{fontSize:9,color:"rgba(134,239,172,0.5)",fontFamily:"monospace"}}>{p.label}</span>
                    <span style={{fontSize:12,color:"#fde68a",fontWeight:700,fontFamily:"monospace"}}>{sol(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            {!table.handActive && <div style={{color:"rgba(134,239,172,0.12)",fontSize:14,fontWeight:900,letterSpacing:4}}>{table.seated>=2?"NEXT HAND SOON":"WAITING FOR PLAYERS"}</div>}
          </div>
          {/* seats */}
          <div style={{position:"absolute",inset:0,zIndex:10}}>
            {table.seats.map((seat,i)=>{
              const pos=seatPos(i);
              if(!seat) return <EmptySeat key={i} pos={pos} canSit={!you&&!!onSitDown} onClick={onSitDown}/>;
              return <SeatPod key={i} seat={seat} isMe={i===myIndex} isWinner={!!(table.lastResult?.winners.some(w=>w.seat===i))} winCards={winCards??undefined} bb={bb} pos={pos}/>;
            })}
          </div>
          {/* result banner */}
          {table.lastResult && (
            <div style={{position:"absolute",bottom:-52,left:"50%",transform:"translateX(-50%)",zIndex:30,whiteSpace:"nowrap",pointerEvents:"none"}}>
              <div style={{padding:"5px 16px",background:"rgba(15,23,42,0.97)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,fontSize:12,boxShadow:"0 4px 20px rgba(0,0,0,0.6)"}}>
                <span style={{fontSize:9,color:"#64748b",marginRight:8}}>{table.lastResult.reveal?"SHOWDOWN":"WINNER"}</span>
                {table.lastResult.winners.map((w,i)=>(
                  <span key={i} style={{color:"#fde68a",fontWeight:600}}>
                    {w.name} +{sol(w.amount)}
                    {w.hand&&w.hand!=="win"&&w.hand!=="(everyone folded)"&&<span style={{color:"#94a3b8",marginLeft:4}}>· {w.hand}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ACTION PANEL — completely separate from felt, no z-index issues */}
        <div style={{...s.panel,padding:"12px 16px",border:`1px solid ${you?.myTurn?"rgba(99,102,241,0.5)":"rgba(255,255,255,0.07)"}`}}>
          {you?.myTurn ? (
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {/* YOUR TURN header + timer */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingBottom:8,borderBottom:"1px solid rgba(99,102,241,0.15)"}}>
                <span style={{color:"#a5b4fc",fontSize:12,fontWeight:700,letterSpacing:2}}>▸ YOUR TURN</span>
                <span style={{fontSize:13,fontFamily:"monospace",fontWeight:700,color:timeLeft<=5?"#ef4444":timeLeft<=10?"#f59e0b":"#64748b"}}>{timeLeft}s</span>
              </div>
              {/* timer bar */}
              <div style={{height:4,background:"rgba(255,255,255,0.07)",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${(timeLeft/20)*100}%`,background:timeLeft>8?"#6366f1":timeLeft>3?"#f59e0b":"#ef4444",borderRadius:2,transition:"width 0.25s linear"}}/>
              </div>
              {/* main buttons */}
              <div style={{display:"flex",gap:10}}>
                <button
                  onClick={() => onAct({type:"fold"})}
                  style={{flex:1,padding:"16px 0",background:"rgba(180,29,29,0.65)",border:"2px solid #dc2626",borderRadius:12,color:"#fecaca",fontWeight:800,fontSize:16,cursor:"pointer"}}>
                  FOLD
                </button>
                {you.canCheck ? (
                  <button
                    onClick={() => onAct({type:"check"})}
                    style={{flex:1,padding:"16px 0",background:"rgba(51,65,85,0.8)",border:"2px solid #475569",borderRadius:12,color:"#e2e8f0",fontWeight:800,fontSize:16,cursor:"pointer"}}>
                    CHECK
                  </button>
                ) : (
                  <button
                    onClick={() => onAct({type:"call"})}
                    style={{flex:1,padding:"16px 0",background:"rgba(67,56,202,0.65)",border:"2px solid #6366f1",borderRadius:12,color:"#e0e7ff",fontWeight:800,fontSize:16,cursor:"pointer"}}>
                    CALL {sol(you.toCall)}
                  </button>
                )}
              </div>
              {/* raise */}
              {canRaise && (
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{display:"flex",gap:4}}>
                    {presets.map(p=>(
                      <button key={p.l} onClick={()=>setRaiseAmt(p.v)}
                        style={{flex:1,padding:"4px 0",borderRadius:6,fontSize:10,fontWeight:600,cursor:"pointer",border:raiseAmt===p.v?"1px solid #7c3aed":"1px solid rgba(255,255,255,0.09)",background:raiseAmt===p.v?"rgba(124,58,237,0.35)":"rgba(255,255,255,0.03)",color:raiseAmt===p.v?"#c4b5fd":"#94a3b8"}}>
                        {p.l}
                      </button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input type="range" min={rMin} max={rMax} step={Math.max(1,Math.floor(bb/2))} value={raiseAmt} onChange={e=>setRaiseAmt(+e.target.value)} style={{flex:1,accentColor:"#7c3aed"}}/>
                    <button
                      onClick={() => onAct({type:raiseAmt>=rMax?"decent":"raise",amount:raiseAmt})}
                      style={{padding:"10px 18px",background:"rgba(124,58,237,0.65)",border:"2px solid #8b5cf6",borderRadius:10,color:"#ede9fe",fontWeight:800,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>
                      {raiseAmt>=rMax?"ALL-IN":"RAISE"} {sol(raiseAmt)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : you && !you.inHand ? (
            <div style={{textAlign:"center",padding:"8px 0"}}>
              <div style={{color:"#94a3b8",fontSize:13}}>⏳ Sitting out — dealt in next hand</div>
            </div>
          ) : you?.inHand ? (
            <div style={{textAlign:"center",color:"#64748b",fontSize:13}}>{table.handActive?"Waiting for your turn…":"Next hand coming up…"}</div>
          ) : (
            <div style={{textAlign:"center"}}>{onSitDown&&<button onClick={onSitDown} style={{padding:"10px 24px",background:"#4338ca",color:"#fff",border:"none",borderRadius:9,fontSize:14,fontWeight:700,cursor:"pointer"}}>SIT DOWN</button>}</div>
          )}
        </div>

        {/* Action log */}
        {(table.actionLog?.length||0) > 0 && (
          <div style={{...s.panel,padding:"6px 12px"}}>
            <div style={{fontSize:9,color:"#334155",fontFamily:"monospace",letterSpacing:2,marginBottom:4}}>LOG</div>
            <div style={{display:"flex",flexDirection:"column",gap:1,maxHeight:56,overflowY:"auto"}}>
              {[...table.actionLog].reverse().map((e,i)=>(
                <div key={i} style={{display:"flex",gap:8,fontSize:10}}>
                  <span style={{color:"#475569",minWidth:70,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.name}</span>
                  <span style={{color:e.label==="FOLD"?"#ef4444":e.label==="CHECK"?"#64748b":e.label==="ALL-IN"?"#f97316":"#818cf8",fontWeight:600}}>{e.label}{e.amount?` ${sol(e.amount)}`:""}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* RIGHT SIDEBAR */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {/* chat */}
        <div style={{...s.panel,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"6px 10px",borderBottom:"1px solid rgba(255,255,255,0.05)",fontSize:9,color:"#334155",fontFamily:"monospace",letterSpacing:2}}>CHAT</div>
          <div ref={chatRef} style={{height:120,overflowY:"auto",padding:"6px 10px",display:"flex",flexDirection:"column",gap:4}}>
            {!table.chat?.length
              ? <div style={{color:"#1e293b",fontSize:11,textAlign:"center",marginTop:12}}>No messages</div>
              : table.chat.map(m=>(
                <div key={m.id} style={{display:"flex",flexDirection:"column",alignItems:m.seat===you?.seat?"flex-end":"flex-start"}}>
                  <span style={{fontSize:9,color:"#475569",marginBottom:1}}>{m.name}</span>
                  <div style={{padding:"3px 8px",borderRadius:7,fontSize:11,maxWidth:"92%",background:m.seat===you?.seat?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.8)",color:m.seat===you?.seat?"#c7d2fe":"#cbd5e1"}}>{m.text}</div>
                </div>
              ))}
          </div>
          <div style={{display:"flex",gap:5,padding:"6px 10px",borderTop:"1px solid rgba(255,255,255,0.05)"}}>
            <input value={chatText} onChange={e=>setChatText(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&chatText.trim()&&you){onChat(chatText.trim());setChatText("");}}}
              placeholder={you?"Message…":"Sit to chat"} disabled={!you} maxLength={140}
              style={{flex:1,background:"rgba(30,41,59,0.6)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:7,padding:"4px 8px",fontSize:11,color:"#e2e8f0",outline:"none"}}/>
            <button onClick={()=>{if(chatText.trim()&&you){onChat(chatText.trim());setChatText("");}}} disabled={!you||!chatText.trim()}
              style={{padding:"3px 8px",background:"#4338ca",border:"none",borderRadius:7,color:"#c7d2fe",cursor:"pointer",fontSize:11,opacity:!you||!chatText.trim()?0.4:1}}>→</button>
          </div>
        </div>
        {/* reactions */}
        {you && (
          <div style={{padding:"8px 10px",background:"rgba(15,23,42,0.8)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,alignSelf:"flex-start"}}>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {["😂","😤","🤔","😭","🔥","💩","👋"].map(e=>(
                <button key={e} onClick={()=>onReact(e)} style={{fontSize:18,background:"none",border:"none",cursor:"pointer",padding:2}}>{e}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Homepage ──────────────────────────────────────────────────────────────────
const CASH_TABLES = [
  {id:"table1",name:"Micro Felt",   sb:0.001, bb:0.002, min:0.1,  max:1,   color:"#22c55e"},
  {id:"table2",name:"Main Event",   sb:0.005, bb:0.010, min:0.5,  max:5,   color:"#06b6d4"},
  {id:"table3",name:"High Roller",  sb:0.010, bb:0.020, min:1,    max:10,  color:"#a855f7"},
  {id:"table4",name:"Whale Table",  sb:0.050, bb:0.100, min:5,    max:50,  color:"#f59e0b"},
  {id:"table5",name:"Nosebleed",    sb:0.100, bb:0.200, min:10,   max:100, color:"#ef4444"},
  {id:"table6",name:"Custom",       sb:0,     bb:0,     min:0,    max:0,   color:"#64748b"},
];

function HomePage({ onPractice, onRoom, onCash, lobby, connected }: {
  onPractice: () => void;
  onRoom: () => void;
  onCash: (tableId: string, buyIn: number) => void;
  lobby: LobbyTable[];
  connected: boolean;
}) {
  const [name, setName] = useState(() => typeof sessionStorage!=="undefined" ? sessionStorage.getItem("player_name")||"" : "");
  const [nameErr, setNameErr] = useState("");
  const [showRoom, setShowRoom] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [buyInTable, setBuyInTable] = useState<typeof CASH_TABLES[0]|null>(null);
  const [buyAmt, setBuyAmt] = useState("");
  const [customSb, setCustomSb] = useState("0.010");
  const [customBb, setCustomBb] = useState("0.020");

  function saveName(n: string) {
    setName(n);
    if (typeof sessionStorage!=="undefined") sessionStorage.setItem("player_name", n);
  }

  function requireName(): boolean {
    if (!name.trim()) { setNameErr("Enter your name first"); return false; }
    setNameErr(""); return true;
  }

  return (
    <div style={{maxWidth:880,margin:"0 auto",padding:"28px 16px"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <h1 style={{fontSize:38,fontWeight:900,margin:0,letterSpacing:-1,color:"#f1f5f9"}}>DECENT POKER</h1>
        <p style={{color:"#475569",margin:"6px 0 0",fontSize:14}}>Texas Hold'em · Provably fair · Play with friends</p>
      </div>

      {/* Name */}
      <div style={{maxWidth:320,margin:"0 auto 24px",textAlign:"center"}}>
        <label style={{display:"block",fontSize:11,color:"#475569",fontWeight:600,letterSpacing:1,marginBottom:5}}>YOUR NAME</label>
        <input value={name} onChange={e=>{saveName(e.target.value);setNameErr("");}} placeholder="Enter your name…" maxLength={20}
          style={{width:"100%",background:"rgba(30,41,59,0.8)",border:`1px solid ${nameErr?"#ef4444":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"11px 16px",fontSize:15,color:"#f1f5f9",outline:"none",boxSizing:"border-box",textAlign:"center"}}/>
        {nameErr && <p style={{color:"#ef4444",fontSize:12,margin:"4px 0 0"}}>{nameErr}</p>}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:14,marginBottom:24}}>
        {/* Practice */}
        <div style={{padding:22,borderRadius:16,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(99,102,241,0.2)",display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontSize:28}}>🤖</div>
          <h2 style={{margin:0,fontSize:18,fontWeight:800,color:"#f1f5f9"}}>Practice</h2>
          <p style={{margin:0,color:"#64748b",fontSize:12,lineHeight:1.5}}>Play vs bots with 1,000 free chips. No wallet needed.</p>
          <button onClick={()=>{if(!requireName())return;onPractice();}}
            style={{marginTop:"auto",padding:"11px 0",background:"#4338ca",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer"}}>
            PLAY NOW →
          </button>
        </div>

        {/* Friend Table */}
        <div style={{padding:22,borderRadius:16,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(34,197,94,0.2)",display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontSize:28}}>🃏</div>
          <h2 style={{margin:0,fontSize:18,fontWeight:800,color:"#f1f5f9"}}>Friend Table</h2>
          <p style={{margin:0,color:"#64748b",fontSize:12,lineHeight:1.5}}>Private room with a shareable link. No wallet needed.</p>
          {!showRoom ? (
            <button onClick={()=>{if(!requireName())return;setShowRoom(true);}}
              style={{marginTop:"auto",padding:"11px 0",background:"#166534",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              CREATE OR JOIN →
            </button>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:"auto"}}>
              <button onClick={()=>{if(!requireName())return;onRoom();}}
                style={{padding:"9px 0",background:"#166534",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>CREATE ROOM</button>
              <div style={{display:"flex",gap:6}}>
                <input value={roomCode} onChange={e=>setRoomCode(e.target.value.toLowerCase())} placeholder="Room code…" maxLength={6}
                  style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"7px 10px",fontSize:13,color:"#f1f5f9",outline:"none",fontFamily:"monospace",letterSpacing:2}}/>
                <button onClick={()=>{if(roomCode.trim().length===6)window.location.href=`/table/${roomCode.trim()}`;}}
                  style={{padding:"7px 12px",background:"rgba(22,101,52,0.5)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:8,color:"#86efac",fontSize:13,fontWeight:700,cursor:"pointer"}}>JOIN</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cash Games */}
      <div style={{padding:20,borderRadius:16,background:"rgba(15,23,42,0.8)",border:"1px solid rgba(245,158,11,0.2)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
          <span style={{fontSize:22}}>💎</span>
          <div>
            <h2 style={{margin:0,fontSize:18,fontWeight:800,color:"#f1f5f9"}}>Cash Games</h2>
            <p style={{margin:0,color:"#64748b",fontSize:12}}>Real SOL · Multiple stake levels</p>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:10}}>
          {CASH_TABLES.map(t => {
            const live = lobby.find(l=>l.id===t.id);
            return (
              <div key={t.id} onClick={()=>{if(!requireName())return;setBuyInTable(t);setBuyAmt(t.min.toString());}}
                style={{padding:"12px 14px",borderRadius:12,background:"rgba(10,10,15,0.6)",border:`1px solid ${t.color}30`,cursor:"pointer",transition:"border-color 0.2s"}}
                onMouseOver={e=>(e.currentTarget as any).style.borderColor=t.color+"80"}
                onMouseOut={e=>(e.currentTarget as any).style.borderColor=t.color+"30"}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontWeight:700,color:"#e2e8f0",fontSize:14}}>{t.name}</span>
                  {live?.inHand && <div style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:5,height:5,borderRadius:"50%",background:"#ef4444"}}/><span style={{fontSize:9,color:"#ef4444"}}>LIVE</span></div>}
                </div>
                <div style={{fontSize:12,color:"#64748b",fontFamily:"monospace",marginBottom:6}}>
                  {t.id==="table6" ? "Custom blinds" : `${t.sb}/${t.bb} SOL blinds`}
                </div>
                {t.id!=="table6" && <div style={{fontSize:11,color:"#334155"}}>Buy-in: {t.min}–{t.max} SOL</div>}
                {live && (
                  <div style={{display:"flex",gap:4,marginTop:6}}>
                    {Array.from({length:live.maxSeats}).map((_,i)=>(
                      <div key={i} style={{width:7,height:7,borderRadius:"50%",background:i<live.seated?"#818cf8":"#1e293b"}}/>
                    ))}
                    <span style={{fontSize:10,color:"#475569",marginLeft:2}}>{live.seated}/{live.maxSeats}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!connected && <div style={{textAlign:"center",color:"#334155",fontSize:12,marginTop:16}}>⟳ Connecting to game server…</div>}

      {/* Buy-in modal */}
      {buyInTable && (
        <div onClick={()=>setBuyInTable(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:380,background:"#0f172a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:18,padding:26,boxShadow:"0 20px 60px rgba(0,0,0,0.8)"}}>
            <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:800,color:"#f1f5f9"}}>BUY IN — {buyInTable.name}</h2>
            {buyInTable.id==="table6" ? (
              <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
                <p style={{margin:0,color:"#64748b",fontSize:13}}>Set custom blinds</p>
                <div style={{display:"flex",gap:8}}>
                  <div style={{flex:1}}>
                    <label style={{fontSize:10,color:"#64748b",display:"block",marginBottom:3}}>SMALL BLIND (SOL)</label>
                    <input type="number" value={customSb} onChange={e=>setCustomSb(e.target.value)} step="0.001" min="0.001"
                      style={{width:"100%",background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"8px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
                  </div>
                  <div style={{flex:1}}>
                    <label style={{fontSize:10,color:"#64748b",display:"block",marginBottom:3}}>BIG BLIND (SOL)</label>
                    <input type="number" value={customBb} onChange={e=>setCustomBb(e.target.value)} step="0.001" min="0.002"
                      style={{width:"100%",background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"8px 10px",fontSize:14,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
                  </div>
                </div>
                <div>
                  <label style={{fontSize:10,color:"#64748b",display:"block",marginBottom:3}}>BUY-IN (SOL)</label>
                  <input type="number" value={buyAmt} onChange={e=>setBuyAmt(e.target.value)} step="0.1" min="0.1"
                    style={{width:"100%",background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"10px 12px",fontSize:16,color:"#f1f5f9",outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}/>
                </div>
              </div>
            ) : (
              <div style={{marginBottom:16}}>
                <p style={{margin:"0 0 12px",color:"#64748b",fontSize:13}}>Blinds: {buyInTable.sb}/{buyInTable.bb} SOL · Buy-in: {buyInTable.min}–{buyInTable.max} SOL</p>
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  {[buyInTable.min, buyInTable.min*2, buyInTable.min*5, buyInTable.max].map(v=>(
                    <button key={v} onClick={()=>setBuyAmt(v.toString())}
                      style={{flex:1,padding:"5px 0",borderRadius:7,fontSize:11,fontWeight:600,cursor:"pointer",background:buyAmt===v.toString()?"rgba(67,56,202,0.4)":"rgba(30,41,59,0.6)",border:buyAmt===v.toString()?"1px solid #4338ca":"1px solid rgba(255,255,255,0.06)",color:buyAmt===v.toString()?"#a5b4fc":"#64748b"}}>
                      {v}
                    </button>
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
              <button onClick={()=>setBuyInTable(null)} style={{flex:1,padding:"10px 0",borderRadius:10,background:"transparent",border:"1px solid rgba(255,255,255,0.07)",color:"#64748b",fontWeight:700,fontSize:13,cursor:"pointer"}}>CANCEL</button>
              <button onClick={()=>{
                const amt = parseFloat(buyAmt);
                if (isNaN(amt)||amt<=0) return;
                const lamports = Math.round(amt*1e9);
                onCash(buyInTable.id, lamports);
                setBuyInTable(null);
              }} style={{flex:1,padding:"10px 0",borderRadius:10,background:"#4338ca",border:"none",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
                CONFIRM
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Share Modal ───────────────────────────────────────────────────────────────
function ShareModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const url = typeof window!=="undefined" ? `${window.location.origin}/table/${roomId}` : `/table/${roomId}`;
  const [copied, setCopied] = useState(false);
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:400,background:"#0f172a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:18,padding:28}}>
        <h2 style={{margin:"0 0 6px",fontSize:20,fontWeight:800,color:"#f1f5f9"}}>🎉 Room Created!</h2>
        <p style={{margin:"0 0 16px",color:"#64748b",fontSize:13}}>Share this link with your friends:</p>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          <input readOnly value={url} style={{flex:1,background:"rgba(30,41,59,0.8)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"9px 12px",fontSize:11,color:"#a5b4fc",fontFamily:"monospace",outline:"none"}}/>
          <button onClick={()=>{navigator.clipboard?.writeText(url);setCopied(true);setTimeout(()=>setCopied(false),2000);}}
            style={{padding:"9px 14px",background:copied?"#166534":"#4338ca",border:"none",borderRadius:9,color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>{copied?"✓":"COPY"}</button>
        </div>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{fontSize:10,color:"#475569",marginBottom:3}}>Room code</div>
          <div style={{fontSize:26,fontWeight:900,fontFamily:"monospace",letterSpacing:6,color:"#f1f5f9"}}>{roomId.toUpperCase()}</div>
        </div>
        <button onClick={onClose} style={{width:"100%",padding:"11px 0",background:"#166534",border:"none",borderRadius:11,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>START PLAYING</button>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "wss://decent-poker-production.up.railway.app";

export default function App() {
  const { connected, lobby, table, error, roomId, setRoomId, send, setTable } = useWS(WS_URL);
  const [view, setView] = useState<"home"|"table">("home");
  const [cashMsg, setCashMsg] = useState<string|null>(null);
  const [seed] = useState(genSeed);

  // Check for room join redirect
  useEffect(() => {
    if (!connected) return;
    const rid = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("join_room_id") : null;
    const rname = typeof sessionStorage!=="undefined" ? sessionStorage.getItem("join_room_name") : null;
    if (rid && rname) {
      sessionStorage.removeItem("join_room_id");
      sessionStorage.removeItem("join_room_name");
      send({ type:"join_room", roomId:rid, name:rname, playerSeed:seed });
      setView("table");
    }
  }, [connected]);

  // Go to table view when we receive a table
  useEffect(() => {
    if (table) setView("table");
  }, [!!table]);

  function handlePractice() {
    send({ type:"practice", tableId:"table1", name:getPlayerName(), playerSeed:seed });
  }

  function handleRoom() {
    send({ type:"create_room", name:getPlayerName(), playerSeed:seed, sb:10_000_000, bb:20_000_000, maxPlayers:6, roomName:`${getPlayerName()}'s Table` });
  }

  function handleCash(tableId: string, lamports: number) {
    const sig = `dev_${Date.now()}_${seed.slice(0,8)}`;
    send({ type:"join", tableId, lamports, signature:sig, name:getPlayerName(), playerSeed:seed });
  }

  function handleLeave() {
    if (table) send({ type:"cashout", tableId:table.id });
    setTable(null);
    setView("home");
    send({ type:"lobby" });
  }

  return (
    <div style={{minHeight:"100vh",background:"#0a0a0f",color:"#e2e8f0",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"}}>
      {/* Nav */}
      <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 18px",borderBottom:"1px solid rgba(255,255,255,0.05)",background:"rgba(10,10,15,0.9)",position:"sticky",top:0,zIndex:40}}>
        <button onClick={()=>{if(table)handleLeave();setView("home");}} style={{fontSize:17,fontWeight:900,background:"none",border:"none",color:"#f1f5f9",cursor:"pointer",letterSpacing:-0.5}}>DECENT POKER</button>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:connected?"#34d399":"#ef4444"}}/>
            <span style={{fontSize:11,color:"#475569"}}>{connected?"Live":"Connecting…"}</span>
          </div>
        </div>
      </header>

      <main>
        {cashMsg && <div style={{maxWidth:500,margin:"8px auto",padding:"7px 16px",background:"rgba(5,46,22,0.6)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:9,color:"#86efac",fontSize:13,textAlign:"center"}}>{cashMsg}</div>}
        {error && <div style={{maxWidth:500,margin:"8px auto",padding:"7px 16px",background:"rgba(127,29,29,0.4)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:9,color:"#fca5a5",fontSize:13,textAlign:"center"}}>{error}</div>}

        {view==="table" && table ? (
          <TableView
            table={table}
            onAct={a => send({type:"act", tableId:table.id, action:a})}
            onChat={t => send({type:"chat", tableId:table.id, text:t})}
            onReact={e => send({type:"react", tableId:table.id, emoji:e})}
            onLeave={handleLeave}
            onSitDown={() => {}}
          />
        ) : (
          <HomePage
            onPractice={handlePractice}
            onRoom={handleRoom}
            onCash={handleCash}
            lobby={lobby}
            connected={connected}
          />
        )}
      </main>

      {roomId && <ShareModal roomId={roomId} onClose={() => setRoomId(null)} />}
    </div>
  );
}
