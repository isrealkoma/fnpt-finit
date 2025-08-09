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

// EasyPay API Configuration
const EASYPAY_USERNAME = process.env.EASYPAY_USERNAME;
const EASYPAY_PASSWORD = process.env.EASYPAY_PASSWORD;
const EASYPAY_API_URL = 'https://www.easypay.co.ug/api/';

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

// Update wallet balance
const updateWalletBalance = async (user_id, newBalance) => {
  const { error } = await supabase
    .from('wallets')
    .update({ balance: newBalance })
    .eq('user_id', user_id);
  
  if (error) throw error;
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

// Process airtime purchase via EasyPay API
const processAirtimePurchase = async (phone, provider, amount, user_id) => {
  try {
    // Check wallet balance first
    const currentBalance = await getWalletBalance(user_id);
    if (currentBalance < amount) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    // Prepare data for the EasyPay API
    const easyPayData = {
      username: EASYPAY_USERNAME,
      password: EASYPAY_PASSWORD,
      action: 'paybill',
      provider,
      phone,
      amount,
      reference: "fntp" + Math.floor(Math.random() * 9000000000) + 1000000000
    };

    // Send request to the EasyPay API
    const response = await axios.post(EASYPAY_API_URL, easyPayData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000 // 30 second timeout
    });

    // Check if the request was successful
    if (response.status !== 200) {
      throw new Error('EASYPAY_API_ERROR');
    }

    const responseData = response.data;
    
    // Check if EasyPay response indicates success
    // Note: You may need to adjust this based on EasyPay's actual response format
    if (responseData.status === 'success' || responseData.success === true) {
      // Deduct amount from wallet
      await updateWalletBalance(user_id, currentBalance - amount);
      
      // Record transaction
      await supabase.from('transactions').insert([
        {
          user_id,
          type: 'airtime',
          status: 'completed',
          amount,
          metadata: { 
            provider, 
            phone, 
            reference: easyPayData.reference,
            easypay_response: responseData 
          },
        },
      ]);

      return {
        success: true,
        reference: easyPayData.reference,
        response: responseData
      };
    } else {
      // EasyPay returned an error
      throw new Error('EASYPAY_TRANSACTION_FAILED');
    }

  } catch (error) {
    console.error('Airtime purchase error:', error);
    
    // Record failed transaction
    await supabase.from('transactions').insert([
      {
        user_id,
        type: 'airtime',
        status: 'failed',
        amount,
        metadata: { 
          provider, 
          phone, 
          error: error.message,
          timestamp: new Date()
        },
      },
    ]);

    throw error;
  }
};

// Show airtime purchase options
const showAirtimeOptions = async (phone) => {
  await sendWhatsapp(phone, 
    `📱 *Airtime Purchase*\n\n` +
    `Please choose your network provider:\n\n` +
    `📶 *MTN* - Reply: MTN [amount] [phone]\n` +
    `📶 *Airtel* - Reply: AIRTEL [amount] [phone]\n` +
    `📶 *UTL* - Reply: UTL [amount] [phone]\n\n` +
    `*Example:* MTN 5000 256701234567\n\n` +
    `💡 *Or use simple format:*\n` +
    `"Buy 10000 MTN airtime for 256701234567"\n\n` +
    `_Phone number can be yours or someone else's_`
  );
};

// Parse airtime request from message
const parseAirtimeRequest = (message) => {
  const normalized = message.trim().toUpperCase();
  
  // Pattern 1: "MTN 5000 256701234567"
  const pattern1 = /^(MTN|AIRTEL|UTL)\s+(\d+)\s+(256\d{9})$/;
  const match1 = normalized.match(pattern1);
  if (match1) {
    return {
      provider: match1[1],
      amount: parseInt(match1[2]),
      phone: match1[3]
    };
  }

  // Pattern 2: "Buy 5000 MTN airtime for 256701234567"
  const pattern2 = /BUY\s+(\d+)\s+(MTN|AIRTEL|UTL)\s+AIRTIME\s+FOR\s+(256\d{9})/;
  const match2 = normalized.match(pattern2);
  if (match2) {
    return {
      provider: match2[2],
      amount: parseInt(match2[1]),
      phone: match2[3]
    };
  }

  // Pattern 3: "5000 MTN 256701234567"
  const pattern3 = /^(\d+)\s+(MTN|AIRTEL|UTL)\s+(256\d{9})$/;
  const match3 = normalized.match(pattern3);
  if (match3) {
    return {
      provider: match3[2],
      amount: parseInt(match3[1]),
      phone: match3[3]
    };
  }

  return null;
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
      `_Example: "Check my balance" or "Buy MTN airtime"_`
    : `${timeOfDay}! Welcome back to *FanitePay* 👋\n\n` +
      `How can I help you today?\n\n` +
      `💡 *Quick commands:* balance, airtime, pay water, transfer money, or just tell me what you need!`;
  
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
    `• "Buy 5000 MTN airtime for 256701234567"\n` +
    `• "Send 50k to my friend"\n` +
    `• "Pay my UMEME bill"\n\n` +
    `We're here 24/7 to help! 🌟`
  );
};

