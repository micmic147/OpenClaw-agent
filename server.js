import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";
import * as dotenv from "dotenv";
import axios from "axios";
import pdf from "pdf-parse/lib/pdf-parse.js";
import * as XLSX from "xlsx";

dotenv.config();

// --- 1. הגדרות וחיבורים ---
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [291735216]; // ה-ID שלך

// --- 2. פונקציות עזר (זיכרון, חיפוש, קבצים) ---

// שמירת הודעה בזיכרון הקבוע של Supabase
async function saveMessage(chatId, role, content) {
    const { error } = await supabase.from('messages').insert([{ chat_id: chatId, role, content }]);
    if (error) console.error("❌ שגיאה בשמירה ל-Supabase:", error.message);
    else console.log("✅ הודעה נשמרה בזיכרון");
}

async function getHistory(chatId) {
    const { data, error } = await supabase
        .from('messages')
        .select('role, content')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(10);
    
    if (error) {
        console.error("❌ שגיאה בשליפה מ-Supabase:", error.message);
        return [];
    }
    console.log(`✅ נשלפו ${data?.length || 0} הודעות מהיסטוריית הצ'אט`);
    return data ? data.reverse() : [];
}

// פונקציה לחיפוש באינטרנט
async function searchWeb(query) {
    const searchResult = await tvly.search(query, { searchDepth: "advanced" });
    return searchResult.results.map(r => `${r.title}: ${r.content}`).join("\n");
}

// --- 3. טיפול בקבצים (PDF/Excel) ---

bot.on(['document', 'photo'], async (ctx) => {
    const chatId = ctx.chat.id;
    if (!ALLOWED_USERS.includes(chatId)) return;

    try {
        await ctx.reply("בודק את הקובץ ששלחת... 🧐");
        const fileId = ctx.message.document?.file_id || ctx.message.photo?.pop().file_id;
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        
        const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
        let extractedText = "";

        if (ctx.message.document?.file_name?.endsWith('.pdf')) {
            const data = await pdf(response.data);
            extractedText = data.text;
        } else if (ctx.message.document?.file_name?.endsWith('.xlsx')) {
            const workbook = XLSX.read(response.data);
            extractedText = XLSX.utils.sheet_to_txt(workbook.Sheets[workbook.SheetNames[0]]);
        } else {
            return ctx.reply("כרגע אני תומך רק ב-PDF או Excel. תמונות אני אוכל לנתח בגרסה הבאה!");
        }

        const aiRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "ניתוח מסמך: סכם את המידע החשוב מהטקסט הבא בצורה מקצועית." },
                { role: "user", content: extractedText.substring(0, 5000) } // מגבלה קטנה כדי לא להעמיס
            ]
        });

        ctx.reply(aiRes.choices[0].message.content);
    } catch (err) {
        ctx.reply("מצטער, הייתה בעיה בקריאת הקובץ.");
    }
});

// --- 4. לוגיקה מרכזית (טקסט וחיפוש) ---

bot.on("text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    if (!ALLOWED_USERS.includes(chatId)) return;

    try {
        await ctx.sendChatAction("typing");

        // האם המשתמש רוצה חיפוש? (אם ההודעה מתחילה ב"חפש")
        let context = "";
        if (text.startsWith("חפש ")) {
            const query = text.replace("חפש ", "");
            await ctx.reply(`מחפש באינטרנט על: ${query}... 🌐`);
            context = await searchWeb(query);
        }

        const history = await getHistory(chatId);
        
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "אתה עוזר אישי חכם. אם יש הקשר מהאינטרנט, השתמש בו. אם לא, ענה מהידע שלך." },
                ...history,
                { role: "user", content: context ? `מידע מהאינטרנט: ${context}\n\nשאלה: ${text}` : text }
            ],
        });

        const reply = response.choices[0].message.content;
        
        await saveMessage(chatId, "user", text);
        await saveMessage(chatId, "assistant", reply);
        
        await ctx.reply(reply);
    } catch (error) {
        ctx.reply("משהו השתבש בדרך...");
    }
});

// --- 5. הרצה ---
app.get("/", (req, res) => res.send("Agent System v1.1 Online! 🚀"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    bot.launch();
    console.log("Super-Agent started");
});
