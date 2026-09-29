// bot.js
// Minecraft PvE Dungeon Bot
// Discord + Web Panel + Mineflayer
// Render uyumlu
//
// Seviye 3:
// - Wither Skeleton
// - Baby Zombie
//
// Kontrol:
// Discord DM veya Minecraft chat (sadece winmaster33)
//

const mineflayer = require("mineflayer");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials
} = require("discord.js");

const {
  pathfinder,
  Movements,
  goals
} = require("mineflayer-pathfinder");

const {
  GoalNear
} = goals;


// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  MC_HOST: process.env.MC_HOST,
  MC_PORT: Number(process.env.MC_PORT || 25565),
  MC_USERNAME: process.env.MC_USERNAME,
  MC_PASSWORD: process.env.MC_PASSWORD || undefined,

  DISCORD_TOKEN: process.env.DISCORD_TOKEN,

  OWNER_DISCORD_ID:
    process.env.OWNER_DISCORD_ID ||
    "1025116253217640609",

  OWNER_MC_NAME:
    process.env.OWNER_MC_NAME ||
    "winmaster33"
};


// ============================================================
// VALIDATION
// ============================================================

if (!CONFIG.MC_HOST) {
  console.error("[CONFIG] MC_HOST eksik.");
  process.exit(1);
}

if (!CONFIG.MC_USERNAME) {
  console.error("[CONFIG] MC_USERNAME eksik.");
  process.exit(1);
}

if (!CONFIG.DISCORD_TOKEN) {
  console.error("[CONFIG] DISCORD_TOKEN eksik.");
  process.exit(1);
}


// ============================================================
// EXPRESS WEB PANEL
// ============================================================

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);


// ============================================================
// BOT STATE
// ============================================================

let mcBot = null;
let discordClient = null;

let minecraftOnline = false;
let discordOnline = false;

let attackEnabled = false;
let movementEnabled = true;

let currentTarget = null;
let lastAttackTime = 0;

let reconnectTimer = null;

let lastEquipmentState = {};

let lastTPAAction = 0;

const state = {
  dungeonLevel: 3,

  attackEnabled: false,
  movementEnabled: true,

  target: null,

  minecraftOnline: false,
  discordOnline: false,

  lastChat: null,

  startedAt: Date.now()
};


// ============================================================
// DISCORD OWNER DM
// ============================================================

async function sendOwnerDM(message) {
  try {
    if (!discordClient || !discordClient.isReady()) {
      console.log("[DISCORD DM]", message);
      return;
    }

    const user =
      await discordClient.users.fetch(
        CONFIG.OWNER_DISCORD_ID
      );

    if (user) {
      await user.send(String(message));
    }
  } catch (err) {
    console.error(
      "[DISCORD DM ERROR]",
      err.message
    );
  }
}


// ============================================================
// LOG
// ============================================================

function log(...args) {
  console.log(
    `[${new Date().toISOString()}]`,
    ...args
  );
}


// ============================================================
// MINECRAFT BOT
// ============================================================

