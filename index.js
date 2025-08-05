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
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID; // Add to .env
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN; // Add to .env
const CLOUDFLARE_API_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/mixtral-8x7b-instruct`;

// Function to send WhatsApp message
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

// Ensure user exists in Supabase
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
  const { data, error } = await supabase.from('wallets').select('balance').eq('user_id', user_id).single();
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
  const { data, error } = await supabase
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

// Show help message
const showHelp = (phone) =>
  sendWhatsapp(
    phone,
    `Here are the commands you can use with Fanitepay:\n\n` +
      `• balance - Check your account balance\n` +
      `• pay water - Pay water bill\n` +
      `• pay electricity - Pay electricity bill\n` +
      `• pay tv - Pay TV bill\n` +
      `• airtime - Buy airtime\n` +
      `• top up - Top up your wallet\n` +
      `• transfer - Transfer money\n` +
      `• loans - Check or apply for loans\n` +
      `• help - Show this help message`
  );

// Intent-to-command mapping
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
  greeting: 'help', // Map greetings to help
};

// Parse user input using Cloudflare Workers AI (Mixtral model)
const parseCommand = async (message) => {
  const candidateIntents = Object.keys(intentToCommand); // e.g., ['check_balance', 'pay_water', ...]
  const prompt = `
    You are a WhatsApp fintech bot. Classify the following user message into one of these intents: ${candidateIntents.join(', ')}.
    Message: "${message}"
    Return only the intent name (e.g., check_balance, pay_water, etc.). If the intent is unclear, return "none".
  `;

  try {
    const response = await axios.post(
      CLOUDFLARE_API_URL,
      {
        prompt: prompt,
        max_tokens: 50,
        temperature: 0.3, // Low temperature for deterministic output
      },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const intent = response.data.result?.response?.trim() || 'none';
    if (intent === 'none' || !intentToCommand[intent]) {
      // Check for OTP (6-digit number)
      if (/^\d{6}$/.test(message.trim())) {
        return 'otp';
      }
      return null; // No valid intent detected
    }

    return intentToCommand[intent];
  } catch (err) {
    console.error('Cloudflare AI error:', err.response?.data || err.message);
    // Fallback to OTP check
    if (/^\d{6}$/.test(message.trim())) {
      return 'otp';
    }
    return null;
  }
};

const pendingActions = {}; // In-memory store for pending actions

// Webhook verification endpoint
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

// Webhook message handling endpoint
app.post('/whatsapp', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value?.messages?.[0];
    if (!changes) return res.sendStatus(200);

    const message = changes.text?.body;
    const phone = changes.from;

    const user = await ensureUserExists(phone);
    const user_id = user.id;

    const command = await parseCommand(message);

    if (command === 'help') {
      await showHelp(phone);
    } else if (command === 'balance') {
      const balance = await getWalletBalance(user_id);
      await sendWhatsapp(phone, `💰 Your balance is UGX ${balance.toLocaleString()}`);
    } else if (command === 'loans') {
      await sendWhatsapp(
        phone,
        `💸 Loans feature is under development. You can check loan eligibility or apply for a loan soon!`
      );
    } else if (
      ['pay water', 'pay electricity', 'pay tv', 'airtime', 'top up', 'transfer'].includes(command)
    ) {
      pendingActions[phone] = command;
      await sendOtp(phone);
      await sendWhatsapp(phone, `To continue with ${command}, please enter the OTP sent to your phone.`);
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

        await sendWhatsapp(phone, `✅ OTP verified. ${action.toUpperCase()} completed successfully.`);
      } else {
        await sendWhatsapp(phone, `❌ Invalid or expired OTP. Please try again.`);
      }
    } else {
      await sendWhatsapp(
        phone,
        `❓ I didn't understand that.\nType "help" to see available commands.`
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));
