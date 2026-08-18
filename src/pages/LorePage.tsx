import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, FolderCog, LibraryBig, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { LoreBookCover } from "../components/LoreBookCover";
import { LoreMountFields } from "../components/LoreMountFields";
import { Empty, Modal } from "../components/ui";
import { changeLoreImportMode, evaluateLore, LORE_DOCUMENT_ACCEPT, readLoreImportFile, type LoreImportMode, type LoreImportPreview } from "../core/lore";
import { createLoreBook, importLoreBooks } from "../core/loreStorage";
import { deleteLoreShelfGroup, ensureLoreShelfGroup, getLoreShelfGroups, renameLoreShelfGroup } from "../core/loreShelfGroups";
import { useStore } from "../core/store";
import { now, SCHEMA_VERSION, uid, type LoreBook, type LoreMount, type LoreShelfGroup } from "../core/types";

const emptyMount = (): LoreMount => ({ mode: "none", characterIds: [], conversationIds: [] });
type LibraryView = "shelf" | "tester";

export default function LorePage() {
  const nav = useNavigate(), fileRef = useRef<HTMLInputElement>(null);
  const { loreBooks, characters, conversations, reload } = useStore();
  const [view, setView] = useState<LibraryView>("shelf"), [open, setOpen] = useState(false), [name, setName] = useState(""), [description, setDescription] = useState(""), [mount, setMount] = useState<LoreMount>(emptyMount());
  const [search, setSearch] = useState(""), [status, setStatus] = useState<"all" | "enabled" | "disabled">("all"), [test, setTest] = useState(""), [characterId, setCharacterId] = useState(characters[0]?.id ?? ""), [conversationId, setConversationId] = useState(conversations[0]?.id ?? "");
  const [preview, setPreview] = useState<LoreImportPreview | null>(null), [importMount, setImportMount] = useState<LoreMount>(emptyMount()), [error, setError] = useState("");
  const [groups, setGroups] = useState<LoreShelfGroup[]>([]), [groupId, setGroupId] = useState(""), [importGroupId, setImportGroupId] = useState(""), [newGroupName, setNewGroupName] = useState(""), [importNewGroupName, setImportNewGroupName] = useState("");
  const [groupManagerOpen, setGroupManagerOpen] = useState(false), [renameId, setRenameId] = useState(""), [renameText, setRenameText] = useState("");

  const loadGroups = async () => setGroups(await getLoreShelfGroups());
  useEffect(() => { void loadGroups(); }, []);

  const validMount = (value: LoreMount) => value.mode !== "selected" || Boolean(value.characterIds.length || value.conversationIds.length);
  const resolveGroup = async (selected: string, freshName: string) => {
    if (!freshName.trim()) return selected || undefined;
    const group = await ensureLoreShelfGroup(freshName);
    await loadGroups();
    return group.id;
  };
  const create = async () => {
    if (!name.trim() || !validMount(mount)) return;
    const t = now(), id = uid();
    try {
      const shelfGroupId = await resolveGroup(groupId, newGroupName);
      await createLoreBook({ id, schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t, name: name.trim(), description: description.trim(), entries: [], enabled: true, mount, shelfGroupId, triggerSettings: { defaultScanDepth: 20 } });
      await reload(); setOpen(false); setName(""); setDescription(""); setMount(emptyMount()); setGroupId(""); setNewGroupName(""); nav(`/lore/${id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建世界书失败"); }
  };
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return loreBooks.filter((book) => (status === "all" || (status === "enabled" ? book.enabled : !book.enabled)) && (!query || [book.name, book.description, ...book.entries.flatMap((entry) => [entry.title ?? "", entry.content, ...entry.keywords])].some((value) => value.toLocaleLowerCase().includes(query))));
  }, [loreBooks, search, status]);
  const shelves = useMemo(() => {
    const rows = groups.map((group) => ({ key: group.id, title: group.name, books: filtered.filter((book) => book.shelfGroupId === group.id) }));
    const ungrouped = filtered.filter((book) => !book.shelfGroupId || !groups.some((group) => group.id === book.shelfGroupId));
    if (ungrouped.length) rows.push({ key: "ungrouped", title: "未分组", books: ungrouped });
    return rows.filter((row) => row.books.length || (!search && status === "all"));
  }, [filtered, groups, search, status]);
  const selectedCharacter = characters.find((item) => item.id === characterId), selectedConversation = conversations.find((item) => item.id === conversationId);
  const decisions = test && selectedCharacter && selectedConversation ? evaluateLore({ books: loreBooks, texts: [test], characterId, conversationId, character: selectedCharacter, conversation: selectedConversation, seed: test }) : [];
  const handleFile = async (file?: File) => {
    if (!file) return;
    try { setPreview(await readLoreImportFile(file)); setImportMount(emptyMount()); setImportGroupId(""); setImportNewGroupName(""); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "导入失败"); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  };
  const confirmImport = async () => {
    if (!preview || !validMount(importMount)) return;
    try {
      const shelfGroupId = await resolveGroup(importGroupId, importNewGroupName);
      const created = await importLoreBooks(preview.books, importMount, shelfGroupId);
      await reload(); setPreview(null); if (created.length === 1) nav(`/lore/${created[0].id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); }
  };
  const renameGroup = async () => {
    if (!renameId || !renameText.trim()) return;
    try { await renameLoreShelfGroup(renameId, renameText); setRenameId(""); setRenameText(""); await loadGroups(); }
    catch (e) { setError(e instanceof Error ? e.message : "重命名失败"); }
  };
  const removeGroup = async (group: LoreShelfGroup) => {
    if (!window.confirm(`删除分组“${group.name}”？其中的世界书会移到“未分组”。`)) return;
    await deleteLoreShelfGroup(group.id); await reload(); await loadGroups();
  };

  return <div className="app-page lore-page lore-library-page">
    <header className="lore-library-header"><button type="button" className="lore-header-back" aria-label="返回桌面" onClick={() => nav("/")}><ArrowLeft /></button><nav aria-label="世界书视图"><button className={view === "shelf" ? "active" : ""} onClick={() => setView("shelf")}>书架</button><button className={view === "tester" ? "active" : ""} onClick={() => setView("tester")}>命中测试</button></nav>{view === "shelf" ? <button className="lore-header-add" aria-label="新建世界书" onClick={() => setOpen(true)}><Plus /></button> : <span className="lore-header-spacer" />}</header>
    <input ref={fileRef} className="lore-document-input" hidden type="file" accept={LORE_DOCUMENT_ACCEPT} onChange={(event) => void handleFile(event.target.files?.[0])} />
    {view === "shelf" ? loreBooks.length ? <>
      <label className="lore-library-search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索世界书" />{search && <button aria-label="清空搜索" onClick={() => setSearch("")}><X /></button>}</label>
      <div className="lore-library-manage"><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="enabled">仅已启用</option><option value="disabled">仅已停用</option></select><button onClick={() => fileRef.current?.click()}><Upload />导入文档</button><button onClick={() => setGroupManagerOpen(true)}><FolderCog />管理分组</button></div>
      {error && <p className="form-error lore-page-error">{error}</p>}<div className="lore-library-count">共 {filtered.length} 本世界书</div>
      {shelves.length ? <div className="lore-shelves">{shelves.map((shelf) => <section className="lore-shelf" key={shelf.key}><header><h2>{shelf.title}</h2><span>全部 {shelf.books.length} 本 <ChevronRight /></span></header><div className="lore-shelf-track" aria-label={`${shelf.title}书架`}>{shelf.books.map((book) => <button key={book.id} className="lore-shelf-book" onClick={() => nav(`/lore/${book.id}`)} aria-label={`打开世界书 ${book.name}`}><LoreBookCover book={book} /></button>)}{!shelf.books.length && <div className="lore-empty-shelf">这个分组还没有世界书</div>}</div><div className="lore-shelf-board" /></section>)}</div> : <Empty icon={<Search size={38} />} title="没有符合条件的世界书" text="尝试清空搜索或更换筛选条件。" />}
    </> : <>{error && <p className="form-error lore-page-error">{error}</p>}<div className="lore-library-empty"><LibraryBig /><h3>书架还是空的</h3><p>创建第一本世界书，或从 TXT、DOCX 文档导入已有设定。</p><div className="lore-library-empty-actions"><button type="button" onClick={() => setOpen(true)}><Plus />新建世界书</button><button type="button" className="secondary" onClick={() => fileRef.current?.click()}><Upload />导入文档</button><button type="button" className="secondary" onClick={() => setGroupManagerOpen(true)}><FolderCog />管理分组</button></div></div></> : <section className="lore-tester lore-tester-library"><div><Search /><b>关键词命中测试</b></div><p>测试内容仅在本地处理，不会调用模型或保存。</p><textarea value={test} onChange={(event) => setTest(event.target.value)} rows={4} placeholder="输入一段对话，查看条目命中与跳过原因…" /><div className="tester-scope"><select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>{characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select><select value={conversationId} onChange={(event) => setConversationId(event.target.value)}>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select></div>{!characters.length || !conversations.length ? <div className="inside-empty"><BookOpen size={32} /><p>创建角色和会话后即可测试实际挂载范围。</p></div> : test && <div className="match-results lore-decisions">{decisions.map((item) => <article key={`${item.bookId}-${item.id}`} className={item.injected ? "matched" : "skipped"}><i>{item.order ?? "—"}</i><div><b>{item.title || "未命名条目"}</b><small>{item.bookName} · {item.injected ? `已注入 ${item.estimatedChars} 字，剩余 ${item.remainingBudget}` : item.reason}</small></div></article>)}</div>}</section>}

    {open && <Modal onClose={() => setOpen(false)}><div className="sheet-head"><div><small>NEW LORE BOOK</small><h2>新建世界书</h2></div><button onClick={() => setOpen(false)}><X /></button></div><div className="simple-form"><label>名称 *<input autoFocus value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="例如：雾港市" /></label><label>简介<textarea rows={3} value={description} maxLength={160} onChange={(event) => setDescription(event.target.value)} placeholder="这个世界书包含哪些设定？" /></label><LoreGroupPicker groups={groups} value={groupId} newName={newGroupName} onValue={setGroupId} onNewName={setNewGroupName} /><LoreMountFields value={mount} onChange={setMount} characters={characters} conversations={conversations} />{mount.mode === "selected" && !validMount(mount) && <p className="form-error">至少选择一个角色或群聊。</p>}<button className="primary" disabled={!name.trim() || !validMount(mount)} onClick={() => void create()}>创建世界书</button></div></Modal>}
    {preview && <Modal onClose={() => setPreview(null)}><div className="sheet-head"><button type="button" className="lore-import-back" aria-label="返回世界书" onClick={() => setPreview(null)}><ArrowLeft /></button><div><small>IMPORT LORE</small><h2>导入预览</h2></div><button onClick={() => setPreview(null)}><X /></button></div><div className="simple-form lore-import-preview"><p>格式：{preview.format.toUpperCase()} · {preview.books.length} 本世界书 · {preview.entryCount} 个条目</p><fieldset className="lore-import-mode"><legend>条目生成方式</legend>{(["single", "headings"] as LoreImportMode[]).map((mode) => <button type="button" key={mode} className={preview.mode === mode ? "active" : ""} onClick={() => setPreview(changeLoreImportMode(preview, mode))}><b>{mode === "single" ? "整篇一个条目" : "按标题拆分"}</b><small>{mode === "single" ? "保留全文和段落，推荐普通文档" : "仅识别 Word、Markdown 或“标题：”结构"}</small></button>)}</fieldset>{preview.books.map((book) => <article key={book.id}><b>{book.name}</b><small>{book.entries.length} 个条目 · {book.entries.map((entry) => `${entry.title || "文档正文"}（${entry.content.length} 字）`).join("、")}</small></article>)}{preview.warnings.length > 0 && <div className="import-warnings"><b>导入提示</b>{preview.warnings.map((warning, index) => <small key={index}>{warning}</small>)}</div>}<LoreGroupPicker groups={groups} value={importGroupId} newName={importNewGroupName} onValue={setImportGroupId} onNewName={setImportNewGroupName} /><LoreMountFields value={importMount} onChange={setImportMount} characters={characters} conversations={conversations} />{importMount.mode === "selected" && !validMount(importMount) && <p className="form-error">至少选择一个角色或群聊。</p>}<button className="primary" disabled={!validMount(importMount)} onClick={() => void confirmImport()}>确认导入</button></div></Modal>}
    {groupManagerOpen && <Modal onClose={() => setGroupManagerOpen(false)}><div className="sheet-head"><div><small>BOOK SHELVES</small><h2>管理分组</h2></div><button onClick={() => setGroupManagerOpen(false)}><X /></button></div><div className="lore-group-manager">{groups.map((group) => <article key={group.id}>{renameId === group.id ? <input autoFocus value={renameText} maxLength={30} onChange={(event) => setRenameText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void renameGroup(); }} /> : <span><b>{group.name}</b><small>{loreBooks.filter((book) => book.shelfGroupId === group.id).length} 本世界书</small></span>}<button aria-label={`重命名${group.name}`} onClick={() => { if (renameId === group.id) void renameGroup(); else { setRenameId(group.id); setRenameText(group.name); } }}><Pencil /></button><button aria-label={`删除${group.name}`} onClick={() => void removeGroup(group)}><Trash2 /></button></article>)}<LoreGroupCreator onCreate={async (value) => { const group=await ensureLoreShelfGroup(value); await loadGroups(); return group.name; }} /></div></Modal>}
  </div>;
}

function LoreGroupPicker({ groups, value, newName, onValue, onNewName }: { groups: LoreShelfGroup[]; value: string; newName: string; onValue: (value: string) => void; onNewName: (value: string) => void }) {
  return <fieldset className="lore-group-picker"><legend>书架分组</legend><select value={newName ? "new" : value} onChange={(event) => { if (event.target.value === "new") { onValue(""); onNewName("新分组"); } else { onNewName(""); onValue(event.target.value); } }}><option value="">未分组</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}<option value="new">＋ 新建分组</option></select>{newName && <input value={newName} maxLength={30} onChange={(event) => onNewName(event.target.value)} placeholder="输入新分组名称" />}</fieldset>;
}

function LoreGroupCreator({ onCreate }: { onCreate: (name: string) => Promise<string | void> }) {
  const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ok:boolean;text:string}|null>(null);
  const submit=async()=>{
    if(!value.trim()||busy)return;
    setBusy(true);setMessage(null);
    try{
      const created=await onCreate(value);
      setMessage({ok:true,text:`已创建分组“${created||value.trim()}”`});
      setValue("");
    }catch(error){
      setMessage({ok:false,text:error instanceof Error?error.message:"创建分组失败"});
    }finally{setBusy(false)}
  };
  return <div className="lore-group-create"><input value={value} maxLength={30} onChange={(event) => setValue(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void submit()}}} placeholder="新分组名称" /><button type="button" disabled={busy || !value.trim()} onClick={() => void submit()}><Plus />{busy?"创建中…":"新建分组"}</button>{message&&<small className={message.ok?"success":"error"}>{message.text}</small>}</div>;
}
