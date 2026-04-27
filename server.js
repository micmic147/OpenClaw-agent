import express from "express";
import axios from "axios";

const app = express();

app.get("/", (req, res) => {
  res.send("Agent is alive 🚀");
});

app.get("/ask", async (req, res) => {
  const prompt = req.query.prompt || "Hello";

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      answer: response.data.choices[0].message.content
    });

  } catch (error) {
    console.error("FULL ERROR:", JSON.stringify(error.response?.data, null, 2));
    res.status(500).send("Error talking to OpenAI");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

app.use(express.json());

app.post("/telegram", async (req, res) => {
  const message = req.body.message?.text;
  const chatId = req.body.message?.chat?.id;

  if (!message) return res.sendStatus(200);

  try {
    // קריאה ל-AI שלך
    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: message }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = aiResponse.data.choices[0].message.content;

    // שליחה חזרה לטלגרם
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: reply
      }
    );

    res.sendStatus(200);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});
