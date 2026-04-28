import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";
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

// --- פונקציות זיכרון וחיפוש ---

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

// --- המוח המרכזי (מתקן את הלופ) ---

async function askAI(ctx, text) {
    const chatId = ctx.chat.id;

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
                { role: "system", content: "אתה עוזר אישי חכם עבור מיכאל. ענה בעברית מקצועית ועניינית. השתמש בהקשר מהאינטרנט אם קיים." },
                ...history,
                { role: "user", content: context ? `מידע מהאינטרנט: ${context}\n\nשאלה: ${text}` : text }
            ],
        });

        const reply = response.choices[0].message.content;
        await saveMessage(chatId, "user", text);
        await saveMessage(chatId, "assistant", reply);
        await ctx.reply(reply);

    } catch (error) {
        console.error("AI Error:", error.message);
        ctx.reply("חלה שגיאה בעיבוד הבקשה.");
    }
}

// --- טיפול באירועים ---

// 1. טקסט
bot.on("text", (ctx) => {
    if (ALLOWED_USERS.includes(ctx.chat.id)) askAI(ctx, ctx.message.text);
});

// 2. קול (Whisper)
bot.on('voice', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    let tempFilePath = "";
    try {
        await ctx.reply("מקשיב... 🎧");
        const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const downloadRes = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        tempFilePath = path.join(os.tmpdir(), `voice_${ctx.message.voice.file_id}.oga`);
        fs.writeFileSync(tempFilePath, Buffer.from(downloadRes.data));

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: "whisper-1",
        });

        await ctx.reply(`אמרת: "${transcription.text}"`);
        // במקום handleUpdate, אנחנו פונים ישירות למוח:
        await askAI(ctx, transcription.text);

    } catch (err) {
        console.error("Voice Error:", err.message);
        ctx.reply("שגיאה בתמלול הקול.");
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
});

// 3. תמונות (Vision)
bot.on('photo', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    try {
        await ctx.reply("מנתח תמונה... 🧐");
        const fileLink = await ctx.telegram.getFileLink(ctx.message.photo.pop().file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');

        const aiRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "ניתוח תמונות עבור מיכאל." },
                { role: "user", content: [{ type: "text", text: "מה בתמונה?" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }
            ]
        });
        ctx.reply(aiRes.choices[0].message.content);
    } catch (err) { ctx.reply("שגיאה בניתוח תמונה."); }
});

// 4. מסמכים
bot.on('document', async (ctx) => {
    if (!ALLOWED_USERS.includes(ctx.chat.id)) return;
    try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        let text = "";
        if (ctx.message.document.file_name.endsWith('.pdf')) {
            const data = await pdf(response.data);
            text = data.text;
        } else if (ctx.message.document.file_name.endsWith('.xlsx')) {
            const workbook = XLSX.read(response.data);
            text = XLSX.utils.sheet_to_txt(workbook.Sheets[workbook.SheetNames[0]]);
        }
        await askAI(ctx, `סכם את המסמך הזה: ${text.substring(0, 5000)}`);
    } catch (err) { ctx.reply("שגיאה בקריאת מסמך."); }
});

app.get("/", (req, res) => res.send("Super-Agent v1.4 Loop-Fix Online! 🚀"));
app.listen(process.env.PORT || 3000, () => {
    bot.launch();
    console.log("Bot logic updated and loop fixed.");
});
