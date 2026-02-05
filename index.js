const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

// --- 1. HEALTH CHECK ROUTE (Keeps server awake & verifiable) ---
app.get("/", (req, res) => {
  res.send("✅ EMERGO SERVER IS RUNNING. Status: Online.");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// STRUCTURE: { "family-id": { password: "123", blocked: false, pushToken: "ExponentPushToken[...]" } }
const users = {}; 

// --- ADMIN CREDENTIALS ---
const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; 

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 2. AUTHENTICATION HANDLER
  socket.on("auth-user", ({ familyId, password, pushToken }, callback) => {
      // A. ADMIN LOGIN
      if (familyId === ADMIN_ID) {
          if (password === ADMIN_PASSWORD) {
              socket.join("admin-room");
              callback({ success: true, isAdmin: true });
          } else {
              callback({ success: false, message: "Invalid Admin Password" });
          }
          return;
      }

      // B. REGULAR USER LOGIN
      const user = users[familyId];

      if (user) {
          // Check Password
          if (user.password === password) {
              if (user.blocked) {
                  return callback({ success: false, message: "Account Blocked by Admin." });
              }
              // Update Push Token (User might have a new phone)
              user.pushToken = pushToken; 
              socket.join(familyId);
              callback({ success: true, isAdmin: false });
          } else {
              callback({ success: false, message: "Incorrect Password." });
          }
      } else {
          // C. NEW USER REGISTRATION
          users[familyId] = { password, blocked: false, pushToken };
          socket.join(familyId);
          console.log(`New Family Registered: ${familyId}`);
          callback({ success: true, isAdmin: false });
          
          // Update Admin Dashboard in real-time
          io.to("admin-room").emit("admin-update", users);
      }
  });

  // 3. EMERGENCY ALERT (Web -> Mobile)
  socket.on("trigger-alert", async (qrId) => {
      const user = users[qrId];
      if (user && user.pushToken) {
          console.log(`🚨 ALERT SENT TO: ${qrId}`);
          try {
              await axios.post('https://exp.host/--/api/v2/push/send', {
                  to: user.pushToken,
                  sound: 'default',
                  title: "🚨 EMERGENCY ALERT",
                  body: "Someone is at your vehicle! Action Required.",
                  priority: 'high',
                  channelId: 'emergency-alert', 
              });
          } catch (error) {
              console.error("Push Notification Failed:", error);
          }
      }
  });

  // 4. ADMIN ACTIONS
  socket.on("admin-get-list", () => socket.emit("admin-update", users));
  
  socket.on("admin-action", ({ targetId, action, adminPass }, callback) => {
      if (adminPass !== ADMIN_PASSWORD) return callback({ success: false, message: "Unauthorized" });
      
      if (!users[targetId]) return callback({ success: false, message: "User not found" });

      if (action === "delete") {
          delete users[targetId];
          io.in(targetId).disconnectSockets(); // Force logout
      } else if (action === "block") {
          users[targetId].blocked = !users[targetId].blocked;
          if (users[targetId].blocked) io.in(targetId).disconnectSockets();
      }
      
      io.to("admin-room").emit("admin-update", users);
      callback({ success: true });
  });

  // 5. USER SELF-DELETE
  socket.on("delete-self", ({ familyId, password }, callback) => {
      if (users[familyId] && users[familyId].password === password) {
          delete users[familyId];
          io.in(familyId).disconnectSockets();
          io.to("admin-room").emit("admin-update", users);
          callback({ success: true });
      } else {
          callback({ success: false, message: "Invalid Credentials" });
      }
  });

  // 6. CORE FEATURES
  socket.on("scan-qr", (data) => socket.to(data.qrId).emit("critical-alert", data));
  socket.on("send-chat", (data) => socket.to(data.qrId).emit("receive-chat", data));
  socket.on("send-audio", (data) => socket.to(data.qrId).emit("receive-audio", data.audioBase64));
  
  // Re-join room on page refresh
  socket.on("join-family", (id) => socket.join(id));
});

server.listen(3001, () => console.log("SERVER RUNNING ON PORT 3001"));