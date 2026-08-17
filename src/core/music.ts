import { db, getSetting, setSetting } from "./db";
import { invitationResponseBubbleCountPlan, invitationResponseTask } from "./invitationResponseTaskModel";

import { pauseActiveMeetForOnlineActivity } from "./crossModeContinuity";
import { rewardIslandListening } from "./coupleIsland";
import {now,SCHEMA_VERSION,uid,type CharacterMusicAction,type ListeningContext,type ListeningSession,type Message,type MusicAccountProfile,type MusicClientSettings,type MusicEvent,type MusicEventType,type MusicFile,type MusicPlaylist,type MusicTrack} from "./types";
import { buildMusicDjCandidates, characterDjSettings, createListeningSummary, createMusicControlProposal, normalizeListeningQueueEntries, queueListeningTrack, searchTrackForCharacter } from "./musicDj";

const MUSIC_GATEWAY_ORIGIN = "https://matchaphone-d5gjgy87ybfb50382-1463048417.ap-shanghai.app.tcloudbase.com";
export const MUSIC_API_BASE = typeof location !== "undefined" && /tcloudbaseapp\.com$/i.test(location.hostname) ? MUSIC_GATEWAY_ORIGIN + "/api/music" : "/api/music";
export const MAX_MUSIC_FILE_BYTES=200*1024*1024;
export const defaultMusicClientSettings:MusicClientSettings={backgroundPlayback:true,volume:.85,repeatMode:"off",shuffle:false,lyricsTranslationVisible:true,lyricsFontSize:"medium"};

