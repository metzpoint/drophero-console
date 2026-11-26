const types = {
  affiliate_invitation: 'Affiliate invitation', onboarding: 'Onboarding',
  referral_link: 'Referral link', affiliate_support: 'Affiliate support', outreach_followup: 'Outreach follow-up'
};
const affiliateStates = {
  registered: 'Registered', unmatched: 'No matching registration',
  ambiguous: 'Several possible matches', archived: 'Archived', unconfirmed: 'Registration unconfirmed'
};
const delivery = {
  queued: 'Queued for sending', sending: 'Sending…', sent: 'Accepted by the mail server',
  failed: 'Sending failed. Your draft is ready to retry.', uncertain: 'Sending could not be confirmed. Check Sent before trying again.'
};
const formatDate = value => value ? new Date(value).toLocaleString(undefined, {
  dateStyle: 'medium', timeStyle: 'short'
}) : '';

function node(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  Object.assign(element, props);
  element.append(...children.flat().filter(child => child !== null && child !== undefined));
  return element;
}

const btn = (title, run, props = {}) => node('button', { type: 'button', onclick: run, ...props }, title);
const picker = (name, options) => {
  const select = node('select', {}, options.map(([value, label]) => node('option', { value }, label)));
  select.setAttribute('aria-label', name);
  return select;
};
const field = (label, input) => node('label', {}, label, input);

function fromLine(value) {
  return node('p', { className: 'mail-from' }, node('strong', {}, 'From '), value);
}

