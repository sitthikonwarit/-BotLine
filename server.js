require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// นำเข้าโมดูลที่เราแยกไว้
const botHandler = require('./bot/botHandler');
const apiRoutes = require('./routes/api');

// ==========================================
// 1. LINE Webhook (ต้องอยู่ก่อน Body Parser เสมอ!)
// ==========================================
app.use('/webhook', botHandler.router);

// ==========================================
// 2. Middleware ทั่วไป & Static Files
// ==========================================
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public')); 

// ==========================================
// 3. Web APIs (ส่ง io เข้าไปเพื่อให้ API สั่งแจ้งเตือน Socket ได้)
// ==========================================
app.use('/api', apiRoutes(io));

// ==========================================
// 4. Socket.io Connection
// ==========================================
io.on('connection', (socket) => {
    console.log('🔗 Admin Dashboard connected via Socket:', socket.id);
    socket.on('disconnect', () => console.log('❌ Admin Dashboard disconnected'));
});

app.use(cors({
    origin: '*', // อนุญาตทุกโดเมน (เพื่อให้ Google Apps Script ยิงเข้ามาได้)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// เริ่มรันเซิร์ฟเวอร์
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 Server เปิดแล้วที่ Port: ${PORT}`);
    await botHandler.initializeBrain(); // สั่งให้บอทเริ่มอ่านข้อมูลตอนเปิดเซิร์ฟเวอร์
});