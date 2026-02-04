const { checkWeatherAlerts, getCurrentSMNAlert } = require("./alerts/weather");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const net = require('net');
const fs = require("fs");

/* ===== CONFIG ===== */
const CALLSIGN = "LW7EEA-1";
const APRS_PASS = "19889";
const APRS_SERVER = "rotate.aprs2.net";
const APRS_PORT = 14580;
const CONTACTS_FILE = "./contacts.json";

/* ===== LOCKS ===== */
const LOCKED_DEST = {};     // APRS → WhatsApp { ORIGCALL: DESTCALL }
const WA_LOCKED_DEST = {};  // WhatsApp → APRS { chatId: CALLSIGN }

/* ===== TRACKING ACK ===== */
const sentMessages = {};
let CONTACTS = {};

/* ===== CONTACTOS ===== */
if (fs.existsSync(CONTACTS_FILE)) {
    try {
        CONTACTS = JSON.parse(fs.readFileSync(CONTACTS_FILE));
        console.log("📒 Agenda cargada:", CONTACTS);
    } catch {
        CONTACTS = {};
    }
}

function saveContacts() {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(CONTACTS, null, 2));
}

/* ===== WHATSAPP CLIENT ===== */
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: "/usr/bin/chromium-browser",
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--single-process",
            "--no-zygote"
        ]
    }
});


const WELCOME_MESSAGE =
`👋 Gateway APRS–WhatsApp LW7EEA
WhatsApp → APRS: @CALL mensaje
APRS → WhatsApp: @CALL mensaje | #NUM mensaje
LOCK: #LOCK CALL | #UNLOCK
Clima: #WX`;

/* ================= WHATSAPP → APRS ================= */
client.on('message', async message => {

    /* ===== LOCK WhatsApp ===== */
if (message.body.startsWith("#LOCK ")) {
    const dest = message.body.split(" ")[1]?.toUpperCase();

    // Validar CALLSIGN APRS, NO agenda
    if (!dest || !/^[A-Z0-9]{3,6}(-\d{1,2})?$/.test(dest)) {
        message.reply("❌ Uso: #LOCK CALLSIGN (ej: LW7EEA-7)");
        return;
    }

    WA_LOCKED_DEST[message.from] = dest;
    message.reply(`🔒 LOCK APRS activo → ${dest}`);
    return;
}


    if (message.body.trim() === "#UNLOCK") {
        delete WA_LOCKED_DEST[message.from];
        message.reply("🔓 LOCK desactivado");
        return;
    }

    /* ===== CLIMA ===== */
    if (message.body.trim().toUpperCase() === "#WX") {
        getCurrentSMNAlert(alert => {
            if (!alert) message.reply("🌤 Sin alertas SMN");
            else message.reply(`🌩 ALERTA SMN\n${alert.title}`);
        });
        return;
    }

    /* ===== MENSAJE CON LOCK ===== */
    const locked = WA_LOCKED_DEST[message.from];
    if (!message.body.startsWith("@") && !message.body.startsWith("#") && locked) {
        sendAPRS(locked.padEnd(9), message.body);
        message.reply("✅ Enviado");
        return;
    }

    if (!message.body.startsWith("@")) {
        message.reply(WELCOME_MESSAGE);
        return;
    }

    /* ===== @CALL ===== */
    const match = message.body.match(/^@([A-Z0-9\-]{3,9})\s+(.+)/i);
    if (!match) {
        message.reply("Formato inválido");
        return;
    }

    sendAPRS(match[1].toUpperCase().padEnd(9), match[2]);
    message.reply("✅ Enviado a APRS");
});



/* ================= APRS ================= */
let aprs;

