const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// NLP Cloud Configuration
const NLP_CLOUD_API_KEY = process.env.NLP_CLOUD_API_KEY;
const NLP_CLOUD_MODEL = process.env.NLP_CLOUD_MODEL || 'distilbert-base-uncased-finetuned-sst-2-english';
const NLP_CLOUD_BASE_URL = 'https://api.nlpcloud.io/v1';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Intent classification training data for zero-shot classification
const intentLabels = [
  'check balance',
  'pay water bill',
  'pay electricity bill', 
  'pay tv bill',
  'buy airtime',
  'top up wallet',
  'transfer money',
  'loan services',
  'help request',
  'greeting',
  'none'
];

const intentToCommand = {
  'check balance': 'balance',
  'pay water bill': 'pay water',
  'pay electricity bill': 'pay electricity',
  'pay tv bill': 'pay tv',
  'buy airtime': 'airtime',
  'top up wallet': 'top up',
  'transfer money': 'transfer',
  'loan services': 'loans',
  'help request': 'help',
  'greeting': 'help',
  'none': null
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

// Parse intent using NLP Cloud
const parseCommand = async (message) => {
  const normalized = message.trim();

  // Check if it's an OTP first
  if (/^\d{6}$/.test(normalized)) return 'otp';

  try {
    // Handle common greetings quickly
    const lowerMessage = normalized.toLowerCase();
    if (['hi', 'hello', 'hey', 'start'].includes(lowerMessage)) {
      return 'help';
    }

    // Use NLP Cloud's zero-shot classification
    const response = await axios.post(
      `${NLP_CLOUD_BASE_URL}/bart-large-mnli/classification`,
      {
        text: normalized,
        labels: intentLabels,
        multi_class: false
      },
      {
        headers: {
          'Authorization': `Token ${NLP_CLOUD_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const classification = response.data;
    const topLabel = classification.labels[0];
    const confidence = classification.scores[0];

    console.log('NLP Cloud response:', {
      text: normalized,
      topLabel: topLabel,
      confidence: confidence,
      allScores: classification.scores.slice(0, 3) // Top 3 scores
    });

    // Only proceed if confidence is above threshold
    if (confidence < 0.6) {
      console.log(`Low confidence (${confidence}), treating as unknown`);
      return null;
    }

    // Map classified intent to command
    if (topLabel && intentToCommand.hasOwnProperty(topLabel)) {
      return intentToCommand[topLabel];
    }

    return null;
  } catch (err) {
    console.error('NLP Cloud error:', err.response?.data || err.message);
    
    // Fallback to simple keyword matching if NLP Cloud fails
    const lowerMessage = normalized.toLowerCase();
    if (lowerMessage.includes('balance')) return 'balance';
    if (lowerMessage.includes('water')) return 'pay water';
    if (lowerMessage.includes('electricity') || lowerMessage.includes('power') || lowerMessage.includes('light')) return 'pay electricity';
    if (lowerMessage.includes('tv') || lowerMessage.includes('television') || lowerMessage.includes('dstv')) return 'pay tv';
    if (lowerMessage.includes('airtime')) return 'airtime';
    if (lowerMessage.includes('top up') || lowerMessage.includes('topup') || lowerMessage.includes('deposit')) return 'top up';
    if (lowerMessage.includes('transfer') || lowerMessage.includes('send money') || lowerMessage.includes('send')) return 'transfer';
    if (lowerMessage.includes('loan') || lowerMessage.includes('borrow')) return 'loans';
    if (lowerMessage.includes('help') || lowerMessage.includes('command')) return 'help';
    
    return null;
  }
};

// Alternative method using NLP Cloud's text generation for more complex intent parsing
const parseCommandWithGeneration = async (message) => {
  const normalized = message.trim();

  // Check if it's an OTP first
  if (/^\d{6}$/.test(normalized)) return 'otp';

  try {
    const prompt = `Classify this message into one of these fintech intents:
- balance: check account balance
- pay water: pay water bill
- pay electricity: pay electricity bill  
- pay tv: pay tv bill
- airtime: buy airtime
- top up: top up wallet
- transfer: transfer money
- loans: loan services
- help: get help
- none: if unclear

Message: "${normalized}"
Intent:`;

    const response = await axios.post(
      `${NLP_CLOUD_BASE_URL}/flan-alpaca-base/generation`,
      {
        text: prompt,
        max_length: 10,
        temperature: 0.1,
        top_p: 0.9
      },
      {
        headers: {
          'Authorization': `Token ${NLP_CLOUD_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const generatedText = response.data.generated_text.trim().toLowerCase();
    console.log('Generated intent:', generatedText);

    // Map generated intent to command
    const intentMap = {
      'balance': 'balance',
      'pay water': 'pay water',
      'pay electricity': 'pay electricity',
      'pay tv': 'pay tv',
      'airtime': 'airtime',
      'top up': 'top up',
      'transfer': 'transfer',
      'loans': 'loans',
      'help': 'help',
      'none': null
    };

    return intentMap[generatedText] || null;
  } catch (err) {
    console.error('NLP Cloud generation error:', err.response?.data || err.message);
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

// Health check endpoint for testing NLP Cloud connection
app.get('/test-nlp', async (req, res) => {
  try {
    const testMessage = req.query.message || 'check my balance';
    const command = await parseCommand(testMessage);
    res.json({
      message: testMessage,
      detectedCommand: command,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint for text generation approach
app.get('/test-nlp-gen', async (req, res) => {
  try {
    const testMessage = req.query.message || 'check my balance';
    const command = await parseCommandWithGeneration(testMessage);
    res.json({
      message: testMessage,
      detectedCommand: command,
      method: 'text-generation',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Fanitepay bot is running on port ${PORT}`));
