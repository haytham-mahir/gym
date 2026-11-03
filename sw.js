/* UNIT service worker — put this file next to index.html on your hosting.

   Three jobs:
   1. Keep a copy of the app so it opens with no signal. The page itself is
      fetched fresh whenever there is a connection (so updates arrive), and
      the saved copy is used only when the network fails. Firebase, font and
      icon files are served from the copy first.
      Database and sign-in traffic is never touched — it always goes live.
   2. Show lock-screen notifications pushed by the server (rest timer, Hub),
      and open the right screen when one is tapped.
   3. Phone-only fallback for the rest alert when server notifications are off.

   Bump CACHE when you want every phone to drop its old saved copy. */
const CACHE='unit-v3';
const SHELL=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/apple-touch-icon.png'];
const LIBS=/^https:\/\/(www\.gstatic\.com\/firebasejs\/|fonts\.googleapis\.com\/|fonts\.gstatic\.com\/)/;
const ICON='icons/icon-192.png', BADGE='icons/badge-96.png';

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('unit-')&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET')return;
  const url=new URL(r.url);

  // the app page: network first, saved copy when offline
  if(r.mode==='navigate'){
    e.respondWith((async()=>{
      try{
        const res=await fetch(r);
        if(res&&res.ok){const c=await caches.open(CACHE);c.put('./',res.clone());}
        return res;
      }catch(err){
        const c=await caches.open(CACHE);
        return (await c.match(r,{ignoreSearch:true}))||(await c.match('./'))||(await c.match('./index.html'))||Response.error();
      }
    })());
    return;
  }

  // Firebase SDK and fonts: saved copy first, fetched and saved the first time
  if(LIBS.test(r.url)){
    e.respondWith((async()=>{
      const c=await caches.open(CACHE);
      const hit=await c.match(r);
      if(hit)return hit;
      const res=await fetch(r);
      if(res&&(res.ok||res.type==='opaque'))c.put(r,res.clone());
      return res;
    })());
    return;
  }

  // other files on your own site (icons, manifest): serve saved, refresh behind
  if(url.origin===self.location.origin){
    e.respondWith((async()=>{
      const c=await caches.open(CACHE);
      const hit=await c.match(r);
      const net=fetch(r).then(res=>{if(res&&res.ok)c.put(r,res.clone());return res;}).catch(()=>hit);
      return hit||net;
    })());
  }
  // everything else (database, sign-in) goes straight to the network
});

/* ── pushed notifications ──
   The server sends data-only messages: {title, body, tag, url, kind, badge}.
   An iPhone insists every push shows something, so this always does. */
function readPush(e){
  let p={};
  try{p=e&&e.data?e.data.json():{};}catch(x){try{p={data:{body:e.data.text()}};}catch(y){p={};}}
  const d=Object.assign({},p.notification||{},p.data||{});
  // some senders put the fields at the top level
  ['title','body','tag','url','kind','badge'].forEach(k=>{if(d[k]===undefined&&p[k]!==undefined)d[k]=p[k];});
  return d;
}
async function handlePush(d){
  const kind=d.kind||'';
  const opts={
    body:d.body||'',
    tag:d.tag||kind||'unit',
    icon:ICON,badge:BADGE,
    data:{url:d.url||'./'},
    renotify:kind==='rest-done'||kind==='rest-warn'||kind==='test',
    requireInteraction:kind==='rest-done',   // Android keeps "go" on screen until it's seen
    vibrate:kind==='rest-done'?[300,100,300,100,600]:kind==='rest-warn'?[160,80,160]:[120]
  };
  // each rest alert replaces the one before it: until… → 30 seconds left → go
  if(kind==='rest-done'||kind==='rest-start'||kind==='rest-warn'){
    try{(await self.registration.getNotifications({tag:'rest'})).forEach(n=>n.close());}catch(x){}
    opts.tag='rest';
  }
  await self.registration.showNotification(d.title||'UNIT',opts);
  const n=parseInt(d.badge,10);
  if(n>0&&self.navigator&&self.navigator.setAppBadge){try{await self.navigator.setAppBadge(n);}catch(x){}}
}
self.addEventListener('push',e=>{e.waitUntil(handlePush(readPush(e)));});
self.__unitHandlePush=handlePush;   // lets the app's tests drive this without a real push

/* ── phone-only rest fallback ──
   The page posts {type:'S', ms, title, n} when a rest starts and {type:'C'}
   when it ends early. waitUntil keeps the worker awake for the rest (Android
   allows a few minutes; an iPhone does not — that is what server push is for). */
let restT=null,restDone=null;
function stopRest(){clearTimeout(restT);restT=null;if(restDone){restDone();restDone=null;}}
self.addEventListener('message',e=>{
  const d=e.data||{};
  if(d.type==='S'){
    stopRest();
    e.waitUntil(new Promise(res=>{
      restDone=res;
      restT=setTimeout(()=>{
        self.registration.showNotification(d.title||'Rest complete',{
          body:d.n||'Next set',tag:'rest',renotify:true,icon:ICON,badge:BADGE,vibrate:[200,100,200],data:{url:'./#train'}
        }).catch(()=>{}).finally(()=>{restDone=null;res();});
      },Math.max(0,d.ms||0));
    }));
  }
  if(d.type==='C'){
    stopRest();
    e.waitUntil(self.registration.getNotifications({tag:'rest'}).then(ns=>ns.forEach(n=>n.close())).catch(()=>{}));
  }
});

/* ── tapping a notification ──
   Bring the app forward and tell it where to go, or open it there. */
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil((async()=>{
    const cs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of cs){
      if('focus'in c){
        try{await c.focus();}catch(x){}
        c.postMessage({type:'open',url});
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
