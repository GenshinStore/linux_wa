const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https'); // Modul untuk download dari Channel

// ==========================================
//             KONFIGURASI UTAMA
// ==========================================
const PRIMARY_GROUP_ID = '120363408426078537@g.us';
const SECONDARY_GROUP_ID = '120363426296094605@g.us';

const ENABLE_FORWARD_TO_SECONDARY = true; 
const DELAY_MS = 1000; 

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

// ================= FUNGSI KIRIM =================
function sendOnce(text, label) {
    const key = text.trim();
    if (isDuplicate(key)) return;

    const msg = `${key}\n\nTipe: ${label}`;

    if (sock) {
        sock.sendMessage(PRIMARY_GROUP_ID, { text: msg }).catch(() => { });
        if (ENABLE_FORWARD_TO_SECONDARY) {
            setTimeout(() => {
                sock.sendMessage(SECONDARY_GROUP_ID, { text: msg }).catch(() => { });
            }, DELAY_MS);
        }
    }
}

// ================= EKSTRAKSI URL =================
function extractUrls(text) {
    if (!text) return [];
    const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
    const matches = text.match(regex);
    if (!matches) return [];

    const results = [];
    for (let i = 0; i < matches.length; i++) {
        let u = matches[i];
        if (u.includes('link.dana.id/minta') || u.endsWith('link.dana.id') || u.endsWith('link.dana.id/')) continue;
        results.push(u.startsWith('http') ? u : 'https://' + u);
    }
    return results;
}

// ================= DETEKSI GAMBAR QR =================
async function detectQR(buffer) {
    try {
        const decode = async (imgBuffer) => {
            const image = await Jimp.read(imgBuffer);
            return new Promise((resolve) => {
                const qr = new QrCode();
                qr.callback = (e, v) => resolve((e || !v) ? null : v.result);
                qr.decode(image.bitmap);
            });
        };

        const baseImg = sharp(buffer).flatten({ background: '#ffffff' });
        const meta = await baseImg.metadata();

        let res = await decode(await baseImg.clone().png().toBuffer());
        if (res) return res;

        res = await decode(await baseImg.clone().greyscale().linear(1.5, -50).png().toBuffer());
        if (res) return res;

        const cw1 = Math.floor(meta.width * 0.7);
        const ch1 = Math.floor(meta.height * 0.6);
        res = await decode(await baseImg.clone().extract({ left: Math.floor((meta.width - cw1) / 2), top: Math.floor((meta.height - ch1) / 2), width: cw1, height: ch1 }).resize(cw1 * 2).greyscale().threshold(140).png().toBuffer());
        if (res) return res;

        const cw2 = Math.floor(meta.width * 0.45);
        const ch2 = Math.floor(meta.height * 0.4);
        return await decode(await baseImg.clone().extract({ left: Math.floor((meta.width - cw2) / 2), top: Math.floor((meta.height - ch2) / 2), width: cw2, height: ch2 }).resize(cw2 * 3).greyscale().linear(2, -100).png().toBuffer());
    } catch {
        return null;
    }
}

// ================= DOWNLOAD MEDIA (Support Channel) =================
async function downloadMedia(mediaMsg, type) {
    try {
        if (mediaMsg.mediaKey) {
            const stream = await downloadContentFromMessage(mediaMsg, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            return buffer;
        } 
        
        let downloadUrl = mediaMsg.url;
        if (!downloadUrl && mediaMsg.directPath) {
            downloadUrl = `https://mmg.whatsapp.net${mediaMsg.directPath}`;
        }

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
    } catch (error) {
        throw error;
    }
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
            } else {
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log(`⚡ BOT ${BOT_ID} READY! (Mendukung Channel WA)`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (!from || from === PRIMARY_GROUP_ID || from === SECONDARY_GROUP_ID) return;

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
            const sourceInfo = from.includes('@newsletter') ? 'Channel' : 'Grup/PM';

            console.log(`[BOT ${BOT_ID}] 🔍 Mendeteksi ${mediaType} dari ${sourceInfo}...`);

            downloadMedia(mediaMsg, mediaType).then(buffer => {
                detectQR(buffer).then(qrData => {
                    if (qrData) {
                        if (VALID_DOMAINS.test(qrData)) {
                            if (qrData.includes('qr.dana.id') || qrData.includes('link.dana.id/minta')) return;
                            console.log(`[BOT ${BOT_ID}] ✅ QR Valid Dieksekusi dari ${sourceInfo}`);
                            sendOnce(qrData, imageMsg ? 'Gambar QR' : 'Stiker QR');
                        }
                    }
                }).catch(() => {});
            }).catch(() => {});
        }
    });

    sock.ev.on('groups.update', updates => {
        for (const update of updates) {
            if (update.desc) extractUrls(update.desc.toString()).forEach(url => sendOnce(url, 'Deskripsi Grup'));
        }
    });
}

startBot();

// ================= AUTO RESTART (3 JAM SEKALI) =================
// Keterangan bot akan ditampilkan dan direstart otomatis
setInterval(() => {
    console.log(`[BOT ${BOT_ID}] ♻️ Melakukan Auto-Restart rutin 3 jam sekali...`);
    process.exit(1); 
}, 3 * 60 * 60 * 1000);

process.on('unhandledRejection', () => { });
process.on('uncaughtException', () => process.exit(1));