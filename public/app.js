'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   معلمي v7.0 - JavaScript احترافي كامل
   ═══════════════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'mualimi_v7';
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES = 80;

// ═══ الحالة العامة ═══
const state = {
  apiKey: '',
  studentName: 'رحمة',
  conversations: [],
  activeConversation: null,
  currentView: 'home',
  isConnected: false,
  modelInfo: null,
  isStreaming: false,
};

// ═══ مساعدات DOM ═══
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const hide = (el) => el?.setAttribute('hidden', '');
const show = (el) => el?.removeAttribute('hidden');
const toggle = (el, condition) => condition ? show(el) : hide(el);

// ═══════════════════════════════════════════════════════════════════════
//  التخزين المحلي
// ═══════════════════════════════════════════════════════════════════════

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    
    const data = JSON.parse(saved);
    state.apiKey = String(data.apiKey || '').slice(0, 2048);
    state.studentName = String(data.studentName || 'رحمة').slice(0, 40);
    state.conversations = Array.isArray(data.conversations) 
      ? data.conversations.slice(0, MAX_CONVERSATIONS)
      : [];
  } catch (e) {
    console.error('فشل تحميل البيانات:', e);
  }
}

function saveState() {
  try {
    const data = {
      apiKey: state.apiKey,
      studentName: state.studentName,
      conversations: state.conversations.slice(0, MAX_CONVERSATIONS),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('فشل حفظ البيانات:', e);
    showToast('تعذر حفظ البيانات');
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  إدارة المحادثات
// ═══════════════════════════════════════════════════════════════════════

function createConversation() {
  const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const conversation = {
    id,
    title: 'جلسة جديدة',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  state.conversations.unshift(conversation);
  state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
  state.activeConversation = conversation;
  
  saveState();
  return conversation;
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.activeConversation?.id === id) {
    state.activeConversation = null;
  }
  saveState();
}

function addMessage(role, content) {
  if (!state.activeConversation) {
    createConversation();
  }
  
  const message = {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: Date.now(),
  };
  
  state.activeConversation.messages.push(message);
  state.activeConversation.messages = state.activeConversation.messages.slice(-MAX_MESSAGES);
  state.activeConversation.updatedAt = Date.now();
  
  // تحديث العنوان من أول رسالة
  if (state.activeConversation.messages.length === 1 && role === 'user') {
    state.activeConversation.title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
  }
  
  saveState();
  return message;
}

// ═══════════════════════════════════════════════════════════════════════
//  الاتصال بالخادم
// ═══════════════════════════════════════════════════════════════════════

async function fetchWithKey(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (state.apiKey) {
    headers['X-AI-API-Key'] = state.apiKey;
  }
  
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `HTTP ${response.status}`);
  }
  
  return response;
}

async function checkConnection() {
  try {
    const response = await fetchWithKey('/api/bootstrap', { timeout: 10000 });
    const data = await response.json();
    
    state.isConnected = data.configured;
    state.modelInfo = {
      model: data.model,
      endpoint: data.endpoint,
      supportsVision: data.supportsVision,
    };
    
    updateConnectionStatus();
    return data;
  } catch (e) {
    console.error('فشل الاتصال:', e);
    state.isConnected = false;
    updateConnectionStatus();
    throw e;
  }
}

function updateConnectionStatus() {
  const dot = $('#statusDot');
  const text = $('#statusText');
  
  if (state.isConnected) {
    dot?.classList.add('online');
    dot?.classList.remove('offline');
    text && (text.textContent = 'المعلم جاهز');
  } else {
    dot?.classList.remove('online');
    dot?.classList.add('offline');
    text && (text.textContent = 'غير متصل');
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  إرسال الرسائل
// ═══════════════════════════════════════════════════════════════════════

let abortController = null;

async function sendMessage(content) {
  if (!content.trim()) return;
  if (!state.apiKey) {
    showToast('يرجى إدخال مفتاح API أولاً');
    openSettings();
    return;
  }
  
  // إضافة رسالة المستخدم
  const userMessage = addMessage('user', content);
  renderMessages();
  
  // تجهيز رسالة المساعد
  const assistantMessage = addMessage('assistant', '');
  state.isStreaming = true;
  updateUI();
  
  abortController = new AbortController();
  
  try {
    const messages = state.activeConversation.messages
      .slice(-14)
      .map(m => ({
        role: m.role,
        content: m.content,
      }));
    
    const response = await fetchWithKey('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages,
        studentName: state.studentName,
      }),
      signal: abortController.signal,
    });
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        
        try {
          const event = JSON.parse(data);
          
          if (event.type === 'text') {
            assistantMessage.content += event.text;
            saveState();
            renderMessages();
            scrollToBottom();
          }
        } catch (e) {
          console.error('خطأ في تحليل SSE:', e);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      assistantMessage.content += '\n\n_[تم إيقاف الرد]_';
    } else {
      console.error('خطأ في إرسال الرسالة:', e);
      assistantMessage.content = `حدث خطأ: ${e.message}`;
      showToast('فشل إرسال الرسالة');
    }
  } finally {
    state.isStreaming = false;
    abortController = null;
    saveState();
    renderMessages();
    updateUI();
  }
}

