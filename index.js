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

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const users = {
  "+256771880410": { pin: "1234", balance: 234000, loan: 0, verified: false },
  "+256706025524": { pin: "4321", balance: 50000, loan: 10000, verified: false },
  "+256700000003": { pin: "1111", balance: 120000, loan: 20000, verified: false }
};

function extractIntent(message) {
  const lowered = message.toLowerCase();
  if (lowered.includes("balance")) return "balance";
  if (lowered.includes("send") || lowered.includes("transfer")) return "transfer";
  if (lowered.includes("loan")) return "loan";
  return "chat";
}

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

      await new Promise((resolve, reject) => {
        ffmpeg(oggPath)
          .toFormat("wav")
          .on("error", reject)
          .on("end", resolve)
          .save(wavPath);
      });

      const whisperResponse = await axios.post("https://api.groq.com/v1/audio/transcriptions", {
        file: fs.createReadStream(wavPath),
        model: "whisper-1",
      }, {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "multipart/form-data"
        }
      });

      finalText = whisperResponse.data.text;
    }

    const user = users[from];
    if (!user) {
      msg.body("You are not registered in the system.");
    } else {
      const intent = extractIntent(finalText);

      // Welcome Menu
      const menu = `
Welcome to FanitePay:
1. Check balance — type: balance
2. Send money — type: send 5000 to John
3. Request loan — type: loan 100000 for business
Please respond with one of the options above.`;

      // PIN must be verified externally
      if (!user.verified && ["balance", "transfer", "loan"].includes(intent)) {
        msg.body(`For security, please verify your PIN here first: https://fntpwifi.netlify.app/?phone=${encodeURIComponent(from)}`);
        return res.type("text/xml").send(twiml.toString());
      }

      switch (intent) {
        case "balance":
          msg.body(`Your current balance is UGX ${user.balance.toLocaleString()}.`);
          break;
        case "transfer":
          msg.body("Transfer request received. (This is a demo, no real transfer will occur.)");
          break;
        case "loan":
          msg.body("Loan request received. (This is a demo, no real loan will be issued.)");
          break;
        default:
          const chatResponse = await client.chat.completions.create({
            model: "llama3-8b-8192",
            messages: [{ role: "user", content: finalText }]
          });
          msg.body(chatResponse.choices[0].message.content + "\n\n" + menu);
          break;
      }
    }

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Error:", error.message);
    msg.body("Sorry, an error occurred processing your message.");
    res.type("text/xml").send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
