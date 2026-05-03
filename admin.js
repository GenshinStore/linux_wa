const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Menyimpan proses pembuatan bot (menghindari duplikasi)
const activeSetups = new Map();

let adminSock; // Socket untuk bot admin utama

// Fungsi untuk menghapus pesan pelacakan (Loading & QR lama)
async function clearTrackingMessages(chatId) {
    const setupData = activeSetups.get(chatId);
    if (!setupData) return;
    
    for (const msgKey of setupData.messagesToDelete) {
        try { await adminSock.sendMessage(chatId, { delete: msgKey }); } catch (e) {}
    }
}

async function startAdminBot() {
    // Folder sesi untuk bot Admin
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_admin');
    const { version } = await fetchLatestBaileysVersion();

    adminSock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['BotAdmin', 'Chrome', '1.0.0'],
        getMessage: async () => ({ conversation: '' })
    });

    adminSock.ev.on('creds.update', saveCreds);

    adminSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Menampilkan QR Admin di Terminal VPS
        if (qr) {
            console.log('\n==================================================');
            console.log('SCAN QR DI BAWAH INI UNTUK LOGIN SEBAGAI ADMIN BOT');
            console.log('==================================================');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Koneksi Admin terputus, menyambung kembali...');
                setTimeout(startAdminBot, 3000);
            } else {
                console.log('⚠️ Sesi Admin habis. Hapus folder auth_info_admin dan scan ulang.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('✅ BOT ADMIN READY! (Menunggu perintah di WhatsApp)');
        }
    });

    adminSock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        if (!text) return;

        // --- FITUR BARU: CEK ID GRUP (Hanya merespon di dalam grup) ---
        if (from.endsWith('@g.us')) {
            if (text === '!idgrup') {
                await adminSock.sendMessage(from, { text: `*ID Grup Ini:*\n${from}` }, { quoted: msg });
            }
            return; // Abaikan pesan grup lainnya agar admin tidak nyepam
        }

        // ==============================================================
        // MULAI DARI SINI HANYA MERESPON PESAN JAPRI (PERSONAL MESSAGE)
        // ==============================================================

        // --- FITUR BARU: LIST SEMUA GRUP ---
        if (text === '!listgrup') {
            try {
                const groups = await adminSock.groupFetchAllParticipating();
                const groupKeys = Object.keys(groups);

                if (groupKeys.length === 0) {
                    await adminSock.sendMessage(from, { text: 'Bot admin belum bergabung di grup mana pun.' });
                    return;
                }

                let replyMsg = '*DAFTAR GRUP & ID*\n\n';
                groupKeys.forEach((jid, index) => {
                    replyMsg += `${index + 1}. *${groups[jid].subject}*\nID: ${jid}\n\n`;
                });

                await adminSock.sendMessage(from, { text: replyMsg });
            } catch (err) {
                await adminSock.sendMessage(from, { text: '❌ Gagal mengambil daftar grup.' });
            }
            return;
        }

        // --- FITUR: BATALKAN SETUP ---
        if (text === '!batal') {
            if (activeSetups.has(from)) {
                const setupData = activeSetups.get(from);
                await clearTrackingMessages(from);
                try { setupData.client.ws.close(); } catch (e) {} // Tutup websocket tanpa logout
                activeSetups.delete(from);
                await adminSock.sendMessage(from, { text: '❌ Proses penambahan user dibatalkan.' });
            }
            return;
        }

        // --- FITUR UTAMA: TAMBAH USER / KLIEN BARU ---
        if (text.startsWith('!tambahuser')) {
            if (activeSetups.has(from)) {
                await adminSock.sendMessage(from, { text: '⚠️ Selesaikan atau ketik *!batal* pada proses sebelumnya terlebih dahulu.' });
                return;
            }

            const parts = text.split(' ');
            const newBotId = parts[1] ? parts[1].replace('bot', '') : null;

            if (!newBotId) {
                await adminSock.sendMessage(from, { text: '❌ Format: !tambahuser <angka/id>\nContoh: !tambahuser 2' });
                return;
            }

            // Kirim pesan loading dan simpan kuncinya untuk dihapus nanti
            const loadingMsg = await adminSock.sendMessage(from, { text: `⏳ Memproses sesi untuk *bot${newBotId}*...\nTunggu QR Code muncul.` });

            // Inisiasi sesi untuk klien baru
            const folderName = `auth_info_bot${newBotId}`;
            const { state: clientState, saveCreds: clientSaveCreds } = await useMultiFileAuthState(folderName);

            const setupSock = makeWASocket({
                version,
                auth: clientState,
                logger: pino({ level: 'silent' }),
                browser: [`Setup Bot ${newBotId}`, 'Chrome', '1.0.0'],
                getMessage: async () => ({ conversation: '' })
            });

            setupSock.ev.on('creds.update', clientSaveCreds);

            activeSetups.set(from, {
                client: setupSock,
                messagesToDelete: [loadingMsg.key],
                lastQrKey: null
            });

            setupSock.ev.on('connection.update', async (update) => {
                const { connection, qr } = update;
                const setupData = activeSetups.get(from);
                if (!setupData) return;

                // Jika Baileys menghasilkan QR baru
                if (qr) {
                    try {
                        // Hapus QR lama jika ada (mencegah nyepam chat)
                        if (setupData.lastQrKey) {
                            try { await adminSock.sendMessage(from, { delete: setupData.lastQrKey }); } catch(e) {}
                        }

                        // Ubah teks QR menjadi Gambar (Buffer)
                        const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                        
                        // Kirim gambar QR ke Admin
                        const qrMsg = await adminSock.sendMessage(from, { 
                            image: qrBuffer, 
                            caption: `*QR LOGIN: bot${newBotId}*\n\nSilakan kirim gambar ini ke pelanggan, atau langsung scan menggunakan HP pelanggan.\n\n_(Ketik *!batal* jika ingin membatalkan)_` 
                        });
                        
                        setupData.lastQrKey = qrMsg.key;
                        setupData.messagesToDelete.push(qrMsg.key);
                    } catch (e) {
                        console.error('Gagal mengirim QR:', e);
                    }
                }

                // JIKA KLIEN BERHASIL SCAN QR
                if (connection === 'open') {
                    await clearTrackingMessages(from);
                    
                    const successMsg = `*✅ SUKSES LOGIN!*\nSesi untuk *bot${newBotId}* telah tersimpan aman di server.\n\nSekarang Anda bisa menjalankan bot pelanggan tersebut di terminal VPS dengan perintah:\n\n*BOT_ID=${newBotId} pm2 start index.js --name "wabot-${newBotId}"*`;
                    
                    await adminSock.sendMessage(from, { text: successMsg });
                    
                    activeSetups.delete(from);
                    
                    // Tutup koneksi setup secara halus (TANPA LOGOUT) agar sesi aman
                    setTimeout(() => {
                        try { setupSock.ws.close(); } catch(e) {}
                    }, 2000);
                }
            });
        }
    });
}

// Mulai jalankan Admin Bot
startAdminBot();