const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

// 1. HEALTH CHECK (Keeps server awake)
app.get("/", (req, res) => res.send("✅ EMERGO SERVER IS LIVE"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// DB & STATE
const users = {}; 
const activeAlarms = {}; // Stores the "Pulse" timers
const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; 

// HELPER: SEND PUSH
async function sendPush(token, title, body, data = {}) {
    if(!token) return;
    try {
        await axios.post('https://exp.host/--/api/v2/push/send', {
            to: token,
            sound: 'default',
            title: title,
            body: body,
            priority: 'high',
            channelId: 'emergency-alert',
            data: data
        });
        console.log("-> Push Sent");
    } catch (e) { console.error("Push Error"); }
}

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 2. AUTH & STOP ALARM
  socket.on("auth-user", ({ familyId, password, pushToken }, callback) => {
      if (familyId === ADMIN_ID) {
          if (password === ADMIN_PASSWORD) {
              socket.join("admin-room");
              callback({ success: true, isAdmin: true });
          } else callback({ success: false, message: "Invalid Admin" });
          return;
      }
      
      const user = users[familyId];
      if (user) {
          if (user.password === password) {
              if (user.blocked) return callback({ success: false, message: "Blocked" });
              
              user.pushToken = pushToken;
              socket.join(familyId);
              
              // *** CRITICAL: STOP THE PULSE IF USER LOGS IN ***
              if (activeAlarms[familyId]) {
                  console.log(`🛑 User Answered. Stopping Alarm for ${familyId}`);
                  clearInterval(activeAlarms[familyId]);
                  delete activeAlarms[familyId];
              }

              callback({ success: true, isAdmin: false });

              // DELIVER MISSED MESSAGES
              if (user.pending && user.pending.length > 0) {
                  user.pending.forEach(msg => {
                      if(msg.type === 'chat') socket.emit("receive-chat", msg.content);
                      if(msg.type === 'audio') socket.emit("receive-audio", msg.content.audioBase64);
                  });
                  user.pending = []; 
              }
          } else callback({ success: false, message: "Wrong Password" });
      } else {
          // NEW USER
          users[familyId] = { password, blocked: false, pushToken, pending: [] };
          socket.join(familyId);
          console.log(`Registered: ${familyId}`);
          callback({ success: true, isAdmin: false });
          io.to("admin-room").emit("admin-update", users);
      }
  });

  // 3. TRIGGER PULSE ALARM
  socket.on("trigger-alert", async (qrId) => {
      const user = users[qrId];
      console.log(`⚡ ALARM FOR: ${qrId}`);
      
      // Stop existing if running
      if (activeAlarms[qrId]) clearInterval(activeAlarms[qrId]);

      // Ring App Directly (if online)
      io.to(qrId).emit("incoming-alarm");

      if (user && user.pushToken) {
          let count = 0;
          // *** START PULSE LOOP ***
          const intervalId = setInterval(async () => {
              count++;
              console.log(`🔔 Pulse #${count} -> ${qrId}`);
              
              await sendPush(
                  user.pushToken, 
                  "🚨 INCOMING CALL", 
                  "Emergency! Tap to Answer.", 
                  { type: 'alarm' }
              );

              // Stop after 30 seconds (15 pulses)
              if (count >= 15) {
                  clearInterval(intervalId);
                  delete activeAlarms[qrId];
              }
          }, 2000); // Every 2 seconds

          activeAlarms[qrId] = intervalId;
      }
  });

  // 4. CHAT / AUDIO (Store & Forward)
  socket.on("send-chat", (data) => {
      const room = io.sockets.adapter.rooms.get(data.qrId);
      if (room && room.size > 0) socket.to(data.qrId).emit("receive-chat", data);
      else {
          users[data.qrId]?.pending.push({ type: 'chat', content: data });
          sendPush(users[data.qrId]?.pushToken, "💬 New Message", data.text);
      }
  });

  socket.on("send-audio", (data) => {
       const room = io.sockets.adapter.rooms.get(data.qrId);
       if (room && room.size > 0) socket.to(data.qrId).emit("receive-audio", data.audioBase64);
       else {
           users[data.qrId]?.pending.push({ type: 'audio', content: data });
           sendPush(users[data.qrId]?.pushToken, "🎤 New Voice Note", "Audio received");
       }
  });

  socket.on("join-family", (id) => socket.join(id));
  socket.on("scan-qr", (d) => socket.to(d.qrId).emit("critical-alert", d));
  
  // ADMIN & CLEANUP
  socket.on("delete-self", ({ familyId, password }, cb) => { 
      if (users[familyId]?.password === password) { 
          delete users[familyId]; 
          if(activeAlarms[familyId]) clearInterval(activeAlarms[familyId]);
          io.in(familyId).disconnectSockets(); 
          cb({success:true}); 
          io.to("admin-room").emit("admin-update", users);
      } else cb({success:false}); 
  });
  socket.on("admin-get-list", () => socket.emit("admin-update", users));
  socket.on("admin-action", ({ targetId, action, adminPass }, cb) => { 
      if (adminPass!==ADMIN_PASSWORD) return cb({success:false});
      if (action==='delete') delete users[targetId];
      else if (action==='block') users[targetId].blocked = !users[targetId].blocked;
      io.to("admin-room").emit("admin-update", users); 
      cb({success:true}); 
  });
});

server.listen(3001, () => console.log("SERVER RUNNING"));