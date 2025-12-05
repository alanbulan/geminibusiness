const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_MOEMAIL_BASE_URL = process.env.MOEMAIL_BASE_URL || 'https://111.alanbulan.space';
const DEFAULT_MOEMAIL_API_KEY = 'mk_4Pq6uyO5dDFF92fk6Hxs1qw0LWJls8wD';

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        headless: false,
        threads: 1,
        continuous: false,
        dataDir: null  // 自定义数据目录
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
            case '--help':
                console.log(`
用法: node main.js [选项]

选项:
  --headless, -h       无头模式运行
  --threads, -t <n>    线程数 (默认: 1)
  --continuous, -c     持续运行模式
  --data-dir, -d <dir> 数据保存目录
  --help               显示帮助
                `);
                process.exit(0);
        }
    }

    return config;
}

// 读取配置（命令行参数优先）
async function loadConfig() {
    // 先解析命令行参数
    const cliConfig = parseArgs();
    
    // 如果有命令行参数，直接使用
    if (process.argv.length > 2) {
        console.log('使用命令行参数配置');
        return cliConfig;
    }

    // 否则尝试读取配置文件
    try {
        const configPath = path.join(__dirname, 'config.json');
        const configData = await fs.readFile(configPath, 'utf8');
        const fileConfig = JSON.parse(configData);
        return { ...cliConfig, ...fileConfig };
    } catch (error) {
        console.log('未找到配置文件，使用默认配置');
        return cliConfig;
    }
}

// 确保 data 目录存在
async function ensureDataDir(customDir = null) {
    const dataDir = customDir || path.join(__dirname, 'data');
    try {
        await fs.access(dataDir);
    } catch {
        await fs.mkdir(dataDir, { recursive: true });
    }
    return dataDir;
}

// 获取临时邮箱
async function getTemporaryEmail(threadId, config) {
    console.log(`[线程 ${threadId}] 正在获取临时邮箱...`);
    const baseUrl = (config && config.moemailBaseUrl) || DEFAULT_MOEMAIL_BASE_URL;
    const apiKey = (config && config.moemailApiKey) || process.env.MOEMAIL_API_KEY || DEFAULT_MOEMAIL_API_KEY;
    if (!apiKey) {
        throw new Error('MoeMail API Key 未配置，请设置环境变量 MOEMAIL_API_KEY 或在 config.json 中提供 moemailApiKey');
    }

    let domain = config && config.moemailDomain;
    try {
        if (!domain) {
            const cfgResp = await axios.get(`${baseUrl}/api/config`, {
                headers: {
                    'X-API-Key': apiKey,
                },
            });
            const domains = (cfgResp.data.emailDomains || '')
                .split(',')
                .map(d => d.trim())
                .filter(Boolean);
            if (domains.length > 0) {
                domain = domains[0];
            }
        }
    } catch (error) {
        console.log(`[线程 ${threadId}] 获取 MoeMail 配置失败:`, error.message);
    }
    if (!domain) {
        domain = 'moemail.app';
    }

    const name = `biz_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const response = await axios.post(
        `${baseUrl}/api/emails/generate`,
        {
            name,
            expiryTime: 0,
            domain,
        },
        {
            headers: {
                'X-API-Key': apiKey,
                'Content-Type': 'application/json',
            },
        },
    );

    const emailId = response.data.id;
    const email = response.data.email;
    if (!emailId || !email) {
        throw new Error('MoeMail 返回的数据不完整，缺少 id 或 email');
    }

    console.log(`[线程 ${threadId}] 获取到邮箱:`, email);
    return { email, emailId, baseUrl, apiKey };
}

// 获取邮件内容
async function getEmailContent(emailInfo, threadId, maxRetries = 20) {

    //   console.log(`[线程 ${threadId}] 成功获取邮件`);
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
            console.log(`[线程 ${threadId}] 尝试 ${i + 1}/${maxRetries} 失败:`, error.message);
        }

        // 等待 5 秒后重试
        console.log(`[线程 ${threadId}] 等待 5 秒后重试... (${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(() => resolve(), 5000));
    }

    throw new Error('无法获取邮件内容');
}

