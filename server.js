const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.redirect('/one2one.html'));

// ===================== CONSTANTS =====================

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Patterns that indicate "do not send"
const BLOCK_PATTERNS = [
  /営業.*(?:お断り|禁止|ご遠慮|不要)/,
  /セールス.*(?:お断り|禁止|ご遠慮)/,
  /(?:お断り|禁止|ご遠慮).*営業/,
  /勧誘.*(?:お断り|禁止)/,
  /売り込み.*(?:お断り|禁止|ご遠慮)/,
  /no\s*(?:sales|solicitation)/i,
];

// Link text patterns to find contact pages
const CONTACT_LINK_PATTERNS = [
  /お問い?合わせ/, /問い?合わせ/, /コンタクト/, /ご相談/,
  /資料請求/, /contact/i, /inquiry/i, /enquiry/i,
  /お見積/, /無料相談/, /ご連絡/,
];

// ===================== BROWSER =====================

const BROWSER_OPTS = {
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,900',
  ],
  defaultViewport: { width: 1280, height: 900 },
};

// Create a fresh browser per request for stability
async function createBrowser() {
  return await puppeteer.launch(BROWSER_OPTS);
}

// ===================== FORM PAGE FINDER =====================

async function findFormPage(page, startUrl) {
  console.log(`  [探索] ステップ1: 現在のページにフォームがあるか確認`);

  // 1. Check if current page already has a form
  // Wait a bit for dynamic content
  await new Promise(r => setTimeout(r, 1500));
  let formResult = await pageHasForm(page);
  if (formResult) {
    return { url: page.url(), found: formResult, method: 'direct' };
  }

  // 2. Try common URL paths first (fastest approach)
  console.log(`  [探索] ステップ2: よくあるURLパスを試行`);
  const baseUrl = new URL(startUrl);
  const origin = baseUrl.origin;
  const commonPaths = [
    '/contact', '/contact/', '/contact-us', '/contact-us/',
    '/inquiry', '/inquiry/', '/enquiry',
    '/form', '/form/', '/contact/form',
    '/お問い合わせ', '/お問い合わせ/',
    '/toiawase', '/otoiawase',
    '/contact.html', '/inquiry.html', '/form.html',
    '/contactus', '/contactus/',
    '/support/contact', '/company/contact',
    '/about/contact', '/info/contact',
  ];

  for (const p of commonPaths) {
    const tryUrl = origin + p;
    try {
      const response = await page.goto(tryUrl, { waitUntil: 'networkidle2', timeout: 10000 });
      if (response && response.status() < 400) {
        await new Promise(r => setTimeout(r, 1000));
        formResult = await pageHasForm(page);
        if (formResult) {
          console.log(`  [探索] URLパス ${p} でフォーム発見 (${formResult})`);
          return { url: page.url(), found: formResult, method: 'guessed_url' };
        }
      }
    } catch {}
  }

  // 3. Go back to start page and search for links
  console.log(`  [探索] ステップ3: ページ内リンクを探索`);
  await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));

  const contactLinks = await page.evaluate((patternSources) => {
    // Search ALL links including footer, header, nav
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
      const hrefLower = href.toLowerCase();

      let score = 0;

      // Text matching
      for (const src of patternSources) {
        if (new RegExp(src).test(combined)) score += 10;
      }

      // URL path matching
      if (/\/contact|\/inquiry|\/enquiry|\/toiawase|\/otoiawase|\/form/i.test(hrefLower)) score += 12;
      if (/お問い合わせ|問い合わせ/i.test(decodeURIComponent(hrefLower))) score += 15;

      // Specific text matching (high confidence)
      if (/^お問い合わせ$|^問い合わせ$|^Contact$|^Contact Us$/i.test(text.trim())) score += 20;
      if (/お問い合わせはこちら|お気軽にお問い合わせ/i.test(combined)) score += 18;

      // Is it in footer or nav? (still valid, but less penalized)
      const inFooter = !!link.closest('footer, [class*="footer"], [id*="footer"]');
      const inNav = !!link.closest('nav, [class*="nav"], [class*="menu"], header, [class*="header"]');
      if (inFooter || inNav) score += 3; // Boost: contact links are often in footer/nav

      // Penalize clearly unrelated
      if (/login|ログイン|signup|register|採用|recruit|blog|ブログ|news|ニュース|cart|カート|shop/i.test(text)) score -= 20;
      // Penalize if it goes to a different domain
      try {
        const linkDomain = new URL(href).hostname;
        const pageDomain = window.location.hostname;
        if (linkDomain !== pageDomain) score -= 5;
      } catch {}

      if (score > 0) scored.push({ href, text: text.slice(0, 60), score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10);
  }, CONTACT_LINK_PATTERNS.map(p => p.source));

  console.log(`  [探索] ${contactLinks.length}件の候補リンクを検出:`);
  contactLinks.forEach((l, i) => console.log(`    ${i+1}. [${l.score}点] "${l.text}" -> ${l.href}`));

  // 4. Try each candidate link (2 levels deep)
  for (const link of contactLinks) {
    try {
      console.log(`  [探索] アクセス中: "${link.text}" (${link.href})`);
      await page.goto(link.href, { waitUntil: 'networkidle2', timeout: 15000 });
      await new Promise(r => setTimeout(r, 1500));

      formResult = await pageHasForm(page);
      if (formResult) {
        console.log(`  [探索] フォーム発見! (${formResult})`);
        return { url: page.url(), found: formResult, method: 'link', linkText: link.text };
      }

      // Sub-page search: look for links to the actual form
      const subLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const scored = [];
        const seen = new Set();
        for (const link of links) {
          const href = link.href || '';
          if (!href || seen.has(href) || href.startsWith('tel:') || href.startsWith('mailto:') || href === '#' || href.startsWith('javascript:')) continue;
          seen.add(href);
          const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
          let score = 0;
          if (/フォーム|form|入力|送信/i.test(text + ' ' + href)) score += 15;
          if (/こちら|click|here|ボタン/i.test(text)) score += 3;
          if (/contact|inquiry|form|toiawase/i.test(href)) score += 10;
          if (/お問い合わせ|問い合わせ/i.test(text)) score += 12;
          if (/お問い合わせフォーム|入力フォーム/i.test(text)) score += 20;
          if (score > 0) scored.push({ href, text: text.slice(0, 50), score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 5);
      });

      for (const sub of subLinks) {
        try {
          console.log(`  [探索]   サブリンク: "${sub.text}" (${sub.href})`);
          await page.goto(sub.href, { waitUntil: 'networkidle2', timeout: 12000 });
          await new Promise(r => setTimeout(r, 1000));
          formResult = await pageHasForm(page);
          if (formResult) {
            console.log(`  [探索]   サブリンクでフォーム発見! (${formResult})`);
            return { url: page.url(), found: formResult, method: 'nested', linkText: `${link.text} > ${sub.text}` };
          }
        } catch {}
      }

      // Return to start for next candidate
      await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 12000 });
    } catch (e) {
      console.log(`  [探索] エラー: ${e.message}`);
      try { await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 12000 }); } catch {}
    }
  }

  console.log(`  [探索] フォームが見つかりませんでした`);
  return { url: page.url(), found: false, method: 'none' };
}

