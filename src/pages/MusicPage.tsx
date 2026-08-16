import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Check,
  ChevronRight,
  Download,
  Edit3,
  FileAudio,
  Heart,
  Library,
  Link2,
  ListMusic,
  LogOut,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { db } from "../core/db";
import {
  addTracksToLocalPlaylist,
  clearMusicTrackLyrics,
  createLocalMusicPlaylist,
  createMusicLoginQr,
  createMusicInvitationMessage,
  deleteLocalMusicPlaylist,
  emptyMusicCapabilities,
  endListeningSession,
  fetchMusicCapabilities,
  getMusicAccount,
  importMusicFiles,
  importMusicLink,
  logoutMusicAccount,
  musicCoverDataUrl,
  pollMusicLoginQr,
  removeTrackFromLocalPlaylist,
  renameLocalMusicPlaylist,
  searchNeteaseMusic,
  setMusicTrackLyrics,
  updateLocalMusicPlaylistTracks,
  updateMusicTrackMetadata,
  type MusicCapabilities,
  type MusicSearchResult,
} from "../core/music";
import { useMusicPlayer } from "../core/musicPlayer";
import { deleteMoodImprint, listMoodImprintsForTrack, setMoodImprintRecallEnabled } from "../core/musicMoodImprint";
import { MusicNowPlaying } from "../components/MusicNowPlaying";
import { wakeChatReplyPump } from "../core/chatReplyRunner";
import { canCharacterInteract } from "../core/conversationSettings";
import type { Character, ListeningSession, MusicAccountProfile, MusicMoodImprint, MusicPlaylist, MusicTrack } from "../core/types";

type Tab = "home" | "search" | "library";
type TrackRowProps = { track: MusicTrack; onPlay: () => void; onMore?: () => void; disabled?: boolean; reason?: string; badge?: string };

const formatDuration = (ms = 0) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const trackMatches = (track: MusicTrack, query: string) => {
  const value = query.trim().toLocaleLowerCase();
  return !value || [track.title, track.album, ...track.artists].filter(Boolean).join(" ").toLocaleLowerCase().includes(value);
};
function Cover({ track, className = "" }: { track: MusicTrack; className?: string }) {
  return <span className={`music-track-cover ${className}`}>{track.coverUrl ? <img src={track.coverUrl} alt="" /> : <Music2 aria-hidden="true" />}</span>;
}
function TrackRow({ track, onPlay, onMore, disabled = false, reason, badge }: TrackRowProps) {
  return <div className={`music-track-item${disabled ? " is-disabled" : ""}`}>
    <button type="button" className="music-track-main" disabled={disabled} title={disabled ? reason : undefined} onClick={onPlay}>
      <Cover track={track} />
      <span className="music-track-copy"><b>{track.title}</b><small>{track.artists.join(" / ")}{track.album ? ` · ${track.album}` : ""}</small></span>
      {badge ? <span className="music-track-badge">{badge}</span> : null}
      <span className="music-track-duration">{track.durationMs ? formatDuration(track.durationMs) : ""}</span>
    </button>
    {onMore ? <button type="button" className="music-track-more" aria-label={`更多操作：${track.title}`} onClick={onMore}><MoreHorizontal aria-hidden="true" /></button> : null}
  </div>;
}
function LoginPanel({ onDone }: { onDone: (profile: MusicAccountProfile) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrStatus, setQrStatus] = useState<"waiting" | "scanned">("waiting");
  const [qr, setQr] = useState<{ key: string; qrUrl: string; qrImage?: string; expiresAt: number }>();
  const attemptRef = useRef(0), requestRef = useRef<AbortController | null>(null), timeoutRef = useRef<number | undefined>(undefined), qrKeyRef = useRef<string | undefined>(undefined);
  const cancelPending = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  }, []);
  useEffect(() => () => { attemptRef.current += 1; cancelPending(); }, [cancelPending]);
  useEffect(() => {
    if (!qr) return;
    const attempt = attemptRef.current;
    let disposed = false;
    const poll = async () => {
      if (disposed || attempt !== attemptRef.current) return;
      const controller = new AbortController();
      requestRef.current = controller;
      try {
        const result = await pollMusicLoginQr(qr.key, controller.signal);
        if (disposed || attempt !== attemptRef.current || qrKeyRef.current !== qr.key) return;
        if (result.status === "authorized") {
          cancelPending();
          if (result.profile) onDone(result.profile); else setError("登录成功，但未读取到账号资料，请刷新后重试");
          return;
        }
        if (result.status === "expired") { cancelPending(); setError("二维码已过期，请重新获取"); return; }
        setError("");
        setQrStatus(result.status);
        timeoutRef.current = window.setTimeout(() => void poll(), 2200);
      } catch (reason) {
        if (controller.signal.aborted || disposed || attempt !== attemptRef.current) return;
        setError(reason instanceof Error ? reason.message : "登录状态检查失败");
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    };
    void poll();
    return () => { disposed = true; cancelPending(); };
  }, [cancelPending, onDone, qr]);
  const start = async () => {
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    cancelPending();
    setLoading(true); setError(""); setQr(undefined); qrKeyRef.current = undefined; setQrStatus("waiting");
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const nextQr = await createMusicLoginQr(controller.signal);
      if (attempt !== attemptRef.current || controller.signal.aborted) return;
      qrKeyRef.current = nextQr.key;
      setQr(nextQr);
    } catch (reason) {
      if (!controller.signal.aborted && attempt === attemptRef.current) setError(reason instanceof Error ? reason.message : "音乐服务尚未配置");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (attempt === attemptRef.current) setLoading(false);
    }
  };
  return <section className="music-login-card">
    <div className="music-login-logo"><Music2 aria-hidden="true" /></div><h2>登录网易云音乐</h2>
    <p>扫码后可搜索歌曲、读取歌词和获取官方合法播放地址。本地音乐功能无需登录。</p>
    {qr ? <><div className="music-qr"><img src={qr.qrImage || `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qr.qrUrl)}`} alt="网易云登录二维码" /></div><small>{qrStatus === "scanned" ? "已扫码，请在网易云音乐 App 中确认" : "请使用网易云音乐 App 扫码确认"}</small><button type="button" className="music-secondary" onClick={start}><RefreshCw aria-hidden="true" />刷新二维码</button></> : <button type="button" className="music-primary" disabled={loading} onClick={start}>{loading ? <RefreshCw className="spin" aria-hidden="true" /> : <UserRound aria-hidden="true" />}{loading ? "正在连接…" : "二维码登录"}</button>}
    {error ? <p className="music-error">{error}</p> : null}
  </section>;
}function EmptyState({ children }: { children: ReactNode }) { return <div className="music-empty"><Music2 aria-hidden="true" /><span>{children}</span></div>; }

