/* Think BS — 株式会社BSサービス アイデアメモアプリ
 * データは端末内(IndexedDB)に保存し、Googleドライブの「Think BS」フォルダと同期する。
 *   Think BS/thinkbs-data.json … すべてのアイデア(文字情報)
 *   Think BS/img_<id>.jpg       … 画像(1枚1ファイル)
 */
(function () {
"use strict";

const CFG = window.THINKBS_CONFIG || {};
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Think BS";
const DATA_NAME = "thinkbs-data.json";
const DRIVE = "https://www.googleapis.com/drive/v3/";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const TOMBSTONE_DAYS = 180;

/* ---------- 端末内の保存(IndexedDB) ---------- */
const store = {
  db: null, mem: { ideas: {}, images: {}, meta: {} },
  open() {
    return new Promise(res => {
      try {
        const r = indexedDB.open("thinkbs", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore("ideas", { keyPath: "id" });
          d.createObjectStore("images", { keyPath: "id" });
          d.createObjectStore("meta");
        };
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch (e) { res(); }
    });
  },
  tx(name, mode, fn) {
    return new Promise(res => {
      try {
        const t = this.db.transaction(name, mode); const s = t.objectStore(name); const r = fn(s);
        t.oncomplete = () => res(r && r.result); t.onerror = () => res(undefined);
      } catch (e) { res(undefined); }
    });
  },
  async allIdeas() { if (!this.db) return Object.values(this.mem.ideas); return (await this.tx("ideas", "readonly", s => s.getAll())) || []; },
  async putIdea(i) { if (!this.db) { this.mem.ideas[i.id] = i; return; } await this.tx("ideas", "readwrite", s => s.put(i)); },
  async delIdea(id) { if (!this.db) { delete this.mem.ideas[id]; return; } await this.tx("ideas", "readwrite", s => s.delete(id)); },
  async replaceIdeas(list) {
    if (!this.db) { this.mem.ideas = {}; list.forEach(i => this.mem.ideas[i.id] = i); return; }
    await this.tx("ideas", "readwrite", s => { s.clear(); list.forEach(i => s.put(i)); });
  },
  async getImg(id) { if (!this.db) return this.mem.images[id]; return this.tx("images", "readonly", s => s.get(id)); },
  async putImg(o) { if (!this.db) { this.mem.images[o.id] = o; return; } await this.tx("images", "readwrite", s => s.put(o)); },
  async delImg(id) { if (!this.db) { delete this.mem.images[id]; return; } await this.tx("images", "readwrite", s => s.delete(id)); },
  async get(k) { if (!this.db) return this.mem.meta[k]; return this.tx("meta", "readonly", s => s.get(k)); },
  async set(k, v) { if (!this.db) { this.mem.meta[k] = v; return; } await this.tx("meta", "readwrite", s => s.put(v, k)); }
};

/* ---------- 状態 ---------- */
const DEFAULT_FOLDERS = ["新製品開発", "修理・現場記録", "楽天企画", "その他"];
const S = { ideas: [], folders: [], folderLog: {}, deleted: {}, trash: [], view: "card", folder: "all", tag: null, q: "" };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmt = t => { const d = new Date(t); return d.getFullYear() + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0"); };
const hm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
const byId = id => S.ideas.find(i => i.id === id);
const imgCache = new Map(); // 画像id → dataURL(表示用)

async function saveMeta() {
  await store.set("folders", S.folders);
  await store.set("folderLog", S.folderLog);
  await store.set("deleted", S.deleted);
  await store.set("trash", S.trash);
}

/* ---------- 起動 ---------- */
async function init() {
  await store.open();
  S.ideas = (await store.allIdeas()).map(normalize);
  S.folders = (await store.get("folders")) || DEFAULT_FOLDERS.slice();
  S.folderLog = (await store.get("folderLog")) || {};
  S.deleted = (await store.get("deleted")) || {};
  S.trash = (await store.get("trash")) || [];
  S.view = (await store.get("view")) || "card";
  token = (await store.get("token")) || null;
  render();
  setupAuth();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
function normalize(i) {
  return {
    id: i.id, title: i.title || "", memo: i.memo || "", folder: i.folder || "その他",
    tags: Array.isArray(i.tags) ? i.tags : [],
    images: (i.images || []).map(m => typeof m === "string" ? { id: m, driveId: null } : { id: m.id, driveId: m.driveId || null }),
    related: Array.isArray(i.related) ? i.related : [],
    createdAt: i.createdAt || Date.now(), updatedAt: i.updatedAt || Date.now(),
    syncAt: i.syncAt || i.updatedAt || Date.now()
  };
}

/* ---------- 一覧の描画 ---------- */
function allTags() {
  const m = new Map(); S.ideas.forEach(i => i.tags.forEach(t => m.set(t, (m.get(t) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
}
function folderList() {
  const set = new Set(S.folders); S.ideas.forEach(i => set.add(i.folder)); return [...set];
}
function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.ideas.filter(i => (S.folder === "all" || i.folder === S.folder) && (!S.tag || i.tags.includes(S.tag)) &&
    (!q || [i.title, i.memo, i.folder, ...i.tags].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function render() {
  $("vCard").setAttribute("aria-pressed", S.view === "card"); $("vList").setAttribute("aria-pressed", S.view === "list");
  const cnt = f => S.ideas.filter(i => f === "all" || i.folder === f).length;
  const fl = ["all", ...folderList()];
  if (S.folder !== "all" && !fl.includes(S.folder)) S.folder = "all";
  $("folders").innerHTML = fl.map(f => `<button type="button" data-folder="${esc(f)}" aria-current="${S.folder === f}"><span>${f === "all" ? "すべて" : esc(f)}</span><span class="n">${cnt(f)}</span></button>`).join("");
  $("mFolders").innerHTML = fl.map(f => `<button type="button" class="chip" data-folder="${esc(f)}" aria-pressed="${S.folder === f}">${f === "all" ? "すべて" : esc(f)} ${cnt(f)}</button>`).join("")
    + `<button type="button" class="chip" data-manage-folders>✎ フォルダ編集</button>`;
  const tags = allTags();
  if (S.tag && !tags.some(([t]) => t === S.tag)) S.tag = null;
  const tagBtns = tags.map(([t]) => `<button type="button" class="chip tag" data-tag="${esc(t)}" aria-pressed="${S.tag === t}">${esc(t)}</button>`).join("");
  $("tags").innerHTML = tagBtns || `<span class="hint">タグはまだありません</span>`;
  $("mTags").innerHTML = tagBtns;
  $("tagList").innerHTML = tags.map(([t]) => `<option value="${esc(t)}">`).join("");
  $("heading").textContent = S.folder === "all" ? "すべてのアイデア" : S.folder;
  const list = filtered();
  $("count").textContent = list.length + "件";
  const af = [];
  if (S.tag) af.push(`<button type="button" class="chip" data-clear="tag">#${esc(S.tag)} ✕</button>`);
  if (S.q) af.push(`<button type="button" class="chip" data-clear="q">「${esc(S.q)}」 ✕</button>`);
  $("activeFilters").innerHTML = af.join("");

  if (!list.length) {
    $("items").innerHTML = `<div class="empty">${S.ideas.length
      ? "条件に合うアイデアがありません。検索語やタグを変えてみてください。"
      : "まだアイデアがありません。<br>右下の「新規」から、写真またはメモで登録してください。"}</div>`;
    return;
  }
  if (S.view === "card") {
    $("items").innerHTML = `<div class="grid">` + list.map(i => `
      <button type="button" class="card" data-open="${i.id}">
        <div class="cardbody">
          <div class="cardtop">${i.images.length ? `<span class="flag">画像${i.images.length}枚</span>` : ""}</div>
          <h3>${esc(i.title)}</h3>
          ${i.memo ? `<p class="excerpt">${esc(i.memo)}</p>` : ""}
          <div class="meta">${i.tags.slice(0, 4).map(t => `<span class="chip tag">${esc(t)}</span>`).join("")}</div>
          <div class="meta"><span class="folderpill">${esc(i.folder)}</span><span class="date">${fmt(i.updatedAt)}</span></div>
        </div></button>`).join("") + `</div>`;
  } else {
    $("items").innerHTML = `<div class="list">` + list.map(i => `
      <button type="button" class="row" data-open="${i.id}">
        <div class="info"><h3>${esc(i.title)}</h3><p>${esc(i.memo.replace(/\n/g, " "))}</p></div>
        <div class="rowmeta"><span class="folderpill">${esc(i.folder)}</span><span><span class="date">${fmt(i.updatedAt)}</span>${i.images.length ? ` ・画像${i.images.length}` : ""}</span></div>
      </button>`).join("") + `</div>`;
  }
}

/* ---------- 一覧の操作 ---------- */
document.addEventListener("click", e => {
  const f = e.target.closest("[data-folder]"); if (f) { S.folder = f.dataset.folder; render(); return; }
  const t = e.target.closest("[data-tag]"); if (t) { S.tag = S.tag === t.dataset.tag ? null : t.dataset.tag; render(); return; }
  const c = e.target.closest("[data-clear]"); if (c) { if (c.dataset.clear === "tag") S.tag = null; else { S.q = ""; $("q").value = ""; } render(); return; }
  const mf = e.target.closest("[data-manage-folders]"); if (mf) { openFolderManager(); return; }
  const o = e.target.closest("[data-open]"); if (o) { openDetail(o.dataset.open); return; }
  const x = e.target.closest("[data-close]"); if (x) { closeOverlay(x.closest(".overlay")); }
});
function closeOverlay(ov) { if (!ov) return; ov.hidden = true; if (ov.id === "ovEdit") stopMic(); }
$("q").addEventListener("input", e => { S.q = e.target.value; render(); });
$("vCard").onclick = () => { S.view = "card"; store.set("view", "card"); render(); };
$("vList").onclick = () => { S.view = "list"; store.set("view", "list"); render(); };
document.querySelectorAll(".overlay").forEach(ov => ov.addEventListener("mousedown", e => { if (e.target === ov) closeOverlay(ov); }));
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("lb").hidden) { $("lb").hidden = true; return; }
  const open = [...document.querySelectorAll(".overlay")].reverse().find(o => !o.hidden); closeOverlay(open);
});

/* ---------- 新規 ---------- */
$("fab").onclick = () => { $("ovChoice").hidden = false; };
$("chMemo").onclick = () => { $("ovChoice").hidden = true; openEditor(null, []); setTimeout(() => $("fTitle").focus(), 60); };
$("chPhoto").onclick = () => { $("filePick").value = ""; $("filePick").click(); };
$("filePick").addEventListener("change", async e => {
  const files = [...e.target.files]; if (!files.length) return;
  if (files.length > 3) toast("画像は1件につき3枚までです。最初の3枚を使います");
  $("ovChoice").hidden = true;
  const imgs = (await compressAll(files.slice(0, 3))).map(data => ({ id: uid(), driveId: null, data }));
  openEditor(null, imgs);
});

/* ---------- 画像 ---------- */
function compress(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const max = 1600; let w = img.naturalWidth, h = img.naturalHeight; const r = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * r); h = Math.round(h * r);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url); res(cv.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
async function compressAll(files) { const out = []; for (const f of files) { const d = await compress(f); if (d) out.push(d); else toast("読み込めない画像がありました"); } return out; }

// 表示用に画像を取り出す。端末にあればそれを、なければGoogleドライブから取ってきて端末に残す。
async function loadImage(im) {
  if (imgCache.has(im.id)) return imgCache.get(im.id);
  const local = await store.getImg(im.id);
  if (local && local.data) { imgCache.set(im.id, local.data); return local.data; }
  if (im.driveId && tokenValid() && navigator.onLine) {
    try {
      const r = await api(`files/${im.driveId}?alt=media`);
      const data = await blobToDataURL(await r.blob());
      await store.putImg({ id: im.id, data }); imgCache.set(im.id, data); return data;
    } catch (e) { return null; }
  }
  return null;
}
function blobToDataURL(b) { return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); }
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

/* ---------- 編集 ---------- */
let E = null;
async function openEditor(id, newImages) {
  const src = id ? byId(id) : null;
  E = {
    id,
    images: src ? src.images.map(m => ({ ...m, data: imgCache.get(m.id) || null })) : newImages.slice(0, 3),
    tags: src ? [...src.tags] : (S.tag ? [S.tag] : []),
    related: src ? [...src.related] : []
  };
  $("edTitle").textContent = id ? "アイデアを編集" : "アイデアを登録";
  $("fTitle").value = src ? src.title : ""; $("fMemo").value = src ? src.memo : ""; $("fTag").value = "";
  const cur = src ? src.folder : (S.folder !== "all" ? S.folder : folderList()[0]);
  $("fFolder").innerHTML = folderList().map(f => `<option ${f === cur ? "selected" : ""}>${esc(f)}</option>`).join("") + `<option value="__new">+ 新しいフォルダ</option>`;
  $("newFolderWrap").hidden = true; $("fNewFolder").value = "";
  $("edDelete").hidden = !id;
  drawSlots(); drawTags(); drawRel();
  $("ovDetail").hidden = true; $("ovEdit").hidden = false;
  // 未取得の画像を読み込む
  if (src) for (const m of E.images) if (!m.data) { m.data = await loadImage(m); drawSlots(); }
}
$("fFolder").onchange = e => { $("newFolderWrap").hidden = e.target.value !== "__new"; if (e.target.value === "__new") $("fNewFolder").focus(); };
function drawSlots() {
  let h = "";
  for (let k = 0; k < 3; k++) {
    const m = E.images[k];
    if (m) h += `<div class="slot">${m.data ? `<img src="${m.data}" alt="画像${k + 1}">` : `<span>画像${k + 1}<br>(読み込み中)</span>`}<button type="button" class="rm" data-rm="${k}">✕ 外す</button></div>`;
    else if (k === E.images.length) h += `<button type="button" class="slot" id="addImg"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>画像を追加</button>`;
    else h += `<div class="slot" aria-hidden="true"></div>`;
  }
  $("slots").innerHTML = h;
  const add = $("addImg"); if (add) add.onclick = () => { $("fileAdd").value = ""; $("fileAdd").click(); };
  $("slots").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { E.images.splice(+b.dataset.rm, 1); drawSlots(); });
}
$("fileAdd").addEventListener("change", async e => {
  const room = 3 - E.images.length; const files = [...e.target.files].slice(0, room);
  if (e.target.files.length > room) toast("画像は1件につき3枚までです");
  E.images.push(...(await compressAll(files)).map(data => ({ id: uid(), driveId: null, data }))); drawSlots();
});
function drawTags() {
  const inp = $("fTag");
  $("tagEdit").querySelectorAll(".chip").forEach(c => c.remove());
  E.tags.forEach((t, k) => {
    const s = document.createElement("span"); s.className = "chip tag";
    s.innerHTML = `${esc(t)}<button type="button" class="x" aria-label="${esc(t)}を外す">✕</button>`;
    s.querySelector("button").onclick = () => { E.tags.splice(k, 1); drawTags(); };
    $("tagEdit").insertBefore(s, inp);
  });
}
function addTag() {
  const v = $("fTag").value.replace(/^[#＃]/, "").replace(/[,、]/g, "").trim();
  if (v && !E.tags.includes(v)) E.tags.push(v);
  $("fTag").value = ""; drawTags();
}
$("fTag").addEventListener("keydown", e => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); }
  else if (e.key === "Backspace" && !e.target.value && E.tags.length) { E.tags.pop(); drawTags(); }
});
$("fTag").addEventListener("change", addTag);
function drawRel() {
  $("relEdit").innerHTML = E.related.map(byId).filter(Boolean).map(i => `<span class="chip">${esc(i.title)}<button type="button" class="x" data-unrel="${i.id}" aria-label="関連を外す">✕</button></span>`).join("");
  $("relEdit").querySelectorAll("[data-unrel]").forEach(b => b.onclick = () => { E.related = E.related.filter(x => x !== b.dataset.unrel); drawRel(); });
  const opts = S.ideas.filter(i => i.id !== E.id && !E.related.includes(i.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  $("fRel").innerHTML = `<option value="">+ 関連するアイデアを選んで追加</option>` + opts.map(i => `<option value="${i.id}">${esc(i.title)}</option>`).join("");
}
$("fRel").onchange = e => { if (e.target.value) { E.related.push(e.target.value); drawRel(); } };

$("edForm").addEventListener("submit", async e => {
  e.preventDefault();
  stopMic();
  if ($("fTag").value.trim()) addTag();
  let folder = $("fFolder").value;
  if (folder === "__new") {
    folder = $("fNewFolder").value.trim();
    if (!folder) { $("fNewFolder").focus(); toast("新しいフォルダ名を入力してください"); return; }
  }
  if (!S.folders.includes(folder)) { S.folders.push(folder); S.folderLog[folder] = { del: false, ts: Date.now() }; }
  const now = Date.now(); const old = E.id ? byId(E.id) : null;
  // 画像を端末に保存
  for (const m of E.images) if (m.data && !m.driveId) { await store.putImg({ id: m.id, data: m.data }); imgCache.set(m.id, m.data); }
  // 外した画像は端末から消し、ドライブ側は次の同期で削除
  if (old) {
    const keep = new Set(E.images.map(m => m.id));
    for (const m of old.images) if (!keep.has(m.id)) await dropImage(m);
  }
  const idea = {
    id: E.id || uid(), title: $("fTitle").value.trim(), memo: $("fMemo").value, folder, tags: E.tags,
    images: E.images.map(m => ({ id: m.id, driveId: m.driveId || null })), related: E.related,
    createdAt: old ? old.createdAt : now, updatedAt: now, syncAt: now
  };
  if (old) Object.assign(old, idea); else S.ideas.push(idea);
  await store.putIdea(idea); await saveMeta();
  $("ovEdit").hidden = true; render(); toast(old ? "保存しました" : "登録しました");
  openDetail(idea.id);
  scheduleSync();
});
async function dropImage(m) {
  await store.delImg(m.id); imgCache.delete(m.id);
  if (m.driveId) S.trash.push(m.driveId);
}
$("edDelete").onclick = () => { $("ovConfirm").hidden = false; };
$("cfOk").onclick = async () => {
  const id = E.id; const idea = byId(id);
  if (idea) for (const m of idea.images) await dropImage(m);
  S.ideas = S.ideas.filter(i => i.id !== id);
  const now = Date.now();
  for (const i of S.ideas) if (i.related.includes(id)) { i.related = i.related.filter(x => x !== id); i.syncAt = now; await store.putIdea(i); }
  S.deleted[id] = now;
  await store.delIdea(id); await saveMeta();
  $("ovConfirm").hidden = true; $("ovEdit").hidden = true; render(); toast("削除しました");
  scheduleSync();
};

/* ---------- フォルダの管理 ---------- */
const FALLBACK = "その他";
function openFolderManager() { drawFolderManager(); $("ovFolders").hidden = false; }
function drawFolderManager() {
  const cnt = f => S.ideas.filter(i => i.folder === f).length;
  $("fmList").innerHTML = folderList().map((f, k) => `
    <div class="fmrow">
      <input class="inp" id="fm${k}" value="${esc(f)}" maxlength="30" aria-label="フォルダ名:${esc(f)}" data-old="${esc(f)}">
      <span class="fmn">${cnt(f)}件</span>
      <button type="button" class="btn" data-fm-save="${k}">名前を変更</button>
      <button type="button" class="btn danger" data-fm-del="${k}">削除</button>
    </div>`).join("");
  $("fmList").querySelectorAll("[data-fm-save]").forEach(b => b.onclick = () => {
    const inp = $("fm" + b.dataset.fmSave); renameFolder(inp.dataset.old, inp.value.trim());
  });
  $("fmList").querySelectorAll("input").forEach(inp => inp.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); renameFolder(inp.dataset.old, inp.value.trim()); }
  }));
  $("fmList").querySelectorAll("[data-fm-del]").forEach(b => b.onclick = () => askDeleteFolder($("fm" + b.dataset.fmDel).dataset.old));
}
async function renameFolder(oldName, newName) {
  if (!newName) { toast("フォルダ名を入力してください"); return; }
  if (newName === oldName) return;
  const merging = folderList().includes(newName);
  const now = Date.now();
  for (const i of S.ideas) if (i.folder === oldName) { i.folder = newName; i.syncAt = now; await store.putIdea(i); }
  const k = S.folders.indexOf(oldName);
  if (merging) S.folders = S.folders.filter(f => f !== oldName);
  else if (k >= 0) S.folders[k] = newName; else S.folders.push(newName);
  S.folderLog[oldName] = { del: true, ts: now }; S.folderLog[newName] = { del: false, ts: now };
  if (S.folder === oldName) S.folder = newName;
  await saveMeta(); render(); drawFolderManager();
  toast(merging ? `「${oldName}」を「${newName}」にまとめました` : `「${newName}」に変更しました`);
  scheduleSync();
}
let fmDeleting = null;
function askDeleteFolder(name) {
  const n = S.ideas.filter(i => i.folder === name).length;
  const dest = name === FALLBACK ? (folderList().find(f => f !== FALLBACK) || null) : FALLBACK;
  if (n && !dest) { toast("ほかにフォルダがないため削除できません"); return; }
  fmDeleting = { name, dest };
  $("fdText").textContent = n ? `中の${n}件のアイデアは「${dest}」に移ります。アイデアは消えません。` : "このフォルダは空です。";
  $("fdTitle").textContent = `「${name}」を削除しますか?`;
  $("ovFolderDel").hidden = false;
}
$("fdOk").onclick = async () => {
  const { name, dest } = fmDeleting; const now = Date.now();
  for (const i of S.ideas) if (i.folder === name) { i.folder = dest; i.syncAt = now; await store.putIdea(i); }
  if (dest && !S.folders.includes(dest)) { S.folders.push(dest); S.folderLog[dest] = { del: false, ts: now }; }
  S.folders = S.folders.filter(f => f !== name); S.folderLog[name] = { del: true, ts: now };
  if (S.folder === name) S.folder = "all";
  await saveMeta(); $("ovFolderDel").hidden = true; render(); drawFolderManager(); toast(`「${name}」を削除しました`);
  scheduleSync();
};
$("fmAdd").onclick = async () => {
  const v = $("fmNew").value.trim(); if (!v) { $("fmNew").focus(); return; }
  if (folderList().includes(v)) { toast("同じ名前のフォルダがあります"); return; }
  S.folders.push(v); S.folderLog[v] = { del: false, ts: Date.now() }; $("fmNew").value = "";
  await saveMeta(); render(); drawFolderManager(); scheduleSync();
};
$("sideManage").onclick = openFolderManager;

/* ---------- 音声入力 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recOn = false;
if (SR) $("micBtn").hidden = false;
$("micBtn").onclick = () => { recOn ? stopMic() : startMic(); };
function startMic() {
  try {
    rec = new SR(); rec.lang = "ja-JP"; rec.continuous = true; rec.interimResults = false;
    rec.onresult = ev => {
      let txt = "";
      for (let k = ev.resultIndex; k < ev.results.length; k++) if (ev.results[k].isFinal) txt += ev.results[k][0].transcript;
      if (!txt) return;
      const ta = $("fMemo"); const sep = ta.value && !/\n$/.test(ta.value) ? "\n" : "";
      ta.value += sep + txt;
    };
    rec.onerror = ev => { if (ev.error === "not-allowed") toast("マイクの使用が許可されていません。ブラウザの設定で許可してください"); stopMic(); };
    rec.onend = () => { if (recOn) { try { rec.start(); } catch (e) { stopMic(); } } };
    rec.start(); recOn = true;
    $("micBtn").setAttribute("aria-pressed", "true"); $("micText").textContent = "聞き取り中(タップで停止)";
  } catch (e) { toast("この端末では音声入力を開始できませんでした"); stopMic(); }
}
function stopMic() {
  recOn = false; if (rec) { try { rec.stop(); } catch (e) {} rec = null; }
  $("micBtn").setAttribute("aria-pressed", "false"); $("micText").textContent = "音声入力";
}

/* ---------- 詳細 ---------- */
let D = null, Dsrcs = [];
function openDetail(id) {
  const i = byId(id); if (!i) return; D = id;
  $("dtTitle").textContent = i.title;
  const rel = i.related.map(byId).filter(Boolean);
  const back = S.ideas.filter(x => x.related.includes(id) && !i.related.includes(x.id));
  const relBtn = x => `<button type="button" data-open="${x.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>${esc(x.title)}</button>`;
  $("dtBody").innerHTML = `
    <div class="meta"><span class="folderpill">${esc(i.folder)}</span>${i.tags.map(t => `<span class="chip tag">${esc(t)}</span>`).join("")}<span class="date">更新 ${fmt(i.updatedAt)}</span></div>
    ${i.images.length ? `<div class="dimgs" id="dtImgs">${i.images.map((m, k) => `<button type="button" data-lb="${k}" aria-label="画像${k + 1}を拡大">読み込み中…</button>`).join("")}</div>` : ""}
    ${i.memo ? `<p class="memo">${esc(i.memo)}</p>` : `<p class="hint">メモはありません</p>`}
    ${rel.length || back.length ? `<div><p class="section-label">Related</p><div class="rel">${[...rel, ...back].map(relBtn).join("")}</div></div>` : ""}`;
  $("ovDetail").hidden = false; $("dtBody").parentElement.scrollTop = 0;
  Dsrcs = [];
  i.images.forEach(async (m, k) => {
    const src = await loadImage(m); if (D !== id) return;
    const b = document.querySelector(`#dtImgs [data-lb="${k}"]`); if (!b) return;
    if (src) { Dsrcs[k] = src; b.innerHTML = `<img src="${src}" alt="">`; b.onclick = () => openLB(k); }
    else b.textContent = "画像を取得できません(オフライン)";
  });
}
$("dtEdit").onclick = () => openEditor(D, []);
$("dtPrint").onclick = async () => {
  const i = byId(D); if (!i) return;
  const srcs = []; for (const m of i.images) { const s = await loadImage(m); if (s) srcs.push(s); }
  const rel = i.related.map(byId).filter(Boolean);
  $("printArea").innerHTML = `
    <div class="brand">Think BS ・ 株式会社BSサービス</div>
    <h1>${esc(i.title)}</h1>
    <div class="pmeta">フォルダ:${esc(i.folder)}${i.tags.length ? " / タグ:" + i.tags.map(t => "#" + esc(t)).join(" ") : ""} / 作成 ${fmt(i.createdAt)} / 更新 ${fmt(i.updatedAt)}</div>
    ${i.memo ? `<p class="pmemo">${esc(i.memo)}</p>` : ""}
    ${srcs.length ? `<div class="pimgs">${srcs.map(s => `<img src="${s}" alt="">`).join("")}</div>` : ""}
    ${rel.length ? `<div class="prel">関連:${rel.map(r => esc(r.title)).join("、")}</div>` : ""}`;
  const imgs = [...$("printArea").querySelectorAll("img")];
  await Promise.all(imgs.map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
  try { window.print(); } catch (e) { toast("この画面では印刷を開始できませんでした"); }
};

/* ---------- 画像の拡大 ---------- */
let LBk = 0;
function lbList() { return Dsrcs.filter(Boolean); }
function openLB(k) { const list = lbList(); LBk = Math.max(0, list.indexOf(Dsrcs[k])); showLB(); $("lb").hidden = false; }
function showLB() {
  const list = lbList(); $("lbImg").src = list[LBk];
  $("lbCount").textContent = (LBk + 1) + " / " + list.length + "(画像をタップで2倍に拡大)";
  $("lbStage").classList.remove("zoom"); $("lbPrev").hidden = $("lbNext").hidden = list.length < 2;
}
$("lbImg").onclick = () => $("lbStage").classList.toggle("zoom");
$("lbPrev").onclick = () => { const n = lbList().length; LBk = (LBk - 1 + n) % n; showLB(); };
$("lbNext").onclick = () => { const n = lbList().length; LBk = (LBk + 1) % n; showLB(); };
$("lbClose").onclick = () => { $("lb").hidden = true; };

let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2600); }

/* =========================================================
 * Googleドライブ連携
 * ========================================================= */
let token = null, tokenClient = null;
let syncState = "local", syncMsg = "";
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function tokenValid() { return !!(token && token.v && token.exp > Date.now()); }
function gis() { return window.google && google.accounts && google.accounts.oauth2; }

function setupAuth() {
  if (!CFG.clientId) { setStatus("local"); return; }
  const ready = () => {
    if (!gis()) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId, scope: SCOPE,
      callback: onToken,
      error_callback: err => { setStatus("auth"); if (err && err.type === "popup_failed_to_open") toast("ポップアップがブロックされました。ブラウザの設定で許可してください"); }
    });
    return true;
  };
  if (!ready()) { let n = 0; const iv = setInterval(() => { if (ready() || ++n > 40) clearInterval(iv); }, 250); }
  if (tokenValid()) sync(); else setStatus("auth");
}
function connect() {
  if (!tokenClient) { toast(navigator.onLine ? "Googleの読み込み中です。少し待ってからもう一度押してください" : "オフラインのため接続できません"); return; }
  tokenClient.requestAccessToken({ prompt: "" });
}
async function onToken(r) {
  if (!r || r.error) { setStatus("auth"); toast("Googleへの接続が完了しませんでした"); return; }
  if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) { setStatus("auth"); toast("Googleドライブへのアクセスを許可してください"); return; }
  token = { v: r.access_token, exp: Date.now() + (Number(r.expires_in || 3600) - 120) * 1000 };
  await store.set("token", token); await store.set("connected", true);
  sync();
}
async function disconnect() {
  try { if (token && gis()) google.accounts.oauth2.revoke(token.v, () => {}); } catch (e) {}
  token = null; await store.set("token", null); await store.set("connected", false);
  await store.set("folderId", null); await store.set("dataId", null);
  setStatus("auth"); $("ovSync").hidden = true; toast("Googleとの接続を解除しました(端末内のデータは残ります)");
}

