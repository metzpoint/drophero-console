import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

import * as logic from '../va-portal-logic.mjs';

const root = new URL('../', import.meta.url);

function moduleSource(file) {
  const html = fs.readFileSync(new URL(file, root), 'utf8');
  const modules = [...html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(modules.length, file + ' must contain a module script');
  let source = modules.at(-1)[1];
  source = source.replace(/import \{ createClient \} from '[^']+';/,
    'const createClient = window.__createClient;');
  source = source.replace(/import \{[\s\S]*?\} from '\.\/va-portal-logic\.mjs(?:\?[^']+)?';/,
    `const {
      computeCapacity, sentLabel, checkedLabel, followUpLabel,
      normalizeRpc, safeLogLine, copyText, createSequencer,
      savePending, loadPending, clearPending, workState, senderState,
      passwordProblem, AWAITING_SEND, AWAITING_REPLY
    } = window.__logic;`);
  return { html, source };
}

function waitFor(check, message, timeout = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (check()) return resolve();
      } catch { /* the next poll may observe the completed render */ }
      if (Date.now() - started >= timeout) return reject(new Error('Timed out: ' + message));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function clientMock({ session, rpc, storage } = {}) {
  const channel = { on() { return channel; }, subscribe() { return channel; } };
  return {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: session || null } }),
      signInWithPassword: async () => ({ data: { session }, error: null }),
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => ({ error: null }),
      updateUser: async () => ({ error: null })
    },
    rpc: async (name, args) => rpc(name, args),
    storage: {
      from: (bucket) => storage?.(bucket) || {
        upload: async () => ({ data: {}, error: null }),
        remove: async () => ({ data: {}, error: null }),
        createSignedUrl: async (path) => ({ data: { signedUrl: 'https://example.test/' + path }, error: null })
      }
    },
    channel: () => channel
  };
}

function loadPage(file, client, overrides = {}) {
  const { html, source } = moduleSource(file);
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://console.example/' + file,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  window.__createClient = () => client;
  // Imported functions run in Node's realm, so inject the page's sessionStorage explicitly. The
  // production module naturally resolves the browser global itself.
  window.__logic = {
    ...logic,
    savePending: (entry, deps = {}) => logic.savePending(entry, { ...deps, storage: window.sessionStorage }),
    loadPending: (deps = {}) => logic.loadPending({ ...deps, storage: window.sessionStorage }),
    clearPending: (deps = {}) => logic.clearPending({ ...deps, storage: window.sessionStorage })
  };
  window.alert = overrides.alert || (() => {});
  window.confirm = overrides.confirm || (() => true);
  window.prompt = overrides.prompt || (() => null);
  window.open = overrides.open || (() => ({ opener: null, location: { replace() {} } }));
  // Production uses a same-tab location.assign. Cancel its explicit regression event here so
  // jsdom does not attempt an unsupported document navigation, while retaining the exact URL.
  window.addEventListener('dh:tiktok-navigation', (event) => {
    event.preventDefault();
    if (overrides.open) overrides.open(event.detail.url, '_self');
  });
  window.document.execCommand = overrides.execCommand || (() => true);
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: overrides.clipboard || { writeText: async () => {} }
  });
  window.URL.createObjectURL = () => 'blob:https://console.example/test';
  window.URL.revokeObjectURL = () => {};
  if (window.HTMLDialogElement) {
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    };
  }
  window.eval(source);
  return { dom, window, document: window.document, errors };
}

function vaBase({ newDms = [], replies = [], completed = 0 } = {}) {
  return {
    va: { name: 'Test VA' },
    new_dms: newDms,
    check_replies: replies,
    conversations: [],
    completed_today: completed,
    tier_1: { ready: newDms.filter((row) => row.tier_1).length }
  };
}