function connectAPRS() {
    aprs = net.createConnection(APRS_PORT, APRS_SERVER, () => {
        aprs.write(`user ${CALLSIGN} pass ${APRS_PASS} vers WA-GATE 1.0\n`);
        console.log("📡 Conectado APRS-IS");
    });

    aprs.on('data', data => {
        data.toString().split("\n").forEach(raw => {
            const line = raw.trim();
            if (!line.includes(`::${CALLSIGN}`)) return;

            const from = line.split(">")[0];
            const msgPart = line.split(`::${CALLSIGN}`)[1];
            const text = msgPart?.split(":")[1]?.split("{")[0]?.trim();
            const msgId = msgPart?.match(/\{(\d+)$/)?.[1];

            if (!text) return;

            /* ===== LOCK APRS ===== */
            if (text.startsWith("#LOCK ")) {
                const dest = text.split(" ")[1]?.toUpperCase();
                if (!CONTACTS[dest]) {
                    sendAPRS(from, "❌ Alias inexistente");
                } else {
                    LOCKED_DEST[from] = dest;
                    sendAPRS(from, `🔒 LOCK → ${dest}`);
                }
                if (msgId) sendACK(from, msgId);
                return;
            }

            if (text === "#UNLOCK") {
                delete LOCKED_DEST[from];
                sendAPRS(from, "🔓 LOCK desactivado");
                if (msgId) sendACK(from, msgId);
                return;
            }

            /* ===== MENSAJE SIN COMANDO ===== */
            if (!text.startsWith("@") && !text.startsWith("#")) {
                const locked = LOCKED_DEST[from];
                if (!locked) {
                    sendAPRS(from, WELCOME_MESSAGE);
                    if (msgId) sendACK(from, msgId);
                    return;
                }

                const phone = CONTACTS[locked];
                const chatId = "549" + phone.replace(/^549?/, "") + "@c.us";

                client.sendMessage(chatId, `📡 APRS ${from}:\n${text}`)
                    .then(m => sentMessages[m.id._serialized] = { from });

                if (msgId) sendACK(from, msgId);
                return;
            }

            /* ===== @CALL ===== */
            if (text.startsWith("@")) {
                const parts = text.substring(1).split(" ");
                const alias = parts.shift().toUpperCase();
                const phone = CONTACTS[alias];
                if (!phone) {
                    sendAPRS(from, "❌ Alias inexistente");
                    if (msgId) sendACK(from, msgId);
                    return;
                }

                const chatId = "549" + phone.replace(/^549?/, "") + "@c.us";
                const msg = parts.join(" ");

                client.sendMessage(chatId, `📡 APRS ${from}:\n${msg}`)
                    .then(m => sentMessages[m.id._serialized] = { from });

                if (msgId) sendACK(from, msgId);
            }
        });
    });
}

/* ===== APRS UTILS ===== */
function sendAPRS(dest, text) {
    const packet = `${CALLSIGN}>APRS::${dest}:${text.substring(0,67)}\n`;
    aprs.write(packet);
    console.log("📤 APRS:", packet.trim());
}

function sendACK(dest, id) {
    aprs.write(`${CALLSIGN}>APRS::${dest.padEnd(9)}:ack${id}\n`);
}

/* ===== START ===== */
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => {
    console.log("✅ WhatsApp listo");
    connectAPRS();
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

function broadcastAPRS(text) {
    Object.keys(CONTACTS).forEach(call => {
        sendAPRS(call.padEnd(9), text);
    });
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
//LOCK
            if (text.startsWith("#LOCK ")) {
    const dest = text.split(" ")[1]?.toUpperCase();

    if (!dest || !/^[A-Z0-9\-]{3,9}$/.test(dest)) {
        sendAPRS(from, "Uso: #LOCK CALLSIGN");
        if (msgId) sendACK(from, msgId);
        continue;
    }

    LOCKED_DEST[from] = dest;
    sendAPRS(from, `🔒 LOCK activado → ${dest}`);
    if (msgId) sendACK(from, msgId);
    continue;
}
if (text === "#UNLOCK") {
    if (!LOCKED_DEST[from]) {
        sendAPRS(from, "🔓 No hay LOCK activo");
    } else {
        delete LOCKED_DEST[from];
        sendAPRS(from, "🔓 LOCK desactivado");
    }
    if (msgId) sendACK(from, msgId);
    continue;
}
//LOCK

            // ===== MENSAJE SIN COMANDO =====
// ===== MENSAJE DIRECTO O CON LOCK =====
if (!text.startsWith("#") && !text.startsWith("@")) {

    // ¿Hay LOCK activo?
    const locked = LOCKED_DEST[from];

    if (!locked) {
        sendAPRS(from, WELCOME_MESSAGE);
        if (msgId) sendACK(from, msgId);
        continue;
    }

    // Enviar como si fuera @DEST mensaje
    const phone = CONTACTS[locked];
    if (!phone) {
        sendAPRS(from, `❌ Alias ${locked} no encontrado`);
        delete LOCKED_DEST[from];
        if (msgId) sendACK(from, msgId);
        continue;
    }

    let phoneFull = phone;
    if (!phoneFull.startsWith("54")) phoneFull = "549" + phoneFull;
    const chatId = phoneFull + "@c.us";

    console.log("🔒 LOCK APRS → WhatsApp:", locked, text);

    client.sendMessage(
        chatId,
        `📡 Mensaje recibido vía APRS (${from}):\n*${text}*`
    ).then(sentMsg => {
        sentMessages[sentMsg.id._serialized] = { aprsFrom: from, text };
    });

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
