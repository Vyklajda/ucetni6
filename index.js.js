const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { MongoClient } = require('mongodb');
const http = require('http');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

// ── Mini web server pro Render ────────────────────────────────────────────────
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
}).listen(port);

// ── Ceny ─────────────────────────────────────────────────────────────────────
const CENA_ZA_DIL        = 300;  
const CENA_OPRAVA        = 6000;   // Upraveno z 12000 na 6000
const CENA_VYJEZD_MESTO  = 10000;  // Upraveno z 20000 na 10000
const CENA_VYJEZD_VENKOV = 30000;  // Upraveno z 40000 na 30000
const CENA_TANKOVANI     = 7000;   // Upraveno z 10000 na 7000

// Ekologické parametry jednoho dílu (podle Tygerva + tvé úpravy)
const REALNA_CENA_DILU   = 100; // Skutečná nákupní cena dílu
const ODVOD_GOV          = 35;  // Vládní daň / odvod z dílu
const NA_RUKU_MECHANIK   = 35;  // Fixní částka za montáž dílu mechanikovi

// ── Názvy Discord rolí ────────────────────────────────────────────────────────
const ROLE_MAJITEL = '👑│Majitel';
const ROLE_MANAZER = '⭐️│Manažer';
const ROLE_HL_MECH = '⚙️│Hl. Mechanik';
const ROLE_MECH    = '🔧│Mechanik';
const ROLE_ZK_MECH = '🔨│Zk. Mechanik';

