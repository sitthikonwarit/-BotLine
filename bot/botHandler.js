const express = require('express');
const router = express.Router();
const line = require('@line/bot-sdk');
const axios = require('axios');

// --- Google Sheets & Auth ---
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../credentials.json');

// --- LangChain & AI ---
const { ChatOpenAI, OpenAIEmbeddings } = require('@langchain/openai');
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const { Document } = require('@langchain/core/documents');
const { ChatPromptTemplate } = require('@langchain/core/prompts');

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });

const SHEET_ID = process.env.SHEET_ID;
const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL;

// ==========================================
// ระบบบันทึกแชทลง Google Sheet
// ==========================================
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

async function logToSheet(userId, userMessage, botReply) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['ChatLogs'];
        if (!sheet) throw new Error("หาแท็บชื่อ ChatLogs ไม่เจอครับ");

        await sheet.addRow({
            'เวลา': new Date().toLocaleString('th-TH'),
            'รหัสลูกค้า': userId,
            'คำถาม': userMessage,
            'คำตอบ': botReply
        });
        console.log("📝 บันทึกประวัติการแชทลง Google Sheet สำเร็จ!");
    } catch (error) {
        console.error("❌ บันทึกลง Sheet ไม่สำเร็จ:", error.message);
    }
}

// ==========================================
// ระบบ AI สมองบอท
// ==========================================
let vectorRetriever;
let chatModel;
let chatPrompt;

