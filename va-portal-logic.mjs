// THE PARTS OF THE VA PORTAL THAT CAN BE WRONG QUIETLY.
//
// Capacity arithmetic, relative time, clipboard success and RPC failure all used to live inline in
// va-portal.html, where nothing could reach them but a browser. Each of them had a bug that a single
// assertion would have caught: "60 left today" beside one account holding twenty, a future
// follow-up rendered as "Sent 3 days ago", "Copied" printed before the write resolved, and an RPC
// failure that returned silently and advanced the queue anyway.
//
// They live here so they can be tested. scripts/build-console-pages.mjs inlines this file into the
// page at build time, so the deployed console is still one self-contained file with no new origin
// in its CSP -- and there is exactly one copy of the logic, not two that drift.

// ---------------------------------------------------------------------------------------------
// CAPACITY
//
// THE BUG THIS REPLACES. dh_va_queue computed remaining_today as
//   least(va_daily_capacity - contacted_today, ready_task_count)
// and never looked at the sending accounts at all. A VA with a 60/day personal cap, 900 ready
// creators and one approved account limited to 20 was told "60 left today" while the Accounts tab
// said "0 of 20 sent". Both numbers were honestly derived and one of them was a lie.
//
// A DM needs three things at once: the VA's own cap, an approved account with room, and a creator
// to send it to. The real answer is the smallest of the three, and which one is smallest is worth
// naming -- "you are out of account capacity" and "you have run out of creators" are different
// problems with different fixes.
// ---------------------------------------------------------------------------------------------

/** Only an approved, live account can carry a send. Everything else contributes zero capacity. */
export function accountIsSendable(account) {
  return Boolean(account) && account.status === 'ACTIVE';
}

/** Daily room left on one account, floored at zero so a misconfigured limit cannot go negative. */
export function accountRemaining(account) {
  if (!accountIsSendable(account)) return 0;
  const limit = Number(account.daily_limit);
  const sent = Number(account.sent_today);
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, limit - (Number.isFinite(sent) ? sent : 0));
}

/**
 * How many DMs can actually go out today, and what is stopping the rest.
 *
 * `readyTasks` is how many creators are queued and sendable; pass null when the caller genuinely
 * does not know, and it stops being a constraint rather than silently reading as zero.
 */
export function computeCapacity({ vaCap, vaSentToday, accounts, readyTasks } = {}) {
  const cap = Number.isFinite(Number(vaCap)) ? Number(vaCap) : Infinity;
  const vaSent = Number.isFinite(Number(vaSentToday)) ? Number(vaSentToday) : 0;
  const vaCapRemaining = Math.max(0, cap - vaSent);

  const list = Array.isArray(accounts) ? accounts : [];
  const accountCapacityRemaining = list.reduce((sum, a) => sum + accountRemaining(a), 0);

  const ready = readyTasks === null || readyTasks === undefined
    ? Infinity
    : Math.max(0, Number(readyTasks) || 0);

  const sendableNow = Math.min(vaCapRemaining, accountCapacityRemaining, ready);

  // Named so the screen can say why, not just how many. Ties resolve to the most actionable cause:
  // no approved account is a setup problem, an empty queue is a supply problem, the cap is neither.
  let limitingFactor = 'VA_CAP';
  if (accountCapacityRemaining <= vaCapRemaining && accountCapacityRemaining <= ready) {
    limitingFactor = list.some(accountIsSendable) ? 'ACCOUNT_CAPACITY' : 'NO_APPROVED_ACCOUNT';
  } else if (ready <= vaCapRemaining && ready <= accountCapacityRemaining) {
    limitingFactor = 'NO_READY_TASKS';
  }
  if (sendableNow > 0 && limitingFactor === 'NO_APPROVED_ACCOUNT') limitingFactor = 'ACCOUNT_CAPACITY';

  return {
    sendableNow,
    vaCapRemaining: Number.isFinite(vaCapRemaining) ? vaCapRemaining : null,
    accountCapacityRemaining,
    readyTasks: Number.isFinite(ready) ? ready : null,
    limitingFactor
  };
}

// ---------------------------------------------------------------------------------------------
// TIME
//
// THE BUG THIS REPLACES. The reply card read
//   formatSentTime(follow_up_at || last_checked_at || first_sent_at)
// under the label "Sent…". follow_up_at is usually in the FUTURE, and formatSentTime took
// Math.abs of the difference -- so a follow-up due in two days rendered as "Sent 2 days ago", the
// exact opposite of the truth, on the one card a VA uses to decide whether to chase someone.
//
// Three facts, three fields, three labels. A future time says "in", never "ago".
// ---------------------------------------------------------------------------------------------