export class MusicApiError extends Error{constructor(public code:string,message:string,public status=0,public details?:unknown){super(message);this.name="MusicApiError"}}
const MUSIC_SESSION_HANDLE_KEY="mira-music-session-handle";
const validMusicSessionHandle=(value:unknown)=>typeof value==="string"&&/^[A-Za-z0-9_-]{32,128}$/.test(value)?value:undefined;
export function getMusicSessionHandle(){if(typeof localStorage==="undefined")return;try{return validMusicSessionHandle(localStorage.getItem(MUSIC_SESSION_HANDLE_KEY))}catch{return}}
export function clearMusicSessionHandle(){if(typeof localStorage==="undefined")return;try{localStorage.removeItem(MUSIC_SESSION_HANDLE_KEY)}catch{}}
function saveMusicSessionHandle(value:unknown){const handle=validMusicSessionHandle(value);if(!handle||typeof localStorage==="undefined")return;try{localStorage.setItem(MUSIC_SESSION_HANDLE_KEY,handle)}catch{}}
async function api<T>(path:string,init?:RequestInit):Promise<T>{
 const headers=new Headers(init?.headers);
 if(init?.body&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");
 const sessionHandle=getMusicSessionHandle();
 if(sessionHandle&&!headers.has("Authorization"))headers.set("Authorization",`Bearer ${sessionHandle}`);
 const response=await fetch(MUSIC_API_BASE+path,{...init,credentials:"include",headers});
 const raw=await response.json().catch(()=>({}));
 if(!response.ok){if(response.status===401&&String(raw?.code??"")==="login_required")clearMusicSessionHandle();throw new MusicApiError(String(raw?.code??"request"),String(raw?.message??`音乐服务请求失败：${response.status}`),response.status,raw?.details)}
 return raw as T;
}

export const getMusicClientSettings=async()=>({...defaultMusicClientSettings,...await getSetting<Partial<MusicClientSettings>>("music-client",defaultMusicClientSettings)} satisfies MusicClientSettings);
export const saveMusicClientSettings=(value:MusicClientSettings)=>setSetting("music-client",value);
export async function getMusicAccount(){const result=await api<{authenticated:boolean;profile?:MusicAccountProfile}>("/auth/session");if(!result.authenticated)clearMusicSessionHandle();return result}
export type MusicCapabilityName="search"|"playlists"|"lyrics"|"stream";
export interface MusicCapabilities{authenticated:boolean;search:boolean;playlists:boolean;lyrics:boolean;stream:boolean;reasons?:Partial<Record<MusicCapabilityName,string>>}
export const emptyMusicCapabilities:MusicCapabilities={authenticated:false,search:false,playlists:false,lyrics:false,stream:false,reasons:{}};
export const fetchMusicCapabilities=(refresh=false)=>api<MusicCapabilities>(`/capabilities${refresh?"?refresh=1":""}`);
export async function createMusicLoginQr(signal?:AbortSignal){const result=await api<{key:string;qrUrl:string;qrImage?:string;expiresAt:number;sessionHandle?:string}>("/auth/qr",{method:"POST",signal});saveMusicSessionHandle(result.sessionHandle);return result}
export const pollMusicLoginQr=(key:string,signal?:AbortSignal)=>api<{status:"waiting"|"scanned"|"authorized"|"expired";profile?:MusicAccountProfile}>(`/auth/qr/status?key=${encodeURIComponent(key)}`,{signal});
export async function logoutMusicAccount(){try{return await api<{ok:true}>("/auth/logout",{method:"POST"})}finally{clearMusicSessionHandle()}}

export interface MusicSearchResult{tracks:MusicTrack[];total:number}
export async function searchNeteaseMusic(query:string,offset=0,limit=30){return api<MusicSearchResult>(`/search?q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`)}
export async function fetchNeteasePlaylists(){return api<{playlists:MusicPlaylist[]}>("/me/playlists")}
export async function fetchNeteasePlaylist(externalId:string){return api<{playlist:MusicPlaylist;tracks:MusicTrack[]}>(`/playlists/${encodeURIComponent(externalId)}`)}
export async function resolveNeteaseShareLink(url:string){return api<{kind:"track"|"playlist"|"album";tracks:MusicTrack[];playlist?:MusicPlaylist}>("/resolve",{method:"POST",body:JSON.stringify({url})})}
export async function fetchNeteaseStream(externalId:string){return api<{url?:string;expiresAt?:number;reason?:string;openUrl?:string}>(`/tracks/${encodeURIComponent(externalId)}/stream`)}
export async function fetchNeteaseLyrics(externalId:string){return api<{lrc?:string;translatedLrc?:string}>(`/tracks/${encodeURIComponent(externalId)}/lyrics`)}
export async function reportMusicPlayback(externalId:string,event:"start"|"progress"|"complete",positionMs:number){try{await api("/playback/report",{method:"POST",body:JSON.stringify({externalId,event,positionMs})})}catch{/* playback reporting never blocks listening */}}

export async function upsertMusicTracks(tracks:MusicTrack[]){if(!tracks.length)return;const t=now();await db.musicTracks.bulkPut(tracks.map(track=>({...track,schemaVersion:SCHEMA_VERSION,libraryStatus:track.libraryStatus??"saved",updatedAt:t,createdAt:track.createdAt??t,importedAt:track.importedAt??t})));if(typeof window!=="undefined")window.dispatchEvent(new Event("mira:music-library-changed"))}
export async function importNeteasePlaylist(externalId:string){const result=await fetchNeteasePlaylist(externalId),t=now();await db.transaction("rw",[db.musicTracks,db.musicPlaylists],async()=>{await db.musicTracks.bulkPut(result.tracks.map(track=>({...track,schemaVersion:SCHEMA_VERSION,createdAt:track.createdAt??t,updatedAt:t,importedAt:track.importedAt??t})));await db.musicPlaylists.put({...result.playlist,schemaVersion:SCHEMA_VERSION,createdAt:result.playlist.createdAt??t,updatedAt:t,syncedAt:t,trackIds:result.tracks.map(track=>track.id)})});window.dispatchEvent(new Event("mira:music-library-changed"));return result.playlist}

async function blobDataUrl(blob:Blob){return await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob)})}
function decodeText(bytes:Uint8Array,encoding:number){try{if(encoding===0)return new TextDecoder("latin1").decode(bytes).replace(/\0/g,"").trim();if(encoding===3)return new TextDecoder("utf-8").decode(bytes).replace(/\0/g,"").trim();if(encoding===1||encoding===2){const little=encoding===1&&bytes[0]===0xff&&bytes[1]===0xfe,start=encoding===1?2:0;return new TextDecoder(little?"utf-16le":"utf-16be").decode(bytes.slice(start)).replace(/\0/g,"").trim()}}catch{}return""}
function synchsafe(bytes:Uint8Array,offset:number){return((bytes[offset]&127)<<21)|((bytes[offset+1]&127)<<14)|((bytes[offset+2]&127)<<7)|(bytes[offset+3]&127)}
async function readId3(file:File){const data=new Uint8Array(await file.slice(0,Math.min(file.size,2*1024*1024)).arrayBuffer()),meta:{title?:string;artist?:string;album?:string;coverUrl?:string}={};if(data.length<10||String.fromCharCode(...data.slice(0,3))!=="ID3")return meta;const end=Math.min(data.length,10+synchsafe(data,6));for(let pos=10;pos+10<=end;){const id=String.fromCharCode(...data.slice(pos,pos+4));const size=((data[pos+4]<<24)>>>0)+(data[pos+5]<<16)+(data[pos+6]<<8)+data[pos+7];if(!id.trim()||size<=0||pos+10+size>end)break;const body=data.slice(pos+10,pos+10+size);if(["TIT2","TPE1","TALB"].includes(id)&&body.length>1){const text=decodeText(body.slice(1),body[0]);if(id==="TIT2")meta.title=text;if(id==="TPE1")meta.artist=text;if(id==="TALB")meta.album=text}else if(id==="APIC"&&body.length>5){let cursor=1;while(cursor<body.length&&body[cursor]!==0)cursor++;const mime=decodeText(body.slice(1,cursor),0)||"image/jpeg";cursor+=2;while(cursor<body.length&&body[cursor]!==0)cursor++;cursor++;const image=body.slice(cursor);if(image.length)meta.coverUrl=await blobDataUrl(new Blob([image],{type:mime}))}pos+=10+size}return meta}
async function readDuration(file:File){const url=URL.createObjectURL(file);try{return await new Promise<number|undefined>(resolve=>{const audio=new Audio(),timer=window.setTimeout(()=>resolve(undefined),5000);audio.preload="metadata";audio.onloadedmetadata=()=>{clearTimeout(timer);resolve(Number.isFinite(audio.duration)?Math.round(audio.duration*1000):undefined)};audio.onerror=()=>{clearTimeout(timer);resolve(undefined)};audio.src=url})}finally{URL.revokeObjectURL(url)}}
function nameParts(name:string){const clean=name.replace(/\.[^.]+$/,"").trim();const split=clean.split(/\s+-\s+/);return split.length>1?{artist:split[0],title:split.slice(1).join(" - ")}:{title:clean}}
export async function ensureMusicStorage(files:File[]){for(const file of files)if(file.size>MAX_MUSIC_FILE_BYTES)throw new Error(`${file.name} 超过 200MB`);const required=files.reduce((sum,file)=>sum+file.size,0),estimate=await navigator.storage?.estimate?.();if(estimate?.quota&&estimate?.usage!==undefined&&estimate.quota-estimate.usage<required*1.1)throw new Error("设备存储空间不足");try{await navigator.storage?.persist?.()}catch{/* optional */}}
export async function importMusicFiles(files:File[]){await ensureMusicStorage(files);const imported:MusicTrack[]=[],knownFiles=await db.musicFiles.toArray();for(const file of files){const duplicateFile=knownFiles.find(item=>item.name===file.name&&item.sizeBytes===file.size);if(duplicateFile){const duplicateTrack=(await db.musicTracks.toArray()).find(item=>item.localFileId===duplicateFile.id);if(duplicateTrack){imported.push(duplicateTrack);continue}}const playable=Boolean(document.createElement("audio").canPlayType(file.type||"audio/mpeg"));if(!playable)throw new Error(`当前浏览器不支持播放 ${file.name}`);const [meta,durationMs]=await Promise.all([readId3(file),readDuration(file)]),fallback=nameParts(file.name),t=now(),fileId=uid(),trackId=uid();const stored:MusicFile={id:fileId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,name:file.name,mimeType:file.type||"audio/mpeg",sizeBytes:file.size,blob:file};const track:MusicTrack={id:trackId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,importedAt:t,libraryStatus:"saved",source:"local-file",title:meta.title||fallback.title,artists:[meta.artist||fallback.artist||"未知歌手"],album:meta.album,coverUrl:meta.coverUrl,durationMs,localFileId:fileId};await db.transaction("rw",[db.musicFiles,db.musicTracks],async()=>{await db.musicFiles.add(stored);await db.musicTracks.add(track)});knownFiles.push(stored);imported.push(track)}emitMusicLibraryChanged();return imported}
export async function importDirectMusicUrl(url:string,title?:string){const parsed=new URL(url);if(!["http:","https:"].includes(parsed.protocol))throw new Error("仅支持 http/https 音频链接");const existing=(await db.musicTracks.toArray()).find(item=>item.source==="direct-url"&&item.directUrl===url);if(existing)return existing;const t=now(),track:MusicTrack={id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,importedAt:t,libraryStatus:"saved",source:"direct-url",title:title?.trim()||decodeURIComponent(parsed.pathname.split("/").pop()||"网络歌曲").replace(/\.[^.]+$/,"")||"网络歌曲",artists:["网络来源"],directUrl:url};await db.musicTracks.add(track);if(typeof window!=="undefined")window.dispatchEvent(new Event("mira:music-library-changed"));return track}
export async function importMusicLink(url:string){if(/(?:music\.163\.com|163cn.tv)/i.test(url)){const resolved=await resolveNeteaseShareLink(url);if(resolved.kind!=="track"||resolved.tracks.length!==1)throw new Error("当前仅支持导入网易云单曲链接");const tracks=resolved.tracks.map(track=>({...track,libraryStatus:"saved" as const}));await upsertMusicTracks(tracks);return tracks}return[await importDirectMusicUrl(url)]}
function emitMusicLibraryChanged(){if(typeof window!=="undefined")window.dispatchEvent(new Event("mira:music-library-changed"))}
export function isMusicTrackSaved(track:MusicTrack){return track.libraryStatus!=="temporary"}
export async function saveMusicTrackToLibrary(trackId:string){const track=await db.musicTracks.get(trackId);if(!track)throw new Error("歌曲不存在");await db.musicTracks.update(trackId,{libraryStatus:"saved",updatedAt:now()});emitMusicLibraryChanged()}
export async function setMusicTrackFavorite(trackId:string,favorite:boolean){const track=await db.musicTracks.get(trackId);if(!track)throw new Error("歌曲不存在");await db.musicTracks.update(trackId,{favorite,libraryStatus:favorite?"saved":track.libraryStatus,updatedAt:now()});emitMusicLibraryChanged()}
export async function recordMusicTrackPlayed(trackId:string,playedAt=now()){const track=await db.musicTracks.get(trackId);if(!track)return;await db.musicTracks.update(trackId,{lastPlayedAt:playedAt,playCount:(track.playCount??0)+1,updatedAt:playedAt});emitMusicLibraryChanged()}
export type MusicTrackMetadataPatch=Partial<Pick<MusicTrack,"title"|"artists"|"album"|"coverUrl">>;
export async function updateMusicTrackMetadata(trackId:string,patch:MusicTrackMetadataPatch){const track=await db.musicTracks.get(trackId);if(!track)throw new Error("歌曲不存在");const title=patch.title?.trim()??track.title,artists=patch.artists?.map(item=>item.trim()).filter(Boolean)??track.artists;if(!title)throw new Error("歌曲名称不能为空");if(!artists.length)throw new Error("至少填写一位歌手");await db.musicTracks.update(trackId,{...patch,title,artists,libraryStatus:"saved",updatedAt:now()});emitMusicLibraryChanged();return db.musicTracks.get(trackId)}
export async function musicCoverDataUrl(file:File){if(!file.type.startsWith("image/"))throw new Error("请选择图片文件");if(file.size>5*1024*1024)throw new Error("封面图片不能超过 5MB");const original=await blobDataUrl(file);if(typeof Image==="undefined"||typeof document==="undefined")return original;try{return await new Promise<string>((resolve,reject)=>{const image=new Image();image.onload=()=>{const max=1024,scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));if(scale===1){resolve(original);return}const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext("2d");if(!context){resolve(original);return}context.drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL(file.type==="image/png"?"image/png":"image/jpeg",.88))};image.onerror=()=>reject(new Error("无法读取封面图片"));image.src=original})}catch{return original}}
export async function setMusicTrackLyrics(trackId:string,lyrics:string,kind:"lrc"|"plain",translatedLyrics=""){const track=await db.musicTracks.get(trackId);if(!track)throw new Error("歌曲不存在");if(!lyrics.trim())throw new Error("歌词内容不能为空");await db.musicTracks.update(trackId,{customLyrics:lyrics,customTranslatedLyrics:translatedLyrics||undefined,lyricsKind:kind,libraryStatus:"saved",updatedAt:now()});emitMusicLibraryChanged()}
export async function clearMusicTrackLyrics(trackId:string){await db.musicTracks.update(trackId,{customLyrics:undefined,customTranslatedLyrics:undefined,lyricsKind:undefined,updatedAt:now()});emitMusicLibraryChanged()}
export async function createLocalMusicPlaylist(name:string,trackIds:string[]=[]){const value=name.trim();if(!value)throw new Error("歌单名称不能为空");const t=now(),playlist:MusicPlaylist={id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,source:"local",name:value,trackIds:[...new Set(trackIds)]};await db.musicPlaylists.add(playlist);emitMusicLibraryChanged();return playlist}
export async function renameLocalMusicPlaylist(id:string,name:string){const playlist=await db.musicPlaylists.get(id);if(!playlist||playlist.source!=="local")throw new Error("本地歌单不存在");const value=name.trim();if(!value)throw new Error("歌单名称不能为空");await db.musicPlaylists.update(id,{name:value,updatedAt:now()});emitMusicLibraryChanged()}
export async function deleteLocalMusicPlaylist(id:string){const playlist=await db.musicPlaylists.get(id);if(!playlist||playlist.source!=="local")throw new Error("只能删除本地歌单");await db.musicPlaylists.delete(id);emitMusicLibraryChanged()}
export async function updateLocalMusicPlaylistTracks(id:string,trackIds:string[]){const playlist=await db.musicPlaylists.get(id);if(!playlist||playlist.source!=="local")throw new Error("本地歌单不存在");await db.musicPlaylists.update(id,{trackIds:[...new Set(trackIds)],updatedAt:now()});emitMusicLibraryChanged()}
export async function addTracksToLocalPlaylist(id:string,trackIds:string[]){const playlist=await db.musicPlaylists.get(id);if(!playlist||playlist.source!=="local")throw new Error("本地歌单不存在");return updateLocalMusicPlaylistTracks(id,[...playlist.trackIds,...trackIds])}
export async function removeTrackFromLocalPlaylist(id:string,trackId:string){const playlist=await db.musicPlaylists.get(id);if(!playlist||playlist.source!=="local")throw new Error("本地歌单不存在");return updateLocalMusicPlaylistTracks(id,playlist.trackIds.filter(item=>item!==trackId))}
export async function deleteMusicTrack(trackId:string){const track=await db.musicTracks.get(trackId);if(!track)return;const active=await db.listeningSessions.where("state").equals("active").first();if(active?.currentTrackId===trackId)throw new Error("该歌曲正在一起听中，请先结束一起听");const playlists=await db.musicPlaylists.toArray(),sessions=await db.listeningSessions.toArray();await db.transaction("rw",[db.musicTracks,db.musicFiles,db.musicPlaylists,db.listeningSessions],async()=>{for(const playlist of playlists)if(playlist.trackIds.includes(trackId))await db.musicPlaylists.update(playlist.id,{trackIds:playlist.trackIds.filter(id=>id!==trackId),updatedAt:now()});for(const session of sessions)if(session.queue.includes(trackId))await db.listeningSessions.update(session.id,{queue:session.queue.filter(id=>id!==trackId),currentTrackId:session.currentTrackId===trackId?undefined:session.currentTrackId,playbackState:session.currentTrackId===trackId?"paused":session.playbackState,updatedAt:now()});await db.musicTracks.delete(trackId);if(track.localFileId)await db.musicFiles.delete(track.localFileId)});emitMusicLibraryChanged()}