// 从邮件内容中提取验证码
function extractVerificationCode(emailContent, threadId) {
    const content = emailContent.content || '';
    const subject = emailContent.subject || '';
    // 常见的非验证码单词列表
    const commonWords = ['VERIFY', 'GOOGLE', 'UPDATE', 'MOBILE', 'DEVICE', 'SUBMIT', 'RESEND', 'CANCEL', 'DELETE', 'REMOVE', 'SEARCH', 'VIDEOS', 'IMAGES', 'GMAIL', 'EMAIL', 'ACCOUNT', 'CHROME'];

    // 方法1: 查找所有 6 位大写字母或数字的组合
    const matches = content.match(/\b[A-Z0-9]{6}\b/g);

    if (matches) {
        // 优先寻找包含数字的验证码 (如 F7W96C)
        const withDigits = matches.find(code =>
            !commonWords.includes(code) && /[0-9]/.test(code)
        );
        if (withDigits) {
            console.log(`[线程 ${threadId}] 选择包含数字的验证码: ${withDigits}`);
            return withDigits;
        }

        // 如果没有包含数字的，返回第一个非常见单词的匹配
        const anyMatch = matches.find(code => !commonWords.includes(code));
        if (anyMatch) {
            console.log(`[线程 ${threadId}] 选择第一个非常见词验证码: ${anyMatch}`);
            return anyMatch;
        }
    }

    // 方法2: 查找 "code" 附近的 6 位字符
    const contextMatch = content.match(/code\s*[:is]\s*([A-Z0-9]{6})/i);
    if (contextMatch) {
        console.log(`[线程 ${threadId}] 通过上下文找到验证码: ${contextMatch[1]}`);
        return contextMatch[1];
    }

    // 方法3: 查找 "verification" 附近的代码
    const verifyMatch = content.match(/verification\s*code\s*[:is]*\s*([A-Z0-9]{6})/i);
    if (verifyMatch) {
        console.log(`[线程 ${threadId}] 通过verification找到验证码: ${verifyMatch[1]}`);
        return verifyMatch[1];
    }

    // 方法4: 在HTML标签中查找
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

// 生成随机全名
function generateRandomName() {
    const firstNames = ['John', 'Jane', 'Michael', 'Sarah', 'David', 'Emily', 'Robert', 'Lisa'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];

    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

    return `${firstName} ${lastName}`;
}

// 全局统计
const stats = {
    total: 0,
    success: 0,
    failed: 0,
    startTime: Date.now()
};

// 打印统计信息
function printStats() {
    const duration = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(2);
    console.log('\n=== 运行统计 ===');
    console.log(`运行时间: ${duration} 分钟`);
    console.log(`总尝试数: ${stats.total}`);
    console.log(`成功数量: ${stats.success}`);
    console.log(`失败数量: ${stats.failed}`);
    console.log(`成功率: ${stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(2) : 0}%`);
    console.log('================\n');
}

// 定期打印统计
setInterval(printStats, 60000);

async function runTask(threadId, config) {
    let browser;
    console.log(`[线程 ${threadId}] 启动任务`);
    stats.total++;

    try {
        // 获取临时邮箱
        const { email, emailId, baseUrl, apiKey } = await getTemporaryEmail(threadId, config);

        // 启动浏览器
        console.log(`[线程 ${threadId}] 正在启动浏览器...`);
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : undefined);
        browser = await puppeteer.launch({
            headless: config.headless === true ? 'new' : config.headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--incognito'],
            executablePath,
        });

        // 获取默认页面（避免打开两个窗口）
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        // 设置 User-Agent
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0');

        // 监听请求以捕获 authorization 和 cookie
        let authData = {
            authorization: null,
            cookies: null,
            configId: null,
            csesidx: null
        };

        page.on('request', (request) => {
            const headers = request.headers();
            if (headers['authorization']) {
                authData.authorization = headers['authorization'];
            }
        });

        // 监听所有响应以提取 configId 和 csesidx
        page.on('response', async (response) => {
            try {
                const url = response.url();
                // 提取 configId: /cid/xxx
                const cidMatch = url.match(/\/cid\/([a-f0-9-]+)/i);
                if (cidMatch && !authData.configId) {
                    authData.configId = cidMatch[1];
                    console.log(`[线程 ${threadId}] 从响应提取 configId: ${authData.configId}`);
                }
                // 提取 csesidx: ?csesidx=xxx 或 &csesidx=xxx
                const csesidxMatch = url.match(/[?&]csesidx=(\d+)/);
                if (csesidxMatch && !authData.csesidx) {
                    authData.csesidx = csesidxMatch[1];
                    console.log(`[线程 ${threadId}] 从响应提取 csesidx: ${authData.csesidx}`);
                }
            } catch (e) {
                // 忽略错误
            }
        });

        // 同时监听 URL 变化
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
            timeout: 60000
        });
        // 等待输入框出现
        await page.waitForSelector('input', { timeout: 30000 });
        await new Promise(resolve => setTimeout(() => resolve(), 2000));

        // 先点击输入框聚焦
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            if (inputs.length > 0) {
                inputs[0].click();
                inputs[0].focus();
            }
        });

        await new Promise(resolve => setTimeout(() => resolve(), 1000));

        // 使用 type 方法模拟真实键盘输入
        await page.type('input', email, { delay: 100 });
        console.log(`[线程 ${threadId}] 已填写邮箱:`, email);

        // 等待一下
        await new Promise(resolve => setTimeout(() => resolve(), 2000));

        // 验证输入框的值
        const actualValue = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            return inputs.length > 0 ? inputs[0].value : '';
        });

        // 触发 blur 事件以确保验证
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            if (inputs.length > 0) {
                inputs[0].blur();
            }
        });

        await new Promise(resolve => setTimeout(() => resolve(), 1000));

        // 查找并点击按钮 (带重试)
        let emailSubmitted = false;
        for (let i = 0; i < 5; i++) {
            const clicked = await page.evaluate(() => {
                const targets = ['继续', 'Next', '邮箱', 'Next', 'Continue'];
                const elements = [
                    ...document.querySelectorAll('button'),
                    ...document.querySelectorAll('input[type="submit"]'),
                    ...document.querySelectorAll('div[role="button"]'),
                    ...document.querySelectorAll('span[role="button"]')
                ];

                for (const element of elements) {
                    // 检查可见性
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                    if (element.disabled) continue;

                    const text = (element.textContent || '').trim();
                    if (targets.some(t => text.includes(t))) {
                        element.click();
                        return true;
                    }
                }

                // 备用：查找主要按钮
                const primaryBtn = document.querySelector('button[color="primary"], button.primary');
                if (primaryBtn && !primaryBtn.disabled) {
                    primaryBtn.click();
                    return true;
                }

                return false;
            });

            if (clicked) {
                emailSubmitted = true;
                break;
            }
            await new Promise(resolve => setTimeout(() => resolve(), 1000));
        }

        if (!emailSubmitted) {
            throw new Error('找不到提交按钮');
        }
        await new Promise(resolve => setTimeout(() => resolve(), 5000));

        // 检查页面状态 - 是否需要验证码
        let needsVerification = true;
        try {
            needsVerification = await page.evaluate(() => {
                const body = document.body;
                const pageText = body && typeof body.textContent === 'string' ? body.textContent : '';
                // 检查是否还在验证码页面
                if (pageText.includes('验证') || pageText.includes('Verify') || pageText.includes('验证码')) {
                    return true;
                }
                // 检查是否已经到了全名输入页面
                if (pageText.includes('姓氏') || pageText.includes('名字') || pageText.includes('name')) {
                    return false;
                }
                return true; // 默认需要验证
            });
        } catch (err) {
            if (err && typeof err.message === 'string' && err.message.includes('Execution context was destroyed')) {
                console.log(`[线程 ${threadId}] 在检测是否需要验证码时发生页面跳转，默认需要验证码`);
                needsVerification = true;
            } else {
                throw err;
            }
        }

        let verificationCode = null;

        if (needsVerification) {
            console.log(`[线程 ${threadId}] 页面需要验证码，开始获取邮件...`);

            // 获取验证码邮件
            const emailData = await getEmailContent({ email, emailId, baseUrl, apiKey }, threadId);
            try {
                verificationCode = extractVerificationCode(emailData, threadId);
                console.log(`[线程 ${threadId}] ✓ 成功提取验证码: ${verificationCode}`);
            } catch (err) {
                console.error(`[线程 ${threadId}] ✗ 验证码提取失败:`, err.message);
                throw err;
            }

            // 等待验证码输入框并确保页面稳定
            await page.waitForSelector('input', { timeout: 30000 });
            await new Promise(resolve => setTimeout(() => resolve(), 2000));

            // 清空可能的旧值并聚焦
            await page.evaluate(() => {
                const inputs = document.querySelectorAll('input');
                if (inputs.length > 0) {
                    inputs[0].value = '';
                    inputs[0].click();
                    inputs[0].focus();
                }
            });

            await new Promise(resolve => setTimeout(() => resolve(), 500));

            // 使用 type 方法输入验证码
            await page.type('input', verificationCode, { delay: 150 });
            console.log(`[线程 ${threadId}] 已填写验证码`);

            await new Promise(resolve => setTimeout(() => resolve(), 2000));

            // 触发 blur
            await page.evaluate(() => {
                const inputs = document.querySelectorAll('input');
                if (inputs.length > 0) {
                    inputs[0].blur();
                }
            });

            await new Promise(resolve => setTimeout(() => resolve(), 1000));
            let verifySubmitted = false;
            for (let i = 0; i < 5; i++) {
                let verifyClicked = false;
                try {
                    verifyClicked = await page.evaluate(() => {
                        const targets = ['验证', 'Verify', '继续', 'Next', 'Continue'];
                        const elements = [
                            ...document.querySelectorAll('button'),
                            ...document.querySelectorAll('input[type="submit"]'),
                            ...document.querySelectorAll('div[role="button"]')
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
                    if (err && typeof err.message === 'string' && err.message.includes('Execution context was destroyed')) {
                        console.log(`[线程 ${threadId}] 验证码提交时页面跳转，结束验证码提交重试`);
                        break;
                    }
                    throw err;
                }

                if (verifyClicked) {
                    verifySubmitted = true;
                    break;
                } else {
                    console.log(`[线程 ${threadId}] 尝试 ${i + 1}/5: 未找到验证提交按钮，等待重试...`);
                }
                await new Promise(resolve => setTimeout(() => resolve(), 1500));
            }

            // 等待重定向
            console.log(`[线程 ${threadId}] 等待重定向...`);
            await new Promise(resolve => setTimeout(() => resolve(), 3000));
        } else {
            console.log(`[线程 ${threadId}] 页面已跳过验证码步骤，直接进入下一步`);
        }

        // 确保数据目录存在
        // const dataDir = config.dataDir || path.join(__dirname, 'data');
        try {
            await fs.mkdir(config.dataDir || path.join(__dirname, 'data'), { recursive: true });
        } catch (e) {}
        
        // 生成随机全名
        const fullName = generateRandomName();
        console.log(`[线程 ${threadId}] 生成的全名:`, fullName);

        // 等待输入框并确保页面稳定
        let inputFound = false;
        try {
            await page.waitForSelector('input', { timeout: 30000 });
            await new Promise(resolve => setTimeout(() => resolve(), 2000));
            inputFound = true;
        } catch (e) {
            console.log(`[线程 ${threadId}] 等待全名输入框超时，可能页面结构已变或已自动跳转`);
        }

        if (inputFound) {
            // 清空可能的旧值并聚焦
            try {
                await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input');
                    if (inputs.length > 0) {
                        inputs[0].value = '';
                        inputs[0].click();
                        inputs[0].focus();
                    }
                });
            } catch (err) {
                if (err && typeof err.message === 'string' && err.message.includes('Execution context was destroyed')) {
                    console.log(`[线程 ${threadId}] 填写全名前页面发生跳转，跳过全名输入框清空与聚焦`);
                } else {
                    throw err;
                }
            }

            await new Promise(resolve => setTimeout(() => resolve(), 500));

            // 使用 type 方法输入全名
            // 先再次检查 input 是否存在
            try {
                const inputExists = await page.$('input');
                if (inputExists) {
                    await page.type('input', fullName, { delay: 100 });
                    console.log(`[线程 ${threadId}] 已填写全名`);
                } else {
                    console.log(`[线程 ${threadId}] 尝试输入全名时 input 元素消失，跳过输入`);
                }
            } catch (err) {
                console.log(`[线程 ${threadId}] 输入全名时发生错误:`, err.message);
            }

            await new Promise(resolve => setTimeout(() => resolve(), 2000));

            // 触发 blur
            try {
                await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input');
                    if (inputs.length > 0) {
                        inputs[0].blur();
                    }
                });
            } catch (err) {
                if (err && typeof err.message === 'string' && err.message.includes('Execution context was destroyed')) {
                    console.log(`[线程 ${threadId}] 填写全名后页面发生跳转，忽略 blur 操作`);
                } else {
                     // 忽略其他 blur 错误
                }
            }
        }

        await new Promise(resolve => setTimeout(() => resolve(), 1000));

        // 确认提交 (带重试)
        console.log(`[线程 ${threadId}] 准备提交全名...`);
        let confirmSubmitted = false;
        for (let i = 0; i < 5; i++) {
            const confirmClicked = await page.evaluate(() => {
                const targets = ['同意', 'Confirm', '继续', 'Next', 'Continue'];
                const elements = [
                    ...document.querySelectorAll('button'),
                    ...document.querySelectorAll('input[type="submit"]'),
                    ...document.querySelectorAll('div[role="button"]')
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

                // 备用: 点击第一个可见的按钮
                for (const element of elements) {
                    if (element.offsetParent !== null && !element.disabled) {
                        element.click();
                        return true;
                    }
                }
                return false;
            });

            if (confirmClicked) {
                confirmSubmitted = true;
                break;
            } else {
                console.log(`[线程 ${threadId}] 尝试 ${i + 1}/5: 未找到确认按钮，等待重试...`);
            }
            await new Promise(resolve => setTimeout(() => resolve(), 1500));
        }

        if (!confirmSubmitted) {
        }
        // 循环检查 authorization，如果没获取到就继续尝试点击按钮
        await new Promise(resolve => setTimeout(() => resolve(), 2000));

        let retries = 0;
        while (!authData.authorization && retries < 10) {

            // 尝试点击可能出现的"继续"或"同意"按钮
            let clickedNext = false;
            try {
                clickedNext = await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button');
                    for (const button of buttons) {
                        const text = (button.textContent || '').trim();
                        if (text.includes('同意') || text.includes('Confirm') || text.includes('继续') || text.includes('Next') || text.includes('I agree')) {
                            if (button.offsetParent !== null && !button.disabled) {
                                button.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });
            } catch (err) {
                // 忽略页面导航导致的上下文销毁错误
                if (!err.message.includes('Execution context was destroyed')) {
                    console.error(`[线程 ${threadId}] 检查按钮时出错:`, err.message);
                }
            }

            if (clickedNext) {
                console.log(`[线程 ${threadId}] 点击了额外的继续按钮`);
            }

            await new Promise(resolve => setTimeout(() => resolve(), 3000));
            retries++;
        }

        if (!authData.authorization) {
            throw new Error('未能获取 Authorization，注册可能未完成');
        }

        // 获取最终的 cookies
        const cookies = await page.cookies();
        authData.cookies = cookies;

        const secureCookie = cookies.find(c => c.name === '__Secure-C_SES');
        const hostCookie = cookies.find(c => c.name === '__Host-C_OSES');

        // 保存数据
        await fs.mkdir(config.dataDir || path.join(__dirname, 'data'), { recursive: true });
        const dataDir = config.dataDir || path.join(__dirname, 'data');
        const outputFile = path.join(dataDir, `${email}.json`);
        
        // 尝试注册到账号库 (ConfigStore)
        try {
        // 尝试提取 configId 和 csesidx (在保存前提取)
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

        // 如果还是没有，警告但继续保存
        if (!authData.configId || !authData.csesidx) {
            console.log(`[线程 ${threadId}] ⚠️ 未能提取完整信息: configId=${authData.configId}, csesidx=${authData.csesidx}`);
        } else {
            console.log(`[线程 ${threadId}] ✓ 提取成功: configId=${authData.configId}, csesidx=${authData.csesidx}`);
        }

        // 尝试注册到账号库 (ConfigStore)
        if (authData.configId && authData.csesidx) {
            try {
                const apiBase = process.env.API_BASE_URL || 'http://localhost:5000';
                console.log(`[线程 ${threadId}] 正在将账号添加到系统库: ${apiBase}/api/config/profiles`);
                await axios.post(`${apiBase}/api/config/profiles`, {
                    name: email.split('@')[0],
                    secure_c_ses: secureCookie ? secureCookie.value : null,
                    csesidx: authData.csesidx,
                    config_id: authData.configId,
                    host_c_oses: hostCookie ? hostCookie.value : null,
                    proxy: null
                });
                console.log(`[线程 ${threadId}] 账号已成功注册到系统库`);
            } catch (err) {
                console.error(`[线程 ${threadId}] 注册到系统库失败 (仅保存本地文件):`, err.message);
                if (err.response) {
                     console.error(`[线程 ${threadId}] 响应数据:`, JSON.stringify(err.response.data));
                }
            }
        } else {
             console.log(`[线程 ${threadId}] ⚠️ 由于缺失 configId 或 csesidx，跳过注册到系统库`);
        }

        await fs.writeFile(outputFile, JSON.stringify({
            email: email,
            emailId: emailId,
            fullName: fullName,
            authorization: authData.authorization,
            cookies: authData.cookies,
            configId: authData.configId,
            csesidx: authData.csesidx,
            timestamp: new Date().toISOString()
        }, null, 2));

        // 控制台输出 key=value
        if (secureCookie && secureCookie.value) {
            console.log(`SECURE_C_SES=${secureCookie.value}`);
        }
        if (authData.csesidx) {
            console.log(`CSESIDX=${authData.csesidx}`);
        }
        if (authData.configId) {
            console.log(`CONFIG_ID=${authData.configId}`);
        }
        if (hostCookie && hostCookie.value) {
            console.log(`HOST_C_OSES=${hostCookie.value}`);
        }

        // 生成 txt 文件（与邮箱同名），内容为上述四行
        const lines = [];
        if (secureCookie && secureCookie.value) {
            lines.push(`SECURE_C_SES=${secureCookie.value}`);
        }
        if (authData.csesidx) {
            lines.push(`CSESIDX=${authData.csesidx}`);
        }
        if (authData.configId) {
            lines.push(`CONFIG_ID=${authData.configId}`);
        }
        if (hostCookie && hostCookie.value) {
            lines.push(`HOST_C_OSES=${hostCookie.value}`);
        }
        const txtContent = lines.join('\n') + (lines.length ? '\n' : '');
        const txtFile = path.join(dataDir, `${email}.txt`);
        await fs.writeFile(txtFile, txtContent, 'utf8');
        stats.success++;
        console.log(`[线程 ${threadId}] ✓ 账号保存成功: ${email}`);

        } catch (error) {
            console.error(`[线程 ${threadId}] 注册到系统库时发生错误:`, error);
        }

    } catch (error) {
        console.error(`[线程 ${threadId}] 发生错误:`, error);
        stats.failed++;
    } finally {
        if (browser) {
            // 等待 5 秒后关闭浏览器
            await new Promise(resolve => setTimeout(() => resolve(), 5000));
            await browser.close();
        }
    }
}

