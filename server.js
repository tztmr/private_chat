const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const MAX_ROOM_USERS = 10;
const MAX_TEXT_LENGTH = 1000;
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;
const ROOM_ID_LENGTH = 8;
const USER_ID_LENGTH = 10;
const MESSAGE_ID_LENGTH = 12;
const GUEST_NAME_LENGTH = 4;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function randomId(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";

  for (let index = 0; index < length; index += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }

  return result;
}

function createRoomIfMissing(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Map(),
      messages: new Map(),
    });
  }

  return rooms.get(roomId);
}

function removeUserFromRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  room.clients.delete(userId);
  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function buildUserList(room) {
  return Array.from(room.clients.values()).map((client) => ({
    userId: client.userId,
    nickname: client.nickname,
  }));
}

function broadcastToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const message = JSON.stringify(payload);
  for (const client of room.clients.values()) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(message);
    }
  }
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function normalizeNickname(rawNickname) {
  const trimmed = String(rawNickname || "").trim().slice(0, 20);
  return trimmed || `游客${randomId(GUEST_NAME_LENGTH)}`;
}

function parseImageSize(dataUrl) {
  const parts = String(dataUrl).split(",");
  if (parts.length < 2) {
    return Number.MAX_SAFE_INTEGER;
  }

  const base64Content = parts[1];
  return Buffer.byteLength(base64Content, "base64");
}

function createMessageRecord({ type, sender, content, fileName, imageDataUrl }) {
  return {
    messageId: randomId(MESSAGE_ID_LENGTH),
    type,
    senderUserId: sender.userId,
    senderNickname: sender.nickname,
    content,
    fileName,
    imageDataUrl,
    timestamp: Date.now(),
    recalled: false,
  };
}

wss.on("connection", (socket) => {
  let currentRoomId = null;
  let currentUserId = null;

  send(socket, {
    type: "connected",
    maxRoomUsers: MAX_ROOM_USERS,
  });

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      send(socket, { type: "error", message: "消息格式不正确" });
      return;
    }

    if (message.type === "join") {
      if (currentRoomId && currentUserId) {
        const previousRoomId = currentRoomId;
        removeUserFromRoom(currentRoomId, currentUserId);
        if (rooms.has(previousRoomId)) {
          broadcastToRoom(previousRoomId, {
            type: "presence",
            users: buildUserList(rooms.get(previousRoomId)),
            notice: "有用户切换到了其他房间",
          });
        }
      }

      const requestedRoomId = String(message.roomId || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, ROOM_ID_LENGTH);
      const roomId = requestedRoomId || randomId(ROOM_ID_LENGTH);

      const room = createRoomIfMissing(roomId);
      if (room.clients.size >= MAX_ROOM_USERS) {
        send(socket, { type: "error", message: "房间已满，最多 10 人" });
        return;
      }

      const userId = randomId(USER_ID_LENGTH);
      const nickname = normalizeNickname(message.nickname);

      currentRoomId = roomId;
      currentUserId = userId;
      room.clients.set(userId, { userId, nickname, socket });

      send(socket, {
        type: "joined",
        roomId,
        userId,
        nickname,
        users: buildUserList(room),
      });

      broadcastToRoom(roomId, {
        type: "presence",
        users: buildUserList(room),
        notice: `${nickname} 加入了房间`,
      });
      return;
    }

    if (!currentRoomId || !currentUserId) {
      send(socket, { type: "error", message: "请先加入房间" });
      return;
    }

    const room = rooms.get(currentRoomId);
    const sender = room ? room.clients.get(currentUserId) : null;
    if (!room || !sender) {
      send(socket, { type: "error", message: "房间已失效，请重新进入" });
      return;
    }

    if (message.type === "rename") {
      sender.nickname = normalizeNickname(message.nickname);
      broadcastToRoom(currentRoomId, {
        type: "presence",
        users: buildUserList(room),
        notice: `${sender.nickname} 更新了昵称`,
      });
      return;
    }

    if (message.type === "chat:text") {
      const content = String(message.content || "").trim().slice(0, MAX_TEXT_LENGTH);
      if (!content) {
        send(socket, { type: "error", message: "文字消息不能为空" });
        return;
      }

      const messageRecord = createMessageRecord({
        type: "chat:text",
        sender,
        content,
      });
      room.messages.set(messageRecord.messageId, messageRecord);

      broadcastToRoom(currentRoomId, {
        type: "chat:text",
        messageId: messageRecord.messageId,
        roomId: currentRoomId,
        userId: sender.userId,
        nickname: sender.nickname,
        content: messageRecord.content,
        timestamp: messageRecord.timestamp,
      });
      return;
    }

    if (message.type === "chat:image") {
      const imageDataUrl = String(message.imageDataUrl || "");
      const imageSize = parseImageSize(imageDataUrl);
      const fileName = String(message.fileName || "image");

      if (!imageDataUrl.startsWith("data:image/")) {
        send(socket, { type: "error", message: "仅支持图片文件" });
        return;
      }

      if (imageSize > MAX_IMAGE_SIZE_BYTES) {
        send(socket, { type: "error", message: "图片过大，请控制在 2MB 内" });
        return;
      }

      const messageRecord = createMessageRecord({
        type: "chat:image",
        sender,
        fileName: fileName.slice(0, 80),
        imageDataUrl,
      });
      room.messages.set(messageRecord.messageId, messageRecord);

      broadcastToRoom(currentRoomId, {
        type: "chat:image",
        messageId: messageRecord.messageId,
        roomId: currentRoomId,
        userId: sender.userId,
        nickname: sender.nickname,
        fileName: messageRecord.fileName,
        imageDataUrl: messageRecord.imageDataUrl,
        timestamp: messageRecord.timestamp,
      });
      return;
    }

    if (message.type === "chat:recall") {
      const messageId = String(message.messageId || "");
      const messageRecord = room.messages.get(messageId);

      if (!messageRecord) {
        send(socket, { type: "error", message: "消息不存在或已失效" });
        return;
      }

      if (messageRecord.senderUserId !== sender.userId) {
        send(socket, { type: "error", message: "只能撤回自己发送的消息" });
        return;
      }

      if (messageRecord.recalled) {
        send(socket, { type: "error", message: "这条消息已经撤回过了" });
        return;
      }

      messageRecord.recalled = true;
      messageRecord.recalledAt = Date.now();

      broadcastToRoom(currentRoomId, {
        type: "chat:recalled",
        messageId: messageRecord.messageId,
        userId: sender.userId,
        nickname: sender.nickname,
        timestamp: messageRecord.recalledAt,
      });
      return;
    }

    send(socket, { type: "error", message: "不支持的消息类型" });
  });

  socket.on("close", () => {
    if (!currentRoomId || !currentUserId) {
      return;
    }

    const room = rooms.get(currentRoomId);
    const user = room ? room.clients.get(currentUserId) : null;
    const nickname = user ? user.nickname : "有用户";

    removeUserFromRoom(currentRoomId, currentUserId);

    if (rooms.has(currentRoomId)) {
      broadcastToRoom(currentRoomId, {
        type: "presence",
        users: buildUserList(rooms.get(currentRoomId)),
        notice: `${nickname} 离开了房间`,
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Anonymous chatroom running on http://localhost:${PORT}`);
});
