const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// --- DATABASE (In-Memory) ---
// Structure: { "family-id": { password: "abc", blocked: false } }
const users = {}; 

// --- SUPER USER CONFIG ---
const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; // <--- CHANGE THIS IF YOU WANT

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 1. LOGIN / REGISTER
  socket.on("auth-user", ({ familyId, password }, callback) => {
      // A. ADMIN LOGIN
      if (familyId === ADMIN_ID) {
          if (password === ADMIN_PASSWORD) {
              socket.join("admin-room");
              callback({ success: true, isAdmin: true });
          } else {
              callback({ success: false, message: "Wrong Admin Password" });
          }
          return;
      }

      // B. REGULAR USER
      const user = users[familyId];

      if (user) {
          // USER EXISTS: Check Password
          if (user.password === password) {
              if (user.blocked) {
                  callback({ success: false, message: "This ID has been BLOCKED by Admin." });
              } else {
                  socket.join(familyId);
                  callback({ success: true, isAdmin: false });
              }
          } else {
              callback({ success: false, message: "Wrong Password for this Family ID." });
          }
      } else {
          // USER NEW: Register
          users[familyId] = { password, blocked: false };
          socket.join(familyId);
          console.log(`New User Registered: ${familyId}`);
          callback({ success: true, isAdmin: false });
          
          // Notify Admin
          io.to("admin-room").emit("admin-update", users);
      }
  });

  // 2. USER SELF-DELETE
  socket.on("delete-self", ({ familyId, password }, callback) => {
      const user = users[familyId];
      if (user && user.password === password) {
          delete users[familyId];
          io.in(familyId).disconnectSockets(); // Kick everyone out
          callback({ success: true });
          io.to("admin-room").emit("admin-update", users);
      } else {
          callback({ success: false, message: "Invalid credentials." });
      }
  });

  // --- ADMIN COMMANDS ---
  socket.on("admin-get-list", () => {
      socket.emit("admin-update", users);
  });

  socket.on("admin-action", ({ targetId, action, adminPass }, callback) => {
      if (adminPass !== ADMIN_PASSWORD) return callback({ success: false, message: "Unauthorized" });

      if (!users[targetId]) return callback({ success: false, message: "User not found" });

      if (action === "delete") {
          delete users[targetId];
          io.in(targetId).disconnectSockets();
          callback({ success: true });
      } else if (action === "block") {
          users[targetId].blocked = !users[targetId].blocked; 
          if (users[targetId].blocked) io.in(targetId).disconnectSockets();
          callback({ success: true });
      }
      io.to("admin-room").emit("admin-update", users);
  });

  // --- CORE FEATURES (Text, Audio, QR) ---
  socket.on("scan-qr", (data) => socket.to(data.qrId).emit("critical-alert", data));
  socket.on("send-chat", (data) => socket.to(data.qrId).emit("receive-chat", data));
  socket.on("send-audio", (data) => socket.to(data.qrId).emit("receive-audio", data.audioBase64));
  
  // Re-join logic for page refreshes
  socket.on("join-family", (familyId) => {
     socket.join(familyId);
  });
});

server.listen(3001, () => console.log("SERVER RUNNING"));