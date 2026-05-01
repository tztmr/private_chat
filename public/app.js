const state = {
  socket: null,
  roomId: "",
  userId: "",
  nickname: "",
  maxRoomUsers: 10,
  reconnectTimer: null,
  messages: new Map(),
  imageViewerScale: 1,
  imageViewerOffsetX: 0,
  imageViewerOffsetY: 0,
  imageViewerPointer: null,
  imageViewerPinch: null,
  keyboardOffset: 0,
  pendingImagePreviews: [],
};

const TARGET_IMAGE_UPLOAD_BYTES = 450 * 1024;
const MAX_IMAGE_DIMENSION = 1280;
const MIN_IMAGE_QUALITY = 0.5;
const MAX_RENDERED_MESSAGES = 200;
const IMAGE_VIEWER_MIN_SCALE = 0.5;
const IMAGE_VIEWER_MAX_SCALE = 5;
const IMAGE_VIEWER_SCALE_STEP = 0.2;
const SYSTEM_MESSAGE_LIFETIME_MS = 10_000;

const elements = {
  pageRoot: document.getElementById("pageRoot"),
  sidebar: document.getElementById("sidebar"),
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
  pinnedNotice: document.getElementById("pinnedNotice"),
  messageList: document.getElementById("messageList"),
  composer: document.querySelector(".composer"),
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setRoomPanelsHidden(hidden) {
  elements.sidebar.hidden = hidden;
  elements.pageRoot.classList.toggle("sidebar-hidden", hidden);
  elements.nicknameCard.hidden = hidden;
  elements.roomCard.hidden = hidden;
  elements.currentRoomCard.hidden = hidden;
  elements.onlineUsersCard.hidden = hidden;
}

function setPinnedNoticeVisible(visible) {
  elements.pinnedNotice.hidden = !visible;
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

  if (node.removeTimer) {
    clearTimeout(node.removeTimer);
    node.removeTimer = null;
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

function clampImageViewerOffset(value, axis) {
  const image = elements.imageViewerImage;
  const stage = elements.imageViewerStage;
  const scaledImageSize =
    (axis === "x" ? image.naturalWidth : image.naturalHeight) * state.imageViewerScale;
  const stageSize = axis === "x" ? stage.clientWidth : stage.clientHeight;
  const maxOffset = Math.max(0, (scaledImageSize - stageSize) / 2);
  return Math.min(maxOffset, Math.max(-maxOffset, value));
}

function setImageViewerOffset(offsetX, offsetY) {
  state.imageViewerOffsetX = clampImageViewerOffset(offsetX, "x");
  state.imageViewerOffsetY = clampImageViewerOffset(offsetY, "y");
  applyImageViewerScale();
}

function applyImageViewerScale() {
  elements.imageViewerImage.style.transform = `translate(${state.imageViewerOffsetX}px, ${state.imageViewerOffsetY}px) scale(${state.imageViewerScale})`;
}

function setImageViewerScale(scale) {
  state.imageViewerScale = clampScale(scale);
  state.imageViewerOffsetX = clampImageViewerOffset(state.imageViewerOffsetX, "x");
  state.imageViewerOffsetY = clampImageViewerOffset(state.imageViewerOffsetY, "y");
  applyImageViewerScale();
}

function openImageViewer(sourceUrl) {
  if (!sourceUrl) {
    return;
  }

  state.imageViewerOffsetX = 0;
  state.imageViewerOffsetY = 0;
  state.imageViewerPointer = null;
  state.imageViewerPinch = null;
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
  state.imageViewerOffsetX = 0;
  state.imageViewerOffsetY = 0;
  state.imageViewerPointer = null;
  state.imageViewerPinch = null;
  setImageViewerScale(1);
}

function getViewportHeight() {
  if (window.visualViewport && window.visualViewport.height) {
    return window.visualViewport.height;
  }
  return window.innerHeight;
}

function updateViewportHeight() {
  const viewportHeight = Math.max(320, Math.round(getViewportHeight()));
  document.documentElement.style.setProperty("--app-height", `${viewportHeight}px`);
}

function setKeyboardOffset(offset) {
  state.keyboardOffset = Math.max(0, offset);
  document.documentElement.style.setProperty("--keyboard-offset", `${state.keyboardOffset}px`);
}

function isComposerFocused() {
  return document.activeElement === elements.messageInput;
}

function updateKeyboardOffset() {
  updateViewportHeight();

  if (!isComposerFocused()) {
    setKeyboardOffset(0);
    return;
  }

  const viewport = window.visualViewport;
  if (!viewport) {
    setKeyboardOffset(0);
    return;
  }

  const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  setKeyboardOffset(keyboardOffset);
  scheduleScrollToBottom();
}

function autoResizeMessageInput() {
  const input = elements.messageInput;
  if (!input) {
    return;
  }

  input.style.height = "auto";
  const computed = window.getComputedStyle(input);
  const lineHeight = parseFloat(computed.lineHeight) || 24;
  const minHeight = 80;
  const maxHeight = Math.round(lineHeight * 5);
  const nextHeight = Math.min(maxHeight, input.scrollHeight);
  input.style.height = `${Math.max(nextHeight, minHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

function getTouchDistance(firstTouch, secondTouch) {
  const deltaX = secondTouch.clientX - firstTouch.clientX;
  const deltaY = secondTouch.clientY - firstTouch.clientY;
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

function getTouchCenter(firstTouch, secondTouch) {
  return {
    x: (firstTouch.clientX + secondTouch.clientX) / 2,
    y: (firstTouch.clientY + secondTouch.clientY) / 2,
  };
}

function beginImageViewerDrag(clientX, clientY) {
  state.imageViewerPointer = {
    clientX,
    clientY,
    offsetX: state.imageViewerOffsetX,
    offsetY: state.imageViewerOffsetY,
  };
}

function updateImageViewerDrag(clientX, clientY) {
  if (!state.imageViewerPointer) {
    return;
  }

  const deltaX = clientX - state.imageViewerPointer.clientX;
  const deltaY = clientY - state.imageViewerPointer.clientY;
  setImageViewerOffset(state.imageViewerPointer.offsetX + deltaX, state.imageViewerPointer.offsetY + deltaY);
}

function endImageViewerDrag() {
  state.imageViewerPointer = null;
}

function beginImageViewerPinch(firstTouch, secondTouch) {
  const center = getTouchCenter(firstTouch, secondTouch);
  state.imageViewerPinch = {
    distance: getTouchDistance(firstTouch, secondTouch),
    centerX: center.x,
    centerY: center.y,
    scale: state.imageViewerScale,
  };
}

function updateImageViewerPinch(firstTouch, secondTouch) {
  if (!state.imageViewerPinch) {
    return;
  }

  const distance = getTouchDistance(firstTouch, secondTouch);
  if (!distance) {
    return;
  }

  const nextScale = (distance / state.imageViewerPinch.distance) * state.imageViewerPinch.scale;
  setImageViewerScale(nextScale);
}

function endImageViewerPinch() {
  state.imageViewerPinch = null;
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
  imageUrl = "",
  system = false,
  temporary = false,
  self = false,
  pending = false,
}) {
  const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
  const author = node.querySelector(".message-author");
  const time = node.querySelector(".message-time");
  const body = node.querySelector(".message-body");
  const bubble = node.querySelector(".message-bubble");
  const recallButton = node.querySelector(".message-recall-button");
  const isImageOnly = Boolean((imageDataUrl || imageUrl) && !text);
  node.imageObjectUrls = [];

  author.textContent = system ? "系统消息" : nickname;
  time.textContent = formatTime(timestamp || Date.now());
  node.dataset.messageId = messageId;

  if (text) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    body.appendChild(paragraph);
  }

  if (imageDataUrl || imageUrl) {
    const image = document.createElement("img");
    const resolvedImageUrl = imageUrl || createImageObjectUrl(imageDataUrl);
    if (resolvedImageUrl.startsWith("blob:")) {
      node.imageObjectUrls.push(resolvedImageUrl);
    }
    image.src = resolvedImageUrl;
    image.alt = "聊天图片";
    image.addEventListener("load", scheduleScrollToBottom, { once: true });
    image.addEventListener("error", scheduleScrollToBottom, { once: true });
    body.appendChild(image);
  }

  if (isImageOnly) {
    bubble.classList.add("image-only");
    body.classList.add("image-only");
  }

  if (system) {
    node.classList.add("system");
    recallButton.hidden = true;
    if (temporary) {
      node.removeTimer = setTimeout(() => {
        removeMessageNode(node);
      }, SYSTEM_MESSAGE_LIFETIME_MS);
    }
  } else if (self) {
    node.classList.add("self");
    recallButton.hidden = false;
  } else {
    node.classList.add("other");
    recallButton.hidden = true;
  }

  if (pending) {
    node.classList.add("pending-image");
    recallButton.hidden = true;
  }

  if (messageId) {
    state.messages.set(messageId, node);
  }

  elements.messageList.appendChild(node);
  trimRenderedMessages();
  scheduleScrollToBottom();
  return node;
}

function appendHistoryMessage(message) {
  appendMessage({
    messageId: message.messageId,
    nickname: message.nickname,
    timestamp: message.timestamp,
    text:
      message.recalled
        ? "这条消息已被撤回"
        : message.type === "chat:text"
          ? message.content
          : "",
    imageDataUrl: message.recalled || message.type !== "chat:image" ? "" : message.imageDataUrl,
    self: message.userId === state.userId,
  });

  if (!message.recalled) {
    return;
  }

  const node = state.messages.get(message.messageId);
  if (!node) {
    return;
  }

  node.classList.add("recalled");
  const recallButton = node.querySelector(".message-recall-button");
  if (recallButton) {
    recallButton.hidden = true;
  }
}

function markMessageRecalled(messageId) {
  const messageEntry = state.messages.get(messageId);
  if (!messageEntry) {
    return;
  }

  const node = messageEntry;
  const body = node.querySelector(".message-body");
  const bubble = node.querySelector(".message-bubble");
  const recallButton = node.querySelector(".message-recall-button");
  revokeNodeImageUrls(node);
  bubble.classList.remove("image-only");
  body.classList.remove("image-only");
  body.innerHTML = `<p>${escapeHtml("这条消息已被撤回")}</p>`;
  node.classList.add("recalled");
  recallButton.hidden = true;
  state.messages.delete(messageId);
}

function getNextPendingImagePreview() {
  while (state.pendingImagePreviews.length > 0) {
    const previewNode = state.pendingImagePreviews.shift();
    if (previewNode && previewNode.isConnected) {
      return previewNode;
    }
  }

  return null;
}

function addPendingImagePreview(file) {
  const previewUrl = URL.createObjectURL(file);
  const previewNode = appendMessage({
    nickname: state.nickname || "我",
    timestamp: Date.now(),
    imageUrl: previewUrl,
    self: true,
    pending: true,
  });
  state.pendingImagePreviews.push(previewNode);
  return previewNode;
}

function adoptPendingImagePreview(message) {
  const previewNode = getNextPendingImagePreview();
  if (!previewNode) {
    return false;
  }

  const time = previewNode.querySelector(".message-time");
  const recallButton = previewNode.querySelector(".message-recall-button");
  previewNode.classList.remove("pending-image");
  previewNode.dataset.messageId = message.messageId || "";
  time.textContent = formatTime(message.timestamp || Date.now());

  if (message.messageId) {
    state.messages.set(message.messageId, previewNode);
  }

  recallButton.hidden = false;
  scheduleScrollToBottom();
  return true;
}

function removePendingImagePreview(previewNode) {
  if (!previewNode) {
    return;
  }

  removeMessageNode(previewNode);
}

function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    appendMessage({ system: true, temporary: true, text: "连接尚未建立，请稍后重试" });
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
  const password = elements.passwordInput.value.trim();

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
  setPinnedNoticeVisible(true);

  elements.nicknameInput.value = message.nickname;
  elements.currentRoomLabel.textContent = message.roomId;
  updateInviteLink(message.roomId);
  renderUsers(message.users);
  (message.messages || []).forEach(appendHistoryMessage);
  setStatus(`已进入房间 ${message.roomId}`);
  appendMessage({ system: true, temporary: true, text: `已成功进入房间 ${message.roomId}` });
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片转换失败"));
    reader.readAsDataURL(blob);
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

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("图片压缩失败"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

async function compressImage(file) {
  if (file.type === "image/gif" || file.type === "image/svg+xml") {
    const sourceDataUrl = await readImageAsDataUrl(file);
    return {
      fileName: file.name,
      imageDataUrl: sourceDataUrl,
    };
  }

  const sourceUrl = URL.createObjectURL(file);
  let image;

  try {
    image = await loadImage(sourceUrl);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器不支持图片压缩");
  }
  let { width, height } = image;
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));

  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.82;
  let imageBlob = await canvasToBlob(canvas, "image/jpeg", quality);
  while (imageBlob.size > TARGET_IMAGE_UPLOAD_BYTES && quality > MIN_IMAGE_QUALITY) {
    quality -= 0.08;
    imageBlob = await canvasToBlob(canvas, "image/jpeg", quality);
  }
  const imageDataUrl = await readBlobAsDataUrl(imageBlob);

  return {
    fileName: file.name.replace(/\.[^.]+$/, "") + ".jpg",
    imageDataUrl,
  };
}

async function sendImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    appendMessage({ system: true, temporary: true, text: "只能发送图片文件" });
    return;
  }

  const previewNode = addPendingImagePreview(file);

  try {
    const { fileName, imageDataUrl } = await compressImage(file);
    const isSent = send({
      type: "chat:image",
      fileName,
      imageDataUrl,
    });

    if (!isSent) {
      removePendingImagePreview(previewNode);
    }
  } catch (error) {
    removePendingImagePreview(previewNode);
    appendMessage({ system: true, temporary: true, text: error.message || "发送图片失败" });
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
    temporary: true,
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
      appendMessage({ system: true, temporary: false, text: message.notice });
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
    if (message.userId === state.userId && adoptPendingImagePreview(message)) {
      return;
    }

    appendMessage({
      messageId: message.messageId,
      nickname: message.nickname,
      timestamp: message.timestamp,
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
    appendMessage({ system: true, temporary: true, text: message.message || "发生未知错误" });
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
    setPinnedNoticeVisible(Boolean(state.roomId));
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
    autoResizeMessageInput();
    scheduleScrollToBottom();
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
    appendMessage({ system: true, temporary: true, text: "昵称不能为空" });
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
    appendMessage({ system: true, temporary: true, text: "请先进入房间再复制链接" });
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    appendMessage({ system: true, temporary: true, text: "邀请链接已复制" });
  } catch (error) {
    appendMessage({ system: true, temporary: true, text: "复制失败，请手动复制" });
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
  const clipboardData = event.clipboardData;
  const items = Array.from((clipboardData && clipboardData.items) || []);
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

elements.messageInput.addEventListener("input", () => {
  autoResizeMessageInput();
  updateKeyboardOffset();
});

elements.messageInput.addEventListener("focus", () => {
  autoResizeMessageInput();
  updateKeyboardOffset();
  setTimeout(updateKeyboardOffset, 250);
});

elements.messageInput.addEventListener("blur", () => {
  setTimeout(updateKeyboardOffset, 50);
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

elements.imageViewerStage.addEventListener("mousedown", (event) => {
  if (elements.imageViewer.hidden || event.button !== 0) {
    return;
  }

  event.preventDefault();
  beginImageViewerDrag(event.clientX, event.clientY);
});

elements.imageViewerStage.addEventListener(
  "touchstart",
  (event) => {
    if (elements.imageViewer.hidden) {
      return;
    }

    if (event.touches.length >= 2) {
      beginImageViewerPinch(event.touches[0], event.touches[1]);
      endImageViewerDrag();
      return;
    }

    if (event.touches.length === 1) {
      beginImageViewerDrag(event.touches[0].clientX, event.touches[0].clientY);
    }
  },
  { passive: true }
);

elements.imageViewerStage.addEventListener(
  "touchmove",
  (event) => {
    if (elements.imageViewer.hidden) {
      return;
    }

    if (event.touches.length >= 2) {
      event.preventDefault();
      updateImageViewerPinch(event.touches[0], event.touches[1]);
      return;
    }

    if (event.touches.length === 1 && state.imageViewerPointer) {
      event.preventDefault();
      updateImageViewerDrag(event.touches[0].clientX, event.touches[0].clientY);
    }
  },
  { passive: false }
);

elements.imageViewerStage.addEventListener("touchend", (event) => {
  if (event.touches.length >= 2) {
    beginImageViewerPinch(event.touches[0], event.touches[1]);
    return;
  }

  endImageViewerPinch();
  if (event.touches.length === 1) {
    beginImageViewerDrag(event.touches[0].clientX, event.touches[0].clientY);
    return;
  }

  endImageViewerDrag();
});

elements.imageViewerStage.addEventListener("touchcancel", () => {
  endImageViewerPinch();
  endImageViewerDrag();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.imageViewer.hidden) {
    closeImageViewer();
  }
});

window.addEventListener("mousemove", (event) => {
  if (!state.imageViewerPointer || elements.imageViewer.hidden) {
    return;
  }

  updateImageViewerDrag(event.clientX, event.clientY);
});

window.addEventListener("mouseup", () => {
  endImageViewerDrag();
});

window.addEventListener("resize", () => {
  updateViewportHeight();
  autoResizeMessageInput();
  updateKeyboardOffset();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateKeyboardOffset);
  window.visualViewport.addEventListener("scroll", updateKeyboardOffset);
}

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

updateViewportHeight();
autoResizeMessageInput();
updateKeyboardOffset();
connectSocket();
