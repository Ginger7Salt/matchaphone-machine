import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {ImagePlus,Link2,RotateCcw,Smartphone,Upload} from "lucide-react";
import {useNavigate} from "react-router-dom";
import {
  compactPages,DESKTOP_APPS,DESKTOP_COLUMNS,DESKTOP_ROWS,MAX_DESKTOP_PAGES,
  moveDesktopAppIntoDock,moveDockAppToDesktop,normalizeComplimentBubbleData,normalizeHeroData,
  normalizeProfileStatusData,reorderDesktopApp,reorderDockApp
} from "../core/appearance";
import {buildMobileHomeRowBounds,mobileHomeVisualGridPlacement,nearestMobileHomeLogicalRow} from "../core/mobileHomeLayout";
import {auditMobileHomeGeometry,sameMobileHomeGeometryAudit,type MobileHomeGeometryAudit,type MobileHomeRect} from "../core/mobileHomeGeometry";
import {db,setSetting} from "../core/db";
import {compressImage} from "../core/imageAssets";
import {placeFloatingToolbar} from "../core/floatingToolbar";
import {useStore} from "../core/store";
import type {AppearanceSettings,AppearanceSource,DesktopAppId,DesktopItem,HeroWidgetData,ImageAsset} from "../core/types";

type HeroField="topBackground"|"sideImage"|"bottomImageOne"|"bottomImageTwo"|"bottomImageThree"|"pillText"|"titleText";
type WidgetEditField=HeroField|"profileStatus.image"|"profileStatus.captionText"|"profileStatus.typingText"|"complimentBubble.text";
type PageSwipe={pointerId:number;startX:number;startY:number;lastX:number;lastY:number;axis:"pending"|"horizontal"|"vertical"};
type TextEditState={itemId:string;field:WidgetEditField;value:string;original:string;saving:boolean;error?:string};
type ImageToolState={itemId:string;field:WidgetEditField;anchorX:number;anchorTop:number;anchorBottom:number;x:number;y:number;placement:"above"|"below";arrowX?:number;maxHeight?:number;showUrl:boolean;url:string;busy:boolean;error?:string};
type DesktopArrangement={items:DesktopItem[];dock:DesktopAppId[]};
type DragSource=
  |{kind:"desktop";itemId:string;appId:DesktopAppId;page:number;x:number;y:number}
  |{kind:"dock";appId:DesktopAppId;dockIndex:number};
type DragTarget=
  |{kind:"desktop";page:number;x:number;y:number}
  |{kind:"dock";index:number}
  |{kind:"blocked";page:number;x:number;y:number}
  |null;
type DragOverlayState={appId:DesktopAppId;width:number;height:number};
type GridMetrics={rect:DOMRect;paddingLeft:number;paddingTop:number;cellWidth:number;columnGap:number;rowBounds:readonly {top:number;bottom:number;center:number}[]};
type DragRuntime={
  pointerId:number;source:DragSource;element:HTMLElement;startX:number;startY:number;lastX:number;lastY:number;
  timer:number|null;active:boolean;raf:number|null;edgeTimer:number|null;edgeDirection:-1|0|1;edgeLatched:boolean;
  offsetX:number;offsetY:number;originRect:DOMRect;grid:GridMetrics|null;dockRect:DOMRect|null;homeRect:DOMRect|null;
  origin:DesktopArrangement;preview:DesktopArrangement;target:DragTarget;baseAppearance:AppearanceSettings;
};
type TextEditorBindings={active:TextEditState|null;start:(field:WidgetEditField,value:string)=>void;change:(value:string)=>void;commit:()=>Promise<void>;cancel:()=>void};

function sourceUrl(source:AppearanceSource|undefined,assets:ImageAsset[]){return source?.type==="asset"?assets.find(asset=>asset.id===source.value)?.data:source?.type==="url"?source.value:undefined}
const imageFields=new Set<WidgetEditField>(["topBackground","sideImage","bottomImageOne","bottomImageTwo","bottomImageThree","profileStatus.image"]);
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
const stopPointer=(event:React.PointerEvent)=>event.stopPropagation();
const targetKey=(target:DragTarget)=>target?target.kind+":"+(target.kind==="dock"?target.index:target.page+":"+target.x+":"+target.y):"none";
const arrangementsEqual=(a:DesktopArrangement,b:DesktopArrangement)=>JSON.stringify(a.dock)===JSON.stringify(b.dock)&&JSON.stringify(a.items)===JSON.stringify(b.items);

