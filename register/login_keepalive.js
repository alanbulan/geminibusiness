const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs'); // 保留传统的fs模块用于同步操作
const fsPromises = require('fs/promises'); // 使用Promise版本的fs模块用于异步操作
const path = require('path');

const DEFAULT_MOEMAIL_BASE_URL = process.env.MOEMAIL_BASE_URL || 'https://111.alanbulan.space';
const DEFAULT_MOEMAIL_API_KEY = 'mk_4Pq6uyO5dDFF92fk6Hxs1qw0LWJls8wD';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    headless: false,
    threads: 1,
    continuous: false,
    dataDir: null,
    intervalSeconds: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--headless':
      case '-h':
        config.headless = true;
        break;
      case '--threads':
      case '-t':
        config.threads = parseInt(args[++i]) || 1;
        break;
      case '--continuous':
      case '-c':
        config.continuous = true;
        break;
      case '--data-dir':
      case '-d':
        config.dataDir = args[++i];
        break;
      case '--interval-seconds':
      case '-i':
        config.intervalSeconds = parseInt(args[++i]) || 0;
        break;
      case '--help':
        console.log(`\n用法: node register/login_keepalive.js [选项]\n\n选项:\n  --headless, -h       无头模式运行\n  --threads, -t <n>    线程数 (默认: 1)\n  --continuous, -c     持续运行模式\n  --data-dir, -d <dir> 数据保存目录\n  --help               显示帮助\n`);
        process.exit(0);
    }
  }

  return config;
}

