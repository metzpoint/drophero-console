import { createClient } from './vendor/supabase.mjs';

const $ = id => document.getElementById(id);
const formatDate = value => value ? new Intl.DateTimeFormat('en', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'
}).format(new Date(value)) + ' UTC' : '—';
const labelFor = value => String(value ?? '').toLowerCase().replaceAll('_', ' ').replace(/^./, x => x.toUpperCase());
const amount = (cents, currency) => new Intl.NumberFormat('en', {
  style: 'currency', currency
}).format((cents ?? 0) / 100);
const labels = {
  claimed_dms: 'Claimed DMs',
  verified_replies: 'Verified replies',
  attributed_signups: 'Attributed signups',
  proofs_reviewed: 'Proofs reviewed'
};

function el(tag, properties = {}, ...children) {
  const element = document.createElement(tag);
  Object.assign(element, properties);
  element.append(...children.flat(Infinity).filter(child => child != null));
  return element;
}

const paragraph = (text, className = '') => el('p', { className }, text);
const heading = text => el('h2', {}, text);
const button = (text, onclick) => el('button', { type: 'button', onclick }, text);
const panel = (...children) => el('section', { className: 'panel' }, children);
const entry = (...children) => el('div', { className: 'entry' }, children);
const field = (name, input) => el('label', {}, name, input);
const select = choices => el('select', {}, choices.map(([value, name]) => el('option', { value }, name)));
const notes = (value = '') => el('textarea', { maxLength: 3000, value });
const message = error => String(error?.message || error || 'Something went wrong. Please try again.');
const cards = data => el('div', { className: 'kpis' }, Object.entries(data).map(
  ([name, value]) => el('div', { className: 'kpi' }, el('strong', {}, String(value ?? 0)), el('small', {}, name))
));

function table(headers, rows, empty = 'No records to show.') {
  if (!rows.length) return paragraph(empty, 'muted');
  return el('div', { className: 'scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map(title => el('th', { scope: 'col' }, title)))),
    el('tbody', {}, rows.map(row => el('tr', {}, row.map(value => el('td', {}, value ?? '—')))))
  ));
}

function details(title, load) {
  const body = el('div');
  const node = el('details', { className: 'panel' }, el('summary', {}, title), body);
  node.addEventListener('toggle', async () => {
    if (!node.open || body.dataset.loaded) return;
    body.dataset.loaded = 'true';
    body.replaceChildren(paragraph('Loading…', 'muted'));
    try {
      body.replaceChildren(...await load());
    } catch (error) {
      body.replaceChildren(paragraph(message(error), 'error'));
      delete body.dataset.loaded;
    }
  });
  return node;
}

function metricTable(snapshot) {
  const keys = Object.keys(labels);
  return table(['Team member', ...keys.map(k => labels[k])], snapshot.staff.map(
    row => [row.name, ...keys.map(k => row[k])]
  ), 'No staff activity in this period.');
}
const dateSpan = report => {
  const last = new Date(report.end_date + 'T00:00:00Z');
  last.setUTCDate(last.getUTCDate() - 1);
  const end = last.toISOString().slice(0, 10);
  return report.start_date === end ? end + ' UTC' : report.start_date + ' to ' + end + ' UTC';
};