export default function Home(){
  const nav=useNavigate(),{appearance,imageAssets,conversationSummaries,feedPosts,memoryExtractionBatches,reload}=useStore();
  const [page,setPage]=useState(0),[editing,setEditing]=useState(false),[draftArrangement,setDraftArrangement]=useState<DesktopArrangement|null>(null);
  const [dragOverlay,setDragOverlay]=useState<DragOverlayState|null>(null),[dragTarget,setDragTarget]=useState<DragTarget>(null),[dragPageCount,setDragPageCount]=useState(0),[dragError,setDragError]=useState("");
  const [textEdit,setTextEdit]=useState<TextEditState|null>(null),[imageTools,setImageTools]=useState<ImageToolState|null>(null);
  const hold=useRef<number|null>(null),pageSwipe=useRef<PageSwipe|null>(null),suppressOpen=useRef(false),pageRef=useRef(0),dragRuntimeRef=useRef<DragRuntime|null>(null),pressedAppRef=useRef<HTMLElement|null>(null),draftRef=useRef<DesktopArrangement|null>(null),flipRectsRef=useRef<Map<string,DOMRect>|null>(null);
  const homeRef=useRef<HTMLDivElement>(null),desktopRef=useRef<HTMLDivElement>(null),footerRef=useRef<HTMLDivElement>(null),dotsRef=useRef<HTMLDivElement>(null),dockRef=useRef<HTMLDivElement>(null),dragOverlayRef=useRef<HTMLDivElement>(null),imageToolsRef=useRef<HTMLDivElement>(null),fileRef=useRef<HTMLInputElement>(null),cameraRef=useRef<HTMLInputElement>(null);
  const apps=useMemo(()=>new Map(DESKTOP_APPS.map(app=>[app.id,app])),[]);

  useEffect(()=>{pageRef.current=page},[page]);
  useEffect(()=>{draftRef.current=draftArrangement},[draftArrangement]);
  useLayoutEffect(()=>{
    if(!imageTools||!homeRef.current||!imageToolsRef.current)return;
    let frame=0;
    const reposition=()=>{
      const home=homeRef.current,tools=imageToolsRef.current;if(!home||!tools)return;
      const homeRect=home.getBoundingClientRect(),toolsRect=tools.getBoundingClientRect(),scroll=tools.querySelector<HTMLElement>(".widget-image-tools-scroll"),margin=8,gap=8,width=Math.min(toolsRect.width,Math.max(0,homeRect.width-margin*2)),naturalHeight=(scroll?.scrollHeight??tools.scrollHeight)+2;
      const {x,y,placement,arrowX,maxHeight}=placeFloatingToolbar({viewportWidth:homeRect.width,viewportHeight:homeRect.height,anchorX:imageTools.anchorX,anchorTop:imageTools.anchorTop,anchorBottom:imageTools.anchorBottom,toolbarWidth:width,toolbarHeight:naturalHeight,margin,gap});
      setImageTools(current=>!current||current.itemId!==imageTools.itemId||current.field!==imageTools.field?current:(Math.abs(current.x-x)<.5&&Math.abs(current.y-y)<.5&&current.placement===placement&&Math.abs((current.arrowX??0)-arrowX)<.5&&Math.abs((current.maxHeight??0)-maxHeight)<.5?current:{...current,x,y,placement,arrowX,maxHeight}));
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(reposition)};
    schedule();
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(schedule):undefined;observer?.observe(imageToolsRef.current);
    window.addEventListener("resize",schedule);window.visualViewport?.addEventListener("resize",schedule);
    return()=>{cancelAnimationFrame(frame);observer?.disconnect();window.removeEventListener("resize",schedule);window.visualViewport?.removeEventListener("resize",schedule)};
  },[imageTools?.itemId,imageTools?.field,imageTools?.showUrl,imageTools?.busy,imageTools?.error]);
  useLayoutEffect(()=>{
    const home=homeRef.current,phone=home?.closest<HTMLElement>(".phone");
    if(!home||!phone)return;
    let frame=0,stableCount=0,lastAbnormalAudit:MobileHomeGeometryAudit|null=null,stopped=false,deadline=0;
    const rect=(element:Element|null|undefined):MobileHomeRect|null=>element?element.getBoundingClientRect():null;
    const resetStability=()=>{stableCount=0;lastAbnormalAudit=null};
    const check=()=>{
      if(stopped||phone.classList.contains("pwa-home-layout-v5-recovery"))return;
      if(Date.now()>deadline)return;
      const candidate=phone.classList.contains("pwa-home-recovery-candidate")&&phone.classList.contains("native-mobile-viewport");
      const activeElement=document.activeElement as HTMLElement|null,keyboardFocused=Boolean(activeElement&&(activeElement.matches("input, textarea, select")||activeElement.isContentEditable))&&document.documentElement.dataset.chachaKeyboardMode!=="none";
      if(!candidate||document.visibilityState!=="visible"||keyboardFocused){resetStability();frame=requestAnimationFrame(check);return}
      const viewport=window.visualViewport,visualTop=Math.max(0,viewport?.offsetTop??0),visualHeight=Math.max(1,viewport?.height??window.innerHeight),heroRects=Array.from(home.querySelectorAll<HTMLElement>(".hero-collage-thumb")).map(element=>element.getBoundingClientRect()),appRects=Array.from(home.querySelectorAll<HTMLElement>(`.desktop-app[data-page="${pageRef.current}"]`)).map(element=>element.getBoundingClientRect());
      const dotsRect=rect(dotsRef.current),dockRect=rect(dockRef.current),footerRect=rect(footerRef.current),canvasRect=rect(home),ready=heroRects.length===3&&heroRects.every(item=>item.width>.5&&item.height>.5)&&appRects.length>0&&appRects.every(item=>item.width>.5&&item.height>.5)&&Boolean(dotsRect&&dotsRect.width>.5&&dotsRect.height>.5&&dockRect&&dockRect.width>.5&&dockRect.height>.5&&footerRect&&footerRect.width>.5&&footerRect.height>.5&&canvasRect&&canvasRect.width>.5&&canvasRect.height>.5);
      if(!ready){resetStability();frame=requestAnimationFrame(check);return}
      const audit=auditMobileHomeGeometry({heroRects,appRects,dotsRect,dockRect,footerRect,canvasRect,visualTop,visualHeight,safeAreaBottom:Number.parseFloat(getComputedStyle(phone).getPropertyValue("--safe-area-bottom"))||0});
      if(audit.valid){resetStability()}else if(sameMobileHomeGeometryAudit(lastAbnormalAudit,audit,2)){stableCount+=1}else{stableCount=1;lastAbnormalAudit=audit}
      if(!audit.valid&&stableCount>=2){window.dispatchEvent(new CustomEvent("chacha:home-geometry-recovery",{detail:{recover:true,audit}}));return}
      frame=requestAnimationFrame(check);
    };
    const schedule=(duration=1600)=>{if(stopped||phone.classList.contains("pwa-home-layout-v5-recovery"))return;deadline=Date.now()+duration;resetStability();cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(check)})};
    const onViewportChange=()=>schedule(),onVisibility=()=>{if(document.visibilityState==="visible")schedule()};
    schedule(2600);
    window.addEventListener("pageshow",onViewportChange);window.addEventListener("resize",onViewportChange);window.addEventListener("orientationchange",onViewportChange);window.visualViewport?.addEventListener("resize",onViewportChange);window.visualViewport?.addEventListener("scroll",onViewportChange);document.addEventListener("visibilitychange",onVisibility);
    return()=>{stopped=true;cancelAnimationFrame(frame);window.removeEventListener("pageshow",onViewportChange);window.removeEventListener("resize",onViewportChange);window.removeEventListener("orientationchange",onViewportChange);window.visualViewport?.removeEventListener("resize",onViewportChange);window.visualViewport?.removeEventListener("scroll",onViewportChange);document.removeEventListener("visibilitychange",onVisibility)};
  },[]);
  useEffect(()=>()=>{const runtime=dragRuntimeRef.current;if(runtime?.timer)window.clearTimeout(runtime.timer);if(runtime?.raf)cancelAnimationFrame(runtime.raf);if(runtime?.edgeTimer)window.clearTimeout(runtime.edgeTimer);pressedAppRef.current?.classList.remove("desktop-app-pressed")},[]);
  useLayoutEffect(()=>{
    const before=flipRectsRef.current;if(!before)return;flipRectsRef.current=null;
    const reduce=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;if(reduce)return;
    homeRef.current?.querySelectorAll<HTMLElement>("[data-reorder-key]").forEach(element=>{
      const key=element.dataset.reorderKey,oldRect=key?before.get(key):undefined;if(!oldRect||element.classList.contains("drag-source-hidden"))return;
      const nextRect=element.getBoundingClientRect(),dx=oldRect.left-nextRect.left,dy=oldRect.top-nextRect.top;if(Math.abs(dx)<.5&&Math.abs(dy)<.5)return;
      element.animate?.([{transform:`translate3d(${dx}px,${dy}px,0)`},{transform:"translate3d(0,0,0)"}],{duration:205,easing:"cubic-bezier(.2,.75,.25,1)",fill:"both"});
    });
  },[draftArrangement,page]);

  if(!appearance)return null;
  const arrangement=draftArrangement??{items:appearance.items,dock:appearance.dock};
  const basePages=Math.min(MAX_DESKTOP_PAGES,Math.max(1,...arrangement.items.map(item=>item.page+1)));
  const pages=dragOverlay?Math.min(MAX_DESKTOP_PAGES,Math.max(basePages,dragPageCount,page+1)):basePages;
  const wallpaper=sourceUrl(appearance.wallpaper,imageAssets),wallStyle=wallpaper?{backgroundImage:'url("'+wallpaper+'")'}:{background:appearance.wallpaper.value||"#fff"};
  const unread=Object.values(conversationSummaries??{}).reduce((sum,summary)=>sum+summary.proactiveUnreadCount,0)+feedPosts.filter(post=>(post.origin==="proactive"&&!post.readAt)||post.comments.some(comment=>comment.origin==="proactive"&&!comment.readAt)).length;
  const pending=memoryExtractionBatches.filter(batch=>batch.status==="pending").length;
  const quickEditing=Boolean(textEdit||imageTools);

  const saveAppearance=async(next=appearance)=>{await setSetting("appearance",next);await reload()};
  const updateWidget=async(itemId:string,field:WidgetEditField,value:string|AppearanceSource|undefined)=>{
    const items=appearance.items.map(item=>{
      if(item.id!==itemId)return item;
      if(field.startsWith("profileStatus.")){const key=field.split(".")[1] as "image"|"captionText"|"typingText";return{...item,profileStatus:{...normalizeProfileStatusData(item.profileStatus),[key]:value}}}
      if(field==="complimentBubble.text")return{...item,complimentBubble:{...normalizeComplimentBubbleData(item.complimentBubble),text:String(value??"")}};
      return{...item,hero:{...normalizeHeroData(item.hero),[field]:value} as HeroWidgetData};
    });
    await saveAppearance({...appearance,items});
  };

  const clearHold=()=>{if(hold.current)window.clearTimeout(hold.current);hold.current=null};
  const clearAppPress=()=>{pressedAppRef.current?.classList.remove("desktop-app-pressed");pressedAppRef.current=null};
  const markAppPressed=(element:HTMLElement)=>{clearAppPress();pressedAppRef.current=element;element.classList.add("desktop-app-pressed")};
  const beginHold=()=>{if(quickEditing||dragRuntimeRef.current)return;clearHold();hold.current=window.setTimeout(()=>{setImageTools(null);setTextEdit(null);setEditing(true);try{navigator.vibrate?.(8)}catch{/* optional */}},450)};
  const endHold=()=>clearHold();
  const releaseSwipeSuppression=()=>window.setTimeout(()=>{suppressOpen.current=false},0);
  const captureFlipRects=()=>{const rects=new Map<string,DOMRect>();homeRef.current?.querySelectorAll<HTMLElement>("[data-reorder-key]").forEach(element=>{const key=element.dataset.reorderKey;if(key)rects.set(key,element.getBoundingClientRect())});flipRectsRef.current=rects};
  const setDraft=(next:DesktopArrangement)=>{captureFlipRects();draftRef.current=next;setDraftArrangement(next)};
  const cacheGridMetrics=()=>{
    const grid=desktopRef.current;if(!grid)return null;
    const rect=grid.getBoundingClientRect(),style=getComputedStyle(grid),paddingLeft=parseFloat(style.paddingLeft)||0,paddingRight=parseFloat(style.paddingRight)||0,paddingTop=parseFloat(style.paddingTop)||0,paddingBottom=parseFloat(style.paddingBottom)||0,columnGap=parseFloat(style.columnGap)||0,rowGap=parseFloat(style.rowGap)||0;
    const locked=Boolean(homeRef.current?.closest(".pwa-home-layout-v3, .pwa-home-layout-v5-recovery"));
    const rowBounds=locked
      ?buildMobileHomeRowBounds(Array.from({length:DESKTOP_ROWS},(_,row)=>parseFloat(style.getPropertyValue(`--pwa-home-row-${row+1}`))||0),Array.from({length:DESKTOP_ROWS-1},(_,gap)=>parseFloat(style.getPropertyValue(`--pwa-home-gap-${gap+1}`))||parseFloat(style.getPropertyValue("--pwa-home-row-gap"))||0),paddingTop)
      :Array.from({length:DESKTOP_ROWS},(_,row)=>{const cellHeight=(rect.height-paddingTop-paddingBottom-rowGap*(DESKTOP_ROWS-1))/DESKTOP_ROWS,top=paddingTop+row*(cellHeight+rowGap);return{top,bottom:top+cellHeight,center:top+cellHeight/2}});
    return{rect,paddingLeft,paddingTop,columnGap,rowBounds,cellWidth:(rect.width-paddingLeft-paddingRight-columnGap*(DESKTOP_COLUMNS-1))/DESKTOP_COLUMNS};
  };
  const clearEdge=(runtime:DragRuntime)=>{if(runtime.edgeTimer)window.clearTimeout(runtime.edgeTimer);runtime.edgeTimer=null;runtime.edgeDirection=0;homeRef.current?.classList.remove("drag-edge-left","drag-edge-right")};
  const recacheDragBounds=(runtime:DragRuntime)=>{runtime.grid=cacheGridMetrics();runtime.dockRect=dockRef.current?.getBoundingClientRect()??null;runtime.homeRect=homeRef.current?.getBoundingClientRect()??null};
  const dockTargetIndex=(runtime:DragRuntime,x:number)=>{
    const rect=runtime.dockRect;if(!rect)return 0;
    const count=runtime.source.kind==="desktop"&&runtime.origin.dock.length<4?runtime.origin.dock.length+1:Math.max(1,runtime.origin.dock.length);
    return clamp(Math.floor(((x-rect.left)/Math.max(rect.width,1))*count),0,Math.min(3,count-1));
  };
  const hitTest=(runtime:DragRuntime,x:number,y:number):DragTarget=>{
    const dock=runtime.dockRect;if(dock&&x>=dock.left&&x<=dock.right&&y>=dock.top&&y<=dock.bottom)return{kind:"dock",index:dockTargetIndex(runtime,x)};
    const grid=runtime.grid;if(!grid||x<grid.rect.left||x>grid.rect.right||y<grid.rect.top||y>grid.rect.bottom)return null;
    const cellX=clamp(Math.floor((x-grid.rect.left-grid.paddingLeft)/(grid.cellWidth+grid.columnGap)),0,DESKTOP_COLUMNS-1),cellY=clamp(nearestMobileHomeLogicalRow(y-grid.rect.top,grid.rowBounds),0,DESKTOP_ROWS-1),currentPage=pageRef.current;
    const blocked=runtime.origin.items.some(item=>item.kind==="widget"&&item.page===currentPage&&cellX<item.x+item.w&&cellX+1>item.x&&cellY<item.y+item.h&&cellY+1>item.y);
    return blocked?{kind:"blocked",page:currentPage,x:cellX,y:cellY}:{kind:"desktop",page:currentPage,x:cellX,y:cellY};
  };
  const arrangementForTarget=(runtime:DragRuntime,target:DragTarget):DesktopArrangement=>{
    const origin=runtime.origin;if(!target||target.kind==="blocked")return origin;
    if(runtime.source.kind==="desktop"){
      if(target.kind==="dock")return moveDesktopAppIntoDock(origin.items,origin.dock,runtime.source.itemId,target.index);
      return{items:reorderDesktopApp(origin.items,runtime.source.itemId,target.page,target.x,target.y),dock:origin.dock};
    }
    if(target.kind==="dock")return{items:origin.items,dock:reorderDockApp(origin.dock,runtime.source.appId,target.index)};
    return moveDockAppToDesktop(origin.items,origin.dock,runtime.source.appId,target.page,target.x,target.y);
  };
  const applyDragTarget=(runtime:DragRuntime,target:DragTarget)=>{
    if(targetKey(runtime.target)===targetKey(target))return;
    runtime.target=target;setDragTarget(target);dragOverlayRef.current?.classList.toggle("invalid",target?.kind==="blocked");
    const next=arrangementForTarget(runtime,target);runtime.preview=next;setDraft(next);
  };
  const handleEdgePaging=(runtime:DragRuntime,x:number)=>{
    const rect=runtime.homeRect;if(!rect)return;
    const direction:-1|0|1=x<=rect.left+28?-1:x>=rect.right-28?1:0;
    const canMove=direction<0?pageRef.current>0:direction>0?pageRef.current<MAX_DESKTOP_PAGES-1:false;
    if(!direction||!canMove){runtime.edgeLatched=false;clearEdge(runtime);return}
    if(runtime.edgeLatched)return;
    if(runtime.edgeDirection===direction&&runtime.edgeTimer)return;
    clearEdge(runtime);runtime.edgeDirection=direction;homeRef.current?.classList.add(direction<0?"drag-edge-left":"drag-edge-right");
    runtime.edgeTimer=window.setTimeout(()=>{
      runtime.edgeTimer=null;if(dragRuntimeRef.current!==runtime||!runtime.active)return;
      const next=clamp(pageRef.current+direction,0,MAX_DESKTOP_PAGES-1);if(next===pageRef.current)return;
      runtime.edgeLatched=true;runtime.target=null;setDragTarget(null);pageRef.current=next;setPage(next);setDragPageCount(count=>Math.max(count,next+1));
      requestAnimationFrame(()=>{if(dragRuntimeRef.current===runtime){recacheDragBounds(runtime);scheduleDragFrame(runtime)}});
    },500);
  };
  const scheduleDragFrame=(runtime:DragRuntime)=>{
    if(runtime.raf!==null)return;
    runtime.raf=requestAnimationFrame(()=>{
      runtime.raf=null;if(dragRuntimeRef.current!==runtime||!runtime.active)return;
      const overlay=dragOverlayRef.current;if(overlay){const left=runtime.lastX-runtime.offsetX,top=runtime.lastY-runtime.offsetY;overlay.style.transform=`translate3d(${left}px,${top}px,0) scale(1.08)`;overlay.style.opacity="1"}
      handleEdgePaging(runtime,runtime.lastX);applyDragTarget(runtime,hitTest(runtime,runtime.lastX,runtime.lastY));
    });
  };
  const windowDragMove=(event:PointerEvent)=>{
    const runtime=dragRuntimeRef.current;if(!runtime||runtime.pointerId!==event.pointerId)return;
    runtime.lastX=event.clientX;runtime.lastY=event.clientY;
    if(!runtime.active){if(Math.hypot(event.clientX-runtime.startX,event.clientY-runtime.startY)>8)cancelPendingDrag();return}
    event.preventDefault();scheduleDragFrame(runtime);
  };
  const windowDragUp=(event:PointerEvent)=>{const runtime=dragRuntimeRef.current;if(!runtime||runtime.pointerId!==event.pointerId)return;if(runtime.active){event.preventDefault();void finishDrag(runtime,false);return}const path=apps.get(runtime.source.appId)?.path;cancelPendingDrag();clearAppPress();if(path&&!editing&&!quickEditing&&!suppressOpen.current){event.preventDefault();suppressOpen.current=true;nav(path);releaseSwipeSuppression()}};
  const windowDragCancel=(event:PointerEvent)=>{const runtime=dragRuntimeRef.current;if(!runtime||runtime.pointerId!==event.pointerId)return;if(runtime.active)void finishDrag(runtime,true);else cancelPendingDrag()};
  const preventNativePress=(event:Event)=>event.preventDefault();
  const addNativePressGuards=()=>{homeRef.current?.classList.add("desktop-pressing");document.addEventListener("selectstart",preventNativePress,true);document.addEventListener("contextmenu",preventNativePress,true);document.addEventListener("dragstart",preventNativePress,true)};
  const removeNativePressGuards=()=>{clearAppPress();homeRef.current?.classList.remove("desktop-pressing");document.removeEventListener("selectstart",preventNativePress,true);document.removeEventListener("contextmenu",preventNativePress,true);document.removeEventListener("dragstart",preventNativePress,true)};
  const visibilityCancel=()=>{if(document.visibilityState!=="hidden")return;const runtime=dragRuntimeRef.current;if(runtime){if(runtime.active)void finishDrag(runtime,true);else cancelPendingDrag()}clearAppPress();suppressOpen.current=false};
  const removeDragListeners=()=>{window.removeEventListener("pointermove",windowDragMove,true);window.removeEventListener("pointerup",windowDragUp,true);window.removeEventListener("pointercancel",windowDragCancel,true);document.removeEventListener("visibilitychange",visibilityCancel);removeNativePressGuards()};
  const resetDragRuntime=(runtime:DragRuntime,keepDraft=false)=>{
    if(runtime.timer)window.clearTimeout(runtime.timer);if(runtime.raf!==null)cancelAnimationFrame(runtime.raf);clearEdge(runtime);removeDragListeners();
    dragRuntimeRef.current=null;setDragOverlay(null);setDragTarget(null);setDragPageCount(0);if(!keepDraft){draftRef.current=null;setDraftArrangement(null)}
  };
  const animateOverlayTo=(runtime:DragRuntime,rect:DOMRect,done:()=>void)=>{
    const overlay=dragOverlayRef.current,reduce=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;if(!overlay||reduce){done();return}
    overlay.style.transition="transform 175ms cubic-bezier(.2,.9,.25,1.08)";overlay.style.transform=`translate3d(${rect.left}px,${rect.top}px,0) scale(1)`;window.setTimeout(done,185);
  };
  const finishDrag=async(runtime:DragRuntime,cancelled:boolean)=>{
    if(dragRuntimeRef.current!==runtime)return;
    suppressOpen.current=true;runtime.active=false;if(runtime.raf!==null){cancelAnimationFrame(runtime.raf);runtime.raf=null}clearEdge(runtime);removeDragListeners();
    const finalArrangement=cancelled?runtime.origin:runtime.preview,changed=!cancelled&&!arrangementsEqual(finalArrangement,runtime.origin);
    const targetElement=changed?homeRef.current?.querySelector<HTMLElement>(`[data-app-id="${runtime.source.appId}"]`):null,targetRect=targetElement?.getBoundingClientRect()??runtime.originRect;
    animateOverlayTo(runtime,targetRect,async()=>{
      if(!changed){const returnPage=runtime.source.kind==="desktop"?runtime.source.page:clamp(pageRef.current,0,Math.max(0,...runtime.origin.items.map(item=>item.page)));if(pageRef.current!==returnPage){pageRef.current=returnPage;setPage(returnPage)}resetDragRuntime(runtime);releaseSwipeSuppression();return}
      const normalized={items:compactPages(finalArrangement.items),dock:finalArrangement.dock};draftRef.current=normalized;setDraftArrangement(normalized);
      try{await setSetting("appearance",{...runtime.baseAppearance,items:normalized.items,dock:normalized.dock});await reload();const finalPages=Math.max(1,...normalized.items.map(item=>item.page+1));if(pageRef.current>=finalPages){pageRef.current=finalPages-1;setPage(finalPages-1)}resetDragRuntime(runtime);setDragError("")}
      catch{resetDragRuntime(runtime);setDragError("布局保存失败，已恢复原位置")}
      releaseSwipeSuppression();
    });
  };
  const cancelPendingDrag=()=>{const runtime=dragRuntimeRef.current;if(!runtime)return;if(runtime.timer)window.clearTimeout(runtime.timer);runtime.timer=null;if(!runtime.active){removeDragListeners();dragRuntimeRef.current=null}};
  const activateDrag=(runtime:DragRuntime)=>{
    if(dragRuntimeRef.current!==runtime||quickEditing)return;
    runtime.timer=null;clearAppPress();runtime.active=true;runtime.originRect=runtime.element.getBoundingClientRect();runtime.offsetX=runtime.startX-runtime.originRect.left;runtime.offsetY=runtime.startY-runtime.originRect.top;recacheDragBounds(runtime);
    setImageTools(null);setTextEdit(null);setEditing(true);setDragError("");setDragPageCount(Math.max(basePages,pageRef.current+1));setDragOverlay({appId:runtime.source.appId,width:runtime.originRect.width,height:runtime.originRect.height});suppressOpen.current=true;
    try{navigator.vibrate?.(10)}catch{/* optional */}requestAnimationFrame(()=>scheduleDragFrame(runtime));
  };
  const startAppPress=(source:DragSource,element:HTMLElement,event:React.PointerEvent)=>{
    event.stopPropagation();if(quickEditing||dragRuntimeRef.current)return;markAppPressed(element);
    const runtime:DragRuntime={pointerId:event.pointerId,source,element,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,timer:null,active:false,raf:null,edgeTimer:null,edgeDirection:0,edgeLatched:false,offsetX:0,offsetY:0,originRect:element.getBoundingClientRect(),grid:null,dockRect:null,homeRect:null,origin:{items:appearance.items,dock:appearance.dock},preview:{items:appearance.items,dock:appearance.dock},target:null,baseAppearance:appearance};
    dragRuntimeRef.current=runtime;addNativePressGuards();window.addEventListener("pointermove",windowDragMove,{capture:true,passive:false});window.addEventListener("pointerup",windowDragUp,true);window.addEventListener("pointercancel",windowDragCancel,true);document.addEventListener("visibilitychange",visibilityCancel);
    if(editing)activateDrag(runtime);else runtime.timer=window.setTimeout(()=>activateDrag(runtime),450);
  };
  const pageSwipePointerDown=(event:React.PointerEvent<HTMLDivElement>)=>{
    pageSwipe.current=null;if(event.pointerType==="mouse"||event.isPrimary===false||editing||quickEditing||Boolean(dragRuntimeRef.current))return;
    pageSwipe.current={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,axis:"pending"};
  };
  const pageSwipePointerMove=(event:React.PointerEvent<HTMLDivElement>)=>{
    const swipe=pageSwipe.current;if(!swipe||swipe.pointerId!==event.pointerId)return;if(editing||quickEditing||dragRuntimeRef.current?.active){pageSwipe.current=null;return}
    swipe.lastX=event.clientX;swipe.lastY=event.clientY;const dx=swipe.lastX-swipe.startX,dy=swipe.lastY-swipe.startY,absX=Math.abs(dx),absY=Math.abs(dy);
    if(swipe.axis==="pending"&&Math.max(absX,absY)>=10){if(absX>absY*1.25){swipe.axis="horizontal";clearHold();cancelPendingDrag();suppressOpen.current=true}else if(absY>absX*1.25)swipe.axis="vertical"}
    if(swipe.axis==="horizontal"&&event.cancelable)event.preventDefault();
  };
  const finishPageSwipe=(event:React.PointerEvent<HTMLDivElement>,cancelled=false)=>{
    const swipe=pageSwipe.current;if(!swipe||swipe.pointerId!==event.pointerId)return;pageSwipe.current=null;
    if(swipe.axis!=="horizontal"){if(cancelled)suppressOpen.current=false;return}
    clearHold();cancelPendingDrag();suppressOpen.current=true;const dx=(event.clientX||swipe.lastX)-swipe.startX;
    if(!cancelled&&Math.abs(dx)>=48)setPage(current=>clamp(current+(dx<0?1:-1),0,pages-1));if(event.cancelable)event.preventDefault();releaseSwipeSuppression();
  };

  const finishEditing=()=>{clearHold();clearAppPress();cancelPendingDrag();setImageTools(null);setTextEdit(null);setEditing(false);setDragError("")};
  const openApp=(path:string)=>{clearAppPress();if(quickEditing)return;if(suppressOpen.current){suppressOpen.current=false;return}if(!editing)nav(path)};
  const startTextEdit=(item:DesktopItem,field:WidgetEditField,value:string)=>{if(editing||imageFields.has(field))return;endHold();setImageTools(null);setTextEdit({itemId:item.id,field,value,original:value,saving:false})};
  const commitTextEdit=async()=>{
    const current=textEdit;if(!current||current.saving)return;const value=current.value.trim().slice(0,80);if(!value||value===current.original){setTextEdit(null);return}
    setTextEdit({...current,value,saving:true,error:undefined});try{await updateWidget(current.itemId,current.field,value);setTextEdit(null)}catch{setTextEdit(previous=>previous?.itemId===current.itemId&&previous.field===current.field?{...previous,saving:false,error:"保存失败，请重试"}:previous)}
  };
  const openImageTools=(item:DesktopItem,field:WidgetEditField,element:HTMLElement)=>{
    if(editing||!imageFields.has(field))return;endHold();if(textEdit)void commitTextEdit();if(imageTools?.itemId===item.id&&imageTools.field===field){setImageTools(null);return}
    const homeRect=homeRef.current?.getBoundingClientRect(),rect=element.getBoundingClientRect();if(!homeRect)return;
    const anchorX=rect.left+rect.width/2-homeRect.left,anchorTop=rect.top-homeRect.top,anchorBottom=rect.bottom-homeRect.top,width=Math.min(258,homeRect.width-16),estimatedHeight=64;
    const placement:ImageToolState["placement"]=anchorTop>estimatedHeight+16?"above":"below",x=clamp(anchorX-width/2,8,Math.max(8,homeRect.width-width-8)),y=placement==="above"?Math.max(8,anchorTop-8-estimatedHeight):Math.min(homeRect.height-8-estimatedHeight,anchorBottom+8);
    setImageTools({itemId:item.id,field,anchorX,anchorTop,anchorBottom,x,y,placement,arrowX:anchorX-x,maxHeight:estimatedHeight,showUrl:false,url:"",busy:false});
  };
  const patchImageTools=(patch:Partial<ImageToolState>)=>setImageTools(current=>current?{...current,...patch}:current);
  const saveImageSource=async(source:AppearanceSource|undefined)=>{const target=imageTools;if(!target||target.busy)return;patchImageTools({busy:true,error:undefined});try{await updateWidget(target.itemId,target.field,source);setImageTools(null)}catch{patchImageTools({busy:false,error:"保存失败，请重试"})}};
  const chooseImage=async(file?:File)=>{const target=imageTools;if(!file||!target||target.busy)return;patchImageTools({busy:true,error:undefined});try{const asset=await compressImage(file,"widget");await db.imageAssets.put(asset);await updateWidget(target.itemId,target.field,{type:"asset",value:asset.id});setImageTools(null)}catch{patchImageTools({busy:false,error:"图片处理失败，请重试"})}};
  const applyImageUrl=()=>{const value=imageTools?.url.trim();if(!value){patchImageTools({error:"请输入图片 URL"});return}void saveImageSource({type:"url",value})};
  const switchPage=(index:number)=>{if(quickEditing||editing||dragRuntimeRef.current)return;setImageTools(null);setPage(index)};
  const homePointerDown=(event:React.PointerEvent<HTMLDivElement>)=>{
    const target=event.target as HTMLElement;if(target.closest(".widget-image-tools")||target.closest(".widget-inline-text-input")||target.closest("[data-widget-image-trigger]")||target.closest(".desktop-edit-done"))return;
    if(quickEditing){setImageTools(null);clearHold();return}if(editing&&!target.closest(".desktop-app")&&!target.closest(".dock-app")){finishEditing();return}beginHold();
  };

  const overlayApp=dragOverlay?apps.get(dragOverlay.appId):undefined,overlayBadge=dragOverlay?.appId==="messages"?unread:dragOverlay?.appId==="memories"?pending:0;
  return <div ref={homeRef} className={"home-page cha-home "+(wallpaper?"pwa-home-image-wallpaper ":"")+(editing?"editing ":"")+(quickEditing?"widget-quick-editing":"")} style={wallStyle} onPointerDown={homePointerDown} onPointerUp={endHold} onPointerCancel={endHold} onContextMenu={event=>{if(editing||dragRuntimeRef.current)event.preventDefault()}}>
    {editing&&<><button className="desktop-edit-done" onClick={event=>{event.stopPropagation();finishEditing()}}>完成</button><div className="desktop-drag-hint">按住并拖动 App 调整位置</div></>}
    {dragError&&<div className="desktop-drag-error" role="status">{dragError}</div>}
    <div ref={desktopRef} className="desktop-pages" onPointerDownCapture={pageSwipePointerDown} onPointerMoveCapture={pageSwipePointerMove} onPointerUpCapture={event=>finishPageSwipe(event)} onPointerCancelCapture={event=>finishPageSwipe(event,true)}>{arrangement.items.filter(item=>item.page===page).map(item=>{
      if(item.kind==="app"&&item.appId){const app=apps.get(item.appId);if(!app)return null;return <AppItem key={item.id} item={item} app={app} assets={imageAssets} source={appearance.iconSources[item.appId]} badge={item.appId==="messages"?unread:item.appId==="memories"?pending:0} editing={editing} hidden={dragOverlay?.appId===item.appId} onOpen={()=>openApp(app.path)} onPointerDown={event=>startAppPress({kind:"desktop",itemId:item.id,appId:item.appId!,page:item.page,x:item.x,y:item.y},event.currentTarget,event)}/>}
      const textEditor:TextEditorBindings={active:textEdit,start:(field,value)=>startTextEdit(item,field,value),change:value=>setTextEdit(current=>current?{...current,value,error:undefined}:current),commit:commitTextEdit,cancel:()=>setTextEdit(null)};
      return <WidgetItem key={item.id} item={item} assets={imageAssets} textEditor={textEditor} onHold={beginHold} onEnd={endHold} onImageEdit={(field,element)=>openImageTools(item,field,element)}/>;
    })}</div>
    <div ref={footerRef} className="desktop-footer-stack">
      <div ref={dotsRef} className="page-dots">{Array.from({length:pages},(_,index)=><button key={index} disabled={quickEditing||editing} aria-label={"第 "+(index+1)+" 页"} className={index===page?"active":""} onClick={()=>switchPage(index)}/>)}</div>
      <div ref={dockRef} className={"dock cha-dock "+(dragTarget?.kind==="dock"?"dock-drop-active":"")}>{arrangement.dock.map((id,index)=>{const app=apps.get(id)!;return <DockApp key={id} id={id} name={app.name} icon={app.icon} source={appearance.iconSources[id]} assets={imageAssets} hidden={dragOverlay?.appId===id} target={dragTarget?.kind==="dock"&&dragTarget.index===index} onOpen={()=>openApp(app.path)} onPointerDown={event=>startAppPress({kind:"dock",appId:id,dockIndex:index},event.currentTarget,event)}/>})}</div>
    </div>
    {dragOverlay&&overlayApp&&<div ref={dragOverlayRef} className="desktop-drag-overlay" style={{width:dragOverlay.width||64,height:dragOverlay.height||76}} aria-hidden="true"><AppVisual app={overlayApp} source={appearance.iconSources[dragOverlay.appId]} assets={imageAssets} badge={overlayBadge}/></div>}
    {imageTools&&<ImageTools toolbarRef={imageToolsRef} state={imageTools} onAlbum={()=>fileRef.current?.click()} onCamera={()=>cameraRef.current?.click()} onToggleUrl={()=>patchImageTools({showUrl:!imageTools.showUrl,error:undefined})} onUrlChange={url=>patchImageTools({url,error:undefined})} onApplyUrl={applyImageUrl} onRestore={()=>void saveImageSource(undefined)} onClose={()=>setImageTools(null)}/>} 
    <input hidden ref={fileRef} type="file" accept="image/*" onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void chooseImage(file)}}/>
    <input hidden ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void chooseImage(file)}}/>
  </div>;
}