export interface ParsedLyricLine{timeMs:number;text:string;translation?:string}
export function parseLrc(lrc="",translatedLrc=""){const parse=(value:string)=>{const rows:{timeMs:number;text:string}[]=[];for(const line of value.split(/\r?\n/)){const tags=[...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];const text=line.replace(/\[[^\]]+\]/g,"").trim();for(const tag of tags){const frac=String(tag[3]??"0").padEnd(3,"0").slice(0,3);rows.push({timeMs:Number(tag[1])*60000+Number(tag[2])*1000+Number(frac),text})}}return rows.sort((a,b)=>a.timeMs-b.timeMs)};const base=parse(lrc),translated=parse(translatedLrc),map=new Map(translated.map(row=>[row.timeMs,row.text]));return base.map(row=>({...row,translation:map.get(row.timeMs)}))}
export function lyricWindow(lines:ParsedLyricLine[],positionMs:number,radius=2){if(!lines.length)return[];let index=0;for(let i=0;i<lines.length;i++){if(lines[i].timeMs<=positionMs)index=i;else break}return lines.slice(Math.max(0,index-radius),Math.min(lines.length,index+radius+1)).flatMap(line=>line.translation?[line.text,line.translation]:[line.text]).filter(Boolean)}

export async function createListeningSession(input: {
  conversationId: string;
  characterId: string;
  invitedBy: "user" | "character";
  trackId?: string;
  queue?: string[];
  invitationMessageId?: string;
}) {
  const t = now();
  const session: ListeningSession = {
    id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t, startedAt: t,
    conversationId: input.conversationId, characterId: input.characterId, state: "invited",
    invitedBy: input.invitedBy, invitationMessageId: input.invitationMessageId,
    currentTrackId: input.trackId, queue: input.queue ?? (input.trackId ? [input.trackId] : []),
    queueEntries: (input.queue ?? (input.trackId ? [input.trackId] : [])).map((trackId) => ({ trackId, selectedBy: input.invitedBy, addedAt: t })),
    currentIndex: 0, playbackState: "paused", positionMs: 0, selectedBy: input.invitedBy, totalListenedMs: 0, djTurnCount: 0,
  };
  const existing = await db.listeningSessions.where("state").anyOf("invited", "active").toArray();
  for (const current of existing) await endListeningSession(current.id, "system");
  await db.transaction("rw", [db.listeningSessions, db.musicEvents], async () => {
    await db.listeningSessions.add(session);
    await addMusicEvent(session, "invite", input.invitedBy, input.trackId);
  });
  return session;
}

