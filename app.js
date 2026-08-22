import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, updateDoc, getDocs,
  collection, query, where, orderBy, onSnapshot,
  addDoc, increment, serverTimestamp,
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

// ---------------- state ----------------
let session = null; // {username, id}
let selectedChat = null; // {type:'dm'|'group', id, name}
let friendsUnsub = null;
let groupsUnsub = null;
let messagesUnsub = null;
let presenceUnsub = null;

// ---------------- DOM refs ----------------
const $ = (id) => document.getElementById(id);
const authScreen = $("authScreen"), appScreen = $("appScreen");
const authUser = $("authUser"), authPass = $("authPass"), authError = $("authError"), authBtn = $("authBtn");
const meName = $("meName"), meId = $("meId"), avatar = $("avatar");
const totalVisitsEl = $("totalVisits"), onlineCountEl = $("onlineCount");
const friendsList = $("friendsList"), groupsList = $("groupsList");
const addFriendInput = $("addFriendInput"), addFriendBtn = $("addFriendBtn");
const tabFriends = $("tabFriends"), tabGroups = $("tabGroups");
const friendsPanel = $("friendsPanel"), groupsPanel = $("groupsPanel");
const newGroupBtn = $("newGroupBtn"), newGroupModal = $("newGroupModal");
const newGroupName = $("newGroupName"), newGroupMembers = $("newGroupMembers"), createGroupBtn = $("createGroupBtn");
const settingsBtn = $("settingsBtn"), settingsModal = $("settingsModal");
const oldPass = $("oldPass"), newPass = $("newPass"), newPass2 = $("newPass2"), settingsError = $("settingsError"), changePassBtn = $("changePassBtn");
const logoutBtn = $("logoutBtn"), copyIdBtn = $("copyIdBtn");
const emptyState = $("emptyState"), chatWindow = $("chatWindow"), chatTitle = $("chatTitle");
const messagesBox = $("messagesBox"), msgInput = $("msgInput"), sendBtn = $("sendBtn");
const toast = $("toast");

const showToast = (t) => {
  toast.textContent = t;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2200);
};

// ---------------- auth ----------------
authBtn.onclick = handleAuth;
authPass.addEventListener("keydown", (e) => e.key === "Enter" && handleAuth());

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
      session = { username: uname, id: data.id };
    } else {
      const id = String(Math.floor(100000 + Math.random() * 899999));
      await setDoc(ref, { passHash, id, friends: [], createdAt: Date.now() });
      session = { username: uname, id };
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
  meName.textContent = session.username;
  meId.textContent = session.id;
  avatar.textContent = session.username[0]?.toUpperCase() || "?";
  bumpVisitorCount();
  startPresenceHeartbeat();
  listenFriends();
  listenGroups();
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

// ---------------- password change ----------------
settingsBtn.onclick = () => settingsModal.classList.remove("hidden");
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.onclick = () => $(btn.dataset.close).classList.add("hidden");
});

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
  friendsUnsub = onSnapshot(ref, async (snap) => {
    if (!snap.exists()) return;
    const usernames = snap.data().friends || [];
    const objs = await Promise.all(
      usernames.map(async (f) => {
        const s = await getDoc(doc(db, "chatUsers", f));
        return s.exists() ? { username: f, id: s.data().id } : { username: f, id: "?" };
      })
    );
    renderFriends(objs);
    renderGroupMemberChecklist(objs);
  });
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
    btn.innerHTML = `<span class="dot"></span>${f.username}`;
    btn.onclick = () => openChat({ type: "dm", id: f.username, name: f.username });
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
  groupsUnsub = onSnapshot(q, (snap) => {
    const groups = [];
    snap.forEach((d) => groups.push({ id: d.id, ...d.data() }));
    renderGroups(groups);
  });
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
    label.appendChild(document.createTextNode(f.username));
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
  const q = query(collection(db, "chatMessages"), where("chatId", "==", chatId), orderBy("ts", "asc"));
  if (messagesUnsub) messagesUnsub();
  messagesUnsub = onSnapshot(q, async (snap) => {
    const raw = [];
    snap.forEach((d) => raw.push(d.data()));
    const decrypted = await Promise.all(raw.map(async (m) => ({ from: m.from, ts: m.ts, text: await decryptText(m.enc, secret) })));
    renderMessages(decrypted);
  });
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

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !selectedChat) return;
  msgInput.value = "";
  const secret = secretForChat(selectedChat);
  const enc = await encryptText(text, secret);
  const chatId = selectedChat.type === "dm" ? dmChatId(session.username, selectedChat.id) : "group__" + selectedChat.id;
  await addDoc(collection(db, "chatMessages"), { chatId, from: session.username, enc, ts: Date.now() });
}
