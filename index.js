const { checkWeatherAlerts, getCurrentSMNAlert } = require("./alerts/weather");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const net = require('net');
const fs = require("fs");

const ZONA = "Bahía Blanca";
const CALLSIGN = "LW7EEA-1";
const APRS_PASS = "19889";
const APRS_SERVER = "rotate.aprs2.net";
const APRS_PORT = 14580;
const CONTACTS_FILE = "./contacts.json";

// ===== TRACKING DE MENSAJES WA (ACK) =====
const sentMessages = {};
let CONTACTS = {};

// Cargar contactos
if (fs.existsSync(CONTACTS_FILE)) {
    try {
        CONTACTS = JSON.parse(fs.readFileSync(CONTACTS_FILE));
        console.log("📒 Agenda cargada:", CONTACTS);
    } catch (e) {
        console.log("❌ Error leyendo contacts.json");
        CONTACTS = {};
    }
} else {
    CONTACTS = { "LW2EDM": "2916450825" };
}

function saveContacts() {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(CONTACTS, null, 2));
}

const BLOCKED_IDS = [];

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium-browser',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

const WELCOME_MESSAGE =
    "👋 Gateway APRS–WhatsApp LW7EEA\n" +
    "Enviar: @CALL mensaje | #NUM mensaje\n" +
    "Alias: #SET CALL NUM | #RM CALL\n" +
    "Clima: #WX (Alertas SMN)";

let aprs;

// ================= Mensajes WhatsApp → APRS =================
client.on('message', async message => {
    // ===== COMANDO #WX (WhatsApp) =====
    if (message.body.trim().toUpperCase() === "#WX") {
        getCurrentSMNAlert(alert => {
            if (!alert) {
                message.reply("🌤 SMN: sin alertas meteorológicas vigentes");
            } else {
                message.reply(
                    `🌩 ALERTA SMN (ACP) Zona: ${ZONA} ${alert.title} ${alert.description.substring(0, 700)}`
                );
            }
        });
        return;
    }

    console.log("MENSAJE RECIBIDO", message.from, message.body);

    if (BLOCKED_IDS.includes(message.from)) {
        message.reply("🚫 Estás bloqueado en este gateway APRS");
        return;
    }

    if (message.body.trim().toUpperCase() === "#HELP" || !message.body.startsWith("@")) {
        message.reply(WELCOME_MESSAGE);
        const fromWA = message.from.replace("@c.us", "");
        sendAPRS(fromWA, WELCOME_MESSAGE);
        return;
    }

    if (!message.body.startsWith("@")) return;

    const match = message.body.match(/^@([A-Z0-9\-]{3,9})\s+(.+)/i);
    if (!match) {
        message.reply("❌ Formato inválido. Usá: @CALLSIGN mensaje");
        return;
    }

    const dest = match[1].toUpperCase();
    const text = match[2].substring(0, 67);

    let fromWA = message.from.replace("@c.us", "");
    let contact = await client.getContactById(message.from);
    let senderName = CONTACTS[fromWA] || contact.pushname || fromWA;

    const aprsText = `Mensaje de ${senderName}: ${text}`;
    const packet = `${CALLSIGN}>APRS::${dest.padEnd(9)}:${aprsText.substring(0, 67)}\n`;

    console.log("📡 ENVIANDO A APRS:", packet.trim());
    if (aprs) aprs.write(packet);

    message.reply("✅ Enviado a APRS");
});

// ================= QR y Ready =================
client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
    console.log("WhatsApp conectado");
    connectAPRS();

    setInterval(() => {
        checkWeatherAlerts(
            msg => {
                // WhatsApp broadcast (admin o lista)
                client.sendMessage("549XXXXXXXXX@c.us", msg);
            },
            msg => {
                sendAPRS("ALL", msg);
            }
        );
    }, 10 * 60 * 1000);
});

client.initialize();

// ===== ACK WhatsApp → APRS =====
client.on('message_ack', (msg, ack) => {
    const id = msg.id?._serialized;
    if (!id || !sentMessages[id]) return;

    const info = sentMessages[id];

    // ENTREGADO
    if (ack === 2) {
        sendAPRS(info.aprsFrom, "✔ Mensaje ENTREGADO en WhatsApp");
    }

    // LEÍDO (experimental)
    if (ack === 3) {
        sendAPRS(info.aprsFrom, "✔✔ Mensaje LEÍDO en WhatsApp");
        delete sentMessages[id]; // limpieza
    }
});

// ================= APRS =================
function sendAPRS(dest, text) {
    if (!aprs) return;
    const cleanText = text.replace(/\n/g, " ").trim();
    const packet = `${CALLSIGN}>APRS::${dest}:${cleanText}\n`;
    aprs.write(packet);
    console.log("📤 APRS OUT:", packet.trim());
}

function sendACK(dest, id) {
    if (!id || !aprs) return;
    const packet = `${CALLSIGN}>APRS::${dest.padEnd(9)}:ack${id}\n`;
    aprs.write(packet);
    console.log("✅ ACK:", packet.trim());
}

