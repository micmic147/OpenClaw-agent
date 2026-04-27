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
