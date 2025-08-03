require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Configuration, OpenAIApi } = require("openai");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// OpenAI setup
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Intent extractor
function extractIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("balance")) return "balance";
  if (lowered.includes("send") || lowered.includes("transfer")) return "transfer";
  if (lowered.includes("loan")) return "loan";
  return "chat";
}

// ✅ Webhook Verification Endpoint for Meta
app.get("/whatsapp", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// ✅ WhatsApp Message Webhook
app.post("/whatsapp", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return res.sendStatus(200); // No message to process

    const from = message.from; // WhatsApp ID
    let finalText = message.text?.body || "";

    // Handle media audio (optional)
    if (message.type === "audio") {
      const mediaId = message.audio.id;
      const accessToken = process.env.META_ACCESS_TOKEN;

      // Get media URL
      const mediaUrlRes = await axios.get(
        `https://graph.facebook.com/v19.0/${mediaId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const mediaUrl = mediaUrlRes.data.url;

      // Download the file
      const oggPath = path.join(__dirname, "voice.ogg");
      const wavPath = path.join(__dirname, "voice.wav");

      const audioData = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      fs.writeFileSync(oggPath, audioData.data);

      // Convert OGG to WAV
      await new Promise((resolve, reject) => {
        ffmpeg(oggPath)
          .toFormat("wav")
          .on("end", resolve)
          .on("error", reject)
          .save(wavPath);
      });

      // Transcribe with Whisper
      const formData = new FormData();
      formData.append("file", fs.createReadStream(wavPath));
      formData.append("model", "whisper-1");

      const whisperResponse = await openai.createTranscription(
        formData.getBuffer(),
        "whisper-1",
        undefined,
        {
          headers: formData.getHeaders(),
        }
      );

      finalText = whisperResponse.data.text;
    }

    const intent = extractIntent(finalText);
    let reply = "";

    switch (intent) {
      case "balance":
        reply = "Your current balance is UGX 234,000.";
        break;
      case "transfer":
        reply = "To transfer funds, reply with: Send [amount] to [recipient name].";
        break;
      case "loan":
        reply = "To apply for a loan, reply with amount and purpose (e.g., 'Loan 50000 for school fees').";
        break;
      default:
        const aiReply = await openai.createChatCompletion({
          model: "gpt-4",
          messages: [{ role: "user", content: finalText }],
        });
        reply = aiReply.data.choices[0].message.content;
        break;
    }

    // Send reply via Meta WhatsApp API
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    res.sendStatus(500);
  }
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
