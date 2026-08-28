import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, updateDoc, getDocs,
  collection, query, where, onSnapshot,
  addDoc, increment,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ---------------- crypto helpers ----------------
const sha256Hex = async (str) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};
const deriveAesKey = async (secret) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};
const encryptText = async (text, secret) => {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(cipherBuf)) };
};
const decryptText = async (payload, secret) => {
  try {
    const key = await deriveAesKey(secret);
    const iv = new Uint8Array(payload.iv);
    const data = new Uint8Array(payload.data);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(plainBuf);
  } catch (e) {
    return "⚠️ تعذر فك التشفير";
  }
};
const dmChatId = (a, b) => "dm__" + [a, b].sort().join("__");
const secretForChat = (chat) => (chat.type === "dm" ? dmChatId(session.username, chat.id) : "group__" + chat.id);

// compress an uploaded image file into a small square JPEG data URL
const fileToAvatarDataUrl = (file, maxSize = 128, quality = 0.75) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });

// ---------------- state ----------------
let session = null; // {username, id, displayName, avatar}
let selectedChat = null; // {type:'dm'|'group', id, name}
let friendsUnsub = null;
let groupsUnsub = null;
let messagesUnsub = null;
let presenceUnsub = null;
let pendingAvatarDataUrl = null;
let forgotTargetUsername = null;

// ---------------- DOM refs ----------------
const $ = (id) => document.getElementById(id);
const authScreen = $("authScreen"), appScreen = $("appScreen");
const authUser = $("authUser"), authPass = $("authPass"), authError = $("authError"), authBtn = $("authBtn");
const secQuestion = $("secQuestion"), secAnswer = $("secAnswer"), forgotLink = $("forgotLink");
const meName = $("meName"), meHandle = $("meHandle"), meId = $("meId"), avatarBtn = $("avatarBtn");
const totalVisitsEl = $("totalVisits"), onlineCountEl = $("onlineCount");
const friendsList = $("friendsList"), groupsList = $("groupsList");
const addFriendInput = $("addFriendInput"), addFriendBtn = $("addFriendBtn");
const tabFriends = $("tabFriends"), tabGroups = $("tabGroups");
const friendsPanel = $("friendsPanel"), groupsPanel = $("groupsPanel");
const newGroupBtn = $("newGroupBtn"), newGroupModal = $("newGroupModal");
const newGroupName = $("newGroupName"), newGroupMembers = $("newGroupMembers"), createGroupBtn = $("createGroupBtn");
const settingsBtn = $("settingsBtn"), settingsModal = $("settingsModal");
const avatarPreview = $("avatarPreview"), choosePhotoBtn = $("choosePhotoBtn"), photoInput = $("photoInput");
const displayNameInput = $("displayNameInput"), profileError = $("profileError"), saveProfileBtn = $("saveProfileBtn");
const oldPass = $("oldPass"), newPass = $("newPass"), newPass2 = $("newPass2"), settingsError = $("settingsError"), changePassBtn = $("changePassBtn");
const forgotModal = $("forgotModal"), forgotStep1 = $("forgotStep1"), forgotStep2 = $("forgotStep2");
const forgotUser = $("forgotUser"), forgotError1 = $("forgotError1"), forgotFetchBtn = $("forgotFetchBtn");
const forgotQuestionText = $("forgotQuestionText"), forgotAnswer = $("forgotAnswer");
const forgotNewPass = $("forgotNewPass"), forgotNewPass2 = $("forgotNewPass2"), forgotError2 = $("forgotError2"), forgotResetBtn = $("forgotResetBtn");
const logoutBtn = $("logoutBtn"), copyIdBtn = $("copyIdBtn");
const emptyState = $("emptyState"), chatWindow = $("chatWindow"), chatTitle = $("chatTitle");
const messagesBox = $("messagesBox"), msgInput = $("msgInput"), sendBtn = $("sendBtn");
const toast = $("toast");

const showToast = (t) => {
  toast.textContent = t;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2200);
};

