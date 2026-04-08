const express = require('express');
const axios = require('axios');


const GAS_URL = process.env.GAS_URL; // ใส่ URL ของคุณ
const MEMBER_MENU_ID = process.env.MEMBER_MENU_ID; // ใส่ ID ของ Member Menu ที่ได้จากการสร้างเมนู

// ฟังก์ชันเปลี่ยน Rich Menu
async function linkRichMenu(userId, richMenuId) {
    try {
        await axios.post(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {}, {
            headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        console.log(`✅ Switched menu for ${userId} to ${richMenuId}`);
    } catch (error) {
        console.error('❌ Error switching rich menu:', error.response?.data || error.message);
    }
}

let modbusConfigurations = [];

// ส่ง io เข้ามาเพื่อให้เรียกใช้ io.emit ได้
module.exports = function (io) {
    const router = express.Router();

    router.post('/check-phone', async (req, res) => {
        try {
            const response = await axios.post(GAS_URL, { action: 'check_phone', phone: req.body.phone });
            res.json(response.data);
        } catch (error) {
            console.error("Error checking phone:", error.message);
            res.status(500).json({ error: 'Check failed' });
        }
    });

    router.post('/save-tenant', async (req, res) => {
        try {
            const response = await axios.post(GAS_URL, { action: 'save_tenant', payload: req.body });
            res.json(response.data);
        } catch (error) {
            console.error("Error saving tenant:", error.message);
            res.status(500).json({ success: false, message: 'Save failed' });
        }
    });

    router.post('/liff-verify', async (req, res) => {
        try {
            const { userId, displayName, pictureUrl, phone } = req.body;
            if (!userId || !phone) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });

            const response = await axios.post(GAS_URL, { action: 'verify_and_link', userId, displayName, pictureUrl, phone });
            res.json(response.data);
        } catch (error) {
            console.error("Error linking line user:", error.message);
            res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์' });
        }
    });

    router.post('/check-line-status', async (req, res) => {
        try {
            const { userId } = req.body;
            const response = await axios.post(GAS_URL, { action: 'check_line_status', userId });

            if (response.data.linked) {
                console.log(`User ${userId} is already linked. Switching to Member Menu...`);
                await linkRichMenu(userId, MEMBER_MENU_ID);
            }

            res.json(response.data);
        } catch (error) {
            console.error("Error checking status:", error.message);
            res.status(500).json({ linked: false });
        }
    });

    router.post('/verify-line-user', async (req, res) => {
        try {
            const { userId, displayName, pictureUrl, phone } = req.body;
            if (!userId || !phone) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });

            const response = await axios.post(GAS_URL, { action: 'verify_and_link', userId, displayName, pictureUrl, phone });

            if (response.data.success) {
                await linkRichMenu(userId, MEMBER_MENU_ID);
                console.log(`User Linked: ${phone} -> Sending signal to Admin...`);

                // ใช้ Socket แจ้งเตือนแอดมิน
                io.emit('server-update-tenant', {
                    tenantId: response.data.tenant.id,
                    lineUserId: userId,
                    success: true
                });
            }
            res.json(response.data);
        } catch (error) {
            console.error("Error linking line user:", error.message);
            res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์' });
        }
    });

    router.post('/webhook-bill-updated', (req, res) => {
        try {
            const { monthYear, count } = req.body;
            console.log(`🔔 Received Webhook: Bill Updated for ${monthYear} (${count} items)`);

            // ใช้ Socket กระจายข้อมูลให้หน้าบ้านอัปเดต
            io.emit('server-bill-updated', { monthYear, timestamp: new Date().getTime() });

            res.json({ success: true, message: 'Broadcast sent to clients' });
        } catch (error) {
            console.error("Webhook Error:", error.message);
            res.status(500).json({ success: false });
        }
    });

    // ดึงข้อมูลผู้เช่าและประวัติบิลทั้งหมดของตัวเอง (สำหรับ LIFF)
    router.post('/get-tenant-info', async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) {
                return res.status(400).json({ success: false, message: 'ไม่พบ User ID' });
            }

            // ส่ง Action ไปให้ Google Apps Script ประมวลผล
            const response = await axios.post(GAS_URL, {
                action: 'get_tenant_info',
                userId: userId
            });

            res.json(response.data);
        } catch (error) {
            console.error("Error getting tenant info:", error.message);
            res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลจากเซิร์ฟเวอร์' });
        }
    });

    router.get('/live-meter-config', (req, res) => {
        res.json(modbusConfigurations);
    });

    router.post('/live-meter-config', (req, res) => {
        const { roomId, slaveId, type } = req.body;
        
        // เช็คว่ามี Slave ID นี้อยู่แล้วไหม ถ้ามีให้อัปเดต
        const existingIndex = modbusConfigurations.findIndex(c => c.slaveId === slaveId);
        if (existingIndex >= 0) {
            modbusConfigurations[existingIndex] = { roomId, slaveId, type };
        } else {
            modbusConfigurations.push({ roomId, slaveId, type });
        }

        res.json({ success: true, data: modbusConfigurations });
    });

    // ==========================================
    // 3. API รับข้อมูลดิบจาก ESP32 Hardware
    // ==========================================
    // ESP32 จะต้องยิง HTTP POST มาที่พาร์ทนี้ พร้อมแนบ JSON
    router.post('/hw-meter-ingest', (req, res) => {
        /*
          ตัวอย่าง Payload ที่ ESP32 ต้องส่งมา:
          { "slaveId": 1, "voltage": 225.4, "current": 4.2, "power": 0.94, "energy": 1054.2 }
        */
        const meterData = req.body;

        if (!meterData || meterData.slaveId === undefined) {
            return res.status(400).json({ error: "Invalid Payload" });
        }

        // กระจายข้อมูลไปให้หน้าเว็บที่เปิด Live Meter อยู่ผ่าน Socket.io
        io.emit('live-meter-update', meterData);

        res.json({ success: true, message: "Data received" });
    });



    return router;
};