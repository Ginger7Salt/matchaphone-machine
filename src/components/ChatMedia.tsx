import {
  CalendarDays,
  Camera,
  Coffee,
  Coins,
  Cpu,
  Gift,
  Image as ImageIcon,
  Footprints,
  Mic,
  Music2,
  HeartHandshake,
  Phone,
  ShoppingBag,
  SmilePlus,
  UtensilsCrossed,
  Vote,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./ui";
import { db } from "../core/db";
import { respondMeetInvitation } from "../core/meetService";
import { respondMusicControlProposal, selectMusicSearchCandidate } from "../core/musicDj";
import { closePoll, voteInPoll } from "../core/groupFeatures";
import { getAppSettings } from "../core/db";
import { receiveIncomingWalletTransfer } from "../core/mall";
import {
  displayDuration,
  MAX_VOICE_DURATION_MS,
  saveImageMedia,
  saveVoiceMedia,
} from "../core/mediaAssets";
import type {
  MediaAsset,
  Message,
  MusicTrack,
  StickerItem,
  StickerPack,
} from "../core/types";
export type ChatMediaPanel =
  | "extensions"
  | "stickers"
  | "photo"
  | "voice"
  | "transfer"
  | "red-packet"
  | "poll"
  | "meet"
  | "music"
  | "couple-island"
  | "model"
  | null;
export function ExtensionPanel({
  onSelect,
  onClose,
  isGroup = false,
  directorMode = false,
}: {
  onSelect: (panel: Exclude<ChatMediaPanel, "extensions" | null>) => void;
  onClose: () => void;
  isGroup?: boolean;
  directorMode?: boolean;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="chat-extension-sheet">
        <button
          className="chat-extension-handle"
          aria-label="关闭更多功能"
          onClick={onClose}
        >
          <i />
        </button>
        <div className="chat-extension-list" role="menu" aria-label="更多功能">
          {!directorMode && (
            <>
              <button
                role="menuitem"
                className="extension-photo"
                onClick={() => onSelect("photo")}
              >
                <span>
                  <ImageIcon />
                </span>
                <b>照片</b>
              </button>
              <button
                role="menuitem"
                className="extension-voice"
                onClick={() => onSelect("voice")}
              >
                <span>
                  <Mic />
                </span>
                <b>语音</b>
              </button>
            </>
          )}
          {isGroup ? (
            <>
              <button
                role="menuitem"
                className="extension-red-packet"
                onClick={() => onSelect("red-packet")}
              >
                <span>
                  <Coins />
                </span>
                <b>红包</b>
              </button>
              <button
                role="menuitem"
                className="extension-poll"
                onClick={() => onSelect("poll")}
              >
                <span>
                  <Vote />
                </span>
                <b>投票</b>
              </button>
            </>
          ) : (
            <button
              role="menuitem"
              className="extension-transfer"
              onClick={() => onSelect("transfer")}
            >
              <span>
                <WalletCards />
              </span>
              <b>转账</b>
            </button>
          )}
          {!isGroup && !directorMode && (
            <button role="menuitem" className="extension-music" onClick={() => onSelect("music")}>
              <span><Music2 /></span><b>一起听</b>
            </button>
          )}
          {!isGroup && !directorMode && (
            <button role="menuitem" className="extension-island" onClick={() => onSelect("couple-island")}>
              <span><HeartHandshake /></span><b>茶侣岛</b>
            </button>
          )}
          <button
            role="menuitem"
            className="extension-model"
            onClick={() => onSelect("model")}
          >
            <span>
              <Cpu />
            </span>
            <b>{"\u5207\u6362\u6a21\u578b"}</b>
          </button>
          <button
            role="menuitem"
            className="extension-meet"
            onClick={() => onSelect("meet")}
          >
            <span>
              <Footprints />
            </span>
            <b>见面</b>
          </button>
        </div>
      </div>
    </Modal>
  );
}
export function StickerPicker({
  onSelect,
  onClose,
}: {
  onSelect: (pack: StickerPack, sticker: StickerItem) => void;
  onClose: () => void;
}) {
  const [packs, setPacks] = useState<StickerPack[]>([]),
    [assets, setAssets] = useState<Map<string, MediaAsset>>(new Map()),
    [active, setActive] = useState("");
  useEffect(() => {
    void Promise.all([
      db.stickerPacks.orderBy("order").toArray(),
      db.mediaAssets.where("purpose").equals("sticker").toArray(),
    ]).then(([p, a]) => {
      setPacks(p);
      setAssets(new Map(a.map((x) => [x.id, x])));
      setActive(p[0]?.id ?? "");
    });
  }, []);
  const pack = packs.find((x) => x.id === active);
  return (
    <Modal onClose={onClose}>
      <div className="sheet-head">
        <div>
          <small>STICKERS</small>
          <h2>我的表情包</h2>
        </div>
        <button onClick={onClose}>
          <X />
        </button>
      </div>
      {packs.length ? (
        <>
          <div className="sticker-picker-tabs">
            {packs.map((p) => (
              <button
                key={p.id}
                className={p.id === active ? "active" : ""}
                onClick={() => setActive(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="sticker-picker-grid">
            {pack?.stickers
              .sort((a, b) => a.order - b.order)
              .map((s) => (
                <button
                  key={s.id}
                  title={s.description}
                  onClick={() => onSelect(pack, s)}
                >
                  <img
                    src={
                      s.source === "asset"
                        ? assets.get(s.assetId ?? "")?.data
                        : s.url
                    }
                    alt={s.name}
                  />
                  <small>{s.name}</small>
                </button>
              ))}
          </div>
        </>
      ) : (
        <div className="empty-state compact">
          <SmilePlus />
          <h3>还没有表情包</h3>
          <p>请先前往设置导入自己的表情。</p>
        </div>
      )}
    </Modal>
  );
}
export function RedPacketPanel({
  maxMembers,
  onSend,
  onClose,
}: {
  maxMembers: number;
  onSend: (amountCents: number, count: number, note: string) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(""),
    [count, setCount] = useState(Math.max(1, maxMembers)),
    [note, setNote] = useState("恭喜发财");
  const cents = Math.round(Number(amount) * 100),
    valid = cents >= count && count >= 1 && count <= maxMembers;
  return (
    <Modal onClose={onClose}>
      <div className="sheet-head">
        <div>
          <small>GROUP RED PACKET</small>
          <h2>发红包</h2>
        </div>
        <button onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="group-tool-form red-packet-form">
        <span className="group-tool-hero">
          <Coins />
        </span>
        <label>
          总金额（元）
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
          />
        </label>
        <label>
          红包个数
          <input
            type="number"
            min="1"
            max={maxMembers}
            value={count}
            onChange={(event) =>
              setCount(
                Math.max(
                  1,
                  Math.min(maxMembers, Number(event.target.value) || 1),
                ),
              )
            }
          />
          <small>当前最多 {maxMembers} 位角色可领取</small>
        </label>
        <label>
          祝福语
          <input
            maxLength={40}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={!valid}
          onClick={() => onSend(cents, count, note)}
        >
          塞钱进红包
        </button>
      </div>
    </Modal>
  );
}
export function PollPanel({
  onSend,
  onClose,
}: {
  onSend: (
    question: string,
    mode: "single" | "multiple",
    options: string[],
  ) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState(""),
    [mode, setMode] = useState<"single" | "multiple">("single"),
    [options, setOptions] = useState(["", ""]);
  const valid =
    question.trim() && options.filter((value) => value.trim()).length >= 2;
  return (
    <Modal onClose={onClose}>
      <div className="sheet-head">
        <div>
          <small>GROUP POLL</small>
          <h2>发起投票</h2>
        </div>
        <button onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="group-tool-form poll-create-form">
        <label>
          投票问题
          <input
            maxLength={100}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="大家更喜欢哪个？"
          />
        </label>
        <label>
          选择方式
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as "single" | "multiple")
            }
          >
            <option value="single">单选</option>
            <option value="multiple">多选</option>
          </select>
        </label>
        <div className="poll-option-editor">
          {options.map((value, index) => (
            <label key={index}>
              <span>{index + 1}</span>
              <input
                maxLength={50}
                value={value}
                onChange={(event) =>
                  setOptions((current) =>
                    current.map((item, i) =>
                      i === index ? event.target.value : item,
                    ),
                  )
                }
                placeholder={`选项 ${index + 1}`}
              />
              {options.length > 2 && (
                <button
                  onClick={() =>
                    setOptions((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                >
                  ×
                </button>
              )}
            </label>
          ))}
        </div>
        {options.length < 8 && (
          <button
            className="secondary-action"
            onClick={() => setOptions((current) => [...current, ""])}
          >
            添加选项
          </button>
        )}
        <button
          className="primary"
          disabled={!valid}
          onClick={() =>
            onSend(
              question.trim(),
              mode,
              options.map((value) => value.trim()).filter(Boolean),
            )
          }
        >
          发起投票
        </button>
      </div>
    </Modal>
  );
}
function TranslatedMessageText({ message }: { message: Message }) {
  const translated =
    message.translation?.status === "complete" && message.translation.text;
  return translated ? (
    <div className="translated-message-text">
      <span>{message.content}</span>
      <i />
      <strong>{message.translation!.text}</strong>
    </div>
  ) : (
    <>{message.content}</>
  );
}
export function RichMessageContent({
  message,
  assets,
  onMusicInvitationResponse,
  onCoupleIslandInvitationResponse,
  onInvitationRetry,
}: {
  message: Message;
  assets: Map<string, MediaAsset>;
  onMusicInvitationResponse?: (messageId: string, accept: boolean) => Promise<void>;
  onCoupleIslandInvitationResponse?: (messageId: string, decision: "accept" | "decline", reason?: string) => Promise<void>;
  onInvitationRetry?: (eventId: string) => Promise<void>;
}) {
  const nav = useNavigate(),
    attachment = message.attachments?.[0],
    [transferState, setTransferState] = useState<
      "pending" | "accepted" | "refunded" | null
    >(attachment?.type === "transfer" ? attachment.state : null),
    [pollState, setPollState] = useState(
      attachment?.type === "poll" ? attachment : null,
    ),
    [musicState, setMusicState] = useState(
      attachment?.type === "music-invitation" ? attachment.state : null,
    ),
    [musicTrack, setMusicTrack] = useState<MusicTrack | undefined>(undefined),
    [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]),
    [musicCardState, setMusicCardState] = useState<string | null>(attachment && "state" in attachment && typeof attachment.state === "string" ? attachment.state : null),
    [coupleState, setCoupleState] = useState(attachment?.type === "couple-island-invitation" ? attachment.state : null),
    [coupleBusy, setCoupleBusy] = useState(false),
    [musicBusy, setMusicBusy] = useState(false);
  useEffect(() => {
    if (attachment?.type === "music-invitation") setMusicState(attachment.state);
  }, [attachment]);
  useEffect(() => {
    if (attachment?.type !== "music-invitation" || !attachment.trackId) { setMusicTrack(undefined); return; }
    let cancelled = false;
    void db.musicTracks.get(attachment.trackId).then((track) => { if (!cancelled) setMusicTrack(track); });
    return () => { cancelled = true; };
  }, [attachment]);
  useEffect(() => {
    const ids = attachment?.type === "music-search-candidates" ? attachment.trackIds : attachment?.type === "music-session-summary" ? attachment.trackIds : [];
    if (!ids.length) { setMusicTracks([]); return; }
    let cancelled = false; void db.musicTracks.bulkGet(ids).then((rows) => { if (!cancelled) setMusicTracks(rows.filter((row): row is MusicTrack => Boolean(row))); });
    return () => { cancelled = true; };
  }, [attachment]);
  useEffect(() => { if (attachment && "state" in attachment && typeof attachment.state === "string") setMusicCardState(attachment.state); }, [attachment]);
  useEffect(() => { if (attachment?.type === "couple-island-invitation") setCoupleState(attachment.state); }, [attachment]);
  if (!attachment) return <TranslatedMessageText message={message} />;
  if (attachment.type === "music-invitation") {
    const response = attachment.cardRole === "response";
    const state = musicState ?? attachment.state;
    const retry = async () => {
      if (!onInvitationRetry || !attachment.responseTaskEventId || musicBusy) return;
      setMusicBusy(true);
      try { await onInvitationRetry(attachment.responseTaskEventId); }
      finally { setMusicBusy(false); }
    };
    const respond = async (accept: boolean) => {
      if (!onMusicInvitationResponse || musicBusy || state !== "pending") return;
      setMusicBusy(true);
      try { await onMusicInvitationResponse(message.id, accept); setMusicState(accept ? "accepted" : "declined"); }
      finally { setMusicBusy(false); }
    };
    return (
      <div className={"music-invitation-card " + state + (response ? " response" : " invitation")}>
        <button className="music-invitation-main" onClick={() => nav("/music")} aria-label="打开音乐 App">
          <span className="music-invitation-cover">{musicTrack?.coverUrl ? <img src={musicTrack.coverUrl} alt="" /> : <Music2 />}</span>
          <span><small>{response ? "LISTEN RESPONSE" : "一起听邀请"}</small><b>{musicTrack?.title ?? "一起听音乐"}</b><em>{musicTrack?.artists.join(" / ") ?? "打开音乐 App 选择歌曲"}</em></span>
        </button>
        {!response && message.senderType === "character" && state === "pending" && onMusicInvitationResponse ? (
          <div className="music-invitation-actions"><button disabled={musicBusy} onClick={() => void respond(false)}>拒绝</button><button disabled={musicBusy} onClick={() => void respond(true)}>接受</button></div>
        ) : !response && attachment.responseStatus === "failed" ? (
          <footer className="invitation-response-failed"><span>角色回应未完成</span>{attachment.responseTaskEventId && onInvitationRetry ? <button type="button" disabled={musicBusy} onClick={() => void retry()}>重试</button> : null}</footer>
        ) : <footer>{response ? (state === "accepted" ? "已接受 · 正在一起听" : state === "declined" ? attachment.reason || "这次暂时不一起听" : "回应已完成") : state === "accepted" ? "已接受 · 正在一起听" : state === "declined" ? "已拒绝" : state === "ended" ? "一起听已结束" : message.senderType === "user" ? "等待角色回应" : "等待你的回应"}</footer>}
      </div>
    );
  }
  if (attachment.type === "music-search-candidates") {
    const state = musicCardState ?? attachment.state;
    const choose = async (trackId: string) => { if (musicBusy || state !== "pending") return; setMusicBusy(true); try { const result = await selectMusicSearchCandidate(message.id, trackId); if (result.executed) setMusicCardState("selected"); } finally { setMusicBusy(false); } };
    return <div className={"music-dj-card candidates " + state}><header><Music2 /><span><small>角色 DJ 搜索候选</small><b>“{attachment.query}”</b></span></header><div className="music-dj-candidates">{musicTracks.map((track) => <button type="button" key={track.id} disabled={musicBusy || state !== "pending"} onClick={() => void choose(track.id)}><span>{track.coverUrl ? <img src={track.coverUrl} alt="" /> : <Music2 />}</span><span><b>{track.title}</b><small>{track.artists.join(" / ")}</small></span>{attachment.selectedTrackId === track.id ? <em>已选择</em> : null}</button>)}</div><footer>{state === "selected" ? "已加入播放队列" : state === "expired" ? "候选已失效" : "选择一首加入队列"}</footer></div>;
  }
  if (attachment.type === "music-control-proposal") {
    const state = musicCardState ?? attachment.state, label = attachment.control === "pause" ? "暂停播放" : attachment.control === "next" ? "切到下一首" : "清空队列";
    const respond = async (accept: boolean) => { if (musicBusy || state !== "pending") return; setMusicBusy(true); try { const result = await respondMusicControlProposal(message.id, accept); if (result.executed) setMusicCardState(accept ? "accepted" : "declined"); } finally { setMusicBusy(false); } };
    return <div className={"music-dj-card proposal " + state}><header><Music2 /><span><small>播放控制建议</small><b>{label}</b></span></header><p>{attachment.reason}</p>{state === "pending" ? <div className="music-invitation-actions"><button disabled={musicBusy} onClick={() => void respond(false)}>不调整</button><button disabled={musicBusy} onClick={() => void respond(true)}>同意</button></div> : <footer>{state === "accepted" ? "已同意并执行" : state === "declined" ? "已拒绝" : "请求已过期"}</footer>}</div>;
  }
  if (attachment.type === "music-session-summary") {
    return <button type="button" className="music-dj-card summary" onClick={() => nav("/music")}><header><Music2 /><span><small>一起听小结</small><b>{musicTracks.length || attachment.trackIds.length} 首歌 · {Math.max(1, Math.round(attachment.listenedMs / 60000))} 分钟</b></span></header><div className="music-summary-tracks">{musicTracks.slice(0, 4).map((track) => <span key={track.id}>{track.coverUrl ? <img src={track.coverUrl} alt="" /> : <Music2 />}<b>{track.title}</b></span>)}</div>{attachment.closingNote ? <p>{attachment.closingNote}</p> : <footer>角色正在整理这段共同回忆…</footer>}</button>;
  }
  if (attachment.type === "couple-island-invitation") {
    const response = attachment.cardRole === "response";
    const source = attachment.invitedBy ?? (message.senderType === "character" ? "character" : "user");
    const state = coupleState ?? attachment.state;
    const retry = async () => {
      if (!onInvitationRetry || !attachment.responseTaskEventId || coupleBusy) return;
      setCoupleBusy(true);
      try { await onInvitationRetry(attachment.responseTaskEventId); }
      finally { setCoupleBusy(false); }
    };
    const respond = async (decision: "accept" | "decline") => {
      if (!onCoupleIslandInvitationResponse || coupleBusy || state !== "pending") return;
      setCoupleBusy(true);
      try {
        await onCoupleIslandInvitationResponse(message.id, decision);
        setCoupleState(decision === "accept" ? "accepted" : "declined");
      } finally { setCoupleBusy(false); }
    };
    const title = response ? (state === "accepted" ? "茶侣岛已开启" : state === "declined" ? "暂时拒绝" : "回应茶侣岛邀请") : "茶侣岛邀请";
    const status = state === "accepted"
      ? "小岛已经开放，去看看你们的共同角落"
      : state === "declined"
        ? attachment.reason || "这次先不了，之后还可以再次邀请"
        : attachment.responseStatus === "failed"
          ? "角色回应没有完成，可以重新邀请角色回应"
          : source === "character"
            ? "等待你的回应"
            : "邀请已送达，等待角色回应";
    const showCharacterActions = !response && source === "character" && state === "pending" && Boolean(onCoupleIslandInvitationResponse);
    return (
      <div className={`couple-island-invitation-card ${state} ${response ? "response" : "invitation"} source-${source}`}>
        <button type="button" className="couple-island-ticket-main" onClick={() => nav("/couple-island")} aria-label="打开茶侣岛">
          <span className="couple-island-ticket-top"><span className="couple-island-invitation-icon"><HeartHandshake /></span><span><small>COUPLE ISLAND</small><b>{title}</b></span></span>
          <span className="couple-island-ticket-meta"><em>{source === "character" ? "角色发来的登岛票" : "邀请已送达"}</em><i aria-hidden="true">✦</i></span>
          <span className="couple-island-ticket-divider" aria-hidden="true"><i /><i /><i /></span>
          <span className="couple-island-ticket-status"><strong>{state === "accepted" ? "已接受" : state === "declined" ? "暂时拒绝" : source === "character" ? "等待你的回应" : "等待回应"}</strong><em>{status}</em></span>
        </button>
        {showCharacterActions ? <div className="couple-island-ticket-actions" aria-label="茶侣岛邀请操作">
          <button type="button" disabled={coupleBusy} aria-label="先不了" onClick={(event) => { event.stopPropagation(); void respond("decline"); }}>先不了</button>
          <button type="button" disabled={coupleBusy} aria-label="接受登岛" onClick={(event) => { event.stopPropagation(); void respond("accept"); }}>{coupleBusy ? "处理中…" : "接受登岛"}</button>
        </div> : state === "accepted" ? <button type="button" className="couple-island-ticket-enter" onClick={(event) => { event.stopPropagation(); nav("/couple-island"); }}>进入茶侣岛</button> : !response && source === "user" && attachment.responseStatus === "failed" && attachment.responseTaskEventId && onInvitationRetry ? <button type="button" className="couple-island-ticket-retry" disabled={coupleBusy} onClick={(event) => { event.stopPropagation(); void retry(); }}>{coupleBusy ? "重试中…" : "重试角色回应"}</button> : null}
      </div>
    );
  }  if (attachment.type === "sticker") {
    const src = attachment.assetId
      ? assets.get(attachment.assetId)?.data
      : attachment.url;
    return (
      <div className="sticker-message">
        {src ? (
          <img src={src} alt={attachment.name} />
        ) : (
          <span>表情图片已失效</span>
        )}
      </div>
    );
  }
  if (attachment.type === "image") {
    const src = attachment.assetId
      ? assets.get(attachment.assetId)?.data
      : attachment.url;
    return (
      <div className="image-message">
        {src ? (
          <img src={src} alt={attachment.description || "聊天图片"} />
        ) : (
          <span>图片已失效</span>
        )}
        {attachment.description && <small>{attachment.description}</small>}
      </div>
    );
  }
  if (attachment.type === "text-image")
    return (
      <div className="text-image-message">
        <header>
          <ImageIcon />
          <b>分享了一张图片</b>
          <em>文字图片</em>
        </header>
        <p>{attachment.description}</p>
      </div>
    );
  if (attachment.type === "voice") {
    const src = assets.get(attachment.assetId)?.data;
    return (
      <div className="voice-message">
        {src ? (
          <audio controls preload="metadata" src={src} />
        ) : (
          <span>录音已失效</span>
        )}
        <small>
          {displayDuration(attachment.durationMs)} · {attachment.transcript}
        </small>
        {message.translation?.status === "complete" &&
          message.translation.text && (
            <div className="voice-message-translation">
              {message.translation.text}
            </div>
          )}
      </div>
    );
  }
  if (attachment.type === "red-packet")
    return (
      <div className="red-packet-message">
        <header>
          <span>
            <Coins />
          </span>
          <div>
            <b>群聊红包</b>
            <p>{attachment.note}</p>
          </div>
          <strong>¥{(attachment.totalAmountCents / 100).toFixed(2)}</strong>
        </header>
        <div>
          {attachment.claims.map((claim) => {
            const name = claim.participantName ?? claim.characterName ?? "成员",
              id = claim.participantId ?? claim.characterId ?? name;
            return (
              <span key={id}>
                <i>{name.slice(0, 1)}</i>
                <b>{name}</b>
                <em>¥{(claim.amountCents / 100).toFixed(2)}</em>
              </span>
            );
          })}
        </div>
        <footer>
          {attachment.claims.length}/{attachment.packetCount} 个红包已领取
        </footer>
      </div>
    );
  if (attachment.type === "poll") {
    const poll = pollState ?? attachment,
      total = Math.max(1, poll.votes.length),
      userVote = poll.votes.find((vote) => vote.voterType === "user"),
      toggle = async (id: string) => {
        if (poll.createdBy !== "user" || poll.state !== "open") return;
        const next =
          poll.mode === "single"
            ? [id]
            : userVote?.optionIds.includes(id)
              ? userVote.optionIds.filter((value: string) => value !== id)
              : [...(userVote?.optionIds ?? []), id];
        if (!next.length) return;
        const app = await getAppSettings();
        await voteInPoll(message.id, next, app.userName);
        setPollState({
          ...poll,
          votes: [
            ...poll.votes.filter((vote) => vote.voterType !== "user"),
            {
              voterType: "user",
              voterName: app.userName || "我",
              optionIds: next,
              createdAt: Date.now(),
            },
          ],
        });
      };
    return (
      <div className="poll-message">
        <header>
          <Vote />
          <div>
            <b>{poll.question}</b>
            <small>
              {poll.mode === "single" ? "单选" : "多选"} ·{" "}
              {poll.state === "closed" ? "已结束" : "进行中"}
            </small>
          </div>
        </header>
        <div>
          {poll.options.map((option) => {
            const voters = poll.votes.filter((vote) =>
                vote.optionIds.includes(option.id),
              ),
              percent = Math.round((voters.length / total) * 100),
              selected = userVote?.optionIds.includes(option.id);
            return (
              <button
                key={option.id}
                className={selected ? "selected" : ""}
                disabled={poll.createdBy !== "user" || poll.state !== "open"}
                onClick={() => void toggle(option.id)}
              >
                <span>
                  <b>{option.text}</b>
                  <em>
                    {voters.length} 票 · {percent}%
                  </em>
                </span>
                <i>
                  <u style={{ width: `${percent}%` }} />
                </i>
                <small>
                  {voters.map((voter) => voter.voterName).join("、") ||
                    "暂无投票"}
                </small>
              </button>
            );
          })}
        </div>
        {poll.state === "open" && (
          <footer>
            <button
              onClick={async () => {
                await closePoll(message.id);
                setPollState({
                  ...poll,
                  state: "closed",
                  closedAt: Date.now(),
                });
              }}
            >
              结束投票
            </button>
          </footer>
        )}
      </div>
    );
  }
  if (attachment.type === "transfer") {
    const state = transferState ?? attachment.state,
      incoming = attachment.direction === "character-to-user";
    return (
      <div className={"transfer-message " + state}>
        <div className="transfer-main">
          <span className="transfer-icon">
            <WalletCards />
          </span>
          <div className="transfer-copy">
            <b>¥{(attachment.amountCents / 100).toFixed(2)}</b>
            <span>
              {attachment.note || (incoming ? "角色向你转账" : "转账给角色")}
            </span>
          </div>
        </div>
        {incoming && state === "pending" ? (
          <button
            className="transfer-receive"
            onClick={async () => {
              if (await receiveIncomingWalletTransfer(message.id))
                setTransferState("accepted");
            }}
          >
            收款
          </button>
        ) : (
          <small className="transfer-footer">
            MALL 钱包 ·{" "}
            {state === "accepted"
              ? "已收款"
              : state === "refunded"
                ? "已退回"
                : "待确认"}
          </small>
        )}
      </div>
    );
  }
  if (attachment.type === "commerce") {
    const Icon =
      attachment.commerceType === "eats"
        ? UtensilsCrossed
        : attachment.commerceType === "gift"
          ? Gift
          : ShoppingBag;
    return (
      <button
        className={`commerce-message ${attachment.commerceType}`}
        onClick={() => nav(`/mall?tab=orders&order=${attachment.orderId}`)}
      >
        <span>
          <Icon />
        </span>
        <div>
          <small>
            {attachment.direction === "character-to-user"
              ? "角色送给你"
              : "送给角色"}
          </small>
          <b>{attachment.title}</b>
          <p>{attachment.itemNames.join("、")}</p>
          <em>
            {attachment.recipientName} · ¥
            {(attachment.amountCents / 100).toFixed(2)} ·{" "}
            {attachment.status === "delivered" ? "已送达" : "配送中"}
          </em>
        </div>
      </button>
    );
  }
  if (attachment.type === "call")
    return (
      <div className="call-event-message">
        <Phone />
        <div>
          <b>{attachment.callType === "video" ? "视频通话" : "语音通话"}</b>
          <span>{displayDuration(attachment.durationMs)}</span>
          <small>{attachment.summary}</small>
        </div>
      </div>
    );
  if (attachment.type === "meet-event")
    return (
      <button
        className="meet-message-card"
        onClick={() => nav(`/meet/${attachment.sessionId}`)}
      >
        <Coffee />
        <div>
          <b>见面记录</b>
          <span>{displayDuration(attachment.durationMs)}</span>
          <small>{attachment.summary}</small>
        </div>
      </button>
    );
  if (attachment.type === "meet-invitation")
    return (
      <div className="meet-message-card invitation">
        <CalendarDays />
        <div>
          <b>见面邀请</b>
          <span>
            {attachment.state === "pending"
              ? "等待回应"
              : attachment.state === "accepted"
                ? "已接受"
                : attachment.state === "declined"
                  ? "暂不"
                  : "已过期"}
          </span>
          <small>{attachment.invitationText}</small>
          {attachment.state === "pending" ? (
            <span className="meet-invite-actions">
              <button
                onClick={async () => {
                  const session = await respondMeetInvitation(message.id, true);
                  if (session) nav(`/meet/${session.id}`);
                }}
              >
                接受
              </button>
              <button
                onClick={() => void respondMeetInvitation(message.id, false)}
              >
                暂不
              </button>
            </span>
          ) : (
            attachment.sessionId && (
              <button
                className="meet-open-record"
                onClick={() => nav(`/meet/${attachment.sessionId}`)}
              >
                打开见面
              </button>
            )
          )}
        </div>
      </div>
    );
  return <>{message.content}</>;
}
export function CameraChoice({
  onAlbum,
  onCamera,
}: {
  onAlbum: () => void;
  onCamera: () => void;
}) {
  return (
    <div className="camera-choice">
      <button onClick={onAlbum}>
        <ImageIcon />
        从相册选择
      </button>
      <button onClick={onCamera}>
        <Camera />
        拍照
      </button>
    </div>
  );
}

export function PhotoPanel({
  onSend,
  onClose,
}: {
  onSend: (
    asset: MediaAsset,
    description: string,
    visionMode: "image" | "description",
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [description, setDescription] = useState(""),
    [visionMode, setVisionMode] = useState<"image" | "description">("image"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    album = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const choose = (next?: File) => {
    if (!next) return;
    if (!next.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
    setError("");
  };
  const send = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const asset = await saveImageMedia(file, "chat-image");
      await onSend(asset, description.trim(), visionMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片发送失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <div className="sheet-head">
        <div>
          <small>PHOTO</small>
          <h2>发送照片</h2>
        </div>
        <button onClick={onClose} disabled={busy}>
          <X />
        </button>
      </div>
      {preview ? (
        <div className="photo-compose">
          <img src={preview} alt="照片预览" />
          <button
            className="photo-clear"
            onClick={() => {
              URL.revokeObjectURL(preview);
              setPreview("");
              setFile(null);
            }}
          >
            重新选择
          </button>
        </div>
      ) : (
        <CameraChoice
          onAlbum={() => album.current?.click()}
          onCamera={() => camera.current?.click()}
        />
      )}
      <input
        hidden
        ref={album}
        type="file"
        accept="image/*"
        onChange={(e) => choose(e.target.files?.[0])}
      />
      <input
        hidden
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => choose(e.target.files?.[0])}
      />
      <label className="media-description">
        图片说明
        <textarea
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="可选，帮助角色理解图片"
        />
      </label>
      <label className="switch-row">
        <span>
          <b>让角色查看图片</b>
          <small>关闭后仅把上面的文字说明加入上下文</small>
        </span>
        <input
          type="checkbox"
          checked={visionMode === "image"}
          onChange={(e) =>
            setVisionMode(e.target.checked ? "image" : "description")
          }
        />
      </label>
      {error && <p className="media-error">{error}</p>}
      <button
        className="primary"
        disabled={
          !file || busy || (visionMode === "description" && !description.trim())
        }
        onClick={send}
      >
        {busy ? "正在压缩…" : "发送照片"}
      </button>
    </Modal>
  );
}
export function VoicePanel({
  onSend,
  onClose,
}: {
  onSend: (asset: MediaAsset, transcript: string) => Promise<void>;
  onClose: () => void;
}) {
  const [recording, setRecording] = useState(false),
    [startedAt, setStartedAt] = useState(0),
    [elapsed, setElapsed] = useState(0),
    [blob, setBlob] = useState<Blob | null>(null),
    [preview, setPreview] = useState(""),
    [transcript, setTranscript] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    chunks = useRef<Blob[]>([]),
    timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.state !== "inactive" && recorder.current?.stop();
      stream.current?.getTracks().forEach((x) => x.stop());
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const start = async () => {
    setError("");
    setBlob(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview("");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error("当前浏览器不支持录音");
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (x) => MediaRecorder.isTypeSupported(x),
      );
      const r = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
      recorder.current = r;
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const result = new Blob(chunks.current, {
          type: r.mimeType || "audio/webm",
        });
        setBlob(result);
        setPreview(URL.createObjectURL(result));
        setRecording(false);
        stream.current?.getTracks().forEach((x) => x.stop());
        if (timer.current) clearInterval(timer.current);
      };
      const startTime = Date.now();
      setStartedAt(startTime);
      setElapsed(0);
      setRecording(true);
      r.start(250);
      timer.current = setInterval(() => {
        const next = Date.now() - startTime;
        setElapsed(next);
        if (next >= MAX_VOICE_DURATION_MS) stop();
      }, 200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法开始录音");
    }
  };
  const send = async () => {
    if (!blob || !transcript.trim()) return;
    setBusy(true);
    try {
      const asset = await saveVoiceMedia(
        blob,
        Math.min(
          MAX_VOICE_DURATION_MS,
          Math.max(1, elapsed || Date.now() - startedAt),
        ),
      );
      await onSend(asset, transcript.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "语音发送失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={recording || busy ? () => {} : onClose}>
      <div className="sheet-head">
        <div>
          <small>VOICE</small>
          <h2>录制语音</h2>
        </div>
        <button onClick={onClose} disabled={recording || busy}>
          <X />
        </button>
      </div>
      <div className="voice-recorder">
        <div className={recording ? "recording" : ""}>
          <Mic />
          <b>{displayDuration(elapsed)}</b>
          <small>
            {recording
              ? "正在录音，最长 60 秒"
              : blob
                ? "录音完成，可试听后发送"
                : "点击开始录音"}
          </small>
        </div>
        {preview && <audio controls src={preview} />}
        <button
          className={recording ? "stop-record" : "start-record"}
          onClick={recording ? stop : start}
        >
          {recording ? "停止录音" : blob ? "重新录制" : "开始录音"}
        </button>
      </div>
      <label className="media-description">
        语音文字
        <textarea
          maxLength={500}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="必须填写，角色会通过这段文字理解语音"
        />
      </label>
      {error && <p className="media-error">{error}</p>}
      <button
        className="primary"
        disabled={!blob || !transcript.trim() || busy || recording}
        onClick={send}
      >
        {busy ? "正在保存…" : "发送语音"}
      </button>
    </Modal>
  );
}

export function TransferPanel({
  onSend,
  onClose,
}: {
  onSend: (amountCents: number, note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    value = Number(amount),
    valid =
      Number.isFinite(value) &&
      value >= 0.01 &&
      value <= 999999.99 &&
      /^\d+(?:\.\d{1,2})?$/.test(amount);
  const send = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onSend(Math.round(value * 100), note.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <div className="sheet-head">
        <div>
          <small>TRANSFER</small>
          <h2>转账</h2>
        </div>
        <button onClick={onClose} disabled={busy}>
          <X />
        </button>
      </div>
      <div className="transfer-compose">
        <label>
          金额
          <div>
            <span>¥</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) =>
                setAmount(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="0.00"
            />
          </div>
        </label>
        <label>
          备注
          <input
            maxLength={80}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="选填"
          />
        </label>
        <p>金额范围 ¥0.01–¥999999.99</p>
        <button className="primary" disabled={!valid || busy} onClick={send}>
          {busy ? "正在发送…" : "确认转账"}
        </button>
      </div>
    </Modal>
  );
}



