'use strict';
// WHITEOUT ONLINE: authoritative duel server. All hits, damage, projectiles and ragdoll bones are server-owned.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const {WebSocketServer} = WebSocket;
const PORT = Number(process.env.PORT)||3000;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const rand=(a,b)=>a+Math.random()*(b-a);
const D=Math.hypot;
const BOWS={
 ash:{speed:1,damage:1,color:'#c4c8cc',curve:.15,length:.30,width:.043},
 recurve:{speed:1.18,damage:1.05,color:'#eff0f1',curve:.20,length:.33,width:.039},
 war:{speed:.94,damage:1.48,color:'#9da6b0',curve:.11,length:.36,width:.064},
 storm:{speed:1.17,damage:1.04,color:'#a9dfff',curve:.23,length:.34,width:.047},
 ember:{speed:1.02,damage:1.12,color:'#ffad62',curve:.14,length:.35,width:.052},
 venom:{speed:1.06,damage:1.10,color:'#b1f275',curve:.19,length:.33,width:.05}
};
const ARROWS={
 basic:{speed:1,damage:1,color:'#ced0d4'},piercer:{speed:.96,damage:1.42,color:'#f4f5f6'},
 lightning:{speed:1.32,damage:.94,color:'#9ee5ff'},flame:{speed:1.03,damage:.93,color:'#ffa35b'},
 acid:{speed:.97,damage:.90,color:'#abff68'},poison:{speed:1,damage:.86,color:'#bb89f3'},
 frost:{speed:1,damage:.96,color:'#8ce2ed'}
};
const NODE=['head','neck','chest','belly','hip','lS','rS','lE','rE','lH','rH','lHip','rHip','lK','rK','lF','rF'];
const BONES=[['head','neck'],['neck','chest'],['chest','belly'],['belly','hip'],['chest','lS'],['chest','rS'],['lS','lE'],['lE','lH'],['rS','rE'],['rE','rH'],['hip','lHip'],['hip','rHip'],['lHip','lK'],['lK','lF'],['rHip','rK'],['rK','rF'],['lS','rS'],['lHip','rHip'],['lS','lHip'],['rS','rHip']];
const POSE={head:[0,-.94],neck:[0,-.785],chest:[0,-.69],belly:[0,-.51],hip:[0,-.40],lS:[-.125,-.73],rS:[.125,-.73],lE:[-.23,-.59],rE:[.23,-.59],lH:[-.245,-.42],rH:[.245,-.42],lHip:[-.082,-.38],rHip:[.082,-.38],lK:[-.105,-.19],rK:[.105,-.19],lF:[-.15,0],rF:[.15,0]};
// Foot centers are six world units above the slab so rounded strokes rest on its top.
const FOOT_CLEARANCE=6;
const PLAT=[{id:0,x:120,y:456,w:230,h:32},{id:1,x:650,y:456,w:230,h:32}];
const rooms=new Map(),quickQueue=[],connections=new Set(),ratings=new Map();
const GRACE_MS=45000, INTERMISSION_MS=4600, MAX_ROOMS=350;
const DEFAULT_RATING=1000;
function rankLabel(elo){return elo>=1400?'GOLD':elo>=1150?'SILVER':'BRONZE';}
function ratingFor(ws){return ratings.get(ws.account)||{elo:DEFAULT_RATING,wins:0,losses:0,matches:0};}
function sendRating(ws){const r=ratingFor(ws);send(ws,{t:'rating',...r,division:rankLabel(r.elo),scope:'server-memory-beta'});}
function makeArena(previous){
 const variants=['LEVEL','HIGH LEFT','HIGH RIGHT','GAP','BARRIER'];
 const names=variants.filter(v=>v!==previous);
 const theme=names[crypto.randomInt(names.length)];
 let a=456,b=456;
 if(theme==='HIGH LEFT'){a=397;b=473;}else if(theme==='HIGH RIGHT'){a=477;b=397;}
 else if(theme==='GAP'){a=421;b=484;}else if(theme==='BARRIER'){a=441;b=455;}
 return {theme,platforms:[{id:0,x:120,y:a,w:230,h:32},{id:1,x:650,y:b,w:230,h:32}],barrier:theme==='BARRIER'?{x:489,y:274,w:22,h:113}:null};
}
function arenaPlatforms(room){return room.arena?.platforms||PLAT;}
function arenaParts(room){return [...arenaPlatforms(room),...(room.arena?.barrier?[room.arena.barrier]:[])];}

