require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bodyParser = require('body-parser');
const cors = require('cors'); // นำเข้าโมดูล cors

// 1. ประกาศสร้าง app และ server ก่อน! (ห้ามเอาอะไรมาคั่นก่อนบรรทัดนี้)
const app = express();
const server = http.createServer(app);

// 2. ตั้งค่า CORS (ต้องอยู่หลังจาก const app = express() เสมอ)
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
}));

// 3. ตั้งค่า Socket.io
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
// 4. LINE Webhook (ต้องอยู่ก่อน Body Parser เสมอ!)
// ==========================================
app.use('/webhook', botHandler.router);

// ==========================================
// 5. Middleware ทั่วไป & Static Files
// ==========================================
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 6. Web APIs (ส่ง io เข้าไปเพื่อให้ API สั่งแจ้งเตือน Socket ได้)
// ==========================================
app.use('/api', apiRoutes(io));

// ==========================================
// 7. Socket.io Connection
// ==========================================
io.on('connection', (socket) => {
    console.log('🔗 Admin Dashboard connected via Socket:', socket.id);
    socket.on('disconnect', () => console.log('❌ Admin Dashboard disconnected'));
});

// เริ่มรันเซิร์ฟเวอร์
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 Server เปิดแล้วที่ Port: ${PORT}`);
    await botHandler.initializeBrain(); // สั่งให้บอทเริ่มอ่านข้อมูลตอนเปิดเซิร์ฟเวอร์
});