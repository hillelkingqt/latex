const express = require('express');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const path = require('path');

// --- Configuration ---
const BOT_TOKEN = '8416296712:AAEj1Ff-6cwVzae1IkCHhS2kyha8GXBW2sU';
const ADMIN_CHAT_ID = '7547836101';
const PORT = process.env.PORT || 3000;

// --- Storage Setup (using file-based storage instead of KV) ---
const STORAGE_DIR = './data';

class FileStorage {
    constructor() {
        this.ensureStorageDir();
    }

    async ensureStorageDir() {
        try {
            await fs.access(STORAGE_DIR);
        } catch {
            await fs.mkdir(STORAGE_DIR, { recursive: true });
        }
    }

    async get(key) {
        try {
            const data = await fs.readFile(path.join(STORAGE_DIR, `${key}.json`), 'utf8');
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    async put(key, value, options = {}) {
        const data = {
            value,
            timestamp: Date.now(),
            ttl: options.expirationTtl
        };
        await fs.writeFile(path.join(STORAGE_DIR, `${key}.json`), JSON.stringify(data));
    }

    async delete(key) {
        try {
            await fs.unlink(path.join(STORAGE_DIR, `${key}.json`));
        } catch {
            // File doesn't exist, that's fine
        }
    }

    async list(options = {}) {
        try {
            const files = await fs.readdir(STORAGE_DIR);
            const keys = files
                .filter(file => file.endsWith('.json'))
                .map(file => ({ name: file.replace('.json', '') }))
                .filter(key => !options.prefix || key.name.startsWith(options.prefix));
            return { keys };
        } catch {
            return { keys: [] };
        }
    }

    // Cleanup expired items
    async cleanup() {
        try {
            const files = await fs.readdir(STORAGE_DIR);
            const now = Date.now();

            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const data = await fs.readFile(path.join(STORAGE_DIR, file), 'utf8');
                        const parsed = JSON.parse(data);
                        if (parsed.ttl && (now - parsed.timestamp) > (parsed.ttl * 1000)) {
                            await fs.unlink(path.join(STORAGE_DIR, file));
                        }
                    } catch {
                        // Skip corrupted files
                    }
                }
            }
        } catch {
            // Error during cleanup, continue
        }
    }
}

const storage = new FileStorage();

