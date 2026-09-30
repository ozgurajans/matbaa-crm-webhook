const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Statik dosyaları public klasöründen sun (HTML arayüzü için)
app.use(express.static('public'));

const {
    PORT = 3000,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    WEBHOOK_VERIFY_TOKEN,
    META_API_VERSION = 'v19.0'
} = process.env;

// Meta Cloud API Temel URL
const WHATSAPP_URL = `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

// ==========================================
// 1. GİDEN MESAJ SERVİSLERİ (OUTBOUND)
// ==========================================

async function sendWhatsAppTemplate(to, templateName, parameters = [], languageCode = 'tr') {
    try {
        const response = await axios.post(
            WHATSAPP_URL,
            {
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''),
                type: 'template',
                template: {
                    name: templateName,
                    language: { code: languageCode },
                    components: [
                        {
                            type: 'body',
                            parameters: parameters.map(param => ({
                                type: 'text',
                                text: String(param)
                            }))
                        }
                    ]
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('✅ WhatsApp Mesajı Gönderildi:', response.data);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ WhatsApp Gönderim Hatası:', error.response?.data || error.message);
        return { success: false, error: error.response?.data || error.message };
    }
}

async function sendWhatsAppTextMessage(to, textMessage) {
    try {
        const response = await axios.post(
            WHATSAPP_URL,
            {
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''),
                type: 'text',
                text: { body: textMessage }
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ Metin Mesajı Hatası:', error.response?.data || error.message);
        return { success: false, error: error.response?.data || error.message };
    }
}

// ==========================================
// 2. CRM APILERI (SİPARİŞ DURUM TETİKLEYİCİLERİ)
// ==========================================

app.post('/api/orders/update-status', async (req, res) => {
    const { orderId, clientName, clientPhone, status, pdfLink, operatorPhone } = req.body;

    console.log(`📦 Sipariş #${orderId} Durumu Güncellendi: ${status}`);

    try {
        switch (status) {
            case 'TASARIM_ONAY_BEKLIYOR':
                await sendWhatsAppTemplate(clientPhone, 'siparis_grafik_onay', [
                    clientName,
                    orderId,
                    pdfLink || 'https://crm.matbaa.com/preview/' + orderId
                ]);
                break;

            case 'BASKIDA':
                if (operatorPhone) {
                    await sendWhatsAppTextMessage(
                        operatorPhone,
                        `🛠 **YENİ BASKI GÖREVİ**\nSipariş #${orderId} (${clientName}) grafik onayı aldı. Baskı sırasına ekleyebilirsiniz.`
                    );
                }
                break;

            case 'SEVKIYAT_YOLDA':
                await sendWhatsAppTemplate(clientPhone, 'siparis_sevkiyat_bilgi', [
                    clientName,
                    orderId
                ]);
                break;

            default:
                break;
        }

        res.json({ success: true, message: `Durum '${status}' olarak güncellendi ve bildirimler tetiklendi.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 3. META WEBHOOK (GELEN MESAJ & BUTON YANITLARI)
// ==========================================

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook Doğrulaması Başarılı!');
        res.status(200).send(challenge);
    } else {
        console.error('❌ Webhook Doğrulama Hatası: Token Eşleşmedi!');
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach(entry => {
            const changes = entry.changes;
            changes?.forEach(async change => {
                if (change.field === 'messages') {
                    const messageData = change.value.messages?.[0];
                    if (!messageData) return;

                    const from = messageData.from;

                    if (messageData.type === 'button') {
                        const buttonText = messageData.button.text;
                        console.log(`📩 [WhatsApp Buton Yanıtı] Tel: ${from} | Karar: ${buttonText}`);

                        if (buttonText.includes('ONAY')) {
                            console.log(`✅ Tel ${from} olan müşterinin siparişi onaylandı!`);
                            await sendWhatsAppTextMessage(from, 'Tasarım onayınız alındı, siparişiniz baskı sırasına eklenmiştir. Teşekkür ederiz!');
                        } else if (buttonText.includes('REVİZE')) {
                            console.log(`⚠️ Tel ${from} olan müşteri revize talep etti.`);
                            await sendWhatsAppTextMessage(from, 'Revize talebiniz grafik ekibimize iletilmiştir. En kısa sürede sizinle iletişime geçilecektir.');
                        }
                    } else if (messageData.type === 'text') {
                        const userText = messageData.text.body;
                        console.log(`💬 [Gelen WhatsApp Mesajı] Tel: ${from} | Mesaj: ${userText}`);
                    }
                }
            });
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// Sunucuyu Başlat
app.listen(PORT, () => {
    console.log(`🚀 CRM WhatsApp Webhook Sunucusu Port ${PORT} Üzerinde Aktif!`);
});