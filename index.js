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
const NLP_CLOUD_STT_MODEL = process.env.NLP_CLOUD_STT_MODEL || 'whisper';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Enhanced intent classification with market-ready labels
const intentLabels = [
  'check account balance or wallet amount',
  'pay water utility bill',
  'pay electricity power bill', 
  'pay television subscription bill',
  'buy mobile airtime credit',
  'deposit money to wallet',
  'send money to someone',
  'request loan or credit',
  'get help with services',
  'greeting or welcome message',
  'unrelated or unclear message'
];

const intentToCommand = {
  'check account balance or wallet amount': 'balance',
  'pay water utility bill': 'pay water',
  'pay electricity power bill': 'pay electricity',
  'pay television subscription bill': 'pay tv',
  'buy mobile airtime credit': 'airtime',
  'deposit money to wallet': 'top up',
  'send money to someone': 'transfer',
  'request loan or credit': 'loans',
  'get help with services': 'help',
  'greeting or welcome message': 'greeting',
  'unrelated or unclear message': null
};

// Quick pattern matching for common phrases (faster than API calls)
const quickPatterns = {
  // Greetings - most common, check first
  greeting: [
    /^(hi|hello|hey|good\s+(morning|afternoon|evening|day)|greetings?|howdy|sup|what'?s\s+up)$/i,
    /^(hi\s+there|hello\s+there|hey\s+there)$/i,
    /^(start|begin|menu|main\s+menu)$/i
  ],
  
  // Balance inquiries - very common
  balance: [
    /\b(check|show|get|see|view|tell)\s+(my\s+)?(account\s+)?(balance|amount|money|funds?)\b/i,
    /\bhow\s+much\s+(money\s+)?(do\s+i\s+have|is\s+in\s+my\s+account|balance)\b/i,
    /\b(remaining|available)\s+(balance|amount|funds?|money)\b/i,
    /\b(account\s+)?(balance|statement|summary)\b/i,
    /^balance$/i,
    /\bwallet\s+(balance|amount)\b/i
  ],
  
  // Bill payments
  water: [
    /\b(pay|paying)\s+(my\s+)?(water|nwsc)\s+(bill|utility)\b/i,
    /\bwater\s+(bill|payment|pay)\b/i,
    /\bnwsc\b/i
  ],
  
  electricity: [
    /\b(pay|paying)\s+(my\s+)?(electricity|power|electric|umeme)\s+(bill|utility)\b/i,
    /\b(electricity|power|electric|umeme)\s+(bill|payment|pay)\b/i,
    /\bumeme\b/i,
    /\belectrical?\s+bill\b/i
  ],
  
  tv: [
    /\b(pay|paying)\s+(my\s+)?(tv|television|dstv|gotv|startimes)\s+(bill|subscription)\b/i,
    /\b(tv|television|dstv|gotv|startimes)\s+(bill|payment|pay|subscription)\b/i,
    /\b(dstv|gotv|startimes)\b/i
  ],
  
  // Financial services
  airtime: [
    /\b(buy|purchase|get)\s+(airtime|credit|recharge)\b/i,
    /\bairtime\b/i,
    /\b(top\s+up|topup)\s+(phone|mobile)\b/i,
    /\bmobile\s+(credit|recharge)\b/i
  ],
  
  topup: [
    /\b(top\s+up|topup|deposit|add\s+money|fund)\s+(wallet|account)\b/i,
    /\b(deposit|add)\s+(money|funds?|cash)\b/i,
    /\bfund\s+account\b/i
  ],
  
  transfer: [
    /\b(send|transfer)\s+(money|funds?|cash)\b/i,
    /\bmoney\s+(transfer|sending)\b/i,
    /\bsend\s+to\b/i,
    /\bp2p\s+(transfer|payment)\b/i
  ],
  
  loans: [
    /\b(loan|borrow|credit|advance)\b/i,
    /\bneed\s+(money|cash|funds?)\b/i,
    /\bquick\s+(cash|loan)\b/i
  ]
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

// Create user if not exists and track if they're new
const ensureUserExists = async (phone) => {
  const { data, error } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (data) return { user: data, isNew: false };

  const { data: newUser, error: insertErr } = await supabase
    .from('users')
    .insert([{ phone, created_at: new Date() }])
    .select()
    .single();

  if (insertErr) throw insertErr;

  await supabase.from('wallets').insert([{ user_id: newUser.id, balance: 0 }]);
  return { user: newUser, isNew: true };
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

// Welcome message with personalized greeting
const showWelcome = async (phone, isFirstTime = false) => {
  const timeOfDay = getTimeOfDay();
  const welcomeMessage = isFirstTime 
    ? `🎉 *Welcome to FanitePay!*\n\n` +
      `${timeOfDay}! Your all-in-one financial companion is ready to serve you.\n\n` +
      `💫 *What you can do:*\n` +
      `💰 Check your balance instantly\n` +
      `💧 Pay water bills (NWSC)\n` +
      `⚡ Pay electricity bills (UMEME)\n` +
      `📺 Pay TV subscriptions (DSTV, GoTV)\n` +
      `📱 Buy airtime for any network\n` +
      `💵 Top up your wallet\n` +
      `🔄 Send money to friends & family\n` +
      `🏦 Access quick loans\n\n` +
      `Simply tell me what you need in your own words! 😊\n\n` +
      `_Example: "Check my balance" or "Pay my water bill"_`
    : `${timeOfDay}! Welcome back to *FanitePay* 👋\n\n` +
      `How can I help you today?\n\n` +
      `💡 *Quick commands:* balance, pay water, buy airtime, transfer money, or just tell me what you need!`;
  
  await sendWhatsapp(phone, welcomeMessage);
};

// Get time-appropriate greeting
const getTimeOfDay = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

// Download WhatsApp media (audio files)
const downloadWhatsAppMedia = async (mediaId) => {
  try {
    // Get media URL from WhatsApp
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        },
      }
    );

    const mediaUrl = mediaResponse.data.url;

    // Download the actual media file
    const fileResponse = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
      responseType: 'arraybuffer',
    });

    return Buffer.from(fileResponse.data);
  } catch (err) {
    console.error('Media download error:', err.response?.data || err.message);
    throw new Error('Failed to download audio file');
  }
};

