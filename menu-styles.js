// ╔══════════════════════════════════════════╗
// ║     MALIYA-MD · UNIFIED LUXURY STYLE     ║
// ╚══════════════════════════════════════════╝

// ══════════════════════════════════════════════
//  MAIN MENU — LUXURY UNIFIED
// ══════════════════════════════════════════════
function getMobileMenu(userName = "User") {
  const { time, date } = nowLK();
  const { map } = buildCommandMapCached();
  const cats = Object.keys(map).length;

  return `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       🌟 *MALIYA-MD* 🌟       ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

╭─「 👤 *USER INFO* 」──────────╮
│
│  🙋 *Name*    »  ${userName}
│  👑 *Owner*   »  ${OWNER_NUMBER}
│  ⚡ *Prefix*  »  \`${PREFIX}\`
│
╰─────────────────────────────╯

╭─「 🕐 *DATE & TIME* 」─────────╮
│
│  🗓 *Date*    »  ${date}
│  🕐 *Time*    »  ${time}
│
╰─────────────────────────────╯

╭─「 📊 *STATISTICS* 」──────────╮
│
│  📌 *Commands* »  ${commands.length}
│  📂 *Cats*     »  ${cats}
│  🟢 *Status*   »  Online
│
╰─────────────────────────────╯

✦━━━━━━━━━━━━━━━━━━━━━━━━━━━━✦
     🎯 *Select a category below*
✦━━━━━━━━━━━━━━━━━━━━━━━━━━━━✦`;
}

// ══════════════════════════════════════════════
//  COMMAND LIST — LUXURY UNIFIED (matches menu)
// ══════════════════════════════════════════════
function getMobileCommandList(category, list, userName = "User") {
  const emoji = getCategoryEmoji(category);
  const total = list.length;
  const displayCmds = list.slice(0, 10);

  let result = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃   ${emoji} *${category.toUpperCase()}* COMMANDS   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

╭─「 👤 *USER INFO* 」──────────╮
│
│  🙋 *Name*    »  ${userName}
│  📦 *Total*   »  ${total} cmds
│  ⚡ *Prefix*  »  \`${PREFIX}\`
│
╰─────────────────────────────╯

╭─「 ${emoji} *COMMANDS* 」───────────╮
│\n`;

  for (const cmd of displayCmds) {
    const name = cmd.pattern ? `${PREFIX}${cmd.pattern}` : "No Pattern";
    const desc = cmd.desc || "No description";
    result += `│  ✦ *${name}*\n│     ↳ ${desc.substring(0, 28)}\n│\n`;
  }

  if (list.length > 10) {
    result += `│  ＋ *${list.length - 10} more commands...*\n│\n`;
  }

  result += `╰─────────────────────────────╯

✦━━━━━━━━━━━━━━━━━━━━━━━━━━━━✦
        👑 *${OWNER_NUMBER}*
✦━━━━━━━━━━━━━━━━━━━━━━━━━━━━✦`;

  return result;
}

// ══════════════════════════════════════════════
//  STYLE SELECTORS (single unified style)
// ══════════════════════════════════════════════
function getMenuStyle(userName = "User") {
  return getMobileMenu(userName);
}

function getCommandListStyle(category, list, userName = "User") {
  return getMobileCommandList(category, list, userName);
}

// ══════════════════════════════════════════════
//  SEND MENU (unchanged — drop-in compatible)
// ══════════════════════════════════════════════
async function sendMobileMenu(sock, from, mek, userName) {
  const { map, categories } = buildCommandMapCached();

  if (!categories.length) {
    throw new Error("No commands found!");
  }

  const menuText = getMenuStyle(userName);

  const interactiveMessage = {
    image: { url: headerImage },
    text: menuText,
    footer: `${BOT_NAME} | Interactive Menu`,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "📂 Categories",
          sections: [
            {
              title: "Command Categories",
              rows: categories.map((cat) => ({
                title: `${getCategoryEmoji(cat)} ${cat}`,
                description: `${map[cat].length} commands`,
                id: `menu_cat:${cat}`,
              })),
            },
          ],
        }),
      },
      {
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: "🌐 Website",
          url: "https://maliya-md.replit.app",
        }),
      },
      {
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: "📋 Copy Owner",
          copy_code: OWNER_NUMBER,
        }),
      },
    ],
  };

  return sendInteractiveMessage(sock, from, interactiveMessage, { quoted: mek });
}

// ══════════════════════════════════════════════
//  COMMANDS
// ══════════════════════════════════════════════
cmd(
  {
    pattern: "menu",
    react: "🌟",
    desc: "Show interactive command menu",
    category: "main",
    filename: __filename,
  },
  async (sock, mek, m, { from, sender, pushname, reply }) => {
    try {
      await sock.sendMessage(from, { react: { text: "🌟", key: mek.key } });

      const userName = getUserName(pushname, m, mek, sender);
      const sessionKey = getSessionKey(sender, from);
      const { map, categories } = buildCommandMapCached();

      menuSessions.set(sessionKey, {
        map,
        categories,
        userName,
        timestamp: Date.now(),
      });

      await sendMobileMenu(sock, from, mek, userName);
    } catch (e) {
      console.error("MENU ERROR:", e);
      reply("❌ Menu load karanna bari una. Retry karanna.");
    }
  }
);

cmd(
  {
    filter: (text, { sender, from }) => menuSessions.has(getSessionKey(sender, from)),
    dontAddCommandList: true,
    filename: __filename,
  },
  async (sock, mek, m, { body, from, sender, pushname, reply }) => {
    try {
      const sessionKey = getSessionKey(sender, from);
      const session = menuSessions.get(sessionKey);
      if (!session) return;

      let selectedId = null;

      try {
        const paramsJson =
          m?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
        if (paramsJson) {
          const params = JSON.parse(paramsJson);
          selectedId = params.id || params.selectedId || params.selectedRowId;
        }
      } catch (_) {}

      if (!selectedId) {
        selectedId = m?.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
      }

      if (!selectedId && body) {
        const match = body.match(/menu_cat:(.+)/i);
        if (match) selectedId = match[1];
      }

      if (!selectedId || !selectedId.startsWith("menu_cat:")) return;

      const category = selectedId.replace("menu_cat:", "").trim();
      const list = session.map[category] || [];
      if (!list.length) return reply(`❌ No commands found in "${category}"`);

      const userName = session.userName || getUserName(pushname, m, mek, sender);

      await sock.sendMessage(from, {
        react: { text: getCategoryEmoji(category), key: mek.key },
      });

      const commandList = getCommandListStyle(category, list, userName);

      await sock.sendMessage(
        from,
        { image: { url: headerImage }, caption: commandList },
        { quoted: mek }
      );

      session.timestamp = Date.now();
      menuSessions.set(sessionKey, session);
    } catch (e) {
      console.error("MENU REPLY ERROR:", e);
    }
  }
);