async function worker(threadId, config) {
    console.log(`[线程 ${threadId}] 启动 Worker`);
    while (true) {
        try {
            await runTask(threadId, config);
        } catch (error) {
            console.error(`[线程 ${threadId}] 任务执行异常:`, error);
        }

        if (!config.continuous) {
            console.log(`[线程 ${threadId}] 单次运行完成，退出 Worker`);
            break;
        }

        // 任务之间添加短暂延迟
        console.log(`[线程 ${threadId}] 准备开始下一个任务...`);
        await new Promise(resolve => setTimeout(() => resolve(), 2000));
    }
}

async function main() {
    const config = await loadConfig();
    // 默认配置（命令行模式默认单次运行）
    if (config.continuous === undefined) {
        config.continuous = process.argv.length <= 2; // 无命令行参数时持续运行
    }

    console.log(`配置: Headless=${config.headless}, Threads=${config.threads}, Continuous=${config.continuous}, DataDir=${config.dataDir || 'default'}`);
    console.log(config.continuous ? '开始持续运行模式...' : '开始单次运行模式...');

    const workers = [];
    for (let i = 0; i < config.threads; i++) {
        workers.push(worker(i + 1, config));
    }

    await Promise.all(workers);
    printStats();
    console.log('所有任务完成');
    
    // 非持续模式下强制退出
    if (!config.continuous) {
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };


