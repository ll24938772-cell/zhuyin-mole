#!/usr/bin/env node
/* make-voicepack.js — 把「注音打地鼠」會念的每一句，用 Azure 神經語音先合成成 mp3。
 *
 * 用法（Node 18 以上，不需要安裝任何套件）：
 *   1. 先看清單、不花錢：
 *        node make-voicepack.js --html "注音打地鼠_語音修正版.html" --dry
 *   2. 真的合成（金鑰與區域用環境變數或參數給）：
 *        set AZURE_SPEECH_KEY=你的金鑰
 *        set AZURE_SPEECH_REGION=eastasia
 *        node make-voicepack.js --html "注音打地鼠_語音修正版.html" --out voice
 *      可選：--voice zh-TW-HsiaoYuNeural（女聲偏年輕）、zh-TW-YunJheNeural（男聲），預設 zh-TW-HsiaoChenNeural
 *
 * 產出：
 *   voice/*.mp3        每句一個檔，檔名是句子的 sha1 前 12 碼（避免中文檔名在不同系統出問題）
 *   voice/index.js     window.VOICE_INDEX = {base, voice, files:{句子:檔名}}，遊戲用 <script> 載入，file:// 也能用
 *   voice/index.json   同內容，給人看或給其他程式用
 *
 * 可以中斷再跑：已經存在的 mp3 會跳過，只補沒做的。
 * 金鑰只在這支腳本用，不會進到遊戲的 HTML 裡。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- 參數 ---------- */
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = k => args.includes(k);
const HTML   = opt('--html', '注音打地鼠.html');
const OUT    = opt('--out', 'voice');
const VOICE  = opt('--voice', 'zh-TW-HsiaoChenNeural');
const KEY    = opt('--key', process.env.AZURE_SPEECH_KEY || '');
const REGION = opt('--region', process.env.AZURE_SPEECH_REGION || 'eastasia');
const DRY    = has('--dry');
const CONC   = Math.max(1, Math.min(8, +opt('--concurrency', 3)));
const FORMAT = 'audio-24khz-48kbitrate-mono-mp3';   // 語音夠用、檔案小
const RATE_SENT = opt('--rate', '-8%');              // 句子的語速（SSML prosody），'0%' 是自然速度
const RATE_CHAR = opt('--rate-char', '-15%');        // 單字與注音的語速
const SAMPLE = has('--sample');                      // 試聽模式：每個聲音做幾句樣本，不做整包
const VOICES = opt('--voices', 'zh-TW-HsiaoChenNeural,zh-TW-HsiaoYuNeural,zh-TW-YunJheNeural').split(',').map(s => s.trim()).filter(Boolean);

