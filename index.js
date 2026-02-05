const { checkWeatherAlerts, getCurrentSMNAlert } = require("./alerts/weather");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const net = require("net");
const fs = require("fs");

/* ===== CONFIG ===== */
const CALLSIGN = "LW7EEA-1";
const APRS_PASS = "19889";
const APRS_SERVER = "rotate.aprs2.net";
const APRS_PORT = 14580;
const CONTACTS_FILE = "./contacts.json";

/* ===== LOCKS ===== */
const LOCKED_DEST = {};      // APRS → WhatsApp { ORIGCALL: DESTCALL }
const WA_LOCKED_DEST = {};   // WhatsApp → APRS { chatId: CALLSIGN }

/* ===== TRACKING ACK ===== */
const sentMessages = {};

/* ===== CONTACTOS ===== */
let CONTACTS = {};

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
        //    "--single-process",
         //   "--no-zygote"
        ]
    }
});

const WELCOME_MESSAGE =
    "👋 Gateway APRS–WhatsApp LW7EEA." +
    "WhatsApp → APRS: @CALL-SSID mensaje" +
    "APRS → WhatsApp: @CALL msj ó #NUM msj" +
    "LOCK: #LOCK CALL | #UNLOCK" +
    "Clima: #WX";

/* ================= WHATSAPP → APRS ================= */
client.on("message", async message => {

    /* ===== LOCK WhatsApp ===== */
    if (message.body.startsWith("#LOCK ")) {
        const dest = message.body.split(" ")[1]?.toUpperCase();

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

/* ===== APRS UTILS ===== */
// function sendAPRS(dest, text) {
//     if (!aprs) return;
//     const cleanText = text.replace(/\n/g, " ").trim();
//     const packet = `${CALLSIGN}>APRS::${dest}:${cleanText}\n`;
//     aprs.write(packet);
//     console.log("📤 APRS OUT:", packet.trim());
// }

function sendAPRS(dest, text) {
    const packet = `${CALLSIGN}>APRS::${dest}:${text}\n`;
    aprs.write(packet);
    console.log("📤 APRS:", packet.trim());
}

function sendACK(dest, id) {
    if (!id || !aprs) return;
    const packet = `${CALLSIGN}>APRS::${dest.padEnd(9)}:ack${id}\n`;
    aprs.write(packet);
    console.log("✅ ACK:", packet.trim());
}

/* ===== START ===== */
client.on("qr", qr => qrcode.generate(qr, { small: true }));

client.on("ready", () => {
    console.log("✅ WhatsApp listo");
    connectAPRS();
});

client.initialize();

/* ===== ACK WhatsApp → APRS ===== */
client.on("message_ack", (msg, ack) => {
    const id = msg.id?._serialized;
    if (!id || !sentMessages[id]) return;

    const info = sentMessages[id];

    if (ack === 2) {
        sendAPRS(info.aprsFrom, "✔ Mensaje ENTREGADO en WhatsApp");
    }

    if (ack === 3) {
        sendAPRS(info.aprsFrom, "✔✔ Mensaje LEÍDO en WhatsApp");
        delete sentMessages[id];
    }
});

/* ================= APRS ================= */
function connectAPRS() {
    aprs = net.createConnection(APRS_PORT, APRS_SERVER, () => {
        console.log("📡 Conectado a APRS-IS");
        aprs.write(`user ${CALLSIGN} pass ${APRS_PASS} vers WA-GATE 1.0\n`);
    });

    aprs.on("error", err => console.log("APRS error:", err));

    aprs.on("data", data => {
        data.toString().split("\n").forEach(raw => {
            const line = raw.trim();
            if (!line || !line.includes(`::${CALLSIGN}`)) return;

            const from = line.split(">")[0];
            const msgPart = line.split(`::${CALLSIGN}`)[1];
            if (!msgPart) return;

            const msgId = msgPart.match(/\{(\d+)$/)?.[1];
            let text = msgPart.split(":")[1]?.split("{")[0]?.trim();
            if (!text) return;

            if (handleAgenda(from, text, msgId)) return;
            if (handleLock(from, text, msgId, LOCKED_DEST)) return;
            if (handleHelp(from, text, msgId)) return;
            if (handleWX(from, text, msgId)) return;

            aprsToWA(from, text, msgId);
        });
    });
}

/* ===== FUNCIONES AUXILIARES ===== */
function handleAgenda(from, text, msgId) {
    if (text.startsWith("#SET ")) {
        const [_, call, phoneRaw] = text.split(" ");
        if (!call || !phoneRaw) {
                        sendACK(from, msgId);

            sendAPRS(from, "Uso: #SET CALLSIGN NUMERO");
            return true;
        }

        let phone = phoneRaw.startsWith("54") ? phoneRaw : "549" + phoneRaw;
        if (!/^\d{11,15}$/.test(phone)) {
                        sendACK(from, msgId);

            sendAPRS(from, "Número inválido");
            return true;
        }

        CONTACTS[call.toUpperCase()] = phone;
        saveContacts();
                sendACK(from, msgId);

        sendAPRS(from, `✔ ${call.toUpperCase()} → ${phone} guardado`);
        return true;
    }

    if (text.startsWith("#RM ")) {
        const call = text.split(" ")[1]?.toUpperCase();
        if (!call || !CONTACTS[call]) {
                        sendACK(from, msgId);

            sendAPRS(from, `❌ ${call || ""} no existe`);
            return true;
        }

        delete CONTACTS[call];
        saveContacts();
                sendACK(from, msgId);

        sendAPRS(from, `🗑 ${call} eliminado`);
        return true;
    }

    if (text === "#LIST") {
        const keys = Object.keys(CONTACTS);
                sendACK(from, msgId);

        sendAPRS(
            from,
            keys.length ? `📒 Contactos: ${keys.join(", ")}` : "📒 Agenda vacía"
        );
        return true;
    }

    return false;
}

function handleLock(from, text, msgId, lockDict) {
    if (text.startsWith("#LOCK ")) {
        const dest = text.split(" ")[1]?.toUpperCase();
        if (!dest || !CONTACTS[dest]) {
            sendAPRS(from, "❌ Alias inexistente");
        } else {
            lockDict[from] = dest;
            sendAPRS(from, `🔒 LOCK → ${dest}`);
        }
        sendACK(from, msgId);
        return true;
    }

    if (text === "#UNLOCK") {
        if (lockDict[from]) {
            delete lockDict[from];
            sendAPRS(from, "🔓 LOCK desactivado");
        } else {
            sendAPRS(from, "🔓 No hay LOCK activo");
        }
        sendACK(from, msgId);
        return true;
    }

    return false;
}

function handleHelp(from, text, msgId) {
    if (text === "#HELP" || text === "#START") {
   // 1️⃣ ACK inmediato
        sendACK(from, msgId);

        // 2️⃣ Respuesta después (opcionalmente con delay)
        setTimeout(() => {
            sendAPRS(from, WELCOME_MESSAGE);
        }, 2000);
        return true;
    }
    return false;
}

function handleWX(from, text, msgId) {
    if (text === "#WX") {
        getCurrentSMNAlert(alert => {
            if (!alert)
                sendAPRS(from, "🌤 SMN: sin alertas meteorológicas");
            else
                sendAPRS(from, `🌩 SMN ACP ${alert.title}`);
            sendACK(from, msgId);
        });
        return true;
    }
    return false;
}

function aprsToWA(from, text, msgId) {
    let alias = null;
    let msg = text;

    if (text.startsWith("@")) {
        const parts = text.substring(1).split(" ");
        alias = parts.shift().toUpperCase();
        msg = parts.join(" ").trim();
    }

    const locked = LOCKED_DEST[from];
    if (!alias && locked) alias = locked;

    if (!alias) {
                sendACK(from, msgId);

        sendAPRS(from, WELCOME_MESSAGE);
        return;
    }

    const phone = CONTACTS[alias];
    if (!phone) {
                sendACK(from, msgId);

        sendAPRS(from, `❌ Alias ${alias} no encontrado`);
        return;
    }

    const chatId = "549" + phone.replace(/^549?/, "") + "@c.us";

    console.log("📤 APRS → WhatsApp:", chatId, msg);

    client
        .sendMessage(
            chatId,
            `📡 Mensaje recibido vía APRS (${from}):\n*${msg}*`
        )
        .then(sentMsg => {
            sentMessages[sentMsg.id._serialized] = {
                aprsFrom: from,
                text: msg
            };
        });

    sendACK(from, msgId);
}



/* ===== BROADCAST AUTOMÁTICO DE ALERTAS SMN ===== */
const ALERT_BROADCAST_INTERVAL = 5 * 60 * 1000;
const APRS_BROADCAST_DEST = "APRS";

function checkAndBroadcastAlerts() {
    console.log("Check WX");
    getCurrentSMNAlert(alert => {
        if (!alert) return;
        const message = `🌩 ALERTA SMN: ${alert.title}`;
        console.log("📡 Broadcast APRS:", message);
        sendAPRS(APRS_BROADCAST_DEST, message);
    });
}

setInterval(checkAndBroadcastAlerts, ALERT_BROADCAST_INTERVAL);
