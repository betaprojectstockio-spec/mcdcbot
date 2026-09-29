```js
// MCDCBOT
// Minecraft PvE Bot + Discord Bot + Read-Only Web Status Panel
// Render uyumlu
//
// Web panel BOTU KONTROL ETMEZ.
// Sadece:
// - Minecraft durumu
// - Discord durumu
// - Ping
// - Uptime
// - Can / açlık
// - Konum
// - Dünya
// - Hedef
// - Ekipman
// - Minecraft chat
// - Loglar
// gösterilir.
//
// Environment Variables:
// MC_HOST
// MC_PORT
// MC_USERNAME
// MC_PASSWORD              (opsiyonel)
// MC_AUTH                  (opsiyonel: microsoft / mojang / offline)
// DISCORD_TOKEN
// OWNER_DISCORD_ID
// OWNER_MC_NAME

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import mineflayer from "mineflayer";
import { pathfinder, Movements, goals } from "mineflayer-pathfinder";

const {
  GoalNear
} = goals;

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USERNAME = process.env.MC_USERNAME;
const MC_PASSWORD = process.env.MC_PASSWORD || undefined;
const MC_AUTH = process.env.MC_AUTH || undefined;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const OWNER_DISCORD_ID =
  process.env.OWNER_DISCORD_ID || "1025116253217640609";

const OWNER_MC_NAME =
  process.env.OWNER_MC_NAME || "winmaster33";

if (!MC_HOST) {
  console.error("[CONFIG] MC_HOST eksik.");
}

if (!MC_USERNAME) {
  console.error("[CONFIG] MC_USERNAME eksik.");
}

if (!DISCORD_TOKEN) {
  console.error("[CONFIG] DISCORD_TOKEN eksik.");
}

// ============================================================
// EXPRESS + SOCKET.IO
// ============================================================

const app = express();

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*"
  }
});

app.use(express.json());

app.use(express.static("public"));

// ============================================================
// STATUS
// ============================================================

const startedAt = Date.now();

const status = {
  minecraft: {
    online: false,
    username: MC_USERNAME || "Unknown",
    host: MC_HOST || "Unknown",
    port: MC_PORT,
    ping: null,
    health: null,
    food: null,
    world: null,
    x: null,
    y: null,
    z: null,
    target: null,
    targetDistance: null,
    attacking: false,
    movement: true,
    connectedAt: null,
    lastDisconnect: null
  },

  discord: {
    online: false,
    username: null,
    tag: null,
    id: null,
    connectedAt: null
  },

  web: {
    online: true
  },

  equipment: {
    sword: null,
    helmet: null,
    chestplate: null,
    leggings: null,
    boots: null
  },

  logs: [],
  chat: []
};

// ============================================================
// LOG SYSTEM
// ============================================================

function addLog(message, type = "info") {
  const entry = {
    time: new Date().toISOString(),
    type,
    message
  };

  status.logs.push(entry);

  // Son 150 log
  if (status.logs.length > 150) {
    status.logs.shift();
  }

  io.emit("log", entry);
  io.emit("status", getPublicStatus());

  console.log(`[${type.toUpperCase()}] ${message}`);
}

function addChat(username, message, type = "minecraft") {
  const entry = {
    time: new Date().toISOString(),
    username,
    message,
    type
  };

  status.chat.push(entry);

  if (status.chat.length > 150) {
    status.chat.shift();
  }

  io.emit("chat", entry);
}

// ============================================================
// PUBLIC STATUS
// ============================================================

function getPublicStatus() {
  return {
    minecraft: {
      ...status.minecraft
    },

    discord: {
      ...status.discord
    },

    web: {
      ...status.web
    },

    equipment: {
      ...status.equipment
    },

    logs: [...status.logs],
    chat: [...status.chat],

    uptime: Date.now() - startedAt,
    serverTime: Date.now()
  };
}

function broadcastStatus() {
  io.emit("status", getPublicStatus());
}

// ============================================================
// DISCORD
// ============================================================

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],

  partials: [
    Partials.Channel
  ]
});

async function sendOwnerDM(message) {
  try {
    const user = await discordClient.users.fetch(OWNER_DISCORD_ID);

    if (!user) {
      return;
    }

    await user.send(message);
  } catch (error) {
    addLog(
      `Discord DM gönderilemedi: ${error.message}`,
      "error"
    );
  }
}

discordClient.once("ready", () => {
  status.discord.online = true;
  status.discord.username = discordClient.user.username;
  status.discord.tag = discordClient.user.tag;
  status.discord.id = discordClient.user.id;
  status.discord.connectedAt = new Date().toISOString();

  addLog(
    `Discord bağlantısı aktif: ${discordClient.user.tag}`,
    "success"
  );

  broadcastStatus();
});

discordClient.on("error", (error) => {
  addLog(
    `Discord hatası: ${error.message}`,
    "error"
  );
});

discordClient.on("shardDisconnect", () => {
  status.discord.online = false;
  addLog("Discord bağlantısı kesildi.", "warning");
  broadcastStatus();
});

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) {
    return;
  }

  // Sadece owner Discord kullanıcısı kontrol edebilir.
  if (message.author.id !== OWNER_DISCORD_ID) {
    return;
  }

  // DM ise Minecraft chat'e gönder.
  if (!message.guild) {
    const text = message.content.trim();

    if (!text) {
      return;
    }

    // "/" ile başlayanlar komut olarak kabul edilir.
    if (text.startsWith("/")) {
      handleMinecraftCommand(text);
      return;
    }

    if (mcBot && status.minecraft.online) {
      mcBot.chat(text);

      addLog(
        `Discord → Minecraft: ${text}`,
        "chat"
      );
    }

    return;
  }
});

// ============================================================
// MINECRAFT
// ============================================================

let mcBot = null;
let reconnectTimer = null;

let currentTarget = null;

let attackEnabled = true;
let movementEnabled = true;

let mcMovements = null;

// ============================================================
// MINECRAFT BOT CREATE
// ============================================================

function createMinecraftBot() {
  if (!MC_HOST || !MC_USERNAME) {
    addLog(
      "Minecraft bağlantısı için MC_HOST ve MC_USERNAME gerekli.",
      "error"
    );

    return;
  }

  if (mcBot) {
    try {
      mcBot.quit();
    } catch {}
  }

  addLog(
    `Minecraft'a bağlanılıyor: ${MC_HOST}:${MC_PORT}`,
    "info"
  );

  const options = {
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USERNAME
  };

  if (MC_PASSWORD) {
    options.password = MC_PASSWORD;
  }

  if (MC_AUTH) {
    options.auth = MC_AUTH;
  }

  mcBot = mineflayer.createBot(options);

  mcBot.loadPlugin(pathfinder);

  setupMinecraftEvents();
}