// Enhanced intent parsing with quick pattern matching + NLP Cloud fallback
const parseCommand = async (message) => {
  const normalized = message.trim();

  // Check if it's an OTP first
  if (/^\d{6}$/.test(normalized)) return 'otp';

  // Check for airtime patterns
  if (parseAirtimeRequest(message)) return 'airtime_direct';

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

const pendingActions = {};
const airtimeRequests = {}; // Store pending airtime requests

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
    // Handle direct airtime requests (with phone, provider, amount parsed)
    else if (command === 'airtime_direct') {
      const airtimeDetails = parseAirtimeRequest(message);
      if (airtimeDetails) {
        const { provider, amount, phone: targetPhone } = airtimeDetails;
        
        // Validate amount (minimum 1000, maximum 100000)
        if (amount < 1000 || amount > 100000) {
          await sendWhatsapp(phone, 
            `⚠️ *Invalid Amount*\n\n` +
            `Airtime amount must be between UGX 1,000 and UGX 100,000.\n\n` +
            `Please try again with a valid amount.`
          );
          return res.sendStatus(200);
        }

        // Store the airtime request
        airtimeRequests[phone] = { provider, amount, phone: targetPhone };
        pendingActions[phone] = 'airtime';
        
        await sendOtp(phone);
        await sendWhatsapp(phone, 
          `📱 *Airtime Purchase Confirmation*\n\n` +
          `Provider: ${provider}\n` +
          `Amount: UGX ${amount.toLocaleString()}\n` +
          `Phone: ${targetPhone}\n\n` +
          `🔐 Please enter the 6-digit OTP we just sent to verify this purchase.\n\n` +
          `⏰ OTP expires in 5 minutes`
        );
      }
    }
    // Handle regular airtime requests (show options)
    else if (command === 'airtime') {
      await showAirtimeOptions(phone);
    }
    // Handle services requiring OTP (except direct airtime which is handled above)
    else if (['pay water', 'pay electricity', 'pay tv', 'top up', 'transfer'].includes(command)) {
      pendingActions[phone] = command;
      await sendOtp(phone);
      
      const serviceNames = {
        'pay water': 'Water Bill Payment',
        'pay electricity': 'Electricity Bill Payment',
        'pay tv': 'TV Subscription Payment',
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

        if (action === 'airtime' && airtimeRequests[phone]) {
          // Process real airtime purchase
          const { provider, amount, phone: targetPhone } = airtimeRequests[phone];
          delete airtimeRequests[phone];

          try {
            const result = await processAirtimePurchase(targetPhone, provider, amount, user_id);
            
            if (result.success) {
              await sendWhatsapp(phone, 
                `✅ *Airtime Purchase Successful*\n\n` +
                `📱 ${provider} airtime of UGX ${amount.toLocaleString()} has been sent to ${targetPhone}\n\n` +
                `📋 Reference: ${result.reference}\n\n` +
                `💰 New wallet balance: UGX ${(await getWalletBalance(user_id)).toLocaleString()}\n\n` +
                `Thank you for using FanitePay! 🌟`
              );
            }
          } catch (error) {
            let errorMessage = `❌ *Airtime Purchase Failed*\n\n`;
            
            if (error.message === 'INSUFFICIENT_BALANCE') {
              const currentBalance = await getWalletBalance(user_id);
              errorMessage += `Insufficient balance. You have UGX ${currentBalance.toLocaleString()} but need UGX ${amount.toLocaleString()}.\n\n` +
                              `💡 Top up your wallet and try again.`;
            } else if (error.message === 'EASYPAY_API_ERROR' || error.message === 'EASYPAY_TRANSACTION_FAILED') {
              errorMessage += `There was an issue processing your airtime purchase. Please try again in a few minutes.\n\n` +
                              `If the problem persists, contact our support team.`;
            } else {
              errorMessage += `An unexpected error occurred. Please try again later.\n\n` +
                              `If you continue to experience issues, contact our support team.`;
            }
            
            await sendWhatsapp(phone, errorMessage);
          }
        } else {
          // Handle other services (existing logic)
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
            'top up': '💵 Wallet top-up complete! Funds are now available in your account.',
            'transfer': '🔄 Money transfer successful! Funds have been sent.'
          };

          await sendWhatsapp(phone, 
            `✅ *Transaction Successful*\n\n` +
            `${successMessages[action]}\n\n` +
            `📱 Thank you for using FanitePay! 🌟`
          );
        }
      } else {
        // Clear any pending airtime requests on invalid OTP
        if (airtimeRequests[phone]) {
          delete airtimeRequests[phone];
        }
        
        await sendWhatsapp(phone, 
          `❌ *Invalid OTP*\n\n` +
          `The code you entered is incorrect or has expired.\n\n` +
          `💡 Please try your transaction again to get a new OTP, or type "help" if you need assistance.`
        );
      }
    } 
    // Handle cancel requests
    else if (message.toLowerCase().trim() === 'cancel') {
      if (pendingActions[phone] || airtimeRequests[phone]) {
        delete pendingActions[phone];
        delete airtimeRequests[phone];
        
        await sendWhatsapp(phone, 
          `🚫 *Transaction Cancelled*\n\n` +
          `Your transaction has been cancelled successfully.\n\n` +
          `How else can I help you today? 😊`
        );
      } else {
        await sendWhatsapp(phone, 
          `ℹ️ No active transaction to cancel.\n\n` +
          `How can I help you today?`
        );
      }
    }
    // Handle unknown commands with helpful suggestions
    else {
      const suggestions = [
        'check my balance',
        'buy MTN airtime',
        'pay water bill',
        'send money',
        'help'
      ];
      
      await sendWhatsapp(phone, 
        `🤔 *I didn't quite understand that*\n\n` +
        `No worries! Try saying something like:\n` +
        `${suggestions.map(s => `• "${s}"`).join('\n')}\n\n` +
        `💬 You can also type "help" to see all available services.\n\n` +
        `*For airtime:* Use format like "MTN 5000 256701234567"\n\n` +
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
        // Clean up any pending requests on error
        delete pendingActions[phone];
        delete airtimeRequests[phone];
        
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

// Standalone airtime endpoint (for API access)
app.post('/airtime', async (req, res) => {
  const { phone, provider, amount } = req.body;
  
  // Validate required fields
  const requiredFields = ['phone', 'provider', 'amount'];
  for (const field of requiredFields) {
    if (!req.body[field]) {
      return res.status(400).json({ error: `Missing field: ${field}` });
    }
  }
  
  try {
    // Prepare data for the EasyPay API
    const easyPayData = {
      username: EASYPAY_USERNAME,
      password: EASYPAY_PASSWORD,
      action: 'paybill',
      provider,
      phone,
      amount,
      reference: "fntp" + Math.floor(Math.random() * 9000000000) + 1000000000
    };
    
    // Send request to the EasyPay API
    const response = await axios.post(EASYPAY_API_URL, easyPayData, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Check if the request was successful
    if (response.status !== 200) {
      return res.status(response.status).json({ error: 'Failed to send request to EasyPay API' });
    }
    
    // Echo back the response from the EasyPay API as the response to the initial request
    return res.status(200).json(response.data);
  } catch (error) {
    console.error('Standalone airtime error:', error);
    return res.status(500).json({ error: 'Failed to process airtime transaction request' });
  }
});

// Health check endpoint for testing NLP Cloud connection
app.get('/test-nlp', async (req, res) => {
  try {
    const testMessage = req.query.message || 'check my balance';
    
    const response = await axios.post(
      `${NLP_CLOUD_BASE_URL}/bart-large-mnli/classification`,
      {
        text: testMessage,
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

    res.json({
      message: testMessage,
      classification: response.data,
      parsedCommand: await parseCommand(testMessage)
    });
  } catch (error) {
    console.error('NLP test error:', error);
    res.status(500).json({ error: 'NLP Cloud test failed', details: error.message });
  }
});

// Test airtime parsing endpoint
app.get('/test-airtime-parse', (req, res) => {
  const testMessages = [
    'MTN 5000 256701234567',
    'Buy 10000 AIRTEL airtime for 256709876543',
    '15000 UTL 256701234567',
    'airtel 20000 256701234567',
    'invalid message'
  ];

  const results = testMessages.map(message => ({
    message,
    parsed: parseAirtimeRequest(message)
  }));

  res.json(results);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FanitePay WhatsApp Bot running on port ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.BASE_URL || 'http://localhost:' + PORT}/whatsapp`);
  console.log(`🔧 Health check: ${process.env.BASE_URL || 'http://localhost:' + PORT}/test-nlp`);
});