// Check if a page has a usable form (more lenient detection)
// Returns: false, 'main', or 'iframe' (indicating where the form is)
async function pageHasForm(page) {
  // 1. Check main page
  const mainResult = await checkFormInContext(page);
  if (mainResult) return 'main';

  // 2. Check iframes (HubSpot, Googleフォーム, formrun, etc.)
  try {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      const frameUrl = frame.url();
      // Only check iframes that look like form embeds
      if (/hsforms|hubspot|typeform|google.*forms|formrun|form|widget|embed/i.test(frameUrl)) {
        try {
          const iframeResult = await checkFormInContext(frame);
          if (iframeResult) {
            console.log(`  [検出] iframe内にフォーム発見: ${frameUrl.slice(0, 80)}`);
            return 'iframe';
          }
        } catch {}
      }
    }
    // Also check any iframe with significant size
    const iframeInfos = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map((f, i) => ({
        index: i, src: f.src, width: f.offsetWidth, height: f.offsetHeight
      })).filter(f => f.height > 200 && f.width > 200);
    });
    for (const info of iframeInfos) {
      try {
        const frame = page.frames().find(f => f.url() === info.src);
        if (frame && frame !== page.mainFrame()) {
          const iframeResult = await checkFormInContext(frame);
          if (iframeResult) {
            console.log(`  [検出] 大きいiframe内にフォーム発見: ${info.src.slice(0, 80)}`);
            return 'iframe';
          }
        }
      } catch {}
    }
  } catch {}

  return false;
}

