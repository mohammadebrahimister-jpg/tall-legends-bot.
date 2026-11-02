const BOT_API = "https://api.telegram.org/bot";

const GROUP_CHAT_ID = "-1003920704799";

// Registration notification destination: the "چت" forum topic.
const REGISTRATION_TOPIC_THREAD_ID = 1499;



async function telegramCall(token, method, payload) {

  const response = await fetch(`${BOT_API}${token}/${method}`, {

    method: "POST",

    headers: { "Content-Type": "application/json" },

    body: JSON.stringify(payload)

  });

  return await response.json();

}



async function sendMessage(token, chatId, text, messageThreadId = null) {

  const payload = {

    chat_id: chatId,

    text,

    reply_markup: { remove_keyboard: true }

  };

  if (messageThreadId !== null && messageThreadId !== undefined) {

    payload.message_thread_id = messageThreadId;

  }

  const result = await telegramCall(token, "sendMessage", payload);

  if (!result.ok) console.error("Telegram sendMessage error:", result);

  return result;

}



async function isGroupAdmin(token, groupId, userId) {

  const result = await telegramCall(token, "getChatMember", {

    chat_id: groupId,

    user_id: userId

  });

  return result.ok && ["creator", "administrator"].includes(result.result.status);

}



async function isGroupMember(token, groupId, userId) {

  const result = await telegramCall(token, "getChatMember", {

    chat_id: groupId,

    user_id: userId

  });

  if (!result.ok) return false;

  const member = result.result;

  return member.status === "creator" || member.status === "administrator" ||

    member.status === "member" || (member.status === "restricted" && member.is_member === true);

}



async function releaseRegisteredMember(token, userId) {

  const inGroup = await isGroupMember(token, GROUP_CHAT_ID, Number(userId));

  if (!inGroup) return { ok: false, skipped: true };



  return await telegramCall(token, "restrictChatMember", {

    chat_id: GROUP_CHAT_ID,

    user_id: Number(userId),

    use_independent_chat_permissions: true,

    permissions: {

      can_send_messages: true,

      can_send_audios: true,

      can_send_documents: true,

      can_send_photos: true,

      can_send_videos: true,

      can_send_video_notes: true,

      can_send_voice_notes: true,

      can_send_polls: true,

      can_send_other_messages: true,

      can_add_web_page_previews: true

    }

  });

}





async function restrictUnregisteredMember(token, userId) {
  const numericId = Number(userId);
  if (!Number.isSafeInteger(numericId)) return { ok: false, error: "invalid_user_id" };

  // Never restrict group administrators or the owner.
  if (await isGroupAdmin(token, GROUP_CHAT_ID, numericId)) {
    return { ok: true, skipped: true, reason: "administrator" };
  }

  return await telegramCall(token, "restrictChatMember", {
    chat_id: GROUP_CHAT_ID,
    user_id: numericId,
    use_independent_chat_permissions: true,
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false
    }
  });
}

// Temporary notices are deleted by a Cron Trigger after 5 minutes.
// With a once-per-minute Cron Trigger, deletion normally occurs within 5-6 minutes.
const NOTICE_DELETE_AFTER_SECONDS = 300;

async function ensureScheduledDeletionTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS scheduled_message_deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    delete_at INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_message_deletions_due
    ON scheduled_message_deletions (delete_at)`).run();
}

async function scheduleMessageDeletion(env, chatId, messageId) {
  await ensureScheduledDeletionTable(env.DB);
  const deleteAt = Math.floor(Date.now() / 1000) + NOTICE_DELETE_AFTER_SECONDS;
  await env.DB.prepare(`INSERT INTO scheduled_message_deletions (chat_id, message_id, delete_at)
    VALUES (?, ?, ?)`).bind(String(chatId), Number(messageId), deleteAt).run();
}

async function sendTemporaryNotice(token, env, text, threadId = REGISTRATION_TOPIC_THREAD_ID) {
  const sent = await sendMessage(token, GROUP_CHAT_ID, text, threadId);
  if (sent.ok && sent.result?.message_id) {
    await scheduleMessageDeletion(env, GROUP_CHAT_ID, sent.result.message_id);
  }
  return sent;
}

async function processScheduledDeletions(env) {
  await ensureScheduledDeletionTable(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(`SELECT id, chat_id, message_id
    FROM scheduled_message_deletions WHERE delete_at <= ? ORDER BY delete_at ASC LIMIT 100`).bind(now).all();
  for (const item of (due.results || [])) {
    const result = await telegramCall(env.BOT_TOKEN, "deleteMessage", {
      chat_id: item.chat_id, message_id: item.message_id
    });
    if (result.ok || (result.error_code >= 400 && result.error_code < 500 && result.error_code !== 429)) {
      await env.DB.prepare("DELETE FROM scheduled_message_deletions WHERE id = ?").bind(item.id).run();
    } else {
      console.error("Scheduled notice deletion will be retried:", item.id, result);
    }
  }
}

async function handleNewGroupMembers(message, env, ctx) {
  const token = env.BOT_TOKEN;
  const db = env.DB;
  const threadId = message.message_thread_id ?? null;

  for (const user of (message.new_chat_members || [])) {
    if (user.is_bot) continue;

    const userId = String(user.id);
    await db.prepare(`
      INSERT OR IGNORE INTO members
        (telegram_id, username, first_name, last_name, registration_status)
      VALUES (?, ?, ?, ?, 'pending')
    `).bind(
      userId,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    ).run();
    const record = await db.prepare(
      "SELECT registration_status FROM members WHERE telegram_id = ?"
    ).bind(userId).first();

    if (record && record.registration_status === "completed") {
      const released = await releaseRegisteredMember(token, userId);
      if (!released.ok) console.error("Release existing registered member failed:", userId, released);
      continue;
    }

    const restricted = await restrictUnregisteredMember(token, userId);
    if (!restricted.ok) {
      console.error("Restrict new unregistered member failed:", userId, restricted);
      if (threadId !== null) {
        await sendMessage(token, message.chat.id,
          "⚠️ محدودسازی خودکار این عضو انجام نشد. مدیر گروه باید دسترسی Ban Users ربات را بررسی کند.", threadId);
      }
    } else {
      const displayName = String(user.first_name || "دوست عزیز").replace(/[\r\n]+/g, " ").trim();
      await sendTemporaryNotice(token, env,
        `🚨🔒 اطلاعیه ثبت‌نام عضو جدید