const KOEFICIENTY = {
  [ROLE_MAJITEL]: 0.70,
  [ROLE_MANAZER]: 0.65,
  [ROLE_HL_MECH]: 0.45,
  [ROLE_MECH]:    0.40,
  [ROLE_ZK_MECH]: 0.35,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function hasBossRole(member) {
  return member.roles.cache.some(r => r.name === ROLE_MAJITEL || r.name === ROLE_MANAZER);
}

function getMechRole(member) {
  for (const role of [ROLE_MAJITEL, ROLE_MANAZER, ROLE_HL_MECH, ROLE_MECH, ROLE_ZK_MECH]) {
    if (member.roles.cache.some(r => r.name === role)) return role;
  }
  return null;
}

function fmt(n) { return `$${Number(n).toLocaleString()}`; }

// Počítá celkovou fakturovanou hodnotu (pro zákazníka)
function calculateFaktura(emp) {
  const t = emp.tunings.reduce((s, x) => s + x.dilu * x.cena, 0);
  const o = emp.opravy.reduce((s, x) => s + x.cena, 0);
  return t + o;
}

// Výpočet ekonomicky správné výplaty
function calculateCistaVyplata(emp, koeficient) {
  let celkovyZiskZTuningu = 0;
  let fixniSlozkaZaDily = 0;

  // 1. Spočítáme tuning podle nové ekonomiky
  emp.tunings.forEach(x => {
    // Procenta se počítají z čistého zisku po odečtení nákladů
    const cistyZiskZDilu = x.cena - REALNA_CENA_DILU - ODVOD_GOV - NA_RUKU_MECHANIK;
    
    // Celkový zisk firmy z této várky tuningů, ze kterého jdou procenta
    celkovyZiskZTuningu += (x.dilu * cistyZiskZDilu);
    
    // Fixní odměna pro mechanika za odvedenou práci na dílech (35$ za díl rovnou na ruku)
    fixniSlozkaZaDily += (x.dilu * NA_RUKU_MECHANIK);
  });

  // Procentuální odměna z čistého zisku tuningu
  const vyplataZTuningu = celkovyZiskZTuningu * koeficient;

  // 2. Spočítáme opravy a výjezdy (zůstává starý systém s 10% srážkou čisté faktury)
  const celkoveOpravyFaktura = emp.opravy.reduce((s, x) => s + x.cena, 0);
  const vyplataZOprav = celkoveOpravyFaktura * 0.9 * koeficient;

  // Výsledná výplata = (procenta z tuningu) + (fixní peníze za díly na ruku) + (procenta z oprav)
  return Math.round(vyplataZTuningu + fixniSlozkaZaDily + vyplataZOprav);
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('mechanik-bot');
  console.log('✅ MongoDB připojeno');
}

async function getEmployee(userId, username) {
  const col = db.collection('employees');
  let emp = await col.findOne({ userId });
  if (!emp) {
    emp = { userId, username, tunings: [], opravy: [] };
    await col.insertOne(emp);
  }
  return emp;
}

async function saveEmployee(userId, data) {
  await db.collection('employees').updateOne({ userId }, { $set: data });
}

// ── Discord bot ───────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => console.log(`✅ Bot online: ${client.user.tag}`));

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.member) return;

  const args = message.content.trim().split(/\s+/);
  const cmd  = args[0].toLowerCase();

  const prikazy = ['!tuning','!oprava','!vyjezdm','!vyjezdv','!tankovani','!tankování','!výplata','!vyplata','!stav','!help','!pomoc'];
  if (!prikazy.includes(cmd)) return;

  const isBoss = hasBossRole(message.member);

  // ── !help ─────────────────────────────────────────────────────────────────
  if (cmd === '!help' || cmd === '!pomoc') {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('📋 Příkazy bota')
      .addFields(
        { name: '`!tuning <dílů>`', value: 'Zaznamenání tuningu' },
        { name: '`!oprava`',        value: 'Zaznamenání opravy' },
        { name: '`!vyjezdm` / `!vyjezdv` / `!tankovani`', value: 'Výjezd město / mimo město / dotankování' },
      );

    if (isBoss) {
      embed.addFields(
        { name: '`!výplata @uživatel`', value: 'Zobrazí a resetuje výplatu zaměstnance' },
        { name: '`!stav @uživatel`',    value: 'Aktuální záznamy zaměstnance' },
      );
    }

    return message.reply({ embeds: [embed] });
  }

  // ── !tuning <dílů> [cena] ─────────────────────────────────────────────────
  if (cmd === '!tuning') {
    const dilu = parseInt(args[1]);
    const cena = parseInt(args[2]) || CENA_ZA_DIL;

    if (isNaN(dilu) || dilu <= 0)
      return message.reply('❌ Použití: `!tuning <počet_dílů>`');

    const emp = await getEmployee(message.author.id, message.author.username);
    emp.tunings.push({ dilu, cena, timestamp: Date.now() });
    await saveEmployee(message.author.id, { tunings: emp.tunings });

    const embed = new EmbedBuilder()
      .setColor(0x00b4d8)
      .setTitle('✅ Tuning zaznamenaný')
      .addFields(
        { name: 'Počet dílů',    value: `${dilu}`,                    inline: true },
        { name: 'Cena za díl',   value: fmt(cena),                    inline: true },
        { name: '\u200b',        value: '\u200b',                     inline: true },
        { name: 'Faktura',       value: fmt(dilu * cena),             inline: true },
        { name: 'Počet tuningu', value: `${emp.tunings.length}x`,     inline: true },
        { name: 'Základ celkem', value: fmt(calculateFaktura(emp)),   inline: true },
      )
      .setFooter({ text: `${message.guild?.name} • ${new Date().toLocaleString('cs-CZ')}` });

    return message.reply({ embeds: [embed] });
  }

  // ── !oprava [cena] ────────────────────────────────────────────────────────
  if (cmd === '!oprava') {
    const cena = parseInt(args[1]) || CENA_OPRAVA;

    const emp = await getEmployee(message.author.id, message.author.username);
    emp.opravy.push({ cena, timestamp: Date.now() });
    await saveEmployee(message.author.id, { opravy: emp.opravy });

    const embed = new EmbedBuilder()
      .setColor(0xf4a261)
      .setTitle('🔧 Oprava zaznamenaná')
      .addFields(
        { name: 'Cena opravy',   value: fmt(cena),                  inline: true },
        { name: 'Počet oprav',   value: `${emp.opravy.length}x`,    inline: true },
        { name: 'Základ celkem', value: fmt(calculateFaktura(emp)), inline: true },
      )
      .setFooter({ text: `${message.guild?.name} • ${new Date().toLocaleString('cs-CZ')}` });

    return message.reply({ embeds: [embed] });
  }

  // ── !vyjezdm ──────────────────────────────────────────────────────────────
  if (cmd === '!vyjezdm') {
    const emp = await getEmployee(message.author.id, message.author.username);
    emp.opravy.push({ cena: CENA_VYJEZD_MESTO, timestamp: Date.now() });
    await saveEmployee(message.author.id, { opravy: emp.opravy });

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('🚗 Výjezd v městě zaznamenaný')
      .addFields(
        { name: 'Cena výjezdu',  value: fmt(CENA_VYJEZD_MESTO),    inline: true },
        { name: 'Zahrnuje',      value: 'Oprava + mytí auta',       inline: true },
        { name: 'Základ celkem', value: fmt(calculateFaktura(emp)), inline: true },
      )
      .setFooter({ text: `${message.guild?.name} • ${new Date().toLocaleString('cs-CZ')}` });

    return message.reply({ embeds: [embed] });
  }

  // ── !vyjezdv ──────────────────────────────────────────────────────────────
  if (cmd === '!vyjezdv') {
    const emp = await getEmployee(message.author.id, message.author.username);
    emp.opravy.push({ cena: CENA_VYJEZD_VENKOV, timestamp: Date.now() });
    await saveEmployee(message.author.id, { opravy: emp.opravy });

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('🛻 Výjezd mimo město zaznamenaný')
      .addFields(
        { name: 'Cena výjezdu',  value: fmt(CENA_VYJEZD_VENKOV),   inline: true },
        { name: 'Zahrnuje',      value: 'Oprava + mytí auta',       inline: true },
        { name: 'Základ celkem', value: fmt(calculateFaktura(emp)), inline: true },
      )
      .setFooter({ text: `${message.guild?.name} • ${new Date().toLocaleString('cs-CZ')}` });

    return message.reply({ embeds: [embed] });
  }

  // ── !tankovani ────────────────────────────────────────────────────────────
  if (cmd === '!tankovani' || cmd === '!tankování') {
    const emp = await getEmployee(message.author.id, message.author.username);
    emp.opravy.push({ cena: CENA_TANKOVANI, timestamp: Date.now() });
    await saveEmployee(message.author.id, { opravy: emp.opravy });

    const embed = new EmbedBuilder()
      .setColor(0x27ae60)
      .setTitle('⛽ Dotankování zaznamenaný')
      .addFields(
        { name: 'Příplatek',     value: fmt(CENA_TANKOVANI),        inline: true },
        { name: 'Základ celkem', value: fmt(calculateFaktura(emp)), inline: true },
      )
      .setFooter({ text: `${message.guild?.name} • ${new Date().toLocaleString('cs-CZ')}` });

    return message.reply({ embeds: [embed] });
  }

  // ── !výplata @uživatel (pouze Majitel / Manažer) ──────────────────────────
  if (cmd === '!výplata' || cmd === '!vyplata') {
    if (!isBoss)
      return message.reply('❌ Tento příkaz mohou používat pouze Majitel a Manažer.');

    const target = message.mentions.members?.first();
    if (!target)
      return message.reply('❌ Použití: `!výplata @uživatel`');

    const mechRole = getMechRole(target);
    if (!mechRole)
      return message.reply('❌ Tento uživatel nemá roli mechanika.');

    const koef = KOEFICIENTY[mechRole];
    const emp  = await getEmployee(target.id, target.user.username);
    
    const d    = calculateFaktura(emp);
    const k    = calculateCistaVyplata(emp, koef);

    await saveEmployee(target.id, { tunings: [], opravy: [] });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`💰 Výplata — ${target.user.username}`)
      .setDescription(`Role: **${mechRole}**`)
      .addFields(
        { name: 'Celková faktura',  value: fmt(d),                            inline: true },
        { name: 'Nastavená procenta',value: `${koef * 100}%`,                 inline: true },
        { name: 'Konečná výplata',   value: `**${fmt(k)}**`,                  inline: true },
      )
      .setFooter({ text: `Záznamy resetovány • ${new Date().toLocaleString('cs-CZ')}` });

    return message.reply({ embeds: [embed] });
  }

  // ── !stav @uživatel (pouze Majitel / Manažer) ─────────────────────────────
  if (cmd === '!stav') {
    if (!isBoss)
      return message.reply('❌ Tento příkaz mohou používat pouze Majitel a Manažer.');

    const target = message.mentions.members?.first();
    if (!target)
      return message.reply('❌ Použití: `!stav @uživatel`');

    const mechRole = getMechRole(target);
    const emp  = await getEmployee(target.id, target.user.username);
    
    const d    = calculateFaktura(emp);
    const koef = mechRole ? KOEFICIENTY[mechRole] : 0;
    const k    = calculateCistaVyplata(emp, koef);

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`📊 Stav — ${target.user.username}`)
      .addFields(
        { name: 'Role',           value: mechRole ?? 'Neznámá',     inline: true },
        { name: 'Počet tuningu',  value: `${emp.tunings.length}x`,  inline: true },
        { name: 'Počet oprav',    value: `${emp.opravy.length}x`,   inline: true },
        { name: 'Celková faktura', value: fmt(d),                    inline: true },
        { name: 'Odh. výplata',   value: fmt(k),                    inline: true },
      )
      .setFooter({ text: new Date().toLocaleString('cs-CZ') });

    return message.reply({ embeds: [embed] });
  }
});

connectDB().then(() => client.login(DISCORD_TOKEN));