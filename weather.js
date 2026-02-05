const https = require("https");
const fs = require("fs");
const xml2js = require("xml2js");

const FEED_URL = "https://ssl.smn.gob.ar/feeds/CAP/avisocortoplazo/rss_acpCAP.xml";
const STATE_FILE = "./alerts/state.json";

// CONFIG
// CONFIG
const ZONAS_BUSCADAS = ["Bahía Blanca", "Coronel Dorrego", "Tres Arroyos", "Villarino", "Sierra de la ventana"];

// ================= Estado =================
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ================= Fetch RSS =================
function fetchSMNRSS(cb) {
  https.get(FEED_URL, res => {
    let data = "";
    res.on("data", d => data += d);
    res.on("end", () => {
      xml2js.parseString(data, { explicitArray: false }, (err, result) => {
        if (err) {
          console.log("❌ Error parseando RSS SMN");
          return cb(null);
        }
        cb(result);
      });
    });
  }).on("error", err => {
    console.log("❌ Error SMN RSS:", err.message);
    cb(null);
  });
}

// ================= ALERTA ACTUAL (manual #WX) =================
function getCurrentSMNAlert(cb) {
  fetchSMNRSS(feed => {
    if (!feed?.rss?.channel?.item) return cb(null);

    const items = Array.isArray(feed.rss.channel.item)
      ? feed.rss.channel.item
      : [feed.rss.channel.item];

    // Busca cualquier alerta que contenga alguna de las zonas
const item = items.find(i =>
  ZONAS_BUSCADAS.some(zona =>
    i.description?.toLowerCase().includes(zona.toLowerCase())
  )
);

if (!item) return cb(null);

const zonasAfectadas = ZONAS_BUSCADAS.filter(zona =>
  item.description?.toLowerCase().includes(zona.toLowerCase())
);

cb({
  title: item.title,
  description: item.description,
  zonas: zonasAfectadas
});

  });
}

// ================= CHEQUEO AUTOMÁTICO =================
function checkWeatherAlerts(sendWA, sendAPRS) {
  console.log("Chequeando alertas WX")
  fetchSMNRSS(feed => {
    if (!feed?.rss?.channel?.item) return;

    const items = Array.isArray(feed.rss.channel.item)
      ? feed.rss.channel.item
      : [feed.rss.channel.item];

    const state = loadState();

    for (const item of items) {
      // Salta si no coincide con ninguna zona
      if (!ZONAS_BUSCADAS.some(zona =>
        item.description?.toLowerCase().includes(zona.toLowerCase())
      )) continue;

      const key = item.guid || item.title;
      if (state.last === key) return;

      const zonasAfectadas = ZONAS_BUSCADAS.filter(zona =>
        item.description?.toLowerCase().includes(zona.toLowerCase())
      );

    const msg = item.title.trim();


      console.log("🚨 Nueva alerta SMN:", msg);

     sendWA(msg);

sendAPRS(msg);

      state.last = key;
      saveState(state);
      return;
    }
  });
}


module.exports = {
  checkWeatherAlerts,
  getCurrentSMNAlert
};
