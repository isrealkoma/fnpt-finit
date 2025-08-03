const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sendWhatsapp = async (phone, text) => {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Sending error:', err.response?.data || err.message);
  }
};


const sendOtp = async (phone) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase
    .from('otps')
    .upsert({ phone, otp, verified: false, created_at: new Date() });

  await sendWhatsapp(phone, `Your Fanitepay OTP is: ${otp}`);
};

const verifyOtp = async (phone, code) => {
  const { data, error } = await supabase
    .from('otps')
    .select('*')
    .eq('phone', phone)
    .eq('otp', code)
    .eq('verified', false)
    .single();

  if (data) {
    await supabase.from('otps').update({ verified: true }).eq('id', data.id);
    return true;
  }

  return false;
};

const showHelp = (phone) =>
  sendWhatsapp(
    phone,
    `Here are the commands you can use with Fanitepay:\n\n` +
      `• balance\n• pay water\n• pay tv\n• pay electricity\n• airtime\n` +
      `• top up\n• transfer\n• help`
  );

app.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/whatsapp', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value?.messages?.[0];
    if (!changes) return res.sendStatus(200);

    const message = changes.text?.body?.trim().toLowerCase();
    const phone = changes.from;

    if (message === 'hi' || message === 'hello' || message === 'start') {
      await sendWhatsapp(
        phone,
        `Welcome to Fanitepay 🚀\n\nYou can:\n• Pay bills\n• Buy airtime\n• Transfer money\n• Check balance\n\nType "help" to see all options.`
      );
    } else if (message === 'help') {
      await showHelp(phone);
    } else if (message === 'balance') {
      await sendWhatsapp(phone, `Your balance is UGX 120,000`);
    } else if (
      ['pay water', 'pay electricity', 'pay tv', 'airtime', 'top up', 'transfer'].includes(message)
    ) {
      await sendOtp(phone);
      await sendWhatsapp(phone, `To continue, please enter the OTP sent to your phone.`);
    } else if (/^\d{6}$/.test(message)) {
      const valid = await verifyOtp(phone, message);
      if (valid) {
        await sendWhatsapp(phone, `✅ OTP verified. Proceeding with your request.`);
      } else {
        await sendWhatsapp(phone, `❌ Invalid or expired OTP. Please try again.`);
      }
    } else {
      await sendWhatsapp(
        phone,
        `🤖 Sorry, I didn't understand that.\nType "help" to see available commands.`
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));
