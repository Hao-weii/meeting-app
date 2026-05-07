'use strict';
require('dotenv').config();

const { fetch: undiciFetch, Agent: UndiciAgent } = require('undici');
const longTimeoutAgent = new UndiciAgent({
  headersTimeout: 10 * 60 * 1000,
  bodyTimeout:    10 * 60 * 1000,
});

const express = require('express');
const multer = require('multer');
const { Client } = require('@notionhq/client');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const app = express();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

function tempFilePath(prefix = 'meeting') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
}

async function safeUnlink(p) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* ignore */ }
}
const notion = new Client({ auth: process.env.NOTION_TOKEN });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ─── Config helpers ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  project_name: '',
  project_description: '',
  members: [],
  meeting_counter: 1,
  meeting_types: ['組內會議', '教授會議', '進度回報', '技術討論'],
};

function chunkRichText(text, maxLen = 2000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + maxLen) } });
  }
  return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
}

async function readConfigFromNotion() {
  const { results } = await notion.blocks.children.list({
    block_id: process.env.NOTION_CONFIG_PAGE_ID,
  });
  const codeBlock = results.find((b) => b.type === 'code');
  if (!codeBlock) return null;
  const text = codeBlock.code.rich_text.map((t) => t.plain_text).join('');
  return { data: JSON.parse(text), blockId: codeBlock.id };
}