// ============================================================
// MINECRAFT EVENTS
// ============================================================

function setupMinecraftEvents() {
  mcBot.once("spawn", () => {
    status.minecraft.online = true;
    status.minecraft.connectedAt = new Date().toISOString();

    try {
      mcMovements = new Movements(mcBot);
      mcBot.pathfinder.setMovements(mcMovements);
    } catch (error) {
      addLog(
        `Pathfinder hazırlanamadı: ${error.message}`,
        "error"
      );
    }

    addLog(
      `Minecraft bağlantısı kuruldu: ${mcBot.username}`,
      "success"
    );

    sendOwnerDM(
      `Minecraft botu sunucuya bağlandı.\nSunucu: ${MC_HOST}:${MC_PORT}`
    );

    broadcastStatus();
  });

  mcBot.on("end", (reason) => {
    status.minecraft.online = false;
    status.minecraft.lastDisconnect = new Date().toISOString();
    status.minecraft.target = null;
    status.minecraft.targetDistance = null;
    status.minecraft.attacking = false;

    addLog(
      `Minecraft bağlantısı kesildi: ${reason || "bilinmiyor"}`,
      "warning"
    );

    sendOwnerDM(
      `Minecraft botunun bağlantısı kesildi.\nSebep: ${reason || "bilinmiyor"}`
    );

    broadcastStatus();

    scheduleReconnect();
  });

  mcBot.on("kicked", (reason) => {
    addLog(
      `Minecraft botu atıldı: ${reason}`,
      "error"
    );

    sendOwnerDM(
      `Minecraft botu sunucudan atıldı.\nSebep: ${reason}`
    );
  });

  mcBot.on("error", (error) => {
    addLog(
      `Minecraft hatası: ${error.message}`,
      "error"
    );
  });

  mcBot.on("login", () => {
    addLog(
      "Minecraft login başarılı.",
      "success"
    );
  });

  mcBot.on("chat", (username, message) => {
    addChat(username, message);

    addLog(
      `${username}: ${message}`,
      "chat"
    );

    // Minecraft chat -> Discord DM
    sendOwnerDM(
      `Minecraft | ${username}: ${message}`
    );

    // Owner komutları
    if (
      username.toLowerCase() ===
      OWNER_MC_NAME.toLowerCase()
    ) {
      if (message.startsWith("/")) {
        handleMinecraftCommand(message);
      } else {
        handleMinecraftCommand(message);
      }
    }
  });

  mcBot.on("message", (jsonMsg) => {
    const text = jsonMsg.toString();

    if (!text) {
      return;
    }

    // Bazı sunucular chat event yerine message kullanabilir.
    // Aynı mesajı tekrar tekrar göstermek yerine yalnızca
    // önemli sistem mesajlarını logla.

    if (
      text.toLowerCase().includes("teleport") ||
      text.toLowerCase().includes("tpa")
    ) {
      addLog(
        `Minecraft sistem mesajı: ${text}`,
        "system"
      );
    }
  });

  mcBot.on("health", () => {
    updateMinecraftStatus();
  });

  mcBot.on("physicsTick", () => {
    updateMinecraftStatus();
  });

  mcBot.on("entityGone", (entity) => {
    if (currentTarget && entity.id === currentTarget.id) {
      currentTarget = null;

      status.minecraft.target = null;
      status.minecraft.targetDistance = null;
      status.minecraft.attacking = false;

      broadcastStatus();
    }
  });

  mcBot.on("windowOpen", (window) => {
    handleTeleportWindow(window);
  });
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (!status.minecraft.online) {
      createMinecraftBot();
    }
  }, 10000);
}

