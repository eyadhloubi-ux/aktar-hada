/* عامل الخدمة: بيخلّي اللعبة قابلة للتنزيل كتطبيق، وبيحفظ الملفات الثابتة */
const C='qa3da-aktar-v2';
const ASSETS=['/vendor/qrcode.js','/favicon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin!==location.origin||u.pathname.startsWith('/ws')||u.pathname.startsWith('/stats')||u.pathname==='/healthz')return;
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put('/',cp));return res}).catch(()=>caches.match('/')));
    return;
  }
  e.respondWith(caches.match(r).then(m=>m||fetch(r)));
});
