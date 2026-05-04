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

require('events').EventEmitter.defaultMaxListeners = 0;

// ================= CONFIG =================
const PRIMARY_GROUP_ID = '120363408426078537@g.us';
const SECONDARY_GROUP_ID = '120363426296094605@g.us';

const ENABLE_FORWARD_TO_SECONDARY = true;

const CACHE_TTL_MINUTES = 5;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;
const BOT_ID = String(process.env.BOT_ID || '1').replace(/[^a-zA-Z0-9_-]/g, '');

const SESSION_PATH = `auth_info_bot${BOT_ID}`;
let sock;

// ================= TRACK AKTIVITAS =================
let lastForwardTime = Date.now();
function updateActivity() {
    lastForwardTime = Date.now();
}

// ================= ANTI DUPLIKAT =================
const HISTORY_DIR = path.join(__dirname, 'history_links');

if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
} else {
    try {
        const files = fs.readdirSync(HISTORY_DIR);
        for (const file of files) fs.unlinkSync(path.join(HISTORY_DIR, file));
    } catch {}
}

function isDuplicate(link) {
    const hash = crypto.createHash('md5').update(link).digest('hex');
    const historyFile = path.join(HISTORY_DIR, `${hash}.txt`);

    if (fs.existsSync(historyFile)) return true;

    try {
        const fd = fs.openSync(historyFile, 'wx');
        fs.closeSync(fd);

        setTimeout(() => {
            try { fs.unlinkSync(historyFile); } catch {}
        }, CACHE_TTL_MS);

        return false;
    } catch {
        return true;
    }
}

// ================= SEND INSTANT =================
function sendOnce(text, label) {
    const key = text.trim();
    if (isDuplicate(key)) return;

    const msg = `${key}\n\nTipe: ${label}`;

    if (sock) {
        // Eksekusi secara paralel tanpa delay
        sock.sendMessage(PRIMARY_GROUP_ID, { text: msg }).catch(() => {});
        
        if (ENABLE_FORWARD_TO_SECONDARY) {
            sock.sendMessage(SECONDARY_GROUP_ID, { text: msg }).catch(() => {});
        }

        updateActivity();
    }
}

// ================= EXTRACT URL =================
function extractUrls(text) {
    if (!text) return [];

    const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
    const matches = text.match(regex);
    if (!matches) return [];

    const results = [];

    for (let u of matches) {
        // Filter spesifik: abaikan /minta, ambil hanya yang mengandung kaget
        if (u.includes('/minta') || u.endsWith('dana.id') || u.endsWith('dana.id/')) continue;
        if (u.includes('dana.id') && !u.includes('kaget') && !u.includes('danakaget')) continue;

        results.push(u.startsWith('http') ? u : 'https://' + u);
    }

    return results;
}

// ================= QR DETECT =================
async function detectQR(buffer) {
    try {
        const baseImg = sharp(buffer).flatten({ background: '#ffffff' });
        const meta = await baseImg.metadata();

        const decode = async (buf) => {
            const image = await Jimp.read(buf);
            return new Promise((resolve, reject) => {
                const qr = new QrCode();
                qr.callback = (e, v) => (e || !v) ? reject() : resolve(v.result);
                qr.decode(image.bitmap);
            });
        };

        const cw = Math.floor(meta.width * 0.7);
        const ch = Math.floor(meta.height * 0.6);

        // Promise.any langsung mengembalikan hasil saat salah satu proses selesai, sangat cepat.
        const buffers = await Promise.all([
            baseImg.clone().png().toBuffer(),
            baseImg.clone().greyscale().linear(1.5, -50).png().toBuffer(),
            baseImg.clone().extract({ left: 0, top: 0, width: cw, height: ch }).resize(cw * 2).greyscale().threshold(140).png().toBuffer()
        ]);

        return await Promise.any(buffers.map(decode));

    } catch {
        return null;
    }
}

// ================= DOWNLOAD MEDIA =================
async function downloadMedia(mediaMsg, type) {
    if (mediaMsg.mediaKey) {
        const stream = await downloadContentFromMessage(mediaMsg, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    }

    const url = mediaMsg.url || (mediaMsg.directPath ? `https://mmg.whatsapp.net${mediaMsg.directPath}` : null);

    return new Promise((resolve, reject) => {
        https.get(url, res => {
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
}

// ================= CORE BOT =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Log disenyapkan untuk mencegah output sampah
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
            const reason = lastDisconnect?.error?.output?.statusCode;

            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            } else {
                process.exit(1);
            }

        } else if (connection === 'open') {
            console.log(`⚡ BOT ${BOT_ID} READY (ULTRA FAST - NO DELAY)`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (!from || from === PRIMARY_GROUP_ID || from === SECONDARY_GROUP_ID) return;

        let m = msg.message;

        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;

        const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';

        if (text) extractUrls(text).forEach(url => sendOnce(url, 'Link'));

        const media = m.imageMessage || m.stickerMessage;

        if (media) {
            const typeMedia = m.imageMessage ? 'image' : 'sticker';

            (async () => {
                try {
                    const buffer = await downloadMedia(media, typeMedia);

                    detectQR(buffer).then(qr => {
                        if (qr && VALID_DOMAINS.test(qr)) {
                            if (qr.includes('qr.dana.id') || qr.includes('/minta')) return;
                            sendOnce(qr, typeMedia === 'image' ? 'Gambar QR' : 'Stiker QR');
                        }
                    }).catch(() => {});

                } catch {}
            })();
        }
    });

    sock.ev.on('groups.update', updates => {
        for (const u of updates) {
            if (u.desc) extractUrls(u.desc.toString()).forEach(url => sendOnce(url, 'Deskripsi Grup'));
        }
    });
}

startBot();

// ================= PENJADWALAN & AUTO RESTART =================
const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;
let lastActionDay = '';

setInterval(() => {
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes();
    const day = now.getDate();

    // 1. Cek Jadwal OFF (04:50)
    if (hh === 4 && mm === 50 && lastActionDay !== `${day}-off`) {
        console.log(`♻️ [JADWAL] Mematikan bot (04:50) untuk stabilitas sesi...`);
        lastActionDay = `${day}-off`;
        if (sock) {
            try { sock.ws.close(); } catch {}
        }
    }

    // 2. Cek Jadwal ON (06:00)
    if (hh === 6 && mm === 0 && lastActionDay !== `${day}-on`) {
        console.log(`⚡ [JADWAL] Menghidupkan ulang bot (06:00)...`);
        lastActionDay = `${day}-on`;
        startBot();
    }

    // 3. Cek Idle Restart
    const idle = Date.now() - lastForwardTime;
    if (idle > IDLE_LIMIT_MS && (hh < 4 || hh >= 6)) { // Jangan tabrakan dengan jadwal OFF
        console.log(`♻️ BOT ${BOT_ID} RESTART (IDLE)`);
        try { if (sock) sock.ws.close(); } catch {}
        setTimeout(() => startBot(), 3000);
        updateActivity(); // Reset idle time agar tidak looping
    }

}, 30 * 1000); // Cek setiap 30 detik

// ================= ERROR HANDLER =================
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => process.exit(1));