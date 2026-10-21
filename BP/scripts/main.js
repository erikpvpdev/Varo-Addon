import {
  world,
  system,
  GameMode,
  ItemStack,
  EquipmentSlot,
  EnchantmentTypes,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
} from "@minecraft/server";
import { ActionFormData, FormCancelationReason } from "@minecraft/server-ui";

/* ------------------------------------------------------------------ *
 *  Varo für Bedrock – läuft in jeder Welt (Singleplayer, Realm, Server)
 *  Teams, tägliche Spielzeit, Schutzzeit, Tod = raus, Strikes, Grenze,
 *  Rucksack, Team-Kiste, Offline-Zombies, Varo-Menü (Kompass)
 * ------------------------------------------------------------------ */

const KEY = "varo:state";
const BP_SLOTS = 9; // Rucksack: Anzahl Stapel
const TC_SLOTS = 27; // Team-Kiste: Anzahl Stapel
const MENU_NAME = "§6Varo-Menü";
const ZOMBIE_RE = /^§c(.*) §7\(offline\)$/;
const BLOCKED = [
  "shulker_box", "bundle", "potion", "tipped_arrow", "written_book", "filled_map",
  "banner", "firework", "goat_horn", "decorated_pot", "suspicious",
];

const defaults = () => ({
  started: false,
  protection: 0,
  dayIndex: 0,
  lastDay: null,
  config: {
    dailyMinutes: 30,
    protectionMinutes: 10,
    dayMode: "real", // "real" = echter Kalendertag, "ingame" = Minecraft-Tag
    timeAction: "kick", // "kick" oder "spectator"
    maxStrikes: 3,
    zombies: true, // Offline-Zombies an/aus
  },
  border: { on: false, cx: 0, cz: 0, radius: 0, shrink: 0 },
  players: {}, // name -> { team, alive, strikes, used, day, locked, wipe }
});

let state = null;
const vault = new Map(); // name -> ItemStack[] (volle Qualität, solange die Welt läuft)
const busy = new Set(); // Spieler mit offenem Menü

function S() {
  if (!state) {
    try {
      const raw = world.getDynamicProperty(KEY);
      state = raw ? Object.assign(defaults(), JSON.parse(raw)) : defaults();
      state.config = Object.assign(defaults().config, state.config);
    } catch (e) {
      state = defaults();
    }
  }
  return state;
}

function save() {
  try {
    world.setDynamicProperty(KEY, JSON.stringify(S()));
  } catch (e) {}
}

const later = (fn) => system.run(fn);
const say = (m) => world.sendMessage("§6[Varo]§r " + m);
const online = (name) => world.getAllPlayers().find((p) => p.name === name);
const setMode = (pl, mode) => {
  try {
    pl.setGameMode(mode);
  } catch (e) {}
};
const setPvp = (v) => {
  try {
    world.gameRules.pvp = v;
  } catch (e) {}
};
const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const pretty = (id) => id.replace("minecraft:", "").replace(/_/g, " ");
const label = (it) => it.nameTag || pretty(it.typeId);