function moneySummary(total = 0) {
  return {
    today_total_cents: total,
    period_total_cents: total,
    approved_cents: total,
    pending_cents: 0,
    paid_cents: 0,
    today: {}, period: {}, rates: { dm_cents: 2, reply_cents: 10, signup_cents: 100 }
  };
}

test('VA flow copies one DM, records one send and refreshes into cooldown/empty state', async (t) => {
  const calls = [];
  let sent = false;
  const task = {
    task_id: 'task-1', handle: 'creator.one', profile_url: 'https://www.tiktok.com/@creator.one',
    dm_message: 'Hello creator', tier_1: true
  };
  const client = clientMock({
    session: { user: { id: 'va-user-1', email: 'va@example.test' } },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'dh_va_queue') return { data: vaBase({ newDms: sent ? [] : [task], completed: sent ? 1 : 0 }), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: sent ? 0 : 1, va_sent_today: sent ? 1 : 0, limiting_factor: sent ? 'NO_READY_TASKS' : 'READY' }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [{ account_id: 'acct-1', username: 'sender', status: 'ACTIVE', display_state: 'READY', daily_limit: 20, sent_today: sent ? 1 : 0, level: 1 }], va_sent_today: sent ? 1 : 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') return { data: { ok: true, account_id: 'acct-1', username: 'sender' }, error: null };
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(sent ? 2 : 0), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [], error: null };
      if (name === 'dh_tiktok_record_send') { sent = true; return { data: { ok: true, cooldown_seconds: 1 }, error: null }; }
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const page = loadPage('va.html', client);
  t.after(() => page.dom.window.close());

  await waitFor(() => !page.document.querySelector('#app').hidden && page.document.querySelector('#work-copy-dm'),
    'initial VA work card');
  assert.equal(page.document.querySelector('#remaining').textContent, '1');
  assert.equal(page.document.querySelector('#n-earn').textContent, '$0.00');

  page.document.querySelector('#work-copy-dm').click();
  await waitFor(() => page.document.querySelector('#work-sent'), 'send confirmation card');
  assert.equal(page.window.sessionStorage.getItem(logic.PENDING_KEY + ':va-user-1') !== null, true);

  page.document.querySelector('#work-sent').click();
  await waitFor(() => sent && page.document.querySelector('#work')?.textContent.includes('No tasks right now'),
    'post-send refresh', 3500);
  assert.equal(calls.filter((call) => call.name === 'dh_tiktok_record_send').length, 1);
  assert.equal(page.window.sessionStorage.getItem(logic.PENDING_KEY + ':va-user-1'), null);
  assert.equal(page.document.querySelector('#done').textContent, '1');
  assert.equal(page.document.querySelector('#n-earn').textContent, '$0.02');
  assert.deepEqual(page.errors, []);
});