const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function validItem(value,list,def){return typeof value==='string'&&Object.hasOwn(list,value)?value:def;}
function validSkin(v){return typeof v==='string'&&/^[a-z0-9_-]{1,25}$/.test(v)?v:'whiteout';}
const alive=ws=>ws&&ws.readyState===WebSocket.OPEN;
function send(ws,payload){if(alive(ws)&&ws.bufferedAmount<512_000)try{ws.send(JSON.stringify(payload));}catch{}}
function message(room,payload){for(const ws of room.clients)send(ws,payload);}
const server=http.createServer((req,res)=>{
 const url=new URL(req.url||'/', 'http://localhost');
 if(req.method!=='GET'){res.writeHead(405);return res.end('Method not allowed');}
 if(url.pathname==='/health'){
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  return res.end(JSON.stringify({ok:true,version:'4.1-PLATFORM-FIX',rooms:rooms.size,quickWaiting:quickQueue.filter(r=>r.phase==='waiting').length}));
 }
 const allowed={'/':'index.html','/index.html':'index.html','/online':'online.html','/online.html':'online.html'};
 if(!allowed[url.pathname]){res.writeHead(404);return res.end('Not Found');}
 fs.readFile(path.join(__dirname,allowed[url.pathname]),(err,data)=>{
  if(err){res.writeHead(500);return res.end('File unavailable');}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(data);
 });
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:4096,perMessageDeflate:false});
function code(){for(let i=0;i<100;i++){let code='';for(let j=0;j<6;j++)code+=chars[crypto.randomInt(chars.length)];if(!rooms.has(code))return code;}throw Error('Room limit');}
function cleanQueue(room){for(let i=quickQueue.length-1;i>=0;i--)if(quickQueue[i]===room)quickQueue.splice(i,1);}
function closeRoom(room,leaver){if(!room)return;cleanQueue(room);rooms.delete(room.code);room.phase='closed';for(const ws of room.clients){if(ws?.room===room)ws.room=null;if(ws&&ws!==leaver)send(ws,{t:'opponent_left',message:'Opponent left the room.'});}}
function notifyPause(room,who){room.phaseBeforePause=room.phase;room.phase='paused';room.disconnectAt=Date.now();room.missingSeat=who;room.chargeAt=[null,null];message(room,{t:'opponent_wait',seconds:45});}
function detach(ws,grace=false){const r=ws.room;if(!r)return;ws.room=null;
 if(grace&&r.phase!=='waiting'&&r.phase!=='closed'&&r.phase!=='finished'&&r.phase!=='paused'&&r.clients[ws.seat]===ws){r.clients[ws.seat]=null;notifyPause(r,ws.seat);}
 else closeRoom(r,ws);
}
function resume(ws,m){const r=rooms.get(String(m.code||'').toUpperCase()),token=String(m.token||'');
 if(!r||r.phase!=='paused'||Date.now()-r.disconnectAt>GRACE_MS||!token)return send(ws,{t:'resume_failed'});
 const i=r.tokens.indexOf(token);if(i<0||r.clients[i])return send(ws,{t:'resume_failed'});
 detach(ws);r.clients[i]=ws;ws.room=r;ws.seat=i;ws.loadout={...r.loadouts[i]};r.phase=r.phaseBeforePause;
 if(r.phase==='countdown')r.countdownUntil=Date.now()+3000;
 if(r.phase==='round_end')r.roundEndAt+=Date.now()-r.disconnectAt;
 r.missingSeat=-1;r.disconnectAt=0;r.last=Date.now();
 r.clients.forEach((c,j)=>send(c,{t:'start',code:r.code,seat:j+1,round:r.round,wins:r.wins,loadouts:r.loadouts,token:r.tokens[j],ranked:r.quick,resumed:true}));
 message(r,{t:'opponent_back'});broadcast(r);
}

