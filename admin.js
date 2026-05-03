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

            // Hapus folder lama jika sisa gagal login sebelumnya
            if (fs.existsSync(folderName)) {
                fs.rmSync(folderName, { recursive: true, force: true });
            }

            const loadingMsg = await adminSock.sendMessage(from, { text: `⏳ Memproses sesi untuk *bot${newBotId}*...\nTunggu QR Code muncul.` });

            // Simpan state awal untuk setup
            activeSetups.set(from, {
                client: null,
                messagesToDelete: [loadingMsg.key],
                lastQrKey: null,
                qrCount: 0 // Menghitung berapa kali QR direfresh
            });

            // Fungsi Auto-Reconnect jika putus di tengah scan
            async function connectSetupSocket(retryCount = 0) {
                // Jika sudah diretry 4 kali tetap gagal, baru dibatalkan
                if (retryCount > 3) {
                    await clearTrackingMessages(from);
                    await adminSock.sendMessage(from, { text: `❌ Setup timeout setelah beberapa kali percobaan.\nSilakan ulangi *!tambahuser ${newBotId}*.` });
                    activeSetups.delete(from);
                    if (fs.existsSync(folderName)) fs.rmSync(folderName, { recursive: true, force: true });
                    return;
                }

                const { state: clientState, saveCreds: clientSaveCreds } = await useMultiFileAuthState(folderName);

                const setupSock = makeWASocket({
                    version,
                    auth: clientState,
                    logger: pino({ level: 'silent' }),
                    browser: [`Atmojo ${newBotId}`, 'Chrome', '1.0.0'],
                    getMessage: async () => ({ conversation: '' }),
                    connectTimeoutMs: 60000,
                    keepAliveIntervalMs: 10000
                });

                const setupData = activeSetups.get(from);
                if (setupData) setupData.client = setupSock;

                setupSock.ev.on('creds.update', clientSaveCreds);

                setupSock.ev.on('connection.update', async (update) => {
                    const { connection, qr, lastDisconnect } = update;
                    const currentSetup = activeSetups.get(from);
                    
                    if (!currentSetup) return; // Jika user sudah ketik !batal

                    if (qr) {
                        try {
                            // Hapus QR lama sebelum kirim yang baru
                            if (currentSetup.lastQrKey) {
                                try { await adminSock.sendMessage(from, { delete: currentSetup.lastQrKey }); } catch(e) {}
                            }
                            
                            currentSetup.qrCount++;
                            const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                            
                            const qrMsg = await adminSock.sendMessage(from, { 
                                image: qrBuffer, 
                                caption: `*QR LOGIN: bot${newBotId}* (Refresh ke-${currentSetup.qrCount})\n\nSilakan scan QR ini. QR akan berganti otomatis jika expired agar tidak gagal.\n_(Ketik *!batal* jika ingin membatalkan)_` 
                            });
                            
                            currentSetup.lastQrKey = qrMsg.key;
                            currentSetup.messagesToDelete.push(qrMsg.key);
                        } catch (e) {
                            console.error('Gagal mengirim QR:', e);
                        }
                    }

                    if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        
                        // Jika koneksi putus tapi BUKAN karena logout/ditolak, lakukan reconnect otomatis
                        if (statusCode !== DisconnectReason.loggedOut) {
                            console.log(`[bot${newBotId}] Koneksi drop sementara. Auto-reconnect...`);
                            setTimeout(() => connectSetupSocket(retryCount + 1), 2000);
                        } else {
                            // Jika ditolak/logout baru dibatalkan
                            await clearTrackingMessages(from);
                            await adminSock.sendMessage(from, { text: `❌ Setup dibatalkan atau ditolak perangkat.` });
                            activeSetups.delete(from);
                            if (fs.existsSync(folderName)) fs.rmSync(folderName, { recursive: true, force: true });
                        }
                    }

                    if (connection === 'open') {
                        await clearTrackingMessages(from);
                        const successMsg = `*✅ SUKSES LOGIN!*\nSesi untuk *bot${newBotId}* telah tersimpan aman.\n\nJalankan bot pelanggan di terminal VPS:\n*BOT_ID=${newBotId} pm2 start wabot.js --name "wabot-${newBotId}"*`;
                        
                        await adminSock.sendMessage(from, { text: successMsg });
                        activeSetups.delete(from);
                        
                        setTimeout(() => {
                            try { setupSock.ws.close(); } catch(e) {}
                        }, 2000);
                    }
                });
            }

            // Panggil fungsi setup
            connectSetupSocket();
        }
    });
}

startAdminBot();