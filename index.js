require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Configuration, OpenAIApi } = require('openai');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;

  const twiml = new MessagingResponse();

  try {
    const systemInstruction = `You are a fintech assistant bot. Reply to users asking about balances, transfers, loan info, or general finance tips.`;

    const chatCompletion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: incomingMsg },
      ],
    });

    const responseText = chatCompletion.data.choices[0].message.content;

    twiml.message(responseText);
  } catch (err) {
    console.error(err);
    twiml.message("Sorry, something went wrong.");
  }

  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot is live at http://localhost:${PORT}`);
});
