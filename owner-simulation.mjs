// Admin DMer simulator: authenticated owner APIs only, persistent isolated runs.
export function initOwnerSimulation({client,baseUrl,apiKey,root=document}){
 const $=id=>root.getElementById(id);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let current=null,lastData=null,epoch=0,timer=null,busy=false,preview=null;
 const labels={UPLOAD:'Screenshot uploaden',QUEUED:'Wacht op verwerking',READING:'Screenshot wordt gelezen',
  GENERATING:'AI maakt een antwoord',READY:'Klaar',REVIEW:'Controle nodig',ERROR:'Test onderbroken'};
 const messages={TEST_BUSY:'Deze screenshot wordt nog verwerkt.',OWNER_ONLY:'Alleen de admin kan deze testportal gebruiken.',
  IMAGE_TOO_LARGE:'Kies een afbeelding van maximaal 10 MB.',BAD_IMAGE:'Kies een JPG, PNG of WebP.',
  NO_SENDABLE_REPLY:'Dit voorstel kan niet als DM worden verstuurd.',NOT_READY_FOR_LINK:'De creator is nog niet klaar voor de aanmeldlink.',
  PROCESSING_UNAVAILABLE:'De verwerking kon niet starten. Je test blijft bewaard.',SCREENSHOT_UNAVAILABLE:'De screenshot kon niet worden gelezen.'};
 const notice=(text,error=false)=>{$('sim-notice').textContent=text;$('sim-notice').classList.toggle('bad',error);};
 async function call(action,extra={}){
  const {data:{session}}=await client.auth.getSession();
  if(!session?.access_token)throw new Error('Log opnieuw in als admin.');
  const response=await fetch(baseUrl+'/functions/v1/owner-simulation',{method:'POST',
   headers:{'content-type':'application/json',apikey:apiKey,authorization:'Bearer '+session.access_token},
   body:JSON.stringify({action,...extra}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok||!data?.ok)throw new Error(messages[data?.reason]||'De testactie kon niet worden uitgevoerd ('+(data?.reason||response.status)+').');
  return data;
 }
 const lock=on=>{busy=on;for(const node of root.querySelectorAll('[data-sim-action]'))node.disabled=on;if(!on&&lastData)render(lastData);};
 async function act(fn){
  if(busy)return;
  lock(true);notice('');
  try{await fn();}catch(error){notice(error.message,true);}
  finally{lock(false);}
 }
 function stop(){epoch++;clearTimeout(timer);timer=null;}
 function render(data){
  lastData=data;
  current=data.run;$('sim-active').hidden=false;$('sim-active-title').textContent=current.title;
  $('sim-person').textContent=current.creator?.handle||current.creator?.display_name||'Testcreator';
  $('sim-facts').textContent=current.facts?.registration_confirmed?'Aanmelding bevestigd (simulatie)':
   current.facts?.invite_clicked?'Testlink geopend':current.facts?.invite_exists?'Testlink aangemaakt':'Nog geen testlink';
  const steps=data.steps||[],last=steps.at(-1);
  $('sim-steps').innerHTML=steps.map(step=>{
   const answer=step.suggestion;
   const action=answer?.next_action;
   const status=step.sent_at?'Verzending bevestigd (test)':labels[step.status]||step.status;
   return '<article class="sim-step"><div class="sim-step-head"><strong>'+step.step_seq+'. '+(step.proof_kind==='REPLY'?'Creatorreactie':'Verzonden DM')+'</strong><span>'+esc(status)+'</span></div>'
    +'<div class="sim-step-grid">'+(step.image_url?'<details><summary>Screenshot bekijken</summary><img src="'+esc(step.image_url)+'" alt="Screenshot van deze teststap" loading="lazy"></details>':'')
    +'<div>'+(step.extracted_text?'<p class="muted">Gelezen reactie</p><p>'+esc(step.extracted_text)+'</p>':'')
    +(step.classification?'<p class="muted">Intentie: '+esc(step.classification)+'</p>':'')
    +(answer?'<p class="muted">'+(action==='WAIT'?'Instructie voor de DMer':'Voorgesteld antwoord')+'</p><div class="sim-answer">'+esc(answer.reply_text)+'</div><p class="muted">Vervolgactie: '+esc(action)+'</p>':'')
    +(step.error_code?'<p class="bad">Tegengehouden: '+esc(step.error_code)+'</p>':'')
    +(step.vision&&step.vision.verdict!=='LIKELY_VALID'?'<p class="bad">Screenshotcontrole: controle nodig. '+esc(step.vision.reason||step.vision.result?.notes||'De screenshot is niet met voldoende zekerheid herkend.')+'</p>':'')
    +(step.vision?'<details><summary>Screenshotcontrole en zekerheid</summary><pre>'+esc(JSON.stringify(step.vision,null,2))+'</pre></details>':'')
    +(Object.keys(step.timings||{}).length?'<p class="muted">Screenshot: '+Math.round((step.timings.screenshot_ms||0)/1000)+' s · antwoord: '+Math.round((step.timings.reply_ms||0)/1000)+' s</p>':'')
    +'</div></div></article>';
  }).join('')||'<p class="muted">Upload de eerste screenshot om deze simulatie te starten.</p>';
  const running=last&&['UPLOAD','QUEUED','READING','GENERATING'].includes(last.status);
  $('sim-status').textContent=running?labels[last.status]:last?labels[last.status]:'Klaar voor een screenshot';
  $('sim-upload').disabled=busy||Boolean(running);
  $('sim-copy').disabled=busy||!last?.suggestion||!['SEND_REPLY','SEND_AFFILIATE_LINK'].includes(last.suggestion.next_action);
  $('sim-sent').disabled=$('sim-copy').disabled||Boolean(last?.sent_at);
  $('sim-invite').hidden=last?.suggestion?.next_action!=='SEND_AFFILIATE_LINK';
  $('sim-clicked').hidden=!current.facts?.invite_exists;
  $('sim-registered').hidden=!current.facts?.invite_exists;
  $('sim-sent').dataset.step=last?.step_id||'';
  $('sim-invite').dataset.step=last?.step_id||'';
  $('sim-copy').dataset.text=last?.suggestion?.reply_text||'';
  if(running&&last.status!=='UPLOAD')schedule(current.run_id,epoch);
 }
 function schedule(id,version){
  clearTimeout(timer);timer=setTimeout(async()=>{
   if(version!==epoch||current?.run_id!==id)return;
   try{const data=await call('get',{run_id:id});if(version===epoch&&current?.run_id===id)render(data);}
   catch(error){if(version===epoch){notice(error.message,true);schedule(id,version);}}
  },2000);
 }
 async function refreshRun(id){
  stop();const version=epoch;
  const data=await call('get',{run_id:id});
  if(version===epoch)render(data);
 }
 async function list(){
  const version=epoch;const [runs,examples]=await Promise.all([call('list'),call('examples')]);
  if(version!==epoch)return;
  $('sim-runs').innerHTML='<option value="">Kies een eerdere test</option>'+runs.runs.map(x=>'<option value="'+esc(x.run_id)+'">'+esc(x.title)+'</option>').join('');
  $('sim-examples').innerHTML='<option value="">Of kies een bestaande VA-screenshot</option>'+examples.examples.map(x=>'<option value="'+esc(x.proof_check_id)+'">'+esc(x.handle)+' · '+new Date(x.uploaded_at).toLocaleString('nl-NL')+'</option>').join('');
 }
 $('sim-create').addEventListener('submit',event=>{
  event.preventDefault();act(async()=>{
   stop();const payload={title:$('sim-title').value,handle:$('sim-handle').value,name:$('sim-name').value,
    bio:$('sim-bio').value,first_message:$('sim-first').value,language:$('sim-language').value};
   const data=await call('create',{payload});await refreshRun(data.run.run_id);await list();
  });
 });
 $('sim-import').addEventListener('click',()=>act(async()=>{
  const proof=$('sim-examples').value;if(!proof)throw new Error('Kies eerst een VA-screenshot.');
  stop();notice('Een eigen testkopie van de screenshot wordt gemaakt…');
  const data=await call('create',{payload:{title:'VA-screenshot testen',proof_check_id:proof}});
  await refreshRun(data.run.run_id);await list();notice('De screenshot wordt met de actuele regels getest.');
 }));
 $('sim-runs').addEventListener('change',()=>{if($('sim-runs').value)act(()=>refreshRun($('sim-runs').value));});
 $('sim-refresh').addEventListener('click',()=>act(async()=>{await list();if(current)await refreshRun(current.run_id);}));
 $('sim-file').addEventListener('change',()=>{
  if(preview)URL.revokeObjectURL(preview);
  const file=$('sim-file').files[0];preview=file?URL.createObjectURL(file):null;
  $('sim-preview').hidden=!preview;if(preview)$('sim-preview').src=preview;
 });
 $('sim-upload').addEventListener('click',()=>act(async()=>{
  if(!current)throw new Error('Start eerst een simulatie.');
  const file=$('sim-file').files[0];
  if(!file)throw new Error('Kies een screenshot.');
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.type];
  if(!ext||file.size>10*1024*1024)throw new Error('Kies een JPG, PNG of WebP van maximaal 10 MB.');
  const id=current.run_id,version=epoch;
  const prepared=await call('prepare',{run_id:id,payload:{kind:$('sim-kind').value,extension:ext,size:file.size}});
  try{
   const {error}=await client.storage.from(prepared.bucket).uploadToSignedUrl(prepared.step.image_path,prepared.upload_token,file,{contentType:file.type});
   if(error)throw new Error('De screenshot kon niet worden geüpload.');
   await call('uploaded',{step_id:prepared.step.step_id});
  }catch(error){
   await call('cancel_upload',{step_id:prepared.step.step_id}).catch(()=>{});
   if(version===epoch)await refreshRun(id);throw error;
  }
  if(version!==epoch)return;
  $('sim-file').value='';if(preview)URL.revokeObjectURL(preview);preview=null;$('sim-preview').hidden=true;
  await refreshRun(id);notice('Screenshot ontvangen. De verwerking start automatisch.');
 }));
 $('sim-copy').addEventListener('click',()=>act(async()=>{
  await navigator.clipboard.writeText($('sim-copy').dataset.text);notice('Antwoord gekopieerd voor je test.');
 }));
 $('sim-sent').addEventListener('click',()=>act(async()=>{
  await call('sent',{step_id:$('sim-sent').dataset.step});await refreshRun(current.run_id);notice('Verzending bevestigd in deze simulatie.');
 }));
 $('sim-invite').addEventListener('click',()=>act(async()=>{
  const data=await call('invite',{step_id:$('sim-invite').dataset.step});$('sim-test-link').textContent=data.test_link;
  await refreshRun(current.run_id);notice('Testlink aangemaakt. Dit is geen echte affiliate-uitnodiging.');
 }));
 for(const action of ['clicked','registered'])$('sim-'+action).addEventListener('click',()=>act(async()=>{
  await call(action,{run_id:current.run_id});await refreshRun(current.run_id);
 }));
 client.auth.onAuthStateChange((event)=>{
  if(event==='SIGNED_OUT'){stop();current=null;lastData=null;$('sim-active').hidden=true;$('sim-steps').innerHTML='';$('sim-test-link').textContent='';$('sim-runs').innerHTML='<option value="">Kies een eerdere test</option>';$('sim-examples').innerHTML='<option value="">Kies een VA-screenshot</option>';$('sim-create').reset();$('sim-file').value='';if(preview)URL.revokeObjectURL(preview);preview=null;$('sim-preview').hidden=true;$('sim-preview').removeAttribute('src');notice('');}
  if(event==='SIGNED_IN'&&location.hash==='#simulation')setTimeout(()=>act(list),0);
 });
 window.addEventListener('hashchange',()=>{if(location.hash==='#simulation')act(async()=>{await list();if(current)await refreshRun(current.run_id);});else{clearTimeout(timer);timer=null;}});
 if(location.hash==='#simulation')queueMicrotask(()=>act(list));
 return {call,stop};
}
