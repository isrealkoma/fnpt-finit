const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;
const axios = require("axios");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
//require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Dummy users
const users = {
  "+256771880410": { pin: "1234", balance: 234000, loan: 0 },
  "+256706025524": { pin: "4321", balance: 50000, loan: 10000 },
  "+256700000003": { pin: "1111", balance: 120000, loan: 20000 }
};

// Helper: extract intent
function extractIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("balance")) return "balance";
  if (lowered.includes("send") || lowered.includes("transfer")) return "transfer";
  if (lowered.includes("loan")) return "loan";
  return "chat";
}

// WhatsApp webhook handler
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From.replace("whatsapp:", "");
  const incomingMsg = req.body.Body;
  const mediaUrl = req.body.MediaUrl0;
  const twiml = new MessagingResponse();
  const msg = twiml.message();
  let finalText = incomingMsg;

  try {
    if (mediaUrl) {
      const oggPath = path.join(__dirname, "voice.ogg");
      const wavPath = path.join(__dirname, "voice.wav");
      const audioResponse = await axios.get(mediaUrl, { responseType: "arraybuffer" });
      fs.writeFileSync(oggPath, audioResponse.data);

      console.log("Audio saved as voice.ogg");

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

      msg.body("Sorry, audio transcription is not supported with Groq yet.");
      return res.type("text/xml").send(twiml.toString());
    }

    const user = users[from];
    if (!user) {
      msg.body("You are not registered in the system.");
    } else {
      const intent = extractIntent(finalText);

      switch (intent) {
        case "balance":
          if (finalText.includes(user.pin)) {
            msg.body(`Your current balance is UGX ${user.balance.toLocaleString()}.`);
          } else {
            msg.body("Please provide your PIN to check balance.");
          }
          break;
        case "transfer":
          if (!finalText.includes(user.pin)) {
            msg.body("To transfer funds, include your PIN in the message (e.g., Send 5000 to John 1234).");
          } else {
            msg.body("Transfer request received. (Dummy logic: transfer not actually performed.)");
          }
          break;
        case "loan":
          if (!finalText.includes(user.pin)) {
            msg.body("To request a loan, include your PIN (e.g., Loan 100000 for business 1234).");
          } else {
            msg.body("Loan request received. (Dummy logic: loan not actually processed.)");
          }
          break;
        default:
          const groqResponse = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "mixtral-8x7b-32768", // or "llama3-70b-8192"
            messages: [{ role: "user", content: finalText }],
          }, {
            headers: {
              "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json"
            }
          });

          msg.body(groqResponse.data.choices[0].message.content);
          break;
      }
    }

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Error:", error.message);
    msg.body("Sorry, something went wrong.");
    res.type("text/xml").send(twiml.toString());
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
