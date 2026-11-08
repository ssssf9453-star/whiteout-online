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
const PLAT=[{id:0,x:120,y:456,w:230,h:32},{id:1,x:650,y:456,w:230,h:32}];
const rooms=new Map(),quickQueue=[],connections=new Set();
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
  return res.end(JSON.stringify({ok:true,version:'3.0-CLASSIC',rooms:rooms.size,quickWaiting:quickQueue.filter(r=>r.phase==='waiting').length}));
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
function detach(ws){if(ws.room)closeRoom(ws.room,ws);}
function human(side){
 const x=side===0?235:765,y=456,h=104,p={};
 for(const k of NODE){const [ox,oy]=POSE[k],px=x+ox*h,py=y+oy*h;p[k]={x:px,y:py,ox:px,oy:py};}
 return {side,p,h,hp:240,dead:false,down:false,stun:0,downSince:0,inv:0,shootT:0,effects:{},links:BONES.map(([a,b])=>({a,b,len:D(p[a].x-p[b].x,p[a].y-p[b].y)}))};
}
function newRoom(ws,quick){
 detach(ws);
 const r={code:code(),clients:[ws,null],phase:'waiting',quick,created:Date.now(),last:Date.now(),round:0,wins:[0,0],rematch:[false,false],countdownUntil:0,players:[human(0),human(1)],aim:[.12,.12],chargeAt:[null,null],lastShot:[0,0],loadouts:[{...ws.loadout},{skin:'whiteout',bow:'ash',arrow:'basic'}],arrows:[],events:[],eventId:1,nextArrow:1,elapsed:0,winner:null};
 rooms.set(r.code,r);ws.room=r;ws.seat=0;
 if(quick){quickQueue.push(r);send(ws,{t:'searching',message:'Searching for another player…'});}else send(ws,{t:'room_created',code:r.code,seat:1});
 return r;
}
function begin(r,ws){cleanQueue(r);r.clients[1]=ws;ws.room=r;ws.seat=1;r.loadouts[1]={...ws.loadout};startRound(r);}
function startRound(r){
 r.round++;r.phase='countdown';r.countdownUntil=Date.now()+3000;r.last=Date.now();r.elapsed=0;r.winner=null;r.players=[human(0),human(1)];r.chargeAt=[null,null];r.arrows=[];r.events=[];r.rematch=[false,false];r.lastShot=[0,0];r.aim=[.12,.12];
 r.clients.forEach((ws,i)=>send(ws,{t:'start',code:r.code,seat:i+1,round:r.round,wins:r.wins,loadouts:r.loadouts}));broadcast(r);
}
function leave(ws){detach(ws);send(ws,{t:'left'});}
function event(r,type,data){const e={id:r.eventId++,type,...data};r.events.push(e);if(r.events.length>60)r.events.splice(0,r.events.length-60);message(r,{t:'effect',...e});}
function roundEnd(r,winner){if(r.phase!=='playing')return;r.phase='finished';r.last=Date.now();r.winner=winner;r.chargeAt=[null,null];r.wins[winner-1]++;message(r,{t:'finished',winner,wins:r.wins,round:r.round});}
function hurt(r,victim,amount,source,fromStatus=false){
 const p=r.players[victim];if(p.dead||r.phase!=='playing')return;
 if(amount<=0)return;
 // A fresh projectile always applies damage. DOT damage bypasses short invulnerability.
 p.hp=Math.max(0,p.hp-amount);
 if(p.hp<=0){p.hp=0;p.dead=true;p.down=true;p.downSince=r.elapsed;impulse(p,p.p.chest.x,p.p.chest.y,source,1.7);event(r,'death',{target:victim+1,seed:Math.round(Math.random()*9999)});roundEnd(r,2-victim);}
 else if(!fromStatus){p.down=true;p.downSince=r.elapsed;p.stun=Math.max(p.stun,.24);impulse(p,p.p.chest.x,p.p.chest.y,source,.75+Math.random()*.6);}
}
function impulse(p,hx,hy,vx,mult){
 const sign=Math.sign(vx)||1,t=rand(-.35,.35);
 for(const key of NODE){const n=p.p[key],level=clamp((456-n.y)/p.h,0,1),proximity=clamp(1-D(n.x-hx,n.y-hy)/(p.h*1.4),.2,1);
  n.ox=n.x-((sign*rand(.8,2.2)*mult*(1+level*2.8)+t*level*5)*proximity);
  n.oy=n.y-((rand(-1.2,1)*mult+Math.max(0,level*.8))*proximity);
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
 const load=r.loadouts[p],bow=BOWS[load.bow]||BOWS.ash,arrow=ARROWS[load.arrow]||ARROWS.basic;
 const hold=clamp(held/1050,.18,1),speed=(875+340*hold)*bow.speed*arrow.speed;
 const face=p===0?1:-1,angle=r.aim[p],vx=face*Math.cos(angle)*speed,vy=-Math.sin(angle)*speed;
 const startPt=ch.p.chest;
 r.arrows.push({id:r.nextArrow++,owner:p,arrowType:load.arrow,bowType:load.bow,face,damageMult:bow.damage*arrow.damage,
 x:startPt.x+face*31,y:startPt.y-7,px:startPt.x+face*31,py:startPt.y-7,vx,vy,angle:Math.atan2(vy,vx),age:0,expire:20,afterBounce:false,state:'flight',host:null,at:null});
 event(r,'shot',{owner:p+1,bow:load.bow,arrow:load.arrow});
}
function ragdoll(ch,dt){
 if(!ch.down&&!ch.dead)return;
 const platform=PLAT[ch.side];
 for(const name of NODE){const n=ch.p[name],vx=(n.x-n.ox)*.99,vy=(n.y-n.oy)*.99;n.ox=n.x;n.oy=n.y;n.x+=vx;n.y+=vy+930*1.3*dt*dt;}
 for(let pass=0;pass<7;pass++){
  for(const e of ch.links){const a=ch.p[e.a],b=ch.p[e.b],dx=b.x-a.x,dy=b.y-a.y,len=D(dx,dy)||1,q=(len-e.len)/len*.49;a.x+=dx*q;a.y+=dy*q;b.x-=dx*q;b.y-=dy*q;}
  for(const name of NODE){const n=ch.p[name],radius=name==='head'?12:3;
   for(const pf of PLAT)if(n.x>pf.x-radius*.3&&n.x<pf.x+pf.w+radius*.3&&n.y>pf.y-radius&&n.y<pf.y+pf.h+7&&n.oy<=pf.y+5){n.y=pf.y-radius;n.x+=(n.ox-n.x)*.035;}
   if(!ch.dead){n.x=clamp(n.x,platform.x+5,platform.x+platform.w-5);n.y=Math.min(n.y,platform.y-radius);}
   n.x=clamp(n.x,-80,1080);n.y=Math.min(n.y,760);
  }
 }
 if(!ch.dead&&ch.down&&rNow-ch.downSince>3.65){const ease=clamp((rNow-ch.downSince-3.65)*1.7,0,1);
  const px=ch.side===0?235:765;
  for(const name of NODE){const [ox,oy]=POSE[name],n=ch.p[name];n.x+=(px+ox*ch.h-n.x)*ease*.19;n.y+=(456+oy*ch.h-n.y)*ease*.19;n.ox=n.x;n.oy=n.y;}
  if(ease>=1){ch.down=false;ch.stun=0;}
 }
}
let rNow=0;
function tick(r,dt){
 if(r.phase!=='playing'&&r.phase!=='finished')return;
 r.elapsed+=dt;rNow=r.elapsed;
 if(r.phase==='finished'){
  for(const p of r.players)ragdoll(p,dt);
  for(const a of r.arrows){if(a.state!=='body')continue;const p=r.players[a.host];if(!p||!a.at)continue;const A=p.p[a.at.a],B=p.p[a.at.b],ang=Math.atan2(B.y-A.y,B.x-A.x);a.x=A.x+(B.x-A.x)*a.at.u-Math.sin(ang)*a.at.off;a.y=A.y+(B.y-A.y)*a.at.u+Math.cos(ang)*a.at.off;a.angle=ang+a.at.rel;}
  r.arrows=r.arrows.filter(a=>a.y<=615);return;
 }
 for(let i=0;i<2;i++){
  const p=r.players[i];p.stun=Math.max(0,p.stun-dt);
  for(const [name,e] of Object.entries(p.effects)){
   if(e.left<=0){delete p.effects[name];continue;}
   e.left-=dt;e.tick-=dt;
   if(e.tick<=0&&e.damage>0){e.tick+=e.interval;hurt(r,i,e.damage,i===0?1:-1,true);
    event(r,'dot',{target:i+1,element:name,x:p.p.chest.x,y:p.p.chest.y});}
  }
  if(r.phase!=='playing')break;
  ragdoll(p,dt);
 }
 if(r.phase!=='playing')return;
 for(let j=r.arrows.length-1;j>=0;j--){
  const a=r.arrows[j];a.age+=dt;
  if(a.state==='body'){
   const p=r.players[a.host];if(!p){r.arrows.splice(j,1);continue;}
   const A=p.p[a.at.a],B=p.p[a.at.b],angle=Math.atan2(B.y-A.y,B.x-A.x);
   a.x=A.x+(B.x-A.x)*a.at.u-Math.sin(angle)*a.at.off;
   a.y=A.y+(B.y-A.y)*a.at.u+Math.cos(angle)*a.at.off;a.angle=angle+a.at.rel;
   if(a.y>615||a.x<0||a.x>1000){r.arrows.splice(j,1);continue;}
  }else if(a.state==='flight'){
   a.px=a.x;a.py=a.y;a.vy+=930*dt;a.x+=a.vx*dt;a.y+=a.vy*dt;a.angle=Math.atan2(a.vy,a.vx);
   const target=1-a.owner;
   if(!r.players[target].dead){const hit=hitBone(a,r.players[target]);if(hit){
    stickArrow(a,r.players[target],hit);
    const dmg=(hit.head?108:62)*a.damageMult*(r.players[target].effects.acid?.left>0?1.25:1);
    event(r,'hit',{target:target+1,kind:hit.head?'head':'body',x:a.x,y:a.y,hp:Math.max(0,r.players[target].hp-dmg),element:a.arrowType,arrowId:a.id});
    hurt(r,target,dmg,a.face,false);if(r.phase==='playing')statusApply(r,a.owner,target,a);
    continue;
   }}
   // platform and walls. Rebounding arrows disappear upon landing on screen floor.
   let surface=false;
   for(const pf of PLAT){if(a.px>=pf.x&&a.px<=pf.x+pf.w&&a.py<=pf.y&&a.y>=pf.y&&a.x>=pf.x&&a.x<=pf.x+pf.w){a.y=pf.y-3;surface=true;break;}}
   if(surface){a.vy=-Math.abs(a.vy)*.2;a.vx*=.54;a.afterBounce=true;a.expire=Math.min(a.expire,a.age+10);if(D(a.vx,a.vy)<90){r.arrows.splice(j,1);continue;}}
   if(a.x<15||a.x>985){a.x=clamp(a.x,15,985);a.vx=-a.vx*.3;a.afterBounce=true;a.expire=Math.min(a.expire,a.age+10);}
   if(a.y<12){a.y=12;a.vy=Math.abs(a.vy)*.3;a.afterBounce=true;a.expire=Math.min(a.expire,a.age+10);}
   if(a.y>=585){r.arrows.splice(j,1);continue;}
  }
  if(a.age>=a.expire)r.arrows.splice(j,1);
 }
 if(r.arrows.length>110)r.arrows.splice(0,r.arrows.length-110);
}
function broadcast(r){
 if(!['countdown','playing','finished'].includes(r.phase))return;
 const now=Date.now();
 const payload={t:'state',version:3,code:r.code,phase:r.phase,round:r.round,wins:r.wins,winner:r.winner,serverTime:now,countdown:r.phase==='countdown'?Math.max(0,r.countdownUntil-now):0,
 players:r.players.map((p,i)=>({hp:Math.round(p.hp*10)/10,max:240,skin:r.loadouts[i].skin,bow:r.loadouts[i].bow,arrow:r.loadouts[i].arrow,
 aim:r.aim[i],charge:r.chargeAt[i]===null?0:clamp((now-r.chargeAt[i])/1050,0,1),down:p.down,dead:p.dead,stunned:p.stun>0,fx:Object.keys(p.effects),
 nodes:NODE.map(k=>[Math.round(p.p[k].x*10)/10,Math.round(p.p[k].y*10)/10])})),
 arrows:r.arrows.map(a=>({id:a.id,x:Math.round(a.x*10)/10,y:Math.round(a.y*10)/10,angle:a.angle,owner:a.owner,bounced:a.afterBounce,type:a.arrowType,embedded:a.state==='body'})),
 rematch:r.rematch};
 message(r,payload);
}
function handle(ws,m){
 if(!m||typeof m!=='object'||typeof m.t!=='string')return;
 if(m.t==='host'){newRoom(ws,false);return;}
 if(m.t==='join'){
  const key=String(m.code||'').trim().toUpperCase();if(!/^[A-HJ-NP-Z2-9]{6}$/.test(key))return send(ws,{t:'error',message:'Enter a valid six-character code.'});
  const r=rooms.get(key);if(!r||r.phase!=='waiting'||!alive(r.clients[0]))return send(ws,{t:'error',message:'Room unavailable or full.'});
  if(r.clients[0]===ws)return send(ws,{t:'error',message:'Cannot join your own room.'});detach(ws);begin(r,ws);return;
 }
 if(m.t==='quick'){
  detach(ws);
  while(quickQueue.length){const r=quickQueue.shift();if(r.phase==='waiting'&&alive(r.clients[0])&&r.clients[0]!==ws){begin(r,ws);return;}}
  newRoom(ws,true);return;
 }
 if(m.t==='leave'){leave(ws);return;}
 if(m.t==='ping'){send(ws,{t:'pong',sent:Number.isFinite(m.sent)?m.sent:0});return;}
 if(m.t==='loadout'){
  const bow=validItem(m.bow,BOWS,ws.loadout.bow),arrow=validItem(m.arrow,ARROWS,ws.loadout.arrow);
  ws.loadout={...ws.loadout,bow,arrow,skin:validSkin(m.skin||ws.loadout.skin)};
  if(ws.room&&ws.room.phase!=='closed'){const r=ws.room;r.loadouts[ws.seat]={...ws.loadout};}
  send(ws,{t:'loadout',...ws.loadout});return;
 }
 if(m.t==='rematch'){
  const r=ws.room;if(!r||r.phase!=='finished'||r.clients[ws.seat]!==ws)return;
  r.rematch[ws.seat]=true;message(r,{t:'rematch_status',ready:r.rematch,wins:r.wins});if(r.rematch.every(Boolean))startRound(r);return;
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
  if(m?.t==='hello'){ws.loadout={skin:validSkin(m.skin),bow:validItem(m.bow,BOWS,'ash'),arrow:validItem(m.arrow,ARROWS,'basic')};send(ws,{t:'ready',version:'3.0-CLASSIC'});return;}
  handle(ws,m);
 });
 ws.on('close',()=>{connections.delete(ws);detach(ws);});ws.on('error',()=>{});
});
setInterval(()=>{
 for(const r of rooms.values()){
  if(r.phase==='countdown'&&Date.now()>=r.countdownUntil){r.phase='playing';r.last=Date.now();message(r,{t:'round_live',round:r.round});}
  if(r.phase==='waiting'&&Date.now()-r.created>15*60_000){for(const ws of r.clients){if(ws){send(ws,{t:'error',message:'Room timed out.'});ws.room=null;}}cleanQueue(r);rooms.delete(r.code);continue;}
  if(r.phase==='playing'||r.phase==='finished'&&Date.now()-r.last<3500)for(let sub=0;sub<3;sub++)tick(r,1/60);
  if(r.phase==='countdown'||r.phase==='playing'||r.phase==='finished')broadcast(r);
  if(r.phase==='finished'&&Date.now()-r.last>10*60_000)closeRoom(r,null);
 }
},50);
setInterval(()=>{for(const ws of connections){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30_000);
server.listen(PORT,'0.0.0.0',()=>console.log(`WHITEOUT ONLINE v3 Classic physics listening on ${PORT}`));
module.exports={server,rooms,PLAT,BOWS,ARROWS,NODE};
