const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { OpenAI } = require("openai");
//require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// OpenAI setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Intent extraction
function extractIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("balance")) return "balance";
  if (lowered.includes("send") || lowered.includes("transfer")) return "transfer";
  if (lowered.includes("loan")) return "loan";
  return "chat";
}

// Meta webhook verification endpoint
app.get("/whatsapp", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Message handler
app.post("/whatsapp", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || !message.text) {
      return res.sendStatus(200); // Nothing to process
    }

    const from = message.from; // WhatsApp user phone number
    const text = message.text.body;

    let replyText = "";
    const intent = extractIntent(text);

    switch (intent) {
      case "balance":
        replyText = "Your current balance is UGX 234,000.";
        break;
      case "transfer":
        replyText = "To transfer funds, please reply with: Send [amount] to [recipient name].";
        break;
      case "loan":
        replyText = "To apply for a loan, reply with the amount and purpose (e.g., 'Loan 50000 for school fees').";
        break;
      default:
        const chatResponse = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [{ role: "user", content: text }],
        });
        replyText = chatResponse.choices[0].message.content;
        break;
    }

    // Send reply via Meta WhatsApp API
    await axios.post(
      "https://graph.facebook.com/v19.0/" + process.env.PHONE_NUMBER_ID + "/messages",
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: replyText },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
