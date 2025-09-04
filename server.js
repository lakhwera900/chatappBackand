// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// CONFIG
const CHAT_TTL_MINUTES = 10;       
const ADMIN_VISIBLE_RETENTION_MINUTES = 1440; 

const chats = {}; // in-memory: { chatId: { id, clientId, messages: [...], lastActivity, createdAt } }

function now() { return Date.now(); }

function getOrCreateChat(clientId) {
  let chat = Object.values(chats).find(c => c.clientId === clientId);
  if (!chat) {
    const id = uuidv4();
    chat = { id, clientId, messages: [], createdAt: now(), lastActivity: now() };
    chats[id] = chat;
  }
  return chat;
}

function pushMessage(chatId, from, text) {
  const msg = { id: uuidv4(), from, text, time: now(), seen: false };
  const chat = chats[chatId];
  if (!chat) return null;
  chat.messages.push(msg);
  chat.lastActivity = now();
  return msg;
}

// cleanup loop
setInterval(() => {
  const ttl = CHAT_TTL_MINUTES * 60 * 1000;
  const toDelete = [];
  Object.values(chats).forEach(chat => {
    if (now() - chat.lastActivity > ttl) toDelete.push(chat.id);
  });
  toDelete.forEach(id => {
    delete chats[id];
    io.to("admins").emit("chat_deleted", { chatId: id });
    io.to(`client_${id}`).emit("chat_deleted", { chatId: id });
  });
}, 60 * 1000);

app.get("/chats", (req, res) => {
  const list = Object.values(chats).map(c => ({
    id: c.id,
    clientId: c.clientId,
    lastActivity: c.lastActivity,
    createdAt: c.createdAt,
    unread: c.messages.some(m => !m.seen && m.from === "client")
  }));
  res.json(list);
});

app.get("/chat/:id", (req, res) => {
  const c = chats[req.params.id];
  if (!c) return res.status(404).json({ error: "no chat" });
  res.json(c);
});

io.on("connection", socket => {

  socket.on("identify_client", ({ clientId }) => {
    const id = clientId || uuidv4();
    const chat = getOrCreateChat(id);
    socket.join(`client_${chat.id}`);
    socket.data.chatId = chat.id;
    socket.data.role = "client";
    socket.emit("chat_history", chat);
    io.to("admins").emit("chat_list_update", summarizeChat(chat));
    socket.emit("client_id_assigned", { clientId: id, chatId: chat.id });
  });

  socket.on("identify_admin", () => {
    socket.join("admins");
    socket.data.role = "admin";
    io.to(socket.id).emit("chat_list", Object.values(chats).map(summarizeChat));
  });

  socket.on("client_message", ({ clientId, text }) => {
    const chat = getOrCreateChat(clientId);
    const msg = pushMessage(chat.id, "client", text);
    io.to("admins").emit("new_message", { chatId: chat.id, message: msg });
    socket.emit("message_sent", msg);
    io.to(`client_${chat.id}`).emit("chat_update", chat);
  });

  socket.on("admin_message", ({ chatId, text }) => {
    const chat = chats[chatId];
    if (!chat) return;
    const msg = pushMessage(chatId, "admin", text);
    io.to("admins").emit("chat_update", chat);
    io.to(`client_${chat.id}`).emit("new_message_from_admin", { chatId: chat.id, message: msg });
  });

  socket.on("mark_seen", ({ chatId }) => {
    const chat = chats[chatId];
    if (!chat) return;
    chat.messages.forEach(m => { if (m.from === "client") m.seen = true; });
    chat.lastActivity = now();
    io.to("admins").emit("chat_update", chat);
    io.to(`client_${chat.id}`).emit("messages_seen", { chatId: chat.id });
  });

  socket.on("open_chat", ({ chatId }) => {
    const chat = chats[chatId];
    if (!chat) return;
    chat.messages.forEach(m => { if (m.from === "client") m.seen = true; });
    io.to("admins").emit("chat_update", chat);
    io.to(`client_${chat.id}`).emit("messages_seen", { chatId: chat.id });
  });

  // ✅ DELETE chat
  socket.on("delete_chat", ({ chatId }) => {
    const chat = chats[chatId];
    if (!chat) return;
    delete chats[chatId];
    // notify both admin & client
    io.to("admins").emit("chat_deleted", { chatId });
    io.to(`client_${chatId}`).emit("chat_deleted", { chatId });
  });

  socket.on("disconnect", () => {});
});

function summarizeChat(chat) {
  return {
    id: chat.id,
    clientId: chat.clientId,
    lastActivity: chat.lastActivity,
    createdAt: chat.createdAt,
    lastMessage: chat.messages.length ? chat.messages[chat.messages.length - 1] : null,
    unread: chat.messages.some(m => m.from === "client" && !m.seen)
  };
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on port", PORT));
