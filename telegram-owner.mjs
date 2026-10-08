// Owner-only Telegram setup. The Edge Function independently verifies Supabase OWNER role.
export function initTelegramOwner({client}) {
  const $ = id => document.getElementById(id);
  const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = $('tg-bridge-status'), groups = $('tg-bridge-groups'), messages = $('tg-bridge-messages');
  if (!status || !groups || !messages) return {refresh:async()=>{}};
  let busy=false;
  async function call(action='status',chat_id) {
    const {data,error} = await client.functions.invoke('telegram-bridge',
      {body:{action,...(chat_id===undefined?{}:{chat_id})}});
    if (error) {
      let detail=error.message||'Connection failed';
      try {const b=await error.context?.json();if(b?.error)detail=b.error;} catch {}
      throw new Error(detail);
    }
    return data||{};
  }
  async function refresh(){
    if(busy)return;
    busy=true;
    try {
      const state=await call();
      const privacyWarning = state.bot_can_read_all === false
        ? ' ⚠ Privacy mode is still ON in BotFather. Use /setprivacy → @DropHeroTeamBot → Disable, then remove and re-add the bot (or promote it to group admin).'
        : '';
      const setupWarning = !state.allowed_updates?.includes('my_chat_member')
        ? ' Press Connect bot webhook again to enable group-join detection.'
        : '';
      status.textContent = (state.webhook_active
        ? 'Connected: @'+(state.bot_username||'DropHeroTeamBot')+' · Webhook active.'
        : 'Bot token detected. Press Connect bot webhook to activate.') + privacyWarning + setupWarning;
      const chats=state.groups||[];
      groups.innerHTML='<h3>Telegram groups</h3>'+(chats.length?chats.map(g=>
        '<div style="padding:10px 0;border-top:1px solid var(--line)"><strong>'+esc(g.title||'Telegram group')+'</strong> '
        +'<span class="muted">'+(g.enabled?'Approved':'Not approved')+'</span> '
        +'<button class="ghost" type="button" data-tg-chat="'+esc(g.chat_id)+'" data-tg-action="'+(g.enabled?'disable':'enable')+'">'
        +(g.enabled?'Disconnect & delete messages':'Approve group')+'</button></div>').join('')
        :'<p class="muted">No Telegram group is connected. <a href="https://t.me/DropHeroTeamBot?startgroup=drophero" target="_blank" rel="noopener noreferrer">Add the bot to your group</a> or remove and re-add it, then Refresh groups and approve the correct group.</p>');
      const approved=new Set(chats.filter(g=>g.enabled).map(g=>String(g.chat_id)));
      const recent=(state.messages||[]).filter(m=>approved.has(String(m.chat_id)));
      messages.innerHTML='<h3>Recent group messages</h3>'+(recent.length?recent.map(m=>
        '<div style="border-top:1px solid var(--line);padding:9px 0"><strong>'+esc(m.sender_name||'Member')
        +'</strong> <span class="muted">'+esc(new Date(m.received_at).toLocaleString())+'</span>'
        +'<p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0">'
        +esc(m.text_body||(m.media_type?'['+m.media_type+']':'[non-text message]'))+'</p></div>').join('')
        :'<p class="muted">No messages yet. Approve the group, then send a new message.</p>');
    }catch(e) {
      status.textContent=e.message==='MISSING_TELEGRAM_BOT_TOKEN'
        ? 'Bot token missing. Save TELEGRAM_BOT_TOKEN in Supabase Edge Function Secrets.'
        : 'Telegram connection: '+(e.message||'Unavailable');
    }finally{busy=false;}
  }
  $('tg-bridge-refresh').addEventListener('click',()=>void refresh());
  $('tg-bridge-activate').addEventListener('click',async()=>{
    const btn=$('tg-bridge-activate');btn.disabled=true;
    status.textContent='Connecting Telegram webhook…';
    try {await call('activate');await refresh();}
    catch(e){status.textContent='Could not connect: '+e.message;}
    finally{btn.disabled=false;}
  });
  groups.addEventListener('click',async event=>{
    const btn=event.target.closest('button[data-tg-chat]');if(!btn)return;
    const action=btn.dataset.tgAction,chatId=btn.dataset.tgChat;
    if(!confirm(action==='enable'
      ?'Confirm this is your DropHero group and members have been informed that new messages will be processed?'
      :'Disconnect this group and delete its stored Telegram messages?'))return;
    btn.disabled=true;
    try {await call(action,chatId);await refresh();}
    catch(e){alert('Could not update Telegram group: '+e.message);}
    finally{btn.disabled=false;}
  });
  return {refresh};
}
