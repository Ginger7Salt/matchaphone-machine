import {beforeEach,describe,expect,it,vi} from "vitest";
import {db} from "./db";
import {PHONE_APPS,PHONE_PASSCODE_LOCK_MS,PHONE_PASSCODE_MAX_ATTEMPTS,clearExpiredPhoneLock,clearPhonePasscodeFailures,ensurePhonePrivacy,generatePhoneAppContent,handlePhoneDiscovery,highestRiskPhoneApp,isTestCharacter,normalizeTestCharacterPhonePrivacy,phoneAccessPhase,phoneAppRisk,phonePasscodeOf,phoneAppUnlocked,phoneLocked,phoneSessionRisk,phoneBrowserSchema,phoneCalendarSchema,phoneCallsSchema,phoneGallerySchema,phoneJsonCandidates,phoneMessagesSchema,phoneNotesSchema,phoneWalletSchema,shouldDiscoverPasscode,shouldDiscoverPhoneSession,simplePhoneHint,verifyPhonePasscode} from "./phoneCheck";
import {defaultProvider,type Character,type MallOrder} from "./types";

const makeCharacter=(strategy:boolean,trust=0,intimacy=0):Character=>({id:"c",schemaVersion:1,createdAt:1,updatedAt:1,name:"月白",avatar:"",bio:"旅人",personality:"安静",speakingStyle:"简洁",background:"来自旧城",language:"中文",coreSetting:"来自旧城的安静旅人",persona:"喜欢夜晚和旧书",chatSettings:{language:"中文",contextLimit:30,stream:false,strategyMode:{enabled:strategy}},proactive:{messages:false,timeAware:false,frequency:"medium",quietStart:"23:00",quietEnd:"08:00",catchupLimit:3,dailyLimit:10},relationship:{intimacy,trust,mood:"平静",recentEvents:[]},lastActiveAt:1,phonePrivacy:{passcode:"0427",hint:"离开旧城的日子",createdAt:1}});
const provider={...defaultProvider, networkMode: "direct" as const,apiKey:"test",stream:false};

beforeEach(async()=>{await db.delete();await db.open();vi.restoreAllMocks()});

describe("phone access rules",()=>{
 it("uses the requested app names",()=>{
  expect(Object.fromEntries(PHONE_APPS.map(app=>[app.id,app.label]))).toMatchObject({messages:"Talk",contacts:"联系人",mail:"邮箱",maps:"地图",browser:"search",notes:"提醒事项",gallery:"照片",calls:"通话"});
 });
 it("unlocks by trust only when strategy mode is enabled",()=>{
  const low=makeCharacter(true,29),mid=makeCharacter(true,30),high=makeCharacter(true,65),free=makeCharacter(false,0);
  expect(phoneAppUnlocked(low,"calendar")).toBe(true);
  expect(phoneAppUnlocked(low,"browser")).toBe(false);
  expect(phoneAppUnlocked(mid,"browser")).toBe(true);
  expect(phoneAppUnlocked(mid,"calls")).toBe(true);
  expect(phoneAppUnlocked({...high,relationship:{...high.relationship,trust:64}},"messages")).toBe(false);
  expect(phoneAppUnlocked(high,"messages")).toBe(true);
  expect(PHONE_APPS.every(app=>phoneAppUnlocked(free,app.id))).toBe(true);
 });
 it("adjusts app risk only in strategy mode",()=>{
  expect(phoneAppRisk(makeCharacter(false,90),"messages")).toBe(.2);
  expect(phoneAppRisk(makeCharacter(true,70),"messages")).toBeCloseTo(.13);
  expect(phoneAppRisk(makeCharacter(true,90),"calendar")).toBe(.02);
 });
 it("normalizes every test character phone password to 0000",async()=>{
  const character={...makeCharacter(false),name:"测试甲"};
  expect(isTestCharacter(character)).toBe(true);
  expect(phonePasscodeOf(character)).toBe("0000");
  await db.characters.add(character);
  const privacy=await normalizeTestCharacterPhonePrivacy(character.id);
  expect(privacy).toMatchObject({passcode:"0000",hint:"测试密码是 0000"});
  expect((await db.characters.get(character.id))?.phonePrivacy?.passcode).toBe("0000");
 });
 it("only discovers the fifth consecutive wrong passcode",()=>{
  for(let attempt=1;attempt<PHONE_PASSCODE_MAX_ATTEMPTS;attempt++)expect(shouldDiscoverPasscode(attempt)).toBe(false);
  expect(shouldDiscoverPasscode(PHONE_PASSCODE_MAX_ATTEMPTS)).toBe(true);
  expect(shouldDiscoverPasscode(PHONE_PASSCODE_MAX_ATTEMPTS+1)).toBe(true);
 });
 it("bypasses every phone gate while strategy mode is disabled",()=>{
  const locked={...makeCharacter(false,0),phonePrivacy:{...makeCharacter(false).phonePrivacy!,failedAttempts:4,lockedUntil:Date.now()+60_000}};
  expect(phoneAccessPhase(locked)).toBe("home");
  expect(phoneLocked(locked)).toBe(false);
  expect(PHONE_APPS.every(app=>phoneAppUnlocked(locked,app.id))).toBe(true);
 });
 it("keeps password data dormant when strategy mode is disabled",async()=>{
  const character={...makeCharacter(false),phonePrivacy:{...makeCharacter(false).phonePrivacy!,failedAttempts:3,lastFailedAt:100,lockedUntil:200}};
  await db.characters.add(character);
  const privacy=await clearPhonePasscodeFailures(character.id,300);
  expect(privacy).toMatchObject({passcode:"0427",hint:"离开旧城的日子",failedAttempts:0,lockedUntil:200});
  expect(privacy?.lastFailedAt).toBeUndefined();
  const saved=await db.characters.get(character.id);
  const reenabled={...saved!,chatSettings:{...makeCharacter(true).chatSettings!,strategyMode:{enabled:true}}};
  expect(phoneAccessPhase(reenabled)).toBe("lockscreen");
  expect(phonePasscodeOf(reenabled)).toBe("0427");
 });
 it("keeps password hints short and uses only the first clue",()=>{
  expect(simplePhoneHint("第一次见面的月日。第二条复杂线索")).toBe("第一次见面的月日");
  expect(simplePhoneHint("这是一条超过十八个中文字而且不应该完整显示的密码线索").length).toBeLessThanOrEqual(18);
 });
});

