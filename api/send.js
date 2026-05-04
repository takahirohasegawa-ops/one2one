const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// ===================== CONSTANTS =====================

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const BLOCK_PATTERNS = [
  /営業.*(?:お断り|禁止|ご遠慮|不要)/,
  /セールス.*(?:お断り|禁止|ご遠慮)/,
  /(?:お断り|禁止|ご遠慮).*営業/,
  /勧誘.*(?:お断り|禁止)/,
  /売り込み.*(?:お断り|禁止|ご遠慮)/,
  /no\s*(?:sales|solicitation)/i,
];

const CONTACT_LINK_PATTERNS = [
  /お問い?合わせ/, /問い?合わせ/, /コンタクト/, /ご相談/,
  /資料請求/, /contact/i, /inquiry/i, /enquiry/i,
  /お見積/, /無料相談/, /ご連絡/,
];

// ===================== BROWSER =====================

async function createBrowser() {
  return await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

// ===================== FORM PAGE FINDER =====================

async function findFormPage(page, startUrl) {
  await new Promise(r => setTimeout(r, 1500));
  let formResult = await pageHasForm(page);
  if (formResult) return { url: page.url(), found: formResult, method: 'direct' };

  const baseUrl = new URL(startUrl);
  const origin = baseUrl.origin;
  const commonPaths = [
    '/contact', '/contact/', '/contact-us', '/contact-us/',
    '/inquiry', '/inquiry/', '/enquiry',
    '/form', '/form/', '/contact/form',
    '/toiawase', '/otoiawase',
    '/contact.html', '/inquiry.html', '/form.html',
    '/contactus', '/contactus/',
    '/support/contact', '/company/contact',
    '/about/contact', '/info/contact',
  ];

  for (const p of commonPaths) {
    try {
      const response = await page.goto(origin + p, { waitUntil: 'networkidle2', timeout: 10000 });
      if (response && response.status() < 400) {
        await new Promise(r => setTimeout(r, 1000));
        formResult = await pageHasForm(page);
        if (formResult) return { url: page.url(), found: formResult, method: 'guessed_url' };
      }
    } catch {}
  }

  await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));

  const contactLinks = await page.evaluate((patternSources) => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const scored = [];
    const seenHrefs = new Set();
    for (const link of allLinks) {
      const href = link.href || '';
      if (!href || seenHrefs.has(href)) continue;
      if (href.startsWith('tel:') || href.startsWith('mailto:') || href === '#' || href.startsWith('javascript:')) continue;
      seenHrefs.add(href);
      const text = (link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const title = link.getAttribute('title') || '';
      const ariaLabel = link.getAttribute('aria-label') || '';
      const imgAlt = link.querySelector('img') ? (link.querySelector('img').alt || '') : '';
      const combined = [text, title, ariaLabel, imgAlt].join(' ');
      let score = 0;
      for (const src of patternSources) { if (new RegExp(src).test(combined)) score += 10; }
      if (/\/contact|\/inquiry|\/enquiry|\/toiawase|\/otoiawase|\/form/i.test(href.toLowerCase())) score += 12;
      if (/お問い合わせ|問い合わせ/i.test(decodeURIComponent(href.toLowerCase()))) score += 15;
      if (/^お問い合わせ$|^問い合わせ$|^Contact$|^Contact Us$/i.test(text.trim())) score += 20;
      if (/お問い合わせはこちら|お気軽にお問い合わせ/i.test(combined)) score += 18;
      const inFooter = !!link.closest('footer, [class*="footer"], [id*="footer"]');
      const inNav = !!link.closest('nav, [class*="nav"], [class*="menu"], header, [class*="header"]');
      if (inFooter || inNav) score += 3;
      if (/login|ログイン|signup|register|採用|recruit|blog|ブログ|news|ニュース|cart|カート|shop/i.test(text)) score -= 20;
      try { if (new URL(href).hostname !== window.location.hostname) score -= 5; } catch {}
      if (score > 0) scored.push({ href, text: text.slice(0, 60), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10);
  }, CONTACT_LINK_PATTERNS.map(p => p.source));

  for (const link of contactLinks) {
    try {
      await page.goto(link.href, { waitUntil: 'networkidle2', timeout: 15000 });
      await new Promise(r => setTimeout(r, 1500));
      formResult = await pageHasForm(page);
      if (formResult) return { url: page.url(), found: formResult, method: 'link', linkText: link.text };

      const subLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const scored = []; const seen = new Set();
        for (const link of links) {
          const href = link.href || '';
          if (!href || seen.has(href) || href.startsWith('tel:') || href.startsWith('mailto:') || href === '#') continue;
          seen.add(href);
          const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
          let score = 0;
          if (/フォーム|form|入力|送信/i.test(text + ' ' + href)) score += 15;
          if (/contact|inquiry|form|toiawase/i.test(href)) score += 10;
          if (/お問い合わせ|問い合わせ/i.test(text)) score += 12;
          if (score > 0) scored.push({ href, text: text.slice(0, 50), score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 5);
      });
      for (const sub of subLinks) {
        try {
          await page.goto(sub.href, { waitUntil: 'networkidle2', timeout: 12000 });
          await new Promise(r => setTimeout(r, 1000));
          formResult = await pageHasForm(page);
          if (formResult) return { url: page.url(), found: formResult, method: 'nested' };
        } catch {}
      }
      await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 12000 });
    } catch {
      try { await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 12000 }); } catch {}
    }
  }
  return { url: page.url(), found: false, method: 'none' };
}

