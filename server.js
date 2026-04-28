import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";
import * as dotenv from "dotenv";
import axios from "axios";
import pdf from "pdf-parse/lib/pdf-parse.js";
import * as XLSX from "xlsx";

// תוספות קריטיות לטיפול בקבצים אמיתיים (מובנות ב-Node)
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

// --- 1. הגדרות וחיבורים ---
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [291735216]; // ה-ID של מיכאל

// --- 2. פונקציות עזר (זיכרון וחיפוש - נשאר דומה) ---

async function saveMessage(chatId, role, content) {
    const { error } = await supabase.from('messages').insert([{ chat_id: chatId, role, content }]);
    if (error) console.error("Error saving message:", error.message);
}

async function getHistory(chatId) {
    const { data } = await supabase
        .from('messages')
        .select('role, content')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(10);
    return data ? data.reverse() : [];
}

async function searchWeb(query) {
    const searchResult = await tvly.search(query, { searchDepth: "advanced" });
    return searchResult.results.map(r => `${r.title}: ${r.content}`).join("\n");
}

// --- 3. יכולות ראייה (VISION - עבד מעולה!) ---

bot.on('photo', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!ALLOWED_USERS.includes(chatId)) return;

    try {
        await ctx.sendChatAction("typing");
        await ctx.reply("מנתח את התמונה ששלחת... 🧐");

        const fileId = ctx.message.photo.pop().file_id;
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        
        const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');

        const aiRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "אתה עוזר אישי המסוגל לנתח תמונות. תאר מה אתה רואה, תרגם טקסט אם יש, או ענה על שאלות הקשורות לתמונה עבור מיכאל." },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "תאר לי מה אתה רואה בתמונה הזו:" },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                    ]
                }
            ]
        });

        const reply = aiRes.choices[0].message.content;
        await saveMessage(chatId, "assistant", `[תמונת המשתמש נותחה] ${reply}`);
        await ctx.reply(reply);

    } catch (err) {
        console.error("Vision Error:", err.message);
        ctx.reply("מצטער, הייתה בעיה בניתוח התמונה.");
    }
});

// --- 4. טיפול במסמכים (PDF/Excel - נשאר דומה) ---

bot.on('document', async (ctx) => {
    // ... (קוד המסמכים נשאר זהה לקוד הקודם, דולג למען הקיצור)
    const chatId = ctx.chat.id;
    if (!ALLOWED_USERS.includes(chatId)) return;
    try {
        await ctx.reply("בודק את המסמך... 🧐");
        const fileId = ctx.message.document.file_id;
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
        let extractedText = "";
        if (ctx.message.document.file_name.endsWith('.pdf')) {
            const data = await pdf(response.data);
            extractedText = data.text;
        } else if (ctx.message.document.file_name.endsWith('.xlsx')) {
            const workbook = XLSX.read(response.data);
            extractedText = XLSX.utils.sheet_to_txt(workbook.Sheets[workbook.SheetNames[0]]);
        } else { return ctx.reply("כרגע אני תומך רק בסיכום קבצי PDF או Excel."); }
        const aiRes = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "ניתוח מסמך עבור מיכאל: סכם את המידע החשוב מהטקסט בצורה מקצועית ותמציתית." }, { role: "user", content: extractedText.substring(0, 10000) }] });
        ctx.reply(aiRes.choices[0].message.content);
    } catch (err) { ctx.reply("מצטער, הייתה בעיה בקריאת הקובץ."); }
});

// --- 5. יכולות קוליות (WHISPER) - מתוקן, יציב ומהודק! ---

bot.on('voice', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!ALLOWED_USERS.includes(chatId)) return;

    let tempFilePath = "";

    try {
        await ctx.sendChatAction("typing");
        await ctx.reply("מקשיב להודעה הקולית שלך... 🎧");

        // הורדת קובץ הקול
        const fileId = ctx.message.voice.file_id;
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        const downloadRes = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
        
        // יצירת נתיב זמני ייחודי על שרת ה-Railway (בתיקיית הטיוטות)
        const tempDir = os.tmpdir();
        // הוספנו סיומת .oga שזה הפורמט של הודעות קוליות בטלגרם, כדי ש-Whisper יזהה אותו בקלות
        tempFilePath = path.join(tempDir, `voice_${fileId}.oga`);

        // שמירת הקובץ הפיזי על השרת
        fs.writeFileSync(tempFilePath, Buffer.from(downloadRes.data));
        console.log("✅ קובץ קול זמני נשמר ב:", tempFilePath);

        // פנייה ל-OpenAI Whisper עם הקובץ הפיזי
        const transcriptionRes = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath), // עכשיו אנחנו שולחים "סטרים" מקובץ אמיתי
            model: "whisper-1",
        });

        const transcriptText = transcriptionRes.text;
        await ctx.reply(`אמרת: "${transcriptText}"`);
        
        // שליחה של הטקסט המתומלל ללוגיקת הטקסט הרגילה שלנו (שנוכל לתת פקודות קוליות)
        ctx.message.text = transcriptText; 
        bot.handleUpdate({ update_id: ctx.update.id, message: ctx.message });

    } catch (error) {
        console.error("Voice/Whisper Error:", error.message);
        ctx.reply("לא הצלחתי לתמלל את ההודעה הקולית, משהו השתבש בדרך.");
    } finally {
        // שלב קריטי: ניקוי. מחיקת הקובץ הזמני כדי לא למלא את השרת
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log("🗑️ קובץ זמני נמחק");
            } catch (err) {
                console.error("Error deleting temp file:", err.message);
            }
        }
    }
});

// --- 6. לוגיקה מרכזית לטקסט (נשאר דומה) ---

bot.on("text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    if (!ALLOWED_USERS.includes(chatId)) return;

    try {
        await ctx.sendChatAction("typing");

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
                { role: "system", content: "אתה עוזר אישי חכם עבור מיכאל. ענה בעברית מקצועית, קצרה ועניינית. אם יש הקשר מהאינטרנט, השתמש בו לתשובה." },
                ...history,
                { role: "user", content: context ? `מידע עדכני מהאינטרנט: ${context}\n\nשאלה: ${text}` : text }
            ],
        });

        const reply = response.choices[0].message.content;
        
        await saveMessage(chatId, "user", text);
        await saveMessage(chatId, "assistant", reply);
        
        await ctx.reply(reply);
    } catch (error) {
        ctx.reply("סליחה, אירעה שגיאה בדרך.");
    }
});

// --- 7. הרצה ---
app.get("/", (req, res) => res.send("Super-Agent v1.3 with Fixed Voice & Vision Online! 🚀"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    bot.launch();
    console.log("Super-Agent started");
});
