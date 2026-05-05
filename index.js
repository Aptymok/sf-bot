const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// =======================================
// 1. CONFIGURACIÓN
// =======================================
const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  console.error("❌ Falta BOT_TOKEN");
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("❌ Falta STRIPE_SECRET_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

// =======================================
// 2. PREGUNTAS
// =======================================
const QUESTIONS = [
  "⸻ 1/12 ⸻\n¿Qué sientes que no funciona en tu vida o trabajo ahora mismo?",
  "⸻ 2/12 ⸻\n¿Desde cuándo lo vienes cargando así?",
  "⸻ 3/12 ⸻\n¿Qué has hecho para resolverlo hasta ahora?",
  "⸻ 4/12 ⸻\n¿Qué pensabas que iba a pasar?",
  "⸻ 5/12 ⸻\n¿Y qué pasó realmente?",
  "⸻ 6/12 ⸻\n¿En qué te está afectando hoy, en lo concreto?",
  "⸻ 7/12 ⸻\n¿Qué has tenido que dejar de lado por esto?",
  "⸻ 8/12 ⸻\nSi todo sigue igual, ¿qué se empieza a romper primero?",
  "⸻ 9/12 ⸻\n¿Hay algo que sabes que tendrías que hacer, pero no estás haciendo?",
  "⸻ 10/12 ⸻\n¿Qué te está frenando realmente?",
  "⸻ 11/12 ⸻\n¿Esto es realmente tuyo o lo vienes cargando de alguien más?",
  "⸻ 12/12 ⸻\n¿Qué perderías si esto se resolviera por completo?"
];

// =======================================
// 3. SESIONES EN MEMORIA
// =======================================
const sessions = new Map();

// =======================================
// 4. FUNCIONES AUXILIARES
// =======================================
function calculateMetrics(answers) {
  const totalChars = answers.join(" ").length;
  let ihg = Math.min(0.95, 0.3 + totalChars / 500);
  let nti = Math.max(0.2, 0.7 - (answers.length / 30));
  let ldi = Math.max(1.2, 5.0 - (answers.length / 5));
  return {
    ihg: ihg.toFixed(2),
    nti: nti.toFixed(2),
    ldi: ldi.toFixed(1)
  };
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function injectAnswersAndMetrics(templatePath, answers, metrics) {
  let html = fs.readFileSync(templatePath, "utf8");

  const answersHtml = answers.map(
    (a, i) => `
      <div class="var-row">
        <div class="var-code">P${i + 1}</div>
        <div class="var-desc">${escapeHtml(a)}</div>
      </div>`
  ).join("");

  html = html.replace("<!-- RESPUESTAS_USUARIO -->", answersHtml);
  html = html.replace(/{{IHG}}/g, metrics.ihg);
  html = html.replace(/{{NTI}}/g, metrics.nti);
  html = html.replace(/{{LDI}}/g, metrics.ldi);
  html = html.replace(/{{FECHA}}/g, new Date().toLocaleString("es-MX"));

  return html;
}

async function generatePDFFromHTML(htmlContent) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "networkidle0" });

  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "20mm", bottom: "20mm" }
  });

  await browser.close();
  return pdf;
}

// =======================================
// 5. WEBHOOK STRIPE (RAW BODY)
// =======================================
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send(err.message);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const chatId = parseInt(session.client_reference_id, 10);
      const answers = JSON.parse(session.metadata.answers || "[]");

      const metrics = {
        ihg: session.metadata.ihg,
        nti: session.metadata.nti,
        ldi: session.metadata.ldi
      };

      const templatePath = path.join(__dirname, "sf004.html");
      const finalHtml = injectAnswersAndMetrics(templatePath, answers, metrics);
      const pdf = await generatePDFFromHTML(finalHtml);

      await bot.sendMessage(chatId, "📄 Pago confirmado. Aquí tu dictamen.");
      await bot.sendDocument(
        chatId,
        { source: pdf, filename: "dictamen-sf004.pdf" },
        { caption: "System Friction · Dictamen SF-004" }
      );
    }

    res.json({ received: true });
  }
);

// =======================================
// 6. MIDDLEWARES NORMALES
// =======================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =======================================
// 7. WEBHOOK TELEGRAM
// =======================================
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text || "";

  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: 0, answers: [] });
    await bot.sendMessage(chatId, "⚡ Bienvenido. Te haré 12 preguntas.");
    await bot.sendMessage(chatId, QUESTIONS[0]);
    return res.sendStatus(200);
  }

  const session = sessions.get(chatId);
  if (text && session.step < QUESTIONS.length) {
    session.answers.push(text);
    session.step++;

    if (session.step < QUESTIONS.length) {
      await bot.sendMessage(chatId, QUESTIONS[session.step]);
    } else {
      const metrics = calculateMetrics(session.answers);
      const YOUR_DOMAIN = process.env.YOUR_DOMAIN;

      const stripeSession = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        client_reference_id: chatId.toString(),
        metadata: {
          answers: JSON.stringify(session.answers),
          ...metrics
        },
        line_items: [{
          price_data: {
            currency: "mxn",
            product_data: { name: "Dictamen Estructural SF-004 + MIHM v3.0" },
            unit_amount: 30000
          },
          quantity: 1
        }],
        success_url: `${YOUR_DOMAIN}/gracias.html`,
        cancel_url: `${YOUR_DOMAIN}/cancel.html`
      });

      await bot.sendMessage(
        chatId,
        `✅ Diagnóstico completado.\n\nPaga aquí para recibir tu dictamen:\n${stripeSession.url}`
      );

      sessions.delete(chatId);
    }
  }

  res.sendStatus(200);
});

// =======================================
// 8. SERVIDOR
// =======================================
app.get("/", (_, res) => res.send("SF Bot activo."));

app.listen(PORT, () => {
  console.log(`✅ Servidor activo en puerto ${PORT}`);
  bot.setWebHook(
    `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${TOKEN}`
  );
});