// Check for form fields within a page or frame context
async function checkFormInContext(context) {
  try {
    return await context.evaluate(() => {
      const allInputs = document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"],' +
        'input[type="number"], input:not([type]), textarea, select'
      );

      let formFieldCount = 0;
      let hasTextarea = false;
      let hasEmailField = false;

      const inIframe = window !== window.top;
      for (const el of allInputs) {
        try {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
        } catch { continue; }
        // In iframes, skip strict size/offset checks
        if (!inIframe) {
          if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 15 || rect.height < 5) continue;
        }

        const attrs = [el.name, el.id, el.placeholder, el.className, el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
        if (/^search$|^s$|^q$|検索/i.test(el.name || '')) continue;
        if (el.closest('[role="search"]') || el.closest('.search-form') || el.closest('#search') || el.closest('[class*="search"]')) continue;
        if (el.type === 'password') continue;
        if (el.closest('[class*="login"]') || el.closest('[id*="login"]')) continue;

        if (el.tagName === 'TEXTAREA') hasTextarea = true;
        if (el.type === 'email' || /email|mail|メール/i.test(attrs)) hasEmailField = true;
        formFieldCount++;
      }

      return formFieldCount >= 3 || (formFieldCount >= 2 && hasEmailField) || (hasTextarea && formFieldCount >= 1);
    });
  } catch { return false; }
}

// ===================== FORM ANALYSIS (in-page) =====================

