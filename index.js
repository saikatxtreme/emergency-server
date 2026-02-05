const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

// HEALTH CHECK
app.get("/", (req, res) => res.send("✅ EMERGO SERVER ONLINE"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// STRUCTURE: 
// { 
//   "family-id": { 
//      password: "123", 
//      blocked: false, 
//      pushToken: "...",
//      pending: [] // <--- NEW: Stores missed messages
//   } 
// }
const users = {}; 

const ADMIN_ID = "admin";
const ADMIN_PASSWORD = "super-secret-password"; 

// --- HELPER: SEND PUSH ---
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
        console.log("Push Sent:", title);
    } catch (e) { console.error("Push Failed", e.message); }
}

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // 1. AUTH & RETRIEVE PENDING MESSAGES
  socket.on("auth-user", ({ familyId, password, pushToken }, callback) => {
      if (familyId === ADMIN_ID) {
          if (password === ADMIN_PASSWORD) {
              socket.join("admin-room");
              callback({ success: true, isAdmin: true });
          } else callback({ success: false, message: "Invalid Admin Pass" });
          return;
      }
      
      const user = users[familyId];
      if (user) {
          if (user.password === password) {
              if (user.blocked) return callback({ success: false, message: "Blocked" });
              
              user.pushToken = pushToken;
              socket.join(familyId); // Join the "Live" room
              
              callback({ success: true, isAdmin: false });

              // --- DELIVER PENDING MESSAGES ---
              if (user.pending && user.pending.length > 0) {
                  console.log(`Delivering ${user.pending.length} missed messages to ${familyId}`);
                  user.pending.forEach(msg => {
                      if(msg.type === 'chat') socket.emit("receive-chat", msg.content);
                      if(msg.type === 'audio') socket.emit("receive-audio", msg.content.audioBase64);
                  });
                  user.pending = []; // Clear queue after delivery
              }

          } else callback({ success: false, message: "Wrong Password" });
      } else {
          // NEW REGISTRATION
          users[familyId] = { password, blocked: false, pushToken, pending: [] };
          socket.join(familyId);
          console.log(`Registered: ${familyId}`);
          callback({ success: true, isAdmin: false });
          io.to("admin-room").emit("admin-update", users);
      }
  });

  // 2. TRIGGER ALARM / RINGING
  socket.on("trigger-alert", async (qrId) => {
      const user = users[qrId];
      console.log(`⚡ ALARM TRIGGERED FOR: ${qrId}`);
      
      // Try to ring app directly (if online)
      io.to(qrId).emit("incoming-alarm"); 

      // Send Push (Background)
      if (user) sendPush(user.pushToken, "🚨 URGENT: VEHICLE ALERT", "Someone is at your vehicle! Tap to ANSWER.", { type: 'alarm' });
  });

  // 3. HANDLE CHAT (Store if offline)
  socket.on("send-chat", (data) => {
      const room = io.sockets.adapter.rooms.get(data.qrId);
      const isOnline = room && room.size > 0;

      if (isOnline) {
          // User is online -> Send Direct
          socket.to(data.qrId).emit("receive-chat", data);
      } else {
          // User is offline -> Store & Notify
          const user = users[data.qrId];
          if (user) {
              user.pending.push({ type: 'chat', content: data });
              console.log(`Stored chat for offline user: ${data.qrId}`);
              sendPush(user.pushToken, "💬 New Message", `Helper: ${data.text}`);
          }
      }
  });

  // 4. HANDLE AUDIO (Store if offline)
  socket.on("send-audio", (data) => {
      const room = io.sockets.adapter.rooms.get(data.qrId);
      const isOnline = room && room.size > 0;

      if (isOnline) {
          socket.to(data.qrId).emit("receive-audio", data.audioBase64);
      } else {
          const user = users[data.qrId];
          if (user) {
              // Note: Audio base64 is large, watch memory usage on free tier
              user.pending.push({ type: 'audio', content: data });
              console.log(`Stored audio for offline user: ${data.qrId}`);
              sendPush(user.pushToken, "🎤 New Voice Note", "Helper sent a voice note.");
          }
      }
  });

  // 5. STANDARD STUFF
  socket.on("join-family", (id) => socket.join(id));
  
  socket.on("delete-self", ({ familyId, password }, cb) => { 
      if (users[familyId]?.password === password) { 
          delete users[familyId]; 
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
  
  socket.on("scan-qr", (d) => socket.to(d.qrId).emit("critical-alert", d));
});

server.listen(3001, () => console.log("SERVER RUNNING"));