export async function addMusicEvent(session: ListeningSession, type: MusicEventType, actor: "user" | "character" | "system", trackId?: string, positionMs?: number, detail?: string) {
  const t = now();
  const event: MusicEvent = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t, sessionId: session.id, conversationId: session.conversationId, characterId: session.characterId, type, actor, trackId, positionMs, detail };
  await db.musicEvents.add(event);
  return event;
}

export async function updateListeningPlayback(sessionId: string, patch: Partial<Pick<ListeningSession, "state" | "currentTrackId" | "queue" | "queueEntries" | "currentIndex" | "playbackState" | "positionMs" | "selectedBy" | "totalListenedMs" | "djTurnCount">>, eventType?: MusicEventType, actor: "user" | "character" | "system" = "user") {
  const session = await db.listeningSessions.get(sessionId);
  if (!session) return;
  const delta = patch.positionMs !== undefined && (patch.currentTrackId ?? session.currentTrackId) === session.currentTrackId && session.playbackState === "playing" ? patch.positionMs - session.positionMs : 0;
  const next = { ...patch, totalListenedMs: patch.totalListenedMs ?? ((session.totalListenedMs ?? 0) + (delta > 0 && delta <= 15000 ? delta : 0)), updatedAt: now() };
  await db.transaction("rw", [db.listeningSessions, db.musicEvents], async () => {
    await db.listeningSessions.update(sessionId, next);
    if (eventType) await addMusicEvent({ ...session, ...next }, eventType, actor, patch.currentTrackId ?? session.currentTrackId, patch.positionMs);
  });
  return { ...session, ...next };
}

