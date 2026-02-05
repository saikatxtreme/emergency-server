const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// FIX: Set max buffer to 100MB so audio files don't fail
const io = new Server(server, {
  maxHttpBufferSize: 1e8, 
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('User Connected:', socket.id);

  // 1. FAMILY JOINS
  socket.on('join-family', (qrId) => {
    socket.join(qrId);
    console.log(`Family joined room: ${qrId}`);
  });

  // 2. STRANGER SCANS (Updates Location)
  socket.on('scan-qr', (data) => {
    const { qrId, location } = data;
    console.log(`Location update for ${qrId}`);
    io.to(qrId).emit('critical-alert', { location });
  });

  // 3. AUDIO RELAY (Walkie Talkie)
  socket.on('send-audio', (data) => {
    const { qrId, audioBase64 } = data;
    // Broadcast to everyone in room (excluding sender)
    socket.to(qrId).emit('receive-audio', audioBase64);
  });

  // 4. CHAT RELAY
  socket.on('send-chat', (data) => {
    // Send to everyone in room including sender (so they see their own msg)
    io.to(data.qrId).emit('receive-chat', data);
  });
});

server.listen(3001, '0.0.0.0', () => {
  console.log('✅ SERVER RUNNING on port 3001');
});