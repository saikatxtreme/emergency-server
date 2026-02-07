const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("✅ EMERGO SERVER ONLINE"));

const server = http.createServer(app);
// CORS: Allow Mobile and Web to connect
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// --- DATA STORAGE (WARNING: RESETS ON RESTART) ---
// To fix data loss, you eventually need MongoDB. 
// For now, this keeps it simple.
const users = {}; 

// --- ADMIN CREDENTIALS ---
const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; 

// --- PUSH NOTIFICATION HELPER ---
async function sendPush(token, title, body, data = {}) {
    if(!token) return;
    try {
        await axios.post('https://exp.host/--/api/v2/push/send', {
            to: token, sound: 'default', title, body, priority: 'high', channelId: 'emergency-alert', data
        });
    } catch (e) { console.error("Push Error", e.message); }
}

io.on("connection", (socket) => {
  console.log("User Connected:", socket.id);

  // 1. LOGIN / REGISTER (Matches Mobile App 'auth-user')
  socket.on("auth-user", ({ familyId, password, pushToken }, callback) => {
      // A. ADMIN CHECK
      if(familyId === ADMIN_ID && password === ADMIN_PASSWORD) {
          socket.join("admin-room");
          return callback({ success: true, isAdmin: true });
      }

      // B. REGISTER (If not exists)
      if (!users[familyId]) {
          console.log("New User Registered:", familyId);
          users[familyId] = { password, pushToken, blocked: false };
      }
      
      // C. LOGIN CHECK
      const user = users[familyId];
      if (user.password === password) {
          if (user.blocked) return callback({ success: false, message: "Account Blocked by Admin" });
          
          user.pushToken = pushToken; // Update token
          socket.join(familyId); // Join their Family Room
          
          callback({ success: true, isAdmin: false });
          
          // Notify Admin
          io.to("admin-room").emit("admin-update", users);
      } else {
          callback({ success: false, message: "Invalid Password" });
      }
  });

  // 2. JOIN ROOM (For Web Client & Stranger)
  socket.on("join-room", (qrId) => {
      console.log(`Socket ${socket.id} joined room ${qrId}`);
      socket.join(qrId);
  });

  // 3. CHAT (Broadcast to Room)
  socket.on("send-chat", (data) => {
      // data = { qrId, text, sender }
      // Broadcast to everyone in room EXCEPT sender
      socket.to(data.qrId).emit("receive-chat", data);
      
      // If Family is offline, Push Notification logic could go here
      const user = users[data.qrId];
      if (user && user.pushToken && data.sender !== "Family") {
           sendPush(user.pushToken, "New Message", `${data.sender}: ${data.text}`);
      }
  });

  // 4. AUDIO (Walkie-Talkie)
  socket.on("send-audio", (data) => {
      // Broadcast audio to the room (qrId)
      socket.to(data.qrId).emit("receive-audio", data.audioBase64);
  });

  // 5. ALERTS (SOS & Location)
  socket.on("incoming-alarm", (data) => {
      io.to(data.qrId).emit("incoming-alarm"); // Ring the phone
      
      // Send Push Notification
      const user = users[data.qrId];
      if (user && user.pushToken) {
          sendPush(user.pushToken, "🚨 SOS ALERT", "Someone scanned your QR code!", { type: 'alarm' });
      }
  });

  socket.on("critical-alert", (data) => {
      // data = { qrId, location: {...} }
      io.to(data.qrId).emit("critical-alert", data); // Update Map on Phone
  });

  // 6. ADMIN ACTIONS
  socket.on("admin-get-list", () => {
      socket.emit("admin-update", users);
  });

  socket.on("admin-action", ({ targetId, action, adminPass }, callback) => {
      if (adminPass !== ADMIN_PASSWORD) return callback({ success: false, message: "Unauthorized" });
      
      if (!users[targetId]) return callback({ success: false, message: "User not found" });

      if (action === "block") {
          users[targetId].blocked = !users[targetId].blocked; // Toggle
      } else if (action === "delete") {
          delete users[targetId];
      }
      
      // Refresh Admin View
      io.to("admin-room").emit("admin-update", users);
      callback({ success: true });
  });

  socket.on("delete-self", ({ familyId, password }, callback) => {
      if (users[familyId] && users[familyId].password === password) {
          delete users[familyId];
          callback({ success: true });
          io.to("admin-room").emit("admin-update", users);
      } else {
          callback({ success: false, message: "Invalid Creds" });
      }
  });

  socket.on("disconnect", () => {
      console.log("User Disconnected:", socket.id);
  });
});

server.listen(3001, () => console.log("✅ SERVER RUNNING ON PORT 3001"));