async function initializeBrain() {
    console.log("กำลังดาวน์โหลดข้อมูลผ่าน API จาก Dashboard เพื่อสร้างสมองให้บอท...");
    try {
        const response = await fetch(DASHBOARD_API_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const apiResult = await response.json();
        if (!apiResult.success) throw new Error("API ดึงข้อมูลไม่สำเร็จ: " + apiResult.error);

        const { rooms, tenants, settings } = apiResult.data;
        let docs = [];

        const availableRooms = rooms ? rooms.filter(room => room.status === 'ว่าง' || room.status === 'Available') : [];
        const availableRoomNumbers = availableRooms.map(r => r.number).join(', ');

        const summaryText = `สรุปภาพรวมหอพัก: 
        - ปัจจุบันมีห้องพักในระบบทั้งหมด ${rooms ? rooms.length : 0} ห้อง 
        - มีผู้เช่าทั้งหมด ${tenants ? tenants.length : 0} คน
        - ปัจจุบันมี "ห้องว่าง" ทั้งหมด ${availableRooms.length} ห้อง 
        - รายชื่อห้องที่ว่างตอนนี้คือ: ${availableRoomNumbers || 'ตอนนี้ไม่มีห้องว่างเลย'}`;
        
        docs.push(new Document({ pageContent: summaryText, metadata: { source: "Summary" } }));

        if (settings && settings.config) {
            const settingText = `ข้อมูลการตั้งค่าระบบและค่าบริการ: ค่าไฟหน่วยละ ${settings.config.electricRate || '-'} บาท, ค่าน้ำหน่วยละ ${settings.config.waterRate || '-'} บาท`;
            docs.push(new Document({ pageContent: settingText, metadata: { source: "Settings" } }));
        }

        if (rooms && rooms.length > 0) {
            rooms.forEach(room => {
                const text = `[ข้อมูลห้องพัก]\n- หมายเลขห้อง: ${room.number}\n- รหัสห้อง (ID): ${room.id}\n- สถานะปัจจุบัน: ${room.status}\n- ราคาเช่า: ${room.price} บาท/เดือน\n- รายละเอียด: ${room.detail || 'ไม่มี'}`;
                docs.push(new Document({ pageContent: text, metadata: { source: "Rooms" } }));
            });
        }

        if (tenants && tenants.length > 0) {
            tenants.forEach(tenant => {
                const tagsStr = (tenant.tags && tenant.tags.length > 0) ? tenant.tags.join(', ') : 'ไม่มีแท็ก';
                const startDate = tenant.contractStartDate || tenant.checkInDate || 'ไม่ได้ระบุ';
                const text = `[ข้อมูลผู้เช่า]\n- ชื่อ-นามสกุล: ${tenant.name}\n- รหัสไอดี (ID): ${tenant.id}\n- พักอยู่ห้อง: ${tenant.roomNumber || 'ไม่ได้ระบุ'}\n- เลขบัตรประชาชน: ${tenant.idlicense || 'ไม่มีข้อมูล'}\n- เบอร์ติดต่อ: ${tenant.phone || 'ไม่มีข้อมูล'}\n- ไอดีไลน์ (Line ID): ${tenant.idLine || 'ไม่มีข้อมูล'}\n- วันที่เริ่มสัญญา/วันที่เข้าพัก: ${startDate}\n- วันที่สิ้นสุดสัญญา: ${tenant.contractEndDate || 'ไม่ได้ระบุ'}\n- ลิงก์รูปภาพประจำตัว: ${tenant.imageUrl || 'ไม่มีรูปภาพ'}\n- แท็กผู้เช่า/สิ่งที่ชอบ: ${tagsStr}`;
                docs.push(new Document({ pageContent: text, metadata: { source: "Tenants" } }));
            });
        }

        if (docs.length === 0) docs.push(new Document({ pageContent: "ยังไม่มีข้อมูลในระบบ", metadata: { source: "API" } }));

        const vectorStore = await MemoryVectorStore.fromDocuments(docs, new OpenAIEmbeddings());
        vectorRetriever = vectorStore.asRetriever(15);
        chatModel = new ChatOpenAI({ modelName: "gpt-3.5-turbo", temperature: 0 });

        chatPrompt = ChatPromptTemplate.fromTemplate(`
            คุณคือผู้ช่วยแอดมินอพาร์ตเมนต์บ้านบุญอัมพร เป็นผู้ชาย ตอบคำถามด้วยความสุภาพ เป็นมิตร และดูเป็นมืออาชีพ
            ชื่อของลูกค้าที่กำลังคุยด้วยคือ: {userName}
            
            หน้าที่ของคุณมี 2 ส่วนหลัก (ให้ทำตามอย่างเคร่งครัด):
            
            หน้าที่ 1: การตอบข้อมูลหอพัก (ผู้เช่า, ห้องว่าง, บิลค่าใช้จ่าย)
            - ให้ใช้ "ข้อมูลอ้างอิงจากระบบ" ด้านล่างนี้ในการตอบเท่านั้น!
            
            หน้าที่ 2: ช่วยลูกค้าประเมินการกินไฟของแอร์ (ห้ามปฏิเสธการตอบ!)
            - หากลูกค้าพิมพ์ถามเรื่อง "แอร์", "ติดแอร์", "ค่าไฟแอร์", "BTU" หรือบอกแค่ตัวเลข BTU (ให้เช็คประวัติการสนทนาด้วย)
            - กรณีที่ 1: หากลูกค้ายังไม่บอก BTU แอร์ -> ให้ถามกลับว่า "ยินดีครับ รบกวนขอทราบขนาด BTU ของแอร์ที่ต้องการติดด้วยครับ เพื่อให้ผมประเมินการใช้ไฟให้ครับ"
            - กรณีที่ 2: หากลูกค้าบอก BTU มาแล้ว -> ให้คุณคำนวณทีละขั้นตอนอย่างละเอียด ห้ามคำนวณข้ามขั้นตอนเด็ดขาด!
            
            ขั้นตอนการคำนวณ (เขียนอธิบายทีละข้อให้ลูกค้าดูตามนี้):
            กำหนดสมมติฐาน: แอร์มีค่า SEER = 15 และเปิดใช้งานวันละ 8 ชั่วโมง
            ขั้นที่ 1: กำลังไฟฟ้า (วัตต์) = ขนาด BTU / ค่า SEER (ตัวอย่างวิธีคิด: 12000 / 15 = 800 วัตต์)
            ขั้นที่ 2: การกินไฟต่อวัน (หน่วย) = (กำลังไฟฟ้า / 1000) * ชั่วโมงที่เปิดต่อวัน (ตัวอย่างวิธีคิด: (800 / 1000) * 8 = 6.4 หน่วยต่อวัน)
            ขั้นที่ 3: การกินไฟต่อเดือน (หน่วย) = การกินไฟต่อวัน * 30 วัน (ตัวอย่างวิธีคิด: 6.4 * 30 = 192 หน่วยต่อเดือน)
            ขั้นที่ 4: สรุปเป็นเงิน = นำ "การกินไฟต่อเดือน" คูณกับ "ค่าไฟต่อหน่วย" (ดูเรทค่าไฟจาก ข้อมูลอ้างอิงจากระบบ)
            
            คำแนะนำเพิ่มเติม:
            - เริ่มต้นการตอบด้วยการทักทายชื่อลูกค้าเสมอ แทนตัวเองว่า "ผม" ลงท้ายด้วย "ครับ"
            - หากคำถามไม่เกี่ยวกับหน้าที่ 1 และ 2 ให้ตอบว่า "ขออภัยครับ ไม่พบข้อมูลที่ท่านต้องการในระบบ"
            
            ประวัติการสนทนาล่าสุด:
            {history}
            
            ข้อมูลอ้างอิงจากระบบ:
            {context}
            
            คำถามจากลูกค้า: {input}
            คำตอบ:
        `);
        
        console.log(`✅ สร้างสมองบอทเสร็จเรียบร้อย! (โหลดข้อมูลทั้งหมด ${docs.length} รายการ)`);
    } catch (error) {
        console.error("❌ เกิดข้อผิดพลาดในการสร้างสมองบอท:", error);
    }
}

const activeSessions = new Map();
const sessionTimers = new Map();
const TIMEOUT_LIMIT = 60 * 1000;

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

    const userMessage = event.message.text;
    const userId = event.source.userId;
    let userName = "ลูกค้า";

    try {
        const profile = await client.getProfile(userId);
        userName = profile.displayName;
    } catch (err) {
        console.error("ดึงชื่อผู้ใช้ไม่สำเร็จ:", err.message);
    }

    // ==========================================
    // 1. กดปุ่ม "ข้อมูลผู้เช่า" -> เด้งเมนูย่อยให้เลือก 2 หัวข้อ
    // ==========================================
    if (userMessage === 'ข้อมูลผู้เช่า') {
        const menuFlex = {
            "type": "flex",
            "altText": "เลือกเมนูข้อมูลผู้เช่า",
            "contents": {
              "type": "bubble",
              "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                  { "type": "text", "text": "การจัดการข้อมูล", "weight": "bold", "color": "#1DB446", "size": "sm" },
                  { "type": "text", "text": "กรุณาเลือกรายการที่ต้องการดูครับ", "weight": "bold", "size": "lg", "margin": "md", "wrap": true }
                ]
              },
              "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                  {
                    "type": "button", "style": "primary", "color": "#0d6efd",
                    "action": { "type": "message", "label": "📋 ข้อมูลส่วนตัว", "text": "ดูข้อมูลส่วนตัว" }
                  },
                  {
                    "type": "button", "style": "secondary",
                    "action": { "type": "message", "label": "🧾 ประวัติชำระล่าสุด", "text": "ดูประวัติบิล" }
                  },
                  // 🟢 [เพิ่มปุ่มใหม่ตรงนี้]
                  {
                    "type": "button", "style": "secondary", "color": "#1DB446",
                    "action": { "type": "message", "label": "📊 เช็คยอดน้ำไฟ (Real-time)", "text": "เช็คยอดน้ำไฟ" }
                  }
                ]
              }
            }
        };

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [menuFlex]
        });
    }

    // ==========================================
    // 2. ดักจับข้อความ "ดูข้อมูลส่วนตัว" หรือ "ดูประวัติบิล"
    // ==========================================
    if (userMessage === 'ดูข้อมูลส่วนตัว' || userMessage === 'ดูประวัติบิล') {
        try {
            // ยิงไปถามข้อมูลจาก Google Apps Script
            const response = await axios.post(process.env.DASHBOARD_API_URL || process.env.GAS_URL, {
                action: 'get_tenant_profile_and_bills',
                userId: userId
            });

            const data = response.data;

            if (!data.success) {
                return client.replyMessage({
                    replyToken: event.replyToken,
                    messages: [{ type: 'text', text: 'ไม่พบข้อมูลในระบบ หรือคุณยังไม่ได้ผูกบัญชี กรุณาติดต่อแอดมินครับ' }]
                });
            }

            const profile = data.profile;
            const bills = data.bills;

            // 🟢 [เพิ่มส่วนนี้] ตัวช่วยป้องกัน Error (ถ้าค่าว่างให้ใส่ "-")
            const safeStr = (val) => (val !== undefined && val !== null && String(val).trim() !== '') ? String(val) : '-';

            // --- กรณีเลือก "ดูข้อมูลส่วนตัว" ---
            if (userMessage === 'ดูข้อมูลส่วนตัว') {
                
                // 🟢 สร้างกล่องรายการเอกสาร
                let documentComponents = [];
                if (profile.pdfLinks && profile.pdfLinks.length > 0) {
                    documentComponents.push({ "type": "separator", "margin": "md" });
                    documentComponents.push({
                        "type": "text",
                        "text": "📄 เอกสารและสัญญา",
                        "weight": "bold",
                        "color": "#333333",
                        "size": "sm",
                        "margin": "md"
                    });
                    
                    profile.pdfLinks.forEach(file => {
                        // ชื่อปุ่มห้ามเกิน 40 ตัวอักษรตามกฎของ LINE
                        let fileName = file.name || "เปิดดูเอกสาร";
                        if (fileName.length > 35) fileName = fileName.substring(0, 35) + "...";

                        documentComponents.push({
                            "type": "button",
                            "style": "link",
                            "height": "sm",
                            "action": {
                                "type": "uri",
                                "label": fileName,
                                "uri": file.url
                            }
                        });
                    });
                } else {
                    // ถ้าไม่มีเอกสาร
                    documentComponents.push({ "type": "separator", "margin": "md" });
                    documentComponents.push({
                        "type": "text",
                        "text": "ไม่พบเอกสารแนบในระบบ",
                        "color": "#aaaaaa",
                        "size": "xs",
                        "align": "center",
                        "margin": "md"
                    });
                }

                const profileFlex = {
                    "type": "flex",
                    "altText": "ข้อมูลส่วนตัวผู้เช่า",
                    "contents": {
                        "type": "bubble",
                        "header": {
                            "type": "box", "layout": "vertical", "backgroundColor": "#0d6efd", "paddingAll": "20px",
                            "contents": [
                                { "type": "text", "text": "ข้อมูลส่วนตัวผู้เช่า", "weight": "bold", "color": "#ffffff", "size": "xl" },
                                { "type": "text", "text": `ห้อง: ${safeStr(profile.roomNumber)}`, "color": "#ffffffcc", "size": "md", "margin": "sm" }
                            ]
                        },
                        "body": {
                            "type": "box", "layout": "vertical", "spacing": "md",
                            "contents": [
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "ชื่อ-สกุล", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.name), "color": "#333333", "size": "sm", "flex": 2, "wrap": true }] },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "เบอร์โทร", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.phone), "color": "#333333", "size": "sm", "flex": 2 }] },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "Line ID", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.idLine), "color": "#333333", "size": "sm", "flex": 2 }] },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "บัตร ปชช.", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.idCard), "color": "#333333", "size": "sm", "flex": 2 }] },
                                { "type": "separator", "margin": "md" },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "ที่อยู่", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.address), "color": "#333333", "size": "sm", "flex": 2, "wrap": true }] },
                                { "type": "separator", "margin": "md" },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "เข้าพัก", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.checkInDate), "color": "#333333", "size": "sm", "flex": 2 }] },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "เริ่มสัญญา", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.contractStart), "color": "#333333", "size": "sm", "flex": 2 }] },
                                { "type": "box", "layout": "horizontal", "contents": [{ "type": "text", "text": "สิ้นสุด", "color": "#aaaaaa", "size": "sm", "flex": 1 }, { "type": "text", "text": safeStr(profile.contractEnd), "color": "#DC3545", "size": "sm", "flex": 2 }] },
                                
                                // 🟢 นำกล่องเอกสารแนบมาต่อท้ายตรงนี้
                                ...documentComponents 
                            ]
                        }
                    }
                };
                return client.replyMessage({ replyToken: event.replyToken, messages: [profileFlex] });
            }

            // --- กรณีเลือก "ดูประวัติบิล" ---
            if (userMessage === 'ดูประวัติบิล') {
                let billListComponents = [];
                
                if (bills && bills.length > 0) {
                    // แสดงบิลสูงสุด 12 เดือนล่าสุด
                    bills.slice(0, 12).forEach((bill, index) => {
                        let statusText = bill.status === 'paid' ? '✅ ชำระแล้ว' : (bill.isOverdue ? '❌ ค้างชำระ' : '⏳ รอชำระ');
                        let statusColor = bill.status === 'paid' ? '#06C755' : (bill.isOverdue ? '#DC3545' : '#FFC107');
                        let totalFmt = bill.total ? new Intl.NumberFormat('th-TH').format(bill.total) : '0';

                        if (index > 0) {
                            billListComponents.push({ "type": "separator", "margin": "md", "color": "#eeeeee" });
                        }

                        billListComponents.push({
                            "type": "box", "layout": "horizontal", "margin": "md", "alignItems": "center",
                            "contents": [
                                {
                                    "type": "box", "layout": "vertical", "flex": 2,
                                    "contents": [
                                        { "type": "text", "text": `รอบบิล ${safeStr(bill.monthYear)}`, "size": "sm", "weight": "bold", "color": "#333333" },
                                        { "type": "text", "text": statusText, "size": "xs", "color": statusColor, "margin": "xs", "weight": "bold" }
                                    ]
                                },
                                { "type": "text", "text": `${totalFmt} ฿`, "size": "sm", "weight": "bold", "color": "#111111", "align": "end", "flex": 1 }
                            ]
                        });
                    });
                } else {
                    billListComponents.push({ "type": "text", "text": "ไม่มีประวัติการชำระเงินในระบบ", "size": "sm", "color": "#aaaaaa", "align": "center", "margin": "md" });
                }

                const billsFlex = {
                    "type": "flex",
                    "altText": "ประวัติการชำระเงิน",
                    "contents": {
                        "type": "bubble",
                        "header": {
                            "type": "box", "layout": "vertical", "backgroundColor": "#212529", "paddingAll": "20px",
                            "contents": [
                                { "type": "text", "text": "ประวัติการชำระเงิน", "weight": "bold", "color": "#ffffff", "size": "xl" },
                                { "type": "text", "text": `ห้อง: ${safeStr(profile.roomNumber)}`, "color": "#ffffffcc", "size": "md", "margin": "sm" }
                            ]
                        },
                        "body": {
                            "type": "box", "layout": "vertical",
                            "contents": billListComponents
                        }
                    }
                };
                return client.replyMessage({ replyToken: event.replyToken, messages: [billsFlex] });
            }

        } catch (error) {
            console.error("Error fetching tenant info:", error.message);
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: 'ระบบมีปัญหาในการดึงข้อมูล กรุณาลองใหม่อีกครั้งครับ' }]
            });
        }
    }

    if (userMessage === 'เช็คยอดน้ำไฟ') {
        try {
            // 1. ยิง API ไปที่ GAS เพื่อเอา Room ID และข้อมูลบิลรอบล่าสุด
            const gasRes = await axios.post(process.env.DASHBOARD_API_URL || process.env.GAS_URL, {
                action: 'get_meter_for_bot',
                userId: userId
            });

            if (!gasRes.data.success) {
                return client.replyMessage({
                    replyToken: event.replyToken,
                    messages: [{ type: 'text', text: gasRes.data.message || 'ไม่พบข้อมูลห้องพักครับ' }]
                });
            }

            const { roomId, roomNumber, lastRecord } = gasRes.data;

            // 2. ยิง API ภายในเครื่องตัวเอง (localhost) เพื่อเอา Cache ของมิเตอร์ ESP32
            const port = process.env.PORT || 3000;
            const configRes = await axios.get(`http://localhost:${port}/api/live-meter-config`);
            const liveDataRes = await axios.get(`http://localhost:${port}/api/live-meter-current-values`);

            const modbusConfigs = configRes.data;
            const liveReadings = liveDataRes.data.data;

            // 3. หา Slave ID ของห้องนี้จาก Config
            const electricConfig = modbusConfigs.find(c => String(c.roomId) === String(roomId) && (!c.type || c.type === 'electric'));
            const waterConfig = modbusConfigs.find(c => String(c.roomId) === String(roomId) && c.type === 'water');

            let replyText = `📊 ข้อมูลมิเตอร์ห้อง ${roomNumber}\nประจำเดือนปัจจุบัน\n\n`;

            // --- คำนวณมิเตอร์ไฟ ---
            if (electricConfig && liveReadings[electricConfig.slaveId]) {
                const liveElec = parseFloat(liveReadings[electricConfig.slaveId].energy || 0); // เปลี่ยน .energy ตาม key จริงของ Payload HW คุณ
                const lastElec = lastRecord && lastRecord.electricReading !== '-' ? parseFloat(lastRecord.electricReading) : 0;
                const usageElec = (liveElec - lastElec).toFixed(2);

                replyText += `⚡️ **มิเตอร์ไฟฟ้า**\n`;
                replyText += `- บิลรอบที่แล้ว: ${lastElec} หน่วย\n`;
                replyText += `- วิ่งถึงตอนนี้: ${liveElec.toFixed(1)} หน่วย\n`;
                replyText += `- 🔺 ใช้ไปเดือนนี้: ${Math.max(0, usageElec)} หน่วย\n\n`;
            } else {
                replyText += `⚡️ มิเตอร์ไฟฟ้า: (ไม่ได้เชื่อมต่ออุปกรณ์)\n\n`;
            }

            // --- คำนวณมิเตอร์น้ำ ---
            if (waterConfig && liveReadings[waterConfig.slaveId]) {
                const liveWater = parseFloat(liveReadings[waterConfig.slaveId].water || 0); // เปลี่ยน .water ตาม key จริงของ Payload HW คุณ
                const lastWater = lastRecord && lastRecord.waterReading !== '-' ? parseFloat(lastRecord.waterReading) : 0;
                const usageWater = (liveWater - lastWater).toFixed(2);

                replyText += `💧 **มิเตอร์น้ำ**\n`;
                replyText += `- บิลรอบที่แล้ว: ${lastWater} หน่วย\n`;
                replyText += `- วิ่งถึงตอนนี้: ${liveWater.toFixed(1)} หน่วย\n`;
                replyText += `- 🔺 ใช้ไปเดือนนี้: ${Math.max(0, usageWater)} หน่วย\n`;
            } else {
                replyText += `💧 มิเตอร์น้ำ: (ไม่ได้เชื่อมต่ออุปกรณ์)\n`;
            }

            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: replyText }]
            });

        } catch (error) {
            console.error("Error fetching live meter for bot:", error.message);
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: 'ระบบไม่สามารถดึงข้อมูลมิเตอร์แบบเรียลไทม์ได้ในขณะนี้ กรุณาลองใหม่อีกครั้งครับ' }]
            });
        }
    }

    // ==========================================
    // 3. กดปุ่ม "เพิ่มเติม" (โหมดคุยกับบอท)
    // ==========================================
    if (userMessage === 'เพิ่มเติม') {
        if (activeSessions.has(userId)) {
            clearTimeout(sessionTimers.get(userId)); 
            activeSessions.delete(userId);           
            sessionTimers.delete(userId);            
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: 'จบการสนทนา BP บอทน้อยขอบคุณครับ' }]
            });
        }

        activeSessions.set(userId, { history: [] });
        const timer = setTimeout(async () => {
            if (activeSessions.has(userId)) {
                activeSessions.delete(userId);
                sessionTimers.delete(userId);
                try {
                    await client.pushMessage({
                        to: userId,
                        messages: [{ type: 'text', text: 'จบการสนทนา BP บอทน้อยขอบคุณครับ' }]
                    });
                } catch (e) { console.error("Push timeout error:", e); }
            }
        }, TIMEOUT_LIMIT);

        sessionTimers.set(userId, timer);

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'อันนี้เป็นข้อความเสริมจาก BP บอทน้อย ครับ หากไม่มีการพิมพ์เกิน 1 นาที หรือ กดเพิ่มเติมอีกครั้งจะปิดการสนทนาครับ' }]
        });
    }

    // ==========================================
    // 4. อยู่ในโหมด AI คุย (ต้องพิมพ์คำอื่นที่ไม่ใช่คีย์เวิร์ดด้านบน)
    // ==========================================
    if (activeSessions.has(userId)) {
        clearTimeout(sessionTimers.get(userId));
        const newTimer = setTimeout(async () => {
            activeSessions.delete(userId);
            sessionTimers.delete(userId);
            await client.pushMessage({
                to: userId,
                messages: [{ type: 'text', text: 'จบการสนทนา BP บอทน้อยขอบคุณครับ' }]
            });
        }, TIMEOUT_LIMIT);
        sessionTimers.set(userId, newTimer);

        let replyText = "บอทยังเตรียมสมองไม่เสร็จ กรุณารอสักครู่นะครับ";
        if (vectorRetriever && chatModel) {
            try {
                const relevantDocs = await vectorRetriever.invoke(userMessage);
                const contextText = relevantDocs.map(doc => doc.pageContent).join("\n\n");

                // 🟢 ดึงประวัติการคุยออกมา
                let sessionData = activeSessions.get(userId);
                if (sessionData === true) sessionData = { history: [] }; // ดักไว้เผื่อเป็นค่า true เดิม
                
                const historyText = sessionData.history && sessionData.history.length > 0 
                    ? sessionData.history.join('\n') 
                    : "เพิ่งเริ่มการสนทนา";

                // 🟢 ส่ง history เข้าไปใน Prompt
                const formattedPrompt = await chatPrompt.formatMessages({
                    history: historyText,
                    context: contextText,
                    input: userMessage,
                    userName: userName 
                });

                const response = await chatModel.invoke(formattedPrompt);
                replyText = response.content;

                // 🟢 บันทึกคำถามและคำตอบรอบนี้กลับเข้าไปในระบบความจำ
                if(!sessionData.history) sessionData.history = [];
                sessionData.history.push(`ลูกค้า: ${userMessage}`);
                sessionData.history.push(`แอดมิน: ${replyText}`);
                
                // ให้จำแค่ 3 คู่ล่าสุด (6 ข้อความ) เพื่อป้องกัน Token ล้นและลดค่าใช้จ่าย
                if (sessionData.history.length > 6) {
                    sessionData.history.splice(0, 2); 
                }
                activeSessions.set(userId, sessionData);
                // ------------------------------------------

                await logToSheet(userId, userMessage, replyText);
            } catch (error) {
                console.error("Chat Error:", error);
                replyText = "ขออภัยครับ ตอนนี้สมองบอทมีอาการรวนเล็กน้อย";
            }
        }

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: replyText }],
        });
    }

    return Promise.resolve(null);
}
// ==========================================
// Webhook Route
// ==========================================
router.post('/', line.middleware(config), async (req, res) => {
    try {
        const events = req.body.events;
        await Promise.all(events.map(handleEvent));
        res.status(200).end();
    } catch (err) {
        console.error("Webhook Error:", err);
        res.status(500).end();
    }
});

module.exports = { router, initializeBrain };