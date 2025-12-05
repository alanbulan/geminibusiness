// static/app.js
const API_BASE = '/api';
let regPollTimer = null;
let keepPollTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    loadProfiles();
    loadSettings();
    pollRegisterStatus();
    pollKeepaliveStatus();
    bindSettingsAutoSave();

    // 初始化 Chat
    initChat();

    // 搜索过滤功能
    document.getElementById('profileSearch').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const items = document.querySelectorAll('#profileList .list-group-item');
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = text.includes(term) ? '' : 'none';
        });
    });
});

// ---------- Chat Logic (New) ----------
function initChat() {
    const input = document.getElementById('chatInput');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

function clearChat() {
    document.getElementById('chatMessages').innerHTML = `
        <div class="text-center text-muted opacity-25 py-5">
            <i class="bi bi-chat-square-quote fs-1 mb-2 d-block"></i>
            <p class="small">Ready to connect.</p>
        </div>
    `;
}

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('sendBtn');
    const modelSelect = document.getElementById('chatModel');
    const msgContainer = document.getElementById('chatMessages');
    
    const text = input.value.trim();
    if (!text) return;

    // 1. UI: Add User Message
    appendMessage('user', text);
    input.value = '';
    input.style.height = 'auto';
    btn.disabled = true;

    // 2. UI: Add AI Placeholder
    const aiMsgId = `msg-${Date.now()}`;
    appendMessage('ai', '<div class="typing-indicator"><span></span><span></span><span></span></div>', aiMsgId);

    // 3. API Call
    try {
        const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelSelect.value,
                messages: [{ role: 'user', content: text }],
                stream: true
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // 4. Stream Processing
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiContent = '';
        const aiMsgEl = document.getElementById(aiMsgId);
        aiMsgEl.innerHTML = ''; // Clear typing indicator

        // SSE 行缓冲，避免大体积 data: 行在网络拆包时被截断
        let sseBuffer = '';
        let doneAll = false;

        while (!doneAll) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const rawLines = sseBuffer.split('\n');
            // 最后一行可能是不完整的，保留到下次
            sseBuffer = rawLines.pop() || '';

            for (let rawLine of rawLines) {
                const line = rawLine.trimEnd();
                if (!line.startsWith('data: ')) continue;

                const dataStr = line.slice(6).trim();
                if (!dataStr) continue;
                if (dataStr === '[DONE]') {
                    doneAll = true;
                    break;
                }

                try {
                    const data = JSON.parse(dataStr);
                    // Handle error in stream
                    if (data.error) {
                        aiContent += `\n[Error: ${data.error.message}]`;
                        aiMsgEl.innerText = aiContent;
                        continue;
                    }

                    const delta = data.choices?.[0]?.delta || {};
                    if (delta.content) aiContent += delta.content;

                    // Render with simple markdown parser
                    aiMsgEl.innerHTML = parseSimpleMarkdown(aiContent);
                    // Auto scroll
                    msgContainer.scrollTop = msgContainer.scrollHeight;
                } catch (e) {
                    // JSON 解析失败的行直接忽略
                }
            }
        }
    } catch (error) {
        const aiMsgEl = document.getElementById(aiMsgId);
        if (aiMsgEl) aiMsgEl.innerHTML += `<br><span class="text-danger small">[System Error: ${error.message}]</span>`;
    } finally {
        btn.disabled = false;
        input.focus();
    }
}