function dayKey() {
  if (S().config.dayMode === "ingame") return "g" + world.getDay();
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const limitSec = () => S().config.dailyMinutes * 60;

function teamsAlive() {
  const t = {};
  for (const [name, p] of Object.entries(S().players)) {
    if (p.alive) (t[p.team] ||= []).push(name);
  }
  return t;
}

function curRadius() {
  const s = S();
  return Math.max(10, s.border.radius - s.border.shrink * s.dayIndex);
}

function clearProps(prefixes) {
  try {
    for (const id of world.getDynamicPropertyIds()) {
      if (prefixes.some((p) => id.startsWith(p))) world.setDynamicProperty(id, undefined);
    }
  } catch (e) {}
}

/* --------------------------- Item-(De)Serialisierung --------------------------- */

function ser(item) {
  const o = { t: item.typeId, a: item.amount };
  if (item.nameTag) o.n = item.nameTag;
  try {
    const lore = item.getLore();
    if (lore && lore.length) o.l = lore;
  } catch (e) {}
  try {
    const en = item.getComponent("minecraft:enchantable");
    if (en) {
      const list = en.getEnchantments();
      if (list.length) o.e = list.map((x) => [x.type.id, x.level]);
    }
  } catch (e) {}
  try {
    const du = item.getComponent("minecraft:durability");
    if (du && du.damage) o.d = du.damage;
  } catch (e) {}
  return o;
}

function deser(o) {
  try {
    const it = new ItemStack(o.t, o.a);
    if (o.n) it.nameTag = o.n;
    if (o.l) it.setLore(o.l);
    if (o.e) {
      const en = it.getComponent("minecraft:enchantable");
      if (en) {
        for (const [id, lv] of o.e) {
          try {
            en.addEnchantment({ type: EnchantmentTypes.get(id), level: lv });
          } catch (e) {}
        }
      }
    }
    if (o.d) {
      const du = it.getComponent("minecraft:durability");
      if (du) du.damage = o.d;
    }
    return it;
  } catch (e) {
    return null;
  }
}

const sig = (o) => {
  const { a, ...rest } = o;
  return JSON.stringify(rest);
};
const isBlocked = (typeId) => BLOCKED.some((b) => typeId.includes(b));

/* ----------------------------- Lager (Rucksack/Kiste) ----------------------------- */

function loadStore(id) {
  try {
    const raw = world.getDynamicProperty(id);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveStore(id, arr) {
  try {
    world.setDynamicProperty(id, arr.length ? JSON.stringify(arr) : undefined);
  } catch (e) {}
}

// legt o ins Lager; gibt zurück, wie viele Stück NICHT mehr reingepasst haben
function addToStore(store, o, maxAmt, cap) {
  let left = o.a;
  const s = sig(o);
  for (const e of store) {
    if (left <= 0) break;
    if (sig(e) === s && e.a < maxAmt) {
      const t = Math.min(maxAmt - e.a, left);
      e.a += t;
      left -= t;
    }
  }
  while (left > 0) {
    if (store.length >= cap) return left;
    const t = Math.min(maxAmt, left);
    store.push({ ...o, a: t });
    left -= t;
  }
  return 0;
}

async function showForm(form, player) {
  for (let i = 0; i < 40; i++) {
    const r = await form.show(player);
    if (r.cancelationReason !== FormCancelationReason.UserBusy) return r;
    await new Promise((res) => system.runTimeout(res, 10)); // Chat ist noch offen
  }
  return { canceled: true };
}

async function pickAmount(player, title, max) {
  if (max <= 1) return 1;
  const half = Math.ceil(max / 2);
  const opts = [1];
  const f = new ActionFormData().title(title).body(`Verfügbar: ${max}`).button("1 Stück");
  if (half > 1 && half < max) {
    f.button(`Hälfte (${half})`);
    opts.push(half);
  }
  f.button(`Alles (${max})`);
  opts.push(max);
  const r = await showForm(f, player);
  if (r.canceled) return 0;
  return opts[r.selection];
}

async function depositMenu(player, id, cap) {
  const inv = player.getComponent("minecraft:inventory").container;
  const slots = [];
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)) slots.push(i);
  if (!slots.length) return player.sendMessage("§7Dein Inventar ist leer.");

  const f = new ActionFormData().title("Einlagern").body("Welches Item?");
  for (const i of slots) {
    const it = inv.getItem(i);
    f.button(`${label(it)} x${it.amount}`);
  }
  const r = await showForm(f, player);
  if (r.canceled) return;

  const slot = slots[r.selection];
  const it = inv.getItem(slot);
  if (!it) return;
  if (isBlocked(it.typeId)) return player.sendMessage("§cDieses Item kann nicht eingelagert werden.");

  let n = await pickAmount(player, "Menge", it.amount);
  if (!n) return;
  n = Math.min(n, it.amount);

  const store = loadStore(id); // frisch laden (Team-Kiste wird geteilt)
  const o = ser(it);
  o.a = n;
  const left = addToStore(store, o, it.maxAmount, cap);
  const stored = n - left;
  if (stored <= 0) return player.sendMessage("§cKein Platz mehr.");

  const name = label(it);
  if (stored >= it.amount) inv.setItem(slot, undefined);
  else {
    it.amount -= stored;
    inv.setItem(slot, it);
  }
  saveStore(id, store);
  player.sendMessage(`§a${stored}x ${name} eingelagert.`);
}

async function withdrawMenu(player, id) {
  const store = loadStore(id);
  if (!store.length) return player.sendMessage("§7Hier ist nichts drin.");

  const f = new ActionFormData().title("Entnehmen").body("Welches Item?");
  for (const o of store) f.button(`${o.n || pretty(o.t)} x${o.a}`);
  const r = await showForm(f, player);
  if (r.canceled) return;

  const idx = r.selection;
  const chosen = store[idx];
  let n = await pickAmount(player, "Menge", chosen.a);
  if (!n) return;

  const fresh = loadStore(id); // jemand anderes könnte schon etwas entnommen haben
  const e = fresh[idx];
  if (!e || sig(e) !== sig(chosen)) return player.sendMessage("§cDas Lager hat sich geändert, bitte nochmal.");
  n = Math.min(n, e.a);

  const item = deser({ ...e, a: n });
  if (!item) return player.sendMessage("§cItem konnte nicht erstellt werden.");
  const inv = player.getComponent("minecraft:inventory").container;
  const leftStack = inv.addItem(item);
  const taken = n - (leftStack ? leftStack.amount : 0);
  if (taken <= 0) return player.sendMessage("§cDein Inventar ist voll.");

  e.a -= taken;
  if (e.a <= 0) fresh.splice(idx, 1);
  saveStore(id, fresh);
  player.sendMessage(`§a${taken}x ${e.n || pretty(e.t)} entnommen.`);
}

async function openStore(player, id, title, cap) {
  while (true) {
    const store = loadStore(id);
    const f = new ActionFormData()
      .title(title)
      .body(`Belegt: ${store.length}/${cap} Slots`)
      .button("Einlagern")
      .button("Entnehmen")
      .button("Schließen");
    const r = await showForm(f, player);
    if (r.canceled || r.selection === 2) return;
    if (r.selection === 0) await depositMenu(player, id, cap);
    else await withdrawMenu(player, id);
  }
}

function statusFor(player) {
  const s = S();
  const p = s.players[player.name];
  if (!p) return "§7Du bist nicht in Varo.";
  const rem = p.day === dayKey() ? limitSec() - p.used : limitSec();
  return `§6Varo §7| Team §f${p.team} §7| Strikes §f${p.strikes}/${s.config.maxStrikes} §7| Restzeit heute §f${fmt(rem)}`;
}

async function openMenu(player) {
  if (busy.has(player.name)) return;
  busy.add(player.name);
  try {
    const p = S().players[player.name];
    if (!p) return player.sendMessage("§7Du bist nicht in Varo.");
    const f = new ActionFormData()
      .title("§6Varo")
      .button("Rucksack")
      .button("Team-Kiste")
      .button("Status")
      .button("Schließen");
    const r = await showForm(f, player);
    if (r.canceled) return;
    if (r.selection === 0) await openStore(player, `varo:bp:${player.name}`, "Rucksack", BP_SLOTS);
    else if (r.selection === 1) await openStore(player, `varo:tc:${p.team}`, `Team-Kiste (${p.team})`, TC_SLOTS);
    else if (r.selection === 2) player.sendMessage(statusFor(player));
  } catch (e) {
  } finally {
    busy.delete(player.name);
  }
}

function menuItem() {
  const it = new ItemStack("minecraft:compass", 1);
  it.nameTag = MENU_NAME;
  it.setLore(["§7Rechtsklick: Rucksack, Team-Kiste, Status"]);
  return it;
}

function giveMenu(pl) {
  try {
    const inv = pl.getComponent("minecraft:inventory").container;
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      if (it && it.typeId === "minecraft:compass" && it.nameTag === MENU_NAME) return;
    }
    inv.addItem(menuItem());
  } catch (e) {}
}

