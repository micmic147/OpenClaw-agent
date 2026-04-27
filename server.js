import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import * as dotenv from "dotenv";

dotenv.config();

// --- הגדרות ---
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// אבטחה: רק אתה (מיכאל) יכול להשתמש בבוט
const ALLOWED_USERS = [291735216]; 

// זיכרון: שומר את 10 ההודעות האחרונות של כל משתמש כדי שיהיה הקשר לשיחה
const sessions = new Map();

function updateHistory(chatId, role, content) {
    if (!sessions.has(chatId)) sessions.set(chatId, []);
    const history = sessions.get(chatId);
    history.push({ role, content });
    if (history.length > 15) history.shift(); // שומר היסטוריה קצרה ויעילה
}

// --- לוגיקה של הבוט ---

bot.on("text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userMessage = ctx.message.text;

    // 1. בדיקת אבטחה
    if (!ALLOWED_USERS.includes(chatId)) {
        console.log(`Unauthorized access attempt from ID: ${chatId}`);
        return ctx.reply("מצטער, הגישה לבוט זה מוגבלת למנהל בלבד.");
    }

    try {
        // 2. חיווי "מקליד..." בטלגרם
        await ctx.sendChatAction("typing");

        // 3. עדכון זיכרון (הודעת המשתמש)
        updateHistory(chatId, "user", userMessage);

        // 4. פנייה ל-OpenAI עם הזיכרון המלא
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                  role: "system", 
                  content: "אתה עוזר אישי אינטליגנטי. אתה מומחה ב-Data Science, SQL ופיתוח No-Code. ענה בעברית מקצועית, קצרה וקולעת." 
                },
                ...sessions.get(chatId)
            ],
        });

        const aiReply = response.choices[0].message.content;

        // 5. עדכון זיכרון (תשובת ה-AI)
        updateHistory(chatId, "assistant", aiReply);

        // 6. שליחה חזרה למשתמש
        await ctx.reply(aiReply);

    } catch (error) {
        console.error("AI Error:", error.message);
        ctx.reply("אופס, ה-AI נתקל בשגיאה. כדאי לבדוק את ה-API Key ב-Railway.");
    }
});

// --- חיבור לשרת (עבור Railway) ---

// נתיב בסיסי כדי ש-Railway ידע שהשרת חי
app.get("/", (req, res) => res.send("OpenClaw Agent is Online! 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // הפעלת הבוט בשיטת Polling (הכי פשוט ויציב ל-Railway בשלב זה)
    bot.launch();
    console.log("Telegram Bot started");
});

// סגירה נקייה
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
