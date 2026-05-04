const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ================= KONFIGURASI =================
const TARGET_GROUP_ID = '120363426296094605@g.us'; 

const CACHE_TTL_MINUTES = 5; 
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;
const BOT_ID = String(process.env.BOT_ID || '1').replace(/[^a-zA-Z0-9_-]/g, '');

const SESSION_PATH = `auth_info_bot${BOT_ID}`;
let sock;

// ================= SISTEM ANTI-DUPLIKAT =================
const HISTORY_DIR = path.join(__dirname, 'history_links');

if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
} else {
    try {
        const files = fs.readdirSync(HISTORY_DIR);
        for (const file of files) fs.unlinkSync(path.join(HISTORY_DIR, file));
    } catch (e) {}
}

function isDuplicate(link) {
    const hash = crypto.createHash('md5').update(link).digest('hex');
    const historyFile = path.join(HISTORY_DIR, `${hash}.txt`);

    if (fs.existsSync(historyFile)) return true;

    try {
        const fd = fs.openSync(historyFile, 'wx');
        fs.closeSync(fd);
        
        setTimeout(() => {
            try { if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile); } catch (e) {}
        }, CACHE_TTL_MS);

        return false; 
    } catch (err) {
        return true; 
    }
}

// ================= EKSTRAKSI URL SUPER KETAT =================
function extractUrls(text) {
    if (!text) return [];
    const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
    const matches = text.match(regex);
    if (!matches) return [];

    const results = [];
    for (let i = 0; i < matches.length; i++) {
        let u = matches[i];
        
        if (u.includes('/minta') || u.endsWith('dana.id') || u.endsWith('dana.id/')) continue;
        if (u.includes('dana.id') && !u.includes('kaget') && !u.includes('danakaget')) continue;

        results.push(u.startsWith('http') ? u : 'https://' + u);
    }
    return results;
}

// ================= FUNGSI KIRIM (INSTAN) =================
function sendOnce(text, label) {
    const key = text.trim();
    if (isDuplicate(key)) return;

    const msg = `${key}\n\nTipe: ${label}`;

    if (sock) {
        sock.sendMessage(TARGET_GROUP_ID, { text: msg }).catch(() => { });
    }
}

// ================= DETEKSI QR PARALEL (SUPER CEPAT) =================
async function detectQR(buffer) {
    try {
        const baseImg = sharp(buffer).flatten({ background: '#ffffff' });
        const meta = await baseImg.metadata();

        const decodeBuffer = async (imgBuf) => {
            const image = await Jimp.read(imgBuf);
            return new Promise((resolve, reject) => {
                const qr = new QrCode();
                qr.callback = (e, v) => (e || !v) ? reject(e) : resolve(v.result);
                qr.decode(image.bitmap);
            });
        };

        const cw1 = Math.floor(meta.width * 0.7); const ch1 = Math.floor(meta.height * 0.6);
        const cw2 = Math.floor(meta.width * 0.45); const ch2 = Math.floor(meta.height * 0.4);

        const buffers = await Promise.all([
            baseImg.clone().png().toBuffer(),
            baseImg.clone().greyscale().linear(1.5, -50).png().toBuffer(),
            baseImg.clone().extract({ left: Math.floor((meta.width - cw1) / 2), top: Math.floor((meta.height - ch1) / 2), width: cw1, height: ch1 }).resize(cw1 * 2).greyscale().threshold(140).png().toBuffer(),
            baseImg.clone().extract({ left: Math.floor((meta.width - cw2) / 2), top: Math.floor((meta.height - ch2) / 2), width: cw2, height: ch2 }).resize(cw2 * 3).greyscale().linear(2, -100).png().toBuffer()
        ]);

        return await Promise.any(buffers.map(buf => decodeBuffer(buf)));
    } catch {
        return null;
    }
}

// ================= DOWNLOAD MEDIA =================
async function downloadMedia(mediaMsg, type) {
    try {
        if (mediaMsg.mediaKey) {
            const stream = await downloadContentFromMessage(mediaMsg, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
            return buffer;
        } 
        
        let downloadUrl = mediaMsg.url || (mediaMsg.directPath ? `https://mmg.whatsapp.net${mediaMsg.directPath}` : null);

        if (downloadUrl) {
            return new Promise((resolve, reject) => {
                https.get(downloadUrl, (res) => {
                    const data = [];
                    res.on('data', chunk => data.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(data)));
                }).on('error', err => reject(err));
            });
        }
        throw new Error('Tidak ada url atau mediaKey');
    } catch (error) { throw error; }
}

// ================= CORE BOT =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: [`WaBot-${BOT_ID}`, 'Chrome', '1.0.0'],
        getMessage: async () => ({ conversation: '' }),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            } else { process.exit(1); }
        } else if (connection === 'open') {
            console.log(`⚡ BOT ${BOT_ID} READY! (Fast Paralel Scan)`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (!from || from === TARGET_GROUP_ID) return;

        let msgObj = msg.message;
        if (msgObj.ephemeralMessage) msgObj = msgObj.ephemeralMessage.message;
        if (msgObj.viewOnceMessage) msgObj = msgObj.viewOnceMessage.message;
        if (msgObj.viewOnceMessageV2) msgObj = msgObj.viewOnceMessageV2.message;
        if (msgObj.viewOnceMessageV2Extension) msgObj = msgObj.viewOnceMessageV2Extension.message;
        if (msgObj.documentWithCaptionMessage) msgObj = msgObj.documentWithCaptionMessage.message;

        const text = msgObj.conversation || msgObj.extendedTextMessage?.text || msgObj.imageMessage?.caption || msgObj.videoMessage?.caption || '';
        if (text) extractUrls(text).forEach(url => sendOnce(url, 'Link'));

        const imageMsg = msgObj.imageMessage;
        const stickerMsg = msgObj.stickerMessage;

        if (imageMsg || stickerMsg) {
            const mediaMsg = imageMsg || stickerMsg;
            const mediaType = imageMsg ? 'image' : 'sticker';

            downloadMedia(mediaMsg, mediaType).then(buffer => {
                detectQR(buffer).then(qrData => {
                    if (qrData && VALID_DOMAINS.test(qrData)) {
                        if (qrData.includes('qr.dana.id') || qrData.includes('/minta')) return;
                        sendOnce(qrData, imageMsg ? 'Gambar QR' : 'Stiker QR');
                    }
                }).catch(() => { });
            }).catch(() => { });
        }
    });

    sock.ev.on('groups.update', updates => {
        for (const update of updates) {
            if (update.desc) extractUrls(update.desc.toString()).forEach(url => sendOnce(url, 'Deskripsi Grup'));
        }
    });
}

startBot();

// ================= JADWAL OFF & ON HARIAN =================
function scheduleDailyTask(hour, minute, task) {
    const now = new Date();
    const target = new Date();
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    setTimeout(() => {
        task();
        setInterval(task, 24 * 60 * 60 * 1000);
    }, target - now);
}

// Sesi OFF setiap jam 04:50
scheduleDailyTask(4, 50, () => {
    console.log(`[BOT ${BOT_ID}] 📴 Mode OFF Otomatis`);
    if (sock) sock.ws.close(); 
});

// Sesi ON kembali setiap jam 06:00
scheduleDailyTask(6, 0, () => {
    console.log(`[BOT ${BOT_ID}] 🔛 Menyambung Kembali Sesi`);
    startBot(); 
});

process.on('unhandledRejection', () => { });
process.on('uncaughtException', () => process.exit(1));