
import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";
import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import mineflayer from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";

const {
  pathfinder,
  Movements,
  goals
} = pathfinderPackage;

const { GoalNear } = goals;


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

// ============================================================
// EXPRESS + SOCKET.IO
// ============================================================

const app = express();

const server = http.createServer(app);

const io = new SocketIO(server, {
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
// LOG
// ============================================================

function addLog(message, type = "info") {
  const entry = {
    time: new Date().toISOString(),
    type: type,
    message: String(message)
  };

  status.logs.push(entry);

  if (status.logs.length > 150) {
    status.logs.shift();
  }

  io.emit("log", entry);
  io.emit("status", getPublicStatus());

  console.log(
    "[" +
      String(type).toUpperCase() +
      "] " +
      String(message)
  );
}

// ============================================================
// CHAT
// ============================================================

function addChat(username, message, type = "minecraft") {
  const entry = {
    time: new Date().toISOString(),
    username: String(username || "Unknown"),
    message: String(message || ""),
    type: type
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

// ============================================================
// DISCORD DM
// ============================================================

async function sendOwnerDM(message) {
  try {
    if (!discordClient.isReady()) {
      return;
    }

    const user = await discordClient.users.fetch(
      OWNER_DISCORD_ID
    );

    if (!user) {
      return;
    }

    await user.send(String(message));
  } catch (error) {
    addLog(
      "Discord DM gönderilemedi: " +
        error.message,
      "error"
    );
  }
}

// ============================================================
// DISCORD READY
// ============================================================

discordClient.once("ready", () => {
  status.discord.online = true;

  status.discord.username =
    discordClient.user.username;

  status.discord.tag =
    discordClient.user.tag;

  status.discord.id =
    discordClient.user.id;

  status.discord.connectedAt =
    new Date().toISOString();

  addLog(
    "Discord bağlantısı aktif: " +
      discordClient.user.tag,
    "success"
  );

  broadcastStatus();
});

// ============================================================
// DISCORD ERROR
// ============================================================

discordClient.on("error", (error) => {
  addLog(
    "Discord hatası: " +
      error.message,
    "error"
  );
});

// ============================================================
// DISCORD DISCONNECT
// ============================================================

discordClient.on("shardDisconnect", () => {
  status.discord.online = false;

  addLog(
    "Discord bağlantısı kesildi.",
    "warning"
  );

  broadcastStatus();
});

// ============================================================
// DISCORD MESSAGE
// ============================================================

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) {
    return;
  }

  if (message.author.id !== OWNER_DISCORD_ID) {
    return;
  }

  if (!message.guild) {
    const text =
      message.content.trim();

    if (!text) {
      return;
    }

    if (text.startsWith("/")) {
      handleMinecraftCommand(text);
      return;
    }

    if (
      mcBot &&
      status.minecraft.online
    ) {
      mcBot.chat(text);

      addLog(
        "Discord -> Minecraft: " +
          text,
        "chat"
      );
    }
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

let lastAttackTime = 0;

// ============================================================
// CREATE MINECRAFT BOT
// ============================================================

function createMinecraftBot() {
  if (!MC_HOST) {
    addLog(
      "MC_HOST environment variable eksik.",
      "error"
    );

    return;
  }

  if (!MC_USERNAME) {
    addLog(
      "MC_USERNAME environment variable eksik.",
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
    "Minecraft'a bağlanılıyor: " +
      MC_HOST +
      ":" +
      MC_PORT,
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

  try {
    mcBot = mineflayer.createBot(options);
  } catch (error) {
    addLog(
      "Minecraft botu oluşturulamadı: " +
        error.message,
      "error"
    );

    scheduleReconnect();

    return;
  }

  mcBot.loadPlugin(pathfinder);

  setupMinecraftEvents();
}

// ============================================================
// MINECRAFT EVENTS
// ============================================================

function setupMinecraftEvents() {
  if (!mcBot) {
    return;
  }

  // ----------------------------------------------------------
  // SPAWN
  // ----------------------------------------------------------

  mcBot.once("spawn", () => {
    status.minecraft.online = true;

    status.minecraft.connectedAt =
      new Date().toISOString();

    try {
      mcMovements =
        new Movements(mcBot);

      mcBot.pathfinder.setMovements(
        mcMovements
      );
    } catch (error) {
      addLog(
        "Pathfinder hazırlanamadı: " +
          error.message,
        "error"
      );
    }

    addLog(
      "Minecraft bağlantısı kuruldu: " +
        mcBot.username,
      "success"
    );

    sendOwnerDM(
      "Minecraft botu sunucuya bağlandı.\n" +
        "Sunucu: " +
        MC_HOST +
        ":" +
        MC_PORT
    );

    broadcastStatus();
  });

  // ----------------------------------------------------------
  // LOGIN
  // ----------------------------------------------------------

  mcBot.on("login", () => {
    addLog(
      "Minecraft login başarılı.",
      "success"
    );
  });

  // ----------------------------------------------------------
  // END
  // ----------------------------------------------------------

  mcBot.on("end", (reason) => {
    status.minecraft.online = false;

    status.minecraft.lastDisconnect =
      new Date().toISOString();

    status.minecraft.target = null;
    status.minecraft.targetDistance = null;
    status.minecraft.attacking = false;

    currentTarget = null;

    addLog(
      "Minecraft bağlantısı kesildi: " +
        (reason || "bilinmiyor"),
      "warning"
    );

    sendOwnerDM(
      "Minecraft botunun bağlantısı kesildi.\n" +
        "Sebep: " +
        (reason || "bilinmiyor")
    );

    broadcastStatus();

    scheduleReconnect();
  });

  // ----------------------------------------------------------
  // KICK
  // ----------------------------------------------------------

mcBot.on("kicked", (reason) => {
  let kickReason = "";

  try {
    if (typeof reason === "string") {
      kickReason = reason;
    } else {
      kickReason = JSON.stringify(
        reason,
        null,
        2
      );
    }
  } catch {
    kickReason = String(reason);
  }

  addLog(
    "Minecraft botu sunucudan atıldı. Sebep: " +
      kickReason,
    "error"
  );

  sendOwnerDM(
    "Minecraft botu sunucudan atıldı.\n\n" +
      "Sebep:\n" +
      kickReason
  );
});

  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  mcBot.on("error", (error) => {
    addLog(
      "Minecraft hatası: " +
        error.message,
      "error"
    );
  });

  // ----------------------------------------------------------
  // CHAT
  // ----------------------------------------------------------

  mcBot.on("chat", (username, message) => {
    addChat(
      username,
      message,
      "minecraft"
    );

    addLog(
      username +
        ": " +
        message,
      "chat"
    );

    sendOwnerDM(
      "Minecraft | " +
        username +
        ": " +
        message
    );

    if (
      username.toLowerCase() ===
      OWNER_MC_NAME.toLowerCase()
    ) {
      if (
        String(message).startsWith("/")
      ) {
        handleMinecraftCommand(message);
      } else {
        handleMinecraftCommand(message);
      }
    }
  });

  // ----------------------------------------------------------
  // SYSTEM MESSAGE
  // ----------------------------------------------------------

  mcBot.on("message", (jsonMsg) => {
    try {
      const text =
        jsonMsg.toString();

      if (!text) {
        return;
      }

      const lower =
        text.toLowerCase();

      if (
        lower.includes("teleport") ||
        lower.includes("tpa")
      ) {
        addLog(
          "Minecraft sistem mesajı: " +
            text,
          "system"
        );
      }
    } catch {}
  });

  // ----------------------------------------------------------
  // HEALTH
  // ----------------------------------------------------------

  mcBot.on("health", () => {
    updateMinecraftStatus();
  });

  // ----------------------------------------------------------
  // PHYSICS
  // ----------------------------------------------------------

  mcBot.on("physicsTick", () => {
    updateMinecraftStatus();
  });

  // ----------------------------------------------------------
  // ENTITY GONE
  // ----------------------------------------------------------

  mcBot.on("entityGone", (entity) => {
    if (
      currentTarget &&
      entity.id === currentTarget.id
    ) {
      currentTarget = null;

      status.minecraft.target = null;
      status.minecraft.targetDistance = null;
      status.minecraft.attacking = false;

      broadcastStatus();
    }
  });

  // ----------------------------------------------------------
  // WINDOW
  // ----------------------------------------------------------

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
// UPDATE MINECRAFT STATUS
// ============================================================

function updateMinecraftStatus() {
  if (
    !mcBot ||
    !status.minecraft.online
  ) {
    return;
  }

  if (
    mcBot.player &&
    typeof mcBot.player.ping === "number"
  ) {
    status.minecraft.ping =
      mcBot.player.ping;
  }

  if (
    typeof mcBot.health === "number"
  ) {
    status.minecraft.health =
      Math.round(
        mcBot.health * 10
      ) / 10;
  }

  if (
    typeof mcBot.food === "number"
  ) {
    status.minecraft.food =
      Math.round(
        mcBot.food * 10
      ) / 10;
  }

  if (
    mcBot.entity &&
    mcBot.entity.position
  ) {
    status.minecraft.x =
      Math.round(
        mcBot.entity.position.x * 10
      ) / 10;

    status.minecraft.y =
      Math.round(
        mcBot.entity.position.y * 10
      ) / 10;

    status.minecraft.z =
      Math.round(
        mcBot.entity.position.z * 10
      ) / 10;
  }

  if (
    mcBot.game &&
    mcBot.game.dimension
  ) {
    status.minecraft.world =
      mcBot.game.dimension;
  }

  status.minecraft.attacking =
    attackEnabled;

  status.minecraft.movement =
    movementEnabled;

  updateTargetStatus();

  updateEquipment();

  broadcastStatus();
}

// ============================================================
// TARGET STATUS
// ============================================================

function updateTargetStatus() {
  if (
    !currentTarget ||
    !mcBot ||
    !mcBot.entity
  ) {
    status.minecraft.target = null;
    status.minecraft.targetDistance = null;

    return;
  }

  if (!currentTarget.position) {
    return;
  }

  const distance =
    mcBot.entity.position.distanceTo(
      currentTarget.position
    );

  status.minecraft.targetDistance =
    Math.round(distance * 10) / 10;

  status.minecraft.target =
    getEntityDisplayName(
      currentTarget
    );
}

// ============================================================
// ENTITY NAME
// ============================================================

function getEntityDisplayName(entity) {
  if (!entity) {
    return null;
  }

  if (
    entity.name === "zombie" &&
    entity.isBaby === true
  ) {
    return "Baby Zombie";
  }

  if (
    entity.name ===
    "wither_skeleton"
  ) {
    return "Wither Skeleton";
  }

  return (
    entity.name ||
    "Unknown"
  );
}

// ============================================================
// EQUIPMENT
// ============================================================

function getDurabilityInfo(item) {
  if (!item) {
    return null;
  }

  const result = {
    name:
      item.displayName ||
      item.name ||
      "Unknown",

    durability: null,

    maxDurability: null,

    percent: null
  };

  if (
    typeof item.maxDurability ===
      "number" &&
    item.maxDurability > 0
  ) {
    result.maxDurability =
      item.maxDurability;

    if (
      typeof item.durabilityUsed ===
        "number"
    ) {
      const remaining =
        item.maxDurability -
        item.durabilityUsed;

      result.durability =
        Math.max(
          0,
          remaining
        );

      result.percent =
        Math.round(
          (
            result.durability /
            item.maxDurability
          ) * 100
        );
    }
  }

  return result;
}

function updateEquipment() {
  if (!mcBot) {
    return;
  }

  if (
    !mcBot.inventory ||
    !mcBot.inventory.slots
  ) {
    return;
  }

  const slots =
    mcBot.inventory.slots;

  status.equipment.sword =
    getDurabilityInfo(
      mcBot.heldItem
    );

  status.equipment.boots =
    getDurabilityInfo(
      slots[36]
    );

  status.equipment.leggings =
    getDurabilityInfo(
      slots[37]
    );

  status.equipment.chestplate =
    getDurabilityInfo(
      slots[38]
    );

  status.equipment.helmet =
    getDurabilityInfo(
      slots[39]
    );
}

// ============================================================
// BABY ZOMBIE
// ============================================================

function isBabyZombie(entity) {
  if (!entity) {
    return false;
  }

  if (
    entity.name !== "zombie"
  ) {
    return false;
  }

  if (
    entity.isBaby === true
  ) {
    return true;
  }

  return false;
}

// ============================================================
// ALLOWED TARGET
// ============================================================

function isAllowedTarget(entity) {
  if (!entity) {
    return false;
  }

  if (
    entity.name ===
    "wither_skeleton"
  ) {
    return true;
  }

  if (
    isBabyZombie(entity)
  ) {
    return true;
  }

  return false;
}

// ============================================================
// FIND TARGET
// ============================================================

function findTarget() {
  if (
    !mcBot ||
    !mcBot.entity
  ) {
    return null;
  }

  const entities =
    Object.values(
      mcBot.entities || {}
    );

  const valid =
    entities.filter((entity) => {
      if (
        !isAllowedTarget(entity)
      ) {
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

  valid.sort((a, b) => {
    const aPriority =
      a.name ===
      "wither_skeleton"
        ? 0
        : 1;

    const bPriority =
      b.name ===
      "wither_skeleton"
        ? 0
        : 1;

    if (
      aPriority !==
      bPriority
    ) {
      return (
        aPriority -
        bPriority
      );
    }

    const aDistance =
      mcBot.entity.position.distanceTo(
        a.position
      );

    const bDistance =
      mcBot.entity.position.distanceTo(
        b.position
      );

    return (
      aDistance -
      bDistance
    );
  });

  return valid[0];
}

// ============================================================
// PVE LOOP
// ============================================================

setInterval(() => {
  if (
    !mcBot ||
    !status.minecraft.online
  ) {
    return;
  }

  if (!attackEnabled) {
    currentTarget = null;

    status.minecraft.target = null;
    status.minecraft.targetDistance = null;
    status.minecraft.attacking = false;

    return;
  }

  const target =
    findTarget();

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

  status.minecraft.attacking =
    true;

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

  if (distance <= 3.2) {
    const now = Date.now();

    if (
      now - lastAttackTime >=
      650
    ) {
      lastAttackTime = now;

      try {
        mcBot
          .lookAt(
            target.position,
            true
          )
          .catch(() => {});

        mcBot.attack(target);
      } catch (error) {
        addLog(
          "Saldırı hatası: " +
            error.message,
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
    return JSON.stringify(
      item
    ).toLowerCase();
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
      const items =
        window.slots || [];

      let acceptSlot = null;
      let rejectSlot = null;

      for (
        let i = 0;
        i < items.length;
        i++
      ) {
        const item =
          items[i];

        if (!item) {
          continue;
        }

        const name =
          item.name
            ? item.name.toLowerCase()
            : "";

        const text =
          itemText(item);

        if (
          name ===
            "lime_stained_glass_pane" ||
          (
            name.includes("lime") &&
            text.includes("accept")
          )
        ) {
          acceptSlot = i;
        }

        if (
          name ===
            "red_stained_glass_pane" ||
          (
            name.includes("red") &&
            (
              text.includes("deny") ||
              text.includes("reject")
            )
          )
        ) {
          rejectSlot = i;
        }
      }

      let guiText = "";

      try {
        guiText =
          JSON.stringify(
            items
          ).toLowerCase();
      } catch {}

      const ownerRequested =
        guiText.includes(
          OWNER_MC_NAME.toLowerCase()
        );

      if (
        ownerRequested &&
        acceptSlot !== null
      ) {
        window.click(
          acceptSlot
        );

        addLog(
          "Teleport isteği kabul edildi: " +
            OWNER_MC_NAME,
          "success"
        );
      } else if (
        !ownerRequested &&
        rejectSlot !== null
      ) {
        window.click(
          rejectSlot
        );

        addLog(
          "Yetkisiz teleport isteği reddedildi.",
          "warning"
        );
      }
    } catch (error) {
      addLog(
        "Teleport GUI işlenemedi: " +
          error.message,
        "error"
      );
    }
  }, 500);
}

// ============================================================
// MINECRAFT COMMANDS
// ============================================================

function handleMinecraftCommand(message) {
  if (
    !mcBot ||
    !status.minecraft.online
  ) {
    return;
  }

  let command =
    String(message).trim();

  if (
    command.startsWith("/")
  ) {
    command =
      command.substring(1);
  }

  const parts =
    command.split(/\s+/);

  const cmd =
    parts[0].toLowerCase();

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
        mcBot.pathfinder.setGoal(
          null
        );
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
        mcBot.pathfinder.setGoal(
          null
        );
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
        mcBot.pathfinder.setGoal(
          null
        );
      } catch {}

      addLog(
        "Hareket modu kapatıldı.",
        "warning"
      );

      break;

    case "tpme":

      mcBot.chat(
        "/tpa " +
          OWNER_MC_NAME
      );

      addLog(
        "TPA gönderildi: " +
          OWNER_MC_NAME,
        "info"
      );

      break;

    case "tphere":

      mcBot.chat(
        "/tpahere " +
          OWNER_MC_NAME
      );

      addLog(
        "TPAHere gönderildi: " +
          OWNER_MC_NAME,
        "info"
      );

      break;

    case "townspawn":

      mcBot.chat(
        "/t spawn"
      );

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
        "Bilinmeyen komut: " +
          cmd,
        "warning"
      );

      break;
  }

  status.minecraft.attacking =
    attackEnabled;

  status.minecraft.movement =
    movementEnabled;

  broadcastStatus();
}

// ============================================================
// STATUS MESSAGE
// ============================================================

function createStatusMessage() {
  const m =
    status.minecraft;

  const d =
    status.discord;

  return [
    "MCDCBOT DURUM",
    "",
    "Minecraft: " +
      (m.online
        ? "ONLINE"
        : "OFFLINE"),

    "Discord: " +
      (d.online
        ? "ONLINE"
        : "OFFLINE"),

    "Ping: " +
      (m.ping ?? "?") +
      " ms",

    "Can: " +
      (m.health ?? "?"),

    "Açlık: " +
      (m.food ?? "?"),

    "Dünya: " +
      (m.world ?? "?"),

    "Konum: " +
      (m.x ?? "?") +
      " " +
      (m.y ?? "?") +
      " " +
      (m.z ?? "?"),

    "Hedef: " +
      (m.target ?? "Yok"),

    "Mesafe: " +
      (m.targetDistance ?? "?"),

    "Saldırı: " +
      (attackEnabled
        ? "Açık"
        : "Kapalı"),

    "Hareket: " +
      (movementEnabled
        ? "Açık"
        : "Kapalı")
  ].join("\n");
}

// ============================================================
// WEB API
// SADECE OKUMA
// ============================================================

app.get(
  "/api/status",
  (req, res) => {
    res.json(
      getPublicStatus()
    );
  }
);

app.get(
  "/api/minecraft",
  (req, res) => {
    res.json(
      status.minecraft
    );
  }
);

app.get(
  "/api/discord",
  (req, res) => {
    res.json(
      status.discord
    );
  }
);

app.get(
  "/api/logs",
  (req, res) => {
    res.json(
      status.logs
    );
  }
);

app.get(
  "/api/chat",
  (req, res) => {
    res.json(
      status.chat
    );
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      minecraft:
        status.minecraft.online,

      discord:
        status.discord.online,

      uptime:
        Date.now() -
        startedAt
    });
  }
);

// ============================================================
// SOCKET.IO
// ============================================================

io.on("connection", (socket) => {
  addLog(
    "Web panel bağlandı: " +
      socket.id,
    "web"
  );

  socket.emit(
    "status",
    getPublicStatus()
  );

  socket.on("disconnect", () => {
    addLog(
      "Web panel ayrıldı: " +
        socket.id,
      "web"
    );
  });
});

// ============================================================
// STATUS TIMER
// ============================================================

setInterval(() => {
  updateMinecraftStatus();
}, 3000);

// ============================================================
// WEB SERVER
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    addLog(
      "Web status paneli çalışıyor. PORT=" +
        PORT,
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
        "Discord login başarısız: " +
          error.message,
        "error"
      );
    });
} else {
  addLog(
    "DISCORD_TOKEN bulunamadı.",
    "error"
  );
}

// ============================================================
// MINECRAFT START
// ============================================================

createMinecraftBot();

// ============================================================
// PROCESS ERRORS
// ============================================================

process.on(
  "uncaughtException",
  (error) => {
    addLog(
      "Uncaught exception: " +
        error.message,
      "error"
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {
    addLog(
      "Unhandled rejection: " +
        (
          error &&
          error.message
            ? error.message
            : String(error)
        ),
      "error"
    );
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

process.on(
  "SIGTERM",
  () => {
    addLog(
      "SIGTERM alındı, bot kapatılıyor.",
      "warning"
    );

    try {
      if (mcBot) {
        mcBot.quit();
      }
    } catch {}

    try {
      discordClient.destroy();
    } catch {}

    server.close(() => {
      process.exit(0);
    });
  }
);