/* ---------- 從遊戲 HTML 抓出所有會念的句子 ---------- */
function extract(html) {
  const items = new Map();                              // text -> kind（先到先贏）
  const add = (text, kind) => { text = String(text || '').trim(); if (text && !items.has(text)) items.set(text, kind); };

  // 1. 詞庫 RAW：['蝴蝶','insect','ㄏㄨ2 ㄉㄧㄝ2','e:🦋','圖鑑說明', ...]
  const s = html.indexOf('const RAW'); const e = html.indexOf('\n];', s);
  if (s < 0 || e < 0) throw new Error('找不到 const RAW 詞庫，確認 --html 指到遊戲檔');
  const rows = [...html.slice(s, e).matchAll(/\['([^']+)','(\w+)','([^']+)','[^']*','([^']*)'/g)];
  for (const r of rows) { add(r[1], 'word'); add(r[4], 'fact'); for (const ch of r[1]) add(ch, 'char'); }

  // 2. 單一注音符號的讀法 READ = {ㄅ:'玻',...}
  const read = html.match(/const READ = \{([\s\S]*?)\};/);
  const reads = read ? [...read[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
  for (const r of reads) { add(r, 'read'); add('那是' + r, 'read'); }

  // 3. 四聲比對表 FOUR = { ㄏㄨ:['呼','湖','虎','戶'], ... }
  const four = html.match(/const FOUR = \{([\s\S]*?)\n\};/);
  if (four) for (const m of four[1].matchAll(/'([^']+)'/g)) add(m[1], 'char');

  // 4. 遊戲裡寫死的提示句（從 say / sayParts 呼叫整理出來的；改了遊戲文案要同步改這裡）
  [
    '注音打對了，接下來打聲調', '再聽聽看', '再比比看', '下一個字', '找舉著', '的地鼠',
    '要找聲母喔', '要找介音喔', '要找韻母喔', '要找聲調喔',
    '那是一聲', '那是二聲', '那是三聲', '那是四聲',
    '神獸躲起來了，先把其他圖鑑收集完吧', '還沒收集到，去打打看吧', '三葉蟲',
  ].forEach(t => add(t, 'fixed'));

  return [...items].map(([text, kind]) => ({ text, kind, file: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) + '.mp3' }));
}

/* ---------- Azure 合成 ---------- */
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function ssml(text, kind, voice) {
  const rate = (kind === 'char' || kind === 'read') ? RATE_CHAR : RATE_SENT;   // 單字與注音念慢一點、清楚一點
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW">` +
         `<voice name="${voice || VOICE}"><prosody rate="${rate}">${esc(text)}</prosody></voice></speak>`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function synth(item, voice) {
  const url = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': FORMAT,
        'User-Agent': 'zymole-voicepack',
      },
      body: ssml(item.text, item.kind, voice),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 401 || res.status === 403) throw new Error(`金鑰或區域不對（HTTP ${res.status}）。檢查 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION（區域要跟 Azure 資源一樣，例如 eastasia）`);
    if (res.status === 429 || res.status >= 500) { await sleep(800 * attempt * attempt); continue; }   // 太快或服務忙：退避重試
    throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('重試 5 次仍失敗');
}

/* ---------- 主流程 ---------- */
(async () => {
  /* --sample：每個聲音做六句樣本到 voice_samples/<聲音>/，先聽再決定整包用誰。
     六句 × 三個聲音大約 150 字，幾乎不占額度。 */
  if (SAMPLE) {
    if (!KEY) { console.error('缺金鑰：請設 AZURE_SPEECH_KEY（或 --key）。'); process.exit(1); }
    const samples = [
      { text: '蝴蝶', kind: 'word' }, { text: '蝴', kind: 'char' }, { text: '玻', kind: 'read' },
      { text: '那是一聲', kind: 'read' }, { text: '注音打對了，接下來打聲調', kind: 'fixed' },
      { text: '用長長的口器吸花蜜，翅膀上有細細的鱗片。', kind: 'fact' },
    ];
    for (const v of VOICES) {
      const dir = path.join('voice_samples', v.replace(/^zh-TW-/, '').replace(/Neural$/, ''));
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < samples.length; i++) {
        const f = path.join(dir, `${String(i + 1).padStart(2, '0')}_${samples[i].text.slice(0, 8)}.mp3`);
        try { fs.writeFileSync(f, await synth(samples[i], v)); console.log('  ' + f); }
        catch (err) { console.log(`  ${v}：${err.message}`); if (/金鑰或區域/.test(err.message)) process.exit(1); }
        await sleep(120);
      }
    }
    console.log(`\n樣本做好了，打開 voice_samples\\ 裡各資料夾點兩下 mp3 比較。語速：句子 ${RATE_SENT}、單字 ${RATE_CHAR}（可用 --rate 0% --rate-char 0% 試自然速度）。`);
    console.log('決定後整包重做：先把舊的 voice\\ 資料夾改名或刪掉，再用 --voice <聲音> 跑一次。');
    return;
  }
  const html = fs.readFileSync(HTML, 'utf8');
  const list = extract(html);
  const byKind = {}; list.forEach(i => byKind[i.kind] = (byKind[i.kind] || 0) + 1);
  const chars = list.reduce((a, i) => a + i.text.length, 0);
  console.log(`來源：${HTML}`);
  console.log(`句子：${list.length} 段（${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('、')}）`);

  /* 要做哪些聲音：--all 三個都做；--voices a,b 指定；否則就 --voice 那一個。
     每個聲音各放在 voice/<名字>/，遊戲裡可以切換。 */
  const todoVoices = has('--all') ? ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural']
                   : (args.includes('--voices') ? VOICES : [VOICE]);
  console.log(`聲音：${todoVoices.join('、')}；每個聲音 ${chars} 字（Azure 免費額度每月 50 萬字，三個加起來也遠低於額度）`);
  fs.mkdirSync(OUT, { recursive: true });

  if (DRY) {
    fs.writeFileSync(path.join(OUT, 'voicepack_list.txt'), list.map(i => `${i.kind}\t${i.file}\t${i.text}`).join('\n'), 'utf8');
    console.log(`--dry：沒有呼叫 API。完整清單寫在 ${path.join(OUT, 'voicepack_list.txt')}`);
    return;
  }
  if (!KEY) { console.error('缺金鑰：請設 AZURE_SPEECH_KEY（或 --key）。先用 --dry 看清單。'); process.exit(1); }

  for (const voice of todoVoices) {
    const short = shortName(voice), dir = path.join(OUT, short);
    fs.mkdirSync(dir, { recursive: true });
    const todo = list.filter(i => !fs.existsSync(path.join(dir, i.file)));
    console.log(`\n== ${(packInfo()[short]||{name:short}).name}（${voice}）：已存在 ${list.length - todo.length} 段，這次要做 ${todo.length} 段`);

    let done = 0, failed = [], auth = false;
    const queue = todo.slice();
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          fs.writeFileSync(path.join(dir, item.file), await synth(item, voice));
          done++;
          if (done % 20 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}  ${item.text}`);
          await sleep(120);                                      // 對 API 客氣一點
        } catch (err) {
          failed.push({ text: item.text, err: String(err.message || err) });
          if (/金鑰或區域/.test(err.message)) { auth = true; queue.length = 0; }   // 認證錯誤就不用再試了
        }
      }
    }));
    writeIndex(dir, short, voice, list);
    console.log(`完成 ${short}：成功 ${done} 段，失敗 ${failed.length} 段`);
    if (failed.length) { console.log('  失敗的（再跑一次會只補這些）：'); failed.slice(0, 10).forEach(f => console.log(`    ${f.text}  ← ${f.err}`)); }
    if (auth) process.exit(1);
  }

  const packs = writePacks(OUT);
  console.log(`\n語音包總目錄 → ${path.join(OUT, 'packs.js')}：${packs.map(p => `${p.name} ${p.count} 段`).join('、')}`);
  const bytes = packs.reduce((a, p) => a + p.bytes, 0);
  console.log(`總大小：${(bytes / 1048576).toFixed(1)} MB。把 ${OUT}/ 整個資料夾放在遊戲 HTML 旁邊，設定頁就能切換聲音。`);
})().catch(err => { console.error('錯誤：', err.message || err); process.exit(1); });

/* ---------- 語音包的名字、索引、總目錄 ---------- */
/* 用 function 而不是 const：主流程在檔案底部這些宣告執行前就已經開始跑，const 會變成「尚未初始化」錯誤 */
function packInfo() {
  return {
    HsiaoChen: { name: '曉臻', sub: '女聲・沉穩清楚' },
    HsiaoYu:   { name: '曉雨', sub: '女聲・年輕活潑' },
    YunJhe:    { name: '雲哲', sub: '男聲・溫和' },
  };
}
function shortName(voice) { return voice.replace(/^zh-TW-/, '').replace(/Neural$/, ''); }
function writeIndex(dir, short, voice, list) {
  const files = {};
  for (const i of list) if (fs.existsSync(path.join(dir, i.file))) files[i.text] = i.file;
  const base = dir.replace(/\\/g, '/').replace(/\/?$/, '/');
  const index = { id: short, base, voice, format: FORMAT, made: new Date().toISOString(), count: Object.keys(files).length, files };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 1), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), 'window.VOICE_INDEX=' + JSON.stringify(index) + ';', 'utf8');
  return index;
}
/* 掃 voice/ 底下所有有 index.json 的子資料夾，寫成總目錄 packs.js（遊戲用它畫選單） */
function writePacks(out) {
  const packs = [];
  for (const d of fs.readdirSync(out, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const ij = path.join(out, d.name, 'index.json');
    if (!fs.existsSync(ij)) continue;
    const idx = JSON.parse(fs.readFileSync(ij, 'utf8'));
    const info = packInfo()[d.name] || { name: d.name, sub: idx.voice };
    const bytes = Object.values(idx.files).reduce((a, f) => a + (fs.existsSync(path.join(out, d.name, f)) ? fs.statSync(path.join(out, d.name, f)).size : 0), 0);
    packs.push({ id: d.name, name: info.name, sub: info.sub, voice: idx.voice, count: idx.count, index: `${out.replace(/\\/g, '/').replace(/\/?$/, '/')}${d.name}/index.js`, bytes });
  }
  const order = Object.keys(packInfo());
  packs.sort((a, b) => (order.indexOf(a.id) + 99) % 100 - (order.indexOf(b.id) + 99) % 100);
  fs.writeFileSync(path.join(out, 'packs.js'), 'window.VOICE_PACKS=' + JSON.stringify(packs.map(({ bytes, ...p }) => p)) + ';', 'utf8');
  return packs;
}