describe("phone inspection session risk",()=>{
 it("does not evaluate an empty session",()=>{
  const character=makeCharacter(false,0);
  expect(highestRiskPhoneApp(character,[])).toBeUndefined();
  expect(phoneSessionRisk(character,[])).toBe(0);
  expect(shouldDiscoverPhoneSession(character,[],()=>0)).toBe(false);
 });
 it("uses the highest risk without adding app probabilities",()=>{
  const character=makeCharacter(false,0);
  expect(phoneSessionRisk(character,["calendar","gallery","wallet"])).toBe(.05);
  expect(phoneSessionRisk(character,["calendar","notes"])).toBe(.12);
  expect(phoneSessionRisk(character,["calendar","calls"])).toBe(.12);
  expect(phoneSessionRisk(character,["calendar","notes","messages"])).toBe(.2);
  expect(highestRiskPhoneApp(character,["calendar","notes","messages"])).toBe("messages");
 });
 it("keeps trust adjustment and ignores duplicate app ids",()=>{
  const character=makeCharacter(true,70);
  expect(phoneSessionRisk(character,["messages"])).toBeCloseTo(.13);
  expect(phoneSessionRisk(character,["messages","messages","calendar"])).toBeCloseTo(.13);
 });
 it("performs one controlled roll against the session maximum",()=>{
  const character=makeCharacter(false,0),below=vi.fn(()=>.199),above=vi.fn(()=>.201);
  expect(shouldDiscoverPhoneSession(character,["calendar","messages"],below)).toBe(true);
  expect(shouldDiscoverPhoneSession(character,["calendar","messages"],above)).toBe(false);
  expect(below).toHaveBeenCalledTimes(1);
  expect(above).toHaveBeenCalledTimes(1);
 });
});
describe("phone JSON recovery",()=>{
 it("extracts JSON from fences, prose and hidden-thought wrappers",()=>{
  expect(phoneJsonCandidates('```json\n{"events":[]}\n```')[0]).toEqual({events:[]});
  expect(phoneJsonCandidates('下面是结果：\n{"notes":[]}\n请查收')[0]).toEqual({notes:[]});
  expect(phoneJsonCandidates('<think>先分析一下</think>{"history":[]}')[0]).toEqual({history:[]});
 });
 it("repairs trailing commas without evaluating arbitrary code",()=>{
  expect(phoneJsonCandidates('{"photos":[{"title":"雨",}],}')[0]).toEqual({photos:[{title:"雨"}]});
  expect(phoneJsonCandidates('没有任何 JSON')).toEqual([]);
 });
});
describe("persistent phone passcode verification",()=>{
 it("persists the first four failures and accepts the correct leading-zero password",async()=>{
  const character=makeCharacter(true);await db.characters.add(character);
  for(let attempt=1;attempt<=4;attempt++){
   const result=await verifyPhonePasscode(character.id,"9999",1_000+attempt);
   expect(result).toMatchObject({status:"incorrect",failedAttempts:attempt,remainingAttempts:PHONE_PASSCODE_MAX_ATTEMPTS-attempt});
   expect((await db.characters.get(character.id))?.phonePrivacy?.failedAttempts).toBe(attempt);
  }
  const unlocked=await verifyPhonePasscode(character.id,"0427",2_000);
  expect(unlocked).toMatchObject({status:"unlocked",failedAttempts:0,remainingAttempts:PHONE_PASSCODE_MAX_ATTEMPTS});
  expect(unlocked.privacy).toMatchObject({passcode:"0427",failedAttempts:0,lastViewedAt:2_000});
  expect(unlocked.privacy?.lastFailedAt).toBeUndefined();
 });
 it("always verifies against the newest database password instead of a stale page object",async()=>{
  const stale=makeCharacter(true);await db.characters.add(stale);
  await db.characters.update(stale.id,{phonePrivacy:{...stale.phonePrivacy!,passcode:"7314"}});
  expect(phonePasscodeOf(stale)).toBe("0427");
  const result=await verifyPhonePasscode(stale.id,"7314",3_000);
  expect(result.status).toBe("unlocked");
  expect(result.privacy?.passcode).toBe("7314");
 });
 it("locks exactly five minutes on the fifth failure and rejects submissions while locked",async()=>{
  const character=makeCharacter(true);await db.characters.add(character);
  const start=10_000;
  for(let attempt=1;attempt<PHONE_PASSCODE_MAX_ATTEMPTS;attempt++)await verifyPhonePasscode(character.id,"9999",start+attempt);
  const fifthAt=start+PHONE_PASSCODE_MAX_ATTEMPTS,result=await verifyPhonePasscode(character.id,"9999",fifthAt);
  expect(result).toMatchObject({status:"lock-triggered",failedAttempts:PHONE_PASSCODE_MAX_ATTEMPTS,remainingAttempts:0,lockedUntil:fifthAt+PHONE_PASSCODE_LOCK_MS});
  expect(result.privacy).toMatchObject({passcode:"0427",failedAttempts:0,lockedUntil:fifthAt+PHONE_PASSCODE_LOCK_MS});
  const stillLocked=await verifyPhonePasscode(character.id,"0427",fifthAt+PHONE_PASSCODE_LOCK_MS-1);
  expect(stillLocked.status).toBe("locked");
  expect((await clearExpiredPhoneLock(character.id,fifthAt+PHONE_PASSCODE_LOCK_MS-1))?.lockedUntil).toBe(fifthAt+PHONE_PASSCODE_LOCK_MS);
  const cleared=await clearExpiredPhoneLock(character.id,fifthAt+PHONE_PASSCODE_LOCK_MS);
  expect(cleared?.lockedUntil).toBeUndefined();
  expect(cleared?.failedAttempts).toBe(0);
  expect((await verifyPhonePasscode(character.id,"0427",fifthAt+PHONE_PASSCODE_LOCK_MS+1)).status).toBe("unlocked");
 });
 it("unlocks immediately with strategy mode disabled while preserving dormant password and lock data",async()=>{
  const character={...makeCharacter(false),phonePrivacy:{...makeCharacter(false).phonePrivacy!,failedAttempts:4,lastFailedAt:5_000,lockedUntil:99_999}};await db.characters.add(character);
  const result=await verifyPhonePasscode(character.id,"not-a-passcode",6_000);
  expect(result.status).toBe("unlocked");
  expect(result.privacy).toMatchObject({passcode:"0427",failedAttempts:0,lockedUntil:99_999});
  expect(result.privacy?.lastFailedAt).toBeUndefined();
 });
 it("atomically allows only one fifth-attempt lock trigger",async()=>{
  const character={...makeCharacter(true),phonePrivacy:{...makeCharacter(true).phonePrivacy!,failedAttempts:4,lastFailedAt:7_000}};await db.characters.add(character);
  const results=await Promise.all([verifyPhonePasscode(character.id,"9999",8_000),verifyPhonePasscode(character.id,"9999",8_000)]);
  expect(results.filter(item=>item.status==="lock-triggered")).toHaveLength(1);
  expect(results.filter(item=>item.status==="locked")).toHaveLength(1);
  expect((await db.characters.get(character.id))?.phonePrivacy?.lockedUntil).toBe(8_000+PHONE_PASSCODE_LOCK_MS);
 });});