function dropBackpack(name, dim, loc) {
  const id = `varo:bp:${name}`;
  const store = loadStore(id);
  if (!store.length) return;
  for (const o of store) {
    const it = deser(o);
    if (it) {
      try {
        dim.spawnItem(it, loc);
      } catch (e) {}
    }
  }
  saveStore(id, []);
}

/* ------------------------------- Offline-Zombies ------------------------------- */

const DIMS = ["overworld", "nether", "the_end"];

function findZombies(owner) {
  const out = [];
  for (const d of DIMS) {
    try {
      for (const z of world.getDimension(d).getEntities({ tags: ["varo_offline"] })) {
        const m = ZOMBIE_RE.exec(z.nameTag || "");
        if (m && (!owner || m[1] === owner)) out.push({ z, owner: m[1] });
      }
    } catch (e) {}
  }
  return out;
}

function collectItems(pl) {
  const items = [];
  try {
    const inv = pl.getComponent("minecraft:inventory").container;
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      if (it) items.push(it);
    }
  } catch (e) {}
  try {
    const eq = pl.getComponent("minecraft:equippable");
    for (const sl of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
      const it = eq.getEquipment(sl);
      if (it) items.push(it);
    }
  } catch (e) {}
  return items;
}

function spawnOfflineZombie(name, dim, loc, items) {
  for (const { z } of findZombies(name)) {
    try {
      z.remove();
    } catch (e) {}
  }
  let zombie = null;
  for (let i = 0; i < 6 && !zombie; i++) {
    const e = dim.spawnEntity("minecraft:zombie", loc);
    if (e.getComponent("minecraft:is_baby")) e.remove();
    else zombie = e;
  }
  if (!zombie) return;
  zombie.nameTag = `§c${name} §7(offline)`;
  zombie.addTag("varo_offline");
  const D = 20000000;
  for (const [eff, amp] of [["fire_resistance", 0], ["slowness", 255], ["weakness", 20], ["resistance", 1]]) {
    try {
      zombie.addEffect(eff, D, { amplifier: amp, showParticles: false });
    } catch (e) {}
  }
  vault.set(name, items);
  try {
    world.setDynamicProperty(`varo:oz:${name}`, JSON.stringify(items.map(ser)));
  } catch (e) {}
  say(`§7${name} hat die Welt verlassen - ein Offline-Zombie bleibt zurück!`);
}

