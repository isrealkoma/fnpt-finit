const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const { Configuration, OpenAIApi } = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// OpenAI setup
const configuration = new Configuration({
 apiKey: process.env.OPENAI_API_KEY, // Add your OpenAI API key
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

// WhatsApp webhook route
app.post("/whatsapp", async (req, res) => {
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

      // Convert OGG to WAV using ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(oggPath)
          .toFormat("wav")
          .on("error", reject)
          .on("end", resolve)
          .save(wavPath);
      });

      // Send to OpenAI Whisper
      const formData = new FormData();
      formData.append("file", fs.createReadStream(wavPath));
      formData.append("model", "whisper-1");

      const whisperResponse = await openai.createTranscription(formData.getBuffer(), "whisper-1", undefined, {
        headers: formData.getHeaders(),
      });

      finalText = whisperResponse.data.text;
    }

    const intent = extractIntent(finalText);

    switch (intent) {
      case "balance":
        msg.body("Your current balance is UGX 234,000.");
        break;
      case "transfer":
        msg.body("To transfer funds, please reply with: Send [amount] to [recipient name].");
        break;
      case "loan":
        msg.body("To apply for a loan, reply with the amount and purpose (e.g., 'Loan 50000 for school fees').");
        break;
      default:
        const chatResponse = await openai.createChatCompletion({
          model: "gpt-4",
          messages: [{ role: "user", content: finalText }],
        });
        msg.body(chatResponse.data.choices[0].message.content);
        break;
    }

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Error:", error.message);
    msg.body("Sorry, an error occurred processing your message.");
    res.type("text/xml").send(twiml.toString());
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
