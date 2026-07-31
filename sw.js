const CACHE_NAME='dentanki-1.5.0-20260731-1530';
const APP_SHELL=['./','./index.html','./style.css?v=20260731-1530','./app.js?v=20260731-1530','./manifest.webmanifest?v=20260731-1530','./version.json'];
self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)));
    await self.clients.claim();
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    clients.forEach(client=>client.postMessage({type:'SW_ACTIVATED',version:'1.5.0',build:'20260731-1530'}));
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
  if(event.data?.type==='GET_VERSION')event.source?.postMessage({type:'SW_VERSION',version:'1.5.0',build:'20260731-1530'});
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  const isNavigation=event.request.mode==='navigate';
  const isVersion=url.pathname.endsWith('/version.json')||url.pathname.endsWith('version.json');
  if(isNavigation||isVersion){
    event.respondWith((async()=>{
      try{
        const response=await fetch(event.request,{cache:'no-store'});
        const cache=await caches.open(CACHE_NAME);cache.put(event.request,response.clone());
        return response;
      }catch{return (await caches.match(event.request))||(await caches.match('./index.html'));}
    })());
    return;
  }
  event.respondWith((async()=>{
    const cached=await caches.match(event.request);
    const network=fetch(event.request).then(async response=>{
      if(response?.ok){const cache=await caches.open(CACHE_NAME);cache.put(event.request,response.clone());}
      return response;
    }).catch(()=>null);
    return cached||(await network)||Response.error();
  })());
});