function stopStreaming() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  العرض
// ═══════════════════════════════════════════════════════════════════════

function showView(viewName) {
  // إخفاء كل الشاشات
  $$('.view').forEach(v => hide(v));
  
  // إظهار الشاشة المطلوبة
  const view = $(`#${viewName}View`);
  if (view) {
    show(view);
    state.currentView = viewName;
  }
  
  // تحديث الأزرار
  $$('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  
  // إظهار/إخفاء زر الرجوع
  toggle($('#backBtn'), viewName !== 'home');
  
  // تحديث المحتوى حسب الشاشة
  if (viewName === 'home') {
    const name = $('#studentName');
    if (name) name.textContent = state.studentName || 'رحمة';
  } else if (viewName === 'chat') {
    renderMessages();
    focusInput();
  } else if (viewName === 'history') {
    renderHistory();
  }
}

function renderMessages() {
  const container = $('#messages');
  if (!container) return;
  
  if (!state.activeConversation || !state.activeConversation.messages.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div><p>ابدئي المحادثة بسؤالك</p></div>';
    return;
  }
  
  container.innerHTML = state.activeConversation.messages
    .map(msg => `
      <div class="message ${msg.role}">
        <div class="message-bubble">${escapeHtml(msg.content)}</div>
      </div>
    `)
    .join('');
  
  scrollToBottom();
}

function renderHistory() {
  const list = $('#historyList');
  const empty = $('#emptyHistory');
  
  if (!list) return;
  
  if (!state.conversations.length) {
    hide(list);
    show(empty);
    return;
  }
  
  show(list);
  hide(empty);
  
  list.innerHTML = state.conversations
    .map(conv => `
      <div class="history-item" data-id="${conv.id}">
        <div class="history-icon">💬</div>
        <div class="history-info">
          <div class="history-title">${escapeHtml(conv.title)}</div>
          <div class="history-date">${formatDate(conv.updatedAt)}</div>
        </div>
      </div>
    `)
    .join('');
}

function updateUI() {
  // تحديث أزرار الإرسال/الإيقاف
  toggle($('#sendBtn'), !state.isStreaming);
  toggle($('#stopBtn'), state.isStreaming);
  
  // تعطيل/تفعيل حقل الإدخال
  const input = $('#messageInput');
  if (input) {
    input.disabled = state.isStreaming;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  الإعدادات
// ═══════════════════════════════════════════════════════════════════════

function openSettings() {
  const modal = $('#settingsModal');
  if (!modal) return;
  
  // ملء الحقول
  const nameInput = $('#nameInput');
  const apiInput = $('#apiKeyInput');
  const modelName = $('#modelName');
  const apiStatus = $('#apiStatus');
  
  if (nameInput) nameInput.value = state.studentName || '';
  if (apiInput) apiInput.value = state.apiKey || '';
  
  if (modelName && state.modelInfo) {
    modelName.textContent = state.modelInfo.model || '—';
  }
  
  if (apiStatus) {
    if (state.isConnected) {
      apiStatus.textContent = 'متصل';
      apiStatus.className = 'text-success';
    } else {
      apiStatus.textContent = 'غير متصل';
      apiStatus.className = 'text-warning';
    }
  }
  
  show(modal);
}

function closeModal(modalId) {
  const modal = $(`#${modalId}`);
  if (modal) hide(modal);
}

async function saveSettings() {
  const nameInput = $('#nameInput');
  const apiInput = $('#apiKeyInput');
  
  if (nameInput) {
    state.studentName = nameInput.value.trim() || 'رحمة';
  }
  
  if (apiInput) {
    state.apiKey = apiInput.value.trim();
  }
  
  saveState();
  
  // إعادة التحقق من الاتصال
  try {
    await checkConnection();
    showToast('تم حفظ الإعدادات');
    closeModal('settingsModal');
  } catch (e) {
    showToast('فشل التحقق من الاتصال');
  }
}

async function testApiKey() {
  const apiInput = $('#apiKeyInput');
  const result = $('#apiResult');
  
  if (!apiInput || !result) return;
  
  const key = apiInput.value.trim();
  if (!key) {
    result.textContent = 'يرجى إدخال المفتاح أولاً';
    result.className = 'api-result error';
    return;
  }
  
  // حفظ مؤقت للاختبار
  const oldKey = state.apiKey;
  state.apiKey = key;
  
  try {
    await checkConnection();
    result.textContent = '✓ المفتاح صحيح والاتصال ناجح';
    result.className = 'api-result success';
  } catch (e) {
    result.textContent = '✗ فشل الاتصال: ' + e.message;
    result.className = 'api-result error';
    state.apiKey = oldKey;
  }
}

function clearAllData() {
  if (!confirm('هل أنتِ متأكدة من حذف جميع البيانات؟\n\nسيتم حذف:\n• جميع الجلسات\n• الإعدادات\n• المفتاح المحفوظ\n\nلا يمكن التراجع عن هذا الإجراء.')) {
    return;
  }
  
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ═══════════════════════════════════════════════════════════════════════
//  مساعدات
// ═══════════════════════════════════════════════════════════════════════

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  if (hours < 24) return `قبل ${hours} ساعة`;
  if (days < 7) return `قبل ${days} يوم`;
  
  return date.toLocaleDateString('ar-IQ', { month: 'short', day: 'numeric' });
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  
  toast.textContent = message;
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function scrollToBottom() {
  const container = $('#messages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function focusInput() {
  const input = $('#messageInput');
  if (input && !state.isStreaming) {
    setTimeout(() => input.focus(), 100);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  معالجات الأحداث
// ═══════════════════════════════════════════════════════════════════════

function setupEventListeners() {
  // الهيدر
  $('#backBtn')?.addEventListener('click', () => showView('home'));
  $('#settingsBtn')?.addEventListener('click', openSettings);
  
  // الرئيسية
  $('#startBtn')?.addEventListener('click', () => {
    createConversation();
    showView('chat');
  });
  
  $$('.quick-card').forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.dataset.prompt;
      if (prompt) {
        createConversation();
        showView('chat');
        setTimeout(() => {
          const input = $('#messageInput');
          if (input) {
            input.value = prompt;
            input.focus();
          }
        }, 100);
      }
    });
  });
  
  // المحادثة
  const messageForm = $('#messageForm');
  messageForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#messageInput');
    if (!input) return;
    
    const content = input.value.trim();
    if (content) {
      input.value = '';
      input.style.height = 'auto';
      await sendMessage(content);
    }
  });
  
  // تعديل حجم textarea تلقائياً
  const messageInput = $('#messageInput');
  messageInput?.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
  });
  
  $('#stopBtn')?.addEventListener('click', stopStreaming);
  
  // التاريخ
  const historyList = $('#historyList');
  historyList?.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    
    const id = item.dataset.id;
    const conversation = state.conversations.find(c => c.id === id);
    if (conversation) {
      state.activeConversation = conversation;
      showView('chat');
    }
  });
  
  // التنقل
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) showView(view);
    });
  });
  
  $('#newChatBtn')?.addEventListener('click', () => {
    createConversation();
    showView('chat');
  });
  
  // الإعدادات
  $('#saveApiBtn')?.addEventListener('click', testApiKey);
  $('#saveSettingsBtn')?.addEventListener('click', saveSettings);
  $('#clearDataBtn')?.addEventListener('click', clearAllData);
  
  // المودال
  $$('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      if (modal) hide(modal);
    });
  });
  
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', () => {
      const modal = overlay.closest('.modal');
      if (modal) hide(modal);
    });
  });
  
  // ESC لإغلاق المودال
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal:not([hidden])').forEach(modal => hide(modal));
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  التهيئة
// ═══════════════════════════════════════════════════════════════════════

async function init() {
  console.log('🚀 معلمي v7.0 - بدء التشغيل');
  
  // تحميل البيانات
  loadState();
  
  // إعداد الأحداث
  setupEventListeners();
  
  // عرض التطبيق
  show($('#app'));
  showView('home');
  
  // التحقق من الاتصال
  try {
    await checkConnection();
    console.log('✓ الاتصال ناجح');
  } catch (e) {
    console.warn('⚠ فشل الاتصال الأولي:', e.message);
  }
  
  console.log('✓ التطبيق جاهز');
}

// بدء التطبيق
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