function human(side,room){
 const platform=arenaPlatforms(room)[side],x=platform.x+platform.w/2,y=platform.y-FOOT_CLEARANCE,h=104,p={};
 for(const k of NODE){const [ox,oy]=POSE[k],px=x+ox*h,py=y+oy*h;p[k]={x:px,y:py,ox:px,oy:py};}
 return {side,p,h,hp:240,dead:false,down:false,stun:0,downSince:0,hitRegion:null,inv:0,shootT:0,effects:{},links:BONES.map(([a,b])=>({a,b,len:D(p[a].x-p[b].x,p[a].y-p[b].y)}))};
}
// A living upright archer never walks, slides, hovers or sinks. The only
// movement permitted is the temporary ragdoll response after being hit.
function plantUpright(room,ch){
 if(!ch||ch.dead||ch.down)return;
 const pf=arenaPlatforms(room)[ch.side],x=pf.x+pf.w/2,feetY=pf.y-FOOT_CLEARANCE;
 for(const k of NODE){const n=ch.p[k],pose=POSE[k];n.x=n.ox=x+pose[0]*ch.h;n.y=n.oy=feetY+pose[1]*ch.h;}
}
function newRoom(ws,quick){
 detach(ws);
 if(rooms.size>=MAX_ROOMS){send(ws,{t:'error',message:'Server is full. Try again soon.'});return null;}
 const r={code:code(),clients:[ws,null],phase:'waiting',quick,created:Date.now(),last:Date.now(),round:0,wins:[0,0],rematch:[false,false],countdownUntil:0,
 arena:makeArena(),players:[],aim:[.12,.12],chargeAt:[null,null],lastShot:[0,0],
 loadouts:[{...ws.loadout},{skin:'whiteout',bow:'ash',arrow:'basic'}],arrows:[],events:[],eventId:1,nextArrow:1,elapsed:0,winner:null,
 history:[],replaySent:false,frameAcc:0,roundEndAt:0,disconnectAt:0,missingSeat:-1,tokens:[crypto.randomBytes(20).toString('hex'),crypto.randomBytes(20).toString('hex')],ratingCommitted:false};
 r.players=[human(0,r),human(1,r)];
 rooms.set(r.code,r);ws.room=r;ws.seat=0;
 if(quick){quickQueue.push(r);send(ws,{t:'searching',message:'Searching for another player…'});}else send(ws,{t:'room_created',code:r.code,seat:1});
 return r;
}
function begin(r,ws){cleanQueue(r);r.clients[1]=ws;ws.room=r;ws.seat=1;r.loadouts[1]={...ws.loadout};startRound(r);}
function startRound(r){
 r.round++;r.phase='countdown';r.countdownUntil=Date.now()+3000;r.last=Date.now();r.elapsed=0;r.winner=null;r.matchWinner=null;
 r.arena=makeArena(r.arena?.theme);r.players=[human(0,r),human(1,r)];r.chargeAt=[null,null];r.arrows=[];r.events=[];
 r.history=[];r.frameAcc=0;r.replaySent=false;r.rematch=[false,false];r.lastShot=[0,0];r.aim=[.12,.12];
 r.clients.forEach((ws,i)=>send(ws,{t:'start',code:r.code,seat:i+1,round:r.round,wins:r.wins,loadouts:r.loadouts,token:r.tokens[i],ranked:r.quick,arena:r.arena}));broadcast(r);
}
function capture(r){
 r.history.push({p:r.players.map(p=>NODE.map(k=>[Math.round(p.p[k].x),Math.round(p.p[k].y)])),
 a:r.arrows.slice(-12).map(a=>({id:a.id,x:Math.round(a.x),y:Math.round(a.y),angle:a.angle,type:a.arrowType,embedded:a.state==='body'}))});
 if(r.history.length>54)r.history.shift();
}
function publishReplay(r){if(r.replaySent||r.history.length<4)return;r.replaySent=true;
 // Samples from the last 3 seconds, at 100ms intervals; server controls the exact last-hit trajectory.
 const frames=r.history.filter((_,i)=>i%2===0).slice(-30);
 message(r,{t:'replay',round:r.round,arena:r.arena,frames});
}
function commitRanking(r,winner){if(!r.quick||r.ratingCommitted)return;r.ratingCommitted=true;
 const one=ratingFor(r.clients[0]),two=ratingFor(r.clients[1]);
 const expected=1/(1+10**((two.elo-one.elo)/400)),gain=Math.round(24*(1-expected));
 const p1={...one,elo:Math.max(100,one.elo+(winner===1?gain:gain-24)),matches:one.matches+1,wins:one.wins+(winner===1?1:0),losses:one.losses+(winner===2?1:0)};
 const p2={...two,elo:Math.max(100,two.elo+(winner===2?24-gain:-gain)),matches:two.matches+1,wins:two.wins+(winner===2?1:0),losses:two.losses+(winner===1?1:0)};
 if(r.clients[0]?.account)ratings.set(r.clients[0].account,p1);
 if(r.clients[1]?.account)ratings.set(r.clients[1].account,p2);
 r.clients.forEach(ws=>{if(ws)sendRating(ws);});
}

function leave(ws){detach(ws);send(ws,{t:'left'});}
function event(r,type,data){const e={id:r.eventId++,type,...data};r.events.push(e);if(r.events.length>60)r.events.splice(0,r.events.length-60);message(r,{t:'effect',...e});}
function roundEnd(r,winner){if(r.phase!=='playing')return;
 r.phase='round_end';r.last=Date.now();r.roundEndAt=Date.now()+INTERMISSION_MS;r.winner=winner;r.chargeAt=[null,null];r.wins[winner-1]++;
 message(r,{t:'round_result',winner,wins:r.wins,round:r.round,matchOver:r.wins[winner-1]>=3});
 if(r.wins[winner-1]>=3){r.matchWinner=winner;commitRanking(r,winner);}
}