// This runs inside the browser page context
const ANALYZE_FORM_SCRIPT = function() {
  try {
  // Polyfill CSS.escape if not available (some iframe contexts)
  if (typeof CSS === 'undefined' || !CSS.escape) {
    if (typeof window !== 'undefined') {
      window.CSS = window.CSS || {};
      window.CSS.escape = window.CSS.escape || function(s) { return s.replace(/([^\w-])/g, '\\$1'); };
    }
  }
  const cssEscape = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape : function(s) { return s.replace(/([^\w-])/g, '\\$1'); };

  const result = { fields: [], selects: [], checkboxes: [], radios: [], submitBtn: null, formAction: null };

  // ---- Helper: get label text for a field ----
  function getLabelFor(el) {
    // 1. <label for="id">
    if (el.id) {
      const label = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (label) return label.textContent.trim();
    }
    // 2. Parent <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Get text excluding child input text
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach(c => c.remove());
      return clone.textContent.trim();
    }
    // 3. Preceding sibling
    const prev = el.previousElementSibling;
    if (prev) {
      const tag = prev.tagName;
      if (tag === 'LABEL' || tag === 'SPAN' || tag === 'P' || tag === 'DIV' || tag === 'DT') {
        return prev.textContent.trim();
      }
    }
    // 4. Parent container context (table/dl/div layouts)
    const wrapper = el.closest('td, dd, .form-group, .form-item, .form-field, .field, [class*="form"], [class*="input"]');
    if (wrapper) {
      // Look at previous sibling of wrapper
      const prevW = wrapper.previousElementSibling;
      if (prevW) return prevW.textContent.trim().slice(0, 80);
      // Look at parent's heading/label child before this one
      const parent = wrapper.parentElement;
      if (parent) {
        const children = Array.from(parent.children);
        const idx = children.indexOf(wrapper);
        if (idx > 0) return children[idx - 1].textContent.trim().slice(0, 80);
      }
    }
    // 5. aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    // 6. Closest heading
    const section = el.closest('section, fieldset, .section');
    if (section) {
      const heading = section.querySelector('h1, h2, h3, h4, legend');
      if (heading) return heading.textContent.trim();
    }
    return '';
  }

  // ---- Helper: unique selector ----
  function buildSelector(el) {
    if (el.id) return '#' + cssEscape(el.id);
    if (el.name && el.tagName) {
      const tag = el.tagName.toLowerCase();
      const candidates = document.querySelectorAll(tag + '[name="' + cssEscape(el.name) + '"]');
      if (candidates.length === 1) return tag + '[name="' + cssEscape(el.name) + '"]';
      // Add type to disambiguate
      if (el.type && candidates.length > 1) {
        const withType = document.querySelectorAll(tag + '[name="' + cssEscape(el.name) + '"][type="' + el.type + '"]');
        if (withType.length === 1) return tag + '[name="' + cssEscape(el.name) + '"][type="' + el.type + '"]';
      }
    }
    // Path-based selector
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          sel += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ---- Helper: is element visible ----
  // In iframes (HubSpot etc.), offsetParent and getBoundingClientRect may return 0
  // so we use a more lenient check
  function isVisible(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      // In cross-origin iframes, offsetParent can be null even for visible elements
      // Skip the strict size check if we're in an iframe
      const inIframe = window !== window.top;
      if (!inIframe) {
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) return false;
      }
      return true;
    } catch { return true; } // If we can't check, assume visible
  }

  // ---- Collect all form elements ----
  // Prefer elements inside <form>, fallback to whole page
  let scope = document.querySelector('form');
  if (!scope) {
    // Try to find the main content area with inputs
    const allForms = document.querySelectorAll('form');
    for (const f of allForms) {
      if (f.querySelectorAll('input, textarea').length >= 2) { scope = f; break; }
    }
  }
  if (!scope) scope = document.body;

  // Record form action if available
  if (scope.tagName === 'FORM') {
    result.formAction = scope.action || null;
  }

  // Inputs
  scope.querySelectorAll('input').forEach(el => {
    if (!isVisible(el)) return;
    const type = (el.type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) return;

    if (type === 'checkbox') {
      result.checkboxes.push({
        selector: buildSelector(el), name: el.name || '', id: el.id || '',
        label: getLabelFor(el), value: el.value || '', checked: el.checked,
      });
    } else if (type === 'radio') {
      result.radios.push({
        selector: buildSelector(el), name: el.name || '', id: el.id || '',
        label: getLabelFor(el), value: el.value || '', checked: el.checked,
      });
    } else {
      result.fields.push({
        tag: 'input', type, selector: buildSelector(el),
        name: el.name || '', id: el.id || '', placeholder: el.placeholder || '',
        label: getLabelFor(el), required: el.required,
        autocomplete: el.getAttribute('autocomplete') || '',
      });
    }
  });

  // Textareas
  scope.querySelectorAll('textarea').forEach(el => {
    if (!isVisible(el)) return;
    result.textareas.push({
      tag: 'textarea', selector: buildSelector(el),
      name: el.name || '', id: el.id || '', placeholder: el.placeholder || '',
      label: getLabelFor(el), required: el.required,
    });
  });

  // Selects
  scope.querySelectorAll('select').forEach(el => {
    if (!isVisible(el)) return;
    const options = Array.from(el.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
    result.selects.push({
      tag: 'select', selector: buildSelector(el),
      name: el.name || '', id: el.id || '', label: getLabelFor(el),
      options, required: el.required,
    });
  });

  // Submit button (within the form scope)
  const submitCandidates = [
    ...scope.querySelectorAll('input[type="submit"]'),
    ...scope.querySelectorAll('button[type="submit"]'),
    ...scope.querySelectorAll('button:not([type])'),
    ...scope.querySelectorAll('a[class*="submit"], a[class*="btn"]'),
  ];
  // Filter to find the real submit button
  for (const btn of submitCandidates) {
    if (!isVisible(btn)) continue;
    const text = (btn.textContent || btn.value || '').trim();
    if (/送信|確認|submit|send|confirm|入力内容|次へ|進む/i.test(text) || btn.type === 'submit') {
      result.submitBtn = buildSelector(btn);
      break;
    }
  }
  // Fallback: any visible submit-like button
  if (!result.submitBtn) {
    for (const btn of submitCandidates) {
      if (isVisible(btn)) { result.submitBtn = buildSelector(btn); break; }
    }
  }

  return result;
  } catch(e) { return { fields: [], selects: [], checkboxes: [], radios: [], submitBtn: null, formAction: null, error: e.message }; }
};

// ===================== FIELD MAPPING =====================