function loadOz(name) {
  try {
    const raw = world.getDynamicProperty(`varo:oz:${name}`);
    return raw ? JSON.parse(raw).map(deser).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

function onZombieDeath(ev) {
  const e = ev.deadEntity;
  const m = ZOMBIE_RE.exec(e.nameTag || "");
  if (!m) return;
  const owner = m[1];
  const loot = vault.get(owner) || loadOz(owner);
  const dim = e.dimension;
  const loc = e.location;
  for (const it of loot) {
    try {
      dim.spawnItem(it, loc);
    } catch (err) {}
  }
  vault.delete(owner);
  try {
    world.setDynamicProperty(`varo:oz:${owner}`, undefined);
  } catch (err) {}
  const p = S().players[owner];
  if (!p || !p.alive || !S().started) return;
  p.wipe = true; // beim nächsten Join Inventar leeren (Items hat der Zombie gedroppt)
  const k = ev.damageSource && ev.damageSource.damagingEntity;
  eliminate(
    owner,
    k && k.typeId === "minecraft:player" ? `Offline-Zombie von ${k.name} getötet` : "Offline-Zombie gestorben",
    { dim, loc }
  );
}

function wipePlayer(pl) {
  try {
    pl.getComponent("minecraft:inventory").container.clearAll();
  } catch (e) {}
  try {
    const eq = pl.getComponent("minecraft:equippable");
    for (const sl of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
      eq.setEquipment(sl, undefined);
    }
  } catch (e) {}
}

function restoreFromZombie(pl) {
  const found = findZombies(pl.name);
  if (!found.length) return;
  const { z } = found[0];
  try {
    const zh = z.getComponent("minecraft:health");
    const h = pl.getComponent("minecraft:health");
    if (zh && h) h.setCurrentValue(Math.max(1, Math.min(zh.currentValue, h.effectiveMax)));
  } catch (e) {}
  try {
    pl.teleport(z.location, { dimension: z.dimension });
  } catch (e) {}
  for (const f of found) {
    try {
      f.z.remove();
    } catch (e) {}
  }
  vault.delete(pl.name);
  try {
    world.setDynamicProperty(`varo:oz:${pl.name}`, undefined);
  } catch (e) {}
  pl.sendMessage("§aDein Offline-Zombie wurde zurückgeholt.");
}

function cleanupZombies() {
  const s = S();
  for (const { z, owner } of findZombies(null)) {
    if (!s.started || online(owner)) {
      try {
        z.remove();
      } catch (e) {}
    }
  }
}

/* ----------------------------- Spielablauf ----------------------------- */

function canStart() {
  const s = S();
  if (s.started) return "Varo läuft bereits.";
  const teams = new Set(Object.values(s.players).map((p) => p.team));
  if (teams.size < 2) return "Du brauchst mindestens 2 Teams (/varo:team).";
  return null;
}

function startGame() {
  const s = S();
  const key = dayKey();
  for (const [name, p] of Object.entries(s.players)) {
    p.alive = true;
    p.strikes = 0;
    p.used = 0;
    p.day = key;
    p.locked = false;
    p.wipe = false;
    const pl = online(name);
    if (pl) {
      setMode(pl, GameMode.Survival);
      giveMenu(pl);
    }
  }
  s.started = true;
  s.dayIndex = 0;
  s.lastDay = key;
  s.protection = s.config.protectionMinutes * 60;
  if (s.protection > 0) setPvp(false);
  say(
    `§aVaro startet! §7Spielzeit pro Tag: ${s.config.dailyMinutes} Min` +
      (s.protection > 0 ? `, Schutzzeit: ${s.config.protectionMinutes} Min (kein PvP)` : "")
  );
  save();
}

function endGame(winner) {
  const s = S();
  s.started = false;
  setPvp(true);
  for (const p of Object.values(s.players)) p.wipe = false;
  clearProps(["varo:oz:"]);
  vault.clear();
  cleanupZombies();
  say(winner ? `§aTeam ${winner} gewinnt Varo!` : "§7Varo beendet.");
  save();
}

function checkWin() {
  const s = S();
  if (!s.started) return;
  const alive = Object.keys(teamsAlive());
  const total = new Set(Object.values(s.players).map((p) => p.team)).size;
  if (total >= 2 && alive.length <= 1) endGame(alive[0]);
}

function eliminate(name, reason, where) {
  const p = S().players[name];
  if (!p || !p.alive) return;
  p.alive = false;
  p.locked = false;
  say(`§c${name} §7(Team ${p.team}) ist ausgeschieden${reason ? " - " + reason : ""}!`);
  const pl = online(name);
  try {
    const w = where || (pl ? { dim: pl.dimension, loc: pl.location } : null);
    if (w) dropBackpack(name, w.dim, w.loc);
  } catch (e) {}
  if (pl) {
    setMode(pl, GameMode.Spectator);
    try {
      pl.nameTag = name;
    } catch (e) {}
  }
  checkWin();
  save();
}

function timeUp(pl, p) {
  say(`§7${pl.name} hat die Spielzeit für heute aufgebraucht.`);
  if (S().config.timeAction === "kick") {
    try {
      const r = pl.runCommand(`kick "${pl.name}" Spielzeit für heute aufgebraucht`);
      if (r.successCount > 0) return;
    } catch (e) {}
  }
  p.locked = true;
  setMode(pl, GameMode.Spectator);
  pl.sendMessage("§eDeine Zeit ist vorbei. Morgen geht es weiter!");
}

/* ------------------------------- Haupt-Tick ------------------------------- */

let tickN = 0;

system.runInterval(() => {
  const s = S();
  tickN++;
  if (tickN % 5 === 0) cleanupZombies();
  if (!s.started) return;

  const key = dayKey();
  if (s.lastDay !== key) {
    s.lastDay = key;
    s.dayIndex++;
    say(`§bTag ${s.dayIndex + 1} beginnt!` + (s.border.on ? ` Grenze: ${curRadius()} Blöcke` : ""));
  }

  if (s.protection > 0) {
    s.protection--;
    if (s.protection === 0) {
      setPvp(true);
      say("§cSchutzzeit vorbei - PvP ist jetzt aktiv!");
    }
  }

  const teamCount = Object.keys(teamsAlive()).length;

  for (const pl of world.getAllPlayers()) {
    const p = s.players[pl.name];
    if (!p || !p.alive) continue;

    if (p.day !== key) {
      p.day = key;
      p.used = 0;
    }

    if (p.locked) {
      if (limitSec() - p.used > 0) {
        p.locked = false;
        setMode(pl, GameMode.Survival);
        pl.sendMessage("§aNeuer Tag, neue Spielzeit!");
      }
      continue;
    }

    p.used++;
    const rem = limitSec() - p.used;

    if ([300, 60, 30, 10, 5, 4, 3, 2, 1].includes(rem)) {
      pl.sendMessage(`§eNoch ${fmt(rem)} Spielzeit für heute!`);
      try {
        pl.playSound("note.pling");
      } catch (e) {}
    }
    if (rem <= 0) {
      timeUp(pl, p);
      continue;
    }

    let out = false;
    const b = s.border;
    if (b.on && pl.dimension.id === "minecraft:overworld") {
      const r = curRadius();
      const dx = Math.abs(pl.location.x - b.cx);
      const dz = Math.abs(pl.location.z - b.cz);
      if (Math.max(dx, dz) > r) {
        out = true;
        try {
          pl.applyDamage(1);
        } catch (e) {}
      }
    }

    let txt = `§eZeit ${fmt(rem)} §7| §fTag ${s.dayIndex + 1} §7| §aTeams ${teamCount}`;
    if (s.protection > 0) txt += ` §7| §bSchutz ${fmt(s.protection)}`;
    if (b.on) txt += ` §7| §dGrenze ${curRadius()}`;
    if (out) txt += " §c! AUSSERHALB !";
    pl.onScreenDisplay.setActionBar(txt);
  }

  if (tickN % 10 === 0) save();
}, 20);

/* -------------------------------- Events -------------------------------- */

world.afterEvents.entityDie.subscribe((ev) => {
  try {
    const e = ev.deadEntity;
    if (e.typeId === "minecraft:zombie") return onZombieDeath(ev);
    if (e.typeId !== "minecraft:player") return;
    const s = S();
    const p = s.players[e.name];
    if (!s.started || !p || !p.alive) return;
    const killer = ev.damageSource && ev.damageSource.damagingEntity;
    eliminate(
      e.name,
      killer && killer.typeId === "minecraft:player" ? `getötet von ${killer.name}` : null,
      { dim: e.dimension, loc: e.location }
    );
  } catch (err) {}
});

world.beforeEvents.playerLeave.subscribe(({ player }) => {
  try {
    const s = S();
    const p = s.players[player.name];
    if (!s.config.zombies || !s.started || !p || !p.alive) return;
    if (s.protection > 0) return; // Schutzzeit: kein Zombie
    if (limitSec() - p.used <= 0) return; // Zeit abgelaufen: kein Zombie
    const name = player.name;
    const dim = player.dimension;
    const loc = { x: player.location.x, y: player.location.y, z: player.location.z };
    const items = collectItems(player);
    later(() => spawnOfflineZombie(name, dim, loc, items));
  } catch (err) {}
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  const s = S();
  const p = s.players[player.name];
  if (!p) return;
  if (initialSpawn && p.alive) {
    try {
      player.nameTag = `§7[${p.team}]§r ${player.name}`;
    } catch (e) {}
  }
  if (!s.started) return;

  if (p.wipe && initialSpawn) {
    wipePlayer(player);
    p.wipe = false;
    save();
  }
  if (!p.alive) {
    setMode(player, GameMode.Spectator);
    return;
  }
  if (initialSpawn) {
    restoreFromZombie(player);
    giveMenu(player);
  }
  if (p.day === dayKey() && limitSec() - p.used <= 0) {
    system.runTimeout(() => timeUp(player, p), 40);
  }
});

world.afterEvents.itemUse.subscribe((ev) => {
  const it = ev.itemStack;
  if (it && it.typeId === "minecraft:compass" && it.nameTag === MENU_NAME) openMenu(ev.source);
});

/* -------------------------------- Befehle -------------------------------- */

const ok = (message) => ({ status: CustomCommandStatus.Success, message });
const fail = (message) => ({ status: CustomCommandStatus.Failure, message });

system.beforeEvents.startup.subscribe(({ customCommandRegistry: reg }) => {
  const P = CustomCommandParamType;
  const add = (name, description, handler, mandatory = [], optional = [], any = false) =>
    reg.registerCommand(
      {
        name,
        description,
        permissionLevel: any ? CommandPermissionLevel.Any : CommandPermissionLevel.GameDirectors,
        cheatsRequired: !any,
        mandatoryParameters: mandatory,
        optionalParameters: optional,
      },
      handler
    );

  add(
    "varo:team",
    "Spieler einem Team zuweisen",
    (o, teamName, players) => {
      const s = S();
      if (s.started) return fail("Varo läuft schon.");
      if (!players || !players.length) return fail("Kein Spieler gefunden.");
      if (teamName.length > 16) return fail("Teamname max. 16 Zeichen.");
      for (const pl of players) {
        s.players[pl.name] = { team: teamName, alive: true, strikes: 0, used: 0, day: null, locked: false, wipe: false };
      }
      later(() => {
        for (const pl of players) {
          try {
            pl.nameTag = `§7[${teamName}]§r ${pl.name}`;
          } catch (e) {}
        }
        save();
      });
      return ok(`${players.length} Spieler -> Team ${teamName}`);
    },
    [
      { name: "teamname", type: P.String },
      { name: "spieler", type: P.PlayerSelector },
    ]
  );

  add(
    "varo:remove",
    "Spieler aus Varo entfernen",
    (o, players) => {
      const s = S();
      if (!players || !players.length) return fail("Kein Spieler gefunden.");
      for (const pl of players) delete s.players[pl.name];
      later(() => {
        for (const pl of players) {
          try {
            pl.nameTag = pl.name;
          } catch (e) {}
        }
        save();
      });
      return ok("Entfernt.");
    },
    [{ name: "spieler", type: P.PlayerSelector }]
  );

  add(
    "varo:teamname",
    "Spieler per Name (auch offline) einem Team zuweisen",
    (o, teamName, playerName) => {
      const s = S();
      if (s.started) return fail("Varo läuft schon.");
      const name = (playerName || "").trim();
      if (!name) return fail("Bitte einen Spielernamen angeben.");
      if (teamName.length > 16) return fail("Teamname max. 16 Zeichen.");
      s.players[name] = { team: teamName, alive: true, strikes: 0, used: 0, day: null, locked: false, wipe: false };
      later(() => {
        const pl = online(name);
        if (pl) {
          try {
            pl.nameTag = `§7[${teamName}]§r ${pl.name}`;
          } catch (e) {}
        }
        save();
      });
      return ok(`${name} -> Team ${teamName}${online(name) ? "" : " (offline, Nametag kommt beim nächsten Join)"}`);
    },
    [
      { name: "teamname", type: P.String },
      { name: "spielername", type: P.String },
    ]
  );

  add(
    "varo:removename",
    "Spieler per Name (auch offline) aus Varo entfernen",
    (o, playerName) => {
      const s = S();
      const name = (playerName || "").trim();
      if (!s.players[name]) return fail("Spieler ist nicht in Varo.");
      delete s.players[name];
      later(() => {
        const pl = online(name);
        if (pl) {
          try {
            pl.nameTag = pl.name;
          } catch (e) {}
        }
        save();
      });
      return ok(`${name} entfernt.`);
    },
    [{ name: "spielername", type: P.String }]
  );

  add("varo:start", "Varo starten", () => {
    const err = canStart();
    if (err) return fail(err);
    later(startGame);
    return ok("Varo startet!");
  });

  add("varo:stop", "Varo beenden", () => {
    if (!S().started) return fail("Varo läuft nicht.");
    later(() => endGame(null));
    return ok("Varo beendet.");
  });

  add("varo:reset", "Alle Varo-Daten löschen (inkl. Rucksäcke und Team-Kisten)", () => {
    later(() => {
      for (const pl of world.getAllPlayers()) {
        try {
          pl.nameTag = pl.name;
        } catch (e) {}
      }
      setPvp(true);
      clearProps(["varo:bp:", "varo:tc:", "varo:oz:"]);
      vault.clear();
      state = defaults();
      cleanupZombies();
      save();
    });
    return ok("Varo zurückgesetzt.");
  });

  add(
    "varo:set",
    "Einstellung ändern (dailyMinutes, protectionMinutes, maxStrikes, dayMode, timeAction, zombies)",
    (o, key, value) => {
      const c = S().config;
      if (["dailyMinutes", "protectionMinutes", "maxStrikes"].includes(key)) {
        const n = parseInt(value);
        if (!(n >= 0)) return fail("Bitte eine Zahl angeben.");
        c[key] = n;
      } else if (key === "dayMode") {
        if (!["real", "ingame"].includes(value)) return fail("dayMode: real oder ingame");
        c.dayMode = value;
      } else if (key === "timeAction") {
        if (!["kick", "spectator"].includes(value)) return fail("timeAction: kick oder spectator");
        c.timeAction = value;
      } else if (key === "zombies") {
        if (!["an", "aus", "true", "false"].includes(value)) return fail("zombies: an oder aus");
        c.zombies = value === "an" || value === "true";
      } else {
        return fail("Unbekannt. Keys: dailyMinutes, protectionMinutes, maxStrikes, dayMode, timeAction, zombies");
      }
      later(save);
      return ok(`${key} = ${value}`);
    },
    [
      { name: "key", type: P.String },
      { name: "wert", type: P.String },
    ]
  );

  add(
    "varo:border",
    "Grenze setzen (Mitte = deine Position, radius 0 = aus)",
    (o, radius, shrink) => {
      const loc = o.sourceEntity ? o.sourceEntity.location : { x: 0, z: 0 };
      S().border = {
        on: radius > 0,
        cx: Math.round(loc.x),
        cz: Math.round(loc.z),
        radius,
        shrink: shrink ?? 0,
      };
      later(save);
      return ok(radius > 0 ? `Grenze: ${radius} Blöcke, schrumpft ${shrink ?? 0}/Tag` : "Grenze aus.");
    },
    [{ name: "radius", type: P.Integer }],
    [{ name: "schrumpfung", type: P.Integer }]
  );

  add(
    "varo:strike",
    "Spieler einen Strike geben",
    (o, players, reason) => {
      const pl = players && players[0];
      if (!pl) return fail("Kein Spieler gefunden.");
      const p = S().players[pl.name];
      if (!p) return fail("Spieler ist nicht in Varo.");
      p.strikes++;
      const max = S().config.maxStrikes;
      later(() => {
        say(`§eStrike ${p.strikes}/${max} für ${pl.name}${reason ? ": " + reason : ""}`);
        if (S().started && p.strikes >= max) eliminate(pl.name, "zu viele Strikes");
        save();
      });
      return ok(`Strike für ${pl.name}`);
    },
    [{ name: "spieler", type: P.PlayerSelector }],
    [{ name: "grund", type: P.String }]
  );

  add(
    "varo:revive",
    "Ausgeschiedenen Spieler wieder reinholen",
    (o, players) => {
      const pl = players && players[0];
      const p = pl && S().players[pl.name];
      if (!p) return fail("Spieler ist nicht in Varo.");
      p.alive = true;
      p.strikes = 0;
      later(() => {
        setMode(pl, GameMode.Survival);
        try {
          pl.nameTag = `§7[${p.team}]§r ${pl.name}`;
        } catch (e) {}
        say(`§a${pl.name} ist wieder dabei!`);
        save();
      });
      return ok(`${pl.name} wiederbelebt.`);
    },
    [{ name: "spieler", type: P.PlayerSelector }]
  );

  add(
    "varo:give",
    "Varo-Menü-Kompass an Spieler geben",
    (o, players) => {
      if (!players || !players.length) return fail("Kein Spieler gefunden.");
      later(() => players.forEach(giveMenu));
      return ok("Varo-Menü verteilt.");
    },
    [{ name: "spieler", type: P.PlayerSelector }]
  );

  add(
    "varo:menu",
    "Varo-Menü öffnen (Rucksack, Team-Kiste, Status) - Chat danach schließen",
    (o) => {
      const pl = o.sourceEntity;
      if (!pl || pl.typeId !== "minecraft:player") return fail("Nur für Spieler.");
      later(() => openMenu(pl));
      return ok("Menü öffnet sich, sobald du den Chat schließt.");
    },
    [],
    [],
    true
  );

  add("varo:status", "Varo-Status anzeigen", () => {
    const s = S();
    const lines = [
      `§6Varo: ${s.started ? "läuft (Tag " + (s.dayIndex + 1) + ")" : "nicht gestartet"}`,
      `§7Spielzeit/Tag: ${s.config.dailyMinutes} Min | Schutz: ${s.config.protectionMinutes} Min | Strikes: ${s.config.maxStrikes}`,
      `§7dayMode: ${s.config.dayMode} | timeAction: ${s.config.timeAction} | Zombies: ${s.config.zombies ? "an" : "aus"}`,
    ];
    const teams = {};
    for (const [n, p] of Object.entries(s.players)) {
      (teams[p.team] ||= []).push(`${p.alive ? "§a" : "§c"}${n}§7(${p.strikes})`);
    }
    for (const [t, m] of Object.entries(teams)) lines.push(`§f${t}: ${m.join("§7, ")}`);
    return ok(lines.join("\n"));
  });
});
