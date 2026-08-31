const SW_VERSION="chacha-sw-v2";
const scopeUrl=()=>self.registration?.scope||new URL("./",self.location.href).href;
const scopedTarget=(target)=>{try{return new URL(target.replace(/^\/+/,""),scopeUrl()).href}catch{return target}};
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("message",event=>{if(event.data?.type==="SKIP_WAITING")self.skipWaiting()});
self.addEventListener("sync",event=>{if(event.tag!=="chacha-background")return;event.waitUntil((async()=>{const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});for(const client of clients){client.postMessage({type:"CHACHA_BACKGROUND_WAKE",reason:"sync"});client.postMessage({type:"CHACHA_CHAT_REPLY_WAKE",reason:"sync"})}})())});
self.addEventListener("notificationclick",event=>{event.notification.close();const data=event.notification.data||{},target=scopedTarget(data.url||"");event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});for(const client of windows){if("focus" in client){await client.focus();if("navigate" in client)await client.navigate(target||scopeUrl());return}}if(self.clients.openWindow)await self.clients.openWindow(target||scopeUrl())})())});