export function startOperations(url, key) {
  const db = createClient(url, key);
  const state = { role: null, page: location.hash === '#start' ? 'start' : 'overview', loginVersion: 0, pageVersion: 0 };
  const followupFilter = { sender: '', stage: 'REVIEW', search: '' };
  const reportDate = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const reportPeriod = select([['DAILY', 'Daily'], ['WEEKLY', 'Weekly']]);
  let refreshMessage = '';

  async function call(name, args = {}) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    if (data?.ok === false) throw new Error(labelFor(data.reason || data.error || 'Action could not be completed'));
    return data;
  }

  function status(id, value, error = false) {
    const node = $(id);
    node.textContent = value;
    node.classList.toggle('error', error);
  }

  function action(title, fields, submit, success) {
    const dialog = $('action-dialog');
    if (dialog.open) dialog.close();
    $('action-title').textContent = title;
    const form = $('action-form');
    const feedback = el('p', { className: 'status', role: 'status' });
    const save = el('button', { type: 'submit', className: 'primary' }, 'Save');
    form.replaceChildren(...fields, feedback, el('div', { className: 'actions' },
      save, button('Cancel', () => dialog.close())));
    form.onsubmit = async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        await submit();
        dialog.close();
        refreshMessage = typeof success === 'function' ? success() : success;
        await openPage();
      } catch (error) {
        feedback.textContent = message(error);
        feedback.classList.add('error');
      } finally {
        save.disabled = false;
      }
    };
    dialog.showModal();
  }

  function addNotice(employee, type = 'NOTICE') {
    const title = el('input', { required: true, maxLength: 120 });
    const body = notes();
    body.required = true;
    body.minLength = 8;
    const audience = employee?.name ?? 'the team';
    const fields = [field('Message', body)];
    if (type === 'NOTICE') fields.unshift(field('Title', title));
    action(type === 'WARN' ? 'Warn ' + audience : 'Post a portal notice for ' + audience, fields,
      () => call('dh_manager_staff_action', {
        p_action: type, p_va: employee?.va_id ?? null, p_note: body.value, p_title: title.value
      }), type === 'WARN' ? 'Warning posted.' : 'Notice posted.');
  }

  function staffChange(person, type) {
    const note = notes();
    note.required = true;
    note.minLength = 8;
    const fields = [field('Reason for this change', note)];
    const capacity = el('input', { type: 'number', min: '0', step: '1', required: true, value: person.daily_capacity });
    if (type === 'CAPACITY') fields.unshift(field('Daily capacity', capacity));
    action((type === 'CAPACITY' ? 'Change daily capacity for' : labelFor(type)) + ' ' + person.name, fields,
      () => call('dh_manager_staff_action', {
        p_action: type, p_va: person.va_id, p_note: note.value,
        p_capacity: type === 'CAPACITY' ? capacity.valueAsNumber : null
      }), type === 'UNBLOCK' ? 'Block reviewed. Check the employee’s current status below.' : 'Team record updated.');
  }

  async function showPhoto(bucket, path, target) {
    target.replaceChildren(paragraph('Loading screenshot…'));
    const { data, error } = await db.storage.from(bucket).createSignedUrl(path, 120);
    if (error) {
      target.replaceChildren(paragraph('Screenshot unavailable. Review the archived text where available.', 'error'));
      return;
    }
    const screenshot = el('img', { className: 'evidence', alt: 'Submitted proof screenshot', src: data.signedUrl });
    screenshot.onerror = () => target.replaceChildren(paragraph('Screenshot could not load.', 'error'));
    target.replaceChildren(screenshot);
  }

  const photoViewer = (bucket, path) => {
    if (!path) return paragraph('No screenshot submitted.', 'muted');
    const box = el('div');
    return el('div', {}, button('View screenshot', () => void showPhoto(bucket, path, box)), box);
  };

  async function overview() {
    const [activity, leads, { rows: alerts }] = await Promise.all([
      call('dh_owner_va_activity'), call('dh_owner_hot_leads_summary'), call('dh_owner_coaching_alerts')
    ]);
    const total = key => activity.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
    return [
      cards({
        'Claimed DMs today': total('sent_today'), 'Claimed DMs in 7 days': total('sent_7d'),
        'Open interested creators': leads.open_total, 'Overdue for review': leads.overdue24
      }),
      panel(heading('Team performance'), table(
        ['Team member', 'Today', 'Last 7 days', 'Verified responses', 'Response rate', 'Proofs to review', 'Last activity'],
        activity.map(row => [row.va_name, row.sent_today, row.sent_7d, row.verified_responses,
          row.response_pct + '%', row.proofs_need_review, formatDate(row.last_work_at)]))),
      panel(heading('Coaching alerts'), alerts.length ? alerts.map(row => entry(
        el('h3', {}, row.title),
        row.name ? paragraph(row.name, 'muted') : null,
        paragraph(row.guidance ?? '', 'copy'),
        row.acknowledged_at ? paragraph('Acknowledged ' + formatDate(row.acknowledged_at), 'muted') :
          button('Acknowledge', () => action('Acknowledge coaching alert', [paragraph(row.title)],
            () => call('dh_owner_coaching_ack', { p_id: row.id }), 'Coaching alert acknowledged.'))
      )) : paragraph('No open coaching alerts.', 'muted'))
    ];
  }

  function historyTable(history) {
    return table(['Time', 'Action', 'Recipient', 'Notes', 'Read'], history.map(row => [
      formatDate(row.happened_at), labelFor(row.action), row.name ?? (row.action === 'NOTICE' ? 'Team' : '—'),
      [row.notice_title ? el('strong', {}, row.notice_title + ' ') : null, row.note],
      row.notice_title ? row.acknowledgments : '—'
    ]));
  }

  async function team() {
    const { staff, history } = await call('dh_manager_team');
    return [
      panel(heading('Employees'), table(['Team member', 'Status', 'Daily capacity', 'Actions'],
        staff.map(person => {
          const actions = [];
          if (person.manageable) {
            if (person.active) {
              actions.push(button('Warn', () => addNotice(person, 'WARN')));
              actions.push(button('Block', () => staffChange(person, 'BLOCK')));
            }
            if (person.manager_block || person.outreach_block) actions.push(button('Unblock', () => staffChange(person, 'UNBLOCK')));
            actions.push(button('Set capacity', () => staffChange(person, 'CAPACITY')));
          }
          const teamStatus = person.manager_block || person.outreach_block ? 'Blocked' : person.active ? 'Active' : 'Inactive';
          return [person.name, teamStatus, person.daily_capacity, el('div', { className: 'actions' }, actions)];
        }))),
      panel(heading('Recent staff actions'), historyTable(history))
    ];
  }

  function startHere() {
    return [
      panel(heading('Your role in Outreach'),
        paragraph('Work from Operations with your own DropHero login. Each DMer works in their own VA portal and sends from the original TikTok account. You review the conversation, write the answer and hand it to that DMer.'),
        paragraph('Work within your five hours per week, Monday to Friday. Start with replies waiting for your review, then check pending proof and team issues.'),
        button('Open creator follow-up drafts', () => void openPage('messages'))),
      panel(heading('Prepare an answer for a DMer'),
        el('ol', {},
          el('li', {}, 'Open Communications, then Creator follow-up drafts. Choose Needs review and filter by assigned DMer. Start with the oldest creator reply.'),
          el('li', {}, 'Open the creator card. Check the latest incoming message, previous replies, the assigned DMer, and the listed TikTok account.'),
          el('li', {}, 'Select Edit draft. Write a short reply that answers the creator’s question. Check suggested wording against the conversation and use only terms you can confirm.'),
          el('li', {}, 'Choose Queue for assigned DMer and save. The draft appears in the assigned DMer’s VA portal. They copy it, send it in the original TikTok conversation, then confirm the send in their portal.'),
          el('li', {}, 'Use Awaiting DMer to check handoffs. Use Sent to see the DMer’s recorded confirmation.')),
        paragraph('If a creator replied again, the sender is unclear, or there is no matching draft, ask the DMer to verify the latest chat and flag the issue in your report. Use a targeted team notice for a quick follow-up.')),
      panel(heading('Your first shift'),
        el('ol', {},
          el('li', {}, 'Open Communications and review the oldest open creator replies. Queue the answers you can verify for the assigned DMers.'),
          el('li', {}, 'Open Quality control. Review submitted proof and record what needs correction.'),
          el('li', {}, 'Save a Daily report with the drafts queued, proofs reviewed, and anything that needs a decision. Use Weekly for the end-of-week summary.')),
        paragraph('Use Payout preparation to give the owner a reviewed balance and a note. The owner approves and records final payments.'),
        el('div', { className: 'actions' },
          button('Open Quality control', () => void openPage('quality')),
          button('Open Reports', () => void openPage('reports'))))
    ];
  }

  function canQueueDraft(row) {
    return ['READY_FOR_REVIEW', 'NEEDS_INVESTIGATION', 'APPROVED'].includes(row.status)
      && !row.new_reply_since_draft && !row.copied_at && Boolean(row.sender_account && row.dmer);
  }

  function reviewDraft(row) {
    const copy = notes(row.approved_text || row.draft_text || '');
    const note = notes();
    const choices = [];
    if (canQueueDraft(row)) choices.push(['APPROVE', 'Queue for assigned DMer']);
    if (['DECLINED', 'NEEDS_INVESTIGATION'].includes(row.status)
        || (row.status === 'ALREADY_HANDLED' && row.verify_result === 'NOT_SENT')) {
      choices.push(['REOPEN', 'Reopen draft']);
    }
    if (row.status !== 'DECLINED') {
      choices.push(['REJECT', 'Return for review'], ['DECLINE', 'Close without follow-up']);
    }
    const decision = select(choices);
    action('Edit draft for ' + (row.dmer || 'review'), [
      paragraph((row.handle || 'Creator') + ' · ' + (row.sender_account || 'TikTok account needs verification'), 'muted'),
      field('Decision', decision), field('Reply draft', copy), field('Review note', note)
    ], async () => {
      if (decision.value === 'APPROVE' && !copy.value.trim()) throw new Error('Enter the reply before queuing it.');
      await call('dh_owner_conversion_review', {
        p_draft_id: row.draft_id, p_action: decision.value, p_text: copy.value, p_note: note.value || null
      });
    }, () => decision.value === 'APPROVE' ? 'Queued for ' + row.dmer + ' to send in TikTok.' : 'Draft decision saved.');
  }

  function creatorConversation(lead) {
    return details((lead.handle || lead.display_name || 'Creator') + ' · ' + (lead.va_name ?? 'Unassigned'), async () => {
      const history = await call('dh_manager_thread', { p_task: lead.task_id });
      return [
        paragraph('Latest reply · ' + formatDate(lead.replied_at), 'muted'),
        paragraph(lead.said ?? 'No reply text available.', 'copy'),
        lead.suggestion ? paragraph('Suggested reply: ' + lead.suggestion, 'copy') : null,
        lead.storage_path ? photoViewer('proofs', lead.storage_path) : null,
        ...history.map(row => entry(
          el('small', {}, labelFor(row.direction) + ' · ' + formatDate(row.occurred_at)), paragraph(row.body, 'copy')
        )),
        button('Mark handled', () => {
          const note = notes();
          note.required = true;
          note.minLength = 8;
          action('Mark conversation handled', [field('What was done?', note)],
            () => call('dh_manager_close_interested', { p_task: lead.task_id, p_note: note.value }), 'Conversation marked handled.');
        })
      ].filter(Boolean);
    });
  }

  async function messages() {
    const [{ staff, history }, interested, queue] = await Promise.all([
      call('dh_manager_team'), call('dh_owner_interested_creators'), call('dh_owner_conversion_queue', { p_limit: 1000 })
    ]);
    const recipients = staff.filter(s => s.manageable && s.active);
    const recipient = select([['', 'All active team members'], ...recipients.map(s => [s.va_id, s.name])]);
    const creators = interested.map(creatorConversation);
    const rows = queue.rows;
    const senders = [...new Set(rows.map(row => row.dmer).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const sender = select([['', 'All DMers'], ...senders.map(name => [name, name])]);
    const stages = {
      REVIEW: ['READY_FOR_REVIEW', 'NEEDS_INVESTIGATION'],
      QUEUED: ['APPROVED'],
      SENT: ['SENT']
    };
    const stage = select([['REVIEW', 'Needs review'], ['QUEUED', 'Awaiting DMer'], ['SENT', 'Sent'], ['ALL', 'All statuses']]);
    const search = el('input', { type: 'search', placeholder: 'Creator handle or name', value: followupFilter.search });
    sender.value = senders.includes(followupFilter.sender) ? followupFilter.sender : '';
    stage.value = followupFilter.stage;
    const count = el('p', { className: 'muted', role: 'status' });
    const list = el('div');
    const draftCards = new Map();
    const draftCard = row => {
      if (draftCards.has(row.draft_id)) return draftCards.get(row.draft_id);
      const card = details((row.handle || row.creator_name || 'Creator') + ' · ' + (row.dmer || 'DMer unverified') + ' · ' + labelFor(row.status),
        async () => [
          paragraph('TikTok account · ' + (row.sender_account || 'Verify with the DMer'), 'muted'),
          paragraph('Latest reply · ' + formatDate(row.latest_reply_at), 'muted'),
          paragraph(row.latest_reply || 'No creator reply text.', 'copy'),
          ...row.history.map(m => entry(el('small', {}, labelFor(m.dir) + ' · ' + formatDate(m.at)), paragraph(m.text, 'copy'))),
          paragraph(row.approved_text || row.draft_text || 'No draft text.', 'copy'),
          row.new_reply_since_draft ? paragraph('The creator has a newer reply. Wait for an updated draft.', 'error') : null,
          row.sent_confirmed_at ? paragraph('DM sent · Confirmed by the DMer ' + formatDate(row.sent_confirmed_at), 'muted') : null,
          !['SENT', 'REGISTERED'].includes(row.status) && !row.copied_at
            && (row.status !== 'ALREADY_HANDLED' || row.verify_result === 'NOT_SENT') ?
            button('Edit draft', () => reviewDraft(row)) : null
        ].filter(Boolean));
      draftCards.set(row.draft_id, card);
      return card;
    };
    function renderDrafts() {
      Object.assign(followupFilter, { sender: sender.value, stage: stage.value, search: search.value });
      const query = search.value.trim().toLowerCase();
      const filtered = rows.filter(row => (stage.value === 'ALL' || stages[stage.value].includes(row.status))
        && (!sender.value || row.dmer === sender.value)
        && (!query || [row.handle, row.creator_name].some(value => value?.toLowerCase().includes(query))));
      if (stage.value === 'REVIEW') filtered.sort((a, b) =>
        (a.latest_reply_at || a.created_at || '9999').localeCompare(b.latest_reply_at || b.created_at || '9999'));
      count.textContent = filtered.length + (filtered.length === 1 ? ' draft' : ' drafts');
      list.replaceChildren(...(filtered.length ? filtered.map(draftCard) : [paragraph('No drafts match these filters.', 'muted')]));
    }
    sender.onchange = renderDrafts;
    stage.onchange = renderDrafts;
    search.oninput = renderDrafts;
    renderDrafts();
    return [
      panel(heading('Creator follow-up drafts'),
        paragraph('Queue the reviewed text for the assigned DMer. They send it in TikTok and confirm the send in their VA portal.', 'muted'),
        el('div', { className: 'fields' }, field('Assigned DMer', sender), field('Draft status', stage), field('Find a creator', search)),
        count, list),
      panel(heading('Interested creator conversations'),
        creators.length ? creators : paragraph('No interested conversations awaiting follow-up.', 'muted')),
      panel(heading('Team notices'), el('div', { className: 'fields' },
        field('Recipient', recipient), button('Create notice', () => addNotice(recipients.find(s => s.va_id === recipient.value)))),
        el('div', { className: 'entry' }, historyTable(history.filter(row => row.notice_title))))
    ];
  }

  function proofAction(row, context) {
    const decision = select([['APPROVE', 'Approve evidence'], ['REJECT', 'Reject evidence'], ['FLAG', 'Flag for review']]);
    const note = notes();
    const checks = ['Recipient matches', 'Message matches', 'Screenshot shows it was sent'].map(
      text => {
        const input = el('input', { type: 'checkbox' });
        return [el('label', { className: 'check' }, input, text), input];
      });
    const validation = el('div', {}, checks.map(([checkbox]) => checkbox));
    validation.hidden = !context.required;
    decision.onchange = () => { validation.hidden = !context.required || decision.value !== 'APPROVE'; };
    action('Review proof', [field('Decision', decision), validation, field('Review note', note)], () =>
      call('dh_manager_review_proof', {
        p_proof: row.proof_check_id, p_decision: decision.value, p_note: note.value,
        p_image_sha256: context.image_sha256,
        p_verified_recipient: checks[0][1].checked, p_verified_message: checks[1][1].checked, p_verified_sent: checks[2][1].checked
      }), 'Evidence decision saved.');
  }

  function proofDetails(row) {
    return details((row.handle || row.proof_kind) + ' · ' + row.va_name + ' · ' + labelFor(row.review_status), async () => {
      const [context, transcripts] = await Promise.all([
        call('dh_manager_proof_context', { p_proof: row.proof_check_id }),
        call('dh_owner_proof_text_transcripts', { p_ids: [row.proof_check_id] })
      ]);
      const text = transcripts[0]?.text_archive;
      return [
        paragraph('Requested ' + formatDate(row.requested_at), 'muted'),
        paragraph('AI review: ' + (row.ai_verdict || 'Pending')),
        context?.message ? paragraph('Expected message: ' + context.message, 'copy') : null,
        context?.username ? paragraph('Expected sender: ' + context.username) : null,
        context?.handle ? paragraph('Expected recipient: ' + context.handle) : null,
        context?.duplicate ? paragraph('This screenshot was flagged as a duplicate.', 'error') : null,
        photoViewer(row.bucket || 'proofs', row.image_path),
        text ? details('Archived screenshot text', async () => [el('pre', { className: 'copy' }, JSON.stringify(text, null, 2))]) : null,
        context?.can_review && row.image_path && row.uploaded_at ?
          button('Review evidence', () => proofAction(row, context)) : null
      ].filter(Boolean);
    });
  }

  function screenshotReview(row) {
    const decision = select([['true', 'Approve screenshot'], ['false', 'Request new screenshot']]);
    const note = notes();
    action('Review quality screenshot', [field('Decision', decision), field('Review note', note)],
      () => call('dh_owner_quality_screenshot_review', {
        p_request_id: row.id, p_approved: decision.value === 'true', p_note: note.value
      }), 'Screenshot decision saved.');
  }

  function auditReview(item) {
    const decision = select([['true', 'Pass'], ['false', 'Fail']]);
    const note = notes();
    action('Review message audit evidence', [field('Decision', decision), field('Reason', note)],
      () => call('dh_owner_message_audit_review', {
        p_item: item.id, p_pass: decision.value === 'true', p_reason: note.value
      }), 'Audit decision saved.');
  }

  async function quality() {
    const [needed, pending, screenshots, audits, { staff }] = await Promise.all([
      call('dh_admin_proof_queue', { p_status: 'NEEDS_REVIEW', p_limit: 60 }),
      call('dh_admin_proof_queue', { p_status: 'PENDING_REVIEW', p_limit: 60 }),
      call('dh_owner_quality_screenshot_requests'), call('dh_owner_message_audits'), call('dh_manager_team')
    ]);
    const choices = staff.filter(s => s.active && s.manageable).map(s => [s.va_id, s.name]);
    const employee = select([['', 'Select a team member'], ...choices]);
    employee.required = true;
    const queue = [...needed, ...pending].map(proofDetails);
    return [
      panel(heading('Proof review queue'), queue.length ? queue : paragraph('No proofs waiting for review.', 'muted')),
      panel(heading('Quality screenshot requests'), screenshots.length ? screenshots.map(row => details(
        row.va_name + ' · ' + (row.handle ?? 'Creator') + ' · ' + labelFor(row.status), async () => [
          paragraph('Requested ' + formatDate(row.requested_at), 'muted'),
          photoViewer('va-quality-screenshots', row.image_path),
          ...((row.status === 'SUBMITTED') ? [button('Review screenshot', () => screenshotReview(row))] : [])
        ])) : paragraph('No recent screenshot requests.', 'muted')),
      panel(heading('Message audits'), button('Start message audit', () => action('Start a three-message audit',
        [field('Team member', employee)], () => call('dh_owner_message_audit_start', { p_va: employee.value }), 'Audit requested.')),
      audits.length ? audits.map(row => details(row.name + ' · ' + labelFor(row.state), async () => [
        paragraph('Due ' + formatDate(row.due_at), 'muted'),
        ...row.items.map(item => entry(
          el('h3', {}, (item.handle || 'Creator') + ' · ' + labelFor(item.status)),
          paragraph(item.expected_first_message || '', 'copy'),
          item.expected_followup ? paragraph(item.expected_followup, 'copy') : null,
          photoViewer('message-audit', item.evidence_path),
          row.state === 'OPEN' && ['SUBMITTED', 'PENDING'].includes(item.status) ?
            button('Review audit item', () => auditReview(item)) : null
        ))
      ])) : paragraph('No recent message audits.', 'muted'))
    ];
  }

  async function payments() {
    const rows = await call('dh_manager_payout_review');
    return [panel(heading('Payout preparation'), paragraph('Saved preparations are visible to the owner. Final payment approval is owner-only.', 'muted'),
      table(['Team member', 'Available for review', 'Pending', 'Paid', 'Preparation', 'Action'], rows.map(row => [
        row.name, amount(row.ready_cents, row.currency), amount(row.pending_cents, row.currency), amount(row.paid_cents, row.currency),
        row.prepared_at ? el('div', {},
          paragraph(row.needs_refresh ? 'Balance changed since preparation' : amount(row.prepared_cents, row.currency)),
          el('small', {}, formatDate(row.prepared_at)),
          paragraph(row.note ?? '', 'copy')
        ) : '—',
        row.can_prepare && row.ready_cents > 0 ? button('Prepare for owner', () => {
          const note = notes();
          note.required = true;
          note.minLength = 8;
          action('Prepare payout review for ' + row.name,
            [paragraph('Current available balance: ' + amount(row.ready_cents, row.currency)), field('Review note for the owner', note)],
            () => call('dh_manager_prepare_payout', { p_va: row.va_id, p_currency: row.currency, p_note: note.value }),
            'Preparation saved for the owner.');
        }) : null
      ])))];
  }

  async function reports() {
    const args = { p_period: reportPeriod.value, p_date: reportDate.value };
    const report = await call('dh_manager_report', args);
    const filters = el('form', {
      onsubmit: event => { event.preventDefault(); void openPage(); }
    }, el('div', { className: 'fields' },
      field('Period', reportPeriod), field('Date (UTC)', reportDate), el('button', { type: 'submit' }, 'Load report')
    ));
    reportDate.required = true;
    return [
      panel(heading('Daily and weekly reports'), filters, paragraph(dateSpan(report), 'muted')),
      cards(Object.fromEntries(Object.entries(report.snapshot.totals).map(([k, v]) => [labels[k], v]))),
      panel(heading('Team report'), metricTable(report.snapshot),
        button('Save report for the owner', () => {
          const notesInput = notes();
          const escalation = notes();
          action('Save ' + report.period.toLowerCase() + ' report', [
            paragraph(dateSpan(report), 'muted'), field('Operational summary', notesInput), field('Issues for the owner', escalation)
          ], () => call('dh_manager_report', {
            ...args, p_notes: notesInput.value, p_escalations: escalation.value
          }), 'Report saved for the owner.');
        })),
      panel(heading('Saved reports'), report.history.length ? report.history.map(saved =>
        details(labelFor(saved.period) + ' · ' + dateSpan(saved) + ' · saved ' + formatDate(saved.created_at), async () => [
          metricTable(saved), paragraph(saved.notes, 'copy'),
          saved.escalations ? el('div', {}, el('h3', {}, 'Issues for the owner'), paragraph(saved.escalations, 'copy')) : null
        ].filter(Boolean))) : paragraph('No reports saved yet.', 'muted'))
    ];
  }

  const pages = { start: startHere, overview, team, messages, quality, payments, reports };
  async function openPage(page = state.page) {
    if (!state.role) return;
    const version = ++state.pageVersion;
    state.page = page;
    for (const link of $('navigation').querySelectorAll('button')) {
      link.setAttribute('aria-pressed', String(link.dataset.page === page));
    }
    status('page-status', 'Loading…');
    $('page').replaceChildren();
    try {
      const content = await pages[page]();
      if (version !== state.pageVersion) return;
      $('page').replaceChildren(...content);
      status('page-status', refreshMessage);
      refreshMessage = '';
    } catch (error) {
      if (version !== state.pageVersion) return;
      status('page-status', message(error), true);
      $('page').replaceChildren(button('Try again', () => void openPage()));
    }
  }

  function showLogin() {
    state.role = null;
    state.pageVersion++;
    $('app').hidden = true;
    $('account').hidden = true;
    $('signed-in-as').textContent = '';
    $('page').replaceChildren();
    if ($('action-dialog').open) $('action-dialog').close();
    $('action-form').replaceChildren();
    $('login').hidden = false;
  }

  async function loadSession() {
    const version = ++state.loginVersion;
    const { data: { session } } = await db.auth.getSession();
    if (version !== state.loginVersion) return;
    if (!session) {
      showLogin();
      return;
    }
    try {
      const role = await call('dh_manager_access');
      if (version !== state.loginVersion) return;
      if (!['SYSTEM_MANAGER', 'OWNER'].includes(role)) {
        showLogin();
        status('login-status', 'This account does not have operations access. Use the VA portal to access your work.', true);
        return;
      }
      state.role = role;
      $('login').hidden = true;
      $('account').hidden = false;
      $('app').hidden = false;
      $('owner-link').hidden = role !== 'OWNER';
      $('role').textContent = role === 'OWNER' ? 'Owner' : 'System manager';
      $('signed-in-as').textContent = session.user.email ?? '';
      status('login-status', '');
      await openPage();
    } catch (error) {
      if (version !== state.loginVersion) return;
      showLogin();
      status('login-status', message(error), true);
    }
  }

  $('login-form').onsubmit = async event => {
    event.preventDefault();
    $('sign-in').disabled = true;
    status('login-status', 'Signing in…');
    try {
      const { error } = await db.auth.signInWithPassword({
        email: $('email').value.trim(), password: $('password').value
      });
      if (error) throw error;
      await loadSession();
    } catch (error) {
      status('login-status', message(error), true);
    } finally {
      $('password').value = '';
      $('sign-in').disabled = false;
    }
  };
  $('sign-out').onclick = async () => {
    const { error } = await db.auth.signOut({ scope: 'local' });
    if (error) {
      status('page-status', message(error), true);
      return;
    }
    status('login-status', '');
    showLogin();
  };
  $('navigation').onclick = event => {
    const page = event.target.closest('button[data-page]')?.dataset.page;
    if (page) void openPage(page);
  };
  db.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') {
      state.loginVersion++;
      showLogin();
    }
  });
  $('sign-in').disabled = false;
  void loadSession();
}