function ensureDataDir(customDir = null) {
  const dataDir = customDir || path.join(__dirname, 'data');
  try {
    fs.accessSync(dataDir);
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

async function loadAccounts(dataDir = './data') {
    // 从 data 目录加载账号文件
    const accountFiles = fs.readdirSync(dataDir)
        .filter(file => file.endsWith('.json') && !file.endsWith('.login.json'))
        .sort((a, b) => fs.statSync(path.join(dataDir, b)).mtime - fs.statSync(path.join(dataDir, a)).mtime);
    
    const accounts = [];
    const emailSet = new Set(); // 用于去重，确保每个邮箱只加载一次
    
    for (const file of accountFiles) {
        try {
            const accountData = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
            // 验证必要的字段
            if (accountData.email && (accountData.emailId || accountData.profile_id)) {
                const email = accountData.email.toLowerCase();
                if (!emailSet.has(email)) {
                    emailSet.add(email);
                    console.log(`从 ${file} 加载账号: ${accountData.email}`);
                    accounts.push({...accountData, accountSource: 'data'});
                } else {
                    console.log(`跳过重复账号: ${accountData.email} (${file})`);
                }
            } else {
                console.warn(`账号文件 ${file} 缺少必要的字段 (email 和 emailId/profile_id)`);
            }
        } catch (error) {
            console.warn(`加载账号文件 ${file} 失败:`, error.message);
        }
    }
    
    console.log(`从 data 目录成功加载 ${accounts.length} 个去重后的账号`);
    return accounts;
}

async function getMailboxForAccount(account, threadId, config) {
  const email = account.email;
  if (!email) {
    throw new Error('账号缺少 email 字段');
  }
  const [name, domain] = email.split('@');
  if (!name || !domain) {
    throw new Error(`无效邮箱地址: ${email}`);
  }

  const baseUrl = account.moemailBaseUrl || config.moemailBaseUrl || DEFAULT_MOEMAIL_BASE_URL;
  const apiKey = account.moemailApiKey || process.env.MOEMAIL_API_KEY || DEFAULT_MOEMAIL_API_KEY;
  if (!apiKey) {
    throw new Error('MoeMail API Key 未配置，请设置环境变量 MOEMAIL_API_KEY 或在导入 JSON 中提供 moemailApiKey');
  }

  // 如果账号已有emailId，优先使用已保存的会话
  if (account.emailId) {
    console.log(`[线程 ${threadId}] 使用已保存的邮箱会话: ${email} (id=${account.emailId})`);
    try {
      // 验证emailId是否仍然有效
      const testResp = await axios.get(`${baseUrl}/api/emails/${account.emailId}`, {
        headers: { 'X-API-Key': apiKey }
      });
      
      if (testResp.data && testResp.data.email === email) {
        console.log(`[线程 ${threadId}] 验证邮箱会话有效，继续使用`);
        return {
          email: testResp.data.email,
          emailId: account.emailId,
          baseUrl,
          apiKey
        };
      }
    } catch (error) {
      console.log(`[线程 ${threadId}] 现有邮箱会话无效，将生成新的:`, error.response?.status);
    }
  }

  console.log(`[线程 ${threadId}] 为登录保活生成新邮箱会话: ${email}`);     
  let response;
  try {
    response = await axios.post(
      `${baseUrl}/api/emails/generate`,
      {
        name,
        expiryTime: 3600000, // 1小时有效期
        domain,
      },
      {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
      },
    );
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      console.error(
        `[线程 ${threadId}] 生成邮箱会话失败: status=${status}, data=${JSON.stringify(data)}`,
      );
      if (status === 409) {
        // 邮箱已存在，尝试复用已有邮箱
        if (data && data.id) {
          console.log(
            `[线程 ${threadId}] MoeMail 返回 409，复用已有邮箱会话 id=${data.id}`,
          );
          response = { data };
        } else {
          console.log(
            `[线程 ${threadId}] MoeMail 提示邮箱已存在，尝试从列表查找已有邮箱: ${email}`,
          );
          let cursor = null;
          for (let page = 0; page < 50 && !response; page++) {
            const url = cursor
              ? `${baseUrl}/api/emails?cursor=${encodeURIComponent(cursor)}`
              : `${baseUrl}/api/emails`;
            const listResp = await axios.get(url, {
              headers: {
                'X-API-Key': apiKey,
              },
            });
            const emails = listResp.data.emails || [];
            const found = emails.find((e) => {
              const addr = (e.address || e.email || '').toLowerCase();
              return addr === email.toLowerCase();
            });
            if (found && found.id) {
              console.log(
                `[线程 ${threadId}] 在列表中找到已有邮箱: id=${found.id}, address=${found.address || found.email}`,
              );
              response = { data: { id: found.id, email: found.address || found.email } };
              break;
            }
            cursor = listResp.data.nextCursor;
            if (!cursor) break;
          }
          if (!response) {
            throw new Error(`MoeMail 邮箱已存在但在列表中未找到: ${email}`);
          }
        }
      } else {
        throw error;
      }
    } else {
      console.error(`[线程 ${threadId}] 生成邮箱会话失败:`, error.message || error);
      throw error;
    }
  }

  const emailId = response.data.id;
  if (!emailId) {
    throw new Error('MoeMail 返回的数据不完整，缺少 id');
  }

  return { email, emailId, baseUrl, apiKey };
}

async function getEmailContent(emailInfo, threadId, maxRetries = 20, afterMessageId = null) {
  const { email, emailId, baseUrl, apiKey } = emailInfo;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const listResp = await axios.get(`${baseUrl}/api/emails/${emailId}`, {
        headers: {
          'X-API-Key': apiKey,
        },
      });

      const messages = listResp.data.messages || [];
      if (messages.length > 0) {
        const message = messages[0];
        const messageId = message.id;
        
        // 如果指定了 afterMessageId，则必须是更新的邮件
        if (afterMessageId && messageId === afterMessageId) {
           // 虽然获取到了邮件列表，但不是最新的，视为暂未获取到
           throw new Error(`等待新邮件 (最新ID仍为 ${messageId})`);
        }

        if (!messageId) {
          throw new Error('MoeMail 消息缺少 id');
        }

        const msgResp = await axios.get(`${baseUrl}/api/emails/${emailId}/${messageId}`, {
          headers: {
            'X-API-Key': apiKey,
          },
        });

        const detail = msgResp.data.message || msgResp.data;
        return {
          subject: detail.subject || '',
          content: detail.content || detail.html || '',
        };
      }
    } catch (error) {
      console.log(`[线程 ${threadId}] 拉取验证码尝试 ${i + 1}/${maxRetries} 失败:`, error.message);
    }

    console.log(`[线程 ${threadId}] 等待 5 秒后重试拉取验证码... (${i + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(() => resolve(), 5000));
  }

  throw new Error(`无法获取 ${email} 的验证码邮件`);
}

function extractVerificationCode(emailContent, threadId) {
  const content = emailContent.content || '';
  const subject = emailContent.subject || '';
  console.log(`[DEBUG] 邮件主题: ${subject}`);
  console.log(`[DEBUG] 邮件内容预览: ${content.substring(0, 500).replace(/\n/g, ' ')}`);
  const commonWords = ['VERIFY', 'GOOGLE', 'UPDATE', 'MOBILE', 'DEVICE', 'SUBMIT', 'RESEND', 'CANCEL', 'DELETE', 'REMOVE', 'SEARCH', 'VIDEOS', 'IMAGES', 'GMAIL', 'EMAIL', 'ACCOUNT', 'CHROME'];

  // 优先匹配纯数字验证码 (Google 标准)
  const digitMatches = content.match(/\b\d{6}\b/g);
  if (digitMatches) {
    console.log(`[线程 ${threadId}] 找到纯数字验证码候选: ${digitMatches.join(', ')}`);
    return digitMatches[0];
  }

  // 备选：匹配 G-xxxxxx 格式（有时 Google 会发这种）
  const gMatches = content.match(/G-(\d{6})/g);
  if (gMatches) {
     console.log(`[线程 ${threadId}] 找到 G-验证码: ${gMatches[0]}`);
     return gMatches[0].replace('G-', '');
  }

  // 原有逻辑作为最后兜底，但必须包含数字
  const matches = content.match(/\b[A-Z0-9]{6}\b/g);
  if (matches) {
    const withDigits = matches.find(code => !commonWords.includes(code) && /[0-9]/.test(code));
    if (withDigits) {
      console.log(`[线程 ${threadId}] 选择包含数字的验证码: ${withDigits}`);
      return withDigits;
    }
    // 删除纯字母的兜底，避免误判
  }

  const contextMatch = content.match(/code\s*[:is]\s*([A-Z0-9]{6})/i);
  if (contextMatch) {
    console.log(`[线程 ${threadId}] 通过上下文找到验证码: ${contextMatch[1]}`);
    return contextMatch[1];
  }

  const verifyMatch = content.match(/verification\s*code\s*[:is]*\s*([A-Z0-9]{6})/i);
  if (verifyMatch) {
    console.log(`[线程 ${threadId}] 通过verification找到验证码: ${verifyMatch[1]}`);
    return verifyMatch[1];
  }

  const htmlMatch = content.match(/>\s*([A-Z0-9]{6})\s*</g);
  if (htmlMatch && htmlMatch.length > 0) {
    const code = htmlMatch[0].replace(/[><\s]/g, '');
    if (!commonWords.includes(code) && /[0-9]/.test(code)) {
      console.log(`[线程 ${threadId}] 从HTML标签找到验证码: ${code}`);
      return code;
    }
  }

  console.error(`[线程 ${threadId}] 无法提取验证码，邮件内容: ${content.substring(0, 500)}`);
  throw new Error(`无法从邮件中提取验证码。邮件主题: ${subject}`);
}

async function loginAndRefresh(threadId, config, account) {
  let browser;
  console.log(`[线程 ${threadId}] 开始登录保活: ${account.email}`);

  try {
    const emailInfo = await getMailboxForAccount(account, threadId, config);

    // 获取当前最新的邮件 ID，防止读取到旧验证码
    let lastMessageId = null;
    try {
      const listResp = await axios.get(`${emailInfo.baseUrl}/api/emails/${emailInfo.emailId}`, {
        headers: { 'X-API-Key': emailInfo.apiKey }
      });
      if (listResp.data.messages && listResp.data.messages.length > 0) {
        lastMessageId = listResp.data.messages[0].id;
        console.log(`[线程 ${threadId}] 当前最新邮件ID: ${lastMessageId} (将在登录后等待新ID)`);
      }
    } catch (e) { 
      console.log(`[线程 ${threadId}] 获取初始邮件列表失败(可能为空，不影响): ${e.message}`); 
    }

    console.log(`[线程 ${threadId}] 启动浏览器...`);
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : undefined);

    browser = await puppeteer.launch({
      headless: config.headless === true ? 'new' : config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--incognito'],
      executablePath,
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0');

    const authData = {
      authorization: null,
      cookies: null,
      configId: null,
      csesidx: null,
    };

    page.on('request', (request) => {
      const headers = request.headers();
      if (headers['authorization']) {
        authData.authorization = headers['authorization'];
      }
    });

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const cidMatch = url.match(/\/cid\/([a-f0-9-]+)/i);
        if (cidMatch && !authData.configId) {
          authData.configId = cidMatch[1];
          console.log(`[线程 ${threadId}] 从响应提取 configId: ${authData.configId}`);
        }
        const csesidxMatch = url.match(/[?&]csesidx=(\d+)/);
        if (csesidxMatch && !authData.csesidx) {
          authData.csesidx = csesidxMatch[1];
          console.log(`[线程 ${threadId}] 从响应提取 csesidx: ${authData.csesidx}`);
        }
      } catch (e) {
      }
    });

    page.on('framenavigated', async (frame) => {
      if (frame === page.mainFrame()) {
        const url = frame.url();
        const cidMatch = url.match(/\/cid\/([a-f0-9-]+)/i);
        if (cidMatch && !authData.configId) {
          authData.configId = cidMatch[1];
          console.log(`[线程 ${threadId}] 从URL提取 configId: ${authData.configId}`);
        }
        const csesidxMatch = url.match(/[?&]csesidx=(\d+)/);
        if (csesidxMatch && !authData.csesidx) {
          authData.csesidx = csesidxMatch[1];
          console.log(`[线程 ${threadId}] 从URL提取 csesidx: ${authData.csesidx}`);
        }
      }
    });

    await page.goto('https://business.gemini.google', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await page.waitForSelector('input', { timeout: 30000 });
    await new Promise(r => setTimeout(() => r(), 2000));

    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      if (inputs.length > 0) {
        inputs[0].click();
        inputs[0].focus();
        try { inputs[0].value = ''; } catch (e) {}
      }
    });
    await new Promise(r => setTimeout(() => r(), 1000));

    await page.type('input', emailInfo.email, { delay: 100 });
    console.log(`[线程 ${threadId}] 已填写邮箱:`, emailInfo.email);

    await new Promise(r => setTimeout(() => r(), 2000));

    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      if (inputs.length > 0) {
        inputs[0].blur();
      }
    });
    await new Promise(r => setTimeout(() => r(), 1500));

    const clicked = await page.evaluate(() => {
      const targets = ['继续', '下一步', 'Next', 'Continue', 'Confirm', '同意', 'I agree', '登录', 'Sign in'];
      const elements = [
        ...document.querySelectorAll('button'),
        ...document.querySelectorAll('input[type="submit"]'),
        ...document.querySelectorAll('div[role="button"]'),
      ];
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (element.disabled) continue;
        const text = (element.textContent || '').trim();
        if (targets.some(t => text.includes(t))) {
          element.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      console.log(`[线程 ${threadId}] 点击了登录/继续按钮`);
    }

    console.log(`[线程 ${threadId}] 等待验证码邮件...`);
    const emailContent = await getEmailContent(emailInfo, threadId, 20, lastMessageId);
    const code = extractVerificationCode(emailContent, threadId);

    console.log(`[线程 ${threadId}] 准备填写验证码: ${code}`);
    await new Promise(r => setTimeout(() => r(), 5000));

    // 智能查找并聚焦输入框
    const inputFound = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const visibleInputs = inputs.filter(input => {
        const style = window.getComputedStyle(input);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !input.disabled && !input.readOnly;
      });

      // 优先匹配验证码特征
      let target = visibleInputs.find(input => 
        (input.name && input.name.toLowerCase().includes('code')) ||
        (input.id && input.id.toLowerCase().includes('code')) ||
        (input.getAttribute('aria-label') && (input.getAttribute('aria-label').includes('code') || input.getAttribute('aria-label').includes('验证码'))) ||
        input.type === 'tel'
      );

      // 兜底：如果有多个输入框且都可见，取第一个
      if (!target && visibleInputs.length > 0) target = visibleInputs[0];

      if (target) {
        target.click();
        target.focus();
        target.value = '';
        return true;
      }
      return false;
    });

    if (!inputFound) {
      console.log(`[线程 ${threadId}] ⚠️ 未找到合适的验证码输入框，尝试默认策略`);
    }

    await new Promise(resolve => setTimeout(() => resolve(), 500));

    // 使用 keyboard.type 输入到当前聚焦的元素，这比 page.type('input') 更可靠
    await page.keyboard.type(code, { delay: 200 });
    console.log(`[线程 ${threadId}] 已通过键盘模拟输入验证码`);

    await new Promise(r => setTimeout(() => r(), 1500));

    const clickedVerify = await page.evaluate(() => {
      const targets = ['验证', 'Verify', '继续', 'Next', 'Continue', '确认', 'Confirm'];
      const elements = [
        ...document.querySelectorAll('button'),
        ...document.querySelectorAll('input[type="submit"]'),
        ...document.querySelectorAll('div[role="button"]'),
      ];
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (element.disabled) continue;
        const text = (element.textContent || '').trim();
        if (targets.some(t => text.includes(t))) {
          element.click();
          return true;
        }
      }
      return false;
    });
    if (clickedVerify) {
      console.log(`[线程 ${threadId}] 点击了验证码确认按钮`);
    }

    await new Promise(r => setTimeout(() => r(), 4000));

    let retries = 0;
    while (!authData.authorization && retries < 10) {
      let clickedNext = false;
      try {
        clickedNext = await page.evaluate(() => {
          const targets = ['同意', 'Confirm', '继续', 'Next', 'I agree', 'Start'];
          const elements = [
            ...document.querySelectorAll('button'),
            ...document.querySelectorAll('input[type="submit"]'),
            ...document.querySelectorAll('div[role="button"]'),
          ];
          for (const element of elements) {
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            if (element.disabled) continue;
            const text = (element.textContent || '').trim();
            if (targets.some(t => text.includes(t))) {
              element.click();
              return true;
            }
          }
          return false;
        });
      } catch (err) {
        if (!String(err.message || '').includes('Execution context was destroyed')) {
          console.error(`[线程 ${threadId}] 检查额外按钮时出错:`, err.message);
        }
      }

      if (clickedNext) {
        console.log(`[线程 ${threadId}] 点击了额外的继续/同意按钮`);
      }

      await new Promise(r => setTimeout(() => r(), 3000));
      retries++;
    }

    if (!authData.authorization) {
      throw new Error('未能获取 Authorization，登录可能未完成');
    }

    const cookies = await page.cookies();
    authData.cookies = cookies;

    const secureCookie = cookies.find(c => c.name === '__Secure-C_SES');
    const hostCookie = cookies.find(c => c.name === '__Host-C_OSES');

    const dataDir = await ensureDataDir(config.dataDir);
    const safeEmail = emailInfo.email.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    
    // 生成保活文件路径
    const loginOutputFile = path.join(dataDir, `${safeEmail}.login.json`);
    const loginTxtFile = path.join(dataDir, `${safeEmail}.login.txt`);
    
    // 主注册文件路径（与 main.js 生成的文件名一致）
    const mainOutputFile = path.join(dataDir, `${emailInfo.email}.json`);
    const mainTxtFile = path.join(dataDir, `${emailInfo.email}.txt`);

    for (let attempt = 0; attempt < 5 && (!authData.configId || !authData.csesidx); attempt++) {
      await new Promise(resolve => setTimeout(() => resolve(), 2000));
      const currentUrl = page.url();
      console.log(`[线程 ${threadId}] 当前URL: ${currentUrl}`);

      if (!authData.configId) {
        const cidMatch = currentUrl.match(/\/cid\/([a-f0-9-]+)/i);
        if (cidMatch) {
          authData.configId = cidMatch[1];
          console.log(`[线程 ${threadId}] 从最终URL提取 configId: ${authData.configId}`);
        }
      }
      if (!authData.csesidx) {
        const csesidxMatch = currentUrl.match(/[?&]csesidx=(\d+)/);
        if (csesidxMatch) {
          authData.csesidx = csesidxMatch[1];
          console.log(`[线程 ${threadId}] 从最终URL提取 csesidx: ${authData.csesidx}`);
        }
      }
    }

    if (!authData.configId || !authData.csesidx) {
      console.log(`[线程 ${threadId}] ⚠️ 未能提取完整信息: configId=${authData.configId}, csesidx=${authData.csesidx}`);
    } else {
      console.log(`[线程 ${threadId}] ✓ 提取成功: configId=${authData.configId}, csesidx=${authData.csesidx}`);
    }

    // 生成要保存的数据
    const accountData = {
      email: emailInfo.email,
      emailId: emailInfo.emailId,
      authorization: authData.authorization,
      cookies: authData.cookies,
      configId: authData.configId,
      csesidx: authData.csesidx,
      timestamp: new Date().toISOString(),
    };
    
    // 保留原有的 fullName 字段（如果存在）
    let existingData = {};
    try {
      const mainFileContent = await fsPromises.readFile(mainOutputFile, 'utf8');
      existingData = JSON.parse(mainFileContent);
      if (existingData.fullName) {
        accountData.fullName = existingData.fullName;
      }
      console.log(`[线程 ${threadId}] 保留了原有注册文件的 fullName 字段`);
    } catch (error) {
      console.log(`[线程 ${threadId}] 读取主注册文件失败（可能是新账号）:`, error.message);
    }

    // 生成文本内容
    const lines = [];
    if (secureCookie && secureCookie.value) {
      lines.push(`SECURE_C_SES=${secureCookie.value}`);
      console.log(`SECURE_C_SES=${secureCookie.value}`);
    }
    if (authData.csesidx) {
      lines.push(`CSESIDX=${authData.csesidx}`);
      console.log(`CSESIDX=${authData.csesidx}`);
    }
    if (authData.configId) {
      lines.push(`CONFIG_ID=${authData.configId}`);
      console.log(`CONFIG_ID=${authData.configId}`);
    }
    if (hostCookie && hostCookie.value) {
      lines.push(`HOST_C_OSES=${hostCookie.value}`);
      console.log(`HOST_C_OSES=${hostCookie.value}`);
    }
    const txtContent = lines.join('\n') + (lines.length ? '\n' : '');

    // 1. 保存保活文件（原有功能保留）
    await fsPromises.writeFile(loginOutputFile, JSON.stringify(accountData, null, 2));
    await fsPromises.writeFile(loginTxtFile, txtContent, 'utf8');
    
    // 2. 更新主注册文件（新增功能：直接覆盖旧的注册文件）
    await fsPromises.writeFile(mainOutputFile, JSON.stringify(accountData, null, 2));
    await fsPromises.writeFile(mainTxtFile, txtContent, 'utf8');
    console.log(`[线程 ${threadId}] ✓ 已更新主注册文件: ${mainOutputFile}`);

    // 可选：直接回调网关 API，按账号映射到指定 profile
    const updateUrl = process.env.KEEPALIVE_UPDATE_URL;
    const profileId = account.profile_id || account.profileId;
    if (updateUrl && profileId && secureCookie && secureCookie.value && authData.csesidx && authData.configId) {
      try {
        await axios.post(updateUrl, {
          profile_id: profileId,
          secure_c_ses: secureCookie.value,
          host_c_oses: hostCookie ? hostCookie.value : null,
          csesidx: authData.csesidx,
          config_id: authData.configId,
          timeout: 15000
        });
        console.log(`[线程 ${threadId}] 已通过 API 自动更新配置 ${profileId}`);
      } catch (e) {
        console.error(`[线程 ${threadId}] 调用保活更新 API 失败:`, e.message || e);
      }
    }

    console.log(`[线程 ${threadId}] ✓ 登录保活完成并保存: ${emailInfo.email}`);
    console.log(`[线程 ${threadId}] ✓ 已更新主注册文件: ${emailInfo.email}.json 和 ${emailInfo.email}.txt`);
  } catch (err) {
    console.error(`[线程 ${threadId}] 登录保活发生错误:`, err.message || err);
  } finally {
    if (browser) {
      await new Promise(resolve => setTimeout(() => resolve(), 5000));
      await browser.close();
    }
  }
}

async function worker(threadId, config, accounts, shared) {
  console.log(`[线程 ${threadId}] 启动登录保活 Worker`);
  while (true) {
    let account;
    if (shared.index >= accounts.length) {
      if (config.continuous && accounts.length > 0) {
        if (config.intervalSeconds && config.intervalSeconds > 0) {
          console.log(`[线程 ${threadId}] 本轮登录保活结束，等待 ${config.intervalSeconds} 秒后开始下一轮...`);
          await new Promise(resolve => setTimeout(() => resolve(), config.intervalSeconds * 1000));
        }
        shared.index = 0;
      } else {
        console.log(`[线程 ${threadId}] 登录保活队列已空，退出 Worker`);
        break;
      }
    }
    account = accounts[shared.index++];
    if (!account) {
      break;
    }

    await loginAndRefresh(threadId, config, account);

    console.log(`[线程 ${threadId}] 准备下一个账号...`);
    await new Promise(resolve => setTimeout(() => resolve(), 2000));
  }
}

async function main() {
  const config = parseArgs();
  const dataDir = config.dataDir || path.join(__dirname, 'data');
  const accounts = await loadAccounts(dataDir);
  if (accounts.length === 0) {
    console.log('没有可用账号，登录保活结束');
    process.exit(0);
  }

  console.log(`登录保活配置: Headless=${config.headless}, Threads=${config.threads}, Continuous=${config.continuous}, DataDir=${config.dataDir || 'default'}`);
  console.log(`登录保活账号数量: ${accounts.length}`);

  const shared = { index: 0 };
  const workers = [];
  const threads = Math.max(1, config.threads || 1);

  for (let i = 0; i < threads; i++) {
    workers.push(worker(i + 1, config, accounts, shared));
  }

  await Promise.all(workers);
  console.log('所有登录保活任务完成');

  if (!config.continuous) {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('登录保活主程序异常:', err.message || err);
  process.exit(1);
});