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

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});
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
  try {
    const { apiKey, model, driveUrl, date, meetingType, topic, config } = req.body;
    const cfg = JSON.parse(config);

    let audioBuffer, mimeType;

    if (req.file) {
      audioBuffer = req.file.buffer;
      mimeType = (req.file.mimetype && req.file.mimetype !== 'application/octet-stream')
        ? req.file.mimetype
        : detectMime(req.file.originalname);
      console.log('file mimetype:', req.file.mimetype, '| originalname:', req.file.originalname, '| resolved:', mimeType);
    } else if (driveUrl) {
      const fileId = extractDriveId(driveUrl);
      const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      const resp = await fetch(downloadUrl, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`無法取得 Drive 檔案（HTTP ${resp.status}）`);
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        throw new Error('Google Drive 回傳 HTML 頁面，請確認連結已設為「知道連結的人都可以檢視」');
      }
      audioBuffer = Buffer.from(await resp.arrayBuffer());
      mimeType = ct.split(';')[0].trim() || 'audio/ogg';
    } else {
      throw new Error('請提供音訊檔案或 Google Drive 連結');
    }

    const fileUri = await uploadToGeminiFiles(apiKey, audioBuffer, mimeType);
    await waitForGeminiFile(apiKey, fileUri);

    const prompt = buildPrompt(cfg, date, meetingType, topic);
    const content = await geminiGenerateContent(apiKey, model, fileUri, mimeType, prompt);

    res.json({ content });
  } catch (err) {
    console.error('POST /generate:', err.message, err.cause ?? '');
    res.status(500).json({ error: err.message });
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

async function uploadToGeminiFiles(apiKey, buffer, mimeType) {
  const boundary = `gem${Date.now()}`;
  const meta = JSON.stringify({ file: { mimeType } });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const resp = await undiciFetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
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

請仔細聆聽這段會議錄音，根據實際對話內容撰寫會議紀錄。

撰寫原則：
- 只保留與專題直接相關的內容，略去閒聊與跑題。
- 每個討論主題的「內容」欄位必須具體描述實際討論的細節，例如：提出的方案、技術選項、數據、遇到的問題、成員的意見與顧慮——不可以只寫「討論了 XX 問題」這種空泛描述。
- 決議事項必須是會議中真正達成共識或做出的決定，不可以是含糊的「待討論」或重複討論內容。
- 若某個欄位錄音中沒有明確資訊，直接略去或留空，不要捏造內容。

請嚴格按照以下 Markdown 格式輸出，不要加任何開場白或結尾說明：

# ${meetingType}_${topic}

- 會議日期: ${date}
- 會議時間: <如錄音中有提及則填入，否則留空>
- 會議類型: ${meetingType}
- 與會者: <留空，由使用者自行填寫>

## 討論內容

（依錄音中的實際討論主題逐項列出，每項格式如下）

1. <討論主題標題>
- 背景：<為何討論此議題，或目前遇到的問題>
- 內容：<具體的討論細節、提案、技術選項、數據、成員意見等>
- 結論傾向：<本次討論傾向的方向或待確認事項>

## 決議事項

（列出會議中明確達成共識的決定，每項一行，具體說明決定的內容與原因）

1.

## 後續行動項目

（列出會後需執行的具體任務，每項一行，說明要做什麼）

1.

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