function formStatus(text = '') {
  const status = node('p', { className: 'status', textContent: text });
  status.setAttribute('role', 'status');
  return status;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export async function managerMail(call) {
  const options = await call('dh_manager_mail_options');
  const mailboxes = options.mailboxes;
  const area = node('section', { className: 'manager-mail' });
  if (!mailboxes.length) {
    area.append(node('h2', {}, 'Email'), node('p', {}, 'Mailbox access is being configured.'));
    return area;
  }

  const statuses = [['open', 'Needs reply'], ['waiting', 'Waiting for reply'], ['all', 'All email']];
  const list = node('div', { className: 'mail-list' });
  const conversation = node('section', { className: 'mail-detail' });
  const affiliate = node('details', { className: 'mail-affiliate', open: true });
  const tabs = node('nav', { className: 'tabs' });
  tabs.setAttribute('aria-label', 'Email views');
  const search = node('input', { type: 'search', placeholder: 'Search email', maxLength: 150 });
  search.setAttribute('aria-label', 'Search email');
  const mailbox = picker('Mailbox', [['', 'All mailboxes'], ...mailboxes.map(row => [row.mailbox, row.mailbox])]);
  const mailType = picker('Mail type', [['', 'All mail types'], ...options.types.sort().map(type => [type, types[type] || type])]);
  const direction = picker('Direction', [['', 'Received and sent'], ['received', 'Received'], ['sent', 'Sent']]);
  const filters = node('div', { className: 'mail-filters' }, search, mailType, mailbox, direction);
  const notice = formStatus();
  const back = btn('Back to conversations', () => {
    area.classList.remove('mail-selected');
    list.querySelector('[aria-current=true]')?.focus();
  }, { className: 'mail-back' });
  const state = { view: 'open', page: 0, listRequest: 0, detailRequest: 0, thread: null, searchTimer: null };
  const drafts = new Map();

  if (mailboxes.some(row => row.sync_error || !row.history_ready)) {
    notice.textContent = 'Some mailbox history is still syncing or unavailable. Use the mailbox filter to review each address.';
  }
  area.append(node('header', { className: 'mail-heading' }, node('h2', {}, 'Email'),
    btn('New email', compose, { disabled: !mailboxes.some(row => row.send_enabled) })),
  notice, tabs, filters, node('div', { className: 'mail-layout' }, list, conversation, affiliate));
  conversation.append(node('p', { className: 'muted' }, 'Select a conversation.'));
  affiliate.hidden = true;

  for (const [view, label] of statuses) {
    const tab = btn(label, () => {
      state.view = view;
      state.page = 0;
      void reload();
    });
    tab.dataset.view = view;
    tabs.append(tab);
  }
  for (const filter of [mailbox, mailType, direction]) {
    filter.onchange = () => { state.page = 0; void reload(); };
  }
  search.oninput = () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => { state.page = 0; void reload(); }, 250);
  };

  async function reload() {
    const version = ++state.listRequest;
    for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.view === state.view));
    list.setAttribute('aria-busy', 'true');
    try {
      const rows = await call('dh_manager_mail_list', {
        p_state: state.view, p_search: search.value, p_mailbox: mailbox.value || null,
        p_type: mailType.value || null, p_direction: direction.value || null, p_page: state.page
      });
      if (version !== state.listRequest) return;
      const cards = rows.slice(0, 40).map(row => {
        const card = btn('', () => void open(row.id, true), { className: 'mail-card' });
        card.append(node('strong', {}, row.subject || '(No subject)'),
          node('span', {}, row.contact_email || row.mailbox),
          node('small', {}, formatDate(row.last_at), row.mail_type ? ' · ' + (types[row.mail_type] || row.mail_type) : ''));
        if (row.id === state.thread) card.setAttribute('aria-current', 'true');
        card.dataset.thread = row.id;
        return card;
      });
      const pager = node('div', { className: 'mail-pager' },
        state.page > 0 ? btn('Previous', () => { state.page--; void reload(); }) : null,
        rows.length > 40 ? btn('Next', () => { state.page++; void reload(); }) : null);
      list.replaceChildren(...cards.length ? cards : [node('p', { className: 'muted' }, 'No matching conversations.')], pager);
    } catch {
      if (version === state.listRequest) list.replaceChildren(node('p', {}, 'Email could not be loaded.'), btn('Try again', reload));
    } finally {
      if (version === state.listRequest) list.removeAttribute('aria-busy');
    }
  }

  async function open(id, focus = false) {
    const version = ++state.detailRequest;
    state.thread = id;
    for (const card of list.querySelectorAll('[data-thread]')) {
      if (card.dataset.thread === id) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }
    area.classList.add('mail-selected');
    affiliate.hidden = true;
    conversation.replaceChildren(back, formStatus('Loading conversation…'));
    try {
      const data = await call('dh_manager_mail_thread', { p_thread: id });
      if (version !== state.detailRequest) return;
      const subject = node('h3', { tabIndex: -1 }, data.thread.subject || '(No subject)');
      const history = node('div', { className: 'mail-history' });
      const s = formStatus(data.job ? delivery[data.job.state] || '' : '');
      const body = node('textarea', { rows: 5, maxLength: 30000, required: true,
        value: drafts.get(id)?.body ?? (data.job?.state === 'failed' ? data.job.body : '') });
      body.oninput = () => drafts.set(id, { body: body.value });
      const locked = ['queued', 'sending', 'uncertain'].includes(data.job?.state);
      const sendStatus = formStatus();
      const actions = node('div', { className: 'actions' });
      const replyForm = node('form', {}, fromLine(data.thread.mailbox), field('Reply', body), actions, sendStatus);
      const send = (close, click) => submit({
        control: click.currentTarget, status: sendStatus, draftKey: id, body,
        args: { p_thread: id, p_reply_message: data.reply_message, p_close: close }
      });
      const sendButton = btn('Send', click => void send(false, click));
      actions.append(sendButton, btn('Send and close', click => void send(true, click)));
      replyForm.onsubmit = event => { event.preventDefault(); sendButton.click(); };

      const close = btn('Mark closed', async event => {
        event.preventDefault();
        close.disabled = true;
        try {
          await call('dh_manager_mail_close', { p_thread: id, p_seen_at: data.thread.last_at });
          await Promise.all([open(id), reload()]);
        } catch {
          s.textContent = 'The conversation changed. Refresh it and try again.';
        } finally { close.disabled = false; }
      }, { disabled: locked });
      const refresh = btn('Refresh conversation', () => void open(id));
      conversation.replaceChildren(back, subject, s,
        node('div', { className: 'actions' }, data.thread.state === 'closed' ? null : close, refresh), history,
        !locked && data.send_enabled && data.reply_message ? replyForm : null);
      if (!locked && data.reply_message && !data.send_enabled) {
        conversation.append(node('p', { className: 'muted' }, 'Sending from this mailbox is unavailable.'));
      }
      history.append(...historyPage(data.messages, id, version));
      renderAffiliate(data.affiliate, !locked && data.send_enabled && data.reply_message ? body : null);
      if (focus) subject.focus();
      if (['queued', 'sending'].includes(data.job?.state)) {
        setTimeout(() => {
          if (area.isConnected && version === state.detailRequest) {
            void Promise.all([open(id), reload()]);
          }
        }, 8000);
      }
    } catch {
      if (version === state.detailRequest) conversation.replaceChildren(back, formStatus('Conversation could not be loaded.'), btn('Try again', () => void open(id)));
    }
  }

  function historyPage(messages, thread, version) {
    const visible = messages.slice(-30);
    if (messages.length <= 30) return visible.map(renderMessage);
    const older = btn('Load older emails', async () => {
      older.disabled = true;
      try {
        const response = await call('dh_manager_mail_thread', { p_thread: thread, p_before: visible[0].id });
        if (version === state.detailRequest) older.replaceWith(...historyPage(response.messages, thread, version));
      } catch {
        older.textContent = 'Retry loading older emails';
        older.disabled = false;
      }
    });
    return [older, ...visible.map(renderMessage)];
  }

  function renderMessage(email) {
    const attachments = email.attachments.map(file => {
      if (!file.available) return node('li', {}, file.filename, ' · preview unavailable');
      const download = btn(file.filename, async () => {
        download.disabled = true;
        try {
          const result = await call('dh_manager_mail_attachment', { p_message: email.id, p_attachment: file.id });
          const content = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
          const link = node('a', { href: url, download: result.filename.replace(/[\\/]/g, '_') });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
          download.textContent = file.filename + ' · retry download';
        } finally { download.disabled = false; }
      });
      return node('li', {}, download);
    });
    return node('article', { className: 'mail-message' },
      node('strong', {}, (email.direction === 'sent' ? 'Sent' : 'Received') + ' · ' + (email.sender || 'Unknown sender')),
      node('small', {}, formatDate(email.occurred_at), email.folder ? ' · ' + email.folder : ''),
      node('small', {}, email.recipients.length ? 'To ' + email.recipients.join(', ') : ''),
      node('div', { className: 'mail-body' }, email.body || '(No text content)'),
      attachments.length ? node('ul', {}, attachments) : null);
  }

  function renderAffiliate(details, body) {
    const link = safeLink(details?.referral_link);
    affiliate.hidden = false;
    affiliate.replaceChildren(node('summary', {}, 'FirstPromoter'),
      node('p', {}, affiliateStates[details?.status] || 'Registration status unavailable'),
      details?.creator ? node('p', {}, details.creator) : null,
      link ? node('p', { className: 'mail-referral' }, link) : null,
      link && body ? btn('Insert referral link', () => {
        body.setRangeText(link, body.selectionStart, body.selectionEnd, 'end');
        body.dispatchEvent(new Event('input'));
        body.focus();
      }) : null);
    affiliate.open = !matchMedia('(max-width: 760px)').matches;
  }

  function compose() {
    state.detailRequest++;
    state.thread = null;
    area.classList.add('mail-selected');
    affiliate.hidden = true;
    const previous = drafts.get('new');
    const subject = node('input', { required: true, maxLength: 998, value: previous?.subject || '' });
    const recipient = node('input', { type: 'email', required: true, maxLength: 254, value: previous?.recipient || '' });
    const body = node('textarea', { rows: 6, required: true, maxLength: 30000, value: previous?.body || '' });
    const type = picker('Mail type', Object.entries(types));
    type.value = previous?.type || 'affiliate_support';
    const available = mailboxes.filter(row => row.provider === 'graph' && row.send_enabled);
    const original = picker('Original outreach mailbox', available.map(row => [row.mailbox, row.mailbox]));
    if (previous?.mailbox) original.value = previous.mailbox;
    const originalField = field('Original outreach mailbox', original);
    const from = fromLine('');
    const status = formStatus();
    const send = node('button', { type: 'submit' }, 'Send');
    const form = node('form', {}, field('Mail type', type), originalField, from, field('To', recipient),
      field('Subject', subject), field('Message', body), send, status);
    const mailboxForType = () => type.value === 'outreach_followup' ? original.value : 'affiliate@drophero.app';
    const showFrom = () => {
      from.lastChild.textContent = mailboxForType() || 'Unavailable';
      originalField.hidden = type.value !== 'outreach_followup';
      send.disabled = !mailboxes.some(row => row.mailbox === mailboxForType() && row.send_enabled);
      status.textContent = send.disabled ? 'Sending from this mailbox is unavailable.' : '';
    };
    form.addEventListener('input', () => drafts.set('new', {
      body: body.value, subject: subject.value, recipient: recipient.value, mailbox: original.value, type: type.value
    }));
    type.onchange = original.onchange = showFrom;
    form.onsubmit = event => {
      event.preventDefault();
      void submit({ control: send, status, draftKey: 'new', body, args: {
        p_type: type.value, p_mailbox: mailboxForType(), p_to: recipient.value, p_subject: subject.value
      } });
    };
    conversation.replaceChildren(back, node('h3', {}, 'New email'), form);
    showFrom();
    recipient.focus();
  }

  async function submit({ control, status, draftKey, body, args }) {
    if (!body.reportValidity()) return;
    const previous = drafts.get(draftKey);
    const params = {
      p_thread: null, p_reply_message: null, p_type: null, p_mailbox: null, p_to: null, p_subject: null,
      p_close: false, ...args, p_body: body.value.replace(/\r\n?/g, '\n')
    };
    const signature = JSON.stringify(params);
    const pending = previous?.signature === signature ? previous : { ...previous, request: crypto.randomUUID(), signature };
    drafts.set(draftKey, { ...pending, body: body.value });
    const controls = Array.from(body.form.querySelectorAll('button'));
    controls.forEach(button => { button.disabled = true; });
    status.textContent = 'Queuing email…';
    try {
      const result = await call('dh_manager_mail_send', { p_request: pending.request, ...params });
      drafts.delete(draftKey);
      await Promise.all([open(result.thread), reload()]);
    } catch (error) {
      const cause = String(error?.message ?? '');
      status.textContent = cause.includes('MAIL_THREAD_CHANGED') ? 'A newer email arrived. Refresh the conversation before replying.'
        : cause.includes('MAIL_RECIPIENT_SUPPRESSED') ? 'This recipient is on the do-not-contact list.'
          : cause.includes('ORIGINAL_OUTREACH_MAILBOX_REQUIRED') ? 'Choose the mailbox with the original outreach conversation.'
            : cause.includes('MAILBOX_SEND_UNAVAILABLE') ? 'Sending from this mailbox is unavailable.'
            : 'Could not confirm the queue request. Your draft is still here.';
    } finally {
      if (control.isConnected) controls.forEach(button => { button.disabled = false; });
    }
  }

  await reload();
  return area;
}