function hurt(r,victim,amount,source,fromStatus=false,region='torso',impact=null){
 const p=r.players[victim];if(p.dead||r.phase!=='playing')return;
 if(amount<=0)return;
 // A fresh projectile always applies damage. DOT damage bypasses short invulnerability.
 p.hp=Math.max(0,p.hp-amount);
 if(p.hp<=0){p.hp=0;p.dead=true;p.down=true;p.downSince=r.elapsed;p.hitRegion=region;
  impulse(p,impact?.x??p.p.chest.x,impact?.y??p.p.chest.y,source,1.4+Math.random()*.5,region);
  event(r,'death',{target:victim+1,region,seed:Math.round(Math.random()*9999)});roundEnd(r,2-victim);}
 else if(!fromStatus){p.down=true;p.downSince=r.elapsed;p.hitRegion=region;
  p.stun=Math.max(p.stun,region==='head'?.45:region==='arm'?.13:region==='leg'?.22:.26);
  impulse(p,impact?.x??p.p.chest.x,impact?.y??p.p.chest.y,source,.65+Math.random()*.65,region);}

}
function impulse(p,hx,hy,vx,mult,region='torso'){
 const sign=Math.sign(vx)||1,t=rand(-.75,.75),floor=p.p.hip.y+p.h*.4;
 for(const key of NODE){const n=p.p[key],level=clamp((floor-n.y)/p.h,0,1),proximity=clamp(1-D(n.x-hx,n.y-hy)/(p.h*1.05),.12,1);
  const arm=/^(lS|rS|lE|rE|lH|rH)$/.test(key),leg=/^(lHip|rHip|lK|rK|lF|rF)$/.test(key);
  const regional=(region==='arm'&&arm||region==='leg'&&leg)?2.2:1;
  const ux=(sign*rand(.6,1.9)*mult*(1+level*3.8)+t*level*5)*proximity*regional;
  const uy=(rand(-1.8,.7)*mult-Math.max(0,level*.7))*proximity*regional;
  n.ox=n.x-ux;n.oy=n.y-uy;
 }
}