// Initialize Express app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Latest message endpoint
app.get('/latest-message', async (req, res) => {
    try {
        const messageData = await storage.get('latest_message');
        
        const headers = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        };

        Object.keys(headers).forEach(key => {
            res.set(key, headers[key]);
        });

        if (messageData && messageData.value) {
            return res.json(messageData.value);
        }
        return res.status(404).json({ message: 'No new message' });
    } catch (error) {
        console.error('Error getting latest message:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Ping endpoint
app.post('/ping', async (req, res) => {
    try {
        const { version = 'unknown' } = req.body;
        const pingsKey = 'stats_total_pings';
        const versionKey = `stats_version_${version}`;

        const currentPings = await storage.get(pingsKey);
        const currentVersionPings = await storage.get(versionKey);

        await Promise.all([
            storage.put(pingsKey, (currentPings?.value || 0) + 1),
            storage.put(versionKey, (currentVersionPings?.value || 0) + 1)
        ]);

        res.status(200).send('Ping received.');
    } catch (error) {
        console.error('Error handling ping:', error);
        res.status(400).send('Invalid ping request.');
    }
});

// Error reporting endpoint
app.post('/error', async (req, res) => {
    try {
        const { error, stack, version, platform } = req.body;
        if (!error) {
            return res.status(400).send('Error report received, but no error message provided.');
        }

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
        
        await sendMessage(ADMIN_CHAT_ID, errorMessage);
        res.status(200).send('Error report received.');
    } catch (error) {
        console.error('Error handling error report:', error);
        res.status(400).send('Invalid error report.');
    }
});

// Telegram webhook endpoint
app.post('/', async (req, res) => {
    try {
        await handleWebhook(req.body);
        res.send('ok');
    } catch (error) {
        console.error('Error handling webhook:', error);
        res.send('ok');
    }
});

// Main route
app.get('/', (req, res) => {
    res.send(`GeminiApp Advanced Server is active. Current time: ${new Date().toISOString()}`);
});

// ==================================
// TELEGRAM WEBHOOK LOGIC
// ==================================

async function handleWebhook(body) {
    const message = body.message || body.callback_query?.message;
    const user = body.message?.from || body.callback_query?.from;

    if (!message || !user || String(user.id) !== ADMIN_CHAT_ID) return;

    if (body.message?.text && body.message.text.startsWith('/')) {
        await storage.delete(`state_${user.id}`);
    }

    if (body.callback_query) {
        await handleCallbackQuery(body.callback_query);
    } else if (body.message) {
        await handleMessage(body.message);
    }
}

async function handleMessage(message) {
    const { from, chat, text } = message;
    const stateData = await storage.get(`state_${from.id}`);
    const state = stateData?.value;

    // State-based input handling
    if (state) {
        if (state === 'awaiting_broadcast_text' && text) {
            const messageData = { id: Date.now(), type: 'text', content: text };
            await storage.put('latest_message', messageData, { expirationTtl: 86400 });
            await sendMessage(chat.id, '✅ *Success!* Text broadcast is now active.');
            await storage.delete(`state_${from.id}`);
            return showMainMenu(chat.id, 'What would you like to do next?');
        }
        if (state === 'awaiting_broadcast_html' && message.document) {
            if (message.document.file_name?.toLowerCase().endsWith('.html')) {
                const fileId = message.document.file_id;
                const fileInfo = await getFile(fileId);
                const fileResponse = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`);
                const fileContent = await fileResponse.text();
                const messageData = { id: Date.now(), type: 'html', content: fileContent };
                await storage.put('latest_message', messageData, { expirationTtl: 86400 });
                await sendMessage(chat.id, '✅ *Success!* HTML broadcast is now active.');
                await storage.delete(`state_${from.id}`);
                return showMainMenu(chat.id, 'What would you like to do next?');
            } else {
                return sendMessage(chat.id, '❌ Invalid file. Please upload an `.html` file.');
            }
        }
    }

    // Command handling
    if (text === '/stats') {
        const totalPingsData = await storage.get('stats_total_pings');
        const totalPings = totalPingsData?.value || 0;
        const versionKeys = await storage.list({ prefix: 'stats_version_' });

        let versionStats = 'No version data yet.';
        if (versionKeys.keys.length > 0) {
            const versionCounts = await Promise.all(versionKeys.keys.map(async (key) => {
                const data = await storage.get(key.name);
                return {
                    version: key.name.replace('stats_version_', ''),
                    count: data?.value || 0
                };
            }));
            versionStats = versionCounts.sort((a, b) => b.count - a.count)
                .map(v => `\`${v.version}\`: *${v.count}* opens`).join('\n');
        }

        return sendMessage(chat.id, `📊 *GeminiDesk Analytics*\n\n*Total App Opens:* ${totalPings}\n\n*Opens by Version:*\n${versionStats}`);
    }

    return showMainMenu(chat.id);
}

async function handleCallbackQuery(callbackQuery) {
    const { from, message, data } = callbackQuery;
    const [action] = data.split(':');

    switch (action) {
        case 'dismiss':
            return apiCall('deleteMessage', { chat_id: message.chat.id, message_id: message.message_id });
        case 'back_to_main':
            await storage.delete(`state_${from.id}`);
            return showMainMenu(message.chat.id, 'Welcome back!', message.message_id);
        case 'broadcast_menu':
            return showBroadcastMenu(message.chat.id, message.message_id);
        case 'view_stats':
            return handleMessage({ text: '/stats', chat: { id: message.chat.id }, from });
        case 'view_active_message':
            const msgData = await storage.get('latest_message');
            if (msgData?.value) {
                const msg = msgData.value;
                const contentPreview = msg.content.substring(0, 300) + (msg.content.length > 300 ? '...' : '');
                const text = `👁️ *Active Broadcast*\n*Type:* \`${msg.type}\` | *ID:* \`${msg.id}\`\n---\n*Preview:*\n\`\`\`\n${contentPreview}\n\`\`\``;
                return editMessage(message.chat.id, message.message_id, text, { inline_keyboard: [[{ text: '🗑️ Delete This Message', callback_data: 'delete_active_message_confirm' }], [{ text: '‹ Back', callback_data: 'broadcast_menu' }]] });
            }
            return editMessage(message.chat.id, message.message_id, 'ℹ️ There is no active broadcast message.', { inline_keyboard: [[{ text: '‹ Back', callback_data: 'broadcast_menu' }]] });
        case 'delete_active_message_confirm':
            return editMessage(message.chat.id, message.message_id, '❓ Are you sure you want to delete the active broadcast?', { inline_keyboard: [[{ text: '✅ Yes, Delete It', callback_data: 'delete_active_message_do' }], [{ text: '❌ No, Cancel', callback_data: 'view_active_message' }]] });
        case 'delete_active_message_do':
            await storage.delete('latest_message');
            return editMessage(message.chat.id, message.message_id, '🗑️ Active broadcast has been deleted.', { inline_keyboard: [[{ text: '‹ Back', callback_data: 'broadcast_menu' }]] });
        case 'awaiting_broadcast_text':
        case 'awaiting_broadcast_html':
            await storage.put(`state_${from.id}`, action);
            const prompt = action === 'awaiting_broadcast_text' ? '✍️ Send the text you want to broadcast.' : '📄 Upload the `.html` file.';
            return editMessage(message.chat.id, message.message_id, prompt, { inline_keyboard: [[{ text: '‹ Cancel', callback_data: 'broadcast_menu' }]] });
    }
}

// ==================================
// SCHEDULED TASKS
// ==================================

async function handleScheduledMessages() {
    const scheduled = await storage.list({ prefix: 'scheduled_' });
    const now = Math.floor(Date.now() / 1000);
    
    for (const key of scheduled.keys) {
        const scheduledTime = parseInt(key.name.split('_')[1]);
        if (now >= scheduledTime) {
            const messageData = await storage.get(key.name);
            if (messageData?.value) {
                await storage.put('latest_message', messageData.value, { expirationTtl: 86400 });
                await storage.delete(key.name);
                await sendMessage(ADMIN_CHAT_ID, `✅ Scheduled message \`${messageData.value.id}\` has been published.`);
            }
        }
    }
}

// ==================================
// MENU FUNCTIONS
// ==================================

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
        return editMessage(chatId, messageId, text, keyboard);
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
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
    return editMessage(chatId, messageId, text, keyboard);
}

// ==================================
// TELEGRAM API HELPERS
// ==================================

async function apiCall(method, params) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const response = await fetch(url, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(params) 
    });
    return response.json();
}

function sendMessage(chat_id, text, other_params = {}) {
    return apiCall('sendMessage', { chat_id, text, parse_mode: 'Markdown', ...other_params });
}

function editMessage(chat_id, message_id, text, reply_markup_obj = {}) {
    return apiCall('editMessageText', { chat_id, message_id, text, parse_mode: 'Markdown', reply_markup: reply_markup_obj });
}

function getFile(file_id) {
    return apiCall('getFile', { file_id });
}

// ==================================
// SERVER STARTUP & CLEANUP
// ==================================

// Cleanup expired files every hour
setInterval(async () => {
    await storage.cleanup();
}, 60 * 60 * 1000);

// Handle scheduled messages every minute
setInterval(async () => {
    await handleScheduledMessages();
}, 60 * 1000);

app.listen(PORT, () => {
    console.log(`🚀 GeminiDesk Server is running on port ${PORT}`);
    console.log(`📁 Storage directory: ${STORAGE_DIR}`);
});
