const axios = require('axios');
require('dotenv').config({ path: '../.env' });


// 1. ใส่ Token เดิมของคุณ
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 2. ใส่ ID ของ Guest Menu (เอามาจากผลลัพธ์ที่รันผ่านเมื่อกี้)
const GUEST_MENU_ID = process.env.GUEST_MENU_ID; 

async function setDefaultRichMenu() {
    try {
        await axios.post(
            `https://api.line.me/v2/bot/user/all/richmenu/${GUEST_MENU_ID}`,
            {},
            {
                headers: { 
                    'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
                }
            }
        );
        console.log('✅ ตั้งค่าเมนูเริ่มต้นสำเร็จ!');
        console.log('ตอนนี้ทุกคนที่เปิดเข้าแชท จะเห็นเมนู Guest เป็นอันแรกครับ');
    } catch (error) {
        console.error('❌ Error:', error.response ? error.response.data : error.message);
    }
}

setDefaultRichMenu();