const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const puppeteer = require("puppeteer");

const TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const QUESTIONS = [
  "¿Qué sientes que no funciona en tu vida o trabajo ahora mismo?",
  "¿Desde cuándo lo vienes cargando así?",
  "¿Qué has hecho para resolverlo hasta ahora?",
  "¿Qué pensabas que iba a pasar?",
  "¿Y qué pasó realmente?",
  "¿En qué te está afectando hoy, en lo concreto?",
  "¿Qué has dejado de lado?",
  "¿Qué se rompe primero si todo sigue igual?",
  "¿Hay algo que sabes que debes hacer y no estás haciendo?",
  "¿Qué te frena realmente?",
  "¿Esto es realmente tuyo o lo cargas de alguien más?",
  "¿Qué perderías si esto se resolviera por completo?"
];

let users = {};

bot.on("message", async (msg) => {
  const id = msg.chat.id;

  if (!users[id]) {
    users[id] = { step: 0, answers: [] };
    bot.sendMessage(id, QUESTIONS[0]);
    return;
  }

  const user = users[id];
  user.answers.push(msg.text);
  user.step++;

  if (user.step < QUESTIONS.length) {
    bot.sendMessage(id, QUESTIONS[user.step]);
  } else {
    bot.sendMessage(
      id,
      "Gracias. Para descargar tu dictamen SF‑004 realiza el pago (simulado).\nEn unos segundos recibirás tu PDF."
    );

    const pdf = await generatePDF();
    bot.sendDocument(id, pdf, {
      caption: "Dictamen SF‑004 · System Friction Institute"
    });
  }
});

async function generatePDF() {
  const html = fs.readFileSync("sf004.html", "utf8");
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();
  return pdf;
}