// ===================== FORM DETECTION =====================

async function pageHasForm(page) {
  const mainResult = await checkFormInContext(page);
  if (mainResult) return 'main';
  try {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      if (/hsforms|hubspot|typeform|google.*forms|formrun|form|widget|embed/i.test(frame.url())) {
        try { if (await checkFormInContext(frame)) return 'iframe'; } catch {}
      }
    }
    const iframeInfos = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map((f, i) => ({ src: f.src, w: f.offsetWidth, h: f.offsetHeight })).filter(f => f.h > 200 && f.w > 200)
    );
    for (const info of iframeInfos) {
      try {
        const frame = page.frames().find(f => f.url() === info.src);
        if (frame && frame !== page.mainFrame() && await checkFormInContext(frame)) return 'iframe';
      } catch {}
    }
  } catch {}
  return false;
}

async function checkFormInContext(context) {
  try {
    return await context.evaluate(() => {
      const allInputs = document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input[type="number"],input:not([type]),textarea,select');
      let c = 0, ta = false, em = false;
      const inIframe = window !== window.top;
      for (const el of allInputs) {
        try { const s = window.getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') continue; } catch { continue; }
        if (!inIframe) { if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue; const r = el.getBoundingClientRect(); if (r.width < 15 || r.height < 5) continue; }
        const a = [el.name, el.id, el.placeholder, el.className].join(' ').toLowerCase();
        if (/^search$|^s$|^q$|検索/i.test(el.name || '')) continue;
        if (el.closest('[role="search"],.search-form,#search,[class*="search"]')) continue;
        if (el.type === 'password' || el.closest('[class*="login"],[id*="login"]')) continue;
        if (el.tagName === 'TEXTAREA') ta = true;
        if (el.type === 'email' || /email|mail/i.test(a)) em = true;
        c++;
      }
      return c >= 3 || (c >= 2 && em) || (ta && c >= 1);
    });
  } catch { return false; }
}

// ===================== IFRAME FINDER =====================

async function findFormFrame(page) {
  const iframeElements = await page.$$('iframe');
  let bestFrame = null, bestScore = 0;
  for (const iframeEl of iframeElements) {
    try {
      const frame = await iframeEl.contentFrame();
      if (!frame) continue;
      const score = await frame.evaluate(() => {
        try {
          let s = 0;
          s += document.querySelectorAll('input:not([type="hidden"])').length;
          s += document.querySelectorAll('textarea').length * 5;
          s += document.querySelectorAll('select').length * 2;
          return s;
        } catch { return 0; }
      }).catch(() => 0);
      if (score > bestScore) { bestScore = score; bestFrame = frame; }
    } catch {}
  }
  return bestFrame;
}

// ===================== FIELD MAPPING =====================

function mapFieldsToData(analysis, data) {
  const allFields = [...analysis.fields, ...analysis.textareas];
  const mappings = [];
  const usedTypes = new Set();

  const rules = [
    { type: 'email', match: (f) => f.type === 'email' || /mail|email|e[-_]?mail|メール|アドレス/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label+(f.autocomplete||'')), value: () => data.senderEmail },
    { type: 'phone', match: (f) => f.type === 'tel' || /電話|tel|phone|携帯|連絡先/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => data.senderPhone },
    { type: 'company', match: (f) => /会社|企業|法人|組織|corp|company|organization|貴社|御社/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => data.senderCompany },
    { type: 'department', match: (f) => /部署|部門|所属|department|division|役職/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => data.senderDepartment },
    { type: 'lastName', match: (f) => /姓|last[-_]?name|family[-_]?name|sei$|苗字/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => { if (!data.senderName) return ''; return data.senderName.split(/[\s　]+/)[0]; } },
    { type: 'firstName', match: (f) => { const t = f.name+' '+f.id+' '+f.placeholder+' '+f.label; return /first[-_]?name|given[-_]?name|mei$/i.test(t) || (/^名$/i.test(f.label.trim()) && !/名前|氏名/.test(f.label)); }, value: () => { if (!data.senderName) return ''; const p = data.senderName.split(/[\s　]+/); return p.length > 1 ? p.slice(1).join(' ') : ''; } },
    { type: 'name', match: (f) => /氏名|お名前|名前|^name$|full[-_]?name|your[-_]?name|担当|ご担当/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => data.senderName },
    { type: 'subject', match: (f) => /件名|題名|タイトル|subject|title/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => data.subject },
    { type: 'url', match: (f) => f.type === 'url' || /url|ホームページ|サイト|website/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => '' },
    { type: 'body', match: (f) => f.tag === 'textarea' || /本文|内容|メッセージ|お問い?合わせ内容|message|body|content|inquiry|comment|備考|詳細|ご用件|ご質問/i.test(f.name+' '+f.id+' '+f.placeholder+' '+f.label), value: () => data.body },
  ];

  for (const field of allFields) {
    for (const rule of rules) {
      if (usedTypes.has(rule.type) && !['lastName', 'firstName'].includes(rule.type)) continue;
      if (rule.match(field)) {
        const val = rule.value();
        if (val) { mappings.push({ selector: field.selector, value: val, fieldType: rule.type, tag: field.tag }); usedTypes.add(rule.type); }
        break;
      }
    }
  }
  if (!usedTypes.has('body')) {
    const textarea = allFields.find(f => f.tag === 'textarea' && !mappings.some(m => m.selector === f.selector));
    if (textarea && data.body) mappings.push({ selector: textarea.selector, value: data.body, fieldType: 'body', tag: 'textarea' });
  }
  return mappings;
}