👋 خوش آمدی، ${displayName}!

برای ارسال پیام در گروه TALL Legends، ابتدا ثبت‌نامت را در ربات کامل کن:
🤖 https://t.me/TALLLegends_bot

✅ پس از تأیید نهایی، دسترسی‌ات خودکار فعال می‌شود.`,
        REGISTRATION_TOPIC_THREAD_ID);
    }
  }
}

async function handleExistingMemberMessage(message, env, ctx) {
  const token = env.BOT_TOKEN;
  const db = env.DB;
  const user = message.from;
  if (!user || user.is_bot) return;

  // Admins are exempt. This check is performed against Telegram, not a local username list.
  if (await isGroupAdmin(token, GROUP_CHAT_ID, user.id)) return;

  const userId = String(user.id);
  const record = await db.prepare(
    "SELECT registration_status FROM members WHERE telegram_id = ?"
  ).bind(userId).first();

  if (record?.registration_status === "completed") return;

  // Record the first time an unregistered legacy member is detected.
  await db.prepare(`
    INSERT OR IGNORE INTO members
      (telegram_id, username, first_name, last_name, registration_status)
    VALUES (?, ?, ?, ?, 'pending')
  `).bind(
    userId,
    user.username || null,
    user.first_name || null,
    user.last_name || null
  ).run();

  const restricted = await restrictUnregisteredMember(token, userId);
  if (!restricted.ok) {
    console.error("Could not restrict unregistered member:", userId, restricted);
    await sendMessage(token, GROUP_CHAT_ID,
      `⚠️ محدودسازی ${user.first_name || "عضو"} انجام نشد. دسترسی Ban Users ربات را بررسی کنید.`,
      REGISTRATION_TOPIC_THREAD_ID);
    return;
  }

  // Remove the first unregistered message so it does not remain visible in the group.
  const deleted = await telegramCall(token, "deleteMessage", {
    chat_id: GROUP_CHAT_ID,
    message_id: message.message_id
  });
  if (!deleted.ok) console.error("Could not delete unregistered member message:", deleted);

  const displayName = String([user.first_name, user.last_name].filter(Boolean).join(" ") || "دوست عزیز")
    .replace(/[\r\n]+/g, " ").trim();
  await sendTemporaryNotice(token, env,
    `🚨🔒 عضو ثبت‌نام‌نشده شناسایی شد\n\n👤 ${displayName}\n\nبرای ارسال پیام در گروه TALL Legends، ثبت‌نام را در ربات کامل کن:\n🤖 https://t.me/TALLLegends_bot\n\n✅ پس از تأیید نهایی، دسترسی‌ات خودکار فعال می‌شود.`,
    REGISTRATION_TOPIC_THREAD_ID);
}

async function getRegistrationStats(db) {
  return await db.prepare(`
    SELECT
      COUNT(*) AS tracked,
      SUM(CASE WHEN registration_status = 'completed' THEN 1 ELSE 0 END) AS registered,
      SUM(CASE WHEN registration_status IS NULL OR registration_status != 'completed' THEN 1 ELSE 0 END) AS pending
    FROM members
  `).first();
}