function closestSegment(ax,ay,bx,by,cx,cy,dx,dy){
 const ux=bx-ax,uy=by-ay,vx=dx-cx,vy=dy-cy,wx=ax-cx,wy=ay-cy;
 const A=ux*ux+uy*uy||1,B=ux*vx+uy*vy,C=vx*vx+vy*vy||1,D=ux*wx+uy*wy,E=vx*wx+vy*wy;
 let s,t,den=A*C-B*B;
 if(den<1e-7){s=0;t=clamp(E/C,0,1);}else{s=clamp((B*E-C*D)/den,0,1);t=clamp((A*E-B*D)/den,0,1);}
 s=clamp((B*t-D)/A,0,1);t=clamp((E+B*s)/C,0,1);s=clamp((B*t-D)/A,0,1);
 const x1=ax+ux*s,y1=ay+uy*s,x2=cx+vx*t,y2=cy+vy*t;
 return {distance:D2(x1,y1,x2,y2),s,t};
}
function D2(a,b,c,d){return Math.hypot(a-c,b-d);}
function hitBone(a,p){
 let best=null,limit=10;
 const head=p.p.head;
 const dx=a.x-a.px,dy=a.y-a.py;
 const t=clamp(((head.x-a.px)*dx+(head.y-a.py)*dy)/(dx*dx+dy*dy||1),0,1);
 if(D2(a.px+dx*t,a.py+dy*t,head.x,head.y)<17){best={a:'head',b:'neck',u:0,t,head:true,d:0};}
 for(const [b,c] of BONES){if(b==='head'||b==='lS'&&c==='rS'||b==='lHip'&&c==='rHip')continue;
  const q=closestSegment(a.px,a.py,a.x,a.y,p.p[b].x,p.p[b].y,p.p[c].x,p.p[c].y);
  if(q.distance>limit)continue;
  if(!best||q.s<best.t)best={a:b,b:c,u:q.t,t:q.s,head:false,d:q.distance};
 }
 if(best){best.region=best.head?'head':/(lS|rS|lE|rE|lH|rH)/.test(best.a+best.b)?'arm':/(lHip|rHip|lK|rK|lF|rF)/.test(best.a+best.b)?'leg':'torso';}
 return best;
}
function stickArrow(a,p,hit){
 const A=p.p[hit.a],B=p.p[hit.b],base=Math.atan2(B.y-A.y,B.x-A.x);
 const tipX=a.px+(a.x-a.px)*hit.t,tipY=a.py+(a.y-a.py)*hit.t;
 const x=A.x+(B.x-A.x)*hit.u,y=A.y+(B.y-A.y)*hit.u;
 const off=clamp((tipX-x)*(-Math.sin(base))+(tipY-y)*Math.cos(base),-17,17);
 a.state='body';a.host=p.side;a.at={a:hit.a,b:hit.b,u:hit.u,off,rel:a.angle-base};a.x=tipX;a.y=tipY;a.vx=a.vy=0;
}
function statusAdd(p,type,sec,damage,interval){const prev=p.effects[type];p.effects[type]={left:Math.max(sec,prev?.left||0),damage:Math.max(damage,prev?.damage||0),interval,tick:prev?.tick??interval};}
function statusApply(r,source,target,a){
 const p=r.players[target],type=a.arrowType,bow=a.bowType,e=p.effects;
 let combo=null;
 if((type==='flame'||bow==='ember')&&e.poison?.left>0||(type==='poison'||bow==='venom')&&e.flame?.left>0)combo='TOXIC BURST';
 else if((type==='lightning'||bow==='storm')&&e.acid?.left>0||type==='acid'&&e.shock?.left>0)combo='CHAIN SPARK';
 else if((type==='flame'||bow==='ember')&&e.frost?.left>0||type==='frost'&&e.flame?.left>0)combo='STEAM BLAST';
 if(combo){const bonus=combo==='TOXIC BURST'?30:combo==='CHAIN SPARK'?28:25;delete e.flame;delete e.poison;delete e.acid;delete e.shock;delete e.frost;
   event(r,'combo',{x:a.x,y:a.y,combo,owner:source+1});hurt(r,target,bonus,a.face,true);}
 if(p.dead)return;
 if(type==='flame'||bow==='ember')statusAdd(p,'flame',bow==='ember'?5.7:4,4.3,.65);
 if(type==='poison'||bow==='venom')statusAdd(p,'poison',bow==='venom'?9.3:7.2,3.6,.73);
 if(type==='acid')statusAdd(p,'acid',4.5,3.4,.65);
 if(type==='lightning'||bow==='storm'){statusAdd(p,'shock',1.25,0,1);p.stun=Math.max(p.stun,1.25);}
 if(type==='frost'){statusAdd(p,'frost',3,0,1);p.stun=Math.max(p.stun,1.8);}
}
function makeShot(r,p){
 const start=r.chargeAt[p],now=Date.now();if(start===null)return;
 r.chargeAt[p]=null;
 const held=now-start;if(held<100||now-r.lastShot[p]<360)return;
 r.lastShot[p]=now;
 const ch=r.players[p];if(ch.dead||ch.stun>.1)return;
 const load=r.loadouts[p],chosenBow=BOWS[load.bow]||BOWS.ash,chosenArrow=ARROWS[load.arrow]||ARROWS.basic;
 // Quick Match is a fair-play queue: every bow keeps its shape, but raw stat buffs are normalized.
 const bow=r.quick?{...chosenBow,speed:1,damage:1}:chosenBow;
 const arrow=r.quick?{...chosenArrow,speed:clamp(chosenArrow.speed,.97,1.08),damage:clamp(chosenArrow.damage,.85,1.1)}:chosenArrow;
 const hold=clamp(held/1050,.18,1),speed=(850+365*hold)*bow.speed*arrow.speed;
 const face=p===0?1:-1,angle=r.aim[p],vx=face*Math.cos(angle)*speed,vy=-Math.sin(angle)*speed;
 const startPt=ch.p.chest;
 r.arrows.push({id:r.nextArrow++,owner:p,arrowType:load.arrow,bowType:load.bow,face,damageMult:bow.damage*arrow.damage,
 x:startPt.x+face*31,y:startPt.y-7,px:startPt.x+face*31,py:startPt.y-7,vx,vy,angle:Math.atan2(vy,vx),age:0,expire:20,afterBounce:false,state:'flight',host:null,at:null,clashCD:0});
 event(r,'shot',{owner:p+1,bow:load.bow,arrow:load.arrow});
}
function ragdoll(room,ch,dt){
 if(!ch.down&&!ch.dead)return;
 const platform=arenaPlatforms(room)[ch.side];
 for(const name of NODE){const n=ch.p[name],vx=(n.x-n.ox)*.99,vy=(n.y-n.oy)*.99;n.ox=n.x;n.oy=n.y;n.x+=vx;n.y+=vy+930*1.3*dt*dt;}
 for(let pass=0;pass<7;pass++){
  for(const e of ch.links){const a=ch.p[e.a],b=ch.p[e.b],dx=b.x-a.x,dy=b.y-a.y,len=D(dx,dy)||1,q=(len-e.len)/len*.49;a.x+=dx*q;a.y+=dy*q;b.x-=dx*q;b.y-=dy*q;}
  for(const name of NODE){const n=ch.p[name],radius=name==='head'?12:3;
   for(const pf of arenaPlatforms(room))if(n.x>pf.x-radius*.3&&n.x<pf.x+pf.w+radius*.3&&n.y>pf.y-radius&&n.y<pf.y+pf.h+7&&n.oy<=pf.y+5){n.y=pf.y-radius;n.x+=(n.ox-n.x)*.035;}
   if(!ch.dead){n.x=clamp(n.x,platform.x+5,platform.x+platform.w-5);n.y=Math.min(n.y,platform.y-radius);}
   n.x=clamp(n.x,-80,1080);n.y=Math.min(n.y,760);
  }
 }
 if(!ch.dead&&ch.down&&room.elapsed-ch.downSince>3.0){const ease=clamp((room.elapsed-ch.downSince-3)*1.8,0,1);
  const px=platform.x+platform.w/2;
  for(const name of NODE){const [ox,oy]=POSE[name],n=ch.p[name];n.x+=(px+ox*ch.h-n.x)*ease*.19;n.y+=(platform.y+oy*ch.h-n.y)*ease*.19;n.ox=n.x;n.oy=n.y;}
  if(ease>=1){ch.down=false;ch.stun=0;plantUpright(room,ch);}
 }
}
function sweptClash(a,b){
 // Relative-motion closest approach prevents fast arrows from passing through each other.
 const x=a.px-b.px,y=a.py-b.py,vx=(a.x-a.px)-(b.x-b.px),vy=(a.y-a.py)-(b.y-b.py);
 const t=clamp(-(x*vx+y*vy)/(vx*vx+vy*vy||1),0,1);
 return {distance:Math.hypot(x+vx*t,y+vy*t),t};
}
function rebound(r,a,nx,ny,e=.36){const v=a.vx*nx+a.vy*ny;if(v<0){a.vx=(a.vx-(1+e)*v*nx)*.77;a.vy=(a.vy-(1+e)*v*ny)*.77;}
 a.afterBounce=true;a.expire=Math.min(a.expire,a.age+10);a.clashCD=.16;
}
function tick(r,dt){
 if(!['playing','round_end','finished'].includes(r.phase))return;
 r.elapsed+=dt;
 // Record snapshots for slow-motion final-arrow replay, also during the death animation.
 r.frameAcc+=dt;if(r.frameAcc>=.10){r.frameAcc-=.10;capture(r);}
 if(r.phase==='round_end'||r.phase==='finished'){
  for(const p of r.players)ragdoll(r,p,dt);
  for(const a of r.arrows){if(a.state!=='body')continue;const p=r.players[a.host];if(!p||!a.at)continue;const A=p.p[a.at.a],B=p.p[a.at.b],ang=Math.atan2(B.y-A.y,B.x-A.x);a.x=A.x+(B.x-A.x)*a.at.u-Math.sin(ang)*a.at.off;a.y=A.y+(B.y-A.y)*a.at.u+Math.cos(ang)*a.at.off;a.angle=ang+a.at.rel;}
  if(r.phase==='round_end'&&Date.now()>=r.last+750)publishReplay(r);
  return;
 }
 for(let i=0;i<2;i++){
  const p=r.players[i];plantUpright(r,p);p.stun=Math.max(0,p.stun-dt);
  for(const [name,e] of Object.entries(p.effects)){
   if(e.left<=0){delete p.effects[name];continue;}
   e.left-=dt;e.tick-=dt;
   if(e.tick<=0&&e.damage>0){e.tick+=e.interval;hurt(r,i,e.damage,i===0?1:-1,true);
    event(r,'dot',{target:i+1,element:name,x:p.p.chest.x,y:p.p.chest.y});}
  }
  if(r.phase!=='playing')break;
  ragdoll(r,p,dt);
 }
 if(r.phase!=='playing')return;
 // Integrate all flying projectiles before resolving arrow-on-arrow collisions.
 for(const a of r.arrows){a.age+=dt;
  if(a.state==='body'){
   const p=r.players[a.host];if(!p||!a.at){a.expire=0;continue;}
   const A=p.p[a.at.a],B=p.p[a.at.b],angle=Math.atan2(B.y-A.y,B.x-A.x);
   a.x=A.x+(B.x-A.x)*a.at.u-Math.sin(angle)*a.at.off;
   a.y=A.y+(B.y-A.y)*a.at.u+Math.cos(angle)*a.at.off;a.angle=angle+a.at.rel;
   if(a.y>615||a.x<0||a.x>1000)a.expire=0;
  }else if(a.state==='flight'){
   a.px=a.x;a.py=a.y;a.vy+=930*dt;a.x+=a.vx*dt;a.y+=a.vy*dt;
   a.angle=Math.atan2(a.vy,a.vx);a.clashCD=Math.max(0,a.clashCD-dt);
  }
 }
 for(let i=0;i<r.arrows.length;i++){const a=r.arrows[i];if(a.state!=='flight'||a.clashCD>0)continue;
  for(let j=i+1;j<r.arrows.length;j++){const b=r.arrows[j];if(b.state!=='flight'||b.owner===a.owner||b.clashCD>0)continue;
   const near=sweptClash(a,b);if(near.distance>17)continue;
   const x=(a.x+b.x)/2,y=(a.y+b.y)/2;
   const avx=a.vx,avy=a.vy,bvx=b.vx,bvy=b.vy;
   a.vx=bvx*.52;a.vy=bvy*.52-60;b.vx=avx*.52;b.vy=avy*.52-60;
   a.px=a.x;a.py=a.y;b.px=b.x;b.py=b.y;
   a.afterBounce=b.afterBounce=true;a.expire=Math.min(a.expire,a.age+10);b.expire=Math.min(b.expire,b.age+10);
   a.clashCD=b.clashCD=.24;
   event(r,'clash',{x,y,owner:avx>0?1:2});break;
  }
 }
 for(let j=r.arrows.length-1;j>=0;j--){const a=r.arrows[j];if(a.state!=='flight')continue;
  const target=1-a.owner;
  if(!r.players[target].dead){const hit=hitBone(a,r.players[target]);if(hit){
   stickArrow(a,r.players[target],hit);
   const dmg=(hit.head?108:62)*a.damageMult*(r.players[target].effects.acid?.left>0?1.25:1)*(r.quick?.90:1);
   event(r,'hit',{target:target+1,kind:hit.region,head:hit.head,x:a.x,y:a.y,hp:Math.max(0,r.players[target].hp-dmg),element:a.arrowType,arrowId:a.id});
   hurt(r,target,dmg,a.face,false,hit.region,{x:a.x,y:a.y});if(r.phase==='playing')statusApply(r,a.owner,target,a);
   continue;
  }}
  // Floating platforms, center barrier and room walls ricochet consistently on the server.
  let struck=false;
  for(const wall of arenaParts(r)){
   const x0=wall.x,y0=wall.y,x1=x0+wall.w,y1=y0+wall.h;
   const margin=2;
   if(a.px>=x0&&a.px<=x1&&a.py<=y0&&a.y>=y0&&a.x>=x0&&a.x<=x1){a.y=y0-margin;rebound(r,a,0,-1,.22);struck=true;break;}
   if(a.py>=y1&&a.y<=y1&&a.x>=x0&&a.x<=x1){a.y=y1+margin;rebound(r,a,0,1,.24);struck=true;break;}
   if(a.y>y0&&a.y<y1){if(a.px<x0&&a.x>=x0){a.x=x0-margin;rebound(r,a,-1,0);struck=true;break;}
    if(a.px>x1&&a.x<=x1){a.x=x1+margin;rebound(r,a,1,0);struck=true;break;}}
  }
  if(struck&&Math.hypot(a.vx,a.vy)<75){a.expire=0;continue;}
  if(a.x<15||a.x>985){a.x=clamp(a.x,15,985);rebound(r,a,a.x===15?1:-1,0);}
  if(a.y<12){a.y=12;rebound(r,a,0,1);}
  if(a.y>=585)a.expire=0;
 }
 r.arrows=r.arrows.filter(a=>a.age<a.expire);
 if(r.arrows.length>110)r.arrows.splice(0,r.arrows.length-110);
}

