'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const PORT = Number(process.env.PORT) || 3000;
const root = __dirname;
const alive = (ws) => ws && ws.readyState === WebSocket.OPEN;
const send = (ws, value) => { if (alive(ws)) ws.send(JSON.stringify(value)); };
const rooms = new Map();
const quickQueue = [];
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const clamp = (n,min,max) => Math.min(max,Math.max(min,n));
const validSkin = (v) => typeof v === 'string' && /^[a-z0-9_-]{1,25}$/.test(v) ? v : 'whiteout';

const httpServer = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://localhost');
  if(req.method!=='GET'){res.writeHead(405);return res.end('Method not allowed');}
  if (u.pathname==='/health') {res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({ok:true,version:'2.0',waiting:quickQueue.filter(x=>x.room?.phase==='waiting').length,rooms:rooms.size}));}
  const allowed = {'/':'index.html','/index.html':'index.html','/online':'online.html','/online.html':'online.html'};
  const file = allowed[u.pathname];
  if(!file){res.writeHead(404);return res.end('Not found');}
  fs.readFile(path.join(root,file),(err,content)=>{
    if(err){res.writeHead(500);return res.end('Server error');}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(content);
  });
});
const wss = new WebSocketServer({server:httpServer, path:'/ws', maxPayload:2048, perMessageDeflate:false});
function code(){for(let n=0;n<100;n++){let s='';for(let i=0;i<6;i++)s+=chars[crypto.randomInt(chars.length)];if(!rooms.has(s))return s;}throw Error('Room capacity reached');}
function clearQueue(room){for(let i=quickQueue.length-1;i>=0;i--)if(quickQueue[i]===room)quickQueue.splice(i,1);}
function clearRoom(room,leaver){
 if(!room)return;
 clearQueue(room);rooms.delete(room.code);
 for(const ws of room.clients){if(ws && ws.room===room)ws.room=null; if(ws && ws!==leaver)send(ws,{t:'opponent_left',message:'Your opponent disconnected. Return to the online lobby to play again.'});}
 room.phase='closed';
}
function detach(ws){if(ws.room)clearRoom(ws.room,ws);}
function newRoom(ws,isQuick){
 detach(ws);
 const room={code:code(),clients:[ws,null],phase:'waiting',isQuick,created:Date.now(),last:Date.now(),hp:[160,160],aim:[.12,.12],chargeStarted:[null,null],arrows:[],nextArrow:1,winner:null,hitFlash:[0,0],skins:[ws.skin,'whiteout'],wins:[0,0],round:0,rematch:[false,false],countdownUntil:0,lastShot:[0,0]};
 rooms.set(room.code,room);ws.room=room;ws.seat=0;
 if(isQuick){quickQueue.push(room);send(ws,{t:'searching',message:'Searching for another player…'});}
 else send(ws,{t:'room_created',code:room.code,seat:1});
 return room;
}
function startRound(room){
 room.phase='countdown';room.round++;room.countdownUntil=Date.now()+3000;room.last=Date.now();
 room.hp=[160,160];room.aim=[.12,.12];room.arrows=[];room.chargeStarted=[null,null];
 room.lastShot=[0,0];room.winner=null;room.rematch=[false,false];
 room.clients.forEach((client,index)=>send(client,{t:'start',code:room.code,seat:index+1,opponentSkin:room.skins[1-index],round:room.round,wins:room.wins}));
 broadcast(room);
}
function begin(room,ws){
 clearQueue(room);room.clients[1]=ws;ws.room=room;ws.seat=1;room.skins[1]=ws.skin;
 startRound(room);
}
function leave(ws){detach(ws);send(ws,{t:'left'});}
function broadcast(room,force=false){
 if(!['playing','finished','countdown'].includes(room.phase))return;
 const now=Date.now();
 const state={t:'state',code:room.code,phase:room.phase,players:[0,1].map(i=>({hp:room.hp[i],max:160,aim:room.aim[i],charge:room.chargeStarted[i]===null?0:clamp((now-room.chargeStarted[i])/1050,0,1),skin:room.skins[i],flash:room.hitFlash[i]})),arrows:room.arrows.map(a=>({id:a.id,x:Math.round(a.x*10)/10,y:Math.round(a.y*10)/10,angle:Math.atan2(a.vy,a.vx),owner:a.owner,bounced:a.bounced})),winner:room.winner,round:room.round,wins:room.wins,rematch:room.rematch,countdown:room.phase==='countdown'?Math.max(0,room.countdownUntil-now):0,serverTime:now};
 for(const ws of room.clients)send(ws,state);
}
function segmentCircle(x1,y1,x2,y2,cx,cy,r){let dx=x2-x1,dy=y2-y1;let t=clamp(((cx-x1)*dx+(cy-y1)*dy)/(dx*dx+dy*dy||1),0,1);let ox=x1+dx*t-cx,oy=y1+dy*t-cy;return ox*ox+oy*oy<=r*r;}
function collision(a,opponent){
 const targetX=opponent===0?235:765;
 if(segmentCircle(a.oldX,a.oldY,a.x,a.y,targetX,345,16))return 'head';
 for(const [cx,cy,r] of [[targetX,384,21],[targetX,411,20],[targetX-11,442,13],[targetX+11,442,13]]){
  if(segmentCircle(a.oldX,a.oldY,a.x,a.y,cx,cy,r))return 'body';
 }
 return null;
}
function update(room,dt){
 if(room.phase!=='playing')return;
 for(let i=room.arrows.length-1;i>=0;i--){
  const a=room.arrows[i]; a.age+=dt; a.oldX=a.x;a.oldY=a.y;
  a.vy+=720*dt; a.x+=a.vx*dt;a.y+=a.vy*dt;
  const enemy=1-a.owner;
  const hit=collision(a,enemy);
  if(hit){
    room.hp[enemy]=Math.max(0,room.hp[enemy]-(hit==='head'?108:62));room.hitFlash[enemy]=Date.now()+250;
    room.arrows.splice(i,1);
    for(const ws of room.clients)send(ws,{t:'hit',target:enemy+1,kind:hit,x:a.x,y:a.y,hp:room.hp[enemy]});
    if(room.hp[enemy]===0){room.phase='finished';room.last=Date.now();room.winner=a.owner+1;room.wins[a.owner]++;room.chargeStarted=[null,null]; for(const ws of room.clients)send(ws,{t:'finished',winner:room.winner,wins:room.wins,round:room.round});}
    continue;
  }
  if(a.x<=18||a.x>=982){a.x=clamp(a.x,18,982);a.vx=-a.vx*.32;a.bounced=true;a.expire=Math.min(a.expire,a.age+10);}
  if(a.y<=10){a.y=10;a.vy=Math.abs(a.vy)*.32;a.bounced=true;a.expire=Math.min(a.expire,a.age+10);}
  // Solid arena platform: one on each side. Bounced arrows disappear upon landing.
  if(a.y>=456 || a.age>a.expire){room.arrows.splice(i,1);continue;}
 }
 if(room.arrows.length>90)room.arrows.splice(0,room.arrows.length-90);
}
function handle(ws,msg){
 if(!msg || typeof msg!=='object' || typeof msg.t!=='string')return;
 if(msg.t==='host'){newRoom(ws,false);return;}
 if(msg.t==='join'){
  const c=String(msg.code||'').trim().toUpperCase();
  if(!/^[A-HJ-NP-Z2-9]{6}$/.test(c))return send(ws,{t:'error',message:'Enter a valid six-character room code.'});
  const room=rooms.get(c);
  if(!room || room.phase!=='waiting' || !alive(room.clients[0]))return send(ws,{t:'error',message:'Room not found or already full.'});
  if(room.clients[0]===ws)return send(ws,{t:'error',message:'You already host this room.'});
  detach(ws);begin(room,ws);return;
 }
 if(msg.t==='quick'){
  detach(ws);
  while(quickQueue.length){const room=quickQueue.shift();if(room.phase==='waiting' && alive(room.clients[0]) && room.clients[0]!==ws){begin(room,ws);return;}}
  newRoom(ws,true);return;
 }
 if(msg.t==='leave'){leave(ws);return;}
 if(msg.t==='ping'){return send(ws,{t:'pong',sent:Number.isFinite(msg.sent)?msg.sent:0});}
 if(msg.t==='rematch'){
  const room=ws.room;
  if(!room||room.phase!=='finished'||room.clients[ws.seat]!==ws)return;
  room.rematch[ws.seat]=true;
  for(const client of room.clients)send(client,{t:'rematch_status',ready:room.rematch,wins:room.wins});
  if(room.rematch.every(Boolean))startRound(room);
  return;
 }
 const r=ws.room;
 if(!r || r.phase!=='playing' || r.clients[ws.seat]!==ws)return;
 const p=ws.seat, now=Date.now();
 if(msg.t==='aim' && Number.isFinite(msg.value)){
  r.aim[p]=clamp(msg.value,-.3,1.22);return;
 }
 if(msg.t==='charge'){if(r.chargeStarted[p]===null)r.chargeStarted[p]=now;return;}
 if(msg.t==='shoot'){
  if(r.chargeStarted[p]===null)return;
  const held=now-r.chargeStarted[p];r.chargeStarted[p]=null;
  if(held<100||now-r.lastShot[p]<420)return;
  r.lastShot[p]=now;
  const charge=clamp(held/1050,.18,1),speed=900+300*charge;
  const facing=p===0?1:-1,theta=r.aim[p];
  r.arrows.push({id:r.nextArrow++,owner:p,x:p===0?264:736,y:388,oldX:p===0?264:736,oldY:388,vx:facing*Math.cos(theta)*speed,vy:-Math.sin(theta)*speed,age:0,expire:20,bounced:false});
  return;
 }
}
const connections = new Set();
wss.on('connection',(ws)=>{
 connections.add(ws);ws.isAlive=true;ws.room=null;ws.seat=-1;ws.skin='whiteout';
 send(ws,{t:'connected',message:'Connected to WHITEOUT server.'});
 ws.on('pong',()=>{ws.isAlive=true;});
 ws.on('message',(raw)=>{
  let msg;try{msg=JSON.parse(raw.toString());}catch{return;}
  if(msg?.t==='hello'){ws.skin=validSkin(msg.skin);send(ws,{t:'ready',version:'2.0'});return;}
  handle(ws,msg);
 });
 ws.on('close',()=>{connections.delete(ws);detach(ws);});
 ws.on('error',()=>{});
});
setInterval(()=>{
 for(const room of rooms.values()){
  if(room.phase==='countdown' && Date.now()>=room.countdownUntil){room.phase='playing';room.last=Date.now();for(const client of room.clients)send(client,{t:'round_live',round:room.round});}
  if(room.phase==='waiting' && Date.now()-room.created>15*60*1000){for(const ws of room.clients)if(ws){send(ws,{t:'error',message:'Room timed out. Create another room.'});ws.room=null;}clearQueue(room);rooms.delete(room.code);continue;}
  if(room.phase==='playing')update(room,.05);
  if(room.phase==='playing'||room.phase==='finished'||room.phase==='countdown')broadcast(room);
  if(room.phase==='finished' && Date.now()-room.last>10*60*1000)clearRoom(room,null);
 }
},50);
setInterval(()=>{for(const ws of connections){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30_000);
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`WHITEOUT ONLINE listening on ${PORT}`));
module.exports={httpServer,rooms};
