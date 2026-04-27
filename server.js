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
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01"
        }
      }
    );

    res.json({
      answer: response.data.content[0].text
    });

  } catch (error) {
  console.error("FULL ERROR:", error.response?.data || error.message);
  res.status(500).send("Error talking to Claude");
}
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