function broadcast(r){
 if(!['countdown','playing','round_end','finished','paused'].includes(r.phase))return;
 const now=Date.now();
 const payload={t:'state',version:4,code:r.code,phase:r.phase,round:r.round,wins:r.wins,ranked:r.quick,arena:r.arena,
 winner:r.winner,serverTime:now,countdown:r.phase==='countdown'?Math.max(0,r.countdownUntil-now):0,
 players:r.players.map((p,i)=>({hp:Math.round(p.hp*10)/10,max:240,skin:r.loadouts[i].skin,bow:r.loadouts[i].bow,arrow:r.loadouts[i].arrow,
 aim:r.aim[i],charge:r.chargeAt[i]===null?0:clamp((now-r.chargeAt[i])/1050,0,1),down:p.down,dead:p.dead,stunned:p.stun>0,hitRegion:p.hitRegion,fx:Object.keys(p.effects),
 nodes:NODE.map(k=>[Math.round(p.p[k].x*10)/10,Math.round(p.p[k].y*10)/10])})),
 arrows:r.arrows.map(a=>({id:a.id,x:Math.round(a.x*10)/10,y:Math.round(a.y*10)/10,angle:a.angle,owner:a.owner,bounced:a.afterBounce,type:a.arrowType,embedded:a.state==='body'})),
 rematch:r.rematch};
 message(r,payload);
}

