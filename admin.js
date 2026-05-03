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

        if (from.endsWith('@g.us')) {
            if (text === '!idgrup') {
                await adminSock.sendMessage(from, { text: `*ID Grup Ini:*\n${from}` }, { quoted: msg });
            }
            return; 
        }

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

        if (text === '!batal') {
            if (activeSetups.has(from)) {
                const setupData = activeSetups.get(from);
                await clearTrackingMessages(from);
                try { setupData.client.ws.close(); } catch (e) {} 
                activeSetups.delete(from);
                await adminSock.sendMessage(from, { text: '❌ Proses penambahan user dibatalkan.' });
            }
            return;
        }

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

            const folderName = `auth_info_bot${newBotId}`;

            // ========================================================
            // PERBAIKAN BUG: Hapus folder lama jika sisa gagal login
            // ========================================================
            if (fs.existsSync(folderName)) {
                console.log(`Menghapus sesi lama yang korup: ${folderName}`);
                fs.rmSync(folderName, { recursive: true, force: true });
            }

            const loadingMsg = await adminSock.sendMessage(from, { text: `⏳ Memproses sesi untuk *bot${newBotId}*...\nTunggu QR Code muncul.` });

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
                const { connection, qr, lastDisconnect } = update;
                const setupData = activeSetups.get(from);
                if (!setupData) return;

                if (qr) {
                    try {
                        if (setupData.lastQrKey) {
                            try { await adminSock.sendMessage(from, { delete: setupData.lastQrKey }); } catch(e) {}
                        }

                        const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                        
                        const qrMsg = await adminSock.sendMessage(from, { 
                            image: qrBuffer, 
                            caption: `*QR LOGIN: bot${newBotId}*\n\nSilakan scan menggunakan HP pelanggan.\n\n_(Ketik *!batal* jika ingin membatalkan)_` 
                        });
                        
                        setupData.lastQrKey = qrMsg.key;
                        setupData.messagesToDelete.push(qrMsg.key);
                    } catch (e) {
                        console.error('Gagal mengirim QR:', e);
                    }
                }

                // ========================================================
                // PERBAIKAN BUG: Jika Timeout / Gagal di tengah jalan
                // ========================================================
                if (connection === 'close') {
                    await clearTrackingMessages(from);
                    await adminSock.sendMessage(from, { text: `❌ Setup untuk *bot${newBotId}* gagal atau timeout.\nSilakan ulangi perintah *!tambahuser ${newBotId}*.` });
                    activeSetups.delete(from);
                    
                    // Bersihkan folder agar siap diulang
                    if (fs.existsSync(folderName)) {
                        fs.rmSync(folderName, { recursive: true, force: true });
                    }
                }

                if (connection === 'open') {
                    await clearTrackingMessages(from);
                    
                    const successMsg = `*✅ SUKSES LOGIN!*\nSesi untuk *bot${newBotId}* telah tersimpan aman di server.\n\nSekarang jalankan bot pelanggan di terminal VPS:\n\n*BOT_ID=${newBotId} pm2 start wabot.js --name "wabot-${newBotId}"*`;
                    
                    await adminSock.sendMessage(from, { text: successMsg });
                    
                    activeSetups.delete(from);
                    
                    setTimeout(() => {
                        try { setupSock.ws.close(); } catch(e) {}
                    }, 2000);
                }
            });
        }
    });
}

startAdminBot();