test('VA primary DM button uses modern clipboard on iPhone when execCommand fails', async (t) => {
  const copied = [];
  const opened = [];
  let finishCopy;
  const task = {
    task_id: 'task-ios-copy', handle: 'ios.creator',
    profile_url: 'https://www.tiktok.com/@ios.creator', dm_message: 'DM copied on iPhone'
  };
  const client = clientMock({
    session: { user: { id: 'va-ios-copy', email: 'ios@example.test' } },
    rpc: async (name) => {
      if (name === 'dh_va_queue') return { data: vaBase({ newDms: [task] }), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: 1, va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [], va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') return { data: { ok: true, username: 'sender' }, error: null };
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [], error: null };
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const page = loadPage('va.html', client, {
    execCommand: () => false,
    clipboard: { writeText: (value) => {
      copied.push(value);
      return new Promise((resolve) => { finishCopy = resolve; });
    } },
    open: (url, target) => { opened.push({ url, target }); return { opener: null }; }
  });
  t.after(() => page.dom.window.close());

  await waitFor(() => page.document.querySelector('#work-copy-dm'), 'iPhone DM card');
  page.document.querySelector('#work-copy-dm').click();
  // The write starts inside the original tap, but TikTok must not open until it really succeeds.
  await waitFor(() => copied.length === 1, 'iPhone clipboard write starts');
  assert.deepEqual(copied, [task.dm_message]);
  assert.deepEqual(opened, []);
  finishCopy();
  await waitFor(() => page.document.querySelector('#work-sent') && opened.length === 1,
    'successful copy then iPhone send confirmation');
  assert.deepEqual(opened, [{ url: task.profile_url, target: '_self' }]);
  assert.deepEqual(page.errors, []);
});

for (const mode of ['denied', 'legacy']) {
  test('DM copy handles ' + mode + ' without false navigation or an empty selection', async (t) => {
    const task = { task_id: 'copy-edge', handle: 'creator', dm_message: 'Hello 👋\nYour personalised DM', profile_url: 'https://www.tiktok.com/@creator' };
    const opened = [];
    const client = clientMock({
      session: { user: { id: 'copy-edge-user', email: 'test@example.test' } },
      rpc: async (name) => {
        const data = {
          dh_va_queue: vaBase({ newDms: [task] }),
          dh_va_capacity: { ok: true, sendable_now: 1, va_sent_today: 0 },
          dh_tiktok_my_accounts: { accounts: [], va_sent_today: 0 },
          dh_tiktok_pick_account: { ok: true, username: 'sender' },
          dh_va_earnings_summary: moneySummary(), dh_va_pending_proof: null,
          dh_va_conversations: []
        };
        assert.ok(name in data, 'Unexpected RPC: ' + name);
        return { data: data[name], error: null };
      }
    });
    let selected = null;
    const page = loadPage('va.html', client, {
      clipboard: mode === 'legacy' ? {} : { writeText: async () => { throw new Error('denied'); } },
      execCommand: () => {
        const active = page.document.activeElement;
        selected = active.value?.slice(active.selectionStart, active.selectionEnd);
        return selected === task.dm_message;
      },
      open: (url) => opened.push(url)
    });
    t.after(() => page.dom.window.close());
    await waitFor(() => page.document.querySelector('#work-copy-dm'), 'DM card');
    page.document.querySelector('#work-copy-dm').click();
    await waitFor(() => page.document.querySelector('#work-sent'), 'pending send card');
    if (mode === 'denied') {
      assert.deepEqual(opened, []);
      assert.equal(selected, null, 'strict modern copy must not steal focus for legacy copy');
      assert.equal(page.document.querySelector('#manual-copy-text').value, task.dm_message);
      assert.match(page.document.body.textContent, /Automatic copy was blocked/);
    } else {
      assert.equal(selected, task.dm_message);
      assert.deepEqual(opened, [task.profile_url]);
    }
    assert.deepEqual(page.errors, []);
  });
}

test('VA cooldown counts down and unlocks the queued DM without losing it', async (t) => {
  let pickCalls = 0;
  const task = {
    task_id: 'task-cooldown', handle: 'waiting.creator',
    profile_url: 'https://www.tiktok.com/@waiting.creator', dm_message: 'Hello after the wait'
  };
  const client = clientMock({
    session: { user: { id: 'va-cooldown', email: 'cooldown@example.test' } },
    rpc: async (name) => {
      if (name === 'dh_va_queue') return { data: vaBase({ newDms: [task] }), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: pickCalls ? 1 : 0, va_sent_today: 0, limiting_factor: 'ACCOUNT_CAPACITY' }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [{ account_id: 'acct-c', username: 'sender', status: 'ACTIVE', display_state: pickCalls ? 'READY' : 'COOLDOWN', cooldown_seconds_left: pickCalls ? 0 : 1, daily_limit: 20, sent_today: 0, level: 1 }], va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') {
        pickCalls += 1;
        return pickCalls === 1
          ? { data: { ok: false, reason: 'COOLDOWN', next_cooldown_seconds: 1 }, error: null }
          : { data: { ok: true, account_id: 'acct-c', username: 'sender' }, error: null };
      }
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [], error: null };
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const page = loadPage('va.html', client);
  t.after(() => page.dom.window.close());

  await waitFor(() => page.document.querySelector('#work .countdown'), 'cooldown card');
  assert.match(page.document.querySelector('#work').textContent, /Short break between messages/);
  assert.equal(page.document.querySelector('#work .countdown').textContent, '00:01');
  await waitFor(() => page.document.querySelector('#work-copy-dm'), 'DM unlock after cooldown', 3000);
  assert.ok(pickCalls >= 2);
  assert.equal(page.document.querySelector('#work').textContent.includes('@waiting.creator'), true);
  assert.deepEqual(page.errors, []);
});

test('VA reply flow requires photo and manual classification, then clears pending state', async (t) => {
  const calls = [];
  let classified = false;
  let uploads = 0;
  const replyTask = {
    task_id: 'task-r', handle: 'reply.creator', profile_url: 'https://www.tiktok.com/@reply.creator',
    send_id: 'send-r',
    first_sent_at: '2026-09-16T12:00:00Z'
  };
  const client = clientMock({
    session: { user: { id: 'va-user-2', email: 'reply@example.test' } },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'dh_va_queue') return { data: vaBase({ replies: classified ? [] : [replyTask] }), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: 0, va_sent_today: 0, limiting_factor: 'NO_READY_TASKS' }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [], va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') return { data: { ok: false, reason: 'NO_ACCOUNTS' }, error: null };
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [], error: null };
      if (name === 'dh_reply_report') return { data: { ok: true, reply_event_id: 'reply-1', proof_check_id: 'proof-1', is_first: true }, error: null };
      if (name === 'dh_proof_upload') return { data: { ok: true }, error: null };
      if (name === 'dh_reply_classify') { classified = true; return { data: { ok: true }, error: null }; }
      throw new Error('Unexpected RPC ' + name);
    },
    storage: () => ({
      upload: async () => { uploads += 1; return { data: {}, error: null }; },
      remove: async () => ({ data: {}, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/proof' }, error: null })
    })
  });
  const page = loadPage('va.html', client);
  t.after(() => page.dom.window.close());

  await waitFor(() => page.document.querySelector('#work-reply-open'), 'reply-check card');
  assert.equal(page.document.querySelector('#work-reply-open').textContent, 'CHECK CHAT IN TIKTOK');
  page.document.querySelector('#work-reply-open').click();
  await waitFor(() => page.document.querySelector('#work-reply-yes'), 'reply confirmation card');
  page.document.querySelector('#work-reply-yes').click();
  assert.equal(page.document.querySelector('#replydlg').hasAttribute('open'), true);
  assert.equal(page.document.querySelector('#rp-send').disabled, true);

  const file = new page.window.File(['image'], 'reply.jpg', { type: 'image/jpeg' });
  Object.defineProperty(page.document.querySelector('#rp-file'), 'files', { configurable: true, value: [file] });
  page.document.querySelector('#rp-file').dispatchEvent(new page.window.Event('change'));
  assert.equal(page.document.querySelector('#rp-send').disabled, true, 'photo alone is insufficient');

  page.document.querySelector('#rp-cls button[data-v="INTERESTED"]').click();
  assert.equal(page.document.querySelector('#rp-send').disabled, false);
  page.document.querySelector('#rp-send').click();

  await waitFor(() => classified && !page.document.querySelector('#replydlg').hasAttribute('open'),
    'classified reply save');
  assert.equal(uploads, 1);
  assert.equal(calls.filter((call) => call.name === 'dh_reply_report').length, 1);
  assert.equal(calls.filter((call) => call.name === 'dh_reply_classify').length, 1);
  assert.equal(calls.find((call) => call.name === 'dh_reply_classify').args.p_classification, 'INTERESTED');
  assert.equal(page.window.sessionStorage.getItem(logic.PENDING_KEY + ':va-user-2'), null);
  assert.deepEqual(page.errors, []);
});

test('VA never creates a pending send for an invalid TikTok destination', async (t) => {
  let opened = 0;
  const task = {
    task_id: 'task-invalid', handle: 'bad/handle', profile_url: 'javascript:alert(1)',
    dm_message: 'This must not be recorded'
  };
  const client = clientMock({
    session: { user: { id: 'va-invalid', email: 'invalid@example.test' } },
    rpc: async (name) => {
      if (name === 'dh_va_queue') return { data: vaBase({ newDms: [task] }), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: 1, va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [], va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') return { data: { ok: true, username: 'sender' }, error: null };
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [], error: null };
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const page = loadPage('va.html', client, { open: () => { opened += 1; return null; } });
  t.after(() => page.dom.window.close());

  await waitFor(() => page.document.querySelector('#work-copy-dm'), 'invalid-destination card');
  page.document.querySelector('#work-copy-dm').click();
  assert.match(page.document.querySelector('#dm-msg').textContent, /no valid TikTok profile link/i);
  assert.equal(page.window.sessionStorage.getItem(logic.PENDING_KEY + ':va-invalid'), null);
  assert.equal(page.document.querySelector('#work-sent'), null);
  assert.equal(opened, 0);
  assert.deepEqual(page.errors, []);
});

test('VA Open TikTok retries the DM copy, then navigates to the real profile', async (t) => {
  const opened = [];
  const copied = [];
  const clipboardState = {};
  const task = {
    task_id: 'task-open-direct', handle: 'real.creator',
    profile_url: 'https://www.tiktok.com/@real.creator', dm_message: 'Hello directly'
  };
  const client = clientMock({
    session: { user: { id: 'va-open-direct', email: 'open@example.test' } },
    rpc: async (name) => {
      if (name === 'dh_va_queue') return { data: vaBase({ newDms: [task] }), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: 1, va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [], va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') return { data: { ok: true, username: 'sender' }, error: null };
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [], error: null };
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const page = loadPage('va.html', client, {
    execCommand: () => false,
    clipboard: clipboardState,
    open: (url, target) => {
      opened.push({ url, target });
      return { opener: {} };
    }
  });
  t.after(() => page.dom.window.close());

  await waitFor(() => page.document.querySelector('#work-copy-dm'), 'direct-open work card');
  page.document.querySelector('#work-copy-dm').click();
  await waitFor(() => page.document.querySelector('#work-open-tiktok'), 'manual Open TikTok action');
  assert.equal(page.document.querySelector('#work-open-tiktok').textContent,
    'TRY COPY AGAIN & OPEN TIKTOK');
  clipboardState.writeText = async (value) => { copied.push(value); };
  page.document.querySelector('#work-open-tiktok').click();
  await waitFor(() => opened.length === 1, 'retry copy then open TikTok');

  assert.deepEqual(copied, [task.dm_message]);
  assert.deepEqual(opened, [{ url: task.profile_url, target: '_self' }]);
  assert.notEqual(opened[0].url, 'about:blank');
  assert.equal(JSON.parse(page.window.sessionStorage.getItem(
    logic.PENDING_KEY + ':va-open-direct')).copy_ok, true);
  assert.deepEqual(page.errors, []);
});

test('VA Chats keeps reply classification, copy and affiliate-link actions connected', async (t) => {
  const calls = [];
  const copied = [];
  let classification = 'QUESTION';
  const chat = () => ({
    reply_event_id: 'reply-chat-1', task_id: 'task-chat-1', handle: 'chat.creator',
    profile_url: 'https://www.tiktok.com/@chat.creator', reported_at: '2026-09-17T10:00:00Z',
    classification, suggestion: 'Thanks — here are the details.', affiliate_available: true,
    affiliate_state: 'AVAILABLE'
  });
  const client = clientMock({
    session: { user: { id: 'va-chat', email: 'chat@example.test' } },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'dh_va_queue') return { data: vaBase(), error: null };
      if (name === 'dh_va_capacity') return { data: { ok: true, sendable_now: 0, va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_my_accounts') return { data: { accounts: [], va_sent_today: 0 }, error: null };
      if (name === 'dh_tiktok_pick_account') return { data: { ok: false, reason: 'NO_ACCOUNTS' }, error: null };
      if (name === 'dh_va_earnings_summary') return { data: moneySummary(), error: null };
      if (name === 'dh_va_pending_proof') return { data: null, error: null };
      if (name === 'dh_va_conversations') return { data: [chat()], error: null };
      if (name === 'dh_reply_classify') {
        classification = args.p_classification;
        return { data: { ok: true }, error: null };
      }
      if (name === 'dh_affiliate_invite_issue') {
        return { data: { ok: true, url: 'https://example.test/join/chat-1' }, error: null };
      }
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const page = loadPage('va.html', client, {
    clipboard: { writeText: async (value) => { copied.push(value); } }
  });
  t.after(() => page.dom.window.close());

  await waitFor(() => !page.document.querySelector('#app').hidden, 'VA portal');
  page.document.querySelector('#tab-conv').click();
  await waitFor(() => page.document.querySelector('[data-copy-reply]'), 'Chats tab');
  assert.equal(page.document.querySelector('#n-conv').textContent, '1');

  page.document.querySelector('[data-copy-reply]').click();
  await waitFor(() => copied.includes('Thanks — here are the details.')
    && /Reply copied/.test(page.document.querySelector('#chatmsg').textContent), 'reply copy');
  assert.match(page.document.querySelector('#chatmsg').textContent, /Reply copied/);

  page.document.querySelector('[data-cls] button[data-v="INTERESTED"]').click();
  await waitFor(() => calls.some((call) => call.name === 'dh_reply_classify'), 'reply classification');
  assert.equal(calls.find((call) => call.name === 'dh_reply_classify').args.p_classification, 'INTERESTED');

  await waitFor(() => page.document.querySelector('[data-invite]'), 'affiliate button after rerender');
  page.document.querySelector('[data-invite]').click();
  await waitFor(() => copied.includes('https://example.test/join/chat-1')
    && /Signup link copied/.test(page.document.querySelector('#chatmsg').textContent), 'affiliate-link copy');
  assert.match(page.document.querySelector('#chatmsg').textContent, /Signup link copied/);
  assert.deepEqual(page.errors, []);
});

test('owner flow renders exact payout cents, blocks unsafe links, pays and creates fragment invite', async (t) => {
  const calls = [];
  const handedOver = [];
  const payouts = [
    { va_id: 'va-1', va_name: 'Alice', approved_cents: 100, pending_cents: 10, paid_cents: 0, payable: true },
    { va_id: 'va-2', va_name: 'Bob', approved_cents: 250, pending_cents: 0, paid_cents: 500, payable: false }
  ];
  const client = clientMock({
    session: { user: { id: 'owner-1', email: 'owner@example.test' } },
    rpc: async (name, args) => {
      calls.push({ name, args });
      const data = {
        dh_owner_overview: { as_of: '2026-09-17T12:00:00Z', creators: 1, qualified: 1, route_email: 0, route_dm: 1, dms_sent: 0, replies: 0, interested: 0, affiliates: 0, customers: 0, revenue: 0, spend: 0 },
        dh_owner_funnel: [], dh_owner_full_funnel: null, dh_owner_attention: {},
        dh_owner_interested_creators: [], dh_owner_va_admin: { vas: [], rates: null, dm_template: 'Hello' },
        dh_owner_sourcing_settings: { sourcing_enabled: false, providers: [], territory: { countries: [] }, qualification: {}, clusters: [], budget: { ceiling: 100, spent: 25, remaining: 75, pct_used: 25, level: 'OK' } },
        dh_owner_integrations: {}, dh_tiktok_admin_overview: [], dh_admin_va_performance: [],
        dh_admin_proof_queue: [], dh_admin_payout_rows: payouts, dh_tiktok_template_metrics: [],
        dh_tiktok_block_rate_by_sender: [], dh_owner_supply_pipeline: null,
        dh_owner_directory_facets: { platforms: ['tiktok'], routes: ['MANUAL_DM'], statuses: ['READY'], categories: [], countries: [], vas: [] },
        dh_owner_directory: { total: 1, rows: [{ creator: 'Unsafe creator', handle: 'safe-handle', profile_url: 'javascript:alert(1)', platform: 'tiktok' }] }
      }[name];
      if (name === 'dh_admin_payout_mark_paid') return { data: { ok: true }, error: null };
      if (name === 'dh_owner_invite_va') return { data: { email: args.p_email, invite_code: 'invite code' }, error: null };
      if (name in {
        dh_owner_overview: 1, dh_owner_funnel: 1, dh_owner_full_funnel: 1, dh_owner_attention: 1,
        dh_owner_interested_creators: 1, dh_owner_va_admin: 1, dh_owner_sourcing_settings: 1,
        dh_owner_integrations: 1, dh_tiktok_admin_overview: 1, dh_admin_va_performance: 1,
        dh_admin_proof_queue: 1, dh_admin_payout_rows: 1, dh_tiktok_template_metrics: 1,
        dh_tiktok_block_rate_by_sender: 1, dh_owner_supply_pipeline: 1,
        dh_owner_directory_facets: 1, dh_owner_directory: 1
      }) return { data, error: null };
      throw new Error('Unexpected RPC ' + name);
    }
  });
  const prompt = (message, defaultValue) => {
    if (message === 'How was it paid? (e.g. Wise, PayPal)') return 'Wise';
    if (message === 'Transaction reference (optional)') return 'tx-1';
    if (message === 'VA name') return 'New VA';
    if (message === 'VA email') return 'new-va@example.test';
    if (message === 'Daily capacity (DMs per day)') return '40';
    if (message.startsWith('Send this link to')) { handedOver.push(defaultValue); return defaultValue; }
    return defaultValue ?? null;
  };
  const page = loadPage('index.html', client, {
    prompt,
    clipboard: { writeText: async () => { throw new Error('blocked'); } },
    execCommand: () => true
  });
  t.after(() => page.dom.window.close());

  await waitFor(() => !page.document.querySelector('#app').hidden
    && page.document.querySelector('#creatorcount').textContent !== '—', 'owner dashboard');
  assert.match(page.document.querySelector('#payouts').textContent, /Total owed\$3\.50/);
  assert.equal(page.document.querySelector('#creators a'), null, 'javascript profile URL is never linked');

  page.document.querySelector('#payouts button[data-pay]').click();
  await waitFor(() => calls.some((call) => call.name === 'dh_admin_payout_mark_paid'), 'payout action');
  const paid = calls.find((call) => call.name === 'dh_admin_payout_mark_paid');
  assert.equal(paid.args.p_va, 'va-1');
  assert.equal(paid.args.p_method, 'Wise');
  assert.equal(paid.args.p_reference, 'tx-1');

  await waitFor(() => calls.filter((call) => call.name === 'dh_owner_overview').length >= 2
    && page.document.querySelector('#invite'), 'invite button after payout refresh');
  page.document.querySelector('#invite').click();
  await waitFor(() => handedOver.length === 1, 'invite handoff');
  assert.match(handedOver[0], /\/va\.html#invite=invite%20code$/);
  assert.equal(handedOver[0].includes('?invite='), false);
  await waitFor(() => calls.filter((call) => call.name === 'dh_owner_overview').length >= 3,
    'owner refresh after invite');
  assert.deepEqual(page.errors, []);
});