const renderAvatarInto = (el, name, avatarDataUrl) => {
  if (avatarDataUrl) {
    el.innerHTML = "";
    const img = document.createElement("img");
    img.src = avatarDataUrl;
    el.appendChild(img);
  } else {
    el.textContent = name?.[0]?.toUpperCase() || "?";
  }
};

// ---------------- auth ----------------
authBtn.onclick = handleAuth;
authPass.addEventListener("keydown", (e) => e.key === "Enter" && handleAuth());
forgotLink.onclick = () => {
  forgotStep1.classList.remove("hidden");
  forgotStep2.classList.add("hidden");
  forgotUser.value = "";
  forgotAnswer.value = "";
  forgotNewPass.value = "";
  forgotNewPass2.value = "";
  forgotError1.classList.add("hidden");
  forgotError2.classList.add("hidden");
  forgotModal.classList.remove("hidden");
};

async function handleAuth() {
  const uname = authUser.value.trim();
  const pass = authPass.value;
  authError.classList.add("hidden");
  if (!uname || !pass) {
    authError.textContent = "✕ لازم يوزر و باسوورد";
    authError.classList.remove("hidden");
    return;
  }
  authBtn.disabled = true;
  authBtn.textContent = "...";
  try {
    const ref = doc(db, "chatUsers", uname);
    const snap = await getDoc(ref);
    const passHash = await sha256Hex(uname.toLowerCase() + ":" + pass);
    if (snap.exists()) {
      const data = snap.data();
      if (data.passHash !== passHash) {
        authError.textContent = "✕ رمز خاطئ";
        authError.classList.remove("hidden");
        authBtn.disabled = false;
        authBtn.textContent = "> connect";
        return;
      }
      session = { username: uname, id: data.id, displayName: data.displayName || uname, avatar: data.avatar || "" };
    } else {
      if (!secQuestion.value.trim() || !secAnswer.value.trim()) {
        authError.textContent = "✕ عبي سؤال الأمان و جوابه (تحتاجهم لو نسيت الباسوورد)";
        authError.classList.remove("hidden");
        authBtn.disabled = false;
        authBtn.textContent = "> connect";
        return;
      }
      const id = String(Math.floor(100000 + Math.random() * 899999));
      const secAnswerHash = await sha256Hex(uname.toLowerCase() + ":" + secAnswer.value.trim().toLowerCase());
      await setDoc(ref, {
        passHash, id, friends: [], createdAt: Date.now(),
        displayName: uname, avatar: "",
        secQuestion: secQuestion.value.trim(), secAnswerHash,
      });
      session = { username: uname, id, displayName: uname, avatar: "" };
      showToast("تم إنشاء الحساب ✓");
    }
    localStorage.setItem("x1877chat_session", JSON.stringify(session));
    enterApp();
  } catch (e) {
    console.error(e);
    authError.textContent = "✕ صار خطأ بالاتصال، جرب مرة ثانية";
    authError.classList.remove("hidden");
  }
  authBtn.disabled = false;
  authBtn.textContent = "> connect";
}

// restore session on load
(function restoreSession() {
  const raw = localStorage.getItem("x1877chat_session");
  if (raw) {
    try {
      session = JSON.parse(raw);
      enterApp();
    } catch (e) {}
  }
})();

function enterApp() {
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  refreshMeUI();
  bumpVisitorCount();
  startPresenceHeartbeat();
  listenFriends();
  listenGroups();
}

function refreshMeUI() {
  meName.textContent = session.displayName || session.username;
  meHandle.textContent = "@" + session.username;
  meId.textContent = session.id;
  renderAvatarInto(avatarBtn, session.displayName || session.username, session.avatar);
}

logoutBtn.onclick = () => {
  session = null;
  selectedChat = null;
  localStorage.removeItem("x1877chat_session");
  if (friendsUnsub) friendsUnsub();
  if (groupsUnsub) groupsUnsub();
  if (messagesUnsub) messagesUnsub();
  if (presenceUnsub) presenceUnsub();
  authScreen.classList.remove("hidden");
  appScreen.classList.add("hidden");
  authUser.value = "";
  authPass.value = "";
};

