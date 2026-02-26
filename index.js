const express = require('express');
const line = require('@line/bot-sdk');
require('dotenv').config();

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./credentials.json');

const { ChatOpenAI, OpenAIEmbeddings } = require('@langchain/openai');
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const { Document } = require('@langchain/core/documents');
const { ChatPromptTemplate } = require('@langchain/core/prompts');

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
const app = express();

const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});


const SHEET_ID = process.env.SHEET_ID;
const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL;

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

let vectorRetriever;
let chatModel;
let chatPrompt;

// ฟังก์ชันสมองใหม่! ดึงข้อมูลจาก API Dashboard
async function initializeBrain() {
    console.log("กำลังดาวน์โหลดข้อมูลผ่าน API จาก Dashboard เพื่อสร้างสมองให้บอท...");
    try {
        const response = await fetch(DASHBOARD_API_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const apiResult = await response.json();
        if (!apiResult.success) throw new Error("API ดึงข้อมูลไม่สำเร็จ: " + apiResult.error);

        const { rooms, tenants, settings } = apiResult.data;
        let docs = [];

        // 1. หน้าสรุปข้อมูล
        const availableRooms = rooms ? rooms.filter(room => room.status === 'ว่าง' || room.status === 'Available') : [];
        const availableRoomNumbers = availableRooms.map(r => r.number).join(', ');

        // 1. หน้าสรุปข้อมูล (เพิ่มข้อมูลห้องว่างเข้าไปแบบตรงๆ)
        const summaryText = `สรุปภาพรวมหอพัก: 
        - ปัจจุบันมีห้องพักในระบบทั้งหมด ${rooms ? rooms.length : 0} ห้อง 
        - มีผู้เช่าทั้งหมด ${tenants ? tenants.length : 0} คน
        - ปัจจุบันมี "ห้องว่าง" ทั้งหมด ${availableRooms.length} ห้อง 
        - รายชื่อห้องที่ว่างตอนนี้คือ: ${availableRoomNumbers || 'ตอนนี้ไม่มีห้องว่างเลย'}`;
        
        docs.push(new Document({ pageContent: summaryText, metadata: { source: "Summary" } }));

        // 2. ข้อมูลการตั้งค่า (ค่าไฟ ค่าน้ำ)
        if (settings && settings.config) {
            const settingText = `ข้อมูลการตั้งค่าระบบและค่าบริการ: ค่าไฟหน่วยละ ${settings.config.electricRate || '-'} บาท, ค่าน้ำหน่วยละ ${settings.config.waterRate || '-'} บาท`;
            docs.push(new Document({ pageContent: settingText, metadata: { source: "Settings" } }));
        }

        // 3. แปลงข้อมูลห้องพัก (จัดฟอร์แมตให้อ่านง่าย)
        if (rooms && rooms.length > 0) {
            rooms.forEach(room => {
                const text = `[ข้อมูลห้องพัก]
                    - หมายเลขห้อง: ${room.number}
                    - รหัสห้อง (ID): ${room.id}
                    - สถานะปัจจุบัน: ${room.status}
                    - ราคาเช่า: ${room.price} บาท/เดือน
                    - รายละเอียด: ${room.detail || 'ไม่มี'}`;
                docs.push(new Document({ pageContent: text, metadata: { source: "Rooms" } }));
            });
        }

        // 4. แปลงข้อมูลผู้เช่า (🌟 เพิ่มเลขบัตร, วันสัญญา, และจัดบรรทัด)
        if (tenants && tenants.length > 0) {
            tenants.forEach(tenant => {
                const tagsStr = (tenant.tags && tenant.tags.length > 0) ? tenant.tags.join(', ') : 'ไม่มีแท็ก';
                // ดึงวันที่เข้าพัก หรือ วันเริ่มสัญญา มาแสดง
                const startDate = tenant.contractStartDate || tenant.checkInDate || 'ไม่ได้ระบุ';

                const text = `[ข้อมูลผู้เช่า]
                - ชื่อ-นามสกุล: ${tenant.name}
                - รหัสไอดี (ID): ${tenant.id}
                - พักอยู่ห้อง: ${tenant.roomNumber || 'ไม่ได้ระบุ'}
                - เลขบัตรประชาชน: ${tenant.idlicense || 'ไม่มีข้อมูล'}
                - เบอร์ติดต่อ: ${tenant.phone || 'ไม่มีข้อมูล'}
                - ไอดีไลน์ (Line ID): ${tenant.idLine || 'ไม่มีข้อมูล'}
                - วันที่เริ่มสัญญา/วันที่เข้าพัก: ${startDate}
                - วันที่สิ้นสุดสัญญา: ${tenant.contractEndDate || 'ไม่ได้ระบุ'}
                - ลิงก์รูปภาพประจำตัว: ${tenant.imageUrl || 'ไม่มีรูปภาพ'}
                - แท็กผู้เช่า/สิ่งที่ชอบ: ${tagsStr}`;

                docs.push(new Document({ pageContent: text, metadata: { source: "Tenants" } }));
            });
        }

        if (docs.length === 0) {
            docs.push(new Document({ pageContent: "ยังไม่มีข้อมูลในระบบ", metadata: { source: "API" } }));
        }

        const vectorStore = await MemoryVectorStore.fromDocuments(docs, new OpenAIEmbeddings());
        // ดึงข้อมูลมาอ่าน 15 รายการ เพื่อให้หาเจอได้แม่นยำขึ้น
        vectorRetriever = vectorStore.asRetriever(15);

        chatModel = new ChatOpenAI({ modelName: "gpt-3.5-turbo", temperature: 0 });

        chatPrompt = ChatPromptTemplate.fromTemplate(`
            คุณคือผู้ช่วยแอดมินหอพัก/อพาร์ตเมนต์ เป็นผู้ชาย ตอบคำถามด้วยความสุภาพ เป็นมิตร และดูเป็นมืออาชีพ
            ชื่อของลูกค้าที่กำลังคุยด้วยคือ: {userName}
            
            กรุณาใช้ "ข้อมูลอ้างอิงจากระบบ" ด้านล่างนี้ในการตอบคำถามเท่านั้น 
            
            คำแนะนำพิเศษ:
            - เริ่มต้นการตอบคำถามด้วยการเรียกชื่อลูกค้าเสมอ เช่น "สวัสดีครับคุณ {userName}" 
            - ให้แทนตัวเองว่า "ผม" และลงท้ายประโยคด้วยคำว่า "ครับ" เสมอ (ห้ามใช้ ค่ะ หรือ ดิฉัน เด็ดขาด)
            - หากผู้ใช้ถามหารูปภาพ ให้คุณส่ง "ลิงก์รูปภาพประจำตัว" ให้ผู้ใช้ได้เลย
            - หากผู้ใช้ถามยอดรวม (เช่น มีผู้เช่ากี่คน มีห้องกี่ห้อง) หรือ ถามหา "ห้องว่าง" ให้ตอบตามข้อมูล "สรุปภาพรวมหอพัก" ทันที
            - หากในข้อมูลอ้างอิงระบุว่า 'ไม่มีข้อมูล' หรือหาไม่เจอ ให้ตอบว่า "ขออภัยครับ ไม่พบข้อมูลที่ท่านต้องการในระบบ"
            
            ข้อมูลอ้างอิงจากระบบ:
            {context}
            
            คำถามจากลูกค้า: {input}
            คำตอบ:
    `);

        console.log(`✅ สร้างสมองบอทเสร็จเรียบร้อย! (โหลดข้อมูลใส่สมองทั้งหมด ${docs.length} รายการ)`);
    } catch (error) {
        console.error("❌ เกิดข้อผิดพลาดในการสร้างสมองบอท:", error);
    }
}

app.post('/webhook', line.middleware(config), async (req, res) => {
    // --- โค้ดส่วน Webhook คงเดิม ---
    try {
        const events = req.body.events;
        await Promise.all(events.map(handleEvent));
        res.status(200).end();
    } catch (err) {
        console.error(err);
        res.status(500).end();
    }
});

async function handleEvent(event) {
    // --- โค้ดส่วน HandleEvent คงเดิม ---
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const userMessage = event.message.text;
    const userId = event.source.userId;
    
    // 🌟 1. ดึงข้อมูล Profile จาก LINE เพื่อเอาชื่อ (Display Name)
    let userName = "ลูกค้า";
    try {
        const profile = await client.getProfile(userId);
        userName = profile.displayName;
    } catch (err) {
        console.error("ดึงชื่อผู้ใช้ไม่สำเร็จ ใช้ชื่อเริ่มต้นแทน:", err.message);
    }

    console.log(`💬 มีคนถามมาว่า: ${userMessage} (จากคุณ: ${userName})`);

    let replyText = "บอทยังเตรียมสมองไม่เสร็จ กรุณารอสักครู่นะครับ";

    if (vectorRetriever && chatModel) {
        try {
            const relevantDocs = await vectorRetriever.invoke(userMessage);
            const contextText = relevantDocs.map(doc => doc.pageContent).join("\n\n");

            // 🌟 เพิ่มบรรทัดนี้เพื่อดูว่า AI มันค้นเจออะไรบ้างก่อนจะตอบ
            console.log(`\n=============================`);
            console.log(`👤 คำถาม: "${userMessage}"`);
            console.log(`🔍 ข้อมูลที่ AI ดึงมาได้จากระบบ:\n${contextText || "--- ไม่พบข้อมูลใดๆ ---"}`);
            console.log(`=============================\n`);

            // 🌟 2. ส่ง userName เข้าไปให้ AI รู้จักชื่อลูกค้า
            const formattedPrompt = await chatPrompt.formatMessages({
                context: contextText,
                input: userMessage,
                userName: userName 
            });

            const response = await chatModel.invoke(formattedPrompt);
            replyText = response.content;

            await logToSheet(userId, userMessage, replyText);

        } catch (error) {
            console.error("Error asking AI:", error);
            replyText = "ขออภัยครับ ตอนนี้สมองบอทมีอาการรวนเล็กน้อย (ระบบขัดข้อง)";
        }
    }

    return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: replyText }],
    });
}


const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Server เปิดแล้วที่ Port: ${PORT}`);
    await initializeBrain();
});