export async function endListeningSession(sessionId: string, actor: "user" | "character" | "system" = "user") {
  const session = await db.listeningSessions.get(sessionId);
  if (!session || session.state === "ended") return;
  const t = now();
  await db.transaction("rw", [db.listeningSessions, db.musicEvents, db.messages], async () => {
    await db.listeningSessions.update(sessionId, { state: "ended", endedAt: t, updatedAt: t, playbackState: "paused" });
    if (session.invitationMessageId) {
      const message = await db.messages.get(session.invitationMessageId);
      if (message) await db.messages.update(message.id, { updatedAt: t, attachments: message.attachments?.map((item) => item.type === "music-invitation" ? { ...item, state: "ended" as const, processedAt: t } : item) });
    }
    await addMusicEvent(session, "leave", actor, session.currentTrackId, session.positionMs);
  });
  if (session.state === "active") { await createListeningSummary(session.id); await rewardIslandListening(session.characterId, session.id, session.conversationId); }
}

export async function currentListeningSession(conversationId?: string) {
  const rows = await db.listeningSessions.where("state").anyOf("invited", "active").toArray();
  return rows.filter((row) => !conversationId || row.conversationId === conversationId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
export async function activeListeningSession(conversationId?: string) { const session = await currentListeningSession(conversationId); return session?.state === "active" ? session : undefined; }

export async function buildListeningContext(conversationId: string, positionMs?: number, lines: ParsedLyricLine[] = []): Promise<ListeningContext | undefined> {
  const session = await currentListeningSession(conversationId);
  if (!session || session.state === "ended") return;
  const [track, recentEvents, candidates] = await Promise.all([session.currentTrackId ? db.musicTracks.get(session.currentTrackId) : undefined, db.musicEvents.where("sessionId").equals(session.id).toArray(), buildMusicDjCandidates(session.characterId)]);
  return { sessionId: session.id, state: session.state, track, positionMs: positionMs ?? session.positionMs, playbackState: session.playbackState, selectedBy: session.selectedBy, lyricWindow: lyricWindow(lines, positionMs ?? session.positionMs), recentEvents: recentEvents.sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).reverse(), candidates };
}

export function listeningContextPrompt(context?: ListeningContext) {
  if (!context) return "";
  const track = context.track;
  const events = context.recentEvents.map((event) => `- ${event.actor}: ${event.type}${event.detail ? `（${event.detail}）` : ""}`).join("\n");
  const candidates = (context.candidates ?? []).map((item) => `- ${item.id} | ${item.title} - ${item.artists.join(" / ")}${item.favorite ? " | 用户收藏" : ""}`).join("\n");
  return ["【一起听实时状态】", context.state === "invited" ? "当前存在待处理的一起听邀请。" : "当前正在一起听。", track ? `当前歌曲：${track.title} - ${track.artists.join(" / ")}${track.album ? `，专辑：${track.album}` : ""}；歌曲 ID：${track.id}` : "当前未选择歌曲", `播放状态：${context.playbackState}，进度约 ${Math.floor(context.positionMs / 1000)} 秒`, context.lyricWindow.length ? `当前歌词附近：\n${context.lyricWindow.map((line) => `- ${line}`).join("\n")}` : "", events ? `最近听歌事件：\n${events}` : "", candidates ? `角色 DJ 可选歌曲（只能使用其中真实 ID）：\n${candidates}` : "本地暂无合适候选，可在确有需要时使用 search-track。", "你可以自然聊歌。musicAction 可用 accept-invite、decline-invite、invite、queue-track、search-track、propose-control、play、pause、next、leave；无操作返回 null。queue-track 只能使用候选中的真实 ID。默认适中控制下，暂停、跳过和清空队列必须使用 propose-control。"].filter(Boolean).join("\n");
}

export async function musicTrackUrl(track: MusicTrack) {
  if (track.source === "local-file") { const file = track.localFileId ? await db.musicFiles.get(track.localFileId) : undefined; if (!file) throw new Error("本地音乐文件缺失，请重新关联"); return { url: URL.createObjectURL(file.blob), revoke: true }; }
  if (track.source === "direct-url" && track.directUrl) return { url: track.directUrl, revoke: false };
  if (track.externalId) { const stream = await fetchNeteaseStream(track.externalId); if (stream.url) return { url: stream.url, revoke: false }; throw new Error(stream.reason || "当前歌曲暂不可播放"); }
  throw new Error("歌曲没有可播放来源");
}

export function musicSettingsOf(character: { chatSettings?: { music?: import("./types").CharacterMusicSettings } }) { return characterDjSettings(character as import("./types").Character); }

export async function createMusicInvitationMessage(input: { conversationId: string; characterId: string; invitedBy: "user" | "character"; trackId?: string }) {
  const t = now(), messageId = uid(), track = input.trackId ? await db.musicTracks.get(input.trackId) : undefined;
  if (input.trackId && !track) throw new Error("邀请歌曲不在当前音乐库中");
  const existing = await db.listeningSessions.where("state").anyOf("invited", "active").toArray();
  const session: ListeningSession = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t, startedAt: t, conversationId: input.conversationId, characterId: input.characterId, state: "invited", invitedBy: input.invitedBy, invitationMessageId: messageId, currentTrackId: input.trackId, queue: input.trackId ? [input.trackId] : [], queueEntries: input.trackId ? [{ trackId: input.trackId, selectedBy: input.invitedBy, addedAt: t }] : [], currentIndex: 0, playbackState: "paused", positionMs: 0, selectedBy: input.invitedBy, totalListenedMs: 0, djTurnCount: 0 };
  const history = input.invitedBy === "user" ? await db.messages.where("conversationId").equals(input.conversationId).sortBy("createdAt") : [];
  const invitedCharacter = await db.characters.get(input.characterId);
  const bubbleCountPlan = input.invitedBy === "user" && invitedCharacter ? invitationResponseBubbleCountPlan(invitedCharacter, history) : undefined;
  const responseTask = input.invitedBy === "user" && invitedCharacter && bubbleCountPlan ? invitationResponseTask({ invitationType: "music", invitationMessageId: messageId, conversationId: input.conversationId, characterId: input.characterId, targetBubbleCount: bubbleCountPlan.preferred, bubbleCountPlan, createdAt: t }) : undefined;
  const message: Message = { id: messageId, schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t, conversationId: input.conversationId, senderType: input.invitedBy === "user" ? "user" : "character", senderId: input.invitedBy === "character" ? input.characterId : undefined, content: track ? `邀请一起听「${track.title}」` : "邀请一起听音乐", kind: "music-invitation", attachments: [{ type: "music-invitation", cardRole: "invitation", sessionId: session.id, characterId: input.characterId, state: "pending", trackId: input.trackId, ...(responseTask ? { responseStatus: "queued" as const, responseTaskEventId: responseTask.eventId } : {}) }], status: "complete", origin: input.invitedBy === "character" ? "proactive" : "manual" };
  for (const current of existing) await endListeningSession(current.id, "system");
  await db.transaction("rw", [db.messages, db.conversations, db.listeningSessions, db.musicEvents, db.meetSessions, db.backgroundTasks], async () => {
    if (input.invitedBy === "user") await pauseActiveMeetForOnlineActivity(input.conversationId, t);
    await db.listeningSessions.add(session); await addMusicEvent(session, "invite", input.invitedBy, input.trackId); await db.messages.add(message); await db.conversations.update(input.conversationId, { lastActivityAt: t, updatedAt: t });
    if (responseTask && !(await db.backgroundTasks.where("eventId").equals(responseTask.eventId).first())) await db.backgroundTasks.add(responseTask);
  });
  if (responseTask && typeof window !== "undefined") window.dispatchEvent(new Event("mira:chat-reply-change"));
  return { session, message };
}