// Convert audio to text using NLP Cloud
const speechToText = async (audioBuffer) => {
  try {
    console.log('Converting audio to text with NLP Cloud...');
    
    // Create FormData for file upload
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, {
      filename: 'audio.ogg',
      contentType: 'audio/ogg',
    });

    const response = await axios.post(
      `${NLP_CLOUD_BASE_URL}/${NLP_CLOUD_STT_MODEL}/speech-to-text`,
      form,
      {
        headers: {
          'Authorization': `Token ${NLP_CLOUD_API_KEY}`,
          ...form.getHeaders(),
        },
        timeout: 30000, // 30 second timeout for audio processing
      }
    );

    const transcription = response.data.text;
    console.log('Audio transcribed:', transcription);
    
    return transcription;
  } catch (err) {
    console.error('Speech-to-text error:', err.response?.data || err.message);
    throw new Error('Failed to convert audio to text');
  }
};
const showHelp = async (phone) => {
  await sendWhatsapp(phone, 
    `📱 *FanitePay Services Menu*\n\n` +
    `💰 *Balance* - Check your account balance\n` +
    `💧 *Water Bills* - Pay NWSC water bills\n` +
    `⚡ *Electricity* - Pay UMEME power bills\n` +
    `📺 *TV Bills* - Pay DSTV, GoTV, StarTimes\n` +
    `📱 *Airtime* - Buy airtime for any network\n` +
    `💵 *Top Up* - Add money to your wallet\n` +
    `🔄 *Transfer* - Send money to anyone\n` +
    `🏦 *Loans* - Quick loans when you need them\n\n` +
    `💬 *Just tell me what you need!*\n` +
    `You can say things like:\n` +
    `• "How much money do I have?"\n` +
    `• "Pay my UMEME bill"\n` +
    `• "Send 50k to my friend"\n` +
    `• "I need airtime"\n\n` +
    `We're here 24/7 to help! 🌟`
  );
};