async function api(path, opt = {}) {
  if (!tokenValid()) throw new HttpErr(401, "auth");
  const url = path.startsWith("http") ? path : DRIVE + path;
  const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: "Bearer " + token.v } });
  if (r.status === 401) { token = null; await store.set("token", null); throw new HttpErr(401, "auth"); }
  if (!r.ok) throw new HttpErr(r.status, "Googleドライブ " + r.status + ": " + (await r.text()).slice(0, 200));
  return r;
}
function q(s) { return encodeURIComponent(s); }
async function findFolder() {
  const r = await (await api(`files?q=${q(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,createdTime)&orderBy=createdTime&spaces=drive`)).json();
  if (r.files && r.files.length) return r.files[0].id;
  const c = await (await api("files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }) })).json();
  return c.id;
}
async function findData(folderId) {
  const r = await (await api(`files?q=${q(`name='${DATA_NAME}' and '${folderId}' in parents and trashed=false`)}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc&spaces=drive`)).json();
  return r.files && r.files.length ? r.files[0].id : null;
}
function multipart(meta, blob) {
  const b = "thinkbs" + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(meta),
    `\r\n--${b}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`, blob, `\r\n--${b}--`
  ]);
  return { body, headers: { "Content-Type": `multipart/related; boundary=${b}` } };
}
async function uploadNew(meta, blob) {
  const m = multipart(meta, blob);
  return (await (await api(`${UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", ...m })).json()).id;
}
async function uploadReplace(fileId, blob) {
  await api(`${UPLOAD}/${fileId}?uploadType=media&fields=id`, { method: "PATCH", headers: { "Content-Type": blob.type }, body: blob });
  return fileId;
}

/* 2つのデータを1つにまとめる:新しく更新された方を残し、削除はそちらが新しければ反映 */
function mergeData(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  for (const [k, v] of Object.entries(local.deleted || {})) deleted[k] = Math.max(deleted[k] || 0, v);
  const driveIds = new Map();
  const collect = list => list.forEach(i => (i.images || []).forEach(m => { if (m.driveId) driveIds.set(m.id, m.driveId); }));
  collect(local.ideas); collect(remote.ideas || []);
  const map = new Map(local.ideas.map(i => [i.id, i]));
  for (const r0 of remote.ideas || []) {
    const r = normalize(r0); const l = map.get(r.id);
    if (!l || r.syncAt > l.syncAt) map.set(r.id, r);
  }
  for (const [id, ts] of Object.entries(deleted)) { const i = map.get(id); if (i && i.syncAt <= ts) map.delete(id); }
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  for (const [id, ts] of Object.entries(deleted)) if (ts < cutoff) delete deleted[id];
  const ideas = [...map.values()].map(i => ({ ...i, images: i.images.map(m => ({ id: m.id, driveId: m.driveId || driveIds.get(m.id) || null })) }));
  // フォルダ:名前ごとに「追加/削除」の新しい方を採用
  const folderLog = { ...(remote.folderLog || {}) };
  for (const [k, v] of Object.entries(local.folderLog || {})) if (!folderLog[k] || v.ts > folderLog[k].ts) folderLog[k] = v;
  const names = [...new Set([...(local.folders || []), ...(remote.folders || []), ...Object.keys(folderLog).filter(k => !folderLog[k].del)])];
  const folders = names.filter(n => !(folderLog[n] && folderLog[n].del));
  return { ideas, deleted, folders, folderLog };
}

let syncing = false, again = false, syncTimer = null;
function scheduleSync() { if (!CFG.clientId) return; clearTimeout(syncTimer); syncTimer = setTimeout(sync, 1500); }

async function sync() {
  if (!CFG.clientId) { setStatus("local"); return; }
  if (!navigator.onLine) { setStatus("offline"); return; }
  if (!tokenValid()) { setStatus("auth"); return; }
  if (syncing) { again = true; return; }
  syncing = true; setStatus("syncing");
  try {
    await syncOnce().catch(async e => {
      if (e.status === 404) { await store.set("folderId", null); await store.set("dataId", null); return syncOnce(); }
      throw e;
    });
    await store.set("lastSync", Date.now());
    setStatus("ok");
    prefetchImages();
  } catch (e) {
    if (e.status === 401) setStatus("auth");
    else if (!navigator.onLine) setStatus("offline");
    else { console.error(e); setStatus("error", e.message || String(e)); }
  } finally {
    syncing = false;
    if (again) { again = false; setTimeout(sync, 300); }
  }
}
async function syncOnce() {
  let folderId = await store.get("folderId");
  if (!folderId) { folderId = await findFolder(); await store.set("folderId", folderId); }
  let dataId = await store.get("dataId");
  if (!dataId) dataId = await findData(folderId);
  let remote = { ideas: [], deleted: {}, folders: [] };
  if (dataId) remote = await (await api(`files/${dataId}?alt=media`)).json();

  // 取り込み
  const merged = mergeData({ ideas: S.ideas, deleted: S.deleted, folders: S.folders, folderLog: S.folderLog }, remote);
  const before = JSON.stringify([S.ideas.map(i => [i.id, i.syncAt]).sort(), S.folders]);
  S.ideas = merged.ideas; S.deleted = merged.deleted; S.folders = merged.folders; S.folderLog = merged.folderLog;
  await store.replaceIdeas(S.ideas); await saveMeta();
  if (JSON.stringify([S.ideas.map(i => [i.id, i.syncAt]).sort(), S.folders]) !== before) { render(); refreshOpenDetail(); }

  // まだドライブにない画像を送る
  for (const i of S.ideas) {
    let changed = false;
    for (const m of i.images) {
      if (m.driveId) continue;
      const local = await store.getImg(m.id); if (!local || !local.data) continue;
      m.driveId = await uploadNew({ name: `img_${m.id}.jpg`, parents: [folderId], mimeType: "image/jpeg" }, await dataURLToBlob(local.data));
      changed = true;
    }
    if (changed) await store.putIdea(i);
  }

  // データファイルを書き出す
  const payload = {
    app: "Think BS", version: 1, savedAt: Date.now(),
    folders: S.folders, folderLog: S.folderLog, deleted: S.deleted,
    ideas: S.ideas.map(i => ({ id: i.id, title: i.title, memo: i.memo, folder: i.folder, tags: i.tags, images: i.images, related: i.related, createdAt: i.createdAt, updatedAt: i.updatedAt, syncAt: i.syncAt }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
  if (dataId) await uploadReplace(dataId, blob);
  else dataId = await uploadNew({ name: DATA_NAME, parents: [folderId], mimeType: "application/json" }, blob);
  await store.set("dataId", dataId);

  // 外した画像をドライブから消す(ほかのアイデアで使っていないものだけ)
  const used = new Set(); S.ideas.forEach(i => i.images.forEach(m => m.driveId && used.add(m.driveId)));
  const rest = [];
  for (const id of S.trash) {
    if (used.has(id)) continue;
    try { await api(`files/${id}`, { method: "DELETE" }); }
    catch (e) { if (e.status !== 404) rest.push(id); }
  }
  S.trash = rest; await saveMeta();
}
let prefetching = false;
async function prefetchImages() {
  if (prefetching) return; prefetching = true;
  try {
    for (const i of S.ideas) for (const m of i.images) {
      if (imgCache.has(m.id)) continue;
      const l = await store.getImg(m.id); if (l && l.data) continue;
      if (!tokenValid() || !navigator.onLine) return;
      await loadImage(m);
    }
  } finally { prefetching = false; }
}
function refreshOpenDetail() {
  if ($("ovDetail").hidden || !D) return;
  if (byId(D)) openDetail(D); else { $("ovDetail").hidden = true; toast("このアイデアはほかの端末で削除されました"); }
}

/* ---------- 同期の表示 ---------- */
async function setStatus(st, msg) {
  syncState = st; syncMsg = msg || "";
  const last = await store.get("lastSync");
  const text = {
    local: "端末内に保存",
    auth: "Googleに接続",
    syncing: "同期中…",
    ok: "同期済み " + (last ? hm(last) : ""),
    offline: "オフライン",
    error: "同期エラー"
  }[st];
  $("syncBtn").dataset.state = st; $("syncText").textContent = text;
  if (!$("ovSync").hidden) drawSyncDialog();
}
$("syncBtn").onclick = () => {
  if (syncState === "auth" && CFG.clientId) { connect(); return; }
  drawSyncDialog(); $("ovSync").hidden = false;
};
async function drawSyncDialog() {
  const last = await store.get("lastSync"); const folderId = await store.get("folderId");
  const unsent = S.ideas.reduce((n, i) => n + i.images.filter(m => !m.driveId).length, 0);
  const stateText = {
    local: "Googleドライブ連携が設定されていません。データはこの端末の中だけに保存されています。",
    auth: "Googleドライブに接続していません。「Googleに接続」を押してください。",
    syncing: "同期しています…",
    ok: "Googleドライブと同期しています。",
    offline: "オフラインです。電波が戻ると自動で同期します。登録や編集はそのまま続けられます。",
    error: "同期できませんでした。少し待ってから「今すぐ同期」を押してください。"
  }[syncState];
  $("syBody").innerHTML = `<p class="plain">${stateText}</p>
    ${syncState === "error" && syncMsg ? `<p class="hint">詳細:${esc(syncMsg)}</p>` : ""}
    <dl class="kv"><dt>アイデア</dt><dd>${S.ideas.length}件</dd>
      <dt>最後の同期</dt><dd>${last ? fmt(last) + " " + hm(last) : "まだありません"}</dd>
      ${unsent ? `<dt>未送信の画像</dt><dd>${unsent}枚</dd>` : ""}
      <dt>保存先</dt><dd>${folderId ? `<a href="https://drive.google.com/drive/folders/${esc(folderId)}" target="_blank" rel="noopener" style="color:var(--accent)">Googleドライブの「Think BS」フォルダ</a>` : "Googleドライブの「Think BS」フォルダ"}</dd></dl>`;
  const btns = [];
  if (CFG.clientId) {
    if (tokenValid()) btns.push(`<button class="btn danger" type="button" id="syOff">接続を解除</button><span class="spacer"></span><button class="btn primary" type="button" id="syNow">今すぐ同期</button>`);
    else btns.push(`<span class="spacer"></span><button class="btn primary" type="button" id="syOn">Googleに接続</button>`);
  } else btns.push(`<span class="spacer"></span><button class="btn" type="button" data-close>閉じる</button>`);
  $("syFoot").innerHTML = btns.join("");
  const on = $("syOn"); if (on) on.onclick = () => { $("ovSync").hidden = true; connect(); };
  const now = $("syNow"); if (now) now.onclick = () => sync();
  const off = $("syOff"); if (off) off.onclick = disconnect;
}

/* 画面に戻ったとき・電波が戻ったとき・5分ごとに同期 */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
window.addEventListener("online", () => sync());
window.addEventListener("offline", () => { if (CFG.clientId) setStatus("offline"); });
setInterval(() => { if (document.visibilityState === "visible") sync(); }, 5 * 60 * 1000);

window.__thinkbs = { mergeData, S, sync }; // テスト用
init();
})();
