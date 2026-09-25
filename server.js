// server.js
// Единый back-end сервер для AvtoFizika чат-бота.
// Принимает сообщения из Telegram и с сайта (веб-виджет),
// пересылает их в Anthropic API вместе с общим системным промптом,
// и возвращает ответ обратно клиенту.

const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS — дозволяємо браузеру на вашому сайті (avtofizika.com.ua) звертатися
// до цього сервера. Без цього браузер заблокує запити від чат-віджета.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
// Легка/дешева модель для швидкої класифікації теми повідомлення
// (не для відповіді клієнту, лише щоб зрозуміти "фари" це чи "детейлінг").
const CLASSIFIER_MODEL =
  process.env.CLASSIFIER_MODEL || "claude-haiku-4-5-20251001";
// Адреса webhook у Make.com, куди відправляються заявки для створення
// ліда в РемОнлайн. Отримати цю адресу — див. README (розділ CRM).
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";

if (!MAKE_WEBHOOK_URL) {
  console.warn("ВНИМАНИЕ: переменная MAKE_WEBHOOK_URL не задана. Заявки в CRM отправляться не будут.");
}

if (!ANTHROPIC_API_KEY) {
  console.warn("ВНИМАНИЕ: переменная ANTHROPIC_API_KEY не задана. Задайте её в .env файле.");
}

// ---------------------------------------------------------------------------
// Базу знань розбито на три файли:
//  - systemPrompt-common.md    — спільне для обох тем (роль, тон, контакти, правила)
//  - systemPrompt-fary.md      — все про фари/оптику/світло
//  - systemPrompt-detailing.md — все про детейлінг/мийку/кузов
// Сервер сам визначає тему повідомлення клієнта і підвантажує common +
// потрібний спеціалізований розділ. Щоб відредагувати базу знань — правте
// відповідний .md файл і перезапустіть сервер. Код трогать не нужно.
// ---------------------------------------------------------------------------
const PROMPT_COMMON = fs.readFileSync(
  path.join(__dirname, "systemPrompt-common.md"),
  "utf-8"
);
const PROMPT_FARY = fs.readFileSync(
  path.join(__dirname, "systemPrompt-fary.md"),
  "utf-8"
);
const PROMPT_DETAILING = fs.readFileSync(
  path.join(__dirname, "systemPrompt-detailing.md"),
  "utf-8"
);

// ---------------------------------------------------------------------------
// Простое хранилище истории диалога в памяти процесса: userId -> [ {role, content}, ... ]
// Для продакшена лучше заменить на Redis/базу данных (история пропадёт при
// перезапуске сервера), но для старта этого достаточно.
// ---------------------------------------------------------------------------
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20; // сколько последних сообщений держим в контексте

function getHistory(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  return conversations.get(userId);
}

function pushToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

// ---------------------------------------------------------------------------
// Множина userId, для яких лід вже був відправлений в CRM — щоб не
// відправляти повторно на кожне наступне повідомлення того ж клієнта.
// ---------------------------------------------------------------------------
const leadAlreadySent = new Set();

// ---------------------------------------------------------------------------
// Витягає звичайний текст з "content" повідомлення (яке може бути або
// простим рядком, або масивом блоків текст+зображення) — потрібно для
// класифікації теми.
// ---------------------------------------------------------------------------
function extractPlainText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text");
    return textBlock ? textBlock.text : "[фото]";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Визначає тему звернення клієнта: FARY, DETAILING або GENERAL.