// ============================================================
// STATUS UPDATE
// ============================================================

function updateMinecraftStatus() {
  if (!mcBot || !status.minecraft.online) {
    return;
  }

  status.minecraft.ping =
    typeof mcBot.player?.ping === "number"
      ? mcBot.player.ping
      : null;

  status.minecraft.health =
    typeof mcBot.health === "number"
      ? Math.round(mcBot.health * 10) / 10
      : null;

  status.minecraft.food =
    typeof mcBot.food === "number"
      ? Math.round(mcBot.food * 10) / 10
      : null;

  if (mcBot.entity?.position) {
    status.minecraft.x =
      Math.round(mcBot.entity.position.x * 10) / 10;

    status.minecraft.y =
      Math.round(mcBot.entity.position.y * 10) / 10;

    status.minecraft.z =
      Math.round(mcBot.entity.position.z * 10) / 10;
  }

  if (mcBot.game?.dimension) {
    status.minecraft.world = mcBot.game.dimension;
  }

  status.minecraft.attacking = attackEnabled;
  status.minecraft.movement = movementEnabled;

  updateTargetStatus();
  updateEquipment();

  broadcastStatus();
}

// ============================================================
// TARGET STATUS
// ============================================================

function updateTargetStatus() {
  if (!currentTarget || !mcBot?.entity) {
    status.minecraft.target = null;
    status.minecraft.targetDistance = null;
    return;
  }

  if (!currentTarget.position) {
    return;
  }

  const distance = mcBot.entity.position.distanceTo(
    currentTarget.position
  );

  status.minecraft.targetDistance =
    Math.round(distance * 10) / 10;

  status.minecraft.target =
    getEntityDisplayName(currentTarget);
}