// Analytics schema: completion timestamp and last-seen activity for reporting.
async function ensureAnalyticsSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS member_activity (
    telegram_id TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER NOT NULL DEFAULT 0
  )`).run();
  try {
    await db.prepare("ALTER TABLE members ADD COLUMN registration_completed_at TEXT").run();
  } catch (error) {
    // Column already exists on databases that have received this migration.
  }
  await db.prepare(`UPDATE members SET registration_completed_at = updated_at
    WHERE registration_status = 'completed' AND registration_completed_at IS NULL`).run();
}

async function trackMemberActivity(db, user) {
  if (!user || user.is_bot) return;
  await db.prepare(`INSERT INTO member_activity (telegram_id, last_seen_at, message_count)
    VALUES (?, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(telegram_id) DO UPDATE SET
      last_seen_at = CURRENT_TIMESTAMP,
      message_count = member_activity.message_count + 1`).bind(String(user.id)).run();
}

function monthNameFa(month) {
  return ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'][month - 1] || '';
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

async function sendMembersCsv(token, chatId, db) {
  const result = await db.prepare(`
    SELECT telegram_id, username, first_name, last_name, birth_day, birth_month, birth_year,
           residence, height_cm, job, sport, registration_status, created_at, updated_at
    FROM members ORDER BY created_at DESC
  `).all();
  const rows = result.results || [];
  const headers = ["telegram_id", "username", "first_name", "last_name", "birth_day", "birth_month", "birth_year",
    "residence", "height_cm", "job", "sport", "registration_status", "created_at", "updated_at"];
  const csv = "\uFEFF" + [headers, ...rows.map(row => headers.map(key => row[key] ?? ""))]
    .map(row => row.map(csvCell).join(",")).join("\r\n");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", `📊 خروجی اعضای TALL Legends\nتعداد رکوردها: ${rows.length}\nاین فایل شامل اطلاعات شخصی اعضاست؛ آن را محرمانه نگه دار.`);
  form.append("document", new Blob([csv], { type: "text/csv;charset=utf-8" }), "tall-legends-members.csv");
  const response = await fetch(`${BOT_API}${token}/sendDocument`, { method: "POST", body: form });
  const sent = await response.json();
  if (!sent.ok) console.error("CSV export failed:", sent);
  return sent;
}

function normalizeDigits(value) {

  const persian = "۰۱۲۳۴۵۶۷۸۹";

  const arabic = "٠١٢٣٤٥٦٧٨٩";

  return String(value)

    .replace(/[۰-۹]/g, d => String(persian.indexOf(d)))

    .replace(/[٠-٩]/g, d => String(arabic.indexOf(d)))

    .trim();

}



function normalizePersianText(text) {
  return String(text || "")
    .normalize("NFC")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ۀ/g, "ه")
    .replace(/ة/g, "ه")
    .replace(/أ|إ|ٱ/g, "ا")
    .replace(/[\u200c\u200e\u200f\u0640]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}


function mod(a, b) {

  return a - Math.floor(a / b) * b;

}



function isJalaliLeapYear(jy) {

  const breaks = [

    -61, 9, 38, 199, 426, 686, 756, 818, 1111,

    1181, 1210, 1635, 2060, 2097, 2192, 2262,

    2324, 2394, 2456, 3178

  ];



  if (jy < breaks[0] || jy >= breaks[breaks.length - 1]) return false;



  let leapJ = -14;

  let jp = breaks[0];

  let jump = 0;

  let jm = 0;



  for (let i = 1; i < breaks.length; i++) {

    jm = breaks[i];

    jump = jm - jp;

    if (jy < jm) break;

    leapJ += Math.floor(jump / 33) * 8 + Math.floor((jump % 33) / 4);

    jp = jm;

  }



  const n = jy - jp;

  leapJ += Math.floor(n / 33) * 8 + Math.floor(((n % 33) + 3) / 4);

  if ((jump % 33) === 4 && (jump - n) === 4) leapJ++;



  const gy = jy + 621;

  const leapG = Math.floor(gy / 4) -

    Math.floor((Math.floor(gy / 100) + 1) * 3 / 4) - 150;

  const march = 20 + leapJ - leapG;



  let adjustedN = n;

  if (jump - n < 6) {

    adjustedN = n - jump + Math.floor((jump + 4) / 33) * 33;

  }



  let leap = mod(mod(adjustedN + 1, 33) - 1, 4);

  if (leap === -1) leap = 4;

  return leap === 0;

}



function parseBirthDate(value) {

  const normalized = normalizeDigits(value);

  const match = normalized.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);

  if (!match) return null;



  const year = Number(match[1]);

  const month = Number(match[2]);

  const day = Number(match[3]);



  if (year < 1300 || year > 1500) return null;

  if (month < 1 || month > 12 || day < 1) return null;



  let maxDay;

  if (month <= 6) maxDay = 31;

  else if (month <= 11) maxDay = 30;

  else maxDay = isJalaliLeapYear(year) ? 30 : 29;



  if (day > maxDay) return null;

  return { day, month, year };

}



async function getSession(db, telegramId) {

  const result = await db.prepare(

    "SELECT current_step, form_data FROM registration_sessions WHERE telegram_id = ?"

  ).bind(telegramId).first();



  if (!result) return null;



  let data = {};

  try {

    data = JSON.parse(result.form_data || "{}");

  } catch {

    data = {};

  }



  return { step: result.current_step, data };

}



async function saveSession(db, telegramId, step, data) {

  await db.prepare(`

    INSERT INTO registration_sessions

      (telegram_id, current_step, form_data, updated_at)

    VALUES (?, ?, ?, CURRENT_TIMESTAMP)

    ON CONFLICT(telegram_id) DO UPDATE SET

      current_step = excluded.current_step,

      form_data = excluded.form_data,

      updated_at = CURRENT_TIMESTAMP

  `).bind(telegramId, step, JSON.stringify(data)).run();

}



async function deleteSession(db, telegramId) {

  await db.prepare(

    "DELETE FROM registration_sessions WHERE telegram_id = ?"

  ).bind(telegramId).run();

}



function stepPrompt(step) {

  const prompts = {

    full_name: "لطفاً نام و نام خانوادگی خود را وارد کن:\nمثال: سوگند ابراهیمیان",

    birth_date: "تاریخ تولد خود را به شمسی و به ترتیب سال/ماه/روز وارد کن:\nمثال: ۱۳۷۵/۰۸/۱۵",

    residence: "محل سکونت خود در تهران را بنویس:\nمثال: تهرانپارس، سعادت‌آباد، پونک یا ونک",

    height: "قد خود را به سانتی‌متر وارد کن:\nمثال: ۱۸۰",

    job: "شغل خود را بنویس:",

    sport: "رشته ورزشی مورد علاقه یا فعالیت ورزشی خود را بنویس:"

  };

  return prompts[step] || "";

}



async function askStep(token, chatId, step) {

  await sendMessage(token, chatId, stepPrompt(step));

}



function makeSummary(data) {

  return (

    "لطفاً اطلاعات ثبت‌نامت را بررسی کن:\n\n" +

    `نام و نام خانوادگی: ${data.full_name}\n` +

    `تاریخ تولد: ${data.birth_year}/${data.birth_month}/${data.birth_day}\n` +

    `محل سکونت: ${data.residence}\n` +

    `قد: ${data.height_cm} سانتی‌متر\n` +

    `شغل: ${data.job}\n` +

    `رشته ورزشی: ${data.sport}\n\n` +

    "اگر اطلاعات صحیح است، کلمه «تأیید» را بفرست.\n" +

    "برای شروع دوباره فرم، کلمه «ویرایش» را بفرست."

  );

}



async function ensureAdminDeletionTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS admin_delete_requests (
    admin_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    target_name TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function validateRegistrationData(data) {
  if (!data || typeof data !== "object") return false;
  const name = String(data.full_name || "").trim();
  const residence = String(data.residence || "").trim();
  const job = String(data.job || "").trim();
  const sport = String(data.sport || "").trim();
  const height = Number(data.height_cm);
  const day = Number(data.birth_day);
  const month = Number(data.birth_month);
  const year = Number(data.birth_year);
  if (name.length < 5 || name.length > 100 || name.split(/\s+/).length < 2) return false;
  if (residence.length < 2 || residence.length > 100) return false;
  if (job.length < 2 || job.length > 100) return false;
  if (sport.length < 2 || sport.length > 100) return false;
  if (!Number.isInteger(height) || height < 80 || height > 250) return false;
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year) || year < 1300 || year > 1500) return false;
  const maxDay = month <= 6 ? 31 : month <= 11 ? 30 : (isJalaliLeapYear(year) ? 30 : 29);
  if (month < 1 || month > 12 || day < 1 || day > maxDay) return false;
  return true;
}

async function handleMessage(update, env, ctx) {

  const message = update.message;

  if (!message || !message.from || !message.chat) return;



  const chatId = message.chat.id;

  const telegramId = String(message.from.id);

  const token = env.BOT_TOKEN;

  const input = (message.text || "").trim();

  // Auto-restrict newly joined non-registered members individually.
  if ((message.chat.type === "group" || message.chat.type === "supergroup") &&
      String(chatId) === GROUP_CHAT_ID && Array.isArray(message.new_chat_members) &&
      message.new_chat_members.length > 0) {
    await handleNewGroupMembers(message, env, ctx);
    return;
  }



  // Check every ordinary message from a legacy group member. Unregistered users are
  // individually restricted; registered members and real admins are unaffected.
  if ((message.chat.type === "group" || message.chat.type === "supergroup") && String(chatId) === GROUP_CHAT_ID) {
    await trackMemberActivity(env.DB, message.from);
    await handleExistingMemberMessage(message, env, ctx);
  }

  // فرمان‌های مدیریتی گروه؛ فقط مدیران واقعی گروه مجازند.*
  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    if (String(chatId) !== GROUP_CHAT_ID) return;
    const isAdmin = await isGroupAdmin(token, GROUP_CHAT_ID, message.from.id);

    if (!isAdmin) return;



    if (/^\/(?:help|commands)(?:@TALLLegends_bot)?$/i.test(input)) {
      await sendMessage(token, chatId,
        `🧭 راهنمای دستورات مدیریتی TALL Legends\n\n` +
        `/stats — آمار کلی ثبت‌نام‌ها و افراد شناسایی‌شده\n` +
        `/monthly — گزارش ماهانه ثبت‌نام‌ها\n` +
        `/pending — فهرست اعضای شناسایی‌شده با ثبت‌نام ناقص\n` +
        `/birthdays — فهرست تولدهای ماه شمسی جاری\n` +
        `/height — رتبه‌بندی ۲۰ عضو بلندقدتر\n` +
        `/activity — گزارش اعضای کم‌فعال‌تر\n` +
        `/tall — نمایش مشخصات عضو (با Reply روی پیام او)\n` +
        `/delete — حذف اطلاعات عضو از دیتابیس (با Reply)\n` +
        `/confirm_delete — تأیید حذف اطلاعات\n` +
        `/cancel_delete — لغو درخواست حذف\n` +
        `/cancel_delete — لغو درخواست حذف\n` +
        `/export — دریافت CSV در گفت‌وگوی خصوصی ربات\n` +
        `/groupid — نمایش شناسه گروه\n\n` +
        `این دستورات فقط برای مدیران واقعی گروه فعال‌اند. آمار اعضای قدیمی فقط پس از شناسایی آن‌ها توسط ربات قابل ثبت است.`,
        message.message_thread_id);
      return;
    }

    if (/^\/stats(?:@TALLLegends_bot)?$/i.test(input)) {
      const stats = await getRegistrationStats(env.DB);
      const tracked = Number(stats?.tracked || 0);
      const registered = Number(stats?.registered || 0);
      const pending = Number(stats?.pending || 0);
      const percent = tracked ? Math.round(registered * 100 / tracked) : 0;
      await sendMessage(token, chatId,
        `📊 آمار ثبت‌نام TALL Legends\n\n👥 اعضای شناسایی‌شده در دیتابیس: ${tracked}\n✅ ثبت‌نام تکمیل‌شده: ${registered}\n⏳ ثبت‌نام ناقص/انجام‌نشده: ${pending}\n📈 درصد تکمیل بین رکوردهای شناسایی‌شده: ${percent}%\n\n⚠️ این آمار تعداد واقعی کل اعضای گروه نیست؛ اعضای قدیمی تا وقتی پیام ندهند یا ثبت‌نام را شروع نکنند، برای ربات قابل شناسایی نیستند.`,
        message.message_thread_id);
      return;
    }

    if (/^\/monthly(?:@TALLLegends_bot)?$/i.test(input)) {
      const result = await env.DB.prepare(`
        SELECT
          SUM(CASE WHEN strftime('%Y-%m', datetime(created_at, '+3 hours', '+30 minutes')) = strftime('%Y-%m', datetime('now', '+3 hours', '+30 minutes')) THEN 1 ELSE 0 END) AS new_members,
          SUM(CASE WHEN registration_status = 'completed' AND registration_completed_at IS NOT NULL AND strftime('%Y-%m', datetime(registration_completed_at, '+3 hours', '+30 minutes')) = strftime('%Y-%m', datetime('now', '+3 hours', '+30 minutes')) THEN 1 ELSE 0 END) AS completed
        FROM members
      `).first();
      await sendMessage(token, chatId,
        `📅 گزارش ماهانه ثبت‌نام TALL Legends\n\n🆕 رکوردهای ایجادشده در این ماه: ${Number(result?.new_members || 0)}\n✅ ثبت‌نام‌های تکمیل‌شده در این ماه: ${Number(result?.completed || 0)}\n\nمبنای ماه: زمان تهران. آمار مربوط به رکوردهای شناخته‌شده ربات است.`,
        message.message_thread_id);
      return;
    }

    if (/^\/birthdays(?:@TALLLegends_bot)?$/i.test(input)) {
      const now = getTehranDateParts();
      const result = await env.DB.prepare(`
        SELECT first_name, last_name, birth_day, birth_year
        FROM members WHERE registration_status = 'completed' AND birth_month = ?
        ORDER BY birth_day, first_name
      `).bind(now.month).all();
      const rows = result.results || [];
      const lines = rows.map((r) => `🎂 ${String(r.birth_day).padStart(2, '0')} ${monthNameFa(now.month)} — ${[r.first_name, r.last_name].filter(Boolean).join(' ') || 'بدون نام'}`);
      await sendMessage(token, chatId,
        rows.length ? `🎉 تولدهای ماه ${monthNameFa(now.month)} (${now.year})\n\n${lines.join('\n')}` : `در ماه ${monthNameFa(now.month)} تولد ثبت‌شده‌ای پیدا نشد.`,
        message.message_thread_id);
      return;
    }

    if (/^\/height(?:@TALLLegends_bot)?$/i.test(input)) {
      const result = await env.DB.prepare(`
        SELECT first_name, last_name, height_cm FROM members
        WHERE registration_status = 'completed' AND height_cm IS NOT NULL
        ORDER BY height_cm DESC, first_name ASC LIMIT 20
      `).all();
      const rows = result.results || [];
      const lines = rows.map((r, i) => `${i + 1}. ${[r.first_name, r.last_name].filter(Boolean).join(' ') || 'بدون نام'} — ${r.height_cm} سانتی‌متر`);
      await sendMessage(token, chatId,
        rows.length ? `📏 رتبه‌بندی قد اعضای ثبت‌نام‌شده (۲۰ نفر اول)\n\n${lines.join('\n')}\n\nاین رتبه‌بندی فقط برای اعضایی است که قدشان را ثبت کرده‌اند.` : 'هنوز اطلاعات قدی برای رتبه‌بندی وجود ندارد.',
        message.message_thread_id);
      return;
    }

    if (/^\/activity(?:@TALLLegends_bot)?$/i.test(input)) {
      const result = await env.DB.prepare(`
        SELECT m.telegram_id, m.first_name, m.last_name, a.last_seen_at, a.message_count
        FROM members m LEFT JOIN member_activity a ON a.telegram_id = m.telegram_id
        WHERE m.registration_status = 'completed'
        ORDER BY COALESCE(a.last_seen_at, '1970-01-01') ASC LIMIT 30
      `).all();
      const rows = result.results || [];
      const lines = rows.map((r, i) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'بدون نام';
        const seen = r.last_seen_at || 'هنوز فعالیتی ثبت نشده';
        return `${i + 1}. ${name} | آخرین فعالیت: ${seen} | پیام‌ها: ${Number(r.message_count || 0)}`;
      });
      await sendMessage(token, chatId,
        rows.length ? `📈 کم‌فعال‌ترین اعضای ثبت‌نام‌شده (حداکثر ۳۰ نفر)\n\n${lines.join('\n')}\n\nفعالیت از زمان فعال‌شدن این قابلیت ثبت می‌شود؛ نبود سابقه به معنی غیرفعال‌بودن قطعی نیست.` : 'هنوز فعالیتی برای اعضا ثبت نشده است.',
        message.message_thread_id);
      return;
    }

    if (/^\/pending(?:@TALLLegends_bot)?$/i.test(input)) {
      const result = await env.DB.prepare(`
        SELECT telegram_id, username, first_name, last_name
        FROM members
        WHERE registration_status IS NULL OR registration_status != 'completed'
        ORDER BY updated_at DESC LIMIT 30
      `).all();
      const rows = result.results || [];
      const lines = rows.map((r, i) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "بدون نام";
        const username = r.username ? ` (@${r.username})` : "";
        return `${i + 1}. ${name}${username} | ID: ${r.telegram_id}`;
      });
      await sendMessage(token, chatId,
        rows.length ? `⏳ اعضای شناسایی‌شده با ثبت‌نام ناقص (حداکثر ۳۰ نفر):\n\n${lines.join("\n")}\n\nبرای آمار کلی: /stats` :
        "در حال حاضر عضو شناسایی‌شده‌ای با ثبت‌نام ناقص در دیتابیس وجود ندارد. توجه: این به معنی ثبت‌نام همه اعضای قدیمی گروه نیست.",
        message.message_thread_id);
      return;
    }

    if (/^\/groupid(?:@TALLLegends_bot)?$/i.test(input)) {
      await sendMessage(token, chatId, `شناسه گروه TALL Legends:\n${GROUP_CHAT_ID}`, message.message_thread_id);
      return;
    }

    // Delete only the member's stored data; do not remove or restrict the person in Telegram.
    if (/^\/delete(?:@TALLLegends_bot)?$/i.test(input)) {
      const replied = message.reply_to_message;
      if (!replied || !replied.from || replied.from.is_bot) {
        await sendMessage(token, chatId,
          "برای حذف اطلاعات، روی پیام همان عضو Reply کن و /delete را بفرست.",
          message.message_thread_id);
        return;
      }
      const targetId = String(replied.from.id);
      if (await isGroupAdmin(token, GROUP_CHAT_ID, Number(targetId))) {
        await sendMessage(token, chatId, "برای جلوگیری از حذف اشتباهی، اطلاعات مدیران گروه با این دستور حذف نمی‌شود.", message.message_thread_id);
        return;
      }
      const target = await env.DB.prepare(
        "SELECT first_name, last_name FROM members WHERE telegram_id = ?"
      ).bind(targetId).first();
      if (!target) {
        await sendMessage(token, chatId, "برای این عضو اطلاعاتی در دیتابیس پیدا نشد.", message.message_thread_id);
        return;
      }
      await ensureAdminDeletionTable(env.DB);
      const targetName = [target.first_name, target.last_name].filter(Boolean).join(" ") || "عضو بدون نام";
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      await env.DB.prepare(`INSERT INTO admin_delete_requests (admin_id, target_id, target_name, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(admin_id) DO UPDATE SET target_id = excluded.target_id,
          target_name = excluded.target_name, expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP`)
        .bind(telegramId, targetId, targetName, expiresAt).run();
      await sendMessage(token, chatId,
        `⚠️ درخواست حذف اطلاعات عضو: ${targetName}\nشناسه: ${targetId}\n\nاین عملیات فقط اطلاعات ثبت‌نامی، فرم نیمه‌تمام و آمار فعالیت او را از دیتابیس پاک می‌کند؛ عضویت و دسترسی او در گروه تغییر نمی‌کند.\n\nبرای تأیید تا ۱۰ دقیقه آینده /confirm_delete و برای انصراف /cancel_delete را بفرست.`,
        message.message_thread_id);
      return;
    }

    if (/^\/cancel_delete(?:@TALLLegends_bot)?$/i.test(input)) {
      await ensureAdminDeletionTable(env.DB);
      await env.DB.prepare("DELETE FROM admin_delete_requests WHERE admin_id = ?").bind(telegramId).run();
      await sendMessage(token, chatId, "درخواست حذف لغو شد.", message.message_thread_id);
      return;
    }

    if (/^\/confirm_delete(?:@TALLLegends_bot)?$/i.test(input)) {
      await ensureAdminDeletionTable(env.DB);
      const request = await env.DB.prepare(`SELECT target_id, target_name, expires_at
        FROM admin_delete_requests WHERE admin_id = ?`).bind(telegramId).first();
      if (!request) {
        await sendMessage(token, chatId, "درخواست حذف فعالی وجود ندارد. ابتدا روی پیام عضو Reply کن و /delete را بفرست.", message.message_thread_id);
        return;
      }
      if (Number(request.expires_at) < Math.floor(Date.now() / 1000)) {
        await env.DB.prepare("DELETE FROM admin_delete_requests WHERE admin_id = ?").bind(telegramId).run();
        await sendMessage(token, chatId, "مهلت تأیید تمام شده است. برای حذف دوباره /delete را اجرا کن.", message.message_thread_id);
        return;
      }
      if (await isGroupAdmin(token, GROUP_CHAT_ID, Number(request.target_id))) {
        await env.DB.prepare("DELETE FROM admin_delete_requests WHERE admin_id = ?").bind(telegramId).run();
        await sendMessage(token, chatId, "اطلاعات مدیران گروه با این دستور حذف نمی‌شود.", message.message_thread_id);
        return;
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM registration_sessions WHERE telegram_id = ?").bind(request.target_id),
        env.DB.prepare("DELETE FROM member_activity WHERE telegram_id = ?").bind(request.target_id),
        env.DB.prepare("DELETE FROM members WHERE telegram_id = ?").bind(request.target_id),
        env.DB.prepare("DELETE FROM admin_delete_requests WHERE admin_id = ?").bind(telegramId)
      ]);
      await sendMessage(token, chatId,
        `✅ اطلاعات ثبت‌شده ${request.target_name || "عضو"} از دیتابیس حذف شد. عضویت و دسترسی او در گروه هیچ تغییری نکرد.`,
        message.message_thread_id);
      return;
    }

    // /tall must be sent as a reply to the member's message.
    if (/^\/tall(?:@TALLLegends_bot)?$/i.test(input)) {
      const replied = message.reply_to_message;
      if (!replied || !replied.from || replied.from.is_bot) {
        await sendMessage(token, chatId,
          "برای مشاهده مشخصات، روی یکی از پیام‌های همان عضو Reply کن و دستور /tall را بفرست.",
          message.message_thread_id);
        return;
      }

      const targetId = String(replied.from.id);
      const profile = await env.DB.prepare(
        `SELECT username, first_name, last_name, birth_day, birth_month, birth_year,
                residence, height_cm, job, sport, registration_status
         FROM members WHERE telegram_id = ?`
      ).bind(targetId).first();

      if (!profile || profile.registration_status !== "completed") {
        await sendMessage(token, chatId,
          `📋 اطلاعات عضو موردنظر\n\nاین عضو هنوز ثبت‌نام خود را تکمیل نکرده است.\nشناسه تلگرام: ${targetId}`,
          message.message_thread_id);
        return;
      }

      const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "ثبت نشده";
      const username = profile.username ? `@${profile.username}` : "ندارد";
      const birthDate = `${String(profile.birth_year).padStart(4, "0")}/${String(profile.birth_month).padStart(2, "0")}/${String(profile.birth_day).padStart(2, "0")}`;
      const details =
        `📋 مشخصات عضو TALL Legends\n\n` +
        `👤 نام و نام خانوادگی: ${fullName}\n` +
        `🔹 نام کاربری: ${username}\n` +
        `🎂 تاریخ تولد: ${birthDate}\n` +
        `📍 محل سکونت: ${profile.residence || "ثبت نشده"}\n` +
        `📏 قد: ${profile.height_cm ? `${profile.height_cm} سانتی‌متر` : "ثبت نشده"}\n` +
        `💼 شغل: ${profile.job || "ثبت نشده"}\n` +
        `🏅 رشته ورزشی: ${profile.sport || "ثبت نشده"}\n` +
        `🆔 شناسه تلگرام: ${targetId}`;

      await sendMessage(token, chatId, details, message.message_thread_id);
      return;
    }

    return;

  }



  // فرم فقط در گفت‌وگوی خصوصی با ربات اجرا می‌شود.*

  if (message.chat.type !== "private") return;



  // Private CSV export: only a currently verified group administrator can use it.
  if (/^\/export(?:@TALLLegends_bot)?$/i.test(input)) {
    const admin = await isGroupAdmin(token, GROUP_CHAT_ID, message.from.id);
    if (!admin) {
      await sendMessage(token, chatId, "⛔ این دستور فقط برای مدیران گروه فعال است.");
      return;
    }
    const sent = await sendMembersCsv(token, chatId, env.DB);
    if (!sent.ok) await sendMessage(token, chatId, "❌ ساخت یا ارسال فایل خروجی ناموفق بود. گزارش Worker را بررسی کنید.");
    return;
  }

  // شرط استفاده از ربات: کاربر باید عضو گروه TALL Legends باشد.*

  // در صورت خطای API نیز دسترسی بسته می‌ماند (fail closed).*

  const membership = await telegramCall(token, "getChatMember", {

    chat_id: GROUP_CHAT_ID,

    user_id: message.from.id

  });



  if (!membership.ok) {

    console.error("getChatMember verification error:", membership);

    await sendMessage(

      token,

      chatId,

      "در حال حاضر امکان بررسی عضویت شما در گروه وجود ندارد. لطفاً کمی بعد دوباره تلاش کن."

    );

    return;

  }



  const status = membership.result.status;

  const isMember =

    status === "creator" ||

    status === "administrator" ||

    status === "member" ||

    (status === "restricted" && membership.result.is_member === true);



  if (!isMember) {

    await sendMessage(

      token,

      chatId,

      `🔒 استفاده از ربات ثبت‌نام TALL Legends فقط برای اعضای گروه امکان‌پذیر است.



ابتدا به گروه TALL Legends بپیوند و سپس دوباره دستور /start را ارسال کن. اگر لینک دعوت را نداری، از یکی از مدیران گروه دریافت کن.`

    );

    return;

  }



  const db = env.DB;



  if (!input) {

    await sendMessage(token, chatId, "لطفاً پاسخ را به‌صورت متن ارسال کن.");

    return;

  }



  if (/^\/cancel(?:@\w+)?$/i.test(input)) {

    await deleteSession(db, telegramId);

    await sendMessage(token, chatId,

      "فرم ثبت‌نام لغو شد. هر زمان خواستی با دستور /start دوباره شروع کن.");

    return;

  }



  const member = await db.prepare(

    "SELECT registration_status FROM members WHERE telegram_id = ?"

  ).bind(telegramId).first();



  if (/^\/start(?:@\w+)?$/i.test(input)) {

    await db.prepare(`

      INSERT OR IGNORE INTO members

        (telegram_id, username, first_name, last_name, registration_status)

      VALUES (?, ?, ?, ?, 'pending')

    `).bind(

      telegramId,

      message.from.username || null,

      message.from.first_name || null,

      message.from.last_name || null

    ).run();



    if (member && member.registration_status === "completed") {

      const releaseResult = await releaseRegisteredMember(token, telegramId);

      await sendMessage(token, chatId,

        releaseResult.ok

          ? "سلام 🌷\nثبت‌نام شما قبلاً تکمیل شده و دسترسی ارسال پیام شما در گروه فعال است."

          : "سلام 🌷\nثبت‌نام شما در ربات اعضای TALL Legends قبلاً تکمیل شده است. اگر عضو گروه هستی، دسترسی‌ات بررسی می‌شود.");

      return;

    }



    const existingSession = await getSession(db, telegramId);

    await sendMessage(token, chatId,

      "سلام 🌷\n\nبه ربات اعضای TALL Legends خوش آمدی.\n\nبرای عضویت در گروه، لطفاً فرم ثبت‌نام را کامل کن.\nاطلاعات ثبت‌شده فقط در اختیار مدیران مجاز گروه قرار می‌گیرد و برای مدیریت اعضا و یادآوری تولدها استفاده می‌شود.");



    if (existingSession) {

      await askStep(token, chatId, existingSession.step);

    } else {

      await saveSession(db, telegramId, "full_name", {});

      await askStep(token, chatId, "full_name");

    }

    return;

  }



  const session = await getSession(db, telegramId);

  if (!session) {

    await sendMessage(token, chatId,

      "برای شروع ثبت‌نام، دستور /start را ارسال کن.");

    return;

  }



  const data = session.data;

  const step = session.step;



  if (step === "full_name") {

    const fullName = input.replace(/\s+/g, " ").trim();

    if (fullName.length < 5 || fullName.length > 100 || fullName.split(" ").length < 2) {

      await sendMessage(token, chatId,

        "لطفاً نام و نام خانوادگی را کامل وارد کن.\nمثال: محمد ابراهیمی");

      return;

    }

    data.full_name = fullName;

    await saveSession(db, telegramId, "birth_date", data);

    await askStep(token, chatId, "birth_date");

    return;

  }



  if (step === "birth_date") {

    const birth = parseBirthDate(input);

    if (!birth) {

      await sendMessage(token, chatId,

        "تاریخ واردشده معتبر نیست.\nلطفاً تاریخ تولد شمسی را به شکل سال/ماه/روز وارد کن.\nمثال: ۱۳۷۵/۰۸/۱۵");

      return;

    }

    data.birth_day = birth.day;

    data.birth_month = birth.month;

    data.birth_year = birth.year;

    await saveSession(db, telegramId, "residence", data);

    await askStep(token, chatId, "residence");

    return;

  }



  if (step === "residence") {

    const residence = input.replace(/\s+/g, " ").trim();

    if (residence.length < 2 || residence.length > 100) {

      await sendMessage(token, chatId,

        "لطفاً نام محله یا محدوده محل سکونتت در تهران را بنویس.");

      return;

    }

    data.residence = residence;

    await saveSession(db, telegramId, "height", data);

    await askStep(token, chatId, "height");

    return;

  }



  if (step === "height") {

    const heightText = normalizeDigits(input);

    const height = Number(heightText);

    if (!/^\d{2,3}$/.test(heightText) || height < 80 || height > 250) {

      await sendMessage(token, chatId,

        "قد را به عدد و برحسب سانتی‌متر وارد کن.\nمثال: ۱۸۰");

      return;

    }

    data.height_cm = height;

    await saveSession(db, telegramId, "job", data);

    await askStep(token, chatId, "job");

    return;

  }



  if (step === "job") {

    const job = input.replace(/\s+/g, " ").trim();

    if (job.length < 2 || job.length > 100) {

      await sendMessage(token, chatId, "لطفاً شغل خود را کامل وارد کن.");

      return;

    }

    data.job = job;

    await saveSession(db, telegramId, "sport", data);

    await askStep(token, chatId, "sport");

    return;

  }



  if (step === "sport") {

    const sport = input.replace(/\s+/g, " ").trim();

    if (sport.length < 2 || sport.length > 100) {

      await sendMessage(token, chatId,

        "لطفاً رشته ورزشی خود را وارد کن. اگر فعالیت ورزشی خاصی نداری، می‌توانی بنویسی «فعلاً ندارم».");

      return;

    }

    data.sport = sport;

    await saveSession(db, telegramId, "confirm", data);

    await sendMessage(token, chatId, makeSummary(data));

    return;

  }



  if (step === "confirm") {

    if (!(await validateRegistrationData(data))) {
      await sendMessage(token, chatId, "اطلاعات ثبت‌نام کامل یا معتبر نیست. فرم از ابتدا آغاز می‌شود.");
      await saveSession(db, telegramId, "full_name", {});
      await askStep(token, chatId, "full_name");
      return;
    }

    const answer = normalizePersianText(input);



    if (["ویرایش", "شروع", "ازاول"].includes(answer)) {

      await saveSession(db, telegramId, "full_name", {});

      await askStep(token, chatId, "full_name");

      return;

    }



    if (!["تایید", "بله", "yes"].includes(answer)) {

      await sendMessage(token, chatId,

        "برای ثبت نهایی، کلمه «تأیید» را بفرست.\nبرای شروع دوباره فرم، کلمه «ویرایش» را ارسال کن.");

      return;

    }



    const nameParts = data.full_name.split(" ");

    const firstName = nameParts.shift();

    const lastName = nameParts.join(" ");



    const updateResult = await db.prepare(`
      UPDATE members SET
        username = ?,
        first_name = ?,
        last_name = ?,
        birth_day = ?,
        birth_month = ?,
        birth_year = ?,
        residence = ?,
        height_cm = ?,
        job = ?,
        sport = ?,
        registration_status = 'completed',
        registration_completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).bind(
      message.from.username || null,
      firstName,
      lastName,
      data.birth_day,
      data.birth_month,
      data.birth_year,
      data.residence,
      data.height_cm,
      data.job,
      data.sport,
      telegramId
    ).run();

    if (!updateResult.meta || updateResult.meta.changes !== 1) {
      console.error("Registration update failed:", {
        telegramId,
        changes: updateResult.meta?.changes
      });
      await sendMessage(token, chatId,
        "ثبت اطلاعات در سامانه انجام نشد. اطلاعات فرم حذف نشده است؛ لطفاً دوباره تلاش کن یا با مدیر گروه تماس بگیر.");
      return;
    }

    await deleteSession(db, telegramId);

    let releaseResult;
    try {
      releaseResult = await releaseRegisteredMember(token, telegramId);
    } catch (error) {
      console.error("Registered member release failed:", { telegramId, error: String(error) });
      releaseResult = { ok: false, error: String(error) };
    }

    if (releaseResult.ok) {
      await sendMessage(token, chatId,
        "🎉 ثبت‌نام شما با موفقیت تکمیل شد.\n\nبه خانواده TALL Legends خوش آمدی! 🌷\n\nدسترسی ارسال پیام شما در گروه هم فعال شد.");
    } else if (releaseResult.skipped) {
      await sendMessage(token, chatId,
        "🎉 ثبت‌نام شما با موفقیت تکمیل شد.\n\nبه خانواده TALL Legends خوش آمدی! 🌷\n\nپس از ورود به گروه، دسترسی ارسال پیام شما بررسی و فعال خواهد شد.");
    } else {
      console.error("Telegram permission activation failed after registration:", {
        telegramId,
        releaseResult
      });
      await sendMessage(token, chatId,
        "🎉 ثبت‌نام شما در سامانه با موفقیت تکمیل شد.\n\nاما فعال‌سازی دسترسی ارسال پیام در گروه با خطا مواجه شد. لطفاً با مدیر گروه تماس بگیر تا دسترسی‌ات بررسی شود.");
    }

    return;

  }



  await sendMessage(token, chatId,

    "برای ادامه ثبت‌نام، دستور /start را ارسال کن.");

}