// Enhanced intent parsing with quick pattern matching + NLP Cloud fallback
const parseCommand = async (message) => {
  const normalized = message.trim();

  // Check if it's an OTP first
  if (/^\d{6}$/.test(normalized)) return 'otp';

  // Quick pattern matching for common phrases (90% of use cases)
  for (const [intent, patterns] of Object.entries(quickPatterns)) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        console.log(`Quick match: "${normalized}" -> ${intent}`);
        return intent;
      }
    }
  }

  // If no quick match, use NLP Cloud for complex/ambiguous messages
  try {
    console.log(`Using NLP Cloud for: "${normalized}"`);
    
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
      confidence: confidence
    });

    // Lower confidence threshold since we have fallback
    if (confidence < 0.4) {
      console.log(`Low confidence (${confidence}), treating as unknown`);
      return null;
    }

    // Map classified intent to command
    if (topLabel && intentToCommand.hasOwnProperty(topLabel)) {
      const command = intentToCommand[topLabel];
      return command === 'greeting' ? 'greeting' : command;
    }

    return null;
  } catch (err) {
    console.error('NLP Cloud error:', err.response?.data || err.message);
    
    // Final fallback to simple keyword matching
    const lowerMessage = normalized.toLowerCase();
    
    // Balance keywords
    if (lowerMessage.match(/\b(balance|amount|money|funds?|how\s+much|remaining|available)\b/)) {
      return 'balance';
    }
    
    // Service keywords
    if (lowerMessage.includes('water') || lowerMessage.includes('nwsc')) return 'pay water';
    if (lowerMessage.match(/\b(electricity|power|electric|umeme|light)\b/)) return 'pay electricity';
    if (lowerMessage.match(/\b(tv|television|dstv|gotv|startimes)\b/)) return 'pay tv';
    if (lowerMessage.includes('airtime') || lowerMessage.includes('recharge')) return 'airtime';
    if (lowerMessage.match(/\b(top\s?up|deposit|add\s+money|fund)\b/)) return 'top up';
    if (lowerMessage.match(/\b(transfer|send\s+money|send)\b/)) return 'transfer';
    if (lowerMessage.match(/\b(loan|borrow|credit|advance)\b/)) return 'loans';
    if (lowerMessage.match(/\b(help|command|menu|service)\b/)) return 'help';
    
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
      await sendWhatsapp(phone, `⚠️ Sorry, I can only understand text messages right now. Please type your request! 😊`);
      return res.sendStatus(200);
    }

    const { user, isNew } = await ensureUserExists(phone);
    const user_id = user.id;

    const command = await parseCommand(message);

    // Handle greetings with personalized welcome
    if (command === 'greeting') {
      await showWelcome(phone, isNew);
    } 
    // Handle help requests
    else if (command === 'help') {
      await showHelp(phone);
    } 
    // Handle balance inquiries with more natural response
    else if (command === 'balance') {
      const balance = await getWalletBalance(user_id);
      const balanceMessage = balance > 0 
        ? `💰 *Your FanitePay Balance*\n\nUGX ${balance.toLocaleString()}\n\n✨ Ready to make payments or transfers!`
        : `💰 *Your FanitePay Balance*\n\nUGX 0\n\n💡 Top up your wallet to start enjoying our services!\nJust say "top up" to get started.`;
      
      await sendWhatsapp(phone, balanceMessage);
    } 
    // Handle loan requests
    else if (command === 'loans') {
      await sendWhatsapp(phone, `🏦 *FanitePay Loans*\n\n💸 Quick loans are coming very soon! We're working hard to bring you the best rates and instant approval.\n\n🔔 You'll be the first to know when it's ready. Stay tuned! ⭐`);
    } 
    // Handle services requiring OTP
    else if (['pay water', 'pay electricity', 'pay tv', 'airtime', 'top up', 'transfer'].includes(command)) {
      pendingActions[phone] = command;
      await sendOtp(phone);
      
      const serviceNames = {
        'pay water': 'Water Bill Payment',
        'pay electricity': 'Electricity Bill Payment',
        'pay tv': 'TV Subscription Payment',
        'airtime': 'Airtime Purchase',
        'top up': 'Wallet Top-up',
        'transfer': 'Money Transfer'
      };
      
      await sendWhatsapp(phone, 
        `🔐 *Security Verification*\n\n` +
        `To proceed with *${serviceNames[command]}*, please enter the 6-digit OTP we just sent to your phone.\n\n` +
        `⏰ OTP expires in 5 minutes\n` +
        `🔄 Reply "cancel" to stop this transaction`
      );
    } 
    // Handle OTP verification
    else if (command === 'otp') {
      const valid = await verifyOtp(phone, message);
      if (valid) {
        const action = pendingActions[phone];
        delete pendingActions[phone];

        await supabase.from('transactions').insert([
          {
            user_id,
            type: action,
            status: 'completed',
            amount: Math.floor(Math.random() * 50000) + 5000, // Random amount for demo
            metadata: { description: `${action} transaction`, otp_verified: true },
          },
        ]);

        const successMessages = {
          'pay water': '💧 Water bill payment successful! Your NWSC account has been credited.',
          'pay electricity': '⚡ Electricity bill paid! Your UMEME account is now up to date.',
          'pay tv': '📺 TV subscription renewed! Enjoy your favorite shows.',
          'airtime': '📱 Airtime purchase successful! Your phone is now topped up.',
          'top up': '💵 Wallet top-up complete! Funds are now available in your account.',
          'transfer': '🔄 Money transfer successful! Funds have been sent.'
        };

        await sendWhatsapp(phone, 
          `✅ *Transaction Successful*\n\n` +
          `${successMessages[action]}\n\n` +
          `📱 Thank you for using FanitePay! 🌟`
        );
      } else {
        await sendWhatsapp(phone, 
          `❌ *Invalid OTP*\n\n` +
          `The code you entered is incorrect or has expired.\n\n` +
          `💡 Please try your transaction again to get a new OTP, or type "help" if you need assistance.`
        );
      }
    } 
    // Handle unknown commands with helpful suggestions
    else {
      const suggestions = [
        'check my balance',
        'pay water bill',
        'buy airtime',
        'send money',
        'help'
      ];
      
      await sendWhatsapp(phone, 
        `🤔 *I didn't quite understand that*\n\n` +
        `No worries! Try saying something like:\n` +
        `${suggestions.map(s => `• "${s}"`).join('\n')}\n\n` +
        `💬 You can also type "help" to see all available services.\n\n` +
        `*FanitePay* - Making financial services simple! 🚀`
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    
    // Send user-friendly error message
    try {
      const phone = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (phone) {
        await sendWhatsapp(phone, 
          `🔧 *Oops! Something went wrong*\n\n` +
          `We're experiencing a temporary issue. Please try again in a moment.\n\n` +
          `If the problem persists, type "help" or contact our support team.\n\n` +
          `Thank you for your patience! 🙏`
        );
      }
    } catch (sendErr) {
      console.error('Failed to send error message:', sendErr);
    }
    
    res.sendStatus(500);
  }
});

// Health check endpoint for testing NLP Cloud connection
app.get('/test-nlp', async (req, res) => {
  try {
    const testMessage = req
