const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// ================= KONFIGURASI =================
const TARGET_GROUP_ID = '120363426296094605@g.us'; // Pastikan ini ID Grup tujuan Forward
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

const BOT_ID = String(process.env.BOT_ID || '1').replace(/[^a-zA-Z0-9_-]/g, '');
const SESSION_PATH = `auth_info_bot${BOT_ID}`;

let sock;

// ================= SISTEM CACHE REAL-TIME =================
const activeLinks = new Set();
const CACHE_TTL = 10000; 

function isDuplicate(link) {
    if (activeLinks.has(link)) return true;
    activeLinks.add(link);
    setTimeout(() => activeLinks.delete(link), CACHE_TTL);
    return false;
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

// ================= FUNGSI KIRIM =================
function sendOnce(text, label) {
    const key = text.trim();
    if (isDuplicate(key)) return;

    const msg = `${key}\n\nTipe: ${label}`;
    
    if (sock) {
        sock.sendMessage(TARGET_GROUP_ID, { text: msg }).catch(() => {});
    }
    resetWatchdog();
}

// ================= DETEKSI QR =================
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
        res = await decode(await baseImg.clone()
            .extract({ left: Math.floor((meta.width - cw1) / 2), top: Math.floor((meta.height - ch1) / 2), width: cw1, height: ch1 })
            .resize(cw1 * 2).greyscale().threshold(140).png().toBuffer());
        if (res) return res;

        const cw2 = Math.floor(meta.width * 0.45);
        const ch2 = Math.floor(meta.height * 0.4);
        res = await decode(await baseImg.clone()
            .extract({ left: Math.floor((meta.width - cw2) / 2), top: Math.floor((meta.height - ch2) / 2), width: cw2, height: ch2 })
            .resize(cw2 * 3).greyscale().linear(2, -100).png().toBuffer());
        return res;
    } catch (e) {
        console.error('\n[ERROR DETECT QR]', e);
        return null;
    }
}

// ================= DOWNLOAD MEDIA BAILEYS =================
async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
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
        getMessage: async () => ({ conversation: '' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Koneksi terputus, menyambung kembali...');
                setTimeout(startBot, 3000);
            } else {
                console.log(`⚠️ Sesi habis. Hapus folder ${SESSION_PATH} dan ulangi pendaftaran.`);
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log(`⚡ BOT ${BOT_ID} READY!`);
            resetWatchdog();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (!from || from === TARGET_GROUP_ID || !from.includes('@')) return;

        const timestamp = msg.messageTimestamp;
        if (timestamp < Math.floor(Date.now() / 1000) - 60) return;

        resetWatchdog();

        // ==========================================================
        // PERBAIKAN: BUKA BUNGKUSAN PESAN SEMENTARA (EPHEMERAL)
        // ==========================================================
        let msgObj = msg.message;
        
        // Membuka lapis demi lapis jika dibungkus oleh fitur WA
        if (msgObj.ephemeralMessage) msgObj = msgObj.ephemeralMessage.message;
        if (msgObj.viewOnceMessage) msgObj = msgObj.viewOnceMessage.message;
        if (msgObj.viewOnceMessageV2) msgObj = msgObj.viewOnceMessageV2.message;
        if (msgObj.viewOnceMessageV2Extension) msgObj = msgObj.viewOnceMessageV2Extension.message;
        if (msgObj.documentWithCaptionMessage) msgObj = msgObj.documentWithCaptionMessage.message;

        // 1. Ekstrak Teks
        const text = msgObj.conversation || msgObj.extendedTextMessage?.text || msgObj.imageMessage?.caption || msgObj.videoMessage?.caption || '';
        if (text) {
            extractUrls(text).forEach(url => sendOnce(url, 'Link'));
        }

        // 2. Ekstrak Media
        const imageMsg = msgObj.imageMessage;
        const stickerMsg = msgObj.stickerMessage;

        if (imageMsg || stickerMsg) {
            const mediaMsg = imageMsg || stickerMsg;
            const mediaType = imageMsg ? 'image' : 'sticker';

            console.log(`\n[MEDIA] Mendeteksi ${mediaType} baru...`);

            downloadMedia(mediaMsg, mediaType).then(buffer => {
                console.log(`[MEDIA] Download sukses. Memindai QR...`);
                detectQR(buffer).then(qrData => {
                    if (qrData) {
                        console.log(`[MEDIA] ✅ QR Terbaca: ${qrData}`);
                        if (VALID_DOMAINS.test(qrData)) {
                            const label = imageMsg ? 'Gambar QR' : 'Stiker QR';
                            sendOnce(qrData, label);
                        } else {
                            console.log(`[MEDIA] ❌ QR Diabaikan (Bukan Link Dana/Gopay/Shopee).`);
                        }
                    } else {
                        console.log(`[MEDIA] ❌ Tidak ditemukan QR Code pada ${mediaType} tersebut.`);
                    }
                }).catch(err => console.error('[MEDIA] ERROR saat memindai:', err));
            }).catch(err => console.error('[MEDIA] ERROR gagal download media:', err));
        }
    });

    sock.ev.on('groups.update', updates => {
        for (const update of updates) {
            if (update.desc) {
                extractUrls(update.desc.toString()).forEach(url => sendOnce(url, 'Deskripsi Grup'));
            }
        }
    });
}

startBot();

// ================= JADWAL OFF & ON =================
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

scheduleDailyTask(4, 50, () => {
    console.log(`[BOT ${BOT_ID}] OFF`);
    if (sock) sock.ws.close();
});

scheduleDailyTask(5, 0, () => {
    console.log(`[BOT ${BOT_ID}] ON kembali`);
    startBot();
});

// ================= WATCHDOG (AUTO-RESTART) =================
let lastActivityTime = Date.now();
const MAX_IDLE_TIME = 120 * 60 * 1000;

function resetWatchdog() {
    lastActivityTime = Date.now();
}

setInterval(() => {
    if (Date.now() - lastActivityTime > MAX_IDLE_TIME) {
        console.log(`[BOT ${BOT_ID}] ⚠️ Tidak ada aktivitas selama 120 menit. Melakukan auto-restart...`);
        process.exit(1); 
    }
}, 10 * 60 * 1000);

process.on('unhandledRejection', () => { });
process.on('uncaughtException', () => process.exit(1));