const state = {
  socket: null,
  roomId: "",
  userId: "",
  nickname: "",
  maxRoomUsers: 10,
  reconnectTimer: null,
  messages: new Map(),
};

const elements = {
  nicknameInput: document.getElementById("nicknameInput"),
  updateNicknameButton: document.getElementById("updateNicknameButton"),
  roomInput: document.getElementById("roomInput"),
  createRoomButton: document.getElementById("createRoomButton"),
  joinRoomButton: document.getElementById("joinRoomButton"),
  currentRoomLabel: document.getElementById("currentRoomLabel"),
  inviteLinkInput: document.getElementById("inviteLinkInput"),
  copyInviteButton: document.getElementById("copyInviteButton"),
  statusText: document.getElementById("statusText"),
  onlineCount: document.getElementById("onlineCount"),
  userList: document.getElementById("userList"),
  messageList: document.getElementById("messageList"),
  messageInput: document.getElementById("messageInput"),
  imageInput: document.getElementById("imageInput"),
  sendButton: document.getElementById("sendButton"),
  messageTemplate: document.getElementById("messageTemplate"),
};

function randomRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

function getSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function updateInviteLink(roomId) {
  if (!roomId) {
    elements.inviteLinkInput.value = "";
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url);
  elements.inviteLinkInput.value = url.toString();
}

function renderUsers(users) {
  elements.userList.innerHTML = "";
  elements.onlineCount.textContent = `${users.length} / ${state.maxRoomUsers}`;

  users.forEach((user) => {
    const item = document.createElement("li");
    item.textContent = user.userId === state.userId ? `${user.nickname}（你）` : user.nickname;
    elements.userList.appendChild(item);
  });
}

function clearMessages() {
  state.messages.clear();
  elements.messageList.innerHTML = "";
}

function appendMessage({
  messageId = "",
  nickname,
  timestamp,
  text,
  imageDataUrl,
  system = false,
  self = false,
}) {
  const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
  const author = node.querySelector(".message-author");
  const time = node.querySelector(".message-time");
  const body = node.querySelector(".message-body");
  const recallButton = node.querySelector(".message-recall-button");

  author.textContent = system ? "系统消息" : nickname;
  time.textContent = formatTime(timestamp || Date.now());
  node.dataset.messageId = messageId;

  if (text) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    body.appendChild(paragraph);
  }

  if (imageDataUrl) {
    const image = document.createElement("img");
    image.src = imageDataUrl;
    image.alt = "聊天图片";
    image.loading = "lazy";
    body.appendChild(image);
  }

  if (system) {
    node.classList.add("system");
    recallButton.hidden = true;
  } else if (self) {
    node.classList.add("self");
    recallButton.hidden = false;
  } else {
    node.classList.add("other");
    recallButton.hidden = true;
  }

  if (messageId) {
    state.messages.set(messageId, node);
  }

  elements.messageList.appendChild(node);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function markMessageRecalled(messageId) {
  const node = state.messages.get(messageId);
  if (!node) {
    return;
  }

  const body = node.querySelector(".message-body");
  const recallButton = node.querySelector(".message-recall-button");
  body.innerHTML = `<p>${escapeHtml("这条消息已被撤回")}</p>`;
  node.classList.add("recalled");
  recallButton.hidden = true;
}

function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    appendMessage({ system: true, text: "连接尚未建立，请稍后重试" });
    return false;
  }

  state.socket.send(JSON.stringify(payload));
  return true;
}

function joinRoom(roomId) {
  const normalizedRoomId = String(roomId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);

  elements.roomInput.value = normalizedRoomId;
  send({
    type: "join",
    roomId: normalizedRoomId,
    nickname: elements.nicknameInput.value.trim(),
  });
}

function handleJoined(message) {
  state.roomId = message.roomId;
  state.userId = message.userId;
  state.nickname = message.nickname;
  clearMessages();

  elements.nicknameInput.value = message.nickname;
  elements.currentRoomLabel.textContent = message.roomId;
  updateInviteLink(message.roomId);
  renderUsers(message.users);
  setStatus(`已进入房间 ${message.roomId}`);
  appendMessage({ system: true, text: `已成功进入房间 ${message.roomId}` });
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解析失败"));
    image.src = dataUrl;
  });
}

async function compressImage(file) {
  const sourceDataUrl = await readImageAsDataUrl(file);
  if (file.type === "image/gif" || file.type === "image/svg+xml") {
    return {
      fileName: file.name,
      imageDataUrl: sourceDataUrl,
    };
  }

  const image = await loadImage(sourceDataUrl);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let { width, height } = image;
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(width, height));

  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.9;
  let imageDataUrl = canvas.toDataURL("image/jpeg", quality);
  while (imageDataUrl.length > 2_800_000 && quality > 0.45) {
    quality -= 0.1;
    imageDataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  return {
    fileName: file.name.replace(/\.[^.]+$/, "") + ".jpg",
    imageDataUrl,
  };
}

