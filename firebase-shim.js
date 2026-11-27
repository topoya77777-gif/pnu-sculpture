/* 조소과 과실 앱: claude.ai 대신 쥬의 Firebase(실시간 데이터베이스)로 움직이게 하는 연결부.
   게임 코드는 그대로 두고, 게임이 쓰는 room / db / assets / user 를 Firebase로 흉내 내요. */
(function () {
  firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth(), rt = firebase.database();
  let uid = null, isAdmin = false, members = {};
  const denied = e => { const c = String((e && (e.code || e.message)) || ""); return { code: /PERMISSION/i.test(c) ? "invalid_argument" : "unavailable", message: c }; };
  const wrap = p => p.catch(e => { throw denied(e); });

  /* ---------- 들어오기: 첫 사람은 관리자, 친구는 초대 코드 ---------- */
  /* 한 번 들어온 사람은 이 기기에 이름·코드를 기억해서 다음부터 바로 들어가요.
     링크에 ?k=초대코드 가 붙어 있으면 코드도 안 쳐도 돼요 (홈 화면 앱에도 그대로 남아요). */
  const LS = { get: k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const urlCode = new URLSearchParams(location.search).get("k") || "";
  function keepCode(code) {
    LS.set("pnu-code", code);
    try { const u = new URL(location.href); if (u.searchParams.get("k") !== code) { u.searchParams.set("k", code); history.replaceState(null, "", u); } } catch {}
  }
  async function tryJoin(name, code) { await rt.ref("members/" + uid).set({ name, code, t: Date.now() }); LS.set("pnu-name", name); keepCode(code); }
  async function joinOverlay(err) {
    const code0 = urlCode || LS.get("pnu-code"), name0 = LS.get("pnu-name");
    if (!err && code0 && name0) { try { await tryJoin(name0, code0); return; } catch {} } // 기억해 둔 걸로 조용히 다시 들어가기
    return new Promise(res => {
      let ov = document.getElementById("joinOv");
      if (!ov) {
        ov = document.createElement("div"); ov.id = "joinOv";
        ov.innerHTML = `<form class="join-card"><h2>조소과 과실</h2><p>쥬한테 받은 초대 코드랑 내 이름을 적어줘.</p>
          <label for="joinName">이름</label><input id="joinName" maxlength="12" autocomplete="off" placeholder="예) 수아">
          <label for="joinCode">초대 코드</label><input id="joinCode" maxlength="20" autocomplete="off" autocapitalize="characters" placeholder="예) GWASIL24">
          <div class="join-err" id="joinErr"></div><button type="submit">들어가기</button></form>`;
        document.body.appendChild(ov);
      }
      ov.hidden = false; ov.querySelector("#joinErr").textContent = err || "";
      ov.querySelector("#joinName").value = name0; ov.querySelector("#joinCode").value = code0;
      if (code0) { ov.querySelector("#joinCode").hidden = true; ov.querySelector('label[for="joinCode"]').hidden = true; ov.querySelector("p").textContent = "내 이름만 적어줘. 다음부터는 바로 들어가져."; }
      ov.querySelector("form").onsubmit = async e => {
        e.preventDefault();
        const name = ov.querySelector("#joinName").value.trim().slice(0, 12), code = ov.querySelector("#joinCode").value.trim();
        if (!name || !code) { ov.querySelector("#joinErr").textContent = "이름이랑 초대 코드를 둘 다 적어줘."; return; }
        try { await tryJoin(name, code); ov.hidden = true; res(); }
        catch { // 기억해 둔 코드가 바뀌었으면 코드 칸을 다시 보여줘요
          LS.set("pnu-code", ""); ov.querySelector("#joinCode").hidden = false; ov.querySelector('label[for="joinCode"]').hidden = false; ov.querySelector("#joinCode").value = "";
          ov.querySelector("#joinErr").textContent = "초대 코드가 틀렸어. 쥬한테 다시 물어봐."; }
      };
    });
  }
  const ready = new Promise(resolve => {
    auth.onAuthStateChanged(async u => {
      if (!u) { auth.signInAnonymously().catch(e => alertBox("로그인에 실패했어: " + e.message)); return; }
      uid = u.uid;
      try {
        const adm = await rt.ref("config/admin").get();
        if (!adm.exists()) { // 맨 처음 연 사람(쥬)이 관리자가 돼요
          await rt.ref("config/admin").set(uid);
          await rt.ref("config/inviteCode").set("GWASIL" + Math.floor(1000 + Math.random() * 9000));
        }
        isAdmin = (await rt.ref("config/admin").get()).val() === uid;
        const mine = await rt.ref("members/" + uid).get().catch(() => null);
        if (!(mine && mine.exists())) {
          if (isAdmin) await rt.ref("members/" + uid).set({ name: "쥬", code: "admin", t: Date.now() });
          else await joinOverlay();
        }
      } catch (e) { alertBox("서버에 연결하지 못했어. config.js 설정을 확인해줘. (" + (e.message || e) + ")"); return; }
      rt.ref("members").on("value", s => { members = s.val() || {}; if (!members[uid]) location.reload(); });
      if (isAdmin) adminUI();
      resolve();
    });
  });
  function alertBox(msg) { const d = document.createElement("div"); d.className = "join-alert"; d.textContent = msg; document.body.appendChild(d); }

  /* ---------- room: 실시간 접속자·위치 ---------- */
  let onDis = false;
  const room = {
    presence(p) { const r = rt.ref("presence/" + uid); if (!onDis) { r.onDisconnect().remove(); onDis = true; } return r.update(Object.assign({}, p, { at: Date.now() })); },
    onPeers(handler, onErr) {
      const r = rt.ref("presence"), cb = s => {
        const v = s.val() || {}, now = Date.now();
        const peers = Object.entries(v).filter(([, p]) => p && now - (p.at || 0) < 75 * 1000).map(([k, p]) => ({ peer: k, by: k, isMe: k === uid, sameTab: k === uid, kind: "viewer", guest: false, presence: p, updatedAt: now }));
        handler({ peers, joined: [], left: [], updated: [] });
      };
      r.on("value", cb, () => onErr && onErr({ code: "not_granted", message: "" })); return () => r.off("value", cb);
    },
    connected: () => true,
  };

  /* ---------- db: 채팅·작품·게시판 (data/<컬렉션>/<문서>) ---------- */
  const snapOf = (id, val) => ({ id, exists: val != null, data: () => (val == null ? undefined : val), metadata: { fromCache: false, hasPendingWrites: false } });
  function docRef(p) {
    const id = p.split("/").pop(), r = rt.ref("data/" + p);
    return {
      id, path: p,
      get: async () => snapOf(id, (await r.get()).val()),
      set: d => wrap(r.set(d)), update: d => wrap(r.update(d)), delete: () => r.remove().catch(() => {}), // 남의 글 지우기는 쥬만 돼요(조용히 넘어가요)
      onSnapshot(next, err) { const cb = s => next(snapOf(id, s.val())); r.on("value", cb, () => err && err({ code: "revoked" })); return () => r.off("value", cb); },
    };
  }
  function query(path, field, dir, n) {
    const ref = () => { let r = rt.ref("data/" + path); if (field) r = r.orderByChild(field); if (n) r = dir === "desc" ? r.limitToLast(n) : r.limitToFirst(n); return r; };
    const docsOf = s => { const a = []; s.forEach(ch => { a.push(snapOf(ch.key, ch.val())); }); if (dir === "desc") a.reverse(); return a; };
    return {
      orderBy: (f, d = "asc") => query(path, f, d, n), limit: k => query(path, field, dir, k), where: () => query(path, field, dir, n),
      doc: id => docRef(path + "/" + (id || rt.ref().push().key)),
      async add(data) { const k = rt.ref().push().key; await wrap(rt.ref("data/" + path + "/" + k).set(data)); return docRef(path + "/" + k); },
      async get() { const docs = docsOf(await ref().get()); return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map(d => ({ type: "added", doc: d })), metadata: { fromCache: false } }; },
      onSnapshot(next, err) {
        let prev = null; const r = ref(), cb = s => {
          const docs = docsOf(s), changes = docs.filter(d => !prev || !prev.has(d.id)).map(d => ({ type: "added", doc: d }));
          prev = new Set(docs.map(d => d.id));
          next({ docs, size: docs.length, empty: !docs.length, docChanges: () => changes, metadata: { fromCache: false, hasPendingWrites: false } });
        };
        r.on("value", cb, () => err && err({ code: "revoked" })); return () => r.off("value", cb);
      },
    };
  }
  const db = { collection: p => query(p), doc: p => docRef(p) };

  /* ---------- assets: 사진은 줄여서 데이터베이스에 저장 ---------- */
  const assetCache = new Map();
  const assets = {
    async upload(blob) {
      if (blob.size > 5 * 1024 * 1024) throw { code: "too_large", message: "5MB보다 작은 사진만 올릴 수 있어." };
      const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      const id = rt.ref().push().key; await wrap(rt.ref("assets/" + id).set(url)); assetCache.set(id, url);
      return { id, url, sizeBytes: blob.size, contentType: blob.type };
    },
  };
  window.setAssetImg = (el, id) => {
    if (assetCache.has(id)) { el.src = assetCache.get(id); return; }
    rt.ref("assets/" + id).get().then(s => { const v = s.val(); if (typeof v === "string" && v.startsWith("data:image/")) { assetCache.set(id, v); el.src = v; } }).catch(() => {});
  };

  /* ---------- user: 내 ID, 친구 이름 ---------- */
  const user = {
    id: async () => uid, isOwner: async () => isAdmin, canEdit: async () => isAdmin, can: async () => true,
    profiles: async ids => Object.fromEntries(ids.map(i => [i, { id: i, name: (members[i] && members[i].name) || "" }])),
    me: async () => ({ id: uid, name: (members[uid] && members[uid].name) || "" }),
  };

  /* ---------- 관리자(쥬) 메뉴 ---------- */
  function adminUI() {
    const btn = document.createElement("button"); btn.className = "admin-btn"; btn.type = "button"; btn.textContent = "⚙️ 관리"; document.body.appendChild(btn);
    const ov = document.createElement("div"); ov.id = "adminOv"; ov.hidden = true; document.body.appendChild(ov);
    const render = async () => {
      const code = (await rt.ref("config/inviteCode").get()).val() || "";
      ov.innerHTML = `<div class="join-card admin-card"><h2>⚙️ 관리자 메뉴</h2>
        <label>초대 코드 (친구들한테 알려줘)</label><div class="admin-row"><input id="admCode" value="${code.replace(/[^A-Za-z0-9가-힣_-]/g, "")}" maxlength="20"><button type="button" id="admSave">바꾸기</button></div>
        <label>참여 중인 친구</label><div id="admMembers" class="admin-list"></div>
        <div class="admin-row"><button type="button" id="admChat">채팅 전체 지우기</button><button type="button" id="admBoard">게시판 전체 지우기</button></div>
        <div class="join-err" id="admMsg"></div><button type="button" id="admClose">닫기</button></div>`;
      const list = ov.querySelector("#admMembers");
      for (const [id, m] of Object.entries(members)) {
        const row = document.createElement("div"); row.className = "admin-row";
        const n = document.createElement("span"); n.textContent = (m.name || "?") + (id === uid ? " (나)" : ""); row.appendChild(n);
        if (id !== uid) { const k = document.createElement("button"); k.type = "button"; k.textContent = "내보내기"; k.onclick = async () => { await rt.ref("members/" + id).remove(); await rt.ref("presence/" + id).remove(); render(); }; row.appendChild(k); }
        list.appendChild(row);
      }
      const confirmDo = (b, label, fn) => { b.onclick = () => { if (b.dataset.sure) { fn(); b.textContent = "지웠어!"; delete b.dataset.sure; } else { b.dataset.sure = "1"; b.textContent = label + " (한 번 더 누르면 지워져)"; } }; };
      ov.querySelector("#admSave").onclick = async () => { const v = ov.querySelector("#admCode").value.trim(); if (v.length < 4) { ov.querySelector("#admMsg").textContent = "4글자 이상으로 해줘."; return; } await rt.ref("config/inviteCode").set(v); ov.querySelector("#admMsg").textContent = "초대 코드를 바꿨어. 이미 들어온 친구는 그대로야."; };
      confirmDo(ov.querySelector("#admChat"), "채팅 전체 지우기", () => rt.ref("data/msgs").remove());
      confirmDo(ov.querySelector("#admBoard"), "게시판 전체 지우기", () => rt.ref("data/board").remove());
      ov.querySelector("#admClose").onclick = () => { ov.hidden = true; };
    };
    btn.onclick = () => { ov.hidden = false; render(); };
  }

  window.claude = { use: n => ready.then(() => ({ room, db, assets, user })[n] || null) };
})();
