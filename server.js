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
async function askClaude(userId, content, source = "chat") {
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

  // Онлайн-запис: інструменти пошуку вільних вікон і створення запису в RO App
  const tools = BOOKING_ENABLED ? BOOKING_TOOLS : undefined;
  if (BOOKING_ENABLED) {
    const today = new Date().toLocaleDateString("uk-UA", {
      timeZone: "Europe/Kyiv", weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
    systemPrompt += `\n\n## Онлайн-запис увімкнено\nСьогодні: ${today}. Для запису використовуй інструменти find_free_slots і book_slot. Ніколи не вигадуй дати чи час — пропонуй лише ті вікна, які повернув find_free_slots.`;
  } else {
    systemPrompt += "\n\n## Онлайн-запис вимкнено\nНе пропонуй обрати дату й час у чаті — лише зворотний дзвінок менеджера.";
  }

  // Робоча копія розмови для цього запиту (з проміжними викликами інструментів)
  const messages = [...getHistory(userId)];
  let replyText = "";

  for (let step = 0; step < 5; step++) {
    const requestBody = {
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
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
    replyText = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const toolUses = data.content.filter((block) => block.type === "tool_use");
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await runBookingTool(userId, tu.name, tu.input || {}, source);
      console.log(`[${userId}] інструмент ${tu.name}:`, JSON.stringify(tu.input), "->", JSON.stringify(result).slice(0, 500));
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!replyText) {
    replyText = "Вибачте, зараз не вдалося перевірити розклад. Залиште, будь ласка, ім'я та номер телефону — менеджер передзвонить і підбере зручний час.";
  }
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
    const replyText = await askClaude(telegramUserId, contentForClaude, "telegram");

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
    const replyText = await askClaude(siteUserId, message, "website");

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
    const replyText = await askClaude(instagramUserId, userText, "instagram");

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
    // API RO App приймає дату лише у форматі 2026-09-25T10:00:00Z (без мілісекунд)
    const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const f = encodeURIComponent(iso(from));
    const t = encodeURIComponent(iso(to));

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

    result.orders_scheduled = await roappGet(
      `/orders?branch_ids=${ROAPP_BRANCH_ID}&scheduled_for=${f}&scheduled_for=${t}`
    );
    result.orders_due = await roappGet(
      `/orders?branch_ids=${ROAPP_BRANCH_ID}&due_date=${f}&due_date=${t}`
    );
    // Як бот бачить зайнятість майстрів (після розбору записів і замовлень)
    try {
      const busy = await fetchBusy(new Date(from.getTime() - 7 * 24 * 3600 * 1000), to);
      result.busy_as_bot_sees = busy.map((b) => ({
        source: b.source || "booking",
        id: b.id,
        start: b.start && b.start.toISOString(),
        end: b.end && b.end.toISOString(),
        masters: b.assignees.map((id) => MASTERS[id] || id),
      }));
    } catch (e) {
      result.busy_error = String(e);
    }
    // Щоб відповідь не була завеликою — обрізаємо списки до 5 елементів
    for (const k of ["bookings_brackets", "bookings_plain", "orders_scheduled", "orders_due"]) {
      const b = result[k] && result[k].body;
      if (b && Array.isArray(b.data)) b.data = b.data.slice(0, 5);
    }
    res.json(result);
  } catch (err) {
    console.error("roapp-check error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ===========================================================================
// ОНЛАЙН-ЗАПИС через RO App API v2
// Бот шукає вільні вікна у потрібного майстра (за існуючими записами в
// RO App), пропонує клієнту 2–3 варіанти і створює Запис у RO App.
// Налаштування послуг / майстрів / боксів — в об'єкті BOOKING_SERVICES нижче.
// Вимкнути онлайн-запис: змінна BOOKING_ENABLED=false у Render Environment.
// ===========================================================================
const ROAPP_BRANCH_ID = Number(process.env.ROAPP_BRANCH_ID || 58845);
const BOOKING_ENABLED = !!ROAPP_API_KEY && process.env.BOOKING_ENABLED !== "false";
const BOOKING_DAYS_AHEAD = Number(process.env.BOOKING_DAYS_AHEAD || 14);
const WORK_DAYS = [1, 2, 3, 4, 5]; // Пн–Пт
const WORK_START = "09:00";
const WORK_END = "19:00";

// Майстри (ID з RO App)
const MASTERS = {
  106873: "Вадос",
  302319: "Максім Федоров",
  321357: "Ника Хоптинець-Сабурова",
  149533: "Олексій Годованець",
  277961: "Олексій Козлов",
  300541: "Ярослав Стьоганцев",
};
// Бокси (ресурси локації в RO App)
const BOX_MOKRYI = 106819; // Мокрий Бокс
const BOX_SVITLYI = 106818; // Світлий Бокс
const BOX_TYKHYI = 106585; // Тихий Бокс

// slots — вікна протягом дня [початок, кінець]. Повний день = одне вікно 09:00–19:00.
const FULL_DAY = [[WORK_START, WORK_END]];
const BOOKING_SERVICES = {
  tail_lights: {
    title: "Задні ліхтарі (переробка поворотників / ремонт)",
    masters: [106873],
    slots: [["09:00", "14:00"], ["14:00", "19:00"]], // до 2 авто на день
    box: BOX_SVITLYI,
  },
  headlight_repair: {
    title: "Ремонт / переупаковка фар, заміна скла",
    masters: [277961, 300541],
    slots: FULL_DAY,
    box: BOX_SVITLYI,
  },
  headlight_polish_film: {
    title: "Шліфування / полірування фар + плівка на фари",
    masters: [300541],
    slots: FULL_DAY,
    box: BOX_SVITLYI,
  },
  bi_led: {
    title: "Встановлення Bi-LED / покращення світла",
    masters: [149533],
    slots: FULL_DAY,
    box: BOX_SVITLYI,
  },
  wash: {
    title: "Мийка",
    masters: [302319],
    slots: [["09:00", "12:00"], ["14:00", "17:00"]], // до 2 авто на день
    box: BOX_MOKRYI,
  },
  detailing: {
    title: "Детейлінг: мийка + хімчистка, полірування кузова, кераміка",
    masters: [302319],
    slots: FULL_DAY,
    box: BOX_MOKRYI,
  },
  body_film: {
    title: "Захисна плівка на кузов",
    masters: [321357],
    slots: FULL_DAY,
    box: BOX_TYKHYI,
  },
};

// ---------- час по Києву ----------
function kyivOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Kyiv",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - utcMs) / 60000);
}
// Київська дата (y, m, d) + "HH:MM" -> Date (UTC)
function kyivToDate(y, m, d, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = kyivOffsetMinutes(guess);
  return new Date(guess - off * 60000);
}
function kyivParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g("weekday")];
  return { y: Number(g("year")), m: Number(g("month")), d: Number(g("day")), wd };
}
const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
function dayLabel(date) {
  return date.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", weekday: "long", day: "numeric", month: "long" });
}

// ---------- записи з RO App ----------
function pickDate(v) {
  if (Array.isArray(v)) v = v[0];
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function bookingAssigneeIds(b) {
  const ids = [];
  if (b.assignee_id) ids.push(Number(b.assignee_id));
  if (b.assignee && b.assignee.id) ids.push(Number(b.assignee.id));
  if (Array.isArray(b.assignees)) b.assignees.forEach((a) => ids.push(Number(a && a.id ? a.id : a)));
  if (b.employee && b.employee.id) ids.push(Number(b.employee.id));
  return ids;
}
function bookingIsCancelled(b) {
  const s = JSON.stringify(b.status || "").toLowerCase();
  return s.includes("скас") || s.includes("отмен") || s.includes("cancel") || s.includes("відмов") || s.includes("отказ");
}

async function fetchBookings(from, to) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const q =
      `/bookings?page=${page}&branches=${ROAPP_BRANCH_ID}` +
      `&scheduled_for=${encodeURIComponent(isoZ(from))}&scheduled_for=${encodeURIComponent(isoZ(to))}`;
    const r = await roappGet(q);
    if (r.status !== 200) {
      throw new Error(`RO App bookings ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    const list = Array.isArray(r.body) ? r.body : r.body.data || [];
    all.push(...list);
    const totalPages = (r.body.paging && r.body.paging.total_pages) || 1;
    if (page >= totalPages || list.length === 0) break;
  }
  return all
    .filter((b) => !bookingIsCancelled(b))
    .map((b) => ({
      start: pickDate(b.scheduled_for || b.start || b.starts_at),
      end: pickDate(b.scheduled_to || b.end || b.ends_at),
      assignees: bookingAssigneeIds(b),
      source: "booking",
      id: b.id,
    }))
    .filter((b) => b.start);
}

// Замовлення (роботи) майстра теж займають його час.
// Інтервал замовлення: від scheduled_for до due_date; якщо due_date немає —
// до кінця робочого дня; якщо немає scheduled_for — весь день due_date.
function orderAssigneeIds(o) {
  const ids = [];
  const add = (v) => { if (v && (v.id || typeof v === "number" || typeof v === "string")) ids.push(Number(v.id || v)); };
  add(o.engineer_id); add(o.engineer); add(o.assignee_id); add(o.assignee);
  add(o.employee_id); add(o.employee);
  ["engineers", "assignees", "employees"].forEach((k) => { if (Array.isArray(o[k])) o[k].forEach(add); });
  return ids.filter((x) => !isNaN(x));
}
function endOfWorkday(date) {
  const p = kyivParts(date);
  return kyivToDate(p.y, p.m, p.d, WORK_END);
}
function startOfWorkday(date) {
  const p = kyivParts(date);
  return kyivToDate(p.y, p.m, p.d, WORK_START);
}
async function fetchOrdersRange(field, from, to) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const q =
      `/orders?page=${page}&branch_ids=${ROAPP_BRANCH_ID}` +
      `&${field}=${encodeURIComponent(isoZ(from))}&${field}=${encodeURIComponent(isoZ(to))}`;
    const r = await roappGet(q);
    if (r.status !== 200) {
      throw new Error(`RO App orders ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    const list = Array.isArray(r.body) ? r.body : r.body.data || [];
    all.push(...list);
    const totalPages = (r.body.paging && r.body.paging.total_pages) || 1;
    if (page >= totalPages || list.length === 0) break;
  }
  return all;
}
async function fetchOrders(from, to) {
  const byId = new Map();
  for (const field of ["scheduled_for", "due_date"]) {
    for (const o of await fetchOrdersRange(field, from, to)) byId.set(o.id, o);
  }
  const res = [];
  for (const o of byId.values()) {
    if (o.closed_at) continue; // закриті замовлення не займають майстра
    if (bookingIsCancelled(o)) continue; // "Відмова" / скасовані
    let start = pickDate(o.scheduled_for);
    let end = pickDate(o.scheduled_to) || pickDate(o.due_date);
    if (!start && !end) continue;
    if (!start) { start = startOfWorkday(end); end = endOfWorkday(end); }
    if (!end || end <= start) end = endOfWorkday(start);
    res.push({ start, end, assignees: orderAssigneeIds(o), source: "order", id: o.id });
  }
  return res;
}
// Уся зайнятість: записи + замовлення
async function fetchBusy(from, to) {
  const [bookings, orders] = await Promise.all([fetchBookings(from, to), fetchOrders(from, to)]);
  return bookings.concat(orders);
}

function masterBusy(bookings, masterId, start, end) {
  return bookings.some((b) => {
    if (!b.assignees.includes(Number(masterId))) return false;
    const bEnd = b.end || new Date(b.start.getTime() + 60 * 60000);
    return b.start < end && bEnd > start;
  });
}

// Кеш запропонованих слотів: userId -> { slotId: {...} }
const offeredSlots = new Map();

async function findFreeSlots(userId, serviceKey, maxResults = 4) {
  const svc = BOOKING_SERVICES[serviceKey];
  if (!svc) return { error: "Невідома послуга. Доступні: " + Object.keys(BOOKING_SERVICES).join(", ") };

  const now = new Date();
  const until = new Date(now.getTime() + BOOKING_DAYS_AHEAD * 24 * 3600 * 1000);
  const bookings = await fetchBusy(new Date(now.getTime() - 7 * 24 * 3600 * 1000), until);

  const result = [];
  const cache = {};
  // Починаємо з завтрашнього дня
  for (let i = 1; i <= BOOKING_DAYS_AHEAD && result.length < maxResults; i++) {
    const p = kyivParts(new Date(now.getTime() + i * 24 * 3600 * 1000));
    if (!WORK_DAYS.includes(p.wd)) continue;
    // Місткість майстра на день = кількість вікон послуги (напр. 2 авто на день).
    // День зайнятий, якщо в майстра вже стільки робіт (замовлень/записів), скільки вікон.
    const dayStart = kyivToDate(p.y, p.m, p.d, WORK_START);
    const dayEnd = kyivToDate(p.y, p.m, p.d, WORK_END);
    let chosen = null;
    for (const mId of svc.masters) {
      const jobs = bookings.filter(
        (b) => b.assignees.includes(Number(mId)) && b.start < dayEnd && (b.end || b.start) > dayStart
      );
      if (jobs.length >= svc.slots.length) continue; // день у майстра заповнений
      // Перше вікно, яке не перетинається з наявними роботами; інакше — наступне по черзі
      let idx = svc.slots.findIndex(([s, e]) => {
        const st = kyivToDate(p.y, p.m, p.d, s);
        const en = kyivToDate(p.y, p.m, p.d, e);
        return !masterBusy(jobs, mId, st, en);
      });
      if (idx < 0) idx = jobs.length;
      chosen = { mId, idx };
      break;
    }
    if (chosen) {
      const [s, e] = svc.slots[chosen.idx];
      const start = kyivToDate(p.y, p.m, p.d, s);
      const end = kyivToDate(p.y, p.m, p.d, e);
      const master = chosen.mId;
      const slotId = `S${Object.keys(cache).length + 1}`;
      cache[slotId] = { serviceKey, masterId: master, start: isoZ(start), end: isoZ(end) };
      result.push({
        slot_id: slotId,
        day: dayLabel(start),
        time: svc.slots.length === 1 ? `з ${s} (машину залишають на день)` : `${s}–${e}`,
        master: MASTERS[master],
      });
    }
  }
  offeredSlots.set(userId, cache);
  if (result.length === 0) return { service: svc.title, slots: [], note: "Вільних вікон найближчим часом немає — запропонуй зворотний дзвінок менеджера." };
  return { service: svc.title, slots: result };
}

async function roappPost(path, body) {
  const resp = await fetch(ROAPP_BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ROAPP_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

async function bookSlot(userId, input, source) {
  const cache = offeredSlots.get(userId) || {};
  const slot = cache[input.slot_id];
  if (!slot) return { ok: false, error: "Слот не знайдено — спочатку виклич find_free_slots і запропонуй вікна клієнту." };
  if (!input.name || !input.phone) return { ok: false, error: "Потрібні ім'я і телефон клієнта." };

  // Перевіряємо ще раз, чи вікно досі вільне
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const bookings = await fetchBusy(new Date(start.getTime() - 7 * 24 * 3600 * 1000), new Date(end.getTime() + 3600 * 1000));
  const svcCap = BOOKING_SERVICES[slot.serviceKey].slots.length;
  const sp = kyivParts(start);
  const dS = kyivToDate(sp.y, sp.m, sp.d, WORK_START);
  const dE = kyivToDate(sp.y, sp.m, sp.d, WORK_END);
  const dayJobs = bookings.filter(
    (b) => b.assignees.includes(Number(slot.masterId)) && b.start < dE && (b.end || b.start) > dS
  );
  if (dayJobs.length >= svcCap || masterBusy(dayJobs, slot.masterId, start, end)) {
    return { ok: false, error: "Це вікно вже зайняли. Виклич find_free_slots ще раз і запропонуй інші варіанти." };
  }

  const svc = BOOKING_SERVICES[slot.serviceKey];
  const comment =
    `Онлайн-запис з чат-бота (${source}). Клієнт: ${input.name}, тел: ${input.phone}. ` +
    `Послуга: ${svc.title}. ${input.car ? "Авто: " + input.car + ". " : ""}${input.comment || ""}`.trim();

  const body = {
    branch_id: ROAPP_BRANCH_ID,
    assignee_id: slot.masterId,
    scheduled_for: slot.start,
    scheduled_to: slot.end,
    resource_id: svc.box,
    comment,
  };
  let r = await roappPost("/bookings", body);
  if (r.status >= 400) {
    // У документації scheduled_to описано як масив — пробуємо і так
    r = await roappPost("/bookings", { ...body, scheduled_to: [slot.end] });
  }
  console.log("RO App створення запису:", r.status, r.text.slice(0, 1000), JSON.stringify(body));
  if (r.status >= 400) {
    return { ok: false, error: "Запис НЕ створено через помилку CRM. Не називай клієнту дату як підтверджену. Скажи, що заявку передано менеджеру і він зателефонує, щоб узгодити зручний час." };
  }
  delete cache[input.slot_id];
  return { ok: true, day: dayLabel(start), master: MASTERS[slot.masterId], service: svc.title };
}

const BOOKING_TOOLS = [
  {
    name: "find_free_slots",
    description:
      "Знаходить вільні вікна для запису в AvtoFizika на найближчі 2 тижні за графіком записів у CRM. " +
      "Викликай, коли клієнт хоче записатися онлайн. Повертає до 4 варіантів (slot_id, день, час, майстер).",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: Object.keys(BOOKING_SERVICES),
          description: Object.entries(BOOKING_SERVICES).map(([k, v]) => `${k} — ${v.title}`).join("; "),
        },
      },
      required: ["service"],
    },
  },
  {
    name: "book_slot",
    description:
      "Створює запис у CRM на обране клієнтом вікно. Викликай ЛИШЕ після того, як клієнт обрав один із запропонованих варіантів і назвав ім'я та телефон.",
    input_schema: {
      type: "object",
      properties: {
        slot_id: { type: "string", description: "slot_id з результату find_free_slots" },
        name: { type: "string" },
        phone: { type: "string" },
        car: { type: "string", description: "Марка, модель, рік авто (якщо відомо)" },
        comment: { type: "string", description: "Коротко суть запиту клієнта" },
      },
      required: ["slot_id", "name", "phone"],
    },
  },
];

async function runBookingTool(userId, name, input, source) {
  try {
    if (name === "find_free_slots") return await findFreeSlots(userId, input.service);
    if (name === "book_slot") return await bookSlot(userId, input, source);
    return { error: "Невідомий інструмент" };
  } catch (err) {
    console.error(`Помилка інструмента ${name}:`, err);
    return { error: "Система запису тимчасово недоступна, запис НЕ створено. Не підтверджуй клієнту жодну дату — запропонуй зворотний дзвінок менеджера для узгодження часу." };
  }
}

app.listen(PORT, () => {
  console.log(`AvtoFizika bot server запущен на порту ${PORT}`);
});
