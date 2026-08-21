import {afterEach,describe,expect,it,vi} from "vitest";
import {cleanup,render,waitFor} from "@testing-library/react";
import {MemoryRouter,Route,Routes} from "react-router-dom";
import {PhoneShell} from "./ui";

vi.mock("../core/musicPlayer",()=>({GlobalMusicMiniPlayer:()=>null}));

afterEach(()=>{
 cleanup();
 vi.restoreAllMocks();
 Object.defineProperty(window.navigator,"standalone",{configurable:true,value:false});
 Object.defineProperty(window.navigator,"virtualKeyboard",{configurable:true,value:undefined});
 Object.defineProperty(window.screen,"width",{configurable:true,value:0});
 Object.defineProperty(window.screen,"height",{configurable:true,value:0});
 Object.defineProperty(window.screen,"availHeight",{configurable:true,value:0});
});

function setTouchViewport(enabled:boolean){
 Object.defineProperty(window.navigator,"maxTouchPoints",{configurable:true,value:enabled?5:0});
 Object.defineProperty(window,"matchMedia",{configurable:true,value:vi.fn().mockImplementation((query:string)=>({
  matches:enabled&&query.includes("pointer: coarse"),
  media:query,
  onchange:null,
  addEventListener:vi.fn(),
  removeEventListener:vi.fn(),
  addListener:vi.fn(),
  removeListener:vi.fn(),
  dispatchEvent:vi.fn(),
 }))});
}

function renderShell(pathname:string){
 return render(<MemoryRouter initialEntries={[pathname]}><Routes><Route element={<PhoneShell/>}><Route path="*" element={<div>page</div>}/></Route></Routes></MemoryRouter>);
}

function setViewportMetrics(input:{innerHeight:number;clientHeight:number;visualHeight:number;offsetTop?:number;width?:number;screenHeight?:number;screenAvailHeight?:number}){
 const listeners=new Map<string,Set<EventListener>>();
 const visualViewport={
  width:input.width??390,
  height:input.visualHeight,
  offsetTop:input.offsetTop??0,
  addEventListener:(type:string,listener:EventListener)=>{const bucket=listeners.get(type)??new Set<EventListener>();bucket.add(listener);listeners.set(type,bucket)},
  removeEventListener:(type:string,listener:EventListener)=>listeners.get(type)?.delete(listener),
  dispatch:(type:string)=>listeners.get(type)?.forEach(listener=>listener(new Event(type))),
 };
 const width=input.width??390;
 Object.defineProperty(window,"innerWidth",{configurable:true,value:width});
 Object.defineProperty(window,"innerHeight",{configurable:true,writable:true,value:input.innerHeight});
 Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:width});
 Object.defineProperty(window.screen,"width",{configurable:true,value:width});
 Object.defineProperty(window.screen,"height",{configurable:true,value:input.screenHeight??input.innerHeight});
 Object.defineProperty(window.screen,"availHeight",{configurable:true,value:input.screenAvailHeight??input.screenHeight??input.innerHeight});
 Object.defineProperty(document.documentElement,"clientHeight",{configurable:true,writable:true,value:input.clientHeight});
 Object.defineProperty(window,"visualViewport",{configurable:true,value:visualViewport});
 return visualViewport;
}