// Convert a Gregorian date to the Jalali calendar without external dependencies.
function gregorianToJalali(gy, gm, gd) {
  const gdm = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gy2 = gy - (gm > 2 ? 1 : 0);
  let days = 355666 + 365 * gy2 + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd;
  for (let i = 0; i < gm; i++) days += gdm[i];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let jm, jd;
  if (days < 186) {
    jm = 1 + Math.floor(days / 31);
    jd = 1 + (days % 31);
  } else {
    jm = 7 + Math.floor((days - 186) / 30);
    jd = 1 + ((days - 186) % 30);
  }
  return { year: jy, month: jm, day: jd };
}

function getTehranDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const jalali = gregorianToJalali(Number(values.year), Number(values.month), Number(values.day));
  return { ...jalali, hour: Number(values.hour), minute: Number(values.minute) };
}

async function sendDailyBirthdayGreetings(env) {
  const now = getTehranDateParts();
  // The every-minute Cron may be delayed slightly; allow a five-minute delivery window.
  if (now.hour !== 9 || now.minute > 5) return;

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS birthday_notifications (
    jalali_date TEXT PRIMARY KEY, sent_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();

  const jalaliDate = `${now.year}/${String(now.month).padStart(2, '0')}/${String(now.day).padStart(2, '0')}`;
  const alreadySent = await env.DB.prepare(
    'SELECT jalali_date FROM birthday_notifications WHERE jalali_date = ?'
  ).bind(jalaliDate).first();
  if (alreadySent) return;

  const result = await env.DB.prepare(`
    SELECT telegram_id, first_name, last_name
    FROM members
    WHERE registration_status = 'completed' AND birth_month = ? AND birth_day = ?
    ORDER BY first_name, last_name
  `).bind(now.month, now.day).all();
  const birthdays = result.results || [];
  if (!birthdays.length) return;

  const names = birthdays.map(member => {
    const name = [member.first_name, member.last_name].filter(Boolean).join(' ').trim() || 'عضو عزیز TALL Legends';
    return `🎉 ${name}`;
  });
  const message = `🎂🎈 تولدهای امروز TALL Legends 🎈🎂\n\n${names.join('\n')}\n\nاز طرف خانواده TALL Legends، تولدتان مبارک! 🌷\nامیدواریم سالی سرشار از سلامتی، شادی و موفقیت پیش رو داشته باشید. 💙`;
  const sent = await sendMessage(env.BOT_TOKEN, GROUP_CHAT_ID, message, REGISTRATION_TOPIC_THREAD_ID);
  if (sent.ok) {
    await env.DB.prepare('INSERT OR IGNORE INTO birthday_notifications (jalali_date) VALUES (?)').bind(jalaliDate).run();
  } else {
    console.error('Birthday greeting send failed:', sent);
  }
}


export default {

  async fetch(request, env, ctx) {

    if (request.method === "GET") {

      return new Response("TALL Legends Bot is running!");

    }



    if (request.method !== "POST") {

      return new Response("Method Not Allowed", { status: 405 });

    }



    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {

      return new Response("Unauthorized", { status: 401 });

    }



    try {

      const update = await request.json();

      if (update.message) await handleMessage(update, env, ctx);

      return new Response("OK");

    } catch (error) {

      console.error("Worker error:", error);

      return new Response("Internal Server Error", { status: 500 });

    }

  }

  ,
  async scheduled(controller, env, ctx) {
    try {
      await ensureAnalyticsSchema(env.DB);
    } catch (error) {
      console.error("Analytics schema setup failed:", error);
    }
    try {
      await processScheduledDeletions(env);
    } catch (error) {
      console.error("Scheduled deletion job failed:", error);
    }
    try {
      await sendDailyBirthdayGreetings(env);
    } catch (error) {
      console.error("Daily birthday greeting job failed:", error);
    }
  }

};
