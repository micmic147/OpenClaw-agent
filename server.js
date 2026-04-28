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

// --- פונקציות עזר ---

async function getGoogleAuth(chatId) {
    const { data, error } = await supabase.from('user_tokens').select('tokens').eq('chat_id', chatId).single();
    if (error || !data) {
        console.log("❌ לא נמצא טוקן ב-Supabase עבור המשתמש");
        return null;
    }
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

async function searchWeb(query) {
    const searchResult = await tvly.search(query, { searchDepth: "advanced" });
    return searchResult.results.map(r => `${r.title}: ${r.content}`).join("\n");
}

// --- המוח המרכזי (משופר ליומן) ---

async function askAI(ctx, text) {
    const chatId = ctx.chat.id;
    try {
        await ctx.sendChatAction("typing");
        const calendar = await getGoogleAuth(chatId);
        let calendarContext = "";

        // בדיקה משופרת - אם יש מילים שקשורות לזמן או פגישות
        const calendarKeywords = ["יומן", "לוח זמנים", "פגישה", "לו״ז", "מחר", "היום", "שבוע"];
        const shouldCheckCalendar = calendarKeywords.some(keyword => text.toLowerCase().includes(keyword));

        if (shouldCheckCalendar && calendar) {
            console.log("📅 ניגש לשלוף אירועים מהיומן...");
            try {
                const res = await calendar.events.list({
                    calendarId: 'primary',
                    timeMin: new Date().toISOString(), // החל מעכשיו
                    maxResults: 15, // הגדלנו כדי לראות גם את מחר
                    singleEvents: true,
                    orderBy: 'startTime',
                });
                
                if (res.data.items && res.data.items.length > 0) {
                    calendarContext = res.data.items.map(e => {
                        const start = e.start.dateTime || e.start.date;
                        return `- ${e.summary} (מתחיל ב: ${start})`;
                    }).join("\n");
                } else {
                    calendarContext = "אין אירועים קרובים ביומן.";
                }
            } catch (err) {
                console.error("Calendar API Error:", err.message);
                calendarContext = "שגיאה בגישה ליומן. ייתכן שצריך להתחבר מחדש עם /login.";
            }
        }

        const history = await getHistory(chatId);
        const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `אתה עוזר אישי חכם עבור מיכאל. 
                    התאריך והשעה עכשיו הם: ${now}. 
                    אם המשתמש שואל על מחר, חשב את התאריך לפי השעה הנוכחית. 
                    קיבלת גישה לנתוני היומן שלו במידה והם מופיעים בהקשר - השתמש בהם כדי לענות. 
                    אל תגיד 'אני צריך גישה' אם כבר סיפקו לך נתונים.` 
                },
                ...history,
                { 
                    role: "user", 
                    content: calendarContext ? `להלן רשימת האירועים מהיומן שלי:\n${calendarContext}\n\nשאלה: ${text}` : text 
                }
            ],
        });

        const reply = response.choices[0].message.content;
        await saveMessage(chatId, "user", text);
        await saveMessage(chatId, "assistant", reply);
        await ctx.reply(reply);

    } catch (error) {
        console.error("Global Error:", error);
        ctx.reply("משהו השתבש בעיבוד הבקשה.");
    }
}

// --- פקודות ואירועים ---

bot.command('login', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // מכריח קבלת Refresh Token
        scope: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
        state: ctx.chat.id.toString()
    });
    ctx.reply(`לחץ כאן כדי לחבר את היומן:\n${url}`);
});

app.get("/oauth2callback", async (req, res) => {
    const { code, state } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        await supabase.from('user_tokens').upsert({ chat_id: parseInt(state), tokens });
        res.send("התחברת בהצלחה! אפשר לחזור לטלגרם.");
        bot.telegram.sendMessage(parseInt(state), "מעולה! עכשיו אני רואה את היומן שלך. שאל אותי למשל: 'איזה פגישות יש לי מחר?'");
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
        await ctx.reply(`🎤: "${transcription.text}"`);
        await askAI(ctx, transcription.text);
    } catch (err) { ctx.reply("שגיאה בתמלול הקול."); }
    finally { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); }
});

bot.on('photo', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.photo.pop().file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
        const aiRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: [{ type: "text", text: "נתח את התמונה עבור מיכאל." }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }]
        });
        ctx.reply(aiRes.choices[0].message.content);
    } catch (err) { ctx.reply("שגיאה בניתוח תמונה."); }
});

app.get("/", (req, res) => res.send("Super-Agent v1.5.1 Calendar Pro Online! 🚀"));
// משימה אוטומטית שרצה כל בוקר ב-08:00 (לפי שעון ישראל)
cron.schedule('0 8 * * *', async () => {
    const chatId = 291735216; // ה-ID שלך
    console.log("⏰ מריץ סיכום בוקר אוטומטי...");
    
    try {
        const calendar = await getGoogleAuth(chatId);
        if (!calendar) return;

        const now = new Date();
        const startOfDay = new Date(now.setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(now.setHours(23, 59, 59, 999)).toISOString();

        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: startOfDay,
            timeMax: endOfDay,
            singleEvents: true,
            orderBy: 'startTime',
        });

        let message = "🌞 **בוקר טוב מיכאל! הנה הלו״ז שלך להיום:**\n\n";
        
        if (res.data.items && res.data.items.length > 0) {
            res.data.items.forEach(e => {
                const startTime = e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : "כל היום";
                message += `• ${startTime} - ${e.summary}\n`;
            });
        } else {
            message += "אין לך פגישות מתוכננות להיום. זמן מצוין להתמקד בפיתוח! 🚀";
        }

        // שליחת הודעת מחקר קטנה (בונוס)
        message += "\n\n💡 **טיפ יומי:** כדאי לבדוק היום את נתוני ה-Conversion ב-Dashboard החדש.";

        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error("Cron Job Error:", err.message);
    }
}, {
    timezone: "Asia/Jerusalem"
});
app.listen(process.env.PORT || 3000, () => { bot.launch(); console.log("Bot started with Enhanced Calendar Logic."); });