export async function respondMusicInvitation(messageId: string, accept: boolean, actor: "user" | "character" = "character") {
  const message = await db.messages.get(messageId), attachment = message?.attachments?.find((item): item is Extract<import("./types").MessageAttachment, { type: "music-invitation" }> => item.type === "music-invitation");
  if (!message || !attachment) return;
  const responseId = `music-invitation-response:${messageId}`, session = await db.listeningSessions.get(attachment.sessionId);
  if (!session) return;
  if (attachment.state !== "pending") return { ...session, state: attachment.state === "accepted" ? ("active" as const) : ("ended" as const), responseMessage: await db.messages.get(responseId) };
  const t = now(), state = accept ? "accepted" as const : "declined" as const;
  const originalAttachment = { ...attachment, cardRole: "invitation" as const, state, reason: accept ? undefined : "这次暂时不一起听", responseStatus: undefined, responseTaskEventId: undefined, processedAt: t };
  const shouldCreateResponse = actor === "character" && message.senderType === "user";
  const character = shouldCreateResponse ? await db.characters.get(attachment.characterId) : undefined;
  const responseMessage: Message | undefined = shouldCreateResponse && character ? {
    id: responseId, schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t, conversationId: message.conversationId,
    senderType: "character", senderId: character.id, content: accept ? `${character.name}接受了一起听邀请。` : `${character.name}暂时拒绝了一起听邀请。`, kind: "music-invitation", status: "complete",
    attachments: [{ ...originalAttachment, cardRole: "response" as const, reason: accept ? undefined : "这次暂时不一起听" }],
  } : undefined;
  await db.transaction("rw", [db.messages, db.listeningSessions, db.musicEvents, db.conversations], async () => {
    await db.messages.update(messageId, { updatedAt: t, attachments: message.attachments?.map((item) => item === attachment ? originalAttachment : item) });
    await db.listeningSessions.update(session.id, { state: accept ? "active" : "ended", updatedAt: t, ...(!accept ? { endedAt: t } : {}), playbackState: accept && session.currentTrackId ? "playing" : "paused" });
    await addMusicEvent(session, accept ? "accept" : "decline", actor, session.currentTrackId);
    await db.conversations.update(message.conversationId, { lastActivityAt: t, updatedAt: t });
    if (responseMessage) await db.messages.put(responseMessage);
  });
  if (accept && session.currentTrackId) window.dispatchEvent(new CustomEvent("mira:music-action", { detail: { type: "play", trackId: session.currentTrackId } }));
  return { ...session, state: accept ? ("active" as const) : ("ended" as const), responseMessage };
}