copyIdBtn.onclick = () => {
  navigator.clipboard?.writeText(session.id);
  showToast("Copied ✓");
};

// ---------------- profile: avatar + display name ----------------
avatarBtn.onclick = openProfileModal;
settingsBtn.onclick = openProfileModal;
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.onclick = () => $(btn.dataset.close).classList.add("hidden");
});

function openProfileModal() {
  pendingAvatarDataUrl = null;
  displayNameInput.value = session.displayName || session.username;
  renderAvatarInto(avatarPreview, session.displayName || session.username, session.avatar);
  profileError.classList.add("hidden");
  oldPass.value = ""; newPass.value = ""; newPass2.value = "";
  settingsError.classList.add("hidden");
  settingsModal.classList.remove("hidden");
}

choosePhotoBtn.onclick = () => photoInput.click();
photoInput.onchange = async () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  try {
    pendingAvatarDataUrl = await fileToAvatarDataUrl(file);
    renderAvatarInto(avatarPreview, session.displayName || session.username, pendingAvatarDataUrl);
  } catch (e) {
    console.error(e);
    showToast("✕ ما كدرت أفتح هذي الصورة");
  }
};

saveProfileBtn.onclick = async () => {
  profileError.classList.add("hidden");
  const name = displayNameInput.value.trim();
  if (!name) {
    profileError.textContent = "✕ حط اسم";
    profileError.classList.remove("hidden");
    return;
  }
  saveProfileBtn.disabled = true;
  const update = { displayName: name };
  if (pendingAvatarDataUrl) update.avatar = pendingAvatarDataUrl;
  try {
    await updateDoc(doc(db, "chatUsers", session.username), update);
    session.displayName = name;
    if (pendingAvatarDataUrl) session.avatar = pendingAvatarDataUrl;
    localStorage.setItem("x1877chat_session", JSON.stringify(session));
    refreshMeUI();
    showToast("تحفظ الملف الشخصي ✓");
  } catch (e) {
    console.error(e);
    profileError.textContent = "✕ صار خطأ، جرب مرة ثانية (يمكن الصورة كبيرة)";
    profileError.classList.remove("hidden");
  }
  saveProfileBtn.disabled = false;
};

// ---------------- password change (while logged in) ----------------
changePassBtn.onclick = async () => {
  settingsError.classList.add("hidden");
  if (!oldPass.value || !newPass.value) {
    settingsError.textContent = "✕ عبي كل الحقول";
    settingsError.classList.remove("hidden");
    return;
  }
  if (newPass.value !== newPass2.value) {
    settingsError.textContent = "✕ الباسوورد الجديد ما يتطابق";
    settingsError.classList.remove("hidden");
    return;
  }
  changePassBtn.disabled = true;
  const ref = doc(db, "chatUsers", session.username);
  const snap = await getDoc(ref);
  const data = snap.data();
  const oldHash = await sha256Hex(session.username.toLowerCase() + ":" + oldPass.value);
  if (oldHash !== data.passHash) {
    settingsError.textContent = "✕ الرمز الحالي غلط";
    settingsError.classList.remove("hidden");
    changePassBtn.disabled = false;
    return;
  }
  const newHash = await sha256Hex(session.username.toLowerCase() + ":" + newPass.value);
  await updateDoc(ref, { passHash: newHash });
  changePassBtn.disabled = false;
  settingsModal.classList.add("hidden");
  oldPass.value = ""; newPass.value = ""; newPass2.value = "";
  showToast("تغيّر الرمز ✓");
};

// ---------------- forgot password (security question) ----------------
forgotFetchBtn.onclick = async () => {
  forgotError1.classList.add("hidden");
  const uname = forgotUser.value.trim();
  if (!uname) {
    forgotError1.textContent = "✕ اكتب اليوزر";
    forgotError1.classList.remove("hidden");
    return;
  }
  forgotFetchBtn.disabled = true;
  const snap = await getDoc(doc(db, "chatUsers", uname));
  forgotFetchBtn.disabled = false;
  if (!snap.exists() || !snap.data().secQuestion) {
    forgotError1.textContent = "✕ ما لكيت هذا اليوزر أو ما عنده سؤال أمان محفوظ";
    forgotError1.classList.remove("hidden");
    return;
  }
  forgotTargetUsername = uname;
  forgotQuestionText.textContent = snap.data().secQuestion;
  forgotStep1.classList.add("hidden");
  forgotStep2.classList.remove("hidden");
};