// Map analysis results to the data we want to fill
function mapFieldsToData(analysis, data) {
  const allFields = [...analysis.fields, ...analysis.textareas];
  const mappings = [];
  const usedTypes = new Set();

  // Define field type detection rules
  const rules = [
    {
      type: 'email',
      match: (f) => f.type === 'email' || /mail|email|e[-_]?mail|メール|アドレス/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label + ' ' + f.autocomplete),
      value: () => data.senderEmail,
    },
    {
      type: 'phone',
      match: (f) => f.type === 'tel' || /電話|tel|phone|携帯|連絡先/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label + ' ' + f.autocomplete),
      value: () => data.senderPhone,
    },
    {
      type: 'company',
      match: (f) => /会社|企業|法人|組織|corp|company|organization|org[-_]?name|貴社|御社/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => data.senderCompany,
    },
    {
      type: 'department',
      match: (f) => /部署|部門|所属|department|division|役職/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => data.senderDepartment,
    },
    {
      type: 'lastName',
      match: (f) => /姓|last[-_]?name|family[-_]?name|sei$|苗字/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => {
        if (!data.senderName) return '';
        const parts = data.senderName.split(/[\s　]+/);
        return parts[0]; // 姓 = 最初の部分
      },
    },
    {
      type: 'firstName',
      match: (f) => {
        const txt = f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label;
        return /first[-_]?name|given[-_]?name|mei$/i.test(txt) || (/^名$/i.test(f.label.trim()) && !/名前|氏名/.test(f.label));
      },
      value: () => {
        if (!data.senderName) return '';
        const parts = data.senderName.split(/[\s　]+/);
        return parts.length > 1 ? parts.slice(1).join(' ') : ''; // 名 = 2番目以降、なければ空
      },
    },
    {
      type: 'name',
      match: (f) => /氏名|お名前|名前|^name$|full[-_]?name|your[-_]?name|担当|ご担当/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => data.senderName,
    },
    {
      type: 'subject',
      match: (f) => /件名|題名|タイトル|subject|title/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => data.subject,
    },
    {
      type: 'url',
      match: (f) => f.type === 'url' || /url|ホームページ|サイト|website|web[-_]?site/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => '', // skip
    },
    {
      type: 'body',
      match: (f) => f.tag === 'textarea' || /本文|内容|メッセージ|お問い?合わせ内容|message|body|content|inquiry|comment|備考|詳細|ご用件|ご質問/i.test(f.name + ' ' + f.id + ' ' + f.placeholder + ' ' + f.label),
      value: () => data.body,
    },
  ];

  // First pass: match each field to a type
  for (const field of allFields) {
    for (const rule of rules) {
      if (usedTypes.has(rule.type) && !['lastName', 'firstName'].includes(rule.type)) continue;
      if (rule.match(field)) {
        const val = rule.value();
        if (val) {
          mappings.push({ selector: field.selector, value: val, fieldType: rule.type, tag: field.tag });
          usedTypes.add(rule.type);
        }
        break;
      }
    }
  }

  // If we found lastName but not firstName (or vice versa), and there's a name field, skip
  // If we have no body mapped and there's a textarea, use it for body
  if (!usedTypes.has('body')) {
    const textarea = allFields.find(f => f.tag === 'textarea' && !mappings.some(m => m.selector === f.selector));
    if (textarea && data.body) {
      mappings.push({ selector: textarea.selector, value: data.body, fieldType: 'body', tag: 'textarea' });
    }
  }

  return mappings;
}

// Find the best iframe that contains the form using ElementHandle approach
async function findFormFrame(page) {
  // Get all iframe elements on the page
  const iframeElements = await page.$$('iframe');
  let bestFrame = null;
  let bestScore = 0;

  for (const iframeEl of iframeElements) {
    try {
      const frame = await iframeEl.contentFrame();
      if (!frame) continue;

      // Score this frame
      const score = await frame.evaluate(() => {
        try {
          let s = 0;
          s += document.querySelectorAll('input:not([type="hidden"])').length;
          s += document.querySelectorAll('textarea').length * 5;
          s += document.querySelectorAll('select').length * 2;
          return s;
        } catch { return 0; }
      }).catch(() => 0);

      if (score > 0) {
        console.log(`  [iframe選定] score=${score} url=${frame.url().slice(0, 80)}`);
      }
      if (score > bestScore) {
        bestScore = score;
        bestFrame = frame;
      }
    } catch {}
  }
  return bestFrame;
}