// Використовує легку/дешеву модель окремим (коротким) запитом — це не
// відповідь клієнту, а лише внутрішня класифікація для вибору бази знань.
// ---------------------------------------------------------------------------
async function classifyTopic(userId, latestUserText) {
  const history = getHistory(userId);
  const recentContext = history
    .slice(-6)
    .map((m) => `${m.role}: ${extractPlainText(m.content)}`)
    .join("\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 10,
        system:
          "Ти класифікатор тем звернень клієнтів автосервісу AvtoFizika. " +
          "Категорії:\n" +
          "FARY — все про фари, оптику, світло, скло фар, ліхтарі, полірування фар, Бі-LED, переробку задніх ліхтарів.\n" +
          "DETAILING — мийка, полірування кузова, хімчистка салону, шумоізоляція, захисна плівка на кузов, тонування, кераміка.\n" +
          "GENERAL — привітання, контакти, графік роботи, подяка, або якщо неможливо однозначно визначити.\n" +
          "Відповідай РІВНО ОДНИМ словом великими літерами: FARY, DETAILING або GENERAL. Без пояснень і жодних інших символів.",
        messages: [
          {
            role: "user",
            content: `Історія розмови:\n${recentContext}\n\nОстаннє повідомлення клієнта: "${latestUserText}"\n\nЯка тема?`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Помилка класифікації теми:", response.status);
      return "GENERAL";
    }

    const data = await response.json();
    const raw = (data.content[0] && data.content[0].text ? data.content[0].text : "")
      .trim()
      .toUpperCase();

    if (raw.includes("FARY")) return "FARY";
    if (raw.includes("DETAILING")) return "DETAILING";
    return "GENERAL";
  } catch (err) {
    console.error("Помилка класифікації теми:", err);
    return "GENERAL";
  }
}

// ---------------------------------------------------------------------------
// Вызов Anthropic API. Общая функция для всех платформ.
// content может быть либо просто строкой (обычный текст), либо массивом
// блоків вида [{type:"text", text:"..."}, {type:"image", source:{...}}]
// — так бот может "видеть" присланные клиентом фото.
// ---------------------------------------------------------------------------
async function askClaude(userId, content) {
  pushToHistory(userId, "user", content);

  const latestUserText = extractPlainText(content);
  const topic = await classifyTopic(userId, latestUserText);
  console.log(`[${userId}] тема повідомлення визначена як: ${topic}`);

  let systemPrompt = PROMPT_COMMON;
  if (topic === "FARY") {
    systemPrompt += "\n\n" + PROMPT_FARY;
  } else if (topic === "DETAILING") {
    systemPrompt += "\n\n" + PROMPT_DETAILING;
  }

  // Пошук по sklofar.ua відключено — тепер бот рахує лише вартість робіт,
  // а вартість запчастин (скло, корпуси тощо) додає менеджер вручну.
  const tools = undefined;

  const requestBody = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: getHistory(userId),
  };
  if (tools) requestBody.tools = tools;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic API error:", response.status, errText);
    throw new Error(`Anthropic API вернул ошибку ${response.status}`);
  }

  const data = await response.json();
  const replyText = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  pushToHistory(userId, "assistant", replyText);
  return replyText;
}