forgotResetBtn.onclick = async () => {
  forgotError2.classList.add("hidden");
  if (!forgotAnswer.value.trim() || !forgotNewPass.value) {
    forgotError2.textContent = "✕ عبي كل الحقول";
    forgotError2.classList.remove("hidden");
    return;
  }
  if (forgotNewPass.value !== forgotNewPass2.value) {
    forgotError2.textContent = "✕ الباسوورد الجديد ما يتطابق";
    forgotError2.classList.remove("hidden");
    return;
  }
  forgotResetBtn.disabled = true;
  const ref = doc(db, "chatUsers", forgotTargetUsername);
  const snap = await getDoc(ref);
  const data = snap.data();
  const answerHash = await sha256Hex(forgotTargetUsername.toLowerCase() + ":" + forgotAnswer.value.trim().toLowerCase());
  if (answerHash !== data.secAnswerHash) {
    forgotError2.textContent = "✕ الجواب غلط";
    forgotError2.classList.remove("hidden");
    forgotResetBtn.disabled = false;
    return;
  }
  const newHash = await sha256Hex(forgotTargetUsername.toLowerCase() + ":" + forgotNewPass.value);
  await updateDoc(ref, { passHash: newHash });
  forgotResetBtn.disabled = false;
  forgotModal.classList.add("hidden");
  showToast("تغيّر الباسوورد ✓ سجل دخول الحين");
};

// ---------------- visitor / presence counters ----------------
async function bumpVisitorCount() {
  const ref = doc(db, "chatStats", "counters");
  try {
    await setDoc(ref, { totalVisits: increment(1) }, { merge: true });
  } catch (e) { console.error(e); }
  onSnapshot(ref, (snap) => {
    totalVisitsEl.textContent = snap.exists() ? (snap.data().totalVisits ?? 0) : 0;
  });
}

function startPresenceHeartbeat() {
  const ref = doc(db, "chatPresence", session.username);
  const beat = () => setDoc(ref, { ts: Date.now() }).catch(() => {});
  beat();
  setInterval(beat, 10000);

  if (presenceUnsub) presenceUnsub();
  presenceUnsub = onSnapshot(collection(db, "chatPresence"), (snap) => {
    let online = 0;
    snap.forEach((d) => {
      const ts = d.data().ts;
      if (ts && Date.now() - ts < 25000) online++;
    });
    onlineCountEl.textContent = Math.max(online, 1);
  });
}

// ---------------- friends ----------------
tabFriends.onclick = () => switchTab("friends");
tabGroups.onclick = () => switchTab("groups");
function switchTab(tab) {
  tabFriends.classList.toggle("active", tab === "friends");
  tabGroups.classList.toggle("active", tab === "groups");
  friendsPanel.classList.toggle("hidden", tab !== "friends");
  groupsPanel.classList.toggle("hidden", tab !== "groups");
}

function listenFriends() {
  const ref = doc(db, "chatUsers", session.username);
  if (friendsUnsub) friendsUnsub();
  friendsUnsub = onSnapshot(
    ref,
    async (snap) => {
      if (!snap.exists()) return;
      const usernames = snap.data().friends || [];
      const objs = await Promise.all(
        usernames.map(async (f) => {
          const s = await getDoc(doc(db, "chatUsers", f));
          return s.exists()
            ? { username: f, id: s.data().id, displayName: s.data().displayName || f, avatar: s.data().avatar || "" }
            : { username: f, id: "?", displayName: f, avatar: "" };
        })
      );
      renderFriends(objs);
      renderGroupMemberChecklist(objs);
    },
    (err) => {
      console.error("friends listener error", err);
      showToast("✕ خطأ بجلب الأصدقاء: " + err.message);
    }
  );
}