function createMinecraftBot() {
  if (mcBot) {
    try {
      mcBot.quit();
    } catch {}
  }

  log(
    `[MC] Bağlanılıyor: ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`
  );

  const options = {
    host: CONFIG.MC_HOST,
    port: CONFIG.MC_PORT,
    username: CONFIG.MC_USERNAME
  };

  if (CONFIG.MC_PASSWORD) {
    options.password = CONFIG.MC_PASSWORD;
  }

  // MC_VERSION bilerek verilmedi.
  // Mineflayer sunucudan uygun protokolü algılamaya çalışır.

  mcBot = mineflayer.createBot(options);

  mcBot.loadPlugin(pathfinder);

  // ==========================================================
  // LOGIN
  // ==========================================================

  mcBot.once("login", () => {
    log("[MC] Login başarılı.");
  });


  // ==========================================================
  // SPAWN
  // ==========================================================

  mcBot.once("spawn", () => {
    minecraftOnline = true;
    state.minecraftOnline = true;

    log("[MC] Bot spawn oldu.");

    try {
      const defaultMovements =
        new Movements(mcBot);

      // Botun gereksiz yere blok kırmasını engelle.
      defaultMovements.canDig = false;

      mcBot.pathfinder.setMovements(
        defaultMovements
      );
    } catch (err) {
      log(
        "[PATHFINDER]",
        err.message
      );
    }

    sendOwnerDM(
      `Minecraft botu bağlandı.\nSunucu: ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}\nSeviye: 3`
    );

    startCombatLoop();
    startEquipmentMonitor();
  });


  // ==========================================================
  // CHAT
  // ==========================================================

  mcBot.on(
    "chat",
    async (username, message) => {
      if (!username) return;

      if (username === mcBot.username) {
        return;
      }

      state.lastChat = {
        username,
        message,
        time: Date.now()
      };

      log(
        `[MC CHAT] ${username}: ${message}`
      );

      // Minecraft chat -> Discord DM
      await sendOwnerDM(
        `[Minecraft]\n${username}: ${message}`
      );

      // Sadece winmaster33 komut verebilir.
      if (
        username.toLowerCase() ===
        CONFIG.OWNER_MC_NAME.toLowerCase()
      ) {
        await handleCommand(
          message,
          "minecraft"
        );
      }
    }
  );


  // ==========================================================
  // SYSTEM MESSAGE
  // ==========================================================

  mcBot.on(
    "message",
    async (message) => {
      try {
        const text =
          typeof message.toString === "function"
            ? message.toString()
            : String(message);

        if (!text) return;

        log(`[MC MSG] ${text}`);

        const lower =
          text.toLowerCase();

        // TPA GUI açılmadan önce bazı sunucular
        // chat mesajı gösterebilir.

        if (
          lower.includes("teleport") ||
          lower.includes("tpa") ||
          lower.includes("ışınlan")
        ) {
          log(
            "[MC] Teleport ile ilgili mesaj:",
            text
          );
        }
      } catch {}
    }
  );


  // ==========================================================
  // ENTITY SPAWN
  // ==========================================================

  mcBot.on(
    "entitySpawn",
    (entity) => {
      if (!entity) return;

      if (
        entity.name === "wither_skeleton" ||
        isBabyZombie(entity)
      ) {
        log(
          `[TARGET] Yeni hedef bulundu: ${getEntityName(entity)}`
        );
      }
    }
  );


  // ==========================================================
  // ENTITY GONE
  // ==========================================================

  mcBot.on(
    "entityGone",
    (entity) => {
      if (
        currentTarget &&
        entity &&
        currentTarget.id === entity.id
      ) {
        currentTarget = null;
        state.target = null;

        log("[TARGET] Hedef öldü/kayboldu.");
      }
    }
  );


  // ==========================================================
  // WINDOW OPEN
  // ==========================================================

  mcBot.on(
    "windowOpen",
    async (window) => {
      try {
        log(
          "[GUI] Pencere açıldı:",
          window.title
        );

        await handleTeleportGUI(window);
      } catch (err) {
        log(
          "[GUI ERROR]",
          err.message
        );
      }
    }
  );


  // ==========================================================
  // DEATH
  // ==========================================================

  mcBot.on(
    "death",
    async () => {
      attackEnabled = false;
      state.attackEnabled = false;

      currentTarget = null;
      state.target = null;

      try {
        mcBot.pathfinder.setGoal(null);
      } catch {}

      log("[MC] Bot öldü.");

      await sendOwnerDM(
        "Minecraft botu öldü. Saldırı modu durduruldu."
      );
    }
  );


  // ==========================================================
  // KICK
  // ==========================================================

  mcBot.on(
    "kicked",
    async (reason) => {
      log(
        "[MC] Kick:",
        String(reason)
      );

      await sendOwnerDM(
        `Minecraft botu sunucudan atıldı.\n${String(reason)}`
      );
    }
  );


  // ==========================================================
  // ERROR
  // ==========================================================

  mcBot.on(
    "error",
    (err) => {
      log(
        "[MC ERROR]",
        err.message
      );
    }
  );


  // ==========================================================
  // END / RECONNECT
  // ==========================================================

  mcBot.on(
    "end",
    async (reason) => {
      minecraftOnline = false;
      state.minecraftOnline = false;

      currentTarget = null;
      state.target = null;

      log(
        "[MC] Bağlantı kapandı:",
        reason
      );

      await sendOwnerDM(
        `Minecraft bağlantısı kapandı.\nSebep: ${reason || "bilinmiyor"}`
      );

      scheduleReconnect();
    }
  );
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

    log("[MC] Yeniden bağlanılıyor...");

    createMinecraftBot();
  }, 10000);
}


// ============================================================
// ENTITY HELPERS
// ============================================================

function getEntityName(entity) {
  if (!entity) return "unknown";

  if (entity.username) {
    return entity.username;
  }

  if (entity.name) {
    return entity.name;
  }

  return "unknown";
}


// ============================================================
// BABY ZOMBIE DETECTION
// ============================================================

