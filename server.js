const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ROOM_ACCESS_PASSWORD = process.env.ROOM_ACCESS_PASSWORD || "dx333";
const MAX_ROOM_USERS = 10;
const MAX_TEXT_LENGTH = 1000;
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_ROOM_MESSAGES = 100;
const ROOM_ID_LENGTH = 8;
const USER_ID_LENGTH = 10;
const MESSAGE_ID_LENGTH = 12;
const GUEST_NAME_LENGTH = 4;
const HEARTBEAT_INTERVAL_MS = 30_000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((_req, res) => {
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
      creatorUserId: "",
    });
  }

  return rooms.get(roomId);
}

function removeUserFromRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (room.creatorUserId === userId) {
    rooms.delete(roomId);
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

function trimRoomMessages(room) {
  while (room.messages.size > MAX_ROOM_MESSAGES) {
    const oldestMessageId = room.messages.keys().next().value;
    if (!oldestMessageId) {
      break;
    }
    room.messages.delete(oldestMessageId);
  }
}

function storeMessage(room, messageRecord) {
  room.messages.set(messageRecord.messageId, messageRecord);
  trimRoomMessages(room);
}

function buildMessageHistory(roomId, room) {
  return Array.from(room.messages.values()).map((messageRecord) => ({
    type: messageRecord.type,
    messageId: messageRecord.messageId,
    roomId,
    userId: messageRecord.senderUserId,
    nickname: messageRecord.senderNickname,
    content: messageRecord.content,
    fileName: messageRecord.fileName,
    imageDataUrl: messageRecord.imageDataUrl,
    timestamp: messageRecord.timestamp,
    recalled: Boolean(messageRecord.recalled),
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

function normalizeNickname(rawNickname, fallbackNickname = "") {
  const trimmed = String(rawNickname || "").trim().slice(0, 20);
  return trimmed || fallbackNickname || `游客${randomId(GUEST_NAME_LENGTH)}`;
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

function releaseMessagePayload(messageRecord) {
  messageRecord.content = "";
  messageRecord.fileName = "";
  messageRecord.imageDataUrl = "";
}

function cleanupSocketMembership(socket) {
  const roomId = socket.roomId;
  const userId = socket.userId;

  if (!roomId || !userId) {
    return;
  }

  const room = rooms.get(roomId);
  const user = room ? room.clients.get(userId) : null;
  const nickname = user ? user.nickname : "有用户";

  removeUserFromRoom(roomId, userId);

  socket.roomId = null;
  socket.userId = null;

  if (rooms.has(roomId)) {
    broadcastToRoom(roomId, {
      type: "presence",
      users: buildUserList(rooms.get(roomId)),
      notice: `${nickname} 离开了房间`,
    });
  }
}

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeatTimer);
});

wss.on("connection", (socket) => {
  let currentRoomId = null;
  let currentUserId = null;

  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

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
      const providedPassword = String(message.password || "").trim();
      const requestedRoomId = String(message.roomId || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, ROOM_ID_LENGTH);
      const roomId = requestedRoomId || randomId(ROOM_ID_LENGTH);
      const roomExists = rooms.has(roomId);
      const targetRoom = roomExists ? rooms.get(roomId) : null;
      const isRejoiningCurrentRoom =
        Boolean(currentRoomId) &&
        currentRoomId === roomId &&
        Boolean(currentUserId) &&
        Boolean(targetRoom) &&
        targetRoom.clients.has(currentUserId);

      if (!roomExists && providedPassword !== ROOM_ACCESS_PASSWORD) {
        send(socket, { type: "error", message: "密码错误，无法创建房间" });
        return;
      }

      const activeClientCount = targetRoom
        ? targetRoom.clients.size - (isRejoiningCurrentRoom ? 1 : 0)
        : 0;
      if (activeClientCount >= MAX_ROOM_USERS) {
        send(socket, { type: "error", message: "房间已满，最多 10 人" });
        return;
      }

      if (currentRoomId && currentUserId) {
        const previousRoomId = currentRoomId;
        removeUserFromRoom(currentRoomId, currentUserId);
        socket.roomId = null;
        socket.userId = null;
        if (rooms.has(previousRoomId)) {
          broadcastToRoom(previousRoomId, {
            type: "presence",
            users: buildUserList(rooms.get(previousRoomId)),
            notice: "有用户切换到了其他房间",
          });
        }
      }

      const room = createRoomIfMissing(roomId);

      const userId = randomId(USER_ID_LENGTH);
      const defaultNickname = roomExists ? "" : "扫码客服";
      const nickname = normalizeNickname(message.nickname, defaultNickname);

      if (!roomExists) {
        room.creatorUserId = userId;
      }

      currentRoomId = roomId;
      currentUserId = userId;
      room.clients.set(userId, { userId, nickname, socket });
      socket.roomId = roomId;
      socket.userId = userId;

      send(socket, {
        type: "joined",
        roomId,
        userId,
        nickname,
        users: buildUserList(room),
        messages: buildMessageHistory(roomId, room),
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
      storeMessage(room, messageRecord);

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
      storeMessage(room, messageRecord);

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
      releaseMessagePayload(messageRecord);

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
    cleanupSocketMembership(socket);
    currentRoomId = null;
    currentUserId = null;
  });
});

server.listen(PORT, () => {
  console.log(`Anonymous chatroom running on http://localhost:${PORT}`);
});