describe("PhoneShell native topbar routes",()=>{
 it.each([
  ["/settings/stickers","sticker-settings-route"],
  ["/messages/conversation-1/settings","chat-settings-route"],
 ])("uses the real mobile safe area for %s",(pathname,routeClass)=>{
  setTouchViewport(true);
  const {container}=renderShell(pathname);
  const phone=container.querySelector(".phone");
  expect(phone).toHaveClass("native-mobile-viewport","native-topbar-route",routeClass);
  expect(phone?.querySelector(":scope > .status")).toBeInTheDocument();
 });

 it.each(["/settings/speech","/messages/conversation-1/search","/messages/conversation-1/inner-voice/character/char-1"])("does not expand the native topbar fix to %s",pathname=>{
  setTouchViewport(true);
  const {container}=renderShell(pathname);
  expect(container.querySelector(".phone")).not.toHaveClass("native-topbar-route","sticker-settings-route","chat-settings-route");
 });

 it("uses narrow viewport fallback and explicit forum route class",()=>{
  setTouchViewport(false);
  Object.defineProperty(window,"innerWidth",{configurable:true,value:390});
  Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:390});
  const {container}=renderShell("/forum");
  expect(container.querySelector(".phone")).toHaveClass("native-mobile-viewport","native-topbar-route","forum-route");
 });
 it("keeps the simulated status bar path on desktop phone frames",()=>{
  Object.defineProperty(window,"innerWidth",{configurable:true,value:1024});
  Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:1024});
  setTouchViewport(false);
  const {container}=renderShell("/settings/stickers");
  const phone=container.querySelector(".phone");
  expect(phone).toHaveClass("native-topbar-route","sticker-settings-route");
  expect(phone).not.toHaveClass("native-mobile-viewport");
  expect(phone?.querySelector(":scope > .status")).toBeInTheDocument();
 });
 it.each(["/messages/contacts/add","/messages/contacts/requests","/messages/group/new","/messages/conversation-1/members/add"])("classifies message-flow route %s for native topbar",pathname=>{
  setTouchViewport(true);
  const {container}=renderShell(pathname);
  expect(container.querySelector(".phone")).toHaveClass("native-mobile-viewport","native-topbar-route","message-flow-route");
 });

 it("tracks a shrinking visual viewport without applying a second composer offset",async()=>{
  setTouchViewport(true);
  const viewport=setViewportMetrics({innerHeight:844,clientHeight:844,visualHeight:844});
  renderShell("/messages/conversation-1");
  await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("844px"));
  viewport.height=520;
  viewport.dispatch("resize");
  await waitFor(()=>expect(document.documentElement.dataset.chachaKeyboardMode).toBe("resize"));
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("520px");
  expect(document.querySelector(".phone")).not.toHaveClass("keyboard-open");
 });

 it("uses the Virtual Keyboard overlay inset only when the visual viewport stays stable",async()=>{
  setTouchViewport(true);
  setViewportMetrics({innerHeight:844,clientHeight:844,visualHeight:844});
  const listeners=new Set<EventListener>();
  const virtualKeyboard={boundingRect:{height:0},addEventListener:(_type:string,listener:EventListener)=>listeners.add(listener),removeEventListener:(_type:string,listener:EventListener)=>listeners.delete(listener)};
  Object.defineProperty(navigator,"virtualKeyboard",{configurable:true,value:virtualKeyboard});
  renderShell("/messages/conversation-1");
  await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("844px"));
  virtualKeyboard.boundingRect.height=300;
  listeners.forEach(listener=>listener(new Event("geometrychange")));
  await waitFor(()=>expect(document.documentElement.dataset.chachaKeyboardMode).toBe("overlay"));
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("844px");
  expect(document.querySelector(".phone")).toHaveClass("keyboard-open");
 });

 describe("PWA home layout contract",()=>{
  it("activates only for a standalone narrow portrait home with distributable height",async()=>{
   setTouchViewport(true);
   setViewportMetrics({innerHeight:844,clientHeight:844,visualHeight:844});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   const {container}=renderShell("/");
   await waitFor(()=>expect(container.querySelector(".phone")).toHaveClass("pwa-home-layout-v3"));
   const phone=container.querySelector(".phone") as HTMLElement;
   expect(phone.style.getPropertyValue("--pwa-home-desktop-height")).not.toBe("");
   expect(Number.parseFloat(phone.style.getPropertyValue("--pwa-home-row-gap"))).toBeGreaterThanOrEqual(22);
   expect(Number.parseFloat(phone.style.getPropertyValue("--pwa-home-hero-thumb-size"))).toBeGreaterThan(95);
   expect(phone.style.getPropertyValue("--pwa-home-flex-spacer")).toBe("");
  });

  it("activates a full-canvas mobile home even when standalone is misreported",async()=>{
   setTouchViewport(true);
   setViewportMetrics({innerHeight:915,clientHeight:915,visualHeight:915,screenHeight:960,screenAvailHeight:960});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:false});
   const {container}=renderShell("/");
   await waitFor(()=>expect(container.querySelector(".phone")).toHaveClass("pwa-home-layout-v3"));
   expect(container.querySelector(".phone")).not.toHaveClass("standalone-mode");
  });
  it("latches v5 recovery only after Home reports stable abnormal geometry",async()=>{
   setTouchViewport(true);
   setViewportMetrics({innerHeight:915,clientHeight:915,visualHeight:844,screenHeight:915,screenAvailHeight:915});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   const {container}=renderShell("/");
   await waitFor(()=>expect(container.querySelector(".phone")).toHaveClass("pwa-home-layout-v3"));
   expect(container.querySelector(".phone")).not.toHaveClass("pwa-home-layout-v5-recovery");
   window.dispatchEvent(new CustomEvent("chacha:home-geometry-recovery",{detail:{recover:true}}));
   await waitFor(()=>expect(container.querySelector(".phone")).toHaveClass("pwa-home-layout-v5-recovery"));
   expect((container.querySelector(".phone") as HTMLElement).style.getPropertyValue("--pwa-home-recovery-height")).toBe("844px");
  });

  it("keeps a normal v3 launch unchanged until a later stable abnormal audit",async()=>{
   setTouchViewport(true);
   const viewport=setViewportMetrics({innerHeight:915,clientHeight:915,visualHeight:915});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   const {container}=renderShell("/");
   const phone=container.querySelector(".phone") as HTMLElement;
   await waitFor(()=>expect(phone).toHaveClass("pwa-home-layout-v3"));
   const frozenDesktopHeight=phone.style.getPropertyValue("--pwa-home-desktop-height");
   window.dispatchEvent(new CustomEvent("chacha:home-geometry-recovery",{detail:{valid:true}}));
   await new Promise(resolve=>setTimeout(resolve,0));
   expect(phone).not.toHaveClass("pwa-home-layout-v5-recovery");
   expect(phone.style.getPropertyValue("--pwa-home-desktop-height")).toBe(frozenDesktopHeight);
   viewport.height=760;viewport.dispatch("resize");
   await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("760px"));
   window.dispatchEvent(new CustomEvent("chacha:home-geometry-recovery",{detail:{recover:true}}));
   await waitFor(()=>expect(phone).toHaveClass("pwa-home-layout-v5-recovery"));
   expect(phone.style.getPropertyValue("--pwa-home-recovery-height")).toBe("760px");
  });

  it("can recover a short full-canvas home that never qualified for v3",async()=>{
   setTouchViewport(true);
   setViewportMetrics({innerHeight:620,clientHeight:620,visualHeight:620});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   const {container}=renderShell("/");
   const phone=container.querySelector(".phone") as HTMLElement;
   await waitFor(()=>expect(phone).toHaveClass("pwa-home-recovery-candidate"));
   expect(phone).not.toHaveClass("pwa-home-layout-v3");
   window.dispatchEvent(new CustomEvent("chacha:home-geometry-recovery",{detail:{recover:true}}));
   await waitFor(()=>expect(phone).toHaveClass("pwa-home-layout-v5-recovery"));
   expect(phone.style.getPropertyValue("--pwa-home-recovery-height")).toBe("620px");
  });

  it("keeps v5 latched for the launch after later viewport changes",async()=>{
   setTouchViewport(true);
   const viewport=setViewportMetrics({innerHeight:844,clientHeight:844,visualHeight:844});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   const {container}=renderShell("/");
   const phone=container.querySelector(".phone") as HTMLElement;
   window.dispatchEvent(new CustomEvent("chacha:home-geometry-recovery",{detail:{recover:true}}));
   await waitFor(()=>expect(phone).toHaveClass("pwa-home-layout-v5-recovery"));
   viewport.height=820;viewport.dispatch("resize");
   await waitFor(()=>expect(phone.style.getPropertyValue("--pwa-home-recovery-height")).toBe("820px"));
   expect(phone).toHaveClass("pwa-home-layout-v5-recovery");
  });

  it("does not activate in an ordinary browser tab",async()=>{
   setTouchViewport(true);
   setViewportMetrics({innerHeight:760,clientHeight:760,visualHeight:760,screenHeight:844,screenAvailHeight:844});
   const {container}=renderShell("/");
   await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("760px"));
   expect(container.querySelector(".phone")).not.toHaveClass("pwa-home-layout-v3");
   expect(container.querySelector(".phone")).toHaveClass("mobile-home-layout-v6");
  });

  it("uses the visible browser viewport for an ordinary mobile home", async () => {
   setTouchViewport(true);
   setViewportMetrics({innerHeight:844,clientHeight:844,visualHeight:700,screenHeight:844,screenAvailHeight:844});
   const {container}=renderShell("/");
   const phone=container.querySelector(".phone") as HTMLElement;
   await waitFor(()=>expect(phone).toHaveClass("mobile-home-layout-v6"));
   expect(phone.style.getPropertyValue("--mobile-home-visible-height")).toBe("700px");
   expect(phone.style.getPropertyValue("--visible-viewport-height")).toBe("700px");
  });
  it("does not activate for landscape, a desktop phone frame, a short PWA, or a non-home route",async()=>{
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   setTouchViewport(true);
   setViewportMetrics({innerHeight:390,clientHeight:390,visualHeight:390});
   Object.defineProperty(window,"innerWidth",{configurable:true,value:844});
   Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:844});
   const landscape=renderShell("/");
   await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("390px"));
   expect(landscape.container.querySelector(".phone")).not.toHaveClass("pwa-home-layout-v3");
   cleanup();

   setTouchViewport(false);
   Object.defineProperty(window,"innerWidth",{configurable:true,value:1024});
   Object.defineProperty(window,"innerHeight",{configurable:true,value:1200});
   Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:1024});
   Object.defineProperty(document.documentElement,"clientHeight",{configurable:true,value:1200});
   Object.defineProperty(window,"visualViewport",{configurable:true,value:undefined});
   const desktop=renderShell("/");
   expect(desktop.container.querySelector(".phone")).not.toHaveClass("pwa-home-layout-v3");
   cleanup();

   setTouchViewport(true);
   setViewportMetrics({innerHeight:620,clientHeight:620,visualHeight:620});
   const short=renderShell("/");
   await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("620px"));
   expect(short.container.querySelector(".phone")).not.toHaveClass("pwa-home-layout-v3");
   cleanup();

   setViewportMetrics({innerHeight:844,clientHeight:844,visualHeight:844});
   const app=renderShell("/settings");
   await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("844px"));
   expect(app.container.querySelector(".phone")).not.toHaveClass("pwa-home-layout-v3");
  });

  it("ignores an abnormal tall visual viewport and resyncs on BFCache pageshow",async()=>{
   setTouchViewport(true);
   const viewport=setViewportMetrics({innerHeight:915,clientHeight:915,visualHeight:1800});
   Object.defineProperty(window.navigator,"standalone",{configurable:true,value:true});
   const {container}=renderShell("/");
   await waitFor(()=>expect(container.querySelector(".phone")).toHaveClass("pwa-home-layout-v3"));
   expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("915px");
   Object.defineProperty(window,"innerHeight",{configurable:true,value:896});
   Object.defineProperty(document.documentElement,"clientHeight",{configurable:true,value:896});
   viewport.height=896;
   window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));
   await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--stable-layout-height")).toBe("896px"));
   expect(container.querySelector(".phone")).toHaveClass("pwa-home-layout-v3");
  });
 });});