function getEntityDisplayName(entity) {
  if (!entity) {
    return null;
  }

  if (
    entity.name === "zombie" &&
    entity.isBaby
  ) {
    return "Baby Zombie";
  }

  if (entity.name === "wither_skeleton") {
    return "Wither Skeleton";
  }

  return entity.name || "Unknown";
}

// ============================================================
// EQUIPMENT
// ============================================================

function getDurabilityInfo(item) {
  if (!item) {
    return null;
  }

  const result = {
    name: item.displayName || item.name || "Unknown",
    durability: null,
    maxDurability: null,
    percent: null
  };

  if (
    typeof item.maxDurability === "number" &&
    item.maxDurability > 0
  ) {
    result.maxDurability = item.maxDurability;

    if (typeof item.durabilityUsed === "number") {
      const remaining =
        item.maxDurability - item.durabilityUsed;

      result.durability =
        Math.max(0, remaining);

      result.percent = Math.round(
        (result.durability /
          item.maxDurability) *
          100
      );
    }
  }

  return result;
}

function updateEquipment() {
  if (!mcBot) {
    return;
  }

  const equipment = mcBot.inventory?.slots;

  if (!equipment) {
    return;
  }

  // Mineflayer standart slotları:
  // 36 = boots
  // 37 = leggings
  // 38 = chestplate
  // 39 = helmet
  // 40 = offhand
  //
  // Held item için bot.heldItem kullanılır.

  status.equipment.sword =
    getDurabilityInfo(mcBot.heldItem);

  status.equipment.boots =
    getDurabilityInfo(equipment[36]);

  status.equipment.leggings =
    getDurabilityInfo(equipment[37]);

  status.equipment.chestplate =
    getDurabilityInfo(equipment[38]);

  status.equipment.helmet =
    getDurabilityInfo(equipment[39]);
}

// ============================================================
// PVE TARGETING
// ============================================================

function isBabyZombie(entity) {
  if (!entity) {
    return false;
  }

  if (entity.name !== "zombie") {
    return false;
  }

  if (entity.isBaby === true) {
    return true;
  }

  // Bazı Minecraft sürümlerinde metadata üzerinden gelir.
  if (Array.isArray(entity.metadata)) {
    for (const value of entity.metadata) {
      if (
        typeof value === "boolean" &&
        value === true
      ) {
        // Sadece zombie entity'sinde fallback.
        return true;
      }
    }
  }

  return false;
}

function isAllowedTarget(entity) {
  if (!entity) {
    return false;
  }

  if (entity.name === "wither_skeleton") {
    return true;
  }

  if (isBabyZombie(entity)) {
    return true;
  }

  return false;
}

function findTarget() {
  if (!mcBot?.entity) {
    return null;
  }

  const entities = Object.values(
    mcBot.entities || {}
  );

  const valid = entities.filter((entity) => {
    if (!isAllowedTarget(entity)) {
      return false;
    }

    if (!entity.position) {
      return false;
    }

    const distance =
      mcBot.entity.position.distanceTo(
        entity.position
      );

    return distance <= 32;
  });

  if (!valid.length) {
    return null;
  }

  // Öncelik:
  // 1. Wither Skeleton
  // 2. Baby Zombie
  valid.sort((a, b) => {
    const aPriority =
      a.name === "wither_skeleton" ? 0 : 1;

    const bPriority =
      b.name === "wither_skeleton" ? 0 : 1;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    const ad =
      mcBot.entity.position.distanceTo(
        a.position
      );

    const bd =
      mcBot.entity.position.distanceTo(
        b.position
      );

    return ad - bd;
  });

  return valid[0];
}