export async function executeCharacterMusicAction(input: { conversationId: string; characterId: string; action: CharacterMusicAction }) {
  const character = await db.characters.get(input.characterId);
  if (!character) return { executed: false, reason: "角色不存在" };
  const settings = musicSettingsOf(character), session = await currentListeningSession(input.conversationId);
  if (input.action.type === "invite") {
    if (!settings.canInviteToListen) return { executed: false, reason: "角色主动邀请已关闭" };
    const track = input.action.trackId ? await db.musicTracks.get(input.action.trackId) : undefined;
    if (input.action.trackId && !track) return { executed: false, reason: "歌曲不在音乐库中" };
    const result = await createMusicInvitationMessage({ conversationId: input.conversationId, characterId: input.characterId, invitedBy: "character", trackId: track?.id });
    return { executed: true, session: result.session };
  }
  if (!session || session.characterId !== input.characterId) return { executed: false, reason: "当前没有该角色的一起听会话" };
  if (input.action.type === "accept-invite" && session.invitationMessageId) { if (session.invitedBy !== "user") return { executed: false, reason: "角色不能接受自己发出的邀请" }; await respondMusicInvitation(session.invitationMessageId, true, "character"); return { executed: true, session }; }
  if (input.action.type === "decline-invite" && session.invitationMessageId) { if (session.invitedBy !== "user") return { executed: false, reason: "角色不能拒绝自己发出的邀请" }; await respondMusicInvitation(session.invitationMessageId, false, "character"); return { executed: true, session }; }
  if (input.action.type === "leave") { await endListeningSession(session.id, "character"); return { executed: true, session }; }
  if (session.state !== "active") return { executed: false, reason: "邀请尚未接受" };
  if (input.action.type === "search-track") return searchTrackForCharacter(session, character, input.action.query, input.action.placement);
  if (input.action.type === "propose-control") { await createMusicControlProposal(session, input.action.control, input.action.reason); return { executed: true, pendingConfirmation: true }; }
  if (!settings.canControlPlayback) return { executed: false, reason: "角色播放控制已关闭" };
  if (input.action.type === "queue-track") { const action = input.action, candidates = await buildMusicDjCandidates(character.id); if (!candidates.some((track) => track.id === action.trackId)) return { executed: false, reason: "歌曲不在本轮真实候选中" }; return queueListeningTrack(session.id, action.trackId, action.placement, "character"); }
  if ((input.action.type === "pause" || input.action.type === "next") && settings.controlMode !== "full") { await createMusicControlProposal(session, input.action.type, input.action.type === "pause" ? "我想先暂停一下，可以吗？" : "我想切到下一首，可以吗？"); return { executed: true, pendingConfirmation: true }; }
  if (input.action.type === "pause") { window.dispatchEvent(new CustomEvent("mira:music-action", { detail: { type: "pause" } })); await updateListeningPlayback(session.id, { playbackState: "paused" }, "pause", "character"); return { executed: true, session }; }
  if (input.action.type === "next") { window.dispatchEvent(new CustomEvent("mira:music-action", { detail: { type: "next" } })); await addMusicEvent(session, "track-change", "character", session.currentTrackId, session.positionMs, "角色切到下一首"); return { executed: true, session }; }
  if (input.action.type === "play") {
    const track = await db.musicTracks.get(input.action.trackId); if (!track) return { executed: false, reason: "歌曲不在音乐库中" };
    if (session.currentTrackId && session.currentTrackId !== track.id && settings.controlMode !== "full") { await queueListeningTrack(session.id, track.id, "next", "character"); return { executed: true, queued: true }; }
    window.dispatchEvent(new CustomEvent("mira:music-action", { detail: { type: "play", trackId: track.id, selectedBy: "character" } })); await updateListeningPlayback(session.id, { currentTrackId: track.id, selectedBy: "character", playbackState: "playing", positionMs: 0 }, "track-change", "character"); return { executed: true, session };
  }
  return { executed: false, reason: "不支持的音乐操作" };
}