/** Milliseconds for a timestamp we are willing to render, or null for missing/unparseable. */
export function parseInstant(iso) {
  if (iso === null || iso === undefined || iso === '') return null;
  const ms = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** "5m", "3h", "2d" -- the coarse unit a queue is read in. */
function coarse(seconds) {
  const s = Math.abs(seconds);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/**
 * "3d ago" / "in 2d" / null.
 *
 * Direction is carried, never flattened: Math.abs is what turned a due date into a send date.
 */
export function relativeTime(iso, now = Date.now()) {
  const ms = parseInstant(iso);
  if (ms === null) return null;
  const seconds = (now - ms) / 1000;
  const text = coarse(seconds);
  return seconds < 0 ? { text: 'in ' + text, future: true } : { text: text + ' ago', future: false };
}

/** Longhand, for the one line at the top of a card where there is room for words. */
function longhand(seconds) {
  const s = Math.abs(seconds);
  if (s < 3600) {
    const m = Math.max(1, Math.round(s / 60));
    return m + ' minute' + (m === 1 ? '' : 's');
  }
  if (s < 86400) {
    const h = Math.round(s / 3600);
    return h + ' hour' + (h === 1 ? '' : 's');
  }
  const d = Math.round(s / 86400);
  return d + ' day' + (d === 1 ? '' : 's');
}

function labelled(prefix, iso, now, missingText) {
  const ms = parseInstant(iso);
  if (ms === null) return missingText;
  const seconds = (now - ms) / 1000;
  return seconds < 0
    ? prefix + ' in ' + longhand(seconds)
    : prefix + ' ' + longhand(seconds) + ' ago';
}

/** When the first DM actually left. Never follow_up_at, never last_checked_at. */
export function sentLabel(firstSentAt, now = Date.now()) {
  return labelled('Sent', firstSentAt, now, 'Send time unknown');
}

/** When a VA last looked at this conversation. */
export function checkedLabel(lastCheckedAt, now = Date.now()) {
  return labelled('Last checked', lastCheckedAt, now, 'Not checked yet');
}

/** When this creator is due to be chased. Normally in the future, and says so. */
export function followUpLabel(followUpAt, now = Date.now()) {
  const ms = parseInstant(followUpAt);
  if (ms === null) return 'No follow-up set';
  const seconds = (now - ms) / 1000;
  return seconds < 0
    ? 'Follow-up due in ' + longhand(seconds)
    : 'Follow-up overdue by ' + longhand(seconds);
}

// ---------------------------------------------------------------------------------------------
// RPC RESULTS
//
// THE BUG THIS REPLACES. Every simplified action did some version of
//   if (error || !data?.ok) return;
// A network failure, an expired session, a refused send and a daily limit all produced the same
// thing on screen: nothing at all. The VA tapped, watched the button do nothing, and tapped again.
//
// Two failure shapes have to be told apart because they need different words: the call did not
// arrive (transport), and the call arrived and the database said no (rejection).
// ---------------------------------------------------------------------------------------------

/** Reasons the server returns that a VA can act on, in their words rather than the enum's. */
export const REASON_TEXT = {
  NO_SUCH_TASK: 'That creator is no longer in your queue.',
  NOT_YOUR_TASK: 'That creator is assigned to someone else now.',
  NOT_YOUR_ACCOUNT: 'That TikTok account is not yours.',
  NO_SUCH_ACCOUNT: 'That TikTok account no longer exists.',
  NO_ELIGIBLE_ACCOUNT: 'No approved TikTok account is free to send right now.',
  NOT_APPROVED: 'That account is still waiting for approval.',
  PAUSED: 'That account is paused.',
  REVIEW_REQUIRED: 'That account is on hold while we look at it.',
  DAILY_LIMIT_REACHED: 'That account has hit its limit for today.',
  VA_DAILY_CAP_REACHED: 'You have reached your own limit for today.',
  COOLDOWN: 'Too soon after the last message — wait for the countdown.',
  PROOF_REQUIRED: 'Send the photo we asked for first, then carry on.',
  MESSAGE_BLOCKED: 'TikTok refused this message. It has to be rewritten before it can go out.',
  DUPLICATE_CREATOR: 'This creator has already been messaged under another record.',
  NO_SEND_TO_REPLY_TO: 'Mark the DM as sent first, then record their reply.',
  NO_SUCH_PROOF: 'That photo request is no longer open.',
  BAD_CLASSIFICATION: 'That is not an answer we can record.',
  NO_REPLY_EVENT: 'We could not find the reply to attach that photo to.',
  // The proof and reply functions. Every reason dh_proof_upload, dh_reply_report and
  // dh_reply_classify can return has a line here -- an unmapped one falls through to the generic
  // "that did not work", which tells a VA nothing about whether to retry, and the upload path used
  // to print the enum itself.
  NOT_YOUR_PROOF: 'That photo request belongs to someone else.',
  ALREADY_DECIDED: 'That photo has already been checked — nothing more to send.',
  NO_IMAGE: 'No photo was attached. Pick one and send again.',
  NO_SUCH_REPLY: 'We could not find that reply any more.',
  NOT_YOUR_REPLY: 'That reply belongs to someone else now.'
};

/**
 * One shape for "did it work", whatever went wrong.
 *
 * `ok:true, duplicate:true` is a success: the server is telling us this task was already recorded,
 * which is exactly what a double tap should look like from the outside.
 */
export function normalizeRpc({ data, error } = {}) {
  if (error) {
    return {
      ok: false,
      kind: 'TRANSPORT',
      reason: null,
      message: 'We could not reach the server. Check your connection and try again.',
      detail: error.message || String(error)
    };
  }
  if (data === null || data === undefined) {
    return { ok: false, kind: 'EMPTY', reason: null, message: 'The server sent no answer. Try again.', detail: null };
  }
  if (data.ok === false) {
    const reason = data.reason || data.error || null;
    return {
      ok: false,
      kind: 'REJECTED',
      reason,
      message: REASON_TEXT[reason] || data.detail || 'That did not work. Try again.',
      detail: data.detail || null
    };
  }
  return { ok: true, kind: 'OK', reason: null, message: null, detail: null, data, duplicate: data.duplicate === true };
}

/** What gets logged: the action and safe identifiers. Never a message body, never a credential. */
export function safeLogLine(action, res, ids = {}) {
  const parts = ['[va-portal]', action, res.ok ? 'ok' : res.kind.toLowerCase()];
  if (res.reason) parts.push(res.reason);
  for (const [k, v] of Object.entries(ids)) if (v) parts.push(k + '=' + v);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// CLIPBOARD
//
// THE BUG THIS REPLACES. copyNow started navigator.clipboard.writeText, did not await it, and
// returned true. The caller then printed "Copied — paste it in TikTok." and opened TikTok. If the
// write was denied the VA arrived in a chat with an empty clipboard and a message saying otherwise.
//
// The write is awaited now. That is safe because opening TikTok no longer happens after the await
// -- the window is opened first, synchronously, inside the gesture.
// ---------------------------------------------------------------------------------------------

/**
 * Copy, and report only what actually happened.
 *
 * `deps` is injected so the failure paths can be tested: a denied permission, a missing async API,
 * and both routes failing are three different things a VA can hit and none of them may print
 * "Copied".
 */
export async function copyText(text, deps = {}) {
  const nav = deps.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const legacy = deps.legacyCopy;
  // A clipboard write is not guaranteed to settle. When the document does not hold focus, or the
  // permission prompt is suppressed rather than answered, navigator.clipboard.writeText() returns a
  // promise that neither resolves nor rejects -- measured in headless Chromium, and reachable in a
  // real browser whenever the VA's tap moves focus to the TikTok tab we have just opened. Awaiting
  // it unguarded deadlocks the whole phase-1 handler: the button stays disabled, no card is drawn,
  // and the VA is left on a dead screen with no error. Time it out and fall back instead.
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 400;
  const setTimer = deps.setTimeout ?? (typeof setTimeout !== 'undefined' ? setTimeout : null);

  if (typeof text !== 'string' || text === '') {
    return { ok: false, method: 'none', reason: 'NOTHING_TO_COPY' };
  }

  const tryLegacy = () => {
    if (typeof legacy !== 'function') return false;
    try { return legacy(text) === true; } catch { return false; }
  };

  if (nav?.clipboard?.writeText) {
    let write;
    try {
      write = Promise.resolve(nav.clipboard.writeText(text));
    } catch {
      write = null; // threw synchronously -- unavailable in this context
    }
    if (write) {
      // Swallow the rejection here so a later await cannot surface it as unhandled.
      const settled = write.then(() => 'written', () => 'failed');
      if (!setTimer) {
        if ((await settled) === 'written') return { ok: true, method: 'async' };
      } else {
        const first = await Promise.race([
          settled,
          new Promise((resolve) => setTimer(() => resolve('pending'), timeoutMs))
        ]);
        if (first === 'written') return { ok: true, method: 'async' };
        if (first === 'pending') {
          // Still unsettled. Rather than keep the VA on a disabled button, copy the old way now and
          // report that -- execCommand is synchronous and does not care about focus. If it also
          // fails, give the async write the rest of its chance before admitting defeat.
          if (tryLegacy()) return { ok: true, method: 'legacy' };
          // Both routes are now in doubt, so give the async write a bounded grace window -- bounded,
          // because awaiting a promise that never settles is the deadlock this whole branch exists
          // to avoid, and re-introducing it here would just move it a few lines down.
          const grace = await Promise.race([
            settled,
            new Promise((resolve) => setTimer(() => resolve('pending'), timeoutMs * 4))
          ]);
          if (grace === 'written') return { ok: true, method: 'async' };
          return { ok: false, method: 'none', reason: 'COPY_FAILED' };
        }
      }
    }
  }

  if (tryLegacy()) return { ok: true, method: 'legacy' };

  return { ok: false, method: 'none', reason: 'COPY_FAILED' };
}

// ---------------------------------------------------------------------------------------------
// STALE RESPONSES
//
// THE BUG THIS REPLACES. Tabs switched only after their data loaded, and loadAccounts/loadMoney had
// no sequencing -- so a slow first request could land after a fast second one and repaint the
// screen with older numbers, or show the tab the VA had already navigated away from.
// ---------------------------------------------------------------------------------------------

/** A monotonic gate: only the newest request in a family is allowed to write to the screen. */
export function createSequencer() {
  const latest = new Map();
  return {
    begin(key) {
      const n = (latest.get(key) || 0) + 1;
      latest.set(key, n);
      return n;
    },
    isCurrent(key, token) {
      return latest.get(key) === token;
    }
  };
}