// ===================== FORM FILLING =====================

async function fillAndSubmit(page, data, options = {}) {
  const { dryRun = false, formLocation = 'main' } = options;

  // Determine the context (main page or iframe)
  let context = page;
  if (formLocation === 'iframe') {
    console.log('  [解析] iframe内のフォームを操作します');
    // Wait for iframes to fully load
    await new Promise(r => setTimeout(r, 2000));
    const formFrame = await findFormFrame(page);
    if (formFrame) {
      context = formFrame;
      // Wait for frame to be ready
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.log('  [解析] iframe取得失敗、メインページで試行');
    }
  }

  // Analyze the form using simple, reliable evaluation
  console.log('  [解析] フォーム要素を解析中...');
  let analysis = { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null };

  try {
    analysis = await context.evaluate(() => {
      try {
        const r = { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null };
        const inputs = document.querySelectorAll('input:not([type="hidden"])');
        for (let i = 0; i < inputs.length; i++) {
          const el = inputs[i];
          const type = (el.type || 'text').toLowerCase();
          if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset' || type === 'file') continue;
          const selector = el.id ? ('#' + el.id) : (el.name ? ('input[name="' + el.name + '"]') : ('input:nth-of-type(' + (i+1) + ')'));
          const label = el.labels && el.labels.length > 0 ? el.labels[0].textContent.trim() : '';
          if (type === 'checkbox') {
            r.checkboxes.push({ selector: selector, name: el.name||'', id: el.id||'', label: label, value: el.value||'', checked: el.checked });
          } else if (type === 'radio') {
            r.radios.push({ selector: selector, name: el.name||'', id: el.id||'', label: label, value: el.value||'', checked: el.checked });
          } else {
            r.fields.push({ tag:'input', type:type, selector:selector, name: el.name||'', id: el.id||'', placeholder: el.placeholder||'', label: label, required: el.required, autocomplete: el.getAttribute('autocomplete')||'' });
          }
        }
        const tas = document.querySelectorAll('textarea');
        for (let i = 0; i < tas.length; i++) {
          const el = tas[i];
          const selector = el.id ? ('#' + el.id) : (el.name ? ('textarea[name="' + el.name + '"]') : ('textarea:nth-of-type(' + (i+1) + ')'));
          const label = el.labels && el.labels.length > 0 ? el.labels[0].textContent.trim() : '';
          r.textareas.push({ tag:'textarea', selector:selector, name: el.name||'', id: el.id||'', placeholder: el.placeholder||'', label: label, required: el.required });
        }
        const sels = document.querySelectorAll('select');
        for (let i = 0; i < sels.length; i++) {
          const el = sels[i];
          const selector = el.id ? ('#' + el.id) : (el.name ? ('select[name="' + el.name + '"]') : ('select:nth-of-type(' + (i+1) + ')'));
          const opts = [];
          for (let j = 0; j < el.options.length; j++) { opts.push({ value: el.options[j].value, text: el.options[j].textContent.trim() }); }
          r.selects.push({ tag:'select', selector:selector, name: el.name||'', id: el.id||'', label: '', options: opts, required: el.required });
        }
        const btn = document.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        if (btn) r.submitBtn = btn.id ? ('#' + btn.id) : 'button[type="submit"]';
        return r;
      } catch(e) { return { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null, error: e.message }; }
    });
  } catch (evalErr) {
    console.log(`  [解析] evaluate失敗: ${evalErr.message}`);
  }

  if (!analysis || !analysis.fields) {
    analysis = { fields: [], selects: [], checkboxes: [], radios: [], textareas: [], submitBtn: null };
  }

  // Ensure all arrays exist
  analysis.fields = analysis.fields || [];
  analysis.textareas = analysis.textareas || [];
  analysis.selects = analysis.selects || [];
  analysis.checkboxes = analysis.checkboxes || [];
  analysis.radios = analysis.radios || [];

  if (analysis.error) {
    console.log(`  [解析] スクリプトエラー: ${analysis.error}`);
  }
  console.log(`  [解析] fields=${analysis.fields.length}, textareas=${analysis.textareas.length}, selects=${analysis.selects.length}, checkboxes=${analysis.checkboxes.length}, submit=${!!analysis.submitBtn}`);

  // Log detected fields for debugging
  for (const f of [...analysis.fields, ...analysis.textareas]) {
    console.log(`    フィールド: name="${f.name}" id="${f.id}" label="${f.label}" placeholder="${f.placeholder}" type="${f.type || f.tag}"`);
  }

  // Log the data being sent
  console.log(`  [送信データ] name="${data.senderName}" company="${data.senderCompany}" email="${data.senderEmail}" phone="${data.senderPhone}" body="${(data.body||'').slice(0,30)}..."`);

  // Map fields to data
  const mappings = mapFieldsToData(analysis, data);
  console.log(`  [マッピング] ${mappings.length}件のフィールドをマッチ`);
  for (const m of mappings) {
    console.log(`    ${m.fieldType}: "${m.value.slice(0, 30)}..." -> ${m.selector}`);
  }

  if (mappings.length === 0) {
    return {
      success: false,
      message: 'フォームのフィールドにマッチするデータがありませんでした。',
      analysis: {
        fields: analysis.fields.map(f => ({ name: f.name, id: f.id, label: f.label, placeholder: f.placeholder })),
        textareas: analysis.textareas.map(f => ({ name: f.name, id: f.id, label: f.label })),
      },
    };
  }

  // Fill in each mapped field
  const fillResults = [];
  for (const m of mappings) {
    try {
      console.log(`  [入力] ${m.fieldType}: ${m.selector.slice(0, 60)}`);

      // Use evaluate to fill directly (more reliable for iframes)
      const filled = await context.evaluate((sel, value) => {
        // Handle ID selectors that start with a digit
        let el;
        if (sel.startsWith('#')) {
          el = document.getElementById(sel.slice(1));
        } else {
          try { el = document.querySelector(sel); } catch { el = null; }
        }
        if (!el) return false;

        // Focus
        el.focus();
        el.click();

        // Use the correct native setter based on element type
        try {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(el, value);
          } else {
            el.value = value;
          }
        } catch {
          el.value = value;
        }

        // Fire events for React/Vue/etc
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));

        return true;
      }, m.selector, m.value);

      if (filled) {
        fillResults.push({ fieldType: m.fieldType, filled: true });
        console.log(`  [入力] ${m.fieldType}: OK`);
      } else {
        fillResults.push({ fieldType: m.fieldType, filled: false, error: 'Element not found' });
        console.log(`  [入力] ${m.fieldType}: 要素が見つかりません`);
      }
    } catch (err) {
      console.log(`  [入力エラー] ${m.fieldType}: ${err.message}`);
      fillResults.push({ fieldType: m.fieldType, filled: false, error: err.message });
    }
  }

  // Helper to query element by selector (handles numeric IDs)
  async function queryEl(ctx, sel) {
    return await ctx.evaluate((s) => {
      if (s.startsWith('#')) return !!document.getElementById(s.slice(1));
      try { return !!document.querySelector(s); } catch { return false; }
    }, sel);
  }

  // Handle select dropdowns
  for (const sel of analysis.selects) {
    const categoryPatterns = [/問い合わせ/, /お問い合わせ/, /その他/, /ご相談/, /サービス/, /提携/, /協業/];
    const matchingOption = sel.options.find(o => categoryPatterns.some(p => p.test(o.text)));
    if (matchingOption && matchingOption.value) {
      try {
        await context.evaluate((s, val) => {
          const el = s.startsWith('#') ? document.getElementById(s.slice(1)) : document.querySelector(s);
          if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }, sel.selector, matchingOption.value);
        console.log(`  [select] ${sel.label || sel.name} -> "${matchingOption.text}"`);
      } catch {}
    }
  }

  // Handle checkboxes (privacy agreement etc.)
  for (const cb of analysis.checkboxes) {
    const text = [cb.name, cb.id, cb.label, cb.value].join(' ');
    if (/同意|承諾|プライバシー|個人情報|agree|privacy|consent|規約|承認|確認/i.test(text)) {
      if (!cb.checked) {
        try {
          await context.evaluate((sel) => {
            const el = sel.startsWith('#') ? document.getElementById(sel.slice(1)) : document.querySelector(sel);
            if (el) el.click();
          }, cb.selector);
          console.log(`  [checkbox] "${cb.label.slice(0, 30)}" をチェック`);
        } catch {}
      }
    }
  }

  // Take screenshot after filling (always from main page for full view)
  let screenshot = '';
  try { screenshot = await page.screenshot({ encoding: 'base64', fullPage: false }); } catch {}

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      fillResults,
      screenshot: screenshot ? `data:image/png;base64,${screenshot}` : '',
      formUrl: page.url(),
      message: 'フォーム入力のプレビューです',
    };
  }

  // Submit
  if (analysis.submitBtn) {
    console.log(`  [送信] ボタンをクリック: ${analysis.submitBtn}`);
    try {
      await context.evaluate((sel) => {
        const btn = sel.startsWith('#') ? document.getElementById(sel.slice(1)) : document.querySelector(sel);
        if (btn) btn.click();
      }, analysis.submitBtn);
      // Wait for response
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.log(`  [送信] クリックエラー: ${err.message}`);
    }
  } else {
    console.log('  [送信] submitボタン未検出、form.submit()を試行');
    try {
      await context.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.submit();
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    } catch {}
  }

  // Take post-submit screenshot
  await new Promise(r => setTimeout(r, 1000));
  let postScreenshot = '';
  try { postScreenshot = await page.screenshot({ encoding: 'base64', fullPage: false }); } catch {}

  return {
    success: true,
    fillResults,
    screenshot: postScreenshot ? `data:image/png;base64,${postScreenshot}` : '',
    formUrl: page.url(),
    message: '送信が完了しました',
  };
}

