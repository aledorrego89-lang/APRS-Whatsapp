require("dotenv").config();
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
const COUNTER_FILE = "./aprs_counter.json";
/* ===== TRACKING ACK RECIBIDOS ===== */
const receivedAcks = new Set();

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


const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'none'
    },
    puppeteer: {
        executablePath: '/usr/bin/chromium-browser',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    }
});



const WELCOME_MESSAGE =
    "👋Bienvenido al Gateway LW7EEA. " +
    "Para recibir instrucciones de uso: #HELP. " +
      "En constante desarrollo. " +
    "Febreo 2026";

/* ================= WHATSAPP → APRS ================= */
client.on("message", async message => {

/* ===== ALERTAS ON/OFF ===== */
if (message.body.trim().toUpperCase() === "#ALERT ON" ||
    message.body.trim().toUpperCase() === "#ALERT OFF") {

    const turnOn = message.body.trim().toUpperCase() === "#ALERT ON";
const contactObj = await message.getContact();
const senderNumber = contactObj.number;

console.log("Numero real:", senderNumber);



const cleanSender = senderNumber.replace(/\D/g, "");


console.log("Numero limpio:", senderNumber);



const alias = Object.keys(CONTACTS).find(key => {
    const contact = CONTACTS[key];

    const phone =
        typeof contact === "string"
            ? contact
            : contact?.phone;

    console.log("Comparando contra:", phone);

    if (!phone) return false;

    const cleanPhone = phone.replace(/\D/g, "");

return cleanPhone === cleanSender;

});

console.log("Numero recibido:", senderNumber);
console.log("Agenda:", CONTACTS);
console.log("Alias encontrado:", alias);


    if (!alias) {
        await safeReply(message, "❌ No estás registrado en la agenda");
        return;
    }

    // Migración automática si estaba en formato viejo
    if (typeof CONTACTS[alias] === "string") {
        CONTACTS[alias] = {
            phone: CONTACTS[alias],
            alerts: false
        };
    }

    CONTACTS[alias].alerts = turnOn;
    saveContacts();

    await safeReply(
        message,
        turnOn
            ? "🌦 Alertas meteorológicas ACTIVADAS"
            : "🔕 Alertas meteorológicas DESACTIVADAS"
    );

    return;
}



    /* ===== LOCK WhatsApp ===== */
    if (message.body.startsWith("#LOCK ")) {
        const dest = message.body.split(" ")[1]?.toUpperCase();

        if (!dest || !/^[A-Z0-9]{3,6}(-\d{1,2})?$/.test(dest)) {
            await safeReply(message, "❌ Uso: #LOCK CALLSIGN (ej: LW7EEA-7)");
            return;
        }

        WA_LOCKED_DEST[message.from] = dest;
        await safeReply(message, `🔒 LOCK APRS activo → ${dest}`);
        return;
    }

    if (message.body.trim() === "#UNLOCK") {
        delete WA_LOCKED_DEST[message.from];
        await safeReply(message, "🔓 LOCK desactivado");
        return;
    }

    /* ===== CLIMA ===== */
    if (message.body.trim().toUpperCase() === "#WX") {
        getCurrentSMNAlert(async alert => {
            if (!alert) await safeReply(message, "🌤 Sin alertas SMN");
            else await safeReply(message, `🌩 ALERTA SMN\n${alert.title}`);
        });
        return;
    }


    /* ===== HELP ===== */
if (message.body.trim().toUpperCase() === "#HELP" ||
    message.body.trim().toUpperCase() === "#START") {

await safeReply(message,
    "👋 *Gateway LW7EEA*\n\n" +

    "📡 *WhatsApp → APRS*\n" +
    "• @CALL-SSID mensaje\n\n" +

    "📲 *APRS → WhatsApp*\n" +
    "• @CALL mensaje _(agendar antes)_\n" +
    "• #NUM mensaje\n\n" +

    "📒 *Agenda*\n" +
      "Utilizar formato internacional sin + Ej: 5492921xxxxxx. \n" +
    "• #SET CALL NUMERO _(agregar contacto)_\n" +
    "• #RM CALL _(eliminar contacto)_\n\n" + 

    "🔒 *LOCK*\n" +
    "• #LOCK CALL\n" +
    "• #UNLOCK\n\n" +

    "🌦 *Alertas*\n" +
    "• #WX\n" +
      "• #ALERT ON _(wx automaticas)_\n" +
        "• #ALERT OFF _(wx automaticas)_\n" +
      "• _(al agendar un alias, por defecto estan desactivadas)_\n" +
    "ℹ️ *Ayuda*\n" +
    "• #HELP\n\n" +

    "🔗 https://gist.github.com/aledorrego89-lang/675c86f9a6f769007491dcf740f5b590"
);
return;

}

/* ===== LIST AGENDA ===== */
if (message.body.trim().toUpperCase() === "#LIST") {

    const entries = Object.entries(CONTACTS);

    if (entries.length === 0) {
        await safeReply(message, "📒 La agenda está vacía");
        return;
    }

    let text = "📒 *Agenda*\n\n";

    for (const [call, number] of entries) {
        text += `• ${call} → ${number}\n`;
    }

    await safeReply(message, text);
    return;
}


    /* ===== MENSAJE CON LOCK ===== */
    const locked = WA_LOCKED_DEST[message.from];

    

    if (!message.body.startsWith("@") && !message.body.startsWith("#") && locked) {
        sendAPRS(locked.padEnd(9), message.body);
        await safeReply(message, "✅ Enviado");
        return;
    }

    if (!message.body.startsWith("@")) {
        await safeReply(message, WELCOME_MESSAGE);
        return;
    }

    /* ===== @CALL ===== */
    const match = message.body.match(/^@([A-Z0-9\-]{3,9})\s+(.+)/i);
    if (!match) {
        await safeReply(message, "Formato inválido");
        return;
    }

sendAPRS(
    match[1].toUpperCase().padEnd(9),
    match[2],
    message
);

await safeReply(message, "📤 Enviado a APRS (esperando ACK)");
});