function handle(ws,m){
 if(!m||typeof m!=='object'||typeof m.t!=='string')return;
 if(m.t==='resume'){resume(ws,m);return;}
 if(m.t==='host'){newRoom(ws,false);return;}
 if(m.t==='join'){
  const key=String(m.code||'').trim().toUpperCase();if(!/^[A-HJ-NP-Z2-9]{6}$/.test(key))return send(ws,{t:'error',message:'Enter a valid six-character code.'});
  const r=rooms.get(key);if(!r||r.phase!=='waiting'||!alive(r.clients[0]))return send(ws,{t:'error',message:'Room unavailable or full.'});
  if(r.clients[0]===ws)return send(ws,{t:'error',message:'Cannot join your own room.'});detach(ws);begin(r,ws);return;
 }
 if(m.t==='quick'){
  detach(ws);
  const me=ratingFor(ws),now=Date.now();let best=null,bestGap=Infinity;
  for(const r of quickQueue){if(r.phase!=='waiting'||!alive(r.clients[0])||r.clients[0]===ws)continue;
   const gap=Math.abs(me.elo-ratingFor(r.clients[0]).elo),wait=now-r.created;
   if(gap>Math.min(900,180+wait/150))continue;
   if(gap<bestGap){best=r;bestGap=gap;}}
  if(best){begin(best,ws);return;}
  newRoom(ws,true);return;
 }
 if(m.t==='leave'){leave(ws);return;}
 if(m.t==='ping'){send(ws,{t:'pong',sent:Number.isFinite(m.sent)?m.sent:0});return;}
 if(m.t==='loadout'){
  const r=ws.room;
  // Prevent mid-flight bow/skin swaps; arrow type may be changed while playing.
  const locked=r&&['playing','countdown','round_end'].includes(r.phase);
  const bow=locked?ws.loadout.bow:validItem(m.bow,BOWS,ws.loadout.bow);
  const arrow=validItem(m.arrow,ARROWS,ws.loadout.arrow);
  ws.loadout={...ws.loadout,bow,arrow,skin:locked?ws.loadout.skin:validSkin(m.skin||ws.loadout.skin)};
  if(r&&r.phase!=='closed'){r.loadouts[ws.seat]={...ws.loadout};}
  send(ws,{t:'loadout',...ws.loadout});return;
 }
 if(m.t==='rematch'){
  const r=ws.room;if(!r||r.phase!=='finished'||r.clients[ws.seat]!==ws)return;
  r.rematch[ws.seat]=true;message(r,{t:'rematch_status',ready:r.rematch,wins:r.wins});
  if(r.rematch.every(Boolean)){r.wins=[0,0];r.round=0;r.ratingCommitted=false;startRound(r);}return;
 }
 const r=ws.room;if(!r||r.phase!=='playing'||r.clients[ws.seat]!==ws)return;
 const p=ws.seat,now=Date.now();
 if(m.t==='aim'){if(Number.isFinite(m.value))r.aim[p]=clamp(m.value,-.3,1.22);return;}
 if(m.t==='charge'){if(!r.players[p].dead&&r.chargeAt[p]===null)r.chargeAt[p]=now;return;}
 if(m.t==='shoot'){makeShot(r,p);return;}
}
wss.on('connection',ws=>{
 connections.add(ws);ws.isAlive=true;ws.room=null;ws.seat=-1;ws.loadout={skin:'whiteout',bow:'ash',arrow:'basic'};
 send(ws,{t:'connected',message:'Connected to WHITEOUT Classic Physics server.'});
 ws.on('pong',()=>ws.isAlive=true);
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString());}catch{return;}
  if(m?.t==='hello'){
   const token=String(m.account||'');ws.account=/^[a-f0-9]{64}$/.test(token)&&ratings.has(token)?token:crypto.randomBytes(32).toString('hex');
   if(!ratings.has(ws.account))ratings.set(ws.account,{elo:DEFAULT_RATING,wins:0,losses:0,matches:0});
   ws.loadout={skin:validSkin(m.skin),bow:validItem(m.bow,BOWS,'ash'),arrow:validItem(m.arrow,ARROWS,'basic')};
   send(ws,{t:'ready',version:'4.1-PLATFORM-FIX',account:ws.account});sendRating(ws);return;}
  if(!ws.account)return;handle(ws,m);
 });
 ws.on('close',()=>{connections.delete(ws);detach(ws,true);});ws.on('error',()=>{});
});
setInterval(()=>{
 const now=Date.now();
 for(const r of rooms.values()){
  if(r.phase==='countdown'&&now>=r.countdownUntil){r.phase='playing';r.last=now;message(r,{t:'round_live',round:r.round});}
  if(r.phase==='waiting'&&now-r.created>15*60_000){for(const ws of r.clients){if(ws){send(ws,{t:'error',message:'Room timed out.'});ws.room=null;}}cleanQueue(r);rooms.delete(r.code);continue;}
  if(r.phase==='paused'&&now-r.disconnectAt>GRACE_MS){const winner=r.missingSeat===0?2:1;
   message(r,{t:'opponent_left',message:'Opponent did not reconnect in time.'});closeRoom(r,null);continue;}
  if(r.phase==='playing'||r.phase==='round_end'||r.phase==='finished'&&now-r.last<3800){for(let sub=0;sub<3;sub++)tick(r,1/60);}
  if(r.phase==='round_end'&&now>=r.roundEndAt){
   if(r.matchWinner){r.phase='finished';r.last=now;message(r,{t:'finished',winner:r.matchWinner,wins:r.wins,round:r.round,ranked:r.quick});}
   else startRound(r);
  }
  if(['countdown','playing','round_end','finished'].includes(r.phase))broadcast(r);
  if(r.phase==='finished'&&now-r.last>10*60_000)closeRoom(r,null);
 }
},50);

setInterval(()=>{for(const ws of connections){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30_000);
server.listen(PORT,'0.0.0.0',()=>console.log(`WHITEOUT ONLINE v4.1 PLATFORM FIX listening on ${PORT}`));
module.exports={server,rooms,PLAT,BOWS,ARROWS,NODE,makeArena,sweptClash,ratings};
