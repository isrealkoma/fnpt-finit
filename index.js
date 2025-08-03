const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// OpenAI setup using v4 SDK
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Intent extractor
function extractIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("balance")) return "balance";
  if (lowered.includes("send") || lowered.includes("transfer")) return "transfer";
  if (lowered.includes("loan")) return "loan";
  return "chat";
}

// Verify Meta Webhook
app.get("/whatsapp", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook to receive messages
app.post("/whatsapp", async (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (messages && messages.length > 0) {
        const msg = messages[0];
        const phone_number_id = value.metadata.phone_number_id;
        const from = msg.from; // user's WhatsApp number
        let finalText = msg.text?.body || "";

        // Check for audio
        if (msg.type === "audio") {
          const mediaId = msg.audio.id;

          // Get media URL
          const mediaRes = await axios({
            method: "GET",
            url: `https://graph.facebook.com/v19.0/${mediaId}`,
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            },
          });

          const mediaUrl = mediaRes.data.url;

          // Download audio
          const audioBuffer = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            },
          });

          const oggPath = path.join(__dirname, "voice.ogg");
          const wavPath = path.join(__dirname, "voice.wav");
          fs.writeFileSync(oggPath, audioBuffer.data);

          // Convert to WAV
          await new Promise((resolve, reject) => {
            ffmpeg(oggPath)
              .toFormat("wav")
              .on("error", reject)
              .on("end", resolve)
              .save(wavPath);
          });

          // Transcribe using Whisper
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(wavPath),
            model: "whisper-1",
          });

          finalText = transcription.text;
        }

        // Extract intent
        const intent = extractIntent(finalText);

        let reply = "";

        switch (intent) {
          case "balance":
            reply = "Your current balance is UGX 234,000.";
            break;
          case "transfer":
            reply = "To transfer funds, please reply with: Send [amount] to [recipient name].";
            break;
          case "loan":
            reply = "To apply for a loan, reply with the amount and purpose (e.g., 'Loan 50000 for school fees').";
            break;
          default:
            const chatRes = await openai.chat.completions.create({
              model: "gpt-4",
              messages: [{ role: "user", content: finalText }],
            });
            reply = chatRes.choices[0].message.content;
            break;
        }

        // Send reply
        await axios.post(
          `https://graph.facebook.com/v19.0/${phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            text: { body: reply },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("Error:", error.message);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