async function safeReply(message, text) {
    try {
        await message.reply(text);
    } catch (e) {
        console.log("⚠ WhatsApp reply falló:", e.message);
    }
}



/* ================= APRS ================= */
let aprs;

/* ===== APRS UTILS ===== */


let aprsMsgCounter = 1;

if (fs.existsSync(COUNTER_FILE)) {
    aprsMsgCounter = JSON.parse(fs.readFileSync(COUNTER_FILE)).counter || 1;
}

function nextAprsId() {
    const id = aprsMsgCounter;

    aprsMsgCounter++;
    if (aprsMsgCounter > 999) aprsMsgCounter = 1;

    fs.writeFileSync(COUNTER_FILE, JSON.stringify({ counter: aprsMsgCounter }));

    return id;
}

function sendAPRS(dest, text, waMsg = null) {
    const id = nextAprsId(); // SOLO mensajes nuevos
    const packet = `${CALLSIGN}>APRS::${dest.padEnd(9)}:${text}{${id}\n`;
    aprs.write(packet);

    console.log("📤 APRS:", packet.trim());

    if (waMsg) {
        sentMessages[id] = {
            waMsg,
            dest,
            time: Date.now()
        };
    }
}



function sendACK(dest, id) {
    if (!id || !aprs) return;
    const packet = `${CALLSIGN}>APRS::${dest.padEnd(9)}:ack${id}\n`;
    aprs.write(packet);
    console.log("✅ ACK:", packet.trim());
}

/* ===== START ===== */
let ultimoQR = 0;
const INTERVALO_QR = 5 * 60 * 1000; // 5 minutos

client.on("qr", qr => {
    const ahora = Date.now();

    if (ahora - ultimoQR < INTERVALO_QR) {
        console.log("⏱ QR ignorado (cooldown activo)");
        return;
    }

    ultimoQR = ahora;

    console.log("⚠ QR generado - sesión perdida");

    qrcode.generate(qr, { small: true });

    sendEmail(
        "⚠ WhatsApp Gateway - REQUIERE QR",
        "Se generó un nuevo código QR.\nLa sesión fue cerrada y requiere reautenticación."
    );
});


client.on("ready", () => {
    console.log("✅ WhatsApp listo");
    connectAPRS();
});

client.initialize();

/* ===== EVENTOS DE SESIÓN WHATSAPP ===== */
client.on("auth_failure", msg => {
    console.log("❌ AUTH FAILURE:", msg);
    sendEmail(
        "⚠ WhatsApp Gateway AUTH FAILURE",
        `Detalle:\n${msg}`
    );
});

client.on("disconnected", reason => {
    console.log("🔌 WA desconectado:", reason);
    sendEmail(
        "⚠ WhatsApp Gateway DESCONECTADO",
        `Motivo:\n${reason}`
    );
});

client.on("change_state", state => {
    console.log("📶 Estado WA:", state);

    if (state === "UNPAIRED" || state === "UNPAIRED_IDLE") {
        sendEmail(
            "⚠ WhatsApp Gateway - SESIÓN CERRADA",
            `El cliente pasó a estado ${state}.\nSe requiere escanear nuevo QR.`
        );
    }
});