async function writeConfigToNotion(config) {
  const text = JSON.stringify(config, null, 2);
  const richText = chunkRichText(text);

  const { results } = await notion.blocks.children.list({
    block_id: process.env.NOTION_CONFIG_PAGE_ID,
  });
  const codeBlock = results.find((b) => b.type === 'code');

  if (codeBlock) {
    await notion.blocks.update({
      block_id: codeBlock.id,
      code: { rich_text: richText, language: 'json' },
    });
  } else {
    await notion.blocks.children.append({
      block_id: process.env.NOTION_CONFIG_PAGE_ID,
      children: [{ type: 'code', code: { rich_text: richText, language: 'json' } }],
    });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/config', async (req, res) => {
  try {
    const result = await readConfigFromNotion();
    res.json(result ? result.data : DEFAULT_CONFIG);
  } catch (err) {
    console.error('GET /config:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/config', async (req, res) => {
  try {
    await writeConfigToNotion(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /config:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate', upload.single('audio'), async (req, res) => {
  let audioPath = null;
  let cleanupAudioPath = false;
  try {
    const { apiKey, model, driveUrl, date, meetingType, topic, config } = req.body;
    const cfg = JSON.parse(config);

    let mimeType;

    if (req.file) {
      audioPath = req.file.path;
      cleanupAudioPath = true;
      mimeType = (req.file.mimetype && req.file.mimetype !== 'application/octet-stream')
        ? req.file.mimetype
        : detectMime(req.file.originalname);
      console.log('file mimetype:', req.file.mimetype, '| originalname:', req.file.originalname, '| size:', req.file.size, '| resolved:', mimeType);
    } else if (driveUrl) {
      const fileId = extractDriveId(driveUrl);
      audioPath = tempFilePath('drive');
      cleanupAudioPath = true;
      const { contentType, filename } = await downloadFromDriveToFile(fileId, audioPath);
      const ct = (contentType || '').split(';')[0].trim();
      mimeType = (ct && !ct.includes('octet-stream'))
        ? ct
        : detectMime(filename || '');
      console.log('drive content-type:', contentType, '| filename:', filename, '| resolved:', mimeType);
    } else {
      throw new Error('請提供音訊檔案或 Google Drive 連結');
    }

    const fileUri = await uploadToGeminiFiles(apiKey, audioPath, mimeType);
    await waitForGeminiFile(apiKey, fileUri);

    const prompt = buildPrompt(cfg, date, meetingType, topic);
    const content = await geminiGenerateContent(apiKey, model, fileUri, mimeType, prompt);

    res.json({ content });
  } catch (err) {
    console.error('POST /generate:', err.message, err.cause ?? '');
    res.status(500).json({ error: err.message });
  } finally {
    if (cleanupAudioPath) await safeUnlink(audioPath);
  }
});

function extractSection(md, heading) {
  const lines = md.split('\n');
  const result = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inside) break;
      if (line.slice(3).trim() === heading) { inside = true; continue; }
    }
    if (inside) result.push(line);
  }
  return result.join('\n').trim();
}

app.post('/upload-to-notion', async (req, res) => {
  try {
    const { title, date, meetingType, content, config } = req.body;
    const cfg = JSON.parse(config);

    const blocks = markdownToNotionBlocks(content);
    const firstBatch = blocks.slice(0, 100);

    const page = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        '會議標題': { title: [{ type: 'text', text: { content: title } }] },
        '會議日期': { date: { start: date } },
        '會議類型': { select: { name: meetingType } },
        '討論內容': { rich_text: [{ type: 'text', text: { content: extractSection(content, '討論內容').replace(/\n+/g, ' ').slice(0, 100).trim() } }] },
        '決議事項': { rich_text: [{ type: 'text', text: { content: extractSection(content, '決議事項').replace(/\n+/g, ' ').slice(0, 100).trim() } }] },
      },
      children: firstBatch,
    });

    // Append blocks beyond the first 100
    for (let i = 100; i < blocks.length; i += 100) {
      await notion.blocks.children.append({
        block_id: page.id,
        children: blocks.slice(i, i + 100),
      });
    }

    // Increment counter and persist
    const newConfig = { ...cfg, meeting_counter: cfg.meeting_counter + 1 };
    await writeConfigToNotion(newConfig);

    res.json({ success: true, newCounter: newConfig.meeting_counter, pageUrl: page.url });
  } catch (err) {
    console.error('POST /upload-to-notion:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Gemini helpers ───────────────────────────────────────────────────────────

async function downloadFromDriveToFile(fileId, destPath) {
  const base = 'https://drive.usercontent.google.com/download';
  const firstUrl = `${base}?id=${fileId}&export=download`;

  let resp = await undiciFetch(firstUrl, {
    redirect: 'follow',
    dispatcher: longTimeoutAgent,
  });
  if (!resp.ok) throw new Error(`無法取得 Drive 檔案（HTTP ${resp.status}）`);

  let ct = resp.headers.get('content-type') || '';

  // 大檔會先回傳 HTML 確認頁；解析其中的表單欄位（含 uuid/confirm）後重送請求
  if (ct.includes('text/html')) {
    const html = await resp.text();
    const formMatch = html.match(/<form[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
    if (!formMatch) {
      throw new Error('Google Drive 回傳 HTML 頁面，請確認連結已設為「知道連結的人都可以檢視」');
    }
    const action = formMatch[1].replace(/&amp;/g, '&');
    const params = {};
    const inputRe = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
    let m;
    while ((m = inputRe.exec(formMatch[2])) !== null) {
      params[m[1]] = m[2];
    }
    const qs = new URLSearchParams(params).toString();
    const confirmUrl = action + (action.includes('?') ? '&' : '?') + qs;

    resp = await undiciFetch(confirmUrl, {
      redirect: 'follow',
      dispatcher: longTimeoutAgent,
    });
    if (!resp.ok) throw new Error(`無法取得 Drive 檔案（HTTP ${resp.status}）`);
    ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      throw new Error('Google Drive 回傳 HTML 頁面，請確認連結已設為「知道連結的人都可以檢視」');
    }
  }

  let filename = '';
  const cd = resp.headers.get('content-disposition') || '';
  const fnStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const fn = cd.match(/filename="?([^";]+)"?/i);
  if (fnStar) filename = decodeURIComponent(fnStar[1]);
  else if (fn) filename = fn[1];

  // 串流寫入暫存檔，避免把整個音檔讀進記憶體
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(destPath));

  return { contentType: ct, filename };
}

function extractDriveId(url) {
  const patterns = [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  throw new Error('無法從 Google Drive URL 解析 File ID，請確認連結格式正確');
}

function detectMime(filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  const map = { ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'audio/mp4' };
  return map[ext] || 'audio/ogg';
}

async function uploadToGeminiFiles(apiKey, filePath, mimeType) {
  const stat = await fs.promises.stat(filePath);
  const boundary = `gem${Date.now()}`;
  const meta = JSON.stringify({ file: { mimeType } });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const contentLength = head.length + stat.size + tail.length;

  const fileStream = fs.createReadStream(filePath);
  const body = Readable.from((async function* () {
    yield head;
    for await (const chunk of fileStream) yield chunk;
    yield tail;
  })());

  const resp = await undiciFetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
      body,
      duplex: 'half',
      dispatcher: longTimeoutAgent,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini File API 上傳失敗: ${text}`);
  }
  const { file } = await resp.json();
  return file.uri;
}

async function waitForGeminiFile(apiKey, fileUri, maxAttempts = 40, intervalMs = 5000) {
  // fileUri: https://generativelanguage.googleapis.com/v1beta/files/FILE_ID
  const fileName = fileUri.replace('https://generativelanguage.googleapis.com/', '');
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/${fileName}?key=${apiKey}`
    );
    if (!resp.ok) break; // proceed and let generateContent surface the error
    const data = await resp.json();
    if (data.state === 'ACTIVE') return;
    if (data.state === 'FAILED') throw new Error('Gemini 檔案處理失敗');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function geminiGenerateContent(apiKey, model, fileUri, mimeType, prompt) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { mime_type: mimeType, file_uri: fileUri } },
              { text: prompt },
            ],
          },
        ],
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini 生成失敗: ${text}`);
  }
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 回應為空，請確認 API Key 與模型名稱是否正確');
  return text;
}

function buildPrompt(cfg, date, meetingType, topic) {
  return `你是專題小組的會議紀錄員。
