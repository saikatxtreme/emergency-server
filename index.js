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

// --- DATA ---
const users = {}; 
const qrRegistry = {}; 
const activeAlarms = {}; 

// --- ADMIN CREDENTIALS ---
const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; // <--- Use this to login as Admin

// --- HELPER ---
async function sendPush(token, title, body, data = {}) {
    if(!token) return;
    try {
        await axios.post('https://exp.host/--/api/v2/push/send', {
            to: token, sound: 'default', title, body, priority: 'high', channelId: 'emergency-alert', data
        });
    } catch (e) { console.error("Push Error"); }
}

io.on("connection", (socket) => {
  // 1. LOGIN (Matches App.js 'login-user')
  socket.on("login-user", ({ username, password, pushToken }, callback) => {
      // A. ADMIN CHECK
      if(username === ADMIN_ID && password === ADMIN_PASSWORD) {
          socket.join("admin-room");
          // Send immediate stats
          const stats = { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length };
          return callback({ success: true, isAdmin: true, data: stats });
      }

      // B. REGULAR USER CHECK
      if (!users[username]) {
          users[username] = { password, pushToken, myQrs: [] };
      }
      
      const user = users[username];
      if (user.password === password) {
          user.pushToken = pushToken;
          socket.join(username);
          
          const dashboard = user.myQrs.map(id => ({
              id: id,
              unread: qrRegistry[id]?.unread || 0
          }));
          
          callback({ success: true, data: dashboard, isAdmin: false });
          // Update Admin Live Stats
          io.to("admin-room").emit("admin-update", { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length });
      } else callback({ success: false, message: "Invalid Password" });
  });

  // 2. ADD VEHICLE
  socket.on("add-qr", ({ username, qrId }, callback) => {
      const user = users[username];
      if (!user) return callback({ success: false, message: "User not found" });

      if (!qrRegistry[qrId]) {
          qrRegistry[qrId] = { owners: [], unread: 0, history: [] };
      }

      if (!qrRegistry[qrId].owners.includes(username)) {
          qrRegistry[qrId].owners.push(username);
          user.myQrs.push(qrId);
      }

      const dashboard = user.myQrs.map(id => ({ id, unread: qrRegistry[id].unread }));
      callback({ success: true, data: dashboard });
      io.to("admin-room").emit("admin-update", { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length });
  });

  // 3. FOCUS CHAT
  socket.on("focus-qr", ({ username, qrId }) => {
      const qr = qrRegistry[qrId];
      if (qr && qr.owners.includes(username)) {
          socket.join(qrId);
          if (activeAlarms[qrId]) { clearInterval(activeAlarms[qrId]); delete activeAlarms[qrId]; }
          socket.emit("history-sync", qr.history);
          qr.unread = 0;
          qr.owners.forEach(owner => io.to(owner).emit("dashboard-update", { qrId, unread: 0 }));
      }
  });

  // 4. ALERTS
  socket.on("trigger-alert", async (qrId) => {
      const qr = qrRegistry[qrId];
      if (!qr) return;
      qr.unread++;
      qr.owners.forEach(o => io.to(o).emit("dashboard-update", { qrId, unread: qr.unread }));
      io.to(qrId).emit("incoming-alarm");

      if (activeAlarms[qrId]) return;
      let count = 0;
      activeAlarms[qrId] = setInterval(() => {
          count++;
          qr.owners.forEach(ownerName => {
              const u = users[ownerName];
              if(u?.pushToken) sendPush(u.pushToken, `🚨 ALERT: ${qrId}`, "Vehicle Scan Detected!", { type: 'alarm', qrId });
          });
          if (count >= 15) { clearInterval(activeAlarms[qrId]); delete activeAlarms[qrId]; }
      }, 3000);
  });

  // 5. CHAT
  socket.on("send-chat", (data) => {
      socket.to(data.qrId).emit("receive-chat", data);
      const qr = qrRegistry[data.qrId];
      if (qr) {
          qr.history.push(data);
          qr.unread++;
          qr.owners.forEach(ownerName => {
              if (ownerName !== data.senderName) {
                  io.to(ownerName).emit("dashboard-update", { qrId: data.qrId, unread: qr.unread });
                  const u = users[ownerName];
                  if(u?.pushToken) sendPush(u.pushToken, `💬 ${data.qrId}`, data.text, { type: 'chat', qrId: data.qrId });
              }
          });
      }
  });

  // 6. DELETE ACCOUNT (Cascade)
  socket.on("delete-self", ({ username, password }, callback) => {
      const user = users[username];
      if (user && user.password === password) {
          [...user.myQrs].forEach(qrId => {
              const qr = qrRegistry[qrId];
              if (qr) {
                  qr.owners = qr.owners.filter(o => o !== username);
                  if (qr.owners.length === 0) {
                      delete qrRegistry[qrId];
                      if(activeAlarms[qrId]) { clearInterval(activeAlarms[qrId]); delete activeAlarms[qrId]; }
                  }
              }
          });
          delete users[username];
          callback({ success: true });
          io.to("admin-room").emit("admin-update", { userCount: Object.keys(users).length, qrCount: Object.keys(qrRegistry).length });
      } else callback({ success: false });
  });

  socket.on("join-family", (id) => socket.join(id));
});

server.listen(3001, () => console.log("SERVER RUNNING"));