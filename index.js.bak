const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios"); // <--- NEW: For sending Push

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// STRUCTURE: { "family-id": { password: "123", blocked: false, pushToken: "ExponentPushToken[...]" } }
const users = {}; 

const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password";

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 1. LOGIN / REGISTER (Now saves Push Token)
  socket.on("auth-user", ({ familyId, password, pushToken }, callback) => {
      // ADMIN
      if (familyId === ADMIN_ID) {
          if (password === ADMIN_PASSWORD) {
              socket.join("admin-room");
              callback({ success: true, isAdmin: true });
          } else { callback({ success: false, message: "Wrong Admin Password" }); }
          return;
      }

      const user = users[familyId];

      if (user) {
          // EXISTING USER
          if (user.password === password) {
              if (user.blocked) {
                  callback({ success: false, message: "BLOCKED." });
              } else {
                  // UPDATE TOKEN (In case they logged in from a new phone)
                  user.pushToken = pushToken;
                  socket.join(familyId);
                  callback({ success: true, isAdmin: false });
              }
          } else { callback({ success: false, message: "Wrong Password." }); }
      } else {
          // NEW USER
          users[familyId] = { password, blocked: false, pushToken };
          socket.join(familyId);
          console.log(`Registered: ${familyId}`);
          callback({ success: true, isAdmin: false });
          io.to("admin-room").emit("admin-update", users);
      }
  });

  // 2. TRIGGER ALERT (Called by Web Client)
  socket.on("trigger-alert", async (qrId) => {
      const user = users[qrId];
      if (user && user.pushToken) {
          console.log(`Sending Push to ${qrId}...`);
          
          // Send to Expo API
          try {
              await axios.post('https://exp.host/--/api/v2/push/send', {
                  to: user.pushToken,
                  sound: 'default',
                  title: "🚨 EMERGENCY ALERT",
                  body: "Someone is at your vehicle! Tap to open.",
                  data: { someData: 'goes here' },
                  priority: 'high',
                  channelId: 'emergency-alert', // For Android High Priority
              });
          } catch (error) {
              console.error("Push Error", error);
          }
      }
  });

  // Standard Listeners
  socket.on("delete-self", ({ familyId, password }, callback) => {
      const user = users[familyId];
      if (user && user.password === password) {
          delete users[familyId];
          io.in(familyId).disconnectSockets();
          callback({ success: true });
          io.to("admin-room").emit("admin-update", users);
      } else callback({ success: false });
  });

  socket.on("admin-get-list", () => socket.emit("admin-update", users));
  socket.on("admin-action", ({ targetId, action, adminPass }, callback) => {
      if (adminPass !== ADMIN_PASSWORD) return callback({ success: false });
      if (!users[targetId]) return callback({ success: false });
      if (action === "delete") delete users[targetId];
      else if (action === "block") users[targetId].blocked = !users[targetId].blocked;
      io.to("admin-room").emit("admin-update", users);
      callback({ success: true });
  });

  socket.on("scan-qr", (data) => socket.to(data.qrId).emit("critical-alert", data));
  socket.on("send-chat", (data) => socket.to(data.qrId).emit("receive-chat", data));
  socket.on("send-audio", (data) => socket.to(data.qrId).emit("receive-audio", data.audioBase64));
  socket.on("join-family", (id) => socket.join(id));
});

server.listen(3001, () => console.log("SERVER RUNNING"));