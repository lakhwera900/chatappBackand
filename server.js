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

const chats = {}; // { chatId: { id, clientId, messages: [...], lastActivity, createdAt } }

const now = () => Date.now();

// Get existing chat or create a new one
function getOrCreateChat(clientId) {
  let chat = Object.values(chats).find(c => c.clientId === clientId);
  if (!chat) {
    const id = uuidv4();
    chat = { id, clientId, messages: [], createdAt: now(), lastActivity: now() };
    chats[id] = chat;
  }
  return chat;
}

// Push a message to chat
function pushMessage(chatId, from, text) {
  const chat = chats[chatId];
  if (!chat) return null;

  const msg = { id: uuidv4(), from, text, time: now(), seen: false };
  chat.messages.push(msg);
  chat.lastActivity = now();
  return msg;
}

// Summarize chat for admin listing
function summarizeChat(chat) {
  return {
    id: chat.id,
    clientId: chat.clientId,
    lastActivity: chat.lastActivity,
    createdAt: chat.createdAt,
    lastMessage: chat.messages.at(-1) || null,
    unread: chat.messages.some(m => m.from === "client" && !m.seen)
  };
}

// Cleanup old chats
setInterval(() => {
  const ttl = CHAT_TTL_MINUTES * 60 * 1000;
  for (const [id, chat] of Object.entries(chats)) {
    if (now() - chat.lastActivity > ttl) {
      delete chats[id];
      io.to("admins").emit("chat_deleted", { chatId: id });
      io.to(`client_${id}`).emit("chat_deleted", { chatId: id });
    }
  }
}, 60 * 1000);

// ROUTES
app.get("/chats", (req, res) => {
  const list = Object.values(chats).map(summarizeChat);
  res.json(list);
});

app.get("/chat/:id", (req, res) => {
  const chat = chats[req.params.id];
  if (!chat) return res.status(404).json({ error: "no chat" });
  res.json(chat);
});

// SOCKET.IO
io.on("connection", socket => {

  socket.on("identify_client", ({ clientId }) => {
    const id = clientId || uuidv4();
    const chat = getOrCreateChat(id);
    socket.join(`client_${chat.id}`);
    socket.data = { chatId: chat.id, role: "client" };
    socket.emit("chat_history", chat);
    io.to("admins").emit("chat_list_update", summarizeChat(chat));
    socket.emit("client_id_assigned", { clientId: id, chatId: chat.id });
  });

  socket.on("identify_admin", () => {
    socket.join("admins");
    socket.data = { role: "admin" };
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

  const markMessagesSeen = chatId => {
    const chat = chats[chatId];
    if (!chat) return;
    chat.messages.forEach(m => { if (m.from === "client") m.seen = true; });
    chat.lastActivity = now();
    io.to("admins").emit("chat_update", chat);
    io.to(`client_${chat.id}`).emit("messages_seen", { chatId });
  };

  socket.on("mark_seen", ({ chatId }) => markMessagesSeen(chatId));
  socket.on("open_chat", ({ chatId }) => markMessagesSeen(chatId));

  socket.on("delete_chat", ({ chatId }) => {
    const chat = chats[chatId];
    if (!chat) return;
    delete chats[chatId];
    io.to("admins").emit("chat_deleted", { chatId });
    io.to(`client_${chatId}`).emit("chat_deleted", { chatId });
  });

  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on port", PORT));
