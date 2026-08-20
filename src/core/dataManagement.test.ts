import {beforeEach,describe,expect,it} from "vitest";
import {clearGitHubCredentials,clearProviderKey,createBackup,factoryReset,restoreBackup} from "./backup";
import {db,getAppearance,getImageGenerationSettings,getProvider,setSetting} from "./db";
import {defaultAppSettings,defaultImageGenerationSettings,defaultProvider} from "./types";
import {defaultAppearance} from "./appearance";

describe("data management",()=>{
 beforeEach(async()=>{await db.delete();await db.open()});
 it("excludes all device credentials from backup",async()=>{
  await setSetting("provider",{...defaultProvider, networkMode: "direct" as const,apiKey:"secret-api"});
  await setSetting("github-backup",{token:"secret-github"});
  await setSetting("speech",{defaultProvider:"minimax",minimax:{enabled:true,apiKey:"secret-minimax",baseUrl:"x",model:"m",defaultVoiceId:"v",speed:1},elevenlabs:{enabled:true,apiKey:"secret-eleven",baseUrl:"x",model:"m",defaultVoiceId:"v",speed:1}});
  await setSetting("image-generation",{provider:"openai",openai:{enabled:true,apiKey:"secret-image-openai",baseUrl:"x",model:"m",size:"1024x1024",quality:"medium"},novelai:{enabled:true,apiKey:"secret-image-novelai",baseUrl:"x",model:"n",width:832,height:1216,sampler:"k_euler",steps:20,scale:5,negativePrompt:""}});
  const text=JSON.stringify(await createBackup());
  for(const secret of ["secret-api","secret-github","secret-minimax","secret-eleven","secret-image-openai","secret-image-novelai"])expect(text).not.toContain(secret);
 });
 it("restores product data while preserving provider, github and image generation secrets",async()=>{
  await setSetting("provider",{...defaultProvider, networkMode: "direct" as const,apiKey:"keep-api"});
  await setSetting("github-backup",{token:"keep-github"});
  await setSetting("image-generation",{...defaultImageGenerationSettings,provider:"novelai",openai:{...defaultImageGenerationSettings.openai,apiKey:"keep-openai"},novelai:{...defaultImageGenerationSettings.novelai,apiKey:"keep-novelai"}});
  const backup={schemaVersion:1,exportedAt:1,data:{characters:[],conversations:[],messages:[],presets:[],loreBooks:[],memories:[],feedPosts:[],imageGenerationSettings:{...defaultImageGenerationSettings,provider:"openai",openai:{...defaultImageGenerationSettings.openai,apiKey:"from-backup",model:"restored-model"},novelai:{...defaultImageGenerationSettings.novelai,apiKey:"from-backup-novel"}},appSettings:{...defaultAppSettings,onboarded:true}}};
  await restoreBackup(backup);
  expect((await getProvider()).apiKey).toBe("keep-api");
  expect((await db.settings.get("github-backup"))?.value).toEqual({token:"keep-github"});
  const images=await getImageGenerationSettings();
  expect(images.openai.apiKey).toBe("keep-openai");
  expect(images.novelai.apiKey).toBe("keep-novelai");
  expect(images.openai.model).toBe("restored-model");
 });
 it("restores legacy backups without image generation settings",async()=>{
  const backup={schemaVersion:1,exportedAt:1,data:{characters:[],conversations:[],messages:[],presets:[],loreBooks:[],memories:[],feedPosts:[],appSettings:{...defaultAppSettings,onboarded:true}}};
  await restoreBackup(backup);
  expect(await getImageGenerationSettings()).toEqual(defaultImageGenerationSettings);
 });
 it("clears credentials independently",async()=>{
  await setSetting("provider",{...defaultProvider, networkMode: "direct" as const,apiKey:"api"});
  await setSetting("github-backup",{token:"gh"});
  await clearProviderKey();
  expect((await getProvider()).apiKey).toBe("");
  expect(await db.settings.get("github-backup")).toBeTruthy();
  await clearGitHubCredentials();
  expect(await db.settings.get("github-backup")).toBeUndefined();
 });
 it("factory reset clears all data, image settings and returns to onboarding",async()=>{
  await db.characters.add({id:"c",name:"x"} as any);
  await setSetting("provider",{...defaultProvider, networkMode: "direct" as const,apiKey:"api"});
  await setSetting("github-backup",{token:"gh"});
  await setSetting("image-generation",{...defaultImageGenerationSettings,openai:{...defaultImageGenerationSettings.openai,apiKey:"image-key"}});
  await factoryReset();
  expect(await db.characters.count()).toBe(0);
  expect(await db.settings.get("provider")).toBeUndefined();
  expect(await db.settings.get("github-backup")).toBeUndefined();
  expect(await db.settings.get("image-generation")).toBeUndefined();
  expect((await db.settings.get("app"))?.value).toMatchObject({onboarded:false});
 });
 it("excludes legacy feed memory batches and cursors from backup and restore",async()=>{
  const chatBatch={id:"chat-batch",characterId:"c",conversationId:"v",source:"chat",sourceIds:["m"],cursorKey:"c:chat:v",status:"pending",candidates:[],createdAt:1,updatedAt:1};
  const feedBatch={id:"feed-batch",characterId:"c",source:"feed",sourceIds:["p"],cursorKey:"c:feed:all",status:"pending",candidates:[],createdAt:1,updatedAt:1};
  await db.memoryExtractionBatches.bulkAdd([chatBatch,feedBatch] as any);
  await db.memoryExtractionCursors.bulkAdd([{key:"c:chat:v",lastSourceId:"m",updatedAt:1},{key:"c:feed:all",lastSourceId:"p",updatedAt:1}]);
  const exported=await createBackup();
  expect(exported.data.memoryExtractionBatches.map(batch=>batch.source)).toEqual(["chat"]);
  expect(exported.data.memoryExtractionCursors.map(cursor=>cursor.key)).toEqual(["c:chat:v"]);
  const backup={schemaVersion:1,exportedAt:1,data:{characters:[],conversations:[],messages:[],presets:[],loreBooks:[],memories:[],feedPosts:[],memoryExtractionBatches:[chatBatch,feedBatch],memoryExtractionCursors:[{key:"c:chat:v",lastSourceId:"m",updatedAt:1},{key:"c:feed:all",lastSourceId:"p",updatedAt:1}],appSettings:{...defaultAppSettings,onboarded:true}}};
  await restoreBackup(backup);
  expect((await db.memoryExtractionBatches.toArray()).map(batch=>batch.source)).toEqual(["chat"]);
  expect((await db.memoryExtractionCursors.toArray()).map(cursor=>cursor.key)).toEqual(["c:chat:v"]);
 }); it("round trips a custom feed cover and its local image asset",async()=>{
  const asset={id:"feed-cover",createdAt:1,updatedAt:1,purpose:"feed-cover",mimeType:"image/webp",width:1200,height:600,data:"data:image/webp;base64,AA=="};
  await db.imageAssets.add(asset as any);
  await setSetting("appearance",{...defaultAppearance,feedCover:{type:"asset",value:asset.id}});
  const backup=await createBackup();
  expect(backup.data.appearance.feedCover).toEqual({type:"asset",value:"feed-cover"});
  expect(backup.data.imageAssets.some(image=>image.id==="feed-cover")).toBe(true);
  await db.imageAssets.clear();
  await setSetting("appearance",defaultAppearance);
  await restoreBackup(backup);
  expect((await getAppearance()).feedCover).toEqual({type:"asset",value:"feed-cover"});
  expect(await db.imageAssets.get("feed-cover")).toBeTruthy();
 });});