import {beforeEach,describe,expect,it} from "vitest";
import {createBackup,restoreBackup} from "./backup";
import {db} from "./db";
import {defaultAppSettings,defaultImageGenerationSettings,defaultSpeechSettings,type BackgroundTask} from "./types";

const staleTask:BackgroundTask={id:"stale",schemaVersion:1,createdAt:1,updatedAt:1,type:"chat-reply",entityId:"conversation",conversationId:"conversation",state:"running",scheduledAt:1,nextAttemptAt:1,attempts:1,leaseExpiresAt:999999,leaseOwnerId:"tab",leaseGeneration:5,eventId:"chat:stale",payload:{phase:"requesting"}};

describe("backup restore lifecycle",()=>{
 beforeEach(async()=>{await db.delete();await db.open()});
 it("removes pre-restore tasks and stale settings while preserving device API credentials",async()=>{await db.settings.bulkPut([{key:"provider",value:{baseUrl:"https://api.example/v1",apiKey:"provider-secret",model:"model",stream:false}},{key:"speech",value:{...defaultSpeechSettings,minimax:{...defaultSpeechSettings.minimax,apiKey:"speech-secret"}}},{key:"image-generation",value:{...defaultImageGenerationSettings,openai:{...defaultImageGenerationSettings.openai,apiKey:"image-secret"}}},{key:"obsolete-setting",value:"remove"},{key:"app",value:{...defaultAppSettings,onboarded:true}}]);const backup=await createBackup();await db.backgroundTasks.add(staleTask);await db.settings.put({key:"obsolete-setting",value:"still-remove"});await restoreBackup(backup);expect(await db.backgroundTasks.count()).toBe(0);expect((await db.settings.get("provider"))?.value).toMatchObject({apiKey:"provider-secret"});expect((await db.settings.get("speech"))?.value).toMatchObject({minimax:{apiKey:"speech-secret"}});expect((await db.settings.get("image-generation"))?.value).toMatchObject({openai:{apiKey:"image-secret"}});expect(await db.settings.get("obsolete-setting")).toBeUndefined()});
 it("rolls back business data and old tasks when backup insertion fails",async()=>{await db.characters.add({id:"current",schemaVersion:1,createdAt:1,updatedAt:1,name:"current"} as any);await db.backgroundTasks.add(staleTask);const backup=await createBackup();backup.data.characters.push({...backup.data.characters[0]});await expect(restoreBackup(backup)).rejects.toThrow();expect(await db.characters.get("current")).toBeTruthy();expect(await db.backgroundTasks.get("stale")).toBeTruthy()});

});
