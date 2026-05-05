const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== 1. CONFIGURACIÓN ==========
const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error("❌ Falta BOT_TOKEN en variables de entorno");
    process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("❌ Falta STRIPE_SECRET_KEY en variables de entorno");
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

// ========== 2. PREGUNTAS ==========
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

// ========== 3. SESIONES EN MEMORIA ==========
const sessions = new Map();

// ========== 4. FUNCIONES AUXILIARES ==========
function calculateMetrics(answers) {
    const totalChars = answers.join(" ").length;
    let ihg = Math.min(0.95, 0.3 + totalChars / 500);
    let nti = Math.max(0.2, 0.7 - (answers.length / 30));
    let ldi = Math.max(1.2, 5.0 - (answers.length / 5));
    return { ihg: ihg.toFixed(2), nti: nti.toFixed(2), ldi: ldi.toFixed(1) };
}

function escapeHtml(str) {
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function injectAnswersAndMetrics(htmlTemplatePath, answers, metrics) {
    let html = fs.readFileSync(htmlTemplatePath, "utf8");
    const answersHtml = answers.map((a, i) => `<div class="var-row"><div class="var-code">P${i+1}</div><div class="var-desc">${escapeHtml(a)}</div></div>`).join("");
    html = html.replace(/<!-- RESPUESTAS_USUARIO -->/, answersHtml);
    html = html.replace(/\{\{IHG\}\}/g, metrics.ihg);
    html = html.replace(/\{\{NTI\}\}/g, metrics.nti);
    html = html.replace(/\{\{LDI\}\}/g, metrics.ldi);
    html = html.replace(/\{\{FECHA\}\}/g, new Date().toLocaleString("es-MX"));
    return html;
}

async function generatePDFFromHTML(htmlContent) {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    return pdf;
}

// ========== 5. WEBHOOK DEL BOT ==========
app.post(`/webhook/${TOKEN}`, async (req, res) => {
    const update = req.body;
    if (!update || !update.message) return res.sendStatus(200);
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || "";

    if (!sessions.has(chatId)) {
        sessions.set(chatId, { step: 0, answers: [] });
        await bot.sendMessage(chatId, "⚡ Bienvenido. Te haré 12 preguntas.");
        await bot.sendMessage(chatId, QUESTIONS[0]);
        return res.sendStatus(200);
    }

    const session = sessions.get(chatId);
    if (session.step < QUESTIONS.length && text) {
        session.answers.push(text);
        session.step++;
        if (session.step < QUESTIONS.length) {
            await bot.sendMessage(chatId, QUESTIONS[session.step]);
        } else {
            const YOUR_DOMAIN = process.env.YOUR_DOMAIN || "https://tu-sitio.com";
            const stripeSession = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'mxn',
                        product_data: { name: 'Dictamen Estructural SF-004 + MIHM v3.0' },
                        unit_amount: 30000,
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                client_reference_id: chatId.toString(),
                metadata: { answers: JSON.stringify(session.answers) },
                success_url: `${YOUR_DOMAIN}/gracias.html`,
                cancel_url: `${YOUR_DOMAIN}/cancel.html`,
            });
            await bot.sendMessage(chatId, `✅ Diagnóstico completado.\n\nPara recibir tu dictamen, paga aquí:\n${stripeSession.url}`);
            sessions.delete(chatId);
        }
        return res.sendStatus(200);
    }
    res.sendStatus(200);
});

// ========== 6. WEBHOOK DE STRIPE ==========
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.log(`⚠️ Error de verificación: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const chatId = parseInt(session.client_reference_id);
        const answers = JSON.parse(session.metadata.answers || "[]");
        const metrics = calculateMetrics(answers);
        
        const templatePath = path.join(__dirname, 'sf004.html');
        const finalHtml = injectAnswersAndMetrics(templatePath, answers, metrics);
        const pdfBuffer = await generatePDFFromHTML(finalHtml);
        
        await bot.sendMessage(chatId, "📄 Pago confirmado. Aquí tu dictamen.");
        await bot.sendDocument(chatId, pdfBuffer, { caption: "System Friction · Dictamen SF-004" });
        console.log(`✅ PDF enviado a chatId ${chatId}`);
    }
    res.json({ received: true });
});

// ========== 7. SERVIDOR ==========
app.get('/', (req, res) => res.send("SF Bot activo."));

const server = app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    bot.setWebHook(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${TOKEN}`);
    console.log(`✅ Webhook del bot configurado.`);
});
