const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const intentToCommand = {
  check_balance: 'balance',
  pay_water: 'pay water',
  pay_electricity: 'pay electricity',
  pay_tv: 'pay tv',
  airtime: 'airtime',
  top_up: 'top up',
  transfer: 'transfer',
  loans: 'loans',
  help: 'help',
  greeting: 'help',
};

// Send WhatsApp message
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

// Create user if not exists
const ensureUserExists = async (phone) => {
  const { data, error } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (data) return data;

  const { data: newUser, error: insertErr } = await supabase
    .from('users')
    .insert([{ phone }])
    .select()
    .single();

  if (insertErr) throw insertErr;

  await supabase.from('wallets').insert([{ user_id: newUser.id, balance: 0 }]);
  return newUser;
};

// Get wallet balance
const getWalletBalance = async (user_id) => {
  const { data } = await supabase.from('wallets').select('balance').eq('user_id', user_id).single();
  return data?.balance ?? 0;
};

// Send OTP
const sendOtp = async (phone) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase
    .from('otps')
    .upsert({ phone, otp, verified: false, created_at: new Date() });

  await sendWhatsapp(phone, `🔐 Your Fanitepay OTP is: ${otp}`);
};

// Verify OTP
const verifyOtp = async (phone, code) => {
  const { data } = await supabase
    .from('otps')
    .select('*')
    .eq('phone', phone)
    .eq('otp', code)
    .eq('verified', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (data) {
    await supabase.from('otps').update({ verified: true }).eq('id', data.id);
    return true;
  }
  return false;
};

// Show help
const showHelp = (phone) =>
  sendWhatsapp(
    phone,
    `📌 *Fanitepay Commands:*\n\n` +
      `• balance - Check account balance\n` +
      `• pay water - Pay water bill\n` +
      `• pay electricity - Pay electricity bill\n` +
      `• pay tv - Pay TV bill\n` +
      `• airtime - Buy airtime\n` +
      `• top up - Top up your wallet\n` +
      `• transfer - Transfer money\n` +
      `• loans - Loan services\n` +
      `• help - Show this message`
  );

// Parse intent using OpenAI
const parseCommand = async (message) => {
  const normalized = message.trim().toLowerCase();

  // Manual greeting shortcut
  if (['hi', 'hello', 'hey'].includes(normalized)) return 'help';

  const candidateIntents = Object.keys(intentToCommand);
  const prompt = `
You are a WhatsApp fintech bot. Classify the following user message into one of these intents:
${candidateIntents.join(', ')}.
Message: "${normalized}"
Respond with only the intent name (e.g., "check_balance"). If uncertain, return "none".
`;

  try {
    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You classify messages into intent names for a fintech bot.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 10,
    });

    const intent = chatResponse.choices?.[0]?.message?.content?.trim().toLowerCase() || 'none';
    console.log('Parsed intent:', intent);

    if (intent === 'none' || !intentToCommand[intent]) {
      if (/^\d{6}$/.test(normalized)) return 'otp';
      return null;
    }

    return intentToCommand[intent];
  } catch (err) {
    console.error('OpenAI error:', err.message || err);
    if (/^\d{6}$/.test(normalized)) return 'otp';
    return null;
  }
};

const pendingActions = {};

// WhatsApp webhook verification
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

// WhatsApp message handler
app.post('/whatsapp', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value?.messages?.[0];
    if (!changes) return res.sendStatus(200);

    const message = changes.text?.body;
    const phone = changes.from;

    if (!message) {
      await sendWhatsapp(phone, `⚠️ Only text messages are supported.`);
      return res.sendStatus(200);
    }

    const user = await ensureUserExists(phone);
    const user_id = user.id;

    const command = await parseCommand(message);

    if (command === 'help') {
      await showHelp(phone);
    } else if (command === 'balance') {
      const balance = await getWalletBalance(user_id);
      await sendWhatsapp(phone, `💰 Your balance is UGX ${balance.toLocaleString()}`);
    } else if (command === 'loans') {
      await sendWhatsapp(phone, `💸 Our loans service is coming soon. Stay tuned!`);
    } else if (
      ['pay water', 'pay electricity', 'pay tv', 'airtime', 'top up', 'transfer'].includes(command)
    ) {
      pendingActions[phone] = command;
      await sendOtp(phone);
      await sendWhatsapp(phone, `To continue with *${command}*, please enter the OTP sent to your phone.`);
    } else if (command === 'otp') {
      const valid = await verifyOtp(phone, message);
      if (valid) {
        const action = pendingActions[phone];
        delete pendingActions[phone];

        await supabase.from('transactions').insert([
          {
            user_id,
            type: action,
            status: 'completed',
            amount: 1000, // Placeholder amount
            metadata: { description: `Sample ${action} transaction` },
          },
        ]);

        await sendWhatsapp(phone, `✅ OTP verified. *${action.toUpperCase()}* completed successfully.`);
      } else {
        await sendWhatsapp(phone, `❌ Invalid or expired OTP. Please try again.`);
      }
    } else {
      await sendWhatsapp(phone, `❓ I didn't understand that. Type *help* to see available commands.`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Fanitepay bot is running on port ${PORT}`));
