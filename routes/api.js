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
let currentMeterReadingsCache = {};
let logQueue = [];

setInterval(async () => {
    if (logQueue.length === 0) return;
    
    const logsToSend = [...logQueue];
    logQueue = []; // ล้างคิว
    
    try {
        await axios.post(GAS_URL, { 
            action: 'save_live_logs_batch', 
            payload: { logs: logsToSend } // <-- สังเกตตรงนี้
        });
        console.log(`✅ Saved ${logsToSend.length} meter logs to Google Sheets`);
    } catch (error) {
        console.error("❌ Failed to save logs to sheets. Queueing back.", error.message);
        logQueue = [...logsToSend, ...logQueue]; 
    }
}, 10000);

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

    router.get('/live-meter-config', async (req, res) => {
        try {
            const response = await axios.post(GAS_URL, { action: 'get_live_configs' });
            res.json(response.data);
        } catch (error) {
            console.error("Error fetching configs:", error.message);
            res.status(500).json({ error: 'Failed to fetch' });
        }
    });

    router.post('/live-meter-config', async (req, res) => {
        const { roomId, slaveId, type } = req.body;
        try {
            const response = await axios.post(GAS_URL, { 
                action: 'save_live_config', 
                payload: { roomId, slaveId, type } 
            });
            res.json(response.data);
        } catch (error) {
            console.error("Error saving config:", error.message);
            res.status(500).json({ success: false });
        }
    });
    // ==========================================
    // 3. API รับข้อมูลดิบจาก ESP32 Hardware
    // ==========================================
    router.post('/hw-meter-ingest', (req, res) => {
        const meterData = req.body;

        if (!meterData || meterData.slaveId === undefined) {
            return res.status(400).json({ error: "Invalid Payload" });
        }

        // 3.1 อัปเดต Cache ของ Node.js ให้แสดงผลเร็วๆ บน UI
        currentMeterReadingsCache[meterData.slaveId] = meterData;

        // 3.2 บรอดแคสต์ผ่าน Socket.io ให้หน้าบ้านดูกราฟ/เลขวิ่งทันที
        io.emit('live-meter-update', meterData);

        // 3.3 โยนเข้าคิวสำหรับบันทึกลง Google Sheets เพื่อดูประวัติย้อนหลัง
        meterData.timestamp = new Date().toISOString();
        logQueue.push(meterData);

        res.json({ success: true, message: "Data received" });
    });

    // ✅ [เพิ่ม API ใหม่นี้] สำหรับให้หน้าฟอร์มมาดึงข้อมูลล่าสุดทั้งหมดไปเติมอัตโนมัติ
    router.get('/live-meter-current-values', (req, res) => {
        res.json({ success: true, data: currentMeterReadingsCache });
    });


    router.delete('/live-meter-config/:slaveId', async (req, res) => {
        try {
            const slaveId = parseInt(req.params.slaveId);
            const response = await axios.post(GAS_URL, { 
                action: 'delete_live_config', 
                payload: { slaveId } 
            });
            
            if (currentMeterReadingsCache[slaveId]) {
                delete currentMeterReadingsCache[slaveId];
            }
            
            res.json(response.data);
        } catch (error) {
            console.error("Error deleting meter config:", error.message);
            res.status(500).json({ success: false, message: 'Internal Server Error' });
        }
    });

    router.post('/liff-tenant-meter', async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ success: false, message: "No User ID" });

            const gasRes = await axios.post(GAS_URL, { action: 'get_meter_for_bot', userId: userId });
            if (!gasRes.data.success) {
                return res.json({ success: false, message: gasRes.data.message || 'ไม่พบข้อมูลห้องพัก' });
            }

            const { roomId, roomNumber, lastRecord } = gasRes.data;
            const configRes = await axios.post(GAS_URL, { action: 'get_live_configs' });
            const modbusConfigs = configRes.data || [];

            const electricConfig = modbusConfigs.find(c => String(c.roomId) === String(roomId) && (!c.type || c.type === 'electric'));
            const waterConfig = modbusConfigs.find(c => String(c.roomId) === String(roomId) && c.type === 'water');

            const elecLive = electricConfig && currentMeterReadingsCache[electricConfig.slaveId] 
                             ? currentMeterReadingsCache[electricConfig.slaveId].energy : 0;
            const waterLive = waterConfig && currentMeterReadingsCache[waterConfig.slaveId] 
                             ? currentMeterReadingsCache[waterConfig.slaveId].water : 0;

            res.json({
                success: true,
                roomNumber: roomNumber,
                electricSlaveId: electricConfig ? electricConfig.slaveId : null,
                waterSlaveId: waterConfig ? waterConfig.slaveId : null,
                initialElec: elecLive,
                initialWater: waterLive,
                lastRecord: lastRecord 
            });
        } catch (error) {
            console.error("LIFF Meter Error:", error.message);
            res.status(500).json({ success: false, message: 'Server Error' });
        }
    });


    return router;
};