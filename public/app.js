const state = {
  socket: null,
  roomId: "",
  userId: "",
  nickname: "",
  maxRoomUsers: 10,
  reconnectTimer: null,
  messages: new Map(),
  imageViewerScale: 1,
};

const MAX_IMAGE_DATA_URL_LENGTH = 14_000_000;
const MAX_RENDERED_MESSAGES = 200;
const IMAGE_VIEWER_MIN_SCALE = 0.5;
const IMAGE_VIEWER_MAX_SCALE = 5;
const IMAGE_VIEWER_SCALE_STEP = 0.2;

const elements = {
  nicknameCard: document.getElementById("nicknameCard"),
  nicknameInput: document.getElementById("nicknameInput"),
  updateNicknameButton: document.getElementById("updateNicknameButton"),
  roomCard: document.getElementById("roomCard"),
  passwordInput: document.getElementById("passwordInput"),
  roomInput: document.getElementById("roomInput"),
  createRoomButton: document.getElementById("createRoomButton"),
  joinRoomButton: document.getElementById("joinRoomButton"),
  currentRoomCard: document.getElementById("currentRoomCard"),
  currentRoomLabel: document.getElementById("currentRoomLabel"),
  inviteLinkInput: document.getElementById("inviteLinkInput"),
  copyInviteButton: document.getElementById("copyInviteButton"),
  statusText: document.getElementById("statusText"),
  onlineUsersCard: document.getElementById("onlineUsersCard"),
  onlineCount: document.getElementById("onlineCount"),
  userList: document.getElementById("userList"),
  messageList: document.getElementById("messageList"),
  messageInput: document.getElementById("messageInput"),
  imageInput: document.getElementById("imageInput"),
  sendButton: document.getElementById("sendButton"),
  messageTemplate: document.getElementById("messageTemplate"),
  imageViewer: document.getElementById("imageViewer"),
  imageViewerBackdrop: document.getElementById("imageViewerBackdrop"),
  imageViewerStage: document.getElementById("imageViewerStage"),
  imageViewerImage: document.getElementById("imageViewerImage"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  zoomResetButton: document.getElementById("zoomResetButton"),
  zoomInButton: document.getElementById("zoomInButton"),
  closeViewerButton: document.getElementById("closeViewerButton"),
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

function setRoomPanelsHidden(hidden) {
  elements.nicknameCard.hidden = hidden;
  elements.roomCard.hidden = hidden;
  elements.currentRoomCard.hidden = hidden;
  elements.onlineUsersCard.hidden = hidden;
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

function revokeNodeImageUrls(node) {
  const imageObjectUrls = Array.isArray(node.imageObjectUrls) ? node.imageObjectUrls : [];
  imageObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  node.imageObjectUrls = [];
}

function removeMessageNode(node) {
  if (!node) {
    return;
  }

  revokeNodeImageUrls(node);

  const messageId = node.dataset.messageId;
  if (messageId) {
    state.messages.delete(messageId);
  }

  node.remove();
}

function trimRenderedMessages() {
  while (elements.messageList.childElementCount > MAX_RENDERED_MESSAGES) {
    removeMessageNode(elements.messageList.firstElementChild);
  }
}

function clearMessages() {
  Array.from(elements.messageList.children).forEach(removeMessageNode);
  state.messages.clear();
}

function dataUrlToBlob(dataUrl) {
  const [header, base64Data = ""] = String(dataUrl).split(",");
  const mimeMatch = header.match(/^data:(.*?);base64$/);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function createImageObjectUrl(dataUrl) {
  return URL.createObjectURL(dataUrlToBlob(dataUrl));
}

function clampScale(scale) {
  return Math.min(IMAGE_VIEWER_MAX_SCALE, Math.max(IMAGE_VIEWER_MIN_SCALE, scale));
}

function applyImageViewerScale() {
  elements.imageViewerImage.style.transform = `scale(${state.imageViewerScale})`;
}

function setImageViewerScale(scale) {
  state.imageViewerScale = clampScale(scale);
  applyImageViewerScale();
}

function openImageViewer(sourceUrl) {
  if (!sourceUrl) {
    return;
  }

  elements.imageViewerImage.src = sourceUrl;
  elements.imageViewer.hidden = false;
  document.body.style.overflow = "hidden";
  elements.imageViewerStage.scrollTop = 0;
  elements.imageViewerStage.scrollLeft = 0;
  setImageViewerScale(1);
}

function closeImageViewer() {
  elements.imageViewer.hidden = true;
  elements.imageViewerImage.removeAttribute("src");
  document.body.style.overflow = "";
  setImageViewerScale(1);
}

function scrollMessageListToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
  const lastMessage = elements.messageList.lastElementChild;
  if (lastMessage) {
    lastMessage.scrollIntoView({ block: "end" });
  }
}

function scheduleScrollToBottom() {
  scrollMessageListToBottom();
  requestAnimationFrame(scrollMessageListToBottom);
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
  node.imageObjectUrls = [];

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
    const imageObjectUrl = createImageObjectUrl(imageDataUrl);
    node.imageObjectUrls.push(imageObjectUrl);
    image.src = imageObjectUrl;
    image.alt = "聊天图片";
    image.loading = "lazy";
    image.addEventListener("load", scheduleScrollToBottom, { once: true });
    image.addEventListener("error", scheduleScrollToBottom, { once: true });
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
  trimRenderedMessages();
  scheduleScrollToBottom();
}

function markMessageRecalled(messageId) {
  const messageEntry = state.messages.get(messageId);
  if (!messageEntry) {
    return;
  }

  const node = messageEntry;
  const body = node.querySelector(".message-body");
  const recallButton = node.querySelector(".message-recall-button");
  revokeNodeImageUrls(node);
  body.innerHTML = `<p>${escapeHtml("这条消息已被撤回")}</p>`;
  node.classList.add("recalled");
  recallButton.hidden = true;
  state.messages.delete(messageId);
}

function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    appendMessage({ system: true, text: "连接尚未建立，请稍后重试" });
    return false;
  }

  state.socket.send(JSON.stringify(payload));
  return true;
}

function joinRoom(roomId, options = {}) {
  const normalizedRoomId = String(roomId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  const password = elements.passwordInput.value.trim();
  const { requirePassword = false } = options;

  if (requirePassword && !password) {
    appendMessage({ system: true, text: "创建房间前请输入密码" });
    return;
  }

  elements.roomInput.value = normalizedRoomId;
  send({
    type: "join",
    roomId: normalizedRoomId,
    nickname: elements.nicknameInput.value.trim(),
    password,
  });
}

function handleJoined(message) {
  state.roomId = message.roomId;
  state.userId = message.userId;
  state.nickname = message.nickname;
  clearMessages();
  setRoomPanelsHidden(true);

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
  while (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH && quality > 0.45) {
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
  joinRoom(randomRoomId(), { requirePassword: true });
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
  const image = event.target.closest(".message-body img");
  if (image) {
    openImageViewer(image.currentSrc || image.src);
    return;
  }

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

elements.imageViewerBackdrop.addEventListener("click", closeImageViewer);
elements.closeViewerButton.addEventListener("click", closeImageViewer);
elements.zoomInButton.addEventListener("click", () => {
  setImageViewerScale(state.imageViewerScale + IMAGE_VIEWER_SCALE_STEP);
});
elements.zoomOutButton.addEventListener("click", () => {
  setImageViewerScale(state.imageViewerScale - IMAGE_VIEWER_SCALE_STEP);
});
elements.zoomResetButton.addEventListener("click", () => {
  setImageViewerScale(1);
});
elements.imageViewerStage.addEventListener(
  "wheel",
  (event) => {
    if (elements.imageViewer.hidden) {
      return;
    }

    event.preventDefault();
    const delta = event.deltaY < 0 ? IMAGE_VIEWER_SCALE_STEP : -IMAGE_VIEWER_SCALE_STEP;
    setImageViewerScale(state.imageViewerScale + delta);
  },
  { passive: false }
);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.imageViewer.hidden) {
    closeImageViewer();
  }
});

window.addEventListener("beforeunload", () => {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
});

connectSocket();
