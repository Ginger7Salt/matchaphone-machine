import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {db,setSetting} from "./db";
import {
 clearModelServiceKeys,
 describeImageWithVision,
 getModelServiceSettings,
 normalizeModelServiceSettings,
 resolveSecondaryProvider,
 saveModelServiceSettings
} from "./modelServices";
import {defaultModelServiceSettings,defaultProvider} from "./types";

afterEach(()=>vi.unstubAllGlobals());
describe("dedicated model services",()=>{
 beforeEach(async()=>{await db.delete();await db.open()});
 it("normalizes legacy partial settings",()=>{
  const normalized=normalizeModelServiceSettings({secondary:{enabled:true,provider:{apiKey:" key ",model:" helper "}},vision:{instruction:""}});
  expect(normalized.secondary.enabled).toBe(true);
  expect(normalized.secondary.provider).toMatchObject({apiKey:"key",model:"helper",stream:false,networkMode:"direct"});
  expect(normalized.vision.instruction).toBe(defaultModelServiceSettings.vision.instruction);
 });
 it("resolves the secondary provider independently and falls back when disabled",async()=>{
  const secondary={...defaultProvider, networkMode: "direct" as const,baseUrl:"https://secondary.example/v1",apiKey:"secondary-key",model:"helper"};
  await saveModelServiceSettings({...defaultModelServiceSettings,secondary:{enabled:true,provider:secondary}});
  expect(await resolveSecondaryProvider({...defaultProvider, networkMode: "direct" as const,apiKey:"main-key",model:"main"})).toMatchObject({apiKey:"secondary-key",model:"helper"});
  await setSetting("model-services-v1",{...defaultModelServiceSettings,secondary:{enabled:false,provider:secondary}});
  expect(await resolveSecondaryProvider({...defaultProvider, networkMode: "direct" as const,apiKey:"main-key",model:"main"})).toMatchObject({apiKey:"main-key",model:"main"});
 });
 it("clears dedicated keys without removing the service configuration",async()=>{
  await saveModelServiceSettings({...defaultModelServiceSettings,secondary:{enabled:true,provider:{...defaultProvider, networkMode: "direct" as const,apiKey:"secondary",model:"helper"}},vision:{...defaultModelServiceSettings.vision,enabled:true,provider:{...defaultProvider, networkMode: "direct" as const,apiKey:"vision",model:"vision"}}});
  const cleared=await clearModelServiceKeys();
  expect(cleared.secondary).toMatchObject({enabled:true,provider:{apiKey:"",model:"helper"}});
  expect(cleared.vision).toMatchObject({enabled:true,provider:{apiKey:"",model:"vision"}});
 });
 it("uses the configured vision provider and sends the image as vision input",async()=>{
  await saveModelServiceSettings({...defaultModelServiceSettings,vision:{...defaultModelServiceSettings.vision,enabled:true,provider:{...defaultProvider, networkMode: "direct" as const,baseUrl:"https://vision.example/v1",apiKey:"vision-key",model:"vision-model"}}});
  const fetchMock=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({choices:[{message:{content:"一只白色杯子放在桌上。"}}]}),{status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetchMock);
  await expect(describeImageWithVision("data:image/png;base64,aGVsbG8=","用户说这是礼物")).resolves.toBe("一只白色杯子放在桌上。");
  const [url,init]=fetchMock.mock.calls[0];
  expect(String(url)).toBe("https://vision.example/v1/chat/completions");
  const body=JSON.parse(String(init?.body));
  expect(body.model).toBe("vision-model");
  expect(body.messages[1].content.some((part:any)=>part.type==="image_url")).toBe(true);
 });
 it("returns undefined when vision is disabled",async()=>{
  expect(await getModelServiceSettings()).toEqual(defaultModelServiceSettings);
  await expect(describeImageWithVision("data:image/png;base64,aGVsbG8=")).resolves.toBeUndefined();
 });
});