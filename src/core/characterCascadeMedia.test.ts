import {beforeEach,describe,expect,it} from "vitest";
import {deleteCharacterCascade} from "./backup";
import {db} from "./db";

describe("character cascade media cleanup",()=>{
 beforeEach(async()=>{await db.delete();await db.open()});
 it("removes orphaned feed and reference images but keeps shared assets",async()=>{
  const t=Date.now();
  await db.mediaAssets.bulkAdd([
   {id:"post-only",createdAt:t,updatedAt:t,purpose:"feed-image",mimeType:"image/png",sizeBytes:10,data:"data:image/png;base64,AA=="},
   {id:"reference-only",createdAt:t,updatedAt:t,purpose:"feed-reference",mimeType:"image/png",sizeBytes:10,data:"data:image/png;base64,AA=="},
   {id:"shared",createdAt:t,updatedAt:t,purpose:"feed-image",mimeType:"image/png",sizeBytes:10,data:"data:image/png;base64,AA=="}
  ] as any);
  await db.characters.bulkAdd([
   {id:"deleted",name:"Deleted",chatSettings:{feedImage:{enabled:true,referenceAssetId:"reference-only"}}},
   {id:"kept",name:"Kept",chatSettings:{feedImage:{enabled:true,referenceAssetId:"shared"}}}
  ] as any);
  await db.feedPosts.add({id:"post",authorId:"deleted",createdAt:t,updatedAt:t,content:"test",comments:[],images:[{id:"one",source:"asset",assetId:"post-only"},{id:"two",source:"asset",assetId:"shared"}]} as any);
  await deleteCharacterCascade("deleted");
  expect(await db.mediaAssets.get("post-only")).toBeUndefined();
  expect(await db.mediaAssets.get("reference-only")).toBeUndefined();
  expect(await db.mediaAssets.get("shared")).toBeTruthy();
 });
});
describe("character cascade forum compatibility",()=>{
 beforeEach(async()=>{await db.delete();await db.open()});
 it("removes forum membership, quotas, and authored character posts",async()=>{const t=Date.now();await db.characters.add({id:"deleted",name:"Deleted"} as any);await db.forumServers.add({id:"forum",schemaVersion:1,createdAt:t,updatedAt:t,name:"Forum",description:"",iconText:"F",color:"#777",order:0,characterIds:["deleted","kept"],activitySettings:{enabled:true,intervalHours:24,postsPerRun:10,repliesPerRun:20,characterQuotas:{deleted:{enabled:true,postsPerRun:3,repliesPerRun:4},kept:{enabled:true,postsPerRun:1,repliesPerRun:1}}}} as any);await db.forumChannels.add({id:"channel",schemaVersion:1,createdAt:t,updatedAt:t,serverId:"forum",name:"General",topic:"",kind:"forum",order:0} as any);await db.forumPosts.add({id:"history",schemaVersion:1,createdAt:t,updatedAt:t,channelId:"channel",authorType:"character",authorId:"deleted",authorName:"Deleted",title:"Old post",content:"History remains",tags:[],pinned:false,reactions:[],replies:[],lastActivityAt:t} as any);await deleteCharacterCascade("deleted");const forum=await db.forumServers.get("forum");expect(forum?.characterIds).toEqual(["kept"]);expect(forum?.activitySettings?.characterQuotas).not.toHaveProperty("deleted");expect(forum?.activitySettings?.characterQuotas).toHaveProperty("kept");expect(await db.forumPosts.get("history")).toBeUndefined()});
});