// ===================== FORM FILLING =====================

async function fillAndSubmit(page, data, options = {}) {
  const { dryRun = false, formLocation = 'main' } = options;

  let context = page;
  if (formLocation === 'iframe') {
    await new Promise(r => setTimeout(r, 2000));
    const formFrame = await findFormFrame(page);
    if (formFrame) { context = formFrame; await new Promise(r => setTimeout(r, 1000)); }
  }

  // Analyze form with simple reliable script
  let analysis = { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null };
  try {
    analysis = await context.evaluate(() => {
      try {
        const r = { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null };
        const inputs = document.querySelectorAll('input:not([type="hidden"])');
        for (let i = 0; i < inputs.length; i++) {
          const el = inputs[i];
          const type = (el.type || 'text').toLowerCase();
          if ('submit button image reset file'.includes(type)) continue;
          const selector = el.id ? ('#' + el.id) : (el.name ? ('input[name="' + el.name + '"]') : ('input:nth-of-type(' + (i+1) + ')'));
          const label = el.labels && el.labels.length > 0 ? el.labels[0].textContent.trim() : '';
          if (type === 'checkbox') r.checkboxes.push({ selector, name: el.name||'', id: el.id||'', label, value: el.value||'', checked: el.checked });
          else if (type === 'radio') r.radios.push({ selector, name: el.name||'', id: el.id||'', label, value: el.value||'', checked: el.checked });
          else r.fields.push({ tag:'input', type, selector, name: el.name||'', id: el.id||'', placeholder: el.placeholder||'', label, required: el.required, autocomplete: el.getAttribute('autocomplete')||'' });
        }
        const tas = document.querySelectorAll('textarea');
        for (let i = 0; i < tas.length; i++) {
          const el = tas[i]; const selector = el.id ? ('#' + el.id) : (el.name ? ('textarea[name="' + el.name + '"]') : ('textarea:nth-of-type(' + (i+1) + ')'));
          const label = el.labels && el.labels.length > 0 ? el.labels[0].textContent.trim() : '';
          r.textareas.push({ tag:'textarea', selector, name: el.name||'', id: el.id||'', placeholder: el.placeholder||'', label, required: el.required });
        }
        const sels = document.querySelectorAll('select');
        for (let i = 0; i < sels.length; i++) {
          const el = sels[i]; const selector = el.id ? ('#' + el.id) : (el.name ? ('select[name="' + el.name + '"]') : ('select:nth-of-type(' + (i+1) + ')'));
          const opts = []; for (let j = 0; j < el.options.length; j++) opts.push({ value: el.options[j].value, text: el.options[j].textContent.trim() });
          r.selects.push({ tag:'select', selector, name: el.name||'', id: el.id||'', label: '', options: opts, required: el.required });
        }
        const btn = document.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        if (btn) r.submitBtn = btn.id ? ('#' + btn.id) : 'button[type="submit"]';
        return r;
      } catch(e) { return { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null, error: e.message }; }
    });
  } catch {}

  analysis.fields = analysis.fields || [];
  analysis.textareas = analysis.textareas || [];
  analysis.selects = analysis.selects || [];
  analysis.checkboxes = analysis.checkboxes || [];
  analysis.radios = analysis.radios || [];

  const mappings = mapFieldsToData(analysis, data);

  if (mappings.length === 0) {
    return { success: false, message: 'フォームのフィールドにマッチするデータがありませんでした。', analysis: { fields: analysis.fields.map(f => ({ name: f.name, label: f.label })), textareas: analysis.textareas.map(f => ({ name: f.name, label: f.label })) } };
  }

  // Fill fields
  const fillResults = [];
  for (const m of mappings) {
    try {
      const filled = await context.evaluate((sel, value) => {
        let el;
        if (sel.startsWith('#')) el = document.getElementById(sel.slice(1));
        else { try { el = document.querySelector(sel); } catch { el = null; } }
        if (!el) return false;
        el.focus(); el.click();
        try {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
        } catch { el.value = value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      }, m.selector, m.value);
      fillResults.push({ fieldType: m.fieldType, filled: !!filled });
    } catch (err) {
      fillResults.push({ fieldType: m.fieldType, filled: false, error: err.message });
    }
  }

  // Selects
  for (const sel of analysis.selects) {
    const opt = sel.options.find(o => /問い合わせ|お問い合わせ|その他|ご相談|サービス/.test(o.text));
    if (opt && opt.value) {
      try { await context.evaluate((s, v) => { const el = s.startsWith('#') ? document.getElementById(s.slice(1)) : document.querySelector(s); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } }, sel.selector, opt.value); } catch {}
    }
  }

  // Checkboxes
  for (const cb of analysis.checkboxes) {
    if (/同意|承諾|プライバシー|個人情報|agree|privacy|consent|規約/i.test([cb.name, cb.id, cb.label, cb.value].join(' '))) {
      if (!cb.checked) { try { await context.evaluate((s) => { const el = s.startsWith('#') ? document.getElementById(s.slice(1)) : document.querySelector(s); if (el) el.click(); }, cb.selector); } catch {} }
    }
  }

  let screenshot = '';
  try { screenshot = await page.screenshot({ encoding: 'base64', fullPage: false }); } catch {}

  if (dryRun) {
    return { success: true, dryRun: true, fillResults, screenshot: screenshot ? `data:image/png;base64,${screenshot}` : '', formUrl: page.url(), message: 'フォーム入力のプレビューです' };
  }

  // Submit
  if (analysis.submitBtn) {
    try {
      await context.evaluate((sel) => { const btn = sel.startsWith('#') ? document.getElementById(sel.slice(1)) : document.querySelector(sel); if (btn) btn.click(); }, analysis.submitBtn);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    } catch {}
  } else {
    try { await context.evaluate(() => { const form = document.querySelector('form'); if (form) form.submit(); }); await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}); } catch {}
  }

  await new Promise(r => setTimeout(r, 1000));
  let postScreenshot = '';
  try { postScreenshot = await page.screenshot({ encoding: 'base64', fullPage: false }); } catch {}

  return { success: true, fillResults, screenshot: postScreenshot ? `data:image/png;base64,${postScreenshot}` : '', formUrl: page.url(), message: '送信が完了しました' };
}