// ============================================================
// PVE LOOP
// ============================================================

let lastAttackTime = 0;

setInterval(() => {
  if (!mcBot || !status.minecraft.online) {
    return;
  }

  if (!attackEnabled) {
    currentTarget = null;
    status.minecraft.target = null;
    status.minecraft.targetDistance = null;
    status.minecraft.attacking = false;
    return;
  }

  const target = findTarget();

  if (!target) {
    currentTarget = null;

    status.minecraft.target = null;
    status.minecraft.targetDistance = null;
    status.minecraft.attacking = false;

    return;
  }

  currentTarget = target;

  updateTargetStatus();

  const distance =
    mcBot.entity.position.distanceTo(
      target.position
    );

  status.minecraft.attacking = true;

  // HAREKET AÇIK
  if (movementEnabled) {
    try {
      mcBot.pathfinder.setGoal(
        new GoalNear(
          target.position.x,
          target.position.y,
          target.position.z,
          2
        )
      );
    } catch {}
  }

  // Saldırı mesafesi
  if (distance <= 3.2) {
    const now = Date.now();

    if (now - lastAttackTime >= 650) {
      lastAttackTime = now;

      try {
        mcBot.lookAt(
          target.position,
          true
        ).catch(() => {});

        mcBot.attack(target);
      } catch (error) {
        addLog(
          `Saldırı hatası: ${error.message}`,
          "error"
        );
      }
    }
  }

  broadcastStatus();
}, 300);

// ============================================================
// TELEPORT GUI
// ============================================================

function itemText(item) {
  if (!item) {
    return "";
  }

  try {
    return JSON.stringify(item).toLowerCase();
  } catch {
    return "";
  }
}

function handleTeleportWindow(window) {
  if (!window) {
    return;
  }

  const title =
    typeof window.title === "string"
      ? window.title.toLowerCase()
      : "";

  const isTeleportWindow =
    title.includes("teleport") ||
    title.includes("tpa") ||
    title.includes("request");

  if (!isTeleportWindow) {
    return;
  }

  addLog(
    "Teleport isteği GUI'si algılandı.",
    "system"
  );

  setTimeout(() => {
    try {
      const items = window.slots || [];

      let acceptSlot = null;
      let rejectSlot = null;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (!item) {
          continue;
        }

        const name =
          item.name?.toLowerCase() || "";

        const text = itemText(item);

        if (
          name === "lime_stained_glass_pane" ||
          (
            name.includes("lime") &&
            text.includes("accept")
          )
        ) {
          acceptSlot = i;
        }

        if (
          name === "red_stained_glass_pane" ||
          (
            name.includes("red") &&
            text.includes("deny")
          )
        ) {
          rejectSlot = i;
        }
      }

      // Burada yalnızca winmaster33 isteğini kabul etmek
      // amaçlanıyor. GUI'de isim bilgisi bulunmuyorsa
      // güvenli tarafta kalıyoruz.
      let guiText = "";

      try {
        guiText = JSON.stringify(items).toLowerCase();
      } catch {}

      const ownerRequested =
        guiText.includes(
          OWNER_MC_NAME.toLowerCase()
        );

      if (ownerRequested && acceptSlot !== null) {
        window.click(acceptSlot);

        addLog(
          `Teleport isteği kabul edildi: ${OWNER_MC_NAME}`,
          "success"
        );
      } else if (
        !ownerRequested &&
        rejectSlot !== null
      ) {
        window.click(rejectSlot);

        addLog(
          "Yetkisiz teleport isteği reddedildi.",
          "warning"
        );
      }
    } catch (error) {
      addLog(
        `Teleport GUI işlenemedi: ${error.message}`,
        "error"
      );
    }
  }, 500);
}

// ============================================================
// MINECRAFT COMMANDS
// ============================================================

