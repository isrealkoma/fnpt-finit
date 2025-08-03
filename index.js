require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const multer = require("multer");
const { default: OpenAI } = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const WHATSAPP_TOKEN = `Bearer ${process.env.META_ACCESS_TOKEN}`;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "fntp-fintech";

// Parse JSON
app.use(express.json());

// 🧪 Webhook Verification for Meta
app.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    res.status(200).send(challenge);
  } else {
    console.log("Webhook verification failed ❌");
    res.sendStatus(403);
  }
});

// 📥 Incoming WhatsApp Message Webhook
app.post("/whatsapp", async (req, res) => {
  const body = req.body;

  if (
    body?.object === "whatsapp_business_account" &&
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  ) {
    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from; // WhatsApp user number
    const msgBody = msg.text?.body?.trim().toLowerCase() || "";

    console.log(`📩 Received message: ${msgBody} from ${from}`);

    // 🔁 Define your logic
    let reply = "Sorry, I didn't understand your message.";

    if (msgBody.includes("balance")) {
      reply = "Your current balance is UGX 45,000.";
    } else if (msgBody.includes("loan")) {
      reply = "You have an active loan of UGX 120,000. Due: 12 Aug 2025.";
    }

    // 📤 Send reply
    await sendWhatsappMessage(from, reply);
  }

  res.sendStatus(200);
});

// 📤 Send WhatsApp Message
async function sendWhatsappMessage(to, messageText) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: messageText,
        },
      },
      {
        headers: {
          Authorization: WHATSAPP_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Message sent:", res.data);
  } catch (error) {
    console.error(
      "❌ Failed to send message:",
      error.response?.data || error.message
    );
  }
}

// Optional: Audio Transcription with Whisper
const upload = multer({ dest: "uploads/" });

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
    });
    fs.unlinkSync(req.file.path); // Clean up file
    res.json({ transcription: transcription.text });
  } catch (err) {
    console.error("Whisper error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