function isBabyZombie(entity) {
  if (!entity) {
    return false;
  }

  if (entity.name !== "zombie") {
    return false;
  }

  // Bazı Mineflayer sürümlerinde direkt bulunabilir.
  if (entity.isBaby === true) {
    return true;
  }

  // Metadata üzerinden baby zombie kontrolü.
  try {
    const metadata = entity.metadata || [];

    for (const entry of metadata) {
      if (!entry) continue;

      if (
        typeof entry === "object" &&
        entry.type === "byte" &&
        typeof entry.value === "number"
      ) {
        // Zombie baby metadata değeri bazı
        // sürümlerde farklı indekslerde olabilir.
        if ((entry.value & 0x01) !== 0) {
          return true;
        }
      }

      if (
        typeof entry === "object" &&
        typeof entry.value === "number"
      ) {
        if ((entry.value & 0x01) !== 0) {
          return true;
        }
      }
    }
  } catch {}

  return false;
}


// ============================================================
// TARGET VALIDATION
// ============================================================

function isValidTarget(entity) {
  if (!entity) {
    return false;
  }

  if (!entity.position) {
    return false;
  }

  // Level 3'te SADECE bunlar.
  if (entity.name === "wither_skeleton") {
    return true;
  }

  if (isBabyZombie(entity)) {
    return true;
  }

  return false;
}


// ============================================================
// FIND TARGET
// ============================================================

function findTarget() {
  if (!mcBot || !mcBot.entities) {
    return null;
  }

  const entities =
    Object.values(mcBot.entities);

  const validTargets =
    entities.filter(isValidTarget);

  if (validTargets.length === 0) {
    return null;
  }

  // Önce Wither Skeleton.
  const wither =
    validTargets.find(
      entity =>
        entity.name ===
        "wither_skeleton"
    );

  if (wither) {
    return wither;
  }

  // Sonra en yakın baby zombie.
  validTargets.sort(
    (a, b) => {
      const da =
        mcBot.entity.position.distanceTo(
          a.position
        );

      const db =
        mcBot.entity.position.distanceTo(
          b.position
        );

      return da - db;
    }
  );

  return validTargets[0];
}


// ============================================================
// ATTACK
// ============================================================

async function attackTarget(target) {
  if (!mcBot) return;
  if (!minecraftOnline) return;
  if (!attackEnabled) return;
  if (!target) return;

  if (!isValidTarget(target)) {
    return;
  }

  if (!target.position) {
    return;
  }

  const distance =
    mcBot.entity.position.distanceTo(
      target.position
    );

  // Yakınsa vur.
  if (distance <= 3.2) {
    try {
      await mcBot.lookAt(
        target.position.offset(
          0,
          Math.min(
            target.height || 1,
            1.2
          ),
          0
        ),
        true
      );
    } catch {}

    try {
      mcBot.attack(target);
    } catch (err) {
      log(
        "[ATTACK ERROR]",
        err.message
      );
    }

    lastAttackTime = Date.now();

    return;
  }

  // Hareket kapalıysa kesinlikle ilerleme.
  if (!movementEnabled) {
    return;
  }

  // Hareket açıksa hedefe git.
  try {
    const p =
      target.position;

    mcBot.pathfinder.setGoal(
      new GoalNear(
        p.x,
        p.y,
        p.z,
        2
      ),
      true
    );
  } catch (err) {
    log(
      "[PATH ERROR]",
      err.message
    );
  }
}


// ============================================================
// COMBAT LOOP
// ============================================================

let combatLoopStarted = false;

function startCombatLoop() {
  if (combatLoopStarted) {
    return;
  }

  combatLoopStarted = true;

  setInterval(
    async () => {
      try {
        if (!mcBot) return;
        if (!minecraftOnline) return;
        if (!attackEnabled) return;

        // Yaklaşık Minecraft attack cooldown.
        if (
          Date.now() - lastAttackTime <
          500
        ) {
          return;
        }

        // Mevcut hedef hâlâ geçerliyse kullan.
        if (
          currentTarget &&
          isValidTarget(currentTarget) &&
          mcBot.entities[currentTarget.id]
        ) {
          currentTarget =
            mcBot.entities[
              currentTarget.id
            ];
        } else {
          currentTarget =
            findTarget();
        }

        if (!currentTarget) {
          state.target = null;

          if (movementEnabled) {
            try {
              mcBot.pathfinder.setGoal(
                null
              );
            } catch {}
          }

          return;
        }

        state.target = {
          id: currentTarget.id,
          name:
            getEntityName(
              currentTarget
            )
        };

        await attackTarget(
          currentTarget
        );
      } catch (err) {
        log(
          "[COMBAT LOOP ERROR]",
          err.message
        );
      }
    },
    100
  );
}