// ---------------------------------------------------------------------------
// Окремим (легким) запитом перевіряє ВСЮ переписку з клієнтом — чи десь у
// ній він назвав і ім'я, і номер телефону. Це надійніше, ніж просити
// основну розмовну модель самій додавати службову позначку в кожній
// відповіді (вона не завжди про це пам'ятає) — тут це окреме, просте і
// цілеспрямоване завдання для моделі.
// Повертає {name, phone, topic} або null, якщо контактів ще нема.
// ---------------------------------------------------------------------------
async function extractLeadFromConversation(userId) {
  const history = getHistory(userId);
  const transcript = history
    .map((m) => `${m.role}: ${extractPlainText(m.content)}`)
    .join("\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 400,
        system:
          "Ти уважно читаєш переписку клієнта з чат-ботом автосервісу AvtoFizika. " +
          "Твоє завдання: перевірити, чи клієнт десь у переписці назвав " +
          "І своє ім'я, І номер телефону (обидва одразу, в будь-якому повідомленні). " +
          "Якщо так — зроби докладну виписку з усієї переписки і поверни РІВНО такий JSON, нічого більше: " +
          '{"found":true,"name":"ім\'я клієнта","phone":"номер телефону як написав клієнт","topic":"розгорнутий опис запиту: марка, модель і рік авто (якщо клієнт їх називав — обов\'язково включи; якщо не називав, напиши \'марка/модель не вказані\'), суть проблеми чи бажана послуга, і будь-які інші важливі деталі з розмови (наприклад, орієнтовна ціна, яку вже озвучили, чи домовленості про час)"} ' +
          "Якщо клієнт НЕ називав одночасно і ім'я, і телефон — поверни РІВНО: " +
          '{"found":false} ' +
          "Поле topic має бути змістовним (2-4 речення), щоб менеджер, прочитавши лише його, одразу розумів ситуацію клієнта без потреби передзвонювати для уточнення базових деталей. " +
          "Відповідай лише цим JSON, без жодного іншого тексту, пояснень чи форматування.",
        messages: [
          {
            role: "user",
            content: `Переписка:\n${transcript}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Помилка перевірки ліда:", response.status);
      return null;
    }

    const data = await response.json();
    let raw = (data.content[0] && data.content[0].text) || "{}";
    // Модель іноді обгортає відповідь в markdown-розмітку (```json ... ```) —
    // знімаємо цю обгортку перед парсингом, інакше JSON.parse впаде з помилкою.
    raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);

    if (parsed.found && parsed.name && parsed.phone) {
      return {
        name: parsed.name,
        phone: parsed.phone,
        topic: parsed.topic || "",
      };
    }
    return null;
  } catch (err) {
    console.error("Помилка перевірки ліда:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Відправляє дані ліда у Make.com, який далі створює звернення в РемОнлайн.
// ---------------------------------------------------------------------------
async function sendLeadToCRM(lead, source) {
  if (!MAKE_WEBHOOK_URL) {
    console.warn("MAKE_WEBHOOK_URL не задано, лід не відправлено:", lead);
    return;
  }

  // Дата і час у момент надходження заявки, за київським часом.
  const now = new Date();
  const timestamp = now.toLocaleString("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Додаємо дату/час прямо в текст опису — так вона гарантовано буде
  // видна менеджеру в РемОнлайн, незалежно від того, чи є там окреме
  // поле "термін"/"дедлайн".
  const topicWithTimestamp = `[Заявка від ${timestamp}] ${lead.topic || ""}`.trim();

  // ISO-формат (наприклад, 2026-09-15T15:16:00+03:00) — саме такий формат
  // очікують поля типу "дата/час" у більшості CRM, включно з полем
  // "Кінцевий термін" у РемОнлайн.
  const deadlineIso = now.toISOString();

  try {
    await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: lead.name || "",
        phone: lead.phone || "",
        topic: topicWithTimestamp,
        timestamp, // людський формат — для відображення в тексті
        deadline: deadlineIso, // ISO-формат — для поля "Кінцевий термін"
        source, // "telegram" або "website"
      }),
    });
    console.log("Лід відправлено в CRM:", lead.name, lead.phone, timestamp);
  } catch (err) {
    console.error("Помилка відправки ліда в CRM:", err);
  }
}

// ---------------------------------------------------------------------------
// Скачивает файл (фото), присланный клиентом в Telegram, и возвращает его
// в виде base64-строки вместе с media_type — в таком формате Anthropic API
// принимает изображения.
// ---------------------------------------------------------------------------
async function downloadTelegramPhotoAsBase64(fileId) {
  // Шаг 1: узнаём, где именно лежит файл на серверах Telegram
  const fileInfoResp = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileInfo = await fileInfoResp.json();
  const filePath = fileInfo.result.file_path;

  // Шаг 2: скачиваем сам файл
  const fileResp = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
  );
  const arrayBuffer = await fileResp.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");

  // Telegram обычно присылает фото в формате jpeg
  const mediaType = filePath.endsWith(".png") ? "image/png" : "image/jpeg";

  return { base64Data, mediaType };
}

// ---------------------------------------------------------------------------
// Health check — чтобы хостинг (Render/Railway) видел, что сервис жив.
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("AvtoFizika bot server is running.");
});

// ---------------------------------------------------------------------------
// TELEGRAM WEBHOOK
// Настраивается один раз командой (см. README.md):
// curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://ваш-домен/webhook/telegram"
// ---------------------------------------------------------------------------
app.post("/webhook/telegram", async (req, res) => {
  // Telegram ждёт быстрый ответ 200 OK, поэтому отвечаем сразу,
  // а обработку делаем асинхронно.
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id;
    let contentForClaude;

    if (message.photo && message.photo.length > 0) {
      // message.photo — массив размеров одного и того же фото.
      // Берём последний элемент — это версия с наибольшим разрешением.
      const largestPhoto = message.photo[message.photo.length - 1];
      const { base64Data, mediaType } = await downloadTelegramPhotoAsBase64(
        largestPhoto.file_id
      );

      contentForClaude = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64Data,
          },
        },
        {
          type: "text",
          text:
            message.caption && message.caption.trim().length > 0
              ? message.caption
              : "Клієнт надіслав фото фари без підпису. Подивись на фото і прокоментуй стан фари, запропонуй релевантну послугу.",
        },
      ];
    } else if (message.text) {
      contentForClaude = message.text;
    } else {
      // Другие типы сообщений (стикеры, голосовые и т.д.) пока не обрабатываем
      return;
    }

    const telegramUserId = `telegram:${chatId}`;
    const replyText = await askClaude(telegramUserId, contentForClaude);

    if (!leadAlreadySent.has(telegramUserId)) {
      const lead = await extractLeadFromConversation(telegramUserId);
      if (lead) {
        leadAlreadySent.add(telegramUserId);
        sendLeadToCRM(lead, "telegram");
      }
    }

    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: replyText,
        }),
      }
    );
  } catch (err) {
    console.error("Ошибка обработки Telegram сообщения:", err);
  }
});

// ---------------------------------------------------------------------------
// ВЕБ-ЧАТ (виджет на сайте)
// Виджет на сайте должен слать POST-запрос сюда с телом:
// { "userId": "какой-то уникальный id посетителя (например, id сессии)", "message": "текст" }
// и получит в ответ { "reply": "текст ответа" }
// ---------------------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: "Нужны поля userId и message" });
    }

    const siteUserId = `site:${userId}`;
    const replyText = await askClaude(siteUserId, message);

    if (!leadAlreadySent.has(siteUserId)) {
      const lead = await extractLeadFromConversation(siteUserId);
      if (lead) {
        leadAlreadySent.add(siteUserId);
        sendLeadToCRM(lead, "website");
      }
    }

    res.json({ reply: replyText });
  } catch (err) {
    console.error("Ошибка обработки веб-чата:", err);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// ---------------------------------------------------------------------------
// INSTAGRAM DIRECT
// Instagram Messaging API через Meta Graph API присилає вебхуки в схожому
// форматі на Messenger. Логіка та ж сама, що й для Telegram/сайту: дістати
// текст повідомлення та id відправника, викликати askClaude, перевірити
// лід, відправити відповідь через Graph API (POST /me/messages).
// ---------------------------------------------------------------------------
app.get("/webhook/instagram", (req, res) => {
  // Meta вимагає верифікацію webhook при підключенні (hub.challenge)
  const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook/instagram", async (req, res) => {
  console.log("INSTAGRAM WEBHOOK ПОЛУЧЕНО:", JSON.stringify(req.body));
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    const senderId = messaging?.sender?.id;
    const userText = messaging?.message?.text;
    // Instagram надсилає окремі "echo"-події на власні відправлені
    // повідомлення бота — їх ігноруємо, інакше бот буде відповідати сам собі.
    if (!senderId || !userText || messaging?.message?.is_echo) return;

    const instagramUserId = `instagram:${senderId}`;
    const replyText = await askClaude(instagramUserId, userText);

    if (!leadAlreadySent.has(instagramUserId)) {
      const lead = await extractLeadFromConversation(instagramUserId);
      if (lead) {
        leadAlreadySent.add(instagramUserId);
        sendLeadToCRM(lead, "instagram");
      }
    }

    await fetch(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.INSTAGRAM_PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: senderId },
          message: { text: replyText },
        }),
      }
    );
  } catch (err) {
    console.error("Ошибка обработки Instagram сообщения:", err);
  }
});

// ---------------------------------------------------------------------------
// RO APP (RemOnline) API v2 — діагностика перед підключенням онлайн-запису.
// Тимчасовий маршрут: показує локації, співробітників, ресурси (пости) і
// записи на найближчі 14 днів, щоб правильно налаштувати пошук вільних слотів.
// Відкривати в браузері: /api/roapp-check?secret=ЗНАЧЕННЯ_ROAPP_DEBUG_SECRET
// Після налаштування онлайн-запису цей маршрут можна видалити.
// ---------------------------------------------------------------------------
const ROAPP_API_KEY = process.env.ROAPP_API_KEY || "";
const ROAPP_BASE = "https://api.roapp.io/v2";

async function roappGet(pathAndQuery) {
  const resp = await fetch(ROAPP_BASE + pathAndQuery, {
    headers: {
      Authorization: `Bearer ${ROAPP_API_KEY}`,
      Accept: "application/json",
    },
  });
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = text.slice(0, 2000);
  }
  return { status: resp.status, body };
}

app.get("/api/roapp-check", async (req, res) => {
  if (!process.env.ROAPP_DEBUG_SECRET || req.query.secret !== process.env.ROAPP_DEBUG_SECRET) {
    return res.sendStatus(403);
  }
  if (!ROAPP_API_KEY) {
    return res.json({ error: "ROAPP_API_KEY не задано в Render Environment" });
  }
  try {
    const from = new Date();
    const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
    const f = encodeURIComponent(from.toISOString());
    const t = encodeURIComponent(to.toISOString());

    const result = {};
    result.locations = await roappGet("/company/locations?is_archived=false");
    result.employees = await roappGet("/company/employees");

    const locList =
      (result.locations.body && (result.locations.body.data || result.locations.body.items)) ||
      (Array.isArray(result.locations.body) ? result.locations.body : []);
    result.resources = {};
    for (const loc of (locList || []).slice(0, 5)) {
      if (loc && loc.id) {
        result.resources[loc.id] = await roappGet(`/company/locations/${loc.id}/resources`);
      }
    }

    // Два варіанти запису масиву в URL — щоб побачити, який розуміє API.
    result.bookings_brackets = await roappGet(
      `/bookings?sort=scheduled_for&scheduled_for[]=${f}&scheduled_for[]=${t}`
    );
    result.bookings_plain = await roappGet(
      `/bookings?sort=scheduled_for&scheduled_for=${f}&scheduled_for=${t}`
    );

    res.json(result);
  } catch (err) {
    console.error("roapp-check error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`AvtoFizika bot server запущен на порту ${PORT}`);
});