function connectAPRS() {
    aprs = net.createConnection(APRS_PORT, APRS_SERVER, () => {
        console.log("Conectado a APRS-IS");
        aprs.write(`user ${CALLSIGN} pass ${APRS_PASS} vers WA-GATE 1.0\n`);
    });

    aprs.on('data', data => {
        const lines = data.toString().split("\n");
        for (let raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith("#") || !line.includes(`::${CALLSIGN}`)) continue;

            const from = line.split(">")[0];
            const msgPart = line.split(`::${CALLSIGN}`)[1];
            if (!msgPart) continue;

            const ackMatch = msgPart.match(/\{(\d+)$/);
            const msgId = ackMatch ? ackMatch[1] : null;
            let text = msgPart.split(":")[1]?.trim();
            if (!text) continue;

            text = text.split("{")[0].trim();

            // ===== COMANDOS DE AGENDA =====
            if (text.startsWith("#SET ")) {
                const parts = text.split(" ");
                const call = parts[1]?.toUpperCase();
                let phone = parts[2];

                if (!call || !phone) {
                    sendAPRS(from, "Uso: #SET CALLSIGN NUMERO");
                    sendACK(from, msgId);
                    continue;
                }

                if (!phone.startsWith("54")) phone = "549" + phone;
                if (!/^\d{11,15}$/.test(phone)) {
                    sendAPRS(from, "Número inválido");
                    sendACK(from, msgId);
                    continue;
                }

                CONTACTS[call] = phone;
                saveContacts();
                sendAPRS(from, `✔ ${call} → ${phone} guardado`);
                sendACK(from, msgId);
                continue;
            }

            if (text.startsWith("#RM ")) {
                const call = text.split(" ")[1]?.toUpperCase();
                if (!call || !CONTACTS[call]) {
                    sendAPRS(from, `❌ ${call || ""} no existe`);
                    sendACK(from, msgId);
                    continue;
                }
                delete CONTACTS[call];
                saveContacts();
                sendAPRS(from, `🗑 ${call} eliminado`);
                sendACK(from, msgId);
                continue;
            }

            if (text === "#LIST") {
                const keys = Object.keys(CONTACTS);
                if (keys.length === 0) sendAPRS(from, "📒 Agenda vacía");
                else sendAPRS(from, `📒 Contactos: ${keys.join(", ").substring(0, 60)}`);
                sendACK(from, msgId);
                continue;
            }

            // ===== MENSAJE SIN COMANDO =====
            if (!text.startsWith("#") && !text.startsWith("@")) {
                sendAPRS(from, WELCOME_MESSAGE);
                if (msgId) sendACK(from, msgId);
                continue;
            }

            // ===== COMANDOS APRS =====
            if (text === "#HELP" || text === "#START") {
                sendAPRS(from, WELCOME_MESSAGE);
                if (msgId) sendACK(from, msgId);
                continue;
            }

            // ===== COMANDO #WX (APRS) =====
            if (text === "#WX") {
                getCurrentSMNAlert(alert => {
                    if (!alert) sendAPRS(from, "🌤 SMN: sin alertas meteorológicas");
                    else sendAPRS(from, `🌩 SMN ACP ${alert.title.substring(0, 67)}`);
                    if (msgId) sendACK(from, msgId);
                });
                continue;
            }

            // ===== MENSAJES APRS → WHATSAPP =====
            if (text.startsWith("#")) {
                const parts = text.substring(1).split(" ");
                let target = parts[0].toUpperCase();
                let phone = CONTACTS[target] || target;
                if (!phone.startsWith("54")) phone = "549" + phone;

                const msg = parts.slice(1).join(" ").trim();
                if (!/^\d{10,15}$/.test(phone)) continue;

                const chatId = phone + "@c.us";
                console.log("📤 APRS → WhatsApp:", chatId, msg);

                client.sendMessage(
                    chatId,
                    `📡 Mensaje recibido vía APRS (${from}):\n*${msg}*`
                ).then(sentMsg => {
                    sentMessages[sentMsg.id._serialized] = { aprsFrom: from, text: msg };
                });

                if (msgId) sendACK(from, msgId);
                continue;
            }

            if (text.startsWith("@")) {
                const parts = text.substring(1).split(" ");
                const alias = parts[0].toUpperCase();
                const msg = parts.slice(1).join(" ").trim();
                const phone = CONTACTS[alias];

                if (!phone) {
                    sendAPRS(from, `❌ Alias ${alias} no encontrado`);
                    sendACK(from, msgId);
                    continue;
                }

                let phoneFull = phone;
                if (!phoneFull.startsWith("54")) phoneFull = "549" + phoneFull;
                const chatId = phoneFull + "@c.us";

                console.log("📤 APRS → WhatsApp:", chatId, msg);
                client.sendMessage(
                    chatId,
                    `📡 Mensaje recibido vía APRS (${from}):\n*${msg}*`
                ).then(sentMsg => {
                    sentMessages[sentMsg.id._serialized] = { aprsFrom: from, text: msg };
                });

                 if (msgId) sendACK(from, msgId);
                continue;
            }
        }
    });

    aprs.on('error', err => console.log("APRS error:", err));
}