client.on("message_ack", (msg, ack) => {
    const id = msg.id?._serialized;
    if (!id || !sentMessages[id]) return;

    const info = sentMessages[id];
    if (ack <= (info.lastAck || 0)) return;

    info.lastAck = ack;

    // LEÍDO
    if (ack === 3) {
        sendAPRS(info.aprsFrom, "✔✔ Mensaje LEÍDO en WhatsApp");
        delete sentMessages[id];
        return;
    }

    // ENTREGADO
    if (ack === 2) {
        setTimeout(() => {
            if (sentMessages[id] && sentMessages[id].lastAck === 2) {
                sendAPRS(info.aprsFrom, "✔ Mensaje ENTREGADO en WhatsApp");
            }
        }, 2000);
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
/* ===== ACK APRS ===== */
const ackMatch = line.match(/::(.{9}):ack(\d+)/);
if (ackMatch) {
    const ackId = ackMatch[2];

    // evitar procesar ACK duplicados
    if (receivedAcks.has(ackId)) return;
    receivedAcks.add(ackId);

    const info = sentMessages[ackId];
    if (info?.waMsg) {
        info.waMsg.reply("✅ Entregado en APRS");
        delete sentMessages[ackId];
    }
    return;
}



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

let phone = phoneRaw.replace(/\D/g, "");

if (!/^\d{8,15}$/.test(phone)) {
    sendACK(from, msgId);
    sendAPRS(from, "Número inválido. Usar formato internacional. Ej: 5492921401356");
    return true;
}


    //    CONTACTS[call.toUpperCase()] = phone;
    CONTACTS[call.toUpperCase()] = {
    phone: phone,
    alerts: false // por defecto desactivado
};

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

        // ACK inmediato
        sendACK(from, msgId);

        // respuesta informativa (mensaje NUEVO)
        setTimeout(() => {
            sendAPRS(from, "https://gist.github.com/aledorrego89-lang/675c86f9a6f769007491dcf740f5b590");
        }, 1500);

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

const contact = CONTACTS[alias];

if (!contact) {
    sendACK(from, msgId);
    sendAPRS(from, `❌ Alias ${alias} no encontrado`);
    return;
}

const phone = typeof contact === "string"
    ? contact
    : contact.phone;

const chatId = phone + "@c.us";


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
// const ALERT_BROADCAST_INTERVAL = 15 * 60 * 1000;
// const APRS_BROADCAST_DEST = "APRS";

// function checkAndBroadcastAlerts() {
//     console.log("Check WX");
//     getCurrentSMNAlert(alert => {
//         if (!alert) return;
//         const message = `🌩 ALERTA SMN: ${alert.title}`;
//         console.log("📡 Broadcast APRS:", message);
//         sendAPRS(APRS_BROADCAST_DEST, message);
//     });
// }

//setInterval(checkAndBroadcastAlerts, ALERT_BROADCAST_INTERVAL);

function broadcastWAAlert(alert) {
    const text =
        `🚨 *ALERTA METEOROLÓGICA SMN*\n\n` +
        `📌 *${alert.title}*\n` +
        `📍 Zonas: ${alert.zonas.join(", ")}\n\n` +
        `${alert.description}`;

   // for (const [alias, phone] of Object.entries(CONTACTS)) {
   for (const [alias, data] of Object.entries(CONTACTS)) {

    if (!data.alerts) continue; // SOLO suscritos

const chatId = data.phone + "@c.us";


        

        client.sendMessage(chatId, text)
            .then(() => console.log(`📲 Alerta enviada a ${alias}`))
            .catch(e => console.log(`❌ Error WA ${alias}:`, e.message));
    }
}


const WX_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutos

setInterval(() => {
    console.log("Check WX");
    checkWeatherAlerts(
        broadcastWAAlert, // WhatsApp
        () => {}           // APRS deshabilitado
    );
}, WX_CHECK_INTERVAL);



const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS    }
});

async function sendEmail(subject, text) {
    try {
        await transporter.sendMail({
            from: "aledorrego89@gmail.com",
            to: "aledorrego89@gmail.com",
            subject: subject,
            text: text
        });
        console.log("📧 Mail enviado");
    } catch (err) {
        console.log("❌ Error enviando mail:", err);
    }
}
//sendEmail("🧪 TEST Gateway", "Si recibís esto, el mail funciona correctamente.");