function AppVisual({app,source,assets,badge=0}:{app:(typeof DESKTOP_APPS)[number];source?:AppearanceSource;assets:ImageAsset[];badge?:number}){const Icon=app.icon,src=sourceUrl(source,assets);return <>{src?<img src={src} alt=""/>:<span><Icon/>{badge>0&&<i>{Math.min(99,badge)}</i>}</span>}<b>{app.name}</b></>}
function AppItem({item,app,assets,source,badge,editing,hidden,onOpen,onPointerDown}:{item:DesktopItem;app:(typeof DESKTOP_APPS)[number];assets:ImageAsset[];source?:AppearanceSource;badge:number;editing:boolean;hidden:boolean;onOpen:()=>void;onPointerDown:(event:React.PointerEvent<HTMLButtonElement>)=>void}){
  const visual=mobileHomeVisualGridPlacement(item.y,item.h),style={"--x":item.x,"--y":item.y,"--w":item.w,"--h":item.h,"--pwa-row-start":visual.start,"--pwa-row-end":visual.end} as React.CSSProperties;
  return <button className={"desktop-item desktop-app "+(hidden?"drag-source-hidden":"")} style={style} aria-grabbed={hidden} data-editing={editing||undefined} data-reorder-key={item.appId} data-app-id={item.appId} onContextMenu={event=>event.preventDefault()} onPointerDown={onPointerDown} onClick={onOpen}><AppVisual app={app} source={source} assets={assets} badge={badge}/></button>;
}
function DockApp({id,name,icon:Icon,source,assets,hidden,target,onOpen,onPointerDown}:{id:DesktopAppId;name:string;icon:(typeof DESKTOP_APPS)[number]["icon"];source?:AppearanceSource;assets:ImageAsset[];hidden:boolean;target:boolean;onOpen:()=>void;onPointerDown:(event:React.PointerEvent<HTMLButtonElement>)=>void}){const src=sourceUrl(source,assets);return <button className={"dock-app "+(hidden?"drag-source-hidden ":"")+(target?"dock-drop-target":"")} aria-label={name} data-reorder-key={id} data-app-id={id} onContextMenu={event=>event.preventDefault()} onPointerDown={onPointerDown} onClick={onOpen}>{src?<img src={src} alt=""/>:<span><Icon/></span>}<small>{name}</small></button>}
function WidgetItem({item,assets,textEditor,onHold,onEnd,onImageEdit}:{item:DesktopItem;assets:ImageAsset[];textEditor:TextEditorBindings;onHold:()=>void;onEnd:()=>void;onImageEdit:(field:WidgetEditField,element:HTMLElement)=>void}){
  const visual=mobileHomeVisualGridPlacement(item.y,item.h),style={"--x":item.x,"--y":item.y,"--w":item.w,"--h":item.h,"--pwa-row-start":visual.start,"--pwa-row-end":visual.end} as React.CSSProperties;
  return <div className={"desktop-item desktop-widget widget-"+item.widgetType} style={style} onPointerDown={event=>{event.stopPropagation();onHold()}} onPointerUp={onEnd} onPointerCancel={onEnd}>
    {item.widgetType==="hero-profile"?<HeroWidget itemId={item.id} data={normalizeHeroData(item.hero)} assets={assets} editor={textEditor} onImageEdit={onImageEdit}/>:item.widgetType==="profile-status"?<ProfileStatusWidget item={item} assets={assets} editor={textEditor} onImageEdit={onImageEdit}/>:item.widgetType==="compliment-bubble"?<ComplimentBubbleWidget item={item} editor={textEditor}/>:<div className="widget-placeholder"><ImagePlus/><span>图片组件</span></div>}
    {textEditor.active?.itemId===item.id&&textEditor.active.error&&<span className="widget-inline-edit-error">{textEditor.active.error}</span>}
  </div>;
}
function ImageButton({source,assets,className,field,onEdit}:{source?:AppearanceSource;assets:ImageAsset[];className:string;field:WidgetEditField;onEdit:(field:WidgetEditField,element:HTMLElement)=>void}){const src=sourceUrl(source,assets);return <button className={className} data-widget-image-trigger="true" aria-label="编辑组件图片" onPointerDown={stopPointer} onClick={event=>{event.stopPropagation();onEdit(field,event.currentTarget)}}>{src?<img src={src} alt=""/>:<ImagePlus/>}</button>}
function EditableText({itemId,field,value,className,editor,multiline=false,children}:{itemId:string;field:WidgetEditField;value:string;className:string;editor:TextEditorBindings;multiline?:boolean;children?:React.ReactNode}){
  const active=editor.active?.itemId===itemId&&editor.active.field===field?editor.active:null;if(!active)return <button className={className} onPointerDown={stopPointer} onClick={event=>{event.stopPropagation();editor.start(field,value)}}>{children??value}</button>;
  const common={className:className+" widget-inline-text-input",autoFocus:true,maxLength:80,value:active.value,disabled:active.saving,onPointerDown:stopPointer,onClick:(event:React.MouseEvent)=>event.stopPropagation(),onFocus:(event:React.FocusEvent<HTMLInputElement|HTMLTextAreaElement>)=>event.currentTarget.select(),onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>editor.change(event.currentTarget.value),onBlur:()=>void editor.commit(),onKeyDown:(event:React.KeyboardEvent<HTMLInputElement|HTMLTextAreaElement>)=>{if(event.key==="Escape"){event.preventDefault();editor.cancel()}else if(event.key==="Enter"){event.preventDefault();event.currentTarget.blur()}}};
  return multiline?<textarea {...common} rows={2} aria-label="组件文字输入"/>:<input {...common} type="text" aria-label="组件文字输入"/>;
}
function HeroWidget({itemId,data,assets,editor,onImageEdit}:{itemId:string;data:HeroWidgetData;assets:ImageAsset[];editor:TextEditorBindings;onImageEdit:(field:WidgetEditField,element:HTMLElement)=>void}){return <div className="hero-collage-widget"><ImageButton source={data.topBackground} assets={assets} className="hero-collage-bg" field="topBackground" onEdit={onImageEdit}/><ImageButton source={data.sideImage} assets={assets} className="hero-collage-side" field="sideImage" onEdit={onImageEdit}/><EditableText itemId={itemId} field="pillText" value={data.pillText} className="hero-collage-pill" editor={editor}/><div className="hero-collage-strip"><ImageButton source={data.bottomImageOne} assets={assets} className="hero-collage-thumb" field="bottomImageOne" onEdit={onImageEdit}/><ImageButton source={data.bottomImageTwo} assets={assets} className="hero-collage-thumb" field="bottomImageTwo" onEdit={onImageEdit}/><ImageButton source={data.bottomImageThree} assets={assets} className="hero-collage-thumb" field="bottomImageThree" onEdit={onImageEdit}/></div></div>}
function ProfileStatusWidget({item,assets,editor,onImageEdit}:{item:DesktopItem;assets:ImageAsset[];editor:TextEditorBindings;onImageEdit:(field:WidgetEditField,element:HTMLElement)=>void}){const data=normalizeProfileStatusData(item.profileStatus),src=sourceUrl(data.image,assets);return <div className="profile-status-widget"><span className="profile-status-back" aria-hidden="true">‹ 返回</span><span className="profile-status-menu" aria-hidden="true"><i/><i/><i/></span><div className="profile-status-avatar-wrap"><button className="profile-status-avatar" data-widget-image-trigger="true" aria-label="编辑头像图片" onPointerDown={stopPointer} onClick={event=>{event.stopPropagation();onImageEdit("profileStatus.image",event.currentTarget)}}>{src?<img src={src} alt="用户头像"/>:<ImagePlus/>}</button><span className="profile-status-chat-badge" aria-hidden="true"><i/></span></div><EditableText itemId={item.id} field="profileStatus.captionText" value={data.captionText} className="profile-status-caption" editor={editor}/><EditableText itemId={item.id} field="profileStatus.typingText" value={data.typingText} className="profile-status-typing" editor={editor}><i/><span>{data.typingText}</span></EditableText></div>}
function ComplimentBubbleWidget({item,editor}:{item:DesktopItem;editor:TextEditorBindings}){const data=normalizeComplimentBubbleData(item.complimentBubble);return <div className="compliment-bubble-widget"><EditableText itemId={item.id} field="complimentBubble.text" value={data.text} className="compliment-main-bubble" editor={editor} multiline><span>{data.text}</span></EditableText><span className="compliment-heart" aria-hidden="true">?</span><span className="compliment-typing-bubble" aria-hidden="true"><i/><i/><i/></span></div>}
function ImageTools({toolbarRef,state,onAlbum,onCamera,onToggleUrl,onUrlChange,onApplyUrl,onRestore,onClose}:{toolbarRef:React.RefObject<HTMLDivElement|null>;state:ImageToolState;onAlbum:()=>void;onCamera:()=>void;onToggleUrl:()=>void;onUrlChange:(value:string)=>void;onApplyUrl:()=>void;onRestore:()=>void;onClose:()=>void}){
  const style={left:state.x,top:state.y,"--tool-arrow-x":`${state.arrowX??24}px`,"--tool-max-height":`${state.maxHeight??240}px`} as React.CSSProperties;
  return <div ref={toolbarRef} className={"widget-image-tools "+state.placement} style={style} role="toolbar" aria-label="组件图片工具" onPointerDown={stopPointer} onClick={event=>event.stopPropagation()}><i className="widget-image-tools-arrow" aria-hidden="true"/><div className="widget-image-tools-scroll"><div className="widget-image-tools-actions"><button disabled={state.busy} onClick={onAlbum}><Upload/><span>相册</span></button><button disabled={state.busy} onClick={onCamera}><Smartphone/><span>相机</span></button><button className={state.showUrl?"active":""} disabled={state.busy} onClick={onToggleUrl}><Link2/><span>URL</span></button><button disabled={state.busy} onClick={onRestore}><RotateCcw/><span>默认</span></button></div>{state.showUrl&&<div className="widget-image-url-row"><input autoFocus aria-label="组件图片 URL" value={state.url} placeholder="https://..." onChange={event=>onUrlChange(event.currentTarget.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();onApplyUrl()}else if(event.key==="Escape"){event.preventDefault();onClose()}}}/><button disabled={state.busy||!state.url.trim()} onClick={onApplyUrl}>应用</button></div>}{(state.busy||state.error)&&<small className={state.error?"error":""}>{state.error??"正在保存…"}</small>}</div></div>;
}
