const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;
const axios = require("axios");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const Groq = require("groq-sdk");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Dummy users
const users = {
  "+256771880410": { pin: "1234", balance: 234000, loan: 0 },
  "+256706025524": { pin: "4321", balance: 50000, loan: 10000 },
  "+256700000003": { pin: "1111", balance: 120000, loan: 20000 }
};

// Initialize Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper: Menu Text
const menuText = `
🧾 Welcome to ChatBook Services:
You can use the following instructions:

• balance <your_pin> — Check your account balance
• loan <amount> <reason> <your_pin> — Request a loan
• send <amount> to <name> <your_pin> — Transfer funds
• menu — Show this help menu again
`;

// Helper: Intent extraction
function extractIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("balance")) return "balance";
  if (lowered.includes("send") || lowered.includes("transfer")) return "transfer";
  if (lowered.includes("loan")) return "loan";
  if (lowered === "menu" || lowered === "help") return "menu";
  return "chat";
}

app.post("/whatsapp", async (req, res) => {
  const from = req.body.From.replace("whatsapp:", "");
  const incomingMsg = req.body.Body.trim();
  const mediaUrl = req.body.MediaUrl0;
  const twiml = new MessagingResponse();
  const msg = twiml.message();
  let finalText = incomingMsg;

  try {
    // Handle voice message if exists
    if (mediaUrl) {
      const oggPath = path.join(__dirname, "voice.ogg");
      const wavPath = path.join(__dirname, "voice.wav");
      const audioResponse = await axios.get(mediaUrl, { responseType: "arraybuffer" });
      fs.writeFileSync(oggPath, audioResponse.data);

      await new Promise((resolve, reject) => {
        ffmpeg(oggPath)
          .toFormat("wav")
          .on("error", (err) => {
            console.error("FFmpeg error:", err.message);
            reject(err);
          })
          .on("end", () => {
            console.log("Audio converted to WAV successfully");
            resolve();
          })
          .save(wavPath);
      });

      // Use Groq/Whisper (or placeholder)
      finalText = "[Voice recognition unavailable in Groq]"; // Update with transcription if using Whisper
    }

    const user = users[from];
    if (!user) {
      msg.body("❌ You are not registered. Please contact support.");
    } else {
      const intent = extractIntent(finalText.toLowerCase());

      switch (intent) {
        case "balance":
          if (finalText.includes(user.pin)) {
            msg.body(`💰 Your current balance is UGX ${user.balance.toLocaleString()}.`);
          } else {
            msg.body("🔐 Please include your PIN to check balance. Example: balance 1234");
          }
          break;
        case "transfer":
          if (!finalText.includes(user.pin)) {
            msg.body("🔐 Please include your PIN to transfer funds. Example: send 5000 to John 1234");
          } else {
            msg.body("✅ Transfer request received. (Simulated response)");
          }
          break;
        case "loan":
          if (!finalText.includes(user.pin)) {
            msg.body("🔐 Please include your PIN to request a loan. Example: loan 100000 for business 1234");
          } else {
            msg.body("✅ Loan request received. (Simulated response)");
          }
          break;
        case "menu":
          msg.body(menuText);
          break;
        default:
          // If nothing matches, fallback to menu
          msg.body("❓ I didn’t understand that.\n" + menuText);
          break;
      }
    }

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Error:", error.message);
    msg.body("❌ An error occurred. Please try again later.");
    res.type("text/xml").send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