function handleMinecraftCommand(message) {
  if (!mcBot || !status.minecraft.online) {
    return;
  }

  let command = message.trim();

  if (command.startsWith("/")) {
    command = command.substring(1);
  }

  const parts = command.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "saldır":
    case "saldir":
      attackEnabled = true;

      addLog(
        "PvE saldırı modu açıldı.",
        "success"
      );

      break;

    case "saldırma":
    case "saldirma":
      attackEnabled = false;

      try {
        mcBot.pathfinder.setGoal(null);
      } catch {}

      currentTarget = null;

      addLog(
        "PvE saldırı modu kapatıldı.",
        "warning"
      );

      break;

    case "hareketizsaldır":
    case "hareketizsaldir":
      attackEnabled = true;
      movementEnabled = false;

      try {
        mcBot.pathfinder.setGoal(null);
      } catch {}

      addLog(
        "Hareketsiz PvE saldırı modu açıldı.",
        "success"
      );

      break;

    case "hareket":
      movementEnabled = true;

      addLog(
        "Hareket modu açıldı.",
        "success"
      );

      break;

    case "hareketyok":
      movementEnabled = false;

      try {
        mcBot.pathfinder.setGoal(null);
      } catch {}

      addLog(
        "Hareket modu kapatıldı.",
        "warning"
      );

      break;

    case "tpme":
      mcBot.chat(`/tpa ${OWNER_MC_NAME}`);

      addLog(
        `TPA gönderildi: ${OWNER_MC_NAME}`,
        "info"
      );

      break;

    case "tphere":
      mcBot.chat(`/tpahere ${OWNER_MC_NAME}`);

      addLog(
        `TPAHere gönderildi: ${OWNER_MC_NAME}`,
        "info"
      );

      break;

    case "townspawn":
      mcBot.chat("/t spawn");

      addLog(
        "Town spawn komutu gönderildi.",
        "info"
      );

      break;

    case "durum":
    case "status":
      sendOwnerDM(
        createStatusMessage()
      );

      break;

    case "yardım":
    case "yardim":
    case "help":
      sendOwnerDM(
        [
          "MCDCBOT komutları:",
          "saldır",
          "saldırma",
          "hareketizsaldır",
          "hareket",
          "hareketyok",
          "tpme",
          "tphere",
          "townspawn",
          "durum"
        ].join("\n")
      );

      break;

    default:
      addLog(
        `Bilinmeyen komut: ${cmd}`,
        "warning"
      );
  }

  status.minecraft.attacking = attackEnabled;
  status.minecraft.movement = movementEnabled;

  broadcastStatus();
}

// ============================================================
// STATUS DM
// ============================================================

function createStatusMessage() {
  const m = status.minecraft;
  const d = status.discord;

  return [
    "MCDCBOT DURUM",
    "",
    `Minecraft: ${m.online ? "ONLINE" : "OFFLINE"}`,
    `Discord: ${d.online ? "ONLINE" : "OFFLINE"}`,
    `Ping: ${m.ping ?? "?"} ms`,
    `Can: ${m.health ?? "?"}`,
    `Açlık: ${m.food ?? "?"}`,
    `Dünya: ${m.world ?? "?"}`,
    `Konum: ${m.x ?? "?"} ${m.y ?? "?"} ${m.z ?? "?"}`,
    `Hedef: ${m.target ?? "Yok"}`,
    `Mesafe: ${m.targetDistance ?? "?"}`,
    `Saldırı: ${attackEnabled ? "Açık" : "Kapalı"}`,
    `Hareket: ${movementEnabled ? "Açık" : "Kapalı"}`
  ].join("\n");
}

// ============================================================
// WEB API - SADECE OKUMA
// ============================================================

// Genel durum
app.get("/api/status", (req, res) => {
  res.json(getPublicStatus());
});

// Minecraft durumu
app.get("/api/minecraft", (req, res) => {
  res.json(status.minecraft);
});