async function sendImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    appendMessage({ system: true, text: "只能发送图片文件" });
    return;
  }

  try {
    appendMessage({ system: true, text: `正在处理图片：${file.name}` });
    const { fileName, imageDataUrl } = await compressImage(file);
    const isSent = send({
      type: "chat:image",
      fileName,
      imageDataUrl,
    });

    if (isSent) {
      appendMessage({ system: true, text: `图片 ${fileName} 已发送` });
    }
  } catch (error) {
    appendMessage({ system: true, text: error.message || "发送图片失败" });
  }
}

async function handleImageSelection(event) {
  const [file] = event.target.files || [];
  if (file) {
    await sendImageFile(file);
  }
  event.target.value = "";
}

function handleRecalledMessage(message) {
  markMessageRecalled(message.messageId);
  appendMessage({
    system: true,
    text: message.userId === state.userId ? "你撤回了一条消息" : `${message.nickname} 撤回了一条消息`,
    timestamp: message.timestamp,
  });
}

function handleSocketMessage(event) {
  const message = JSON.parse(event.data);

  if (message.type === "connected") {
    state.maxRoomUsers = message.maxRoomUsers || 10;
    elements.onlineCount.textContent = `0 / ${state.maxRoomUsers}`;

    const roomFromUrl = new URL(window.location.href).searchParams.get("room");
    if (roomFromUrl) {
      joinRoom(roomFromUrl);
    }
    return;
  }

  if (message.type === "joined") {
    handleJoined(message);
    return;
  }

  if (message.type === "presence") {
    renderUsers(message.users || []);
    if (message.notice) {
      appendMessage({ system: true, text: message.notice });
    }
    return;
  }

  if (message.type === "chat:text") {
    appendMessage({
      messageId: message.messageId,
      nickname: message.nickname,
      timestamp: message.timestamp,
      text: message.content,
      self: message.userId === state.userId,
    });
    return;
  }

  if (message.type === "chat:image") {
    appendMessage({
      messageId: message.messageId,
      nickname: message.nickname,
      timestamp: message.timestamp,
      text: message.fileName ? `发送了图片：${message.fileName}` : "发送了一张图片",
      imageDataUrl: message.imageDataUrl,
      self: message.userId === state.userId,
    });
    return;
  }

  if (message.type === "chat:recalled") {
    handleRecalledMessage(message);
    return;
  }

  if (message.type === "error") {
    appendMessage({ system: true, text: message.message || "发生未知错误" });
  }
}

function connectSocket() {
  const socket = new WebSocket(getSocketUrl());
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    setStatus("服务器连接成功");
  });

  socket.addEventListener("message", handleSocketMessage);

  socket.addEventListener("close", () => {
    setStatus("连接已断开，3 秒后重连");
    state.reconnectTimer = setTimeout(connectSocket, 3000);
  });

  socket.addEventListener("error", () => {
    setStatus("连接出现异常");
  });
}

function sendTextMessage() {
  const content = elements.messageInput.value.trim();
  if (!content) {
    return;
  }

  const isSent = send({
    type: "chat:text",
    content,
  });

  if (isSent) {
    elements.messageInput.value = "";
  }
}

function recallMessage(messageId) {
  if (!messageId) {
    return;
  }

  send({
    type: "chat:recall",
    messageId,
  });
}

elements.createRoomButton.addEventListener("click", () => {
  joinRoom(randomRoomId());
});

elements.joinRoomButton.addEventListener("click", () => {
  joinRoom(elements.roomInput.value);
});

elements.updateNicknameButton.addEventListener("click", () => {
  const nickname = elements.nicknameInput.value.trim();
  if (!nickname) {
    appendMessage({ system: true, text: "昵称不能为空" });
    return;
  }

  const isSent = send({
    type: "rename",
    nickname,
  });

  if (isSent) {
    state.nickname = nickname;
  }
});

elements.copyInviteButton.addEventListener("click", async () => {
  const value = elements.inviteLinkInput.value;
  if (!value) {
    appendMessage({ system: true, text: "请先进入房间再复制链接" });
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    appendMessage({ system: true, text: "邀请链接已复制" });
  } catch (error) {
    appendMessage({ system: true, text: "复制失败，请手动复制" });
  }
});

elements.sendButton.addEventListener("click", sendTextMessage);
elements.imageInput.addEventListener("change", handleImageSelection);
elements.messageList.addEventListener("click", (event) => {
  const button = event.target.closest(".message-recall-button");
  if (!button) {
    return;
  }

  const messageNode = button.closest(".message");
  recallMessage(messageNode ? messageNode.dataset.messageId : "");
});

elements.messageInput.addEventListener("paste", async (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) {
    return;
  }

  event.preventDefault();
  const file = imageItem.getAsFile();
  if (file) {
    await sendImageFile(file);
  }
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTextMessage();
  }
});

connectSocket();
