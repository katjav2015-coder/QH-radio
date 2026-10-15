const express=require('express'),http=require('http'),crypto=require('crypto');
const {Server}=require('socket.io');const app=express(),server=http.createServer(app),io=new Server(server);app.use(express.json({limit:'8kb'}));app.use(express.static('public'));
const users=new Map(),strikes=new Map(),muted=new Map(),lastMessages=new Map();
const secret=process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex');
const djUsers=(()=>{try{return JSON.parse(process.env.DJ_USERS||'{}')}catch{return {}}})();
const safe=s=>String(s||'').trim().slice(0,200).replace(/[<>]/g,'');
const sign=(name,expiry)=>crypto.createHmac('sha256',secret).update(name+'|'+expiry).digest('hex');
function authenticate(token){if(typeof token!=='string')return null;const p=token.split('|');if(p.length!==3)return null;const [name,exp,sig]=p;if(!djUsers[name]||!/^\d+$/.test(exp)||Number(exp)<Date.now())return null;const expected=sign(name,exp);if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;return name}
const loginAttempts=new Map();app.post('/api/dj/login',(req,res)=>{const ip=req.ip,now=Date.now(),a=loginAttempts.get(ip)||{n:0,until:0};if(a.until>now)return res.status(429).json({error:'Probeer later opnieuw.'});const name=String(req.body?.name||''),password=String(req.body?.password||'');const valid=Object.hasOwn(djUsers,name)&&typeof djUsers[name]==='string'&&djUsers[name].length>0&&password===djUsers[name];if(!valid){a.n++;if(a.n>=6){a.until=now+15*60*1000;a.n=0}loginAttempts.set(ip,a);return res.status(401).json({error:'Naam of wachtwoord klopt niet.'})}loginAttempts.delete(ip);const exp=String(now+8*3600000);res.json({token:name+'|'+exp+'|'+sign(name,exp),name})});
let status={live:false,dj:'',program:'',track:'',stream:process.env.RADIO_STREAM_URL||''};
const bad=/\b(kankerhoer|kutwijf|rotwijf|fuck you|kill yourself|nigger|faggot)\b/i,threats=/\b(ik maak je dood|ik ga je vermoorden|ik sla je kapot)\b/i;
function bot(t){io.emit('message',{name:'RadioBot 🤖',text:t,bot:true,time:Date.now()})}let lastBot=0;
io.on('connection',s=>{s.emit('radioStatus',status);s.emit('count',users.size);
 s.on('djAuth',token=>{const name=authenticate(token);if(!name)return s.emit('djError','Log opnieuw in.');s.data.dj=name;s.join('djs');s.emit('djReady',{name,status,users:[...users].map(([id,n])=>({id,name:n}))})});
 s.on('djStatus',data=>{if(!s.data.dj)return;status={...status,live:!!data?.live,dj:s.data.dj,program:safe(data?.program).slice(0,80),track:safe(data?.track).slice(0,100)};io.emit('radioStatus',status);bot(status.live?`🔴 ${status.dj} presenteert nu: ${status.program||'QH Radio'}!`:'Het programma is afgelopen. Bedankt voor het luisteren! 🌈')});
 s.on('djModerate',data=>{if(!s.data.dj)return;const id=String(data?.id||''),action=data?.action;if(!users.has(id)||!['mute','kick'].includes(action))return;if(action==='mute'){muted.set(id,Date.now()+10*60000);io.to(id).emit('notice','Je hebt 10 minuten chatpauze gekregen van een beheerder.')}else{io.to(id).emit('notice','Je bent door een beheerder uit de chat verwijderd.');io.sockets.sockets.get(id)?.disconnect(true)}s.emit('notice','Moderatie uitgevoerd.')});
 s.on('join',raw=>{const name=safe(raw).slice(0,22);if(!name||/radiobot|admin|beheerder/i.test(name))return s.emit('notice','Kies een andere nickname.');users.set(s.id,name);s.emit('joined',name);io.emit('count',users.size);io.to('djs').emit('djUsers',[...users].map(([id,n])=>({id,name:n})));bot(`Welkom bij QH Radio, ${name}! 🌈`)});
 s.on('message',raw=>{const name=users.get(s.id);if(!name)return;const msg=safe(raw).slice(0,350);if(!msg)return;const now=Date.now();if((muted.get(s.id)||0)>now)return s.emit('notice','Je chatpauze is nog actief.');if(now-(lastMessages.get(s.id)||0)<1500)return s.emit('notice','Wacht even voor je opnieuw iets stuurt.');lastMessages.set(s.id,now);if(bad.test(msg)||threats.test(msg)){const n=(strikes.get(s.id)||0)+1;strikes.set(s.id,n);s.emit('notice',`Waarschuwing ${n}: kwetsende taal is niet toegestaan. Bericht geblokkeerd.`);io.to('djs').emit('djAlert',{name,text:msg,count:n});if(n>=3){muted.set(s.id,now+600000);s.emit('notice','Je hebt 10 minuten chatpauze.')}return}io.emit('message',{name,text:msg,time:now});if(now-lastBot>45000&&/\b(hallo|hey|hoi|muziek|radio|gezellig)\b/i.test(msg)){lastBot=now;setTimeout(()=>bot('Leuk dat jullie er zijn! 🎶 Wat luisteren jullie graag?'),1200)}});
 s.on('disconnect',()=>{users.delete(s.id);strikes.delete(s.id);muted.delete(s.id);lastMessages.delete(s.id);io.emit('count',users.size);io.to('djs').emit('djUsers',[...users].map(([id,n])=>({id,name:n})))});
});
// Experimentele browser-audiostream: WebRTC-signalisatie, geen audio op de server.
let activeDjSocket = null;
io.on('connection', socket => {
  socket.emit('audioAvailability', Boolean(activeDjSocket));
  socket.on('audioStart', () => {
    if (!socket.data.dj) return socket.emit('audioError', 'Log eerst in als DJ.');
    if (activeDjSocket && activeDjSocket !== socket.id && io.sockets.sockets.has(activeDjSocket))
      return socket.emit('audioError', 'Er zendt al een andere DJ uit.');
    activeDjSocket = socket.id;
    socket.emit('audioStarted');
    io.emit('audioAvailability', true);
  });
  socket.on('audioStop', () => {
    if (activeDjSocket !== socket.id) return;
    activeDjSocket = null;
    io.emit('audioAvailability', false);
    io.emit('audioEnded');
  });
  socket.on('audioListen', () => {
    if (!activeDjSocket || !io.sockets.sockets.has(activeDjSocket))
      return socket.emit('audioError', 'Er is momenteel geen DJ-uitzending.');
    io.to(activeDjSocket).emit('audioListener', socket.id);
  });
  socket.on('audioSignal', ({ to, description, candidate } = {}) => {
    if (typeof to !== 'string' || !io.sockets.sockets.has(to)) return;
    if (socket.id !== activeDjSocket && to !== activeDjSocket) return;
    if (description && !['offer','answer'].includes(description.type)) return;
    io.to(to).emit('audioSignal', { from: socket.id, description, candidate });
  });
  socket.on('disconnect', () => {
    if (activeDjSocket === socket.id) {
      activeDjSocket = null;
      io.emit('audioAvailability', false);
      io.emit('audioEnded');
    }
  });
});

app.get('/health',(_,r)=>r.json({ok:true}));server.listen(process.env.PORT||3000,()=>console.log('QH Radio gestart'));
