/* 注音打地鼠 離線用服務工作者
   - 遊戲本體（HTML／packs.js）：先抓網路、抓不到用快取 → 更新會自動生效，沒網路也開得起來
   - 語音檔（voice/）：先用快取、沒有才抓網路 → 玩過的句子自動留下來
   - 收到 cache-pack 訊息：把整包語音一次抓進快取（設定頁的「下載離線語音」按鈕） */
const CORE='core-v1', VOICE='voice-v1';
const GAME='./注音打地鼠_語音修正版.html';
const CORE_FILES=['./','./index.html',GAME,'./voice/packs.js','./manifest.webmanifest','./icon-180.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CORE).then(c=>Promise.allSettled(CORE_FILES.map(u=>c.add(new Request(u,{cache:'reload'}))))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>![CORE,VOICE].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin!==location.origin||e.request.method!=='GET') return;
  const isVoice=/\/voice\//.test(u.pathname);
  if(isVoice){                                              // 語音：快取優先
    e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(hit=>hit||fetch(e.request).then(res=>{
      if(res.ok){ const copy=res.clone(); caches.open(VOICE).then(c=>c.put(e.request,copy)); } return res; })));
  }else{                                                    // 遊戲：網路優先，失敗才用快取
    e.respondWith(fetch(e.request).then(res=>{
      if(res.ok){ const copy=res.clone(); caches.open(CORE).then(c=>c.put(e.request,copy)); } return res;
    }).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(hit=>hit||caches.match(GAME))));
  }
});
self.addEventListener('message',async e=>{
  const d=e.data||{};
  if(d.type==='cache-pack'){
    const c=await caches.open(VOICE); let done=0, fail=0;
    for(const f of d.files){
      const req=new Request(d.base+f);
      if(!(await c.match(req))){ try{ const r=await fetch(req); if(r.ok) await c.put(req,r); else fail++; }catch(err){ fail++; } }
      done++;
      if(done%25===0||done===d.files.length) e.source.postMessage({type:'cache-progress',done,total:d.files.length,fail});
    }
    e.source.postMessage({type:'cache-done',total:d.files.length,fail});
  }
  if(d.type==='cache-count'){
    const c=await caches.open(VOICE); const keys=await c.keys();
    e.source.postMessage({type:'cache-count',count:keys.filter(k=>k.url.includes(d.base)).length});
  }
});