// ===================== HANDLER =====================

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, data, dryRun } = req.body;
  if (!url || !data) return res.status(400).json({ error: 'URL and data are required' });

  let browser;
  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const formSearch = await findFormPage(page, url);
    if (!formSearch.found) {
      await browser.close();
      return res.json({ success: false, message: 'お問い合わせフォームが見つかりませんでした。' });
    }

    const pageText = await page.evaluate(() => document.body.innerText);
    if (BLOCK_PATTERNS.some(p => p.test(pageText))) {
      await browser.close();
      return res.json({ success: false, blocked: true, message: '営業お断りの記載を検出しました。送信を中止します。' });
    }

    const result = await fillAndSubmit(page, data, { dryRun: !!dryRun, formLocation: formSearch.found });
    result.formFoundBy = formSearch.method;
    if (!result.formUrl) result.formUrl = formSearch.url;

    await browser.close();
    res.json(result);
  } catch (err) {
    if (browser) try { await browser.close(); } catch {}
    let message = 'エラーが発生しました: ' + err.message;
    if (/ERR_NAME_NOT_RESOLVED/.test(err.message)) message = 'URLが見つかりません。';
    else if (/timeout/i.test(err.message)) message = 'タイムアウトしました。';
    res.json({ success: false, message });
  }
};