export default function MusicPage() {
  const navigate = useNavigate();
  const player = useMusicPlayer();
  const fileRef = useRef<HTMLInputElement>(null), lyricsRef = useRef<HTMLInputElement>(null), coverRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [account, setAccount] = useState<MusicAccountProfile>();
  const [authChecked, setAuthChecked] = useState(false);
  const [capabilities, setCapabilities] = useState<MusicCapabilities>(emptyMusicCapabilities);
  const [query, setQuery] = useState(""), [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MusicSearchResult>({ tracks: [], total: 0 });
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>();
  const [showImport, setShowImport] = useState(false), [link, setLink] = useState(""), [status, setStatus] = useState("");
  const [expandedPlayer, setExpandedPlayer] = useState(false), [showQueue, setShowQueue] = useState(false), [showDjPicker, setShowDjPicker] = useState(false);
  const [friendCharacters, setFriendCharacters] = useState<Character[]>([]), [djSession, setDjSession] = useState<ListeningSession>();
  const [actionTrackId, setActionTrackId] = useState<string>(), [editTrackId, setEditTrackId] = useState<string>(), [playlistPickerTrackId, setPlaylistPickerTrackId] = useState<string>();
  const [moodTrackId, setMoodTrackId] = useState<string>(), [moodImprints, setMoodImprints] = useState<MusicMoodImprint[]>([]), [moodCharacters, setMoodCharacters] = useState<Record<string, Character>>({}), [actionMoodCount, setActionMoodCount] = useState(0);
  const [importedTrackIds, setImportedTrackIds] = useState<string[]>([]), [dragActive, setDragActive] = useState(false), [dragQueueIndex, setDragQueueIndex] = useState<number>(), [dragPlaylistIndex, setDragPlaylistIndex] = useState<number>();
  const [editTitle, setEditTitle] = useState(""), [editArtists, setEditArtists] = useState(""), [editAlbum, setEditAlbum] = useState(""), [editCover, setEditCover] = useState<string>();
  const [editLyrics, setEditLyrics] = useState(""), [editLyricsKind, setEditLyricsKind] = useState<"lrc" | "plain">("lrc");

  const loadPlaylists = useCallback(async () => setPlaylists(await db.musicPlaylists.orderBy("updatedAt").reverse().toArray()), []);
  const loadDjState = useCallback(async () => { const [characters, sessions] = await Promise.all([db.characters.toArray(), db.listeningSessions.where("state").anyOf("invited", "active").toArray()]); setFriendCharacters(characters.filter(canCharacterInteract)); setDjSession(sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]); }, []);
  useEffect(() => {
    void getMusicAccount().then((value) => setAccount(value.authenticated ? value.profile : undefined)).catch(() => setAccount(undefined)).finally(() => setAuthChecked(true));
    void fetchMusicCapabilities().then(setCapabilities).catch(() => setCapabilities(emptyMusicCapabilities));
    void loadPlaylists(); void loadDjState();
    const reload = () => { void loadPlaylists(); void loadDjState(); }; window.addEventListener("mira:music-library-changed", reload); window.addEventListener("mira:chat-reply-change", reload);
    return () => { window.removeEventListener("mira:music-library-changed", reload); window.removeEventListener("mira:chat-reply-change", reload); };
  }, [loadDjState, loadPlaylists]);

  const savedTracks = player.savedTracks;
  const favoriteTracks = useMemo(() => savedTracks.filter((track) => track.favorite), [savedTracks]);
  const recentlyPlayed = useMemo(() => savedTracks.filter((track) => track.lastPlayedAt).sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)).slice(0, 12), [savedTracks]);
  const recentlyAdded = useMemo(() => [...savedTracks].sort((a, b) => b.importedAt - a.importedAt).slice(0, 12), [savedTracks]);
  const localSearchResults = useMemo(() => savedTracks.filter((track) => trackMatches(track, query)), [query, savedTracks]);
  const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const selectedPlaylistTracks = selectedPlaylist ? selectedPlaylist.trackIds.map((id) => player.tracks.find((track) => track.id === id)).filter(Boolean) as MusicTrack[] : [];
  const actionTrack = player.tracks.find((track) => track.id === actionTrackId), editTrack = player.tracks.find((track) => track.id === editTrackId), playlistPickerTrack = player.tracks.find((track) => track.id === playlistPickerTrackId);
  const importedTracks = importedTrackIds.map((id) => player.tracks.find((track) => track.id === id)).filter(Boolean) as MusicTrack[];
  const capabilityCount = [capabilities.search, capabilities.lyrics, capabilities.stream].filter(Boolean).length;

  const djCharacter = friendCharacters.find((character) => character.id === djSession?.characterId);
  const startCharacterDj = async (character: Character) => {
    const conversations = await db.conversations.where("type").equals("private").toArray(), conversation = conversations.find((item) => item.memberIds.includes(character.id));
    if (!conversation) { showMessage("请先和这个角色建立私聊"); return; }
    try {
      const result = await createMusicInvitationMessage({ conversationId: conversation.id, characterId: character.id, invitedBy: "user", trackId: player.currentTrack?.id });
      setDjSession(result.session); setShowDjPicker(false);
      wakeChatReplyPump({ source: "foreground" });
      showMessage("已发送角色 DJ 邀请");
    } catch (reason) { showMessage(reason instanceof Error ? reason.message : "邀请失败"); }
  };
  const stopCharacterDj = async () => { if (!djSession) return; await endListeningSession(djSession.id, "user"); setDjSession(undefined); showMessage("一起听已结束，已生成小结"); };

  const showMessage = useCallback((message: string) => { setStatus(message); window.setTimeout(() => setStatus((current) => current === message ? "" : current), 3200); }, []);
  useEffect(() => {
    const notify = (event: Event) => showMessage((event as CustomEvent<{ message?: string }>).detail?.message || "睡眠定时状态已更新");
    window.addEventListener("mira:music-sleep-timer-finished", notify);
    window.addEventListener("mira:music-sleep-timer-cancelled", notify);
    return () => { window.removeEventListener("mira:music-sleep-timer-finished", notify); window.removeEventListener("mira:music-sleep-timer-cancelled", notify); };
  }, [showMessage]);
  const refreshCapabilities = async () => { try { setCapabilities(await fetchMusicCapabilities(true)); showMessage("网易云能力状态已刷新"); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "能力状态刷新失败"); } };
  const handleLoginDone = useCallback((profile: MusicAccountProfile) => { setAccount(profile); setAuthChecked(true); void fetchMusicCapabilities(true).then(setCapabilities).catch(() => undefined); }, []);
  const handleLogout = async () => { await logoutMusicAccount(); setAccount(undefined); setCapabilities(emptyMusicCapabilities); setResults({ tracks: [], total: 0 }); };
  const runSearch = async () => {
    const value = query.trim(); if (!value) { setResults({ tracks: [], total: 0 }); return; }
    if (!account) { showMessage("请先登录网易云音乐"); setResults({ tracks: [], total: 0 }); return; }
    setSearching(true); try { setResults(await searchNeteaseMusic(value)); void fetchMusicCapabilities(true).then(setCapabilities).catch(() => undefined); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "网易云搜索失败"); } finally { setSearching(false); }
  };
  const finishImport = async (tracks: MusicTrack[]) => { await player.refreshLibrary(); setImportedTrackIds(tracks.map((track) => track.id)); showMessage(`已导入 ${tracks.length} 首歌曲`); };
  const importFiles = async (files: File[]) => { if (!files.length) return; try { await finishImport(await importMusicFiles(files)); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "文件导入失败"); } };
  const importLink = async () => { const value = link.trim(); if (!value) return; try { const tracks = await importMusicLink(value); await finishImport(tracks); setLink(""); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "链接导入失败"); } };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragActive(false); const files = [...event.dataTransfer.files]; if (files.length) void importFiles(files); };
  const createPlaylist = async () => {
    const name = window.prompt("新歌单名称"); if (!name) return;
    try { const playlist = await createLocalMusicPlaylist(name); await loadPlaylists(); setSelectedPlaylistId(playlist.id); setTab("library"); }
    catch (reason) { showMessage(reason instanceof Error ? reason.message : "创建歌单失败"); }
  };
  const renamePlaylist = async (playlist: MusicPlaylist) => {
    if (playlist.source !== "local") return; const name = window.prompt("重命名歌单", playlist.name);
    if (!name || name === playlist.name) return;
    try { await renameLocalMusicPlaylist(playlist.id, name); await loadPlaylists(); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "重命名失败"); }
  };
  const removePlaylist = async (playlist: MusicPlaylist) => {
    if (playlist.source !== "local" || !window.confirm(`删除歌单“${playlist.name}”？歌曲本身不会被删除。`)) return;
    try { await deleteLocalMusicPlaylist(playlist.id); setSelectedPlaylistId(undefined); await loadPlaylists(); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "删除歌单失败"); }
  };
  const playAll = async (tracks: MusicTrack[], random = false) => {
    if (!tracks.length) return; const queue = random ? [...tracks].sort(() => Math.random() - 0.5) : tracks; await player.playTrack(queue[0], queue);
  };
  const movePlaylistTrack = async (from: number, to: number) => {
    if (!selectedPlaylist || selectedPlaylist.source !== "local" || to < 0 || to >= selectedPlaylist.trackIds.length) return;
    const ids = [...selectedPlaylist.trackIds], [id] = ids.splice(from, 1); ids.splice(to, 0, id); await updateLocalMusicPlaylistTracks(selectedPlaylist.id, ids); await loadPlaylists();
  };
  const removeFromPlaylist = async (trackId: string) => { if (!selectedPlaylist || selectedPlaylist.source !== "local") return; await removeTrackFromLocalPlaylist(selectedPlaylist.id, trackId); await loadPlaylists(); };
  const addTrackToPlaylist = async (playlistId: string, trackId: string) => {
    try { const track = player.tracks.find((item) => item.id === trackId); if (track?.libraryStatus === "temporary") await player.saveTrack(trackId); await addTracksToLocalPlaylist(playlistId, [trackId]); await loadPlaylists(); setPlaylistPickerTrackId(undefined); showMessage("已加入歌单"); }
    catch (reason) { showMessage(reason instanceof Error ? reason.message : "加入歌单失败"); }
  };
  const loadMoodImprints = useCallback(async (track: MusicTrack) => {
    const imprints = await listMoodImprintsForTrack(track);
    const characters = (await db.characters.bulkGet([...new Set(imprints.map((item) => item.characterId))])).filter((item): item is Character => Boolean(item));
    setMoodImprints(imprints);
    setMoodCharacters(Object.fromEntries(characters.map((item) => [item.id, item])));
    return imprints;
  }, []);
  useEffect(() => {
    if (!actionTrack) { setActionMoodCount(0); return; }
    void listMoodImprintsForTrack(actionTrack).then((items) => setActionMoodCount(items.length));
  }, [actionTrack?.id, actionTrack?.externalId]);
  const openMoodImprints = async (track: MusicTrack) => {
    await loadMoodImprints(track);
    setMoodTrackId(track.id);
    setActionTrackId(undefined);
  };
  const toggleMoodRecall = async (imprint: MusicMoodImprint) => {
    await setMoodImprintRecallEnabled(imprint.sessionId, !imprint.recallEnabled);
    const track = player.tracks.find((item) => item.id === moodTrackId);
    if (track) await loadMoodImprints(track);
  };
  const removeMoodImprint = async (imprint: MusicMoodImprint) => {
    if (!window.confirm("删除这枚心情印记？歌曲、聊天和一起听记录不会被删除。")) return;
    await deleteMoodImprint(imprint.sessionId);
    const track = player.tracks.find((item) => item.id === moodTrackId);
    if (track) await loadMoodImprints(track);
  };
  const openEditor = (track: MusicTrack) => {
    setEditTrackId(track.id); setEditTitle(track.title); setEditArtists(track.artists.join(", ")); setEditAlbum(track.album || ""); setEditCover(track.coverUrl); setEditLyrics(track.customLyrics || ""); setEditLyricsKind(track.lyricsKind || "lrc"); setActionTrackId(undefined);
  };
  const saveEditor = async () => {
    if (!editTrack) return;
    try {
      await updateMusicTrackMetadata(editTrack.id, { title: editTitle, artists: editArtists.split(/[,，]/).map((value) => value.trim()).filter(Boolean), album: editAlbum.trim() || undefined, coverUrl: editCover });
      if (editLyrics.trim()) await setMusicTrackLyrics(editTrack.id, editLyrics, editLyricsKind);
      else if (editTrack.customLyrics) await clearMusicTrackLyrics(editTrack.id);
      await player.refreshLibrary(); if (player.currentTrack?.id === editTrack.id) await player.reloadCurrent(); setEditTrackId(undefined); showMessage("歌曲资料已保存");
    } catch (reason) { showMessage(reason instanceof Error ? reason.message : "保存失败"); }
  };
  const loadCover = async (file?: File) => { if (!file) return; try { setEditCover(await musicCoverDataUrl(file)); } catch (reason) { showMessage(reason instanceof Error ? reason.message : "封面读取失败"); } };
  const loadLyrics = async (file?: File) => {
    if (!file) return; const lower = file.name.toLocaleLowerCase();
    if (!lower.endsWith(".lrc") && !lower.endsWith(".txt")) { showMessage("请选择 .lrc 或 .txt 歌词文件"); return; }
    setEditLyrics(await file.text()); setEditLyricsKind(lower.endsWith(".lrc") ? "lrc" : "plain");
  };
  const removeTrack = async (track: MusicTrack) => {
    if (!window.confirm(`从音乐库删除“${track.title}”？${track.source === "local-file" ? "本地音频文件也会删除。" : ""}`)) return;
    const activeSession = player.activeSession ?? await db.listeningSessions.where("state").equals("active").first();
    if (activeSession?.currentTrackId === track.id) {
      if (!window.confirm("这首歌正在一起听。要先结束一起听并删除吗？")) return;
      await endListeningSession(activeSession.id, "user");
    }
    try { await player.deleteTrack(track.id); setActionTrackId(undefined); showMessage("歌曲已删除"); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : "删除失败";
      if (message.includes("一起听") && player.activeSession && window.confirm("这首歌正在一起听。要先结束一起听并删除吗？")) { await endListeningSession(player.activeSession.id, "user"); await player.deleteTrack(track.id); setActionTrackId(undefined); showMessage("已结束一起听并删除歌曲"); }
      else showMessage(message);
    }
  };
  const renderTrackList = (tracks: MusicTrack[], empty: string) => tracks.length ? <div className="music-track-list">{tracks.map((track) => <TrackRow key={track.id} track={track} badge={track.favorite ? "收藏" : undefined} onPlay={() => void player.playTrack(track, tracks)} onMore={() => setActionTrackId(track.id)} />)}</div> : <EmptyState>{empty}</EmptyState>;

  const renderHome = () => <>
    <section className="music-greeting"><h2>今天想听什么？</h2><div className="music-pills"><button type="button" onClick={() => setTab("library")}>音乐库</button><button type="button" onClick={() => setTab("search")}>搜索</button><button type="button" onClick={() => setShowImport(true)}>导入歌曲</button></div></section>
    {account ? <section className="music-account-strip"><span>{account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <UserRound aria-hidden="true" />}</span><div><b>{account.nickname}</b><small>网易云已登录 · {capabilityCount}/3 项歌曲能力可用</small></div><button type="button" aria-label="退出网易云登录" onClick={() => void handleLogout()}><LogOut aria-hidden="true" /></button></section> : authChecked ? <LoginPanel onDone={handleLoginDone} /> : <div className="music-loading">正在检查网易云登录状态…</div>}
    <section className="music-dj-panel"><div className="music-section-title"><div><small>PRIVATE DJ</small><h3>角色 DJ</h3></div>{djSession ? <button type="button" onClick={() => void stopCharacterDj()}>结束</button> : <button type="button" onClick={() => setShowDjPicker(true)}>选择角色</button>}</div>{djSession ? <div className={"music-dj-active " + djSession.state}><span>{djCharacter?.avatar ? <img src={djCharacter.avatar} alt="" /> : <UserRound aria-hidden="true" />}</span><div><b>{djCharacter?.name || "角色"}</b><small>{djSession.state === "invited" ? "等待角色接受邀请" : `正在陪你听 · 当前由${djSession.selectedBy === "character" ? "角色" : "用户"}点歌`}</small></div></div> : <p>让好友角色从你的音乐库中点歌、聊歌，并一起留下听歌小结。</p>}</section>
    <button type="button" className="music-report-entry" onClick={() => navigate("/music/report")}><span><BarChart3 aria-hidden="true" /></span><div><small>LISTENING REPORT</small><b>听歌报告与陪听回忆</b><em>查看本周、本月和年度音乐足迹</em></div><ChevronRight aria-hidden="true" /></button>
    <section className="music-section"><div className="music-section-title"><h3>我的收藏</h3><button type="button" onClick={() => setTab("library")}>查看全部</button></div>{favoriteTracks.length ? <div className="music-card-grid">{favoriteTracks.slice(0, 6).map((track) => <button type="button" key={track.id} onClick={() => void player.playTrack(track, favoriteTracks)}><Cover track={track} /><b>{track.title}</b><small>{track.artists.join(" / ")}</small></button>)}</div> : <EmptyState>收藏喜欢的歌曲后会出现在这里</EmptyState>}</section>
    <section className="music-section"><div className="music-section-title"><h3>最近播放</h3></div>{renderTrackList(recentlyPlayed.slice(0, 5), "开始播放后会留下最近记录")}</section>
    <section className="music-section"><div className="music-section-title"><h3>最近添加</h3></div>{renderTrackList(recentlyAdded.slice(0, 5), "导入文件、直链或保存歌曲后会显示在这里")}</section>
    <section className="music-section"><div className="music-section-title"><h3>本地歌单</h3><button type="button" onClick={() => void createPlaylist()}><Plus aria-hidden="true" />新建</button></div>{playlists.length ? <div className="music-playlist-scroll">{playlists.map((playlist) => <article key={playlist.id}>{playlist.coverUrl ? <img src={playlist.coverUrl} alt="" /> : <span><ListMusic aria-hidden="true" /></span>}<b>{playlist.name}</b><small>{playlist.trackIds.length} 首 · {playlist.source === "local" ? "本地歌单" : "历史歌单"}</small><button type="button" onClick={() => { setSelectedPlaylistId(playlist.id); setTab("library"); }}><Play aria-hidden="true" />打开</button></article>)}</div> : <EmptyState>新建歌单，把喜欢的歌曲整理在一起</EmptyState>}</section>
  </>;

  const renderSearch = () => <section className="music-search-view">
    <form className="music-search-box" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索本地歌曲或网易云歌曲" aria-label="搜索歌曲" /><button type="submit" disabled={searching}>{searching ? "搜索中" : "搜索"}</button></form>
    <div className="music-section-title"><h3>本地音乐库</h3><small>{localSearchResults.length} 首</small></div>{renderTrackList(localSearchResults, query ? "本地音乐库没有匹配歌曲" : "输入关键词，或先导入本地歌曲")}
    <div className="music-search-divider" /><div className="music-section-title"><h3>网易云结果</h3>{account ? <button type="button" onClick={() => void refreshCapabilities()}><RefreshCw aria-hidden="true" />刷新能力</button> : null}</div>
    {!account ? <p className="music-capability-note">登录网易云后可额外搜索官方歌曲。本地搜索始终可用。</p> : !capabilities.search ? <p className="music-capability-note">当前账号未开放歌曲搜索能力。{capabilities.reasons?.search || "可继续使用本地音乐。"}</p> : results.tracks.length ? <div className="music-track-list">{results.tracks.map((track) => {
      const stored = player.tracks.find((item) => item.id === track.id), saved = stored ? stored.libraryStatus !== "temporary" : false;
      return <TrackRow key={track.id} track={stored || track} badge={saved ? "已保存" : "网易云"} onPlay={() => void player.playTrack(track, results.tracks)} onMore={() => stored ? setActionTrackId(track.id) : void player.rememberTrack(track).then(() => setActionTrackId(track.id))} />;
    })}</div> : <EmptyState>{query ? "点击搜索获取网易云结果" : "网易云搜索结果会单独显示在这里"}</EmptyState>}
  </section>;

  const renderPlaylistDetail = () => selectedPlaylist ? <section className="music-playlist-detail">
    <button type="button" className="music-inline-back" onClick={() => setSelectedPlaylistId(undefined)}><ArrowLeft aria-hidden="true" />返回音乐库</button>
    <div className="music-playlist-hero"><span>{selectedPlaylist.coverUrl ? <img src={selectedPlaylist.coverUrl} alt="" /> : <ListMusic aria-hidden="true" />}</span><div><small>{selectedPlaylist.source === "local" ? "本地歌单" : "历史网易云歌单 · 只读"}</small><h2>{selectedPlaylist.name}</h2><p>{selectedPlaylistTracks.length} 首歌曲</p></div></div>
    <div className="music-playlist-actions"><button type="button" className="music-primary" disabled={!selectedPlaylistTracks.length} onClick={() => void playAll(selectedPlaylistTracks)}><Play aria-hidden="true" />播放全部</button><button type="button" className="music-secondary" disabled={!selectedPlaylistTracks.length} onClick={() => void playAll(selectedPlaylistTracks, true)}><Shuffle aria-hidden="true" />随机播放</button>{selectedPlaylist.source === "local" ? <><button type="button" className="music-icon-action" aria-label="重命名歌单" onClick={() => void renamePlaylist(selectedPlaylist)}><Edit3 aria-hidden="true" /></button><button type="button" className="music-icon-action danger" aria-label="删除歌单" onClick={() => void removePlaylist(selectedPlaylist)}><Trash2 aria-hidden="true" /></button></> : null}</div>
    {selectedPlaylistTracks.length ? <div className="music-playlist-track-list">{selectedPlaylistTracks.map((track, index) => <div className="music-playlist-track" key={track.id} draggable={selectedPlaylist.source === "local"} onDragStart={() => setDragPlaylistIndex(index)} onDragOver={(event) => { if (selectedPlaylist.source === "local") event.preventDefault(); }} onDrop={() => { if (dragPlaylistIndex !== undefined) void movePlaylistTrack(dragPlaylistIndex, index); setDragPlaylistIndex(undefined); }}><TrackRow track={track} onPlay={() => void player.playTrack(track, selectedPlaylistTracks)} onMore={() => setActionTrackId(track.id)} />{selectedPlaylist.source === "local" ? <div className="music-row-order"><button type="button" aria-label="上移" disabled={index === 0} onClick={() => void movePlaylistTrack(index, index - 1)}><ArrowUp aria-hidden="true" /></button><button type="button" aria-label="下移" disabled={index === selectedPlaylistTracks.length - 1} onClick={() => void movePlaylistTrack(index, index + 1)}><ArrowDown aria-hidden="true" /></button><button type="button" aria-label="从歌单移除" onClick={() => void removeFromPlaylist(track.id)}><X aria-hidden="true" /></button></div> : null}</div>)}</div> : <EmptyState>这个歌单还没有歌曲</EmptyState>}
  </section> : null;

  const renderLibrary = () => selectedPlaylist ? renderPlaylistDetail() : <section className="music-library-view">
    <div className="music-library-head"><div><small>你的本地收藏</small><h2>音乐库</h2></div><button type="button" onClick={() => setShowImport(true)}><Plus aria-hidden="true" />导入</button></div>
    <div className="music-library-summary"><span><b>{savedTracks.length}</b><small>所有歌曲</small></span><span><b>{favoriteTracks.length}</b><small>我的收藏</small></span><span><b>{playlists.length}</b><small>本地与历史歌单</small></span></div>
    <div className="music-section-title"><h3>歌单</h3><button type="button" onClick={() => void createPlaylist()}><Plus aria-hidden="true" />新建歌单</button></div><div className="music-library-playlists">{playlists.map((playlist) => <button type="button" key={playlist.id} onClick={() => setSelectedPlaylistId(playlist.id)}><span>{playlist.coverUrl ? <img src={playlist.coverUrl} alt="" /> : <ListMusic aria-hidden="true" />}</span><div><b>{playlist.name}</b><small>{playlist.trackIds.length} 首 · {playlist.source === "local" ? "可编辑" : "历史只读"}</small></div></button>)}{!playlists.length ? <EmptyState>还没有歌单</EmptyState> : null}</div>
    <div className="music-section-title"><h3>所有歌曲</h3><small>{savedTracks.length} 首</small></div>{renderTrackList(savedTracks, "音乐库还是空的，先导入一首歌曲吧")}
  </section>;
  function renderQueue() {
    return <div className="music-overlay" role="presentation" onClick={() => setShowQueue(false)}><section className="music-queue-sheet" role="dialog" aria-modal="true" aria-label="播放队列" onClick={(event) => event.stopPropagation()}>
      <div className="music-sheet-head"><div><h3>播放队列</h3><small>{player.queueTracks.length} 首</small></div><button type="button" aria-label="关闭队列" onClick={() => setShowQueue(false)}><X aria-hidden="true" /></button></div>
      {player.queueTracks.length ? <><button type="button" className="music-clear-queue" onClick={() => { if (window.confirm("清空播放队列？")) player.clearQueue(); }}><Trash2 aria-hidden="true" />清空队列</button><div className="music-queue-list">{player.queueTracks.map((track, index) => <div key={`${track.id}-${index}`} className={`music-queue-item${track.id === player.currentTrack?.id ? " active" : ""}`} draggable onDragStart={() => setDragQueueIndex(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragQueueIndex !== undefined) player.moveQueueItem(dragQueueIndex, index); setDragQueueIndex(undefined); }}>
        <button type="button" className="music-queue-main" onClick={() => void player.playTrack(track, player.queueTracks)}><span>{index + 1}</span><div><b>{track.title}</b><small>{track.artists.join(" / ")} · {player.queueEntries[index]?.selectedBy === "character" ? (djCharacter?.name || "角色") : "用户"}点歌</small></div></button>
        <div className="music-row-order"><button type="button" aria-label="上移" disabled={index === 0} onClick={() => player.moveQueueItem(index, index - 1)}><ArrowUp aria-hidden="true" /></button><button type="button" aria-label="下移" disabled={index === player.queueTracks.length - 1} onClick={() => player.moveQueueItem(index, index + 1)}><ArrowDown aria-hidden="true" /></button><button type="button" aria-label="从队列移除" onClick={() => player.removeFromQueue(track.id)}><X aria-hidden="true" /></button></div>
      </div>)}</div></> : <EmptyState>播放队列为空</EmptyState>}
    </section></div>;
  }

  function renderEditor() {
    if (!editTrack) return null;
    return <div className="music-overlay" role="presentation" onClick={() => setEditTrackId(undefined)}><section className="music-editor-sheet" role="dialog" aria-modal="true" aria-label={`编辑歌曲：${editTrack.title}`} onClick={(event) => event.stopPropagation()}>
      <div className="music-sheet-head"><div><h3>编辑歌曲信息</h3><small>修改会同步到播放器、歌单和一起听</small></div><button type="button" aria-label="关闭编辑" onClick={() => setEditTrackId(undefined)}><X aria-hidden="true" /></button></div>
      <div className="music-editor-cover"><span>{editCover ? <img src={editCover} alt="歌曲封面预览" /> : <Music2 aria-hidden="true" />}</span><div><button type="button" className="music-secondary" onClick={() => coverRef.current?.click()}><Upload aria-hidden="true" />选择封面</button>{editCover ? <button type="button" className="music-text-action" onClick={() => setEditCover(undefined)}>移除封面</button> : null}</div><input ref={coverRef} hidden type="file" accept="image/*" onChange={(event) => void loadCover(event.target.files?.[0])} /></div>
      <label>歌名<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
      <label>歌手<input value={editArtists} onChange={(event) => setEditArtists(event.target.value)} placeholder="多位歌手用逗号分隔" /></label>
      <label>专辑<input value={editAlbum} onChange={(event) => setEditAlbum(event.target.value)} /></label>
      <div className="music-editor-lyrics-head"><div><b>自定义歌词</b><small>用户歌词优先于网易云官方歌词</small></div><button type="button" className="music-secondary" onClick={() => lyricsRef.current?.click()}><FileAudio aria-hidden="true" />导入 LRC/TXT</button></div>
      <input ref={lyricsRef} hidden type="file" accept=".lrc,.txt,text/plain" onChange={(event) => void loadLyrics(event.target.files?.[0])} />
      <div className="music-kind-toggle"><button type="button" className={editLyricsKind === "lrc" ? "active" : ""} onClick={() => setEditLyricsKind("lrc")}>LRC 同步歌词</button><button type="button" className={editLyricsKind === "plain" ? "active" : ""} onClick={() => setEditLyricsKind("plain")}>TXT 静态歌词</button></div>
      <textarea value={editLyrics} onChange={(event) => setEditLyrics(event.target.value)} rows={8} placeholder={editLyricsKind === "lrc" ? "[00:12.00]第一句歌词" : "每行一段歌词"} />
      {editTrack.customLyrics ? <button type="button" className="music-text-action danger" onClick={() => { setEditLyrics(""); showMessage("保存后将恢复官方歌词"); }}>删除自定义歌词并恢复官方歌词</button> : null}
      <button type="button" className="music-primary music-save-editor" onClick={() => void saveEditor()}><Save aria-hidden="true" />保存修改</button>
    </section></div>;
  }

  if (expandedPlayer && player.currentTrack) return <>
    <MusicNowPlaying onClose={() => setExpandedPlayer(false)} onOpenQueue={() => setShowQueue(true)} onEdit={() => openEditor(player.currentTrack!)} onNotice={showMessage} />
    {showQueue ? renderQueue() : null}
    {editTrack ? renderEditor() : null}
    {status ? <div className="music-toast">{status}</div> : null}
  </>;  return <main className={`music-page${dragActive ? " is-dragging" : ""}`} onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) setDragActive(true); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }} onDrop={onDrop}>
    <header className="music-header"><button type="button" aria-label="返回桌面" onClick={() => navigate("/")}><ArrowLeft aria-hidden="true" /></button><div><small>茶茶机</small><h1>音乐</h1></div><button type="button" className="music-avatar-button" aria-label={account ? "网易云账号" : "登录网易云"} onClick={() => setTab("home")}>{account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <UserRound aria-hidden="true" />}</button></header>
    <div className="music-content">{tab === "home" ? renderHome() : tab === "search" ? renderSearch() : renderLibrary()}</div>
    {player.currentTrack ? <div className="music-page-mini"><button type="button" className="music-page-mini-main" onClick={() => setExpandedPlayer(true)}><Cover track={player.currentTrack} /><span><b>{player.currentTrack.title}</b><small>{player.currentTrack.artists.join(" / ")}</small></span></button><button type="button" className={player.currentTrack.favorite ? "is-favorite" : ""} aria-label={player.currentTrack.favorite ? "取消收藏" : "收藏"} onClick={() => void player.toggleFavorite(player.currentTrack!.id)}><Heart aria-hidden="true" fill={player.currentTrack.favorite ? "currentColor" : "none"} /></button><button type="button" aria-label={player.playing ? "暂停" : "播放"} onClick={() => void player.toggle()}>{player.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button><button type="button" aria-label="打开播放队列" onClick={() => setShowQueue(true)}><ListMusic aria-hidden="true" /></button></div> : null}
    <nav className="music-tabs" aria-label="音乐主导航"><button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><Music2 aria-hidden="true" /><span>首页</span></button><button type="button" className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><Search aria-hidden="true" /><span>搜索</span></button><button type="button" className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}><Library aria-hidden="true" /><span>音乐库</span></button></nav>
    {dragActive ? <div className="music-drop-overlay"><Upload aria-hidden="true" /><b>松开即可导入音乐文件</b><small>支持多选，文件只保存在此设备</small></div> : null}

    {showImport ? <div className="music-overlay" role="presentation" onClick={() => setShowImport(false)}><section className="music-import-sheet" role="dialog" aria-modal="true" aria-label="导入音乐" onClick={(event) => event.stopPropagation()}>
      <div className="music-sheet-head"><div><h3>导入音乐</h3><small>本地文件不会上传到云端</small></div><button type="button" aria-label="关闭导入" onClick={() => setShowImport(false)}><X aria-hidden="true" /></button></div>
      <button type="button" className="music-import-action" onClick={() => fileRef.current?.click()}><Upload aria-hidden="true" /><span><b>选择音乐文件</b><small>MP3、M4A/AAC、FLAC、OGG、WAV、WebM</small></span></button>
      <input ref={fileRef} hidden type="file" multiple accept="audio/*,.mp3,.m4a,.aac,.flac,.ogg,.wav,.webm" onChange={(event) => void importFiles([...(event.target.files || [])])} />
      <div className="music-link-import"><Link2 aria-hidden="true" /><input value={link} onChange={(event) => setLink(event.target.value)} placeholder="音频直链或网易云单曲分享链接" /><button type="button" onClick={() => void importLink()}><Download aria-hidden="true" />导入</button></div>
      <p className="music-capability-note">网易云歌单和专辑链接不再支持，当前仅接受单曲分享链接。</p>
      {importedTracks.length ? <div className="music-import-results"><b>最近导入</b>{importedTracks.map((track) => <TrackRow key={track.id} track={track} onPlay={() => void player.playTrack(track, importedTracks)} onMore={() => setActionTrackId(track.id)} />)}</div> : null}
    </section></div> : null}

    {actionTrack ? <div className="music-overlay" role="presentation" onClick={() => setActionTrackId(undefined)}><section className="music-action-sheet" role="dialog" aria-modal="true" aria-label={`歌曲操作：${actionTrack.title}`} onClick={(event) => event.stopPropagation()}>
      <div className="music-action-track"><Cover track={actionTrack} /><div><b>{actionTrack.title}</b><small>{actionTrack.artists.join(" / ")}</small></div><button type="button" aria-label="关闭" onClick={() => setActionTrackId(undefined)}><X aria-hidden="true" /></button></div>
      <div className="music-action-grid"><button type="button" onClick={() => void player.toggleFavorite(actionTrack.id)}><Heart aria-hidden="true" fill={actionTrack.favorite ? "currentColor" : "none"} />{actionTrack.favorite ? "取消收藏" : "收藏"}</button>{actionTrack.libraryStatus === "temporary" ? <button type="button" onClick={() => void player.saveTrack(actionTrack.id).then(() => showMessage("已保存到音乐库"))}><Save aria-hidden="true" />保存到音乐库</button> : null}<button type="button" onClick={() => void player.playNext(actionTrack).then(() => showMessage("将于下一首播放"))}><SkipForward aria-hidden="true" />下一首播放</button><button type="button" onClick={() => void player.addToQueue(actionTrack).then(() => showMessage("已添加到队尾"))}><ListMusic aria-hidden="true" />添加到队尾</button><button type="button" onClick={() => { setPlaylistPickerTrackId(actionTrack.id); setActionTrackId(undefined); }}><Plus aria-hidden="true" />加入歌单</button><button type="button" onClick={() => void openMoodImprints(actionTrack)}><Heart aria-hidden="true" />心情印记（{actionMoodCount}）</button><button type="button" onClick={() => openEditor(actionTrack)}><Edit3 aria-hidden="true" />编辑资料与歌词</button><button type="button" className="danger" onClick={() => void removeTrack(actionTrack)}><Trash2 aria-hidden="true" />删除歌曲</button></div>
    </section></div> : null}

    {moodTrackId ? <div className="music-overlay" role="presentation" onClick={() => setMoodTrackId(undefined)}><section className="music-picker-sheet music-mood-sheet" role="dialog" aria-modal="true" aria-label="心情印记" onClick={(event) => event.stopPropagation()}>
      <div className="music-sheet-head"><div><h3>心情印记</h3><small>{player.tracks.find((item) => item.id === moodTrackId)?.title}</small></div><button type="button" aria-label="关闭" onClick={() => setMoodTrackId(undefined)}><X aria-hidden="true" /></button></div>
      {moodImprints.length ? <div className="music-mood-list">{moodImprints.map((imprint) => { const character = moodCharacters[imprint.characterId]; return <article className="music-mood-card" key={imprint.id}>
        <header><span className="music-mood-avatar">{character?.avatar ? <img src={character.avatar} alt="" /> : <UserRound aria-hidden="true" />}</span><div><b>{character?.name ?? "已删除角色"}</b><small>{new Date(imprint.createdAt).toLocaleDateString()} · 提起过 {imprint.recallCount} 次</small></div></header>
        <div className="music-mood-tags">{imprint.moodTags.map((tag) => <span key={tag}>{tag}</span>)}</div>
        <p>{imprint.summary}</p>
        <div className="music-mood-quotes">{imprint.quotes.map((quote) => <blockquote key={quote.messageId}><b>{quote.senderType === "user" ? "你" : character?.name ?? "角色"}</b><span>{quote.textSnapshot}</span></blockquote>)}</div>
        <footer><label className="music-mood-toggle"><input type="checkbox" checked={imprint.recallEnabled} onChange={() => void toggleMoodRecall(imprint)} /><span>允许角色主动提起</span></label><button type="button" className="danger" onClick={() => void removeMoodImprint(imprint)}><Trash2 aria-hidden="true" />删除</button></footer>
      </article>; })}</div> : <div className="music-mood-empty"><Heart aria-hidden="true" /><p>与角色一起听并产生真实聊天后，会在这里留下心情印记。</p></div>}
    </section></div> : null}
    {playlistPickerTrack ? <div className="music-overlay" role="presentation" onClick={() => setPlaylistPickerTrackId(undefined)}><section className="music-picker-sheet" role="dialog" aria-modal="true" aria-label="选择歌单" onClick={(event) => event.stopPropagation()}>
      <div className="music-sheet-head"><div><h3>加入歌单</h3><small>{playlistPickerTrack.title}</small></div><button type="button" aria-label="关闭" onClick={() => setPlaylistPickerTrackId(undefined)}><X aria-hidden="true" /></button></div>
      <button type="button" className="music-create-playlist" onClick={() => void createPlaylist()}><Plus aria-hidden="true" />新建本地歌单</button>
      {playlists.filter((playlist) => playlist.source === "local").map((playlist) => <button type="button" className="music-picker-row" key={playlist.id} disabled={playlist.trackIds.includes(playlistPickerTrack.id)} onClick={() => void addTrackToPlaylist(playlist.id, playlistPickerTrack.id)}><ListMusic aria-hidden="true" /><span><b>{playlist.name}</b><small>{playlist.trackIds.length} 首</small></span>{playlist.trackIds.includes(playlistPickerTrack.id) ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}</button>)}
    </section></div> : null}

    {showQueue ? renderQueue() : null}
    {showDjPicker ? <div className="music-overlay" role="presentation" onClick={() => setShowDjPicker(false)}><section className="music-picker-sheet music-dj-picker" role="dialog" aria-modal="true" aria-label="选择角色 DJ" onClick={(event) => event.stopPropagation()}><div className="music-sheet-head"><div><h3>选择角色 DJ</h3><small>仅显示已添加的好友角色</small></div><button type="button" aria-label="关闭" onClick={() => setShowDjPicker(false)}><X aria-hidden="true" /></button></div>{friendCharacters.length ? friendCharacters.map((character) => <button type="button" className="music-dj-character" key={character.id} onClick={() => void startCharacterDj(character)}><span>{character.avatar ? <img src={character.avatar} alt="" /> : <UserRound aria-hidden="true" />}</span><div><b>{character.name}</b><small>邀请一起听并开启私人 DJ</small></div><Plus aria-hidden="true" /></button>) : <EmptyState>还没有可邀请的好友角色</EmptyState>}</section></div> : null}
    {editTrack ? renderEditor() : null}{status ? <div className="music-toast">{status}</div> : null}
  </main>;
}