// ============================================================
// COMMANDS
// ============================================================

async function handleCommand(
  rawCommand,
  source = "discord"
) {
  if (!rawCommand) {
    return;
  }

  let command =
    String(rawCommand)
      .trim();

  if (command.startsWith("/")) {
    command =
      command.slice(1);
  }

  const parts =
    command.split(/\s+/);

  const cmd =
    (parts.shift() || "")
      .toLowerCase();

  const args = parts;


  // ----------------------------------------------------------
  // SALDIR
  // ----------------------------------------------------------

  if (
    cmd === "saldır" ||
    cmd === "saldir"
  ) {
    attackEnabled = true;
    state.attackEnabled = true;

    await reply(
      "PvE saldırı modu açıldı.",
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // SALDIRMA
  // ----------------------------------------------------------

  if (
    cmd === "saldırma" ||
    cmd === "saldirma"
  ) {
    attackEnabled = false;
    state.attackEnabled = false;

    currentTarget = null;
    state.target = null;

    if (mcBot) {
      try {
        mcBot.pathfinder.setGoal(
          null
        );
      } catch {}
    }

    await reply(
      "PvE saldırı modu kapatıldı.",
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // HAREKETİZ SALDIR
  // ----------------------------------------------------------

  if (
    cmd === "hareketizsaldır" ||
    cmd === "hareketizsaldir"
  ) {
    attackEnabled = true;
    state.attackEnabled = true;

    movementEnabled = false;
    state.movementEnabled = false;

    currentTarget = null;

    if (mcBot) {
      try {
        mcBot.pathfinder.setGoal(
          null
        );
      } catch {}
    }

    await reply(
      "Hareketsiz saldırı modu açıldı. Bot bulunduğu yerden saldıracak.",
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // HAREKET
  // ----------------------------------------------------------

  if (cmd === "hareket") {
    movementEnabled = true;
    state.movementEnabled = true;

    await reply(
      "Hareket açıldı.",
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // HAREKET YOK
  // ----------------------------------------------------------

  if (
    cmd === "hareketyok" ||
    cmd === "hareket-yok"
  ) {
    movementEnabled = false;
    state.movementEnabled = false;

    if (mcBot) {
      try {
        mcBot.pathfinder.setGoal(
          null
        );
      } catch {}
    }

    await reply(
      "Hareket kapatıldı.",
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // TPA ME
  // ----------------------------------------------------------

  if (
    cmd === "tpme"
  ) {
    sendMinecraftCommand(
      `/tpa ${CONFIG.OWNER_MC_NAME}`
    );

    await reply(
      `${CONFIG.OWNER_MC_NAME} oyuncusuna TPA gönderildi.`,
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // TPA HERE
  // ----------------------------------------------------------

  if (
    cmd === "tphere"
  ) {
    sendMinecraftCommand(
      `/tpahere ${CONFIG.OWNER_MC_NAME}`
    );

    await reply(
      `${CONFIG.OWNER_MC_NAME} oyuncusuna TPAHere gönderildi.`,
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // TOWN SPAWN
  // ----------------------------------------------------------

  if (
    cmd === "townspawn"
  ) {
    sendMinecraftCommand(
      "/t spawn"
    );

    await reply(
      "/t spawn gönderildi.",
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  if (
    cmd === "status" ||
    cmd === "durum"
  ) {
    const target =
      currentTarget
        ? getEntityName(
            currentTarget
          )
        : "Yok";

    const text =
      [
        "Bot durumu:",
        `Minecraft: ${minecraftOnline ? "Online" : "Offline"}`,
        `Discord: ${discordOnline ? "Online" : "Offline"}`,
        `Seviye: 3`,
        `Saldırı: ${attackEnabled ? "Açık" : "Kapalı"}`,
        `Hareket: ${movementEnabled ? "Açık" : "Kapalı"}`,
        `Hedef: ${target}`
      ].join("\n");

    await reply(
      text,
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // YARDIM
  // ----------------------------------------------------------

  if (
    cmd === "yardım" ||
    cmd === "yardim" ||
    cmd === "help"
  ) {
    const help =
      [
        "Komutlar:",
        "/saldır",
        "/saldırma",
        "/hareketizsaldır",
        "/hareket",
        "/hareketyok",
        "/tpme",
        "/tphere",
        "/townspawn",
        "/status"
      ].join("\n");

    await reply(
      help,
      source
    );

    return;
  }


  // ----------------------------------------------------------
  // BİLİNMEYEN
  // ----------------------------------------------------------

  await reply(
    `Bilinmeyen komut: ${cmd}`,
    source
  );
}


// ============================================================
// MINECRAFT COMMAND
// ============================================================

function sendMinecraftCommand(command) {
  if (!mcBot) {
    return false;
  }

  if (!minecraftOnline) {
    return false;
  }

  try {
    mcBot.chat(command);
    return true;
  } catch (err) {
    log(
      "[MC COMMAND ERROR]",
      err.message
    );

    return false;
  }
}


// ============================================================
// REPLY
// ============================================================

async function reply(
  text,
  source
) {
  if (source === "minecraft") {
    if (mcBot && minecraftOnline) {
      try {
        mcBot.chat(
          String(text)
        );
      } catch {}
    }

    return;
  }

  await sendOwnerDM(text);
}


// ============================================================
// TELEPORT GUI
// ============================================================

function itemText(item) {
  if (!item) return "";

  let text = "";

  try {
    text +=
      ` ${item.name || ""}`;
  } catch {}

  try {
    text +=
      ` ${item.displayName || ""}`;
  } catch {}

  try {
    if (item.nbt) {
      text +=
        ` ${JSON.stringify(item.nbt)}`;
    }
  } catch {}

  return text.toLowerCase();
}


async function handleTeleportGUI(window) {
  if (!mcBot || !window) {
    return;
  }

  const title =
    String(
      window.title || ""
    ).toLowerCase();

  const isTeleportWindow =
    title.includes("teleport") ||
    title.includes("tpa") ||
    title.includes("ışınlan") ||
    title.includes("request") ||
    title.includes("istek");

  if (!isTeleportWindow) {
    return;
  }

  // Güvenlik:
  // Sadece açıkça teleport isteği GUI'si gibi
  // görünen pencerelerde işlem yapıyoruz.

  const slots =
    window.slots || [];

  let acceptSlot = -1;
  let rejectSlot = -1;

  let requesterIsOwner = false;

  for (
    let i = 0;
    i < slots.length;
    i++
  ) {
    const item = slots[i];

    if (!item) continue;

    const text =
      itemText(item);

    if (
      text.includes(
        "lime_stained_glass_pane"
      ) ||
      text.includes(
        "lime glass"
      )
    ) {
      acceptSlot = i;
    }

    if (
      text.includes(
        "red_stained_glass_pane"
      ) ||
      text.includes(
        "red glass"
      )
    ) {
      rejectSlot = i;
    }

    if (
      text.includes(
        CONFIG.OWNER_MC_NAME.toLowerCase()
      )
    ) {
      requesterIsOwner = true;
    }
  }

  // Eğer owner bilgisi item/NBT içerisinde
  // görünmüyorsa, chat mesajları üzerinden
  // /tpaccept fallback kullanılabilir.
  //
  // GUI'de owner tespit edilemiyorsa
  // körlemesine ACCEPT yapmıyoruz.

  if (requesterIsOwner && acceptSlot >= 0) {
    try {
      await mcBot.clickWindow(
        acceptSlot,
        0,
        0
      );

      log(
        `[TPA] ${CONFIG.OWNER_MC_NAME} isteği kabul edildi.`
      );

      await sendOwnerDM(
        `TPA isteği ${CONFIG.OWNER_MC_NAME} için otomatik kabul edildi.`
      );

      lastTPAAction = Date.now();

      return;
    } catch (err) {
      log(
        "[TPA ACCEPT ERROR]",
        err.message
      );
    }
  }

  // Owner değilse reddet.
  if (
    !requesterIsOwner &&
    rejectSlot >= 0
  ) {
    try {
      await mcBot.clickWindow(
        rejectSlot,
        0,
        0
      );

      log(
        "[TPA] Bilinmeyen oyuncunun isteği reddedildi."
      );

      lastTPAAction = Date.now();

      return;
    } catch (err) {
      log(
        "[TPA REJECT ERROR]",
        err.message
      );
    }
  }
}


// ============================================================
// TELEPORT CHAT FALLBACK
// ============================================================

let lastTeleportMessage = "";

mcBotFallbackTeleportHandler = null;


// Minecraft mesajlarından gelen TPA isteklerini
// yakalamaya çalışır.
function handleTeleportText(text) {
  const lower =
    String(text).toLowerCase();

  if (
    !lower.includes("tpa") &&
    !lower.includes("teleport") &&
    !lower.includes("ışınlan")
  ) {
    return;
  }

  if (
    lower.includes(
      CONFIG.OWNER_MC_NAME.toLowerCase()
    )
  ) {
    if (
      Date.now() - lastTPAAction <
      1500
    ) {
      return;
    }

    sendMinecraftCommand(
      "/tpaccept"
    );

    lastTPAAction =
      Date.now();

    log(
      `[TPA] ${CONFIG.OWNER_MC_NAME} için /tpaccept gönderildi.`
    );
  }
}


// ============================================================
// EQUIPMENT
// ============================================================

const equipmentNames = {
  head: "Kask",
  torso: "Göğüslük",
  legs: "Pantolon",
  feet: "Bot",
  hand: "Kılıç / Ana El",
  "off-hand": "Offhand"
};


function getEquipment() {
  if (!mcBot) {
    return {};
  }

  const result = {};

  const slots = [
    "head",
    "torso",
    "legs",
    "feet",
    "hand",
    "off-hand"
  ];

  for (const slot of slots) {
    let item = null;

    try {
      if (
        typeof mcBot.getEquipmentDestSlot ===
        "function"
      ) {
        const inventorySlot =
          mcBot.getEquipmentDestSlot(
            slot
          );

        item =
          mcBot.inventory.slots[
            inventorySlot
          ];
      }
    } catch {}

    result[slot] = item || null;
  }

  return result;
}


// ============================================================
// ITEM DURABILITY
// ============================================================

function getItemDurabilityInfo(item) {
  if (!item) {
    return null;
  }

  try {
    const max =
      item.maxDurability;

    const used =
      item.durabilityUsed;

    if (
      typeof max === "number" &&
      typeof used === "number"
    ) {
      const remaining =
        Math.max(
          0,
          max - used
        );

      return {
        max,
        used,
        remaining
      };
    }
  } catch {}

  return null;
}


// ============================================================
// EQUIPMENT MONITOR
// ============================================================

let equipmentMonitorStarted = false;

function startEquipmentMonitor() {
  if (equipmentMonitorStarted) {
    return;
  }

  equipmentMonitorStarted = true;

  setInterval(
    async () => {
      try {
        if (!mcBot) return;
        if (!minecraftOnline) return;

        const equipment =
          getEquipment();

        for (
          const [slot, item]
          of Object.entries(equipment)
        ) {
          const itemName =
            item
              ? (
                  item.displayName ||
                  item.name ||
                  "Bilinmeyen eşya"
                )
              : null;

          const old =
            lastEquipmentState[slot];

          const durability =
            getItemDurabilityInfo(
              item
            );

          // Item tamamen kaybolduysa
          // ve daha önce vardıysa.
          if (
            old &&
            old.itemName &&
            !item
          ) {
            await sendOwnerDM(
              `Ekipman kırıldı/kayboldu: ${equipmentNames[slot]}\nEşya: ${old.itemName}`
            );
          }

          // Aynı slotta başka item oluştuysa
          // eski item kaybolmuş olabilir.
          if (
            old &&
            old.itemName &&
            item &&
            old.itemName !== itemName
          ) {
            await sendOwnerDM(
              `Ekipman değişti/kırılmış olabilir: ${equipmentNames[slot]}\nÖnceki: ${old.itemName}\nŞimdi: ${itemName}`
            );
          }

          // Dayanıklılık 0'a düştüyse.
          if (
            old &&
            old.durability &&
            durability &&
            old.durability.remaining > 0 &&
            durability.remaining <= 0
          ) {
            await sendOwnerDM(
              `Ekipman kırıldı: ${equipmentNames[slot]}\nEşya: ${itemName}`
            );
          }

          lastEquipmentState[slot] = {
            itemName,
            durability
          };
        }
      } catch (err) {
        log(
          "[EQUIPMENT ERROR]",
          err.message
        );
      }
    },
    1000
  );
}


// ============================================================
// DISCORD
// ============================================================

discordClient =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [
      Partials.Channel
    ]
  });


discordClient.once(
  "ready",
  async () => {
    discordOnline = true;
    state.discordOnline = true;

    log(
      `[DISCORD] ${discordClient.user.tag} online.`
    );

    await sendOwnerDM(
      "Discord kontrol botu online."
    );

    // Minecraft botunu Discord hazır olduktan
    // sonra başlat.
    createMinecraftBot();
  }
);


// ============================================================
// DISCORD MESSAGE
// ============================================================

discordClient.on(
  "messageCreate",
  async (message) => {
    try {
      if (message.author.bot) {
        return;
      }

      // SADECE owner.
      if (
        message.author.id !==
        CONFIG.OWNER_DISCORD_ID
      ) {
        return;
      }

      // DM değilse normal Discord mesajlarını
      // Minecraft'a aktarmıyoruz.
      if (
        message.guild &&
        message.guild.id
      ) {
        return;
      }

      const content =
        String(
          message.content || ""
        ).trim();

      if (!content) {
        return;
      }

      // Slash ise command.
      if (
        content.startsWith("/")
      ) {
        await handleCommand(
          content,
          "discord"
        );

        return;
      }

      // Normal DM -> Minecraft chat.
      if (
        mcBot &&
        minecraftOnline
      ) {
        try {
          mcBot.chat(content);

          await message.react(
            "✓"
          );
        } catch (err) {
          await message.reply(
            `Minecraft mesajı gönderilemedi: ${err.message}`
          );
        }
      } else {
        await message.reply(
          "Minecraft botu şu anda offline."
        );
      }
    } catch (err) {
      log(
        "[DISCORD MESSAGE ERROR]",
        err.message
      );
    }
  }
);


// ============================================================
// EXPRESS API
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft Bot Panel</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #0b0b12;
  color: #fff;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 1000px;
  margin: 40px auto;
  padding: 20px;
}

h1 {
  margin-bottom: 5px;
}

.subtitle {
  color: #999;
  margin-bottom: 30px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(220px, 1fr));
  gap: 15px;
}

.card {
  background: #151521;
  border: 1px solid #29293b;
  border-radius: 14px;
  padding: 20px;
}

.label {
  color: #888;
  font-size: 13px;
}

.value {
  margin-top: 8px;
  font-size: 20px;
  font-weight: bold;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

button {
  border: 0;
  border-radius: 10px;
  padding: 12px 16px;
  background: #27273a;
  color: white;
  cursor: pointer;
}

button:hover {
  background: #38384f;
}

input {
  width: 100%;
  padding: 12px;
  margin-top: 10px;
  border-radius: 10px;
  border: 1px solid #333;
  background: #101018;
  color: white;
}

#log {
  margin-top: 20px;
  white-space: pre-wrap;
  background: #09090e;
  border-radius: 12px;
  padding: 15px;
  min-height: 120px;
}
</style>
</head>

<body>

<div class="container">

<h1>Minecraft Bot</h1>
<div class="subtitle">
GGuild Minecraft PvE Control Panel
</div>

<div class="grid">

<div class="card">
<div class="label">Minecraft</div>
<div id="minecraft" class="value">...</div>
</div>

<div class="card">
<div class="label">Discord</div>
<div id="discord" class="value">...</div>
</div>

<div class="card">
<div class="label">Seviye</div>
<div id="level" class="value">3</div>
</div>

<div class="card">
<div class="label">Saldırı</div>
<div id="attack" class="value">...</div>
</div>

<div class="card">
<div class="label">Hareket</div>
<div id="movement" class="value">...</div>
</div>

<div class="card">
<div class="label">Hedef</div>
<div id="target" class="value">...</div>
</div>

</div>

<div class="card" style="margin-top:20px">

<h2>Kontrol</h2>

<div class="buttons">

<button onclick="command('saldır')">
Saldır
</button>

<button onclick="command('saldırma')">
Saldırma
</button>

<button onclick="command('hareketizsaldır')">
Hareketsiz Saldır
</button>

<button onclick="command('hareket')">
Hareket
</button>

<button onclick="command('hareketyok')">
Hareket Yok
</button>

<button onclick="command('tpme')">
TPA
</button>

<button onclick="command('tphere')">
TPA Here
</button>

<button onclick="command('townspawn')">
Town Spawn
</button>

<button onclick="command('status')">
Durum
</button>

</div>

<h2>Chat</h2>

<input
id="chat"
placeholder="Minecraft'a mesaj gönder..."
onkeydown="if(event.key==='Enter') sendChat()"
/>

<div id="log"></div>

</div>

</div>

<script>

async function refresh() {
  try {
    const response =
      await fetch('/api/status');

    const data =
      await response.json();

    document.getElementById(
      'minecraft'
    ).textContent =
      data.minecraftOnline
        ? 'ONLINE'
        : 'OFFLINE';

    document.getElementById(
      'discord'
    ).textContent =
      data.discordOnline
        ? 'ONLINE'
        : 'OFFLINE';

    document.getElementById(
      'level'
    ).textContent =
      data.dungeonLevel;

    document.getElementById(
      'attack'
    ).textContent =
      data.attackEnabled
        ? 'AÇIK'
        : 'KAPALI';

    document.getElementById(
      'movement'
    ).textContent =
      data.movementEnabled
        ? 'AÇIK'
        : 'KAPALI';

    document.getElementById(
      'target'
    ).textContent =
      data.target
        ? data.target.name
        : 'Yok';

  } catch (e) {
    console.error(e);
  }
}

async function command(cmd) {
  try {
    const response =
      await fetch('/api/command', {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          command: cmd
        })
      });

    const data =
      await response.json();

    document.getElementById(
      'log'
    ).textContent =
      data.message ||
      'Komut gönderildi.';

    refresh();

  } catch (e) {
    document.getElementById(
      'log'
    ).textContent =
      e.message;
  }
}

async function sendChat() {
  const input =
    document.getElementById(
      'chat'
    );

  const text =
    input.value.trim();

  if (!text) return;

  try {
    const response =
      await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          message: text
        })
      });

    const data =
      await response.json();

    document.getElementById(
      'log'
    ).textContent =
      data.message ||
      'Gönderildi.';

    input.value = '';

  } catch (e) {
    document.getElementById(
      'log'
    ).textContent =
      e.message;
  }
}

refresh();

setInterval(
  refresh,
  1000
);

</script>

</body>
</html>
    `);
  }
);


// ============================================================
// STATUS API
// ============================================================

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      minecraftOnline,
      discordOnline,

      dungeonLevel:
        state.dungeonLevel,

      attackEnabled,

      movementEnabled,

      target:
        currentTarget
          ? {
              id:
                currentTarget.id,
              name:
                getEntityName(
                  currentTarget
                )
            }
          : null,

      lastChat:
        state.lastChat,

      uptime:
        Date.now() -
        state.startedAt
    });
  }
);


// ============================================================
// COMMAND API
// ============================================================

app.post(
  "/api/command",
  async (req, res) => {
    try {
      const command =
        String(
          req.body.command || ""
        ).trim();

      if (!command) {
        return res.status(400).json({
          ok: false,
          message:
            "Komut boş."
        });
      }

      await handleCommand(
        command,
        "web"
      );

      res.json({
        ok: true,
        message:
          `Komut gönderildi: ${command}`
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        message:
          err.message
      });
    }
  }
);


// ============================================================
// CHAT API
// ============================================================

app.post(
  "/api/chat",
  (req, res) => {
    try {
      const message =
        String(
          req.body.message || ""
        ).trim();

      if (!message) {
        return res.status(400).json({
          ok: false,
          message:
            "Mesaj boş."
        });
      }

      if (
        !mcBot ||
        !minecraftOnline
      ) {
        return res.status(503).json({
          ok: false,
          message:
            "Minecraft botu offline."
        });
      }

      mcBot.chat(message);

      res.json({
        ok: true,
        message:
          "Minecraft chat'e gönderildi."
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        message:
          err.message
      });
    }
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
      minecraftOnline,
      discordOnline
    });
  }
);


// ============================================================
// START WEB SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    log(
      `[WEB] Panel çalışıyor: port ${PORT}`
    );
  }
);


// ============================================================
// TELEPORT TEXT HOOK
// ============================================================

// Mineflayer botu oluştuktan sonra
// message event'i içerisinde kullanılabilmesi için
// küçük bir yardımcı interval.
//
// Chat/system mesajı geldikçe GUI sistemi
// önceliklidir; text fallback burada desteklenir.

setInterval(() => {
  try {
    if (
      !mcBot ||
      !minecraftOnline
    ) {
      return;
    }

    // Burada sadece mevcut state kontrolü yapılır.
    // TPA GUI event'i esas yöntemdir.
  } catch {}
}, 5000);


// ============================================================
// DISCORD LOGIN
// ============================================================

discordClient.login(
  CONFIG.DISCORD_TOKEN
).catch(
  (err) => {
    console.error(
      "[DISCORD LOGIN ERROR]",
      err.message
    );

    process.exit(1);
  }
);


// ============================================================
// PROCESS SAFETY
// ============================================================

process.on(
  "uncaughtException",
  (err) => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      err
    );
  }
);

process.on(
  "unhandledRejection",
  (err) => {
    console.error(
      "[UNHANDLED REJECTION]",
      err
    );
  }
);