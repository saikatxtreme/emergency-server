const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("✅ EMERGO SERVER ONLINE"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- DATA STRUCTURES ---
// 1. Users: { "john": { password: "123", pushToken: "...", myQrs: ["car1"] } }
const users = {}; 

// 2. Vehicles: { "car1": { owners: ["john", "jane"], unread: 0, history: [] } }
const qrRegistry = {}; 

// 3. Active Ringing Timers
const activeAlarms = {}; 

const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; 

// --- HELPER: SEND PUSH ---
async function sendPush(token, title, body, data = {}) {
    if(!token) return;
    try {
        await axios.post('https://exp.host/--/api/v2/push/send', {
            to: token, sound: 'default', title, body, priority: 'high', channelId: 'emergency-alert', data
        });
    } catch (e) { console.error("Push Error"); }
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  // 1. AUTH & DASHBOARD SYNC
  socket.on("login-user", ({ username, password, pushToken }, callback) => {
      // Admin Check
      if(username === ADMIN_ID && password === ADMIN_PASSWORD) {
          socket.join("admin-room");
          return callback({ success: true, isAdmin: true });
      }

      // User Logic
      if (!users[username]) {
          // Register New
          users[username] = { password, pushToken, myQrs: [] };
      }
      
      const user = users[username];
      if (user.password === password) {
          user.pushToken = pushToken;
          socket.join(username); // Join personal room for dashboard updates
          
          // Build Dashboard Data
          const dashboard = user.myQrs.map(id => ({
              id: id,
              unread: qrRegistry[id]?.unread || 0
          }));
          
          callback({ success: true, data: dashboard, isAdmin: false });
          // Notify Admin
          io.to("admin-room").emit("admin-update", { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length });
      } else callback({ success: false, message: "Invalid Password" });
  });

  // 2. JOIN OR CREATE VEHICLE (SHARED ACCESS)
  socket.on("add-qr", ({ username, qrId }, callback) => {
      const user = users[username];
      if (!user) return callback({ success: false, message: "User not found" });

      // Initialize QR if new
      if (!qrRegistry[qrId]) {
          qrRegistry[qrId] = { owners: [], unread: 0, history: [] };
      }

      // Add user to owners list if not already there
      if (!qrRegistry[qrId].owners.includes(username)) {
          qrRegistry[qrId].owners.push(username);
          user.myQrs.push(qrId);
      }

      // Return updated dashboard
      const dashboard = user.myQrs.map(id => ({ id, unread: qrRegistry[id].unread }));
      callback({ success: true, data: dashboard });
      io.to("admin-room").emit("admin-update", { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length });
  });

  // 3. OPEN CHAT (Focus)
  socket.on("focus-qr", ({ username, qrId }) => {
      const qr = qrRegistry[qrId];
      if (qr && qr.owners.includes(username)) {
          socket.join(qrId); // Join the vehicle chat room
          
          // Stop Ringing if anyone answers
          if (activeAlarms[qrId]) { 
              clearInterval(activeAlarms[qrId]); 
              delete activeAlarms[qrId]; 
          }

          // Send History
          socket.emit("history-sync", qr.history);
          
          // Clear Unread for EVERYONE (Assuming message read)
          qr.unread = 0;
          qr.owners.forEach(owner => {
              io.to(owner).emit("dashboard-update", { qrId, unread: 0 });
          });
      }
  });

  // 4. INCOMING ALERT (Broadcast to Shared Owners)
  socket.on("trigger-alert", async (qrId) => {
      const qr = qrRegistry[qrId];
      if (!qr) return;

      qr.unread++;
      // Notify all dashboards
      qr.owners.forEach(o => io.to(o).emit("dashboard-update", { qrId, unread: qr.unread }));
      
      // Ring the active chat room
      io.to(qrId).emit("incoming-alarm");

      // Start Pulse Push to ALL owners
      if (activeAlarms[qrId]) return;
      let count = 0;
      activeAlarms[qrId] = setInterval(() => {
          count++;
          qr.owners.forEach(ownerName => {
              const u = users[ownerName];
              if(u?.pushToken) sendPush(u.pushToken, `🚨 ALERT: ${qrId}`, "Vehicle is being scanned!", { type: 'alarm', qrId });
          });
          if (count >= 15) { clearInterval(activeAlarms[qrId]); delete activeAlarms[qrId]; }
      }, 3000);
  });

  // 5. CHAT HANDLING (Persistence)
  socket.on("send-chat", (data) => {
      socket.to(data.qrId).emit("receive-chat", data);
      
      const qr = qrRegistry[data.qrId];
      if (qr) {
          // Save History
          qr.history.push(data);
          if(qr.history.length > 50) qr.history.shift(); // Keep last 50

          qr.unread++;
          
          // Notify Owners (Push + Bubble)
          qr.owners.forEach(ownerName => {
              if (ownerName !== data.senderName) { // Don't notify sender
                  io.to(ownerName).emit("dashboard-update", { qrId: data.qrId, unread: qr.unread });
                  const u = users[ownerName];
                  if(u?.pushToken) sendPush(u.pushToken, `💬 ${data.qrId}`, data.text, { type: 'chat', qrId: data.qrId });
              }
          });
      }
  });

  socket.on("send-audio", (data) => {
      socket.to(data.qrId).emit("receive-audio", data.audioBase64);
      const qr = qrRegistry[data.qrId];
      if (qr) {
          // Add marker to history
          const marker = { ...data, text: "🎤 [Audio Message]", audioBase64: null };
          qr.history.push(marker);
          qr.unread++;
          
          qr.owners.forEach(ownerName => {
              if(ownerName !== data.senderName) {
                  io.to(ownerName).emit("dashboard-update", { qrId: data.qrId, unread: qr.unread });
                  const u = users[ownerName];
                  if(u?.pushToken) sendPush(u.pushToken, `🎤 ${data.qrId}`, "Voice Note Received", { type: 'audio', qrId: data.qrId });
              }
          });
      }
  });

  // 6. CASCADE DELETE
  socket.on("delete-self", ({ username, password }, callback) => {
      const user = users[username];
      if (user && user.password === password) {
          // Iterate over user's QRs
          [...user.myQrs].forEach(qrId => {
              const qr = qrRegistry[qrId];
              if (qr) {
                  // Remove user from owners list
                  qr.owners = qr.owners.filter(o => o !== username);
                  
                  // If no owners left, WIPEOUT
                  if (qr.owners.length === 0) {
                      delete qrRegistry[qrId];
                      if(activeAlarms[qrId]) { clearInterval(activeAlarms[qrId]); delete activeAlarms[qrId]; }
                  }
              }
          });
          
          delete users[username];
          callback({ success: true });
          io.to("admin-room").emit("admin-update", { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length });
      } else callback({ success: false, message: "Invalid Password" });
  });

  socket.on("join-family", (id) => socket.join(id));
  socket.on("scan-qr", (d) => socket.to(d.qrId).emit("critical-alert", d));
});

server.listen(3001, () => console.log("SERVER RUNNING"));