describe("phone passcode and generated content",()=>{
 it("creates a stable four digit passcode and reuses it",async()=>{
  const character={...makeCharacter(false),phonePrivacy:undefined};await db.characters.add(character);
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"passcode":"7314","hint":"与旧城有关"}'}}]}),{status:200,headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
  expect(await ensurePhonePrivacy(character.id,provider)).toMatchObject({passcode:"7314",hint:"与旧城有关"});
  expect((await db.characters.get(character.id))?.phonePrivacy?.passcode).toBe("7314");
  await ensurePhonePrivacy(character.id,provider);
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("accepts complete talk tabs and fills optional display fields",()=>{
  const parsed=phoneMessagesSchema.parse({contacts:[{name:"阿林",messages:[{sender:"阿林",senderType:"contact",content:"晚点回去。"},{sender:"月白",senderType:"character",content:"知道了。"}]}],discoveries:[{author:"阿林",content:"雨停了。"}],services:[{title:"附近话题"}]});
  expect(parsed.contacts).toHaveLength(1);
  expect(parsed.contacts[0]).toMatchObject({relationship:"私人联系人",preview:"",status:""});
  expect(parsed.contacts[0].messages[0].time).toBe("");
  expect(parsed.discoveries[0].category).toBe("动态");
 }); it("automatically repairs a non-JSON talk response once",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:"这里是角色的私人聊天记录，但我没有按 JSON 输出。"}}]}),{status:200,headers:{"Content-Type":"application/json"}}))
   .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({contacts:[{name:"阿林",relationship:"朋友",status:"刚下班",preview:"晚点见",messages:[{sender:"阿林",senderType:"contact",content:"晚点见。",time:"21:00"},{sender:"月白",senderType:"character",content:"好，我等你。",time:"21:01"}]}],discoveries:[{author:"阿林",content:"雨终于停了。",time:"今天",category:"动态"}],services:[{title:"附近话题",subtitle:"旧城夜景",category:"话题"}]})}}]}),{status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetchMock);
  const content=await generatePhoneAppContent(character.id,"messages",provider);
  expect("contacts" in content&&content.contacts[0].name).toBe("阿林");
  expect(fetchMock).toHaveBeenCalledTimes(2);
 }); it("validates all seven app response shapes",()=>{
  const talk={contacts:[{name:"林",relationship:"朋友",preview:"晚安",messages:[{sender:"林",senderType:"contact",content:"晚安",time:"22:00"},{sender:"月白",senderType:"character",content:"明天见",time:"22:01"}]}],discoveries:[{author:"林",content:"今天很安静",time:"今天",category:"动态"}],services:[{title:"夜间话题",subtitle:"附近的人在聊",category:"话题"}]};
  expect(phoneMessagesSchema.parse(talk).contacts).toHaveLength(1);
  expect(phoneGallerySchema.parse({photos:Array.from({length:8},(_,i)=>({title:`照片${i}`,date:"今天",location:"旧城",description:"雨后的街道"}))}).photos).toHaveLength(8);
  expect(phoneNotesSchema.parse({notes:Array.from({length:5},(_,i)=>({title:`笔记${i}`,body:"内容",updatedAt:"今天",tag:"生活"}))}).notes).toHaveLength(5);
  expect(phoneBrowserSchema.parse({history:Array.from({length:10},(_,i)=>({query:`搜索${i}`,title:"页面",visitedAt:"今天"}))}).history).toHaveLength(10);
  expect(phoneWalletSchema.parse({balanceCents:10000,transactions:Array.from({length:6},()=>({title:"咖啡店",description:"购买一杯拿铁作为早餐",merchant:"街角咖啡",amountCents:-2200,time:"今天",category:"餐饮"}))}).transactions).toHaveLength(6);
  expect(phoneCalendarSchema.parse({events:Array.from({length:6},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,"0")}`,time:"10:00",title:"日程",note:"备注",category:"生活"}))}).events).toHaveLength(6);
  expect(phoneCallsSchema.parse({contacts:[{name:"林",relationship:"朋友",phoneLabel:"手机"}],records:[{contactName:"林",direction:"incoming",time:"今天 10:00",duration:"03:12",summary:"约好晚餐"}]}).records).toHaveLength(1);
 });
 it("merges character orders without changing the user wallet",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);await db.settings.put({key:"mall-wallet",value:{balanceCents:520000,initializedAt:1,updatedAt:1}});
  const order: MallOrder={id:"o",schemaVersion:1,createdAt:2,updatedAt:2,kind:"gift",source:"character",payerType:"character",payerId:"c",payerName:"月白",recipientType:"user",recipientName:"我",items:[{id:"i",title:"礼物",merchantName:"MALL",category:"礼物",priceCents:8800,quantity:1,tone:1}],subtotalCents:8800,deliveryFeeCents:0,totalCents:8800,userChargeCents:0,status:"placed"};await db.mallOrders.add(order);
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({balanceCents:330000,transactions:Array.from({length:6},(_,i)=>({title:`流水${i}`,description:"在便利店购买晚餐和饮料",merchant:"便利店",amountCents:-1000,time:"今天",category:"日常"}))})}}]}),{status:200,headers:{"Content-Type":"application/json"}})));
  const content=await generatePhoneAppContent(character.id,"wallet",provider);
  expect("orders" in content&&content.orders).toHaveLength(1);
  expect(((await db.settings.get("mall-wallet"))?.value as {balanceCents:number}).balanceCents).toBe(520000);
 });
 it("normalizes legacy wallet fields instead of rejecting the app",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({data:{balance:"¥1234.56",transactions:[{merchant:"街角咖啡",amount:"-28.00元",date:"今天",type:"餐饮"}]}})}}]}),{status:200,headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
  const content=await generatePhoneAppContent(character.id,"wallet",provider);
  expect("transactions" in content&&content.transactions[0]).toMatchObject({title:"街角咖啡",description:"街角咖啡 · 餐饮",amountCents:-2800});
  expect("balanceCents" in content&&content.balanceCents).toBe(123456);
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("normalizes every generated calendar event to the current local day",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);
  const payload={events:[{date:"2030-12-31",time:"18:00",title:"晚餐",note:"和朋友见面",category:"生活"},{date:"明天",time:"08:00",title:"早餐",note:"在家",category:"生活"}]};
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(payload)}}]}),{status:200,headers:{"Content-Type":"application/json"}})));
  const content=await generatePhoneAppContent(character.id,"calendar",provider),now=new Date(),today=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0");
  expect("events" in content&&content.events.every(event=>event.date===today)).toBe(true);
  expect("events" in content&&content.events.map(event=>event.time)).toEqual(["08:00","18:00"]);
 });
 it("supplements incomplete talk tabs and the missing character reply locally",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);
  const payload={contacts:[{name:"阿林",messages:[{sender:"阿林",content:"还醒着吗？"}]}]};
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(payload)}}]}),{status:200,headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
  const content=await generatePhoneAppContent(character.id,"messages",provider);
  expect("discoveries" in content).toBe(true);
  if(!("discoveries" in content))throw new Error("expected talk content");
  expect(content.contacts.length).toBeGreaterThanOrEqual(6);
  expect(content.contacts[0].about.length).toBeGreaterThan(0);
  expect(content.contacts[0].messages.length).toBeGreaterThanOrEqual(8);
  expect(content.contacts[0].messages.some(message=>message.senderType==="character")).toBe(true);
  expect(content.discoveries.length).toBeGreaterThanOrEqual(8);
  expect(content.services.length).toBeGreaterThanOrEqual(4);
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("expands sparse call data with contact profiles and detailed transcripts",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);
  const payload={contacts:[{name:"阿林",relationship:"朋友"}],records:[{contactName:"阿林",direction:"incoming",time:"20:00",duration:"03:12",summary:"确认安排"}]};
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(payload)}}]}),{status:200,headers:{"Content-Type":"application/json"}})));
  const content=await generatePhoneAppContent(character.id,"calls",provider);
  expect("records" in content).toBe(true);
  if(!("records" in content))throw new Error("expected calls content");
  expect(content.contacts.length).toBeGreaterThanOrEqual(6);
  expect(content.contacts[0].about.length).toBeGreaterThan(0);
  expect(content.records.length).toBeGreaterThanOrEqual(10);
  expect(content.records[0].details.length).toBeGreaterThan(0);
  expect(content.records[0].transcript.length).toBeGreaterThanOrEqual(4);
 });
 it("returns safe local content for every app when both model outputs are unusable",async()=>{
  const character=makeCharacter(false);await db.characters.add(character);
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:"无法按要求返回结构"}}]}),{status:200,headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
  const expected={messages:"contacts",gallery:"photos",notes:"notes",browser:"history",wallet:"transactions",calendar:"events",calls:"records"} as const;
  for(const appId of Object.keys(expected) as Array<keyof typeof expected>){const content=await generatePhoneAppContent(character.id,appId,provider);expect(expected[appId] in content).toBe(true)}
  expect(fetchMock).toHaveBeenCalledTimes(14);
 });

});

describe("phone discovery consequences",()=>{
 it("only sends a reaction when strategy mode is disabled",async()=>{
  const character=makeCharacter(false,0,0);await db.characters.add(character);
  const before=structuredClone(character);
  const result=await handlePhoneDiscovery({characterId:character.id,provider:{...provider,apiKey:""},appId:"messages",reason:"app"});
  const saved=await db.characters.get(character.id),message=await db.messages.get(result.message.id);
  expect(result.strategy).toBe(false);
  expect(saved?.relationship).toEqual(before.relationship);
  expect(saved?.phonePrivacy).toEqual(before.phonePrivacy);
  expect(message?.origin).toBe("phone-inspection");
 });
 it("changes the relationship, invalidates the password and locks low-trust strategy characters",async()=>{
  const character=makeCharacter(true,35,50);await db.characters.add(character);
  const result=await handlePhoneDiscovery({characterId:character.id,provider:{...provider,apiKey:""},appId:"messages",reason:"app"});
  const saved=await db.characters.get(character.id);
  expect(result.strategy).toBe(true);
  expect(saved?.relationship).toMatchObject({trust:32,intimacy:49});
  expect(saved?.phonePrivacy?.passcode).toBe("");
  expect(saved?.phonePrivacy?.lockedUntil).toBeGreaterThan(Date.now());
  expect(saved?.relationship.recentEvents[0]).toContain("查看了手机");
 });
 it("keeps the passcode and sends one persona-shaped message after five failures",async()=>{
  const lockedUntil=Date.now()+PHONE_PASSCODE_LOCK_MS,character={...makeCharacter(true,35,50),phonePrivacy:{...makeCharacter(true).phonePrivacy!,failedAttempts:0,lockedUntil}};await db.characters.add(character);
  const result=await handlePhoneDiscovery({characterId:character.id,provider:{...provider,apiKey:""},reason:"passcode"});
  const saved=await db.characters.get(character.id),messages=await db.messages.toArray();
  expect(result.strategy).toBe(true);
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe("密码错了五次。手机锁五分钟。");
  expect(saved?.relationship).toMatchObject({trust:34,intimacy:50});
  expect(saved?.phonePrivacy).toMatchObject({passcode:"0427",hint:"离开旧城的日子",failedAttempts:0,lockedUntil});
  expect(saved?.relationship.recentEvents[0]).toContain("连续五次输错");
 });
 it("uses the provider reaction after five failures when the API succeeds",async()=>{
  const character={...makeCharacter(true,60,60),phonePrivacy:{...makeCharacter(true).phonePrivacy!,lockedUntil:Date.now()+PHONE_PASSCODE_LOCK_MS}};await db.characters.add(character);
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"message":"你连错五次，是在试探我吗？","mood":"警惕","event":"用户连续五次尝试手机密码"}'}}]}),{status:200,headers:{"Content-Type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
  const result=await handlePhoneDiscovery({characterId:character.id,provider,reason:"passcode"});
  expect(result.message.content).toBe("你连错五次，是在试探我吗？");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await db.messages.toArray())).toHaveLength(1);
 });});