// ===================== API ENDPOINTS =====================

app.post('/api/send', async (req, res) => {
  const { url, data, dryRun } = req.body;
  if (!url || !data) return res.status(400).json({ error: 'URL and data are required' });

  let browser, page;
  try {
    browser = await createBrowser();
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.9' });

    console.log(`\n[開始] ${url} (dryRun=${!!dryRun})`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Find the form page
    const formSearch = await findFormPage(page, url);
    console.log(`[探索結果] found=${formSearch.found}, method=${formSearch.method}, url=${formSearch.url}`);

    if (!formSearch.found) {
      await page.close();
      return res.json({
        success: false,
        message: 'お問い合わせフォームが見つかりませんでした。フォームページのURLを直接指定してください。',
      });
    }

    // Check for anti-spam
    const pageText = await page.evaluate(() => document.body.innerText);
    const blocked = BLOCK_PATTERNS.some(p => p.test(pageText));
    if (blocked) {
      await page.close();
      return res.json({ success: false, blocked: true, message: '営業お断りの記載を検出しました。送信を中止します。' });
    }

    // Fill and optionally submit
    const result = await fillAndSubmit(page, data, { dryRun: !!dryRun, formLocation: formSearch.found });
    result.formFoundBy = formSearch.method;
    if (!result.formUrl) result.formUrl = formSearch.url;

    try { await browser.close(); } catch {}
    res.json(result);
  } catch (err) {
    console.error(`[エラー] ${err.message}`);
    if (browser) try { await browser.close(); } catch {}

    // Return user-friendly error instead of 500
    let message = 'エラーが発生しました: ' + err.message;
    if (/ERR_NAME_NOT_RESOLVED/.test(err.message)) {
      message = 'URLが見つかりません。URLを確認してください。';
    } else if (/ERR_CONNECTION_REFUSED/.test(err.message)) {
      message = 'サーバーに接続できません。URLを確認してください。';
    } else if (/timeout/i.test(err.message)) {
      message = 'ページの読み込みがタイムアウトしました。URLを確認してください。';
    } else if (/ERR_CERT/.test(err.message) || /SSL/.test(err.message)) {
      message = 'SSL証明書のエラーが発生しました。URLを確認してください。';
    }
    res.json({ success: false, message });
  }
});

// ===================== START SERVER =====================
const PORT = 3456;
app.listen(PORT, () => {
  console.log(`\n  One 2 One Server running at http://localhost:${PORT}\n`);
});

// Prevent process from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[未処理エラー]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[未処理Promise]', err?.message || err);
});

// Cleanup on exit
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
