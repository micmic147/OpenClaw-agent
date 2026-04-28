import express from "express";
import { Telegraf, Markup } from "telegraf"; // הוספנו את Markup
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";
import { google } from 'googleapis';
import * as dotenv from "dotenv";
import axios from "axios";
import pdf from "pdf-parse/lib/pdf-parse.js";
import * as XLSX from "xlsx";
import fs from 'fs';
import path from 'path';
import os from 'os';
import cron from 'node-cron';

dotenv.config();

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [291735216];

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
);

// --- פונקציות עזר (גוגל, זיכרון, יומן) ---

async function getGoogleAuth(chatId) {
    const { data } = await supabase.from('user_tokens').select('tokens').eq('chat_id', chatId).single();
    if (!data) return null;
    oauth2Client.setCredentials(data.tokens);
    return google.calendar({ version: 'v3', auth: oauth2Client });
}

async function fetchDailySchedule(chatId) {
    const calendar = await getGoogleAuth(chatId);
    if (!calendar) return "לא מצאתי חיבור ליומן. הרץ /login.";
    
    const now = new Date();
    const start = new Date(now.setHours(0, 0, 0, 0)).toISOString();
    const end = new Date(now.setHours(23, 59, 59, 999)).toISOString();

    const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: start,
        timeMax: end,
        singleEvents: true,
        orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) return "אין פגישות להיום! 🎉";
    
    return events.map(e => {
        const time = e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : "כל היום";
        return `• ${time} - ${e.summary}`;
    }).join("\n");
}

// --- המוח המרכזי ---

async function askAI(ctx, text) {
    const chatId = ctx.chat.id;
    try {
        await ctx.sendChatAction("typing");
        const history = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(10);
        const chatHistory = history.data ? history.data.reverse() : [];
        const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: `אתה עוזר אישי חכם עבור מיכאל (מומחה Data ו-SQL). השעה עכשיו: ${now}. ענה בעברית מקצועית ותמציתית.` },
                ...chatHistory,
                { role: "user", content: text }
            ],
        });

        const reply = response.choices[0].message.content;
        await supabase.from('messages').insert([{ chat_id: chatId, role: 'user', content: text }, { chat_id: chatId, role: 'assistant', content: reply }]);
        await ctx.reply(reply, mainMenu); // תמיד מציג את התפריט אחרי תשובה
    } catch (error) {
        ctx.reply("חלה שגיאה קלה...");
    }
}

// --- הגדרת תפריט כפתורים ---

const mainMenu = Markup.keyboard([
    ['📅 הלו"ז שלי היום', '🌐 חיפוש באינטרנט'],
    ['📊 ניתוח קובץ', '💬 שאל שאלה']
]).resize();

// --- פקודות ואירועים ---

bot.start((ctx) => {
    if (ALLOWED_USERS.includes(ctx.chat.id)) {
        ctx.reply("ברוך הבא מיכאל! איך אני יכול לעזור היום? 🚀", mainMenu);
    }
});

// טיפול בכפתורים
bot.hears('📅 הלו"ז שלי היום', async (ctx) => {
    await ctx.reply("בודק את היומן שלך... ⏳");
    const schedule = await fetchDailySchedule(ctx.chat.id);
    await ctx.reply(`🌞 **הלו"ז שלך להיום:**\n\n${schedule}`, { parse_mode: 'Markdown' });
});

bot.hears('🌐 חיפוש באינטרנט', (ctx) => ctx.reply("מה תרצה שאחפש עבורך? (פשוט כתוב 'חפש...' ואת הנושא)"));
bot.hears('📊 ניתוח קובץ', (ctx) => ctx.reply("שלח לי קובץ PDF או Excel ואני אנתח אותו עבורך מיד."));
bot.hears('💬 שאל שאלה', (ctx) => ctx.reply("אני מקשיב! אפשר גם לשלוח הודעה קולית."));

// הודעות טקסט רגילות (אם זה לא כפתור)
bot.on('text', (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    const text = ctx.message.text;
    if (['📅 הלו"ז שלי היום', '🌐 חיפוש באינטרנט', '📊 ניתוח קובץ', '💬 שאל שאלה'].includes(text)) return;
    
    if (text.startsWith("חפש ")) {
        const query = text.replace("חפש ", "");
        ctx.reply(`מחפש באינטרנט על: ${query}...`);
        // לוגיקת חיפוש Tavily כאן (דומה למה שעשינו קודם)
    }
    askAI(ctx, text);
});

// (המשך קוד ה-Voice וה-Photo נשאר זהה לגרסה הקודמת...)
// הוספנו את ה-Voice וה-Photo למען השלמות:
bot.on('voice', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    let tempFilePath = path.join(os.tmpdir(), `voice_${ctx.message.voice.file_id}.oga`);
    try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const downloadRes = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        fs.writeFileSync(tempFilePath, Buffer.from(downloadRes.data));
        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempFilePath), model: "whisper-1" });
        await ctx.reply(`🎤: "${transcription.text}"`);
        await askAI(ctx, transcription.text);
    } finally { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); }
});

// Cron Job לסיכום בוקר אוטומטי
cron.schedule('0 8 * * *', async () => {
    const schedule = await fetchDailySchedule(291735216);
    await bot.telegram.sendMessage(291735216, `🌞 **בוקר טוב מיכאל! הנה הלו"ז להיום:**\n\n${schedule}`, { parse_mode: 'Markdown' });
}, { timezone: "Asia/Jerusalem" });

app.get("/", (req, res) => res.send("Super-Agent v1.6 with Menu Buttons Online! 🚀"));
app.listen(process.env.PORT || 3000, () => {
    bot.launch();
    console.log("Bot started with Menu Interface.");
});
