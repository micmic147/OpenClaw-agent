import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Agent is alive 🚀");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