我們的專題名稱是：${cfg.project_name}
專題說明：${cfg.project_description}

請仔細聆聽這段會議錄音，根據實際對話內容撰寫詳細的會議紀錄。

撰寫原則：
1. 內容完整性：錄音中所有與專題有關的討論主題都要納入，不要因為「不夠重要」就省略。明顯的閒聊（例如打招呼、約吃飯）才略過。
2. 細節豐富度：每個主題下用 2~5 個項目符號條列實際講到的內容，包含提出的方案、技術選項、數據、遇到的問題、成員的意見、教授的建議等具體資訊。避免「討論了 XX 議題」這種空泛描述。
3. 真實性：若錄音中沒有明確資訊，直接留空，不要捏造。決議事項與行動項目必須是錄音中真正提到的，不要把討論內容硬塞進來充數。
4. 在開始撰寫前，先在內部列出錄音中出現的所有主要討論主題（不需要輸出這份清單），再依此撰寫，確保覆蓋完整。

輸出時請只輸出下方格式的 Markdown，不要加任何開場白、結尾說明、或程式碼框：

# ${meetingType}_${topic}

- 會議日期: ${date}
- 會議時間:
- 會議類型: ${meetingType}
- 與會者:

## 討論內容

1. 第一個討論主題的標題
   - 該主題下實際討論的具體內容點 1
   - 該主題下實際討論的具體內容點 2
   - 該主題下實際討論的具體內容點 3

2. 第二個討論主題的標題
   - 該主題下實際討論的具體內容點 1
   - 該主題下實際討論的具體內容點 2

（依此格式列出所有討論主題，每個主題的項目符號數量視實際討論內容而定）

## 決議事項

1. 會議中真正達成共識或做出的決定（每項一行）

## 後續行動項目

1. 會後需執行的具體任務（每項一行，包含要做什麼，若錄音中有提到負責人或期限也一併寫上）
`;
}

// ─── Markdown → Notion blocks ─────────────────────────────────────────────────

function markdownToNotionBlocks(md) {
  const rt = (text) => [{ type: 'text', text: { content: text.slice(0, 2000) } }];
  const blocks = [];
  let started = false;

  for (const line of md.split('\n')) {
    if (!started) {
      if (line.startsWith('## ')) started = true;
      else continue;
    }
    if (!line.trim()) continue;

    const t = line.trimStart();
    if (t.startsWith('# ')) {
      blocks.push({ type: 'heading_1', heading_1: { rich_text: rt(t.slice(2)) } });
    } else if (t.startsWith('## ')) {
      blocks.push({ type: 'heading_2', heading_2: { rich_text: rt(t.slice(3)) } });
    } else if (t.startsWith('### ')) {
      blocks.push({ type: 'heading_3', heading_3: { rich_text: rt(t.slice(4)) } });
    } else if (t.startsWith('- ')) {
      blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(t.slice(2)) } });
    } else if (/^\d+\. /.test(t)) {
      blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: rt(t.replace(/^\d+\. /, '')) } });
    } else {
      blocks.push({ type: 'paragraph', paragraph: { rich_text: rt(t) } });
    }
  }

  return blocks;
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
