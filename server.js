import express from "express";
import { Telegraf } from "telegraf";
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

dotenv.config();

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [291735216];

// הגדרת גוגל
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
);

// --- פונקציות עזר (גוגל, זיכרון, חיפוש) ---

async function getGoogleAuth(chatId) {
    const { data } = await supabase.from('user_tokens').select('tokens').eq('chat_id', chatId).single();
    if (!data) return null;
    oauth2Client.setCredentials(data.tokens);
    return google.calendar({ version: 'v3', auth: oauth2Client });
}

async function saveMessage(chatId, role, content) {
    await supabase.from('messages').insert([{ chat_id: chatId, role, content }]);
}

async function getHistory(chatId) {
    const { data } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(10);
    return data ? data.reverse() : [];
}

// --- המוח המרכזי ---

async function askAI(ctx, text) {
    const chatId = ctx.chat.id;
    try {
        await ctx.sendChatAction("typing");
        const calendar = await getGoogleAuth(chatId);
        let calendarContext = "";

        // בדיקה אם המשתמש שואל על היומן
        if (text.includes("יומן") || text.includes("לוח זמנים") || text.includes("פגישה")) {
            if (!calendar) {
                return ctx.reply("אני עדיין לא מחובר ליומן שלך. הקלד /login כדי להתחבר.");
            }
            // שליפת אירועים להיום כברירת מחדל כדי לתת ל-AI הקשר
            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin: new Date().toISOString(),
                maxResults: 5,
                singleEvents: true,
                orderBy: 'startTime',
            });
            calendarContext = res.data.items.map(e => `${e.summary} ב-${e.start.dateTime || e.start.date}`).join("\n");
        }

        const history = await getHistory(chatId);
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "אתה עוזר אישי חכם עבור מיכאל. יש לך גישה ליומן שלו אם מופיע בהקשר. ענה בעברית מקצועית." },
                ...history,
                { role: "user", content: calendarContext ? `אירועים קרובים ביומן:\n${calendarContext}\n\nשאלה: ${text}` : text }
            ],
        });

        const reply = response.choices[0].message.content;
        await saveMessage(chatId, "user", text);
        await saveMessage(chatId, "assistant", reply);
        await ctx.reply(reply);
    } catch (error) {
        ctx.reply("חלה שגיאה בעיבוד. וודא שהתחברת ליומן עם /login");
    }
}

// --- פקודות ואירועים ---

bot.command('login', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
        state: ctx.chat.id.toString()
    });
    ctx.reply(`לחץ כאן כדי לאשר לי גישה ליומן:\n${url}`);
});

app.get("/oauth2callback", async (req, res) => {
    const { code, state } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        await supabase.from('user_tokens').upsert({ chat_id: parseInt(state), tokens });
        res.send("התחברת בהצלחה! אפשר לחזור לטלגרם.");
        bot.telegram.sendMessage(parseInt(state), "מעולה! אני מחובר ליומן שלך. מה תרצה לדעת?");
    } catch (err) { res.send("שגיאה בהתחברות."); }
});

bot.on("text", (ctx) => { if (ALLOWED_USERS.includes(ctx.chat.id)) askAI(ctx, ctx.message.text); });

bot.on('voice', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    let tempFilePath = path.join(os.tmpdir(), `voice_${ctx.message.voice.file_id}.oga`);
    try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const downloadRes = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        fs.writeFileSync(tempFilePath, Buffer.from(downloadRes.data));
        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempFilePath), model: "whisper-1" });
        await ctx.reply(`אמרת: "${transcription.text}"`);
        await askAI(ctx, transcription.text);
    } finally { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); }
});

bot.on('photo', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.photo.pop().file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
        const aiRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: [{ type: "text", text: "מה בתמונה?" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }]
        });
        ctx.reply(aiRes.choices[0].message.content);
    } catch (err) { ctx.reply("שגיאה בניתוח תמונה."); }
});

app.get("/", (req, res) => res.send("Super-Agent v1.5 Calendar Ready! 🚀"));
app.listen(process.env.PORT || 3000, () => { bot.launch(); console.log("Bot started with Google Calendar support."); });