function appendMessage(role, html, id = null) {
    const container = document.getElementById('chatMessages');
    // Clear initial placeholder if exists
    if (container.querySelector('.text-center')) container.innerHTML = '';

    const msgDiv = document.createElement('div');
    msgDiv.className = `message message-${role}`;
    if (id) msgDiv.id = id;
    msgDiv.innerHTML = html;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

// ---------- 本地存储与设置管理 ----------
const STORAGE_KEY = 'gemini_business_settings';

function loadSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        
        if (settings.regThreads) document.getElementById('regThreads').value = settings.regThreads;
        if (settings.regHeadless !== undefined) document.getElementById('regHeadless').checked = settings.regHeadless;
        if (settings.regContinuous !== undefined) document.getElementById('regContinuous').checked = settings.regContinuous;
        
        if (settings.keepThreads) document.getElementById('keepThreads').value = settings.keepThreads;
        if (settings.keepInterval) {
            const storedValue = parseInt(settings.keepInterval);
            if (storedValue > 24) {
                document.getElementById('keepInterval').value = Math.ceil(storedValue / 3600);
            } else {
                document.getElementById('keepInterval').value = storedValue;
            }
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

function saveSettings() {
    const settings = {
        regThreads: document.getElementById('regThreads').value,
        regHeadless: document.getElementById('regHeadless').checked,
        regContinuous: document.getElementById('regContinuous').checked,
        keepThreads: document.getElementById('keepThreads').value,
        keepInterval: document.getElementById('keepInterval').value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function bindSettingsAutoSave() {
    const inputs = [
        'regThreads', 'regHeadless', 'regContinuous',
        'keepThreads', 'keepInterval'
    ];
    
    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', saveSettings);
            el.addEventListener('input', saveSettings);
        }
    });
}

// ---------- 工具函数 ----------
function showToast(message, type = 'primary') {
    const toastEl = document.getElementById('liveToast');
    const toastBody = document.getElementById('toastMessage');
    
    // Map bootstrap types
    const bgClass = type === 'danger' ? 'text-bg-danger' : 
                      type === 'success' ? 'text-bg-success' : 
                      type === 'warning' ? 'text-bg-warning' : 'text-bg-primary';

    toastEl.className = `toast ${bgClass} border-0`;
    toastBody.textContent = message;
    
    const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
}

// ---------- 配置管理 ----------
async function loadProfiles() {
    try {
        const res = await fetch(`${API_BASE}/config/profiles`);
        const profiles = await res.json();
        const listEl = document.getElementById('profileList');
        listEl.innerHTML = '';

        if (profiles.length === 0) {
            listEl.innerHTML = '<div class="text-center py-4 text-muted opacity-50"><p class="small">暂无配置，请点击新增。</p></div>';
            return;
        }

        profiles.forEach(p => {
            const item = document.createElement('div');
            item.className = `list-group-item ${p.is_active ? 'active' : ''}`;
            item.onclick = () => showProfileDetail(p);
            
            let statusHtml = '';
            if (p.status === 'Valid') statusHtml = '<span class="badge bg-success bg-opacity-25 text-success border border-success border-opacity-25 ms-2">可用</span>';
            else if (p.status === 'Invalid') statusHtml = '<span class="badge bg-danger bg-opacity-25 text-danger border border-danger border-opacity-25 ms-2">不可用</span>';
            else statusHtml = '<span class="badge bg-secondary bg-opacity-25 text-muted border border-secondary border-opacity-25 ms-2">未检测</span>';
            
            item.innerHTML = `
                <div class="d-flex w-100 justify-content-between align-items-start">
                    <div>
                        <h6 class="mb-1 fw-semibold d-flex align-items-center gap-2">
                            ${p.name} 
                            ${p.is_active ? '<i class="bi bi-check-circle-fill text-white fs-6"></i>' : ''}
                            ${statusHtml}
                        </h6>
                        <div class="small opacity-75 font-monospace text-truncate" style="max-width: 180px;">ID: ${p.id}</div>
                        <div class="small text-muted mt-1" style="font-size: 0.75rem;"><i class="bi bi-clock me-1"></i>${p.last_checked ? new Date(p.last_checked * 1000).toLocaleString() : 'Never'}</div>
                    </div>
                    <div class="btn-group-vertical opacity-50 hover-opacity-100 transition-opacity">
                        <button class="btn btn-sm btn-link text-info p-0 mb-2" onclick="event.stopPropagation(); checkProfile('${p.id}')" title="检查">
                            <i class="bi bi-arrow-clockwise fs-5"></i>
                        </button>
                        ${!p.is_active ? `<button class="btn btn-sm btn-link text-light p-0" onclick="event.stopPropagation(); activateProfile('${p.id}')" title="激活"><i class="bi bi-power fs-5"></i></button>` : ''}
                    </div>
                </div>
            `;
            listEl.appendChild(item);
        });
    } catch (error) {
        console.error("加载配置失败:", error);
        showToast("无法加载配置列表", "danger");
    }
}

async function submitProfile() {
    const form = document.getElementById('profileForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    
    Object.keys(data).forEach(key => {
        if (data[key] === '') data[key] = null;
    });
    
    const profileId = data.id;
    
    try {
        let res;
        if (profileId) {
            res = await fetch(`${API_BASE}/config/profiles/${profileId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });
        } else {
            res = await fetch(`${API_BASE}/config/profiles`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });
        }
        
        if (res.ok) {
            const modal = bootstrap.Modal.getInstance(document.getElementById('profileModal'));
            modal.hide();
            form.reset();
            document.getElementById('profileId').value = '';
            document.getElementById('profileModalTitle').innerHTML = '新增配置';
            loadProfiles();
            showToast(profileId ? '配置更新成功' : '配置创建成功', 'success');
        } else {
            const err = await res.json();
            showToast(`操作失败: ${err.error || '未知错误'}`, 'danger');
        }
    } catch (error) {
        showToast(`网络错误: ${error.message}`, 'danger');
    }
}

function showAddModal() {
    const modal = new bootstrap.Modal(document.getElementById('profileModal'));
    const form = document.getElementById('profileForm');
    form.reset();
    document.getElementById('profileId').value = '';
    document.getElementById('profileModalTitle').innerHTML = '新增配置';
    modal.show();
}

function showProfileDetail(profile) {
    const modal = new bootstrap.Modal(document.getElementById('detailModal'));
    const detailContent = document.getElementById('detailContent');
    
    detailContent.innerHTML = `
        <div class="col-12">
            <h6 class="text-muted small text-uppercase fw-bold mb-3">配置详情 / DETAILS</h6>
        </div>
        <div class="col-md-6">
            <label class="form-label small text-muted">名称</label>
            <input type="text" class="form-control bg-black border-secondary border-opacity-25 text-light" value="${profile.name}" readonly>
        </div>
        <div class="col-md-6">
            <label class="form-label small text-muted">ID</label>
            <input type="text" class="form-control bg-black border-secondary border-opacity-25 text-light font-monospace" value="${profile.id}" readonly>
        </div>
        <div class="col-12">
            <label class="form-label small text-muted">Secure C SES</label>
            <textarea class="form-control bg-black border-secondary border-opacity-25 text-light font-monospace" rows="2" readonly>${profile.secure_c_ses}</textarea>
        </div>
        <div class="col-md-6">
            <label class="form-label small text-muted">CSESIDX</label>
            <input type="text" class="form-control bg-black border-secondary border-opacity-25 text-light" value="${profile.csesidx}" readonly>
        </div>
        <div class="col-md-6">
            <label class="form-label small text-muted">Config ID</label>
            <input type="text" class="form-control bg-black border-secondary border-opacity-25 text-light" value="${profile.config_id}" readonly>
        </div>
        <div class="col-12 pt-3 border-top border-secondary border-opacity-10">
            <div class="d-flex gap-2 justify-content-end">
                <button class="btn btn-sm btn-outline-danger" onclick="deleteProfile('${profile.id}'); bootstrap.Modal.getInstance(document.getElementById('detailModal')).hide();">
                    <i class="bi bi-trash me-1"></i> 删除
                </button>
                <button class="btn btn-sm btn-primary" onclick="editProfileFromDetail('${profile.id}')">
                    <i class="bi bi-pencil me-1"></i> 编辑
                </button>
            </div>
        </div>
    `;
    modal.show();
}

function editProfileFromDetail(profileId) {
    const modal = bootstrap.Modal.getInstance(document.getElementById('detailModal'));
    modal.hide();
    editProfile(profileId);
}

async function editProfile(profileId) {
    try {
        const profiles = await fetchProfiles();
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) {
            showToast('配置不存在', 'danger');
            return;
        }
        
        const modal = new bootstrap.Modal(document.getElementById('profileModal'));
        document.getElementById('profileModalTitle').innerHTML = '编辑配置';
        document.getElementById('profileId').value = profile.id;
        document.querySelector('input[name="name"]').value = profile.name;
        document.querySelector('input[name="secure_c_ses"]').value = profile.secure_c_ses;
        document.querySelector('input[name="csesidx"]').value = profile.csesidx;
        document.querySelector('input[name="config_id"]').value = profile.config_id;
        document.querySelector('input[name="host_c_oses"]').value = profile.host_c_oses || '';
        document.querySelector('input[name="proxy"]').value = profile.proxy || '';
        
        modal.show();
    } catch (error) {
        showToast('加载配置详情失败', 'danger');
    }
}

async function fetchProfiles() {
    const res = await fetch(`${API_BASE}/config/profiles`);
    return res.json();
}

async function activateProfile(id) {
    try {
        const res = await fetch(`${API_BASE}/config/profiles/${id}/activate`, { method: 'POST' });
        if (res.ok) {
            loadProfiles();
            showToast('配置已激活', 'success');
        } else {
            showToast('激活失败', 'danger');
        }
    } catch (e) { showToast('网络错误', 'danger'); }
}

async function deleteProfile(id) {
    if(!confirm('确定要删除此配置吗？此操作不可恢复。')) return;
    try {
        const res = await fetch(`${API_BASE}/config/profiles/${id}`, { method: 'DELETE' });
        if (res.ok) {
            loadProfiles();
            showToast('配置已删除', 'success');
        } else {
            showToast('删除失败', 'danger');
        }
    } catch (e) { showToast('网络错误', 'danger'); }
}

async function checkProfile(id) {
    showToast('正在检查可用性...', 'info');
    try {
        const res = await fetch(`${API_BASE}/config/check_availability`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        loadProfiles();
        if (data.valid) {
            showToast('账号可用', 'success');
        } else {
            showToast('账号不可用', 'danger');
        }
    } catch (e) { 
        showToast('检查失败: 网络错误', 'danger');
    }
}

async function checkAllProfiles() {
    showToast('正在批量检查...', 'info');
    try {
        await fetch(`${API_BASE}/config/check_availability`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({})
        });
        loadProfiles();
        showToast('批量检查完成', 'success');
    } catch (e) { 
        showToast('网络错误', 'danger');
    }
}

// ---------- 自动化任务 ----------
async function startRegister() {
    const threads = parseInt(document.getElementById('regThreads').value) || 1;
    const headless = document.getElementById('regHeadless').checked;
    const continuous = document.getElementById('regContinuous').checked;
    
    try {
        const res = await fetch(`${API_BASE}/register/start`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ threads, headless, continuous })
        });
        if (res.ok) {
            showToast('注册任务已启动', 'success');
            pollRegisterStatus(true);
        } else {
            const err = await res.json();
            showToast(`启动失败: ${err.error}`, 'danger');
        }
    } catch (e) { showToast('网络错误', 'danger'); }
}

async function stopRegister() {
    try {
        await fetch(`${API_BASE}/register/stop`, { method: 'POST' });
        showToast('正在停止...', 'warning');
    } catch (e) { showToast('网络错误', 'danger'); }
}

async function pollRegisterStatus(force = false) {
    if (regPollTimer) clearTimeout(regPollTimer);
    try {
        const res = await fetch(`${API_BASE}/register/status`);
        const data = await res.json();
        updateProcessUI('Reg', data);
    } catch (e) {}
    regPollTimer = setTimeout(() => pollRegisterStatus(), 2000);
}

async function startKeepalive() {
    saveSettings();
    const threads = parseInt(document.getElementById('keepThreads').value) || 1;
    const intervalHours = parseInt(document.getElementById('keepInterval').value) || 1;
    const intervalSeconds = intervalHours * 3600;
    
    const statusBadge = document.getElementById('keepStatusBadge');
    if (statusBadge && statusBadge.innerText.includes('RUNNING')) {
        try { await stopKeepalive(); await new Promise(r => setTimeout(r, 1500)); } catch (e) {}
    }

    try {
        const res = await fetch(`${API_BASE}/keepalive/start`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ 
                threads, 
                intervalSeconds, 
                headless: true, 
                continuous: true 
            })
        });
        if (res.ok) {
            showToast('保活任务已启动', 'success');
            pollKeepaliveStatus(true);
        } else {
            const err = await res.json();
            showToast(`启动失败: ${err.error}`, 'danger');
        }
    } catch (e) { showToast('网络错误', 'danger'); }
}

async function stopKeepalive() {
    try {
        await fetch(`${API_BASE}/keepalive/stop`, { method: 'POST' });
        showToast('正在停止...', 'warning');
        setTimeout(() => pollKeepaliveStatus(true), 500);
    } catch (e) { showToast('网络错误', 'danger'); }
}

async function pollKeepaliveStatus(force = false) {
    if (keepPollTimer) clearTimeout(keepPollTimer);
    try {
        const res = await fetch(`${API_BASE}/keepalive/status`);
        const data = await res.json();
        updateProcessUI('Keep', data);
    } catch (e) {}
    keepPollTimer = setTimeout(() => pollKeepaliveStatus(), 2000);
}

function updateProcessUI(prefix, data) {
    const statusBadge = document.getElementById(`${prefix.toLowerCase()}StatusBadge`);
    const btnStart = document.getElementById(`btn${prefix}Start`);
    const btnStop = document.getElementById(`btn${prefix}Stop`);
    const logsEl = document.getElementById(`${prefix.toLowerCase()}Logs`);

    if (data.process.running) {
        statusBadge.className = 'status-badge status-running ms-1';
        statusBadge.innerText = 'RUNNING';
        btnStart.disabled = true;
        btnStop.disabled = false;
    } else {
        statusBadge.className = 'status-badge status-stopped ms-1';
        const exitCode = data.process.exit_code;
        statusBadge.innerText = exitCode !== null ? `EXITED (${exitCode})` : 'STOPPED';
        btnStart.disabled = false;
        btnStop.disabled = true;
    }

    if (!data.logs || data.logs.length === 0) {
        if (logsEl.innerHTML.includes('等待任务启动')) return;
        logsEl.innerHTML = '<span class="text-muted small p-3 d-block">> 暂无日志...</span>';
        return;
    }

    const logContent = data.logs.map(l => {
        const date = new Date(l.time);
        const timeStr = date.toLocaleTimeString('zh-CN', { hour12: false });
        let colorClass = 'text-secondary-emphasis';
        if (l.line.toLowerCase().includes('error')) colorClass = 'text-danger';
        else if (l.line.toLowerCase().includes('warn')) colorClass = 'text-warning';
        else if (l.line.toLowerCase().includes('success') || l.line.includes('✅')) colorClass = 'text-success';

        return `<div class="log-line ${colorClass}"><span class="log-time">[${timeStr}]</span>${l.line}</div>`;
    }).join('');
    
    if (logsEl.getAttribute('data-len') != data.logs.length) {
         logsEl.innerHTML = logContent;
         logsEl.setAttribute('data-len', data.logs.length);
         logsEl.scrollTop = logsEl.scrollHeight;
    }
}

function parseSimpleMarkdown(text) {
    if (!text) return '';
    
    // Escape HTML to prevent XSS (basic)
    let html = text.replace(/&/g, "&amp;")
                   .replace(/</g, "&lt;")
                   .replace(/>/g, "&gt;");

    // Image: ![alt](url)
    html = html.replace(/!\[.*?\]\((.*?)\)/g, '<img src="$1" style="max-width: 100%; border-radius: 8px; margin-top: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">');

    // Image by bare URL (common image extensions)
    html = html.replace(/(https?:\/\/[^(\s]+?\.(?:png|jpe?g|gif|webp|svg))/gi,
        '<img src="$1" style="max-width: 100%; border-radius: 8px; margin-top: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">');

    // Image by Google lh3 URL (no extension, like https://lh3.googleusercontent.com/d/..)
    html = html.replace(/(https?:\/\/lh3\.googleusercontent\.com\/[^(\s]+)/gi,
        '<img src="$1" style="max-width: 100%; border-radius: 8px; margin-top: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">');

    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Italic: *text*
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Code block: ```code```
    html = html.replace(/```([\s\S]*?)```/g, '<pre class="bg-black bg-opacity-50 p-3 rounded-3 mt-2 mb-2 custom-scroll"><code>$1</code></pre>');

    // Inline code: `code`
    html = html.replace(/`(.*?)`/g, '<code class="bg-black bg-opacity-25 px-1 rounded">$1<\/code>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');
    
    return html;}