function renderFriends(objs) {
  friendsList.innerHTML = "";
  if (objs.length === 0) {
    friendsList.innerHTML = `<p class="emptyHint">ما عندك أصدقاء بعد</p>`;
    return;
  }
  objs.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "listItem" + (selectedChat?.id === f.username && selectedChat?.type === "dm" ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(f.displayName));
    btn.onclick = () => openChat({ type: "dm", id: f.username, name: f.displayName });
    friendsList.appendChild(btn);
  });
}

addFriendBtn.onclick = addFriend;
addFriendInput.addEventListener("keydown", (e) => e.key === "Enter" && addFriend());

async function addFriend() {
  const q = addFriendInput.value.trim();
  if (!q) return;
  if (q === session.username) return showToast("ما تكدر تضيف نفسك");
  let targetUsername = q;
  let targetSnap = await getDoc(doc(db, "chatUsers", q));
  if (!targetSnap.exists()) {
    // search by id — small user bases only; fine for a personal site
    const all = await getDocsOnce("chatUsers");
    const match = all.find((u) => u.data.id === q);
    if (!match) return showToast("ما لكيت هذا اليوزر");
    targetUsername = match.id;
    targetSnap = await getDoc(doc(db, "chatUsers", targetUsername));
  }
  const meRef = doc(db, "chatUsers", session.username);
  const meSnap = await getDoc(meRef);
  const meData = meSnap.data();
  if ((meData.friends || []).includes(targetUsername)) return showToast("هذا صديقك خلص");
  const targetData = targetSnap.data();
  await updateDoc(meRef, { friends: [...(meData.friends || []), targetUsername] });
  await updateDoc(doc(db, "chatUsers", targetUsername), { friends: [...(targetData.friends || []), session.username] });
  addFriendInput.value = "";
  showToast("زاد عندك صديق");
}

// one-off full collection read (used only for id search)
async function getDocsOnce(collName) {
  const snap = await getDocs(collection(db, collName));
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, data: d.data() }));
  return out;
}

// ---------------- groups ----------------
function listenGroups() {
  const q = query(collection(db, "chatGroups"), where("members", "array-contains", session.username));
  if (groupsUnsub) groupsUnsub();
  groupsUnsub = onSnapshot(
    q,
    (snap) => {
      const groups = [];
      snap.forEach((d) => groups.push({ id: d.id, ...d.data() }));
      renderGroups(groups);
    },
    (err) => {
      console.error("groups listener error", err);
      showToast("✕ خطأ بجلب الكروبات: " + err.message);
    }
  );
}

function renderGroups(groups) {
  groupsList.innerHTML = "";
  if (groups.length === 0) {
    groupsList.innerHTML = `<p class="emptyHint">ما عندك كروبات بعد</p>`;
    return;
  }
  groups.forEach((g) => {
    const btn = document.createElement("button");
    btn.className = "listItem" + (selectedChat?.id === g.id && selectedChat?.type === "group" ? " active" : "");
    btn.innerHTML = `# ${g.name}<span class="groupMeta">${(g.members || []).length} أعضاء</span>`;
    btn.onclick = () => openChat({ type: "group", id: g.id, name: g.name });
    groupsList.appendChild(btn);
  });
}

let selectedFriendsForGroup = new Set();
newGroupBtn.onclick = () => {
  newGroupName.value = "";
  selectedFriendsForGroup = new Set();
  newGroupModal.classList.remove("hidden");
};

function renderGroupMemberChecklist(friendObjs) {
  newGroupMembers.innerHTML = "";
  if (friendObjs.length === 0) {
    newGroupMembers.innerHTML = `<p class="emptyHint">ضيف أصدقاء أول</p>`;
    return;
  }
  friendObjs.forEach((f) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.onchange = () => {
      if (cb.checked) selectedFriendsForGroup.add(f.username);
      else selectedFriendsForGroup.delete(f.username);
    };
    label.appendChild(cb);
    label.appendChild(document.createTextNode(f.displayName));
    newGroupMembers.appendChild(label);
  });
}