// Discord durumu
app.get("/api/discord", (req, res) => {
  res.json(status.discord);
});

// Loglar
app.get("/api/logs", (req, res) => {
  res.json(status.logs);
});

// Chat
app.get("/api/chat", (req, res) => {
  res.json(status.chat);
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    minecraft: status.minecraft.online,
    discord: status.discord.online,
    uptime: Date.now() - startedAt
  });
});

// ============================================================
// WEB SOCKET
// ============================================================

io.on("connection", (socket) => {
  addLog(
    `Web panel bağlandı: ${socket.id}`,
    "web"
  );

  // İlk durum
  socket.emit(
    "status",
    getPublicStatus()
  );

  socket.on("disconnect", () => {
    addLog(
      `Web panel ayrıldı: ${socket.id}`,
      "web"
    );
  });

  // ÖNEMLİ:
  // Burada hiçbir command/chat/control listener yok.
  // Web panel sadece okuyabilir.
});

// ============================================================
// PERIODIC STATUS
// ============================================================

setInterval(() => {
  updateMinecraftStatus();
  broadcastStatus();
}, 3000);

// ============================================================
// SERVER
// ============================================================

httpServer.listen(
  PORT,
  "0.0.0.0",
  () => {
    addLog(
      `Web status paneli çalışıyor: PORT ${PORT}`,
      "success"
    );

    addLog(
      "Web panel salt-okunur modda.",
      "success"
    );
  }
);

// ============================================================
// DISCORD LOGIN
// ============================================================

if (DISCORD_TOKEN) {
  discordClient
    .login(DISCORD_TOKEN)
    .catch((error) => {
      addLog(
        `Discord login başarısız: ${error.message}`,
        "error"
      );
    });
}

// ============================================================
// MINECRAFT START
// ============================================================

createMinecraftBot();

// ============================================================
// PROCESS HANDLERS
// ============================================================

process.on("uncaughtException", (error) => {
  addLog(
    `Uncaught exception: ${error.message}`,
    "error"
  );
});

process.on("unhandledRejection", (error) => {
  addLog(
    `Unhandled rejection: ${error?.message || error}`,
    "error"
  );
});

process.on("SIGTERM", () => {
  addLog(
    "SIGTERM alındı, bot kapatılıyor.",
    "warning"
  );

  try {
    mcBot?.quit();
  } catch {}

  try {
    discordClient.destroy();
  } catch {}

  httpServer.close(() => {
    process.exit(0);
  });
});
```

### `package.json`

:::writing{variant="document" id="74106" title="mcdcbot — package.json"}
```json
{
  "name": "minecraft-dungeon-bot",
  "version": "1.0.0",
  "private": true,
  "description": "Minecraft PvE bot with Discord and read-only live status panel",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "discord.js": "^14.24.2",
    "express": "^5.1.0",
    "mineflayer": "^4.32.0",
    "mineflayer-pathfinder": "^2.4.5",
    "socket.io": "^4.8.1"
  }
}
```

### Panelin kendisi

Bunu ayrıca `public/index.html` yapacağız. `bot.js` zaten `public` klasörünü servis ediyor:

```text
mcdcbot/
├── bot.js
├── package.json
├── package-lock.json
└── public/
    └── index.html
```

Render'da **Build Command**:

```text
npm install
```

**Start Command**:

```text
npm start
```

Environment Variables:

```text
MC_HOST=SUNUCU_ADRESI
MC_PORT=25565
MC_USERNAME=BOT_ISMI
MC_PASSWORD=VARSA_SIFRE
DISCORD_TOKEN=DISCORD_BOT_TOKEN
OWNER_DISCORD_ID=1025116253217640609
OWNER_MC_NAME=winmaster33
```

Bu kodda özellikle **`POST /api/command` veya webden Minecraft chat gönderme endpoint'i yok**. Panelin yetkisi sadece **durumu okumak**.