createGroupBtn.onclick = async () => {
  const name = newGroupName.value.trim();
  if (!name) return;
  const members = Array.from(new Set([session.username, ...selectedFriendsForGroup]));
  await addDoc(collection(db, "chatGroups"), {
    name, members, owner: session.username, createdAt: Date.now(),
  });
  newGroupModal.classList.add("hidden");
  showToast("تم إنشاء الكروب");
};

// ---------------- chat / messages ----------------
function openChat(chat) {
  selectedChat = chat;
  emptyState.classList.add("hidden");
  chatWindow.classList.remove("hidden");
  chatTitle.textContent = (chat.type === "group" ? "#" : "@") + chat.name;
  messagesBox.innerHTML = "";
  document.querySelectorAll("#friendsList .listItem, #groupsList .listItem").forEach((el) => el.classList.remove("active"));
  listenMessages();
}

function listenMessages() {
  const chatId = selectedChat.type === "dm" ? dmChatId(session.username, selectedChat.id) : "group__" + selectedChat.id;
  const secret = secretForChat(selectedChat);
  // NOTE: no orderBy here on purpose — where() + orderBy() on a different field
  // needs a composite Firestore index, and without it the listener fails silently.
  // We sort by timestamp ourselves after fetching instead.
  const q = query(collection(db, "chatMessages"), where("chatId", "==", chatId));
  if (messagesUnsub) messagesUnsub();
  messagesUnsub = onSnapshot(
    q,
    async (snap) => {
      const raw = [];
      snap.forEach((d) => raw.push(d.data()));
      raw.sort((a, b) => a.ts - b.ts);
      const decrypted = await Promise.all(raw.map(async (m) => ({ from: m.from, ts: m.ts, text: await decryptText(m.enc, secret) })));
      renderMessages(decrypted);
    },
    (err) => {
      console.error("messages listener error", err);
      showToast("✕ ما كدرت أجيب الرسائل: " + err.message);
    }
  );
}

function renderMessages(list) {
  messagesBox.innerHTML = "";
  if (list.length === 0) {
    messagesBox.innerHTML = `<p class="emptyHint">ابعث أول رسالة</p>`;
    return;
  }
  list.forEach((m) => {
    const mine = m.from === session.username;
    const row = document.createElement("div");
    row.className = "bubbleRow " + (mine ? "mine" : "theirs");
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (mine ? "mine" : "theirs");
    if (selectedChat.type === "group" && !mine) {
      const author = document.createElement("p");
      author.className = "bubbleAuthor";
      author.textContent = m.from;
      bubble.appendChild(author);
    }
    const text = document.createElement("p");
    text.className = "bubbleText";
    text.textContent = m.text;
    bubble.appendChild(text);
    row.appendChild(bubble);
    messagesBox.appendChild(row);
  });
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

sendBtn.onclick = sendMessage;
msgInput.addEventListener("keydown", (e) => e.key === "Enter" && sendMessage());

// ---------------- emoji picker ----------------
const EMOJIS = ["😀","😂","🥹","😍","😘","😎","🤔","😢","😭","😡","🥳","👍","👎","🙏","🔥","💯","❤️","🤍","💔","👋","😴","😱","🤝","🎉","😅","🙄","😏","🫡","👌"];
const emojiBtn = $("emojiBtn"), emojiPanel = $("emojiPanel");
EMOJIS.forEach((e) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = e;
  b.onclick = () => {
    msgInput.value += e;
    msgInput.focus();
  };
  emojiPanel.appendChild(b);
});
emojiBtn.onclick = () => emojiPanel.classList.toggle("hidden");

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !selectedChat) return;
  msgInput.value = "";
  const secret = secretForChat(selectedChat);
  const enc = await encryptText(text, secret);
  const chatId = selectedChat.type === "dm" ? dmChatId(session.username, selectedChat.id) : "group__" + selectedChat.id;
  await addDoc(collection(db, "chatMessages"), { chatId, from: session.username, enc, ts: Date.now() });
}
