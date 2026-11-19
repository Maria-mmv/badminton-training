const DB_NAME='badminton-training-db', DB_VERSION=1, STORE='records';
const SYNC_EXEC_URL='https://script.google.com/macros/s/AKfycbwi4GIckQ2ZmeMlUu54b9ZmqYOUln-ADMRs7hTs54ILgCNGOg73iiB7DAOFL4w4PPVabQ/exec';
const SYNC_CHANNEL='badminton-training-sync';
const DEFAULT_TOPICS=['Техника','Перемещения','Игра у сетки','Атака и защита','Подача и приём','Тактика','Физическая подготовка'];
let db, exercises=[], plans=[], topics=[...DEFAULT_TOPICS], currentPlan=[], selectedDetail=null, pendingImages=[], existingImageUrls=[];
let selectionMode=false;
const selectedExerciseIds=new Set();
let syncToken='', syncMeta={revision:0,dirty:false,lastSyncedAt:null}, syncBridgeReady=false, syncInProgress=false, syncTimer=null, applyingCloudData=false, syncErrorMessage='';
const $=id=>document.getElementById(id);
const uid=()=>`${Date.now()}-${Math.random().toString(16).slice(2)}`;
const parseList=s=>s.split(',').map(x=>x.trim()).filter(Boolean);
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE))d.createObjectStore(STORE,{keyPath:'key'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function getRecord(key){return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).get(key);r.onsuccess=()=>resolve(r.result?.value);r.onerror=()=>reject(r.error);});}
function putRecord(key,value){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({key,value});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function delRecord(key){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function loadAll(){
  exercises=await getRecord('exercises')||[];
  plans=await getRecord('plans')||[];
  const savedTopics=await getRecord('topics');
  topics=Array.isArray(savedTopics)?savedTopics:collectLegacyTopics(exercises);
  syncMeta=await getRecord('syncMeta')||{revision:0,dirty:false,lastSyncedAt:null};
  fillTopics();
  renderAll();
}
async function persist(){
  await putRecord('exercises',exercises);
  await putRecord('plans',plans);
  await putRecord('topics',topics);
  if(!applyingCloudData){
    syncMeta={...syncMeta,dirty:true,localUpdatedAt:new Date().toISOString()};
    await putRecord('syncMeta',syncMeta);
  }
  renderAll();
  if(!applyingCloudData) scheduleAutoSync();
}
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2300);}
function switchTab(name){document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===name));document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
function collectLegacyTopics(items=[]){
  const existing=(items||[]).map(item=>String(item.topic||'').trim()).filter(Boolean);
  return [...new Set([...DEFAULT_TOPICS,...existing])];
}
function fillTopics(){
  const filterValue=$('topicFilter').value;
  const editValue=$('exTopic').value;
  const filter=$('topicFilter');
  const edit=$('exTopic');
  filter.innerHTML='';
  edit.innerHTML='';
  filter.add(new Option('Все темы',''));
  edit.add(new Option('Без темы',''));
  topics.forEach(topic=>{
    filter.add(new Option(topic,topic));
    edit.add(new Option(topic,topic));
  });
  filter.value=topics.includes(filterValue)?filterValue:'';
  edit.value=topics.includes(editValue)?editValue:'';
}
function renderAll(){
  fillTopics();updateBulkTagOptions();
  renderLibrary();renderPlan();renderPlans();
  $('exerciseCount').textContent=`${exercises.length} упражнений`;
  $('storageInfo').textContent=`Локальная копия: ${exercises.length} упражнений и ${plans.length} планов. Фото хранятся в базе браузера и синхронизируются вместе с карточками.`;
  renderBulkTools();
  if(typeof updateSyncUI==='function')updateSyncUI();
}
function getFilteredExercises(){
  const q=$('searchInput').value.toLowerCase();
  const topic=$('topicFilter').value;
  const level=$('levelFilter').value;
  return exercises.filter(e=>(!topic||e.topic===topic)&&(!level||e.level===level)&&[e.name,e.description,e.topic,e.shots,e.tags,e.zones].flat().join(' ').toLowerCase().includes(q));
}
function updateBulkTagOptions(){
  const list=$('existingTagOptions');
  if(!list)return;
  const tags=[...new Set(exercises.flatMap(e=>e.tags||[]).map(t=>String(t).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  list.innerHTML='';
  tags.forEach(tag=>list.append(new Option(tag,tag)));
}
function renderBulkTools(){
  const tools=$('bulkTools');
  if(!tools)return;
  tools.classList.toggle('hidden',!selectionMode);
  $('toggleSelectionBtn').textContent=selectionMode?'Завершить выбор':'Выбрать несколько';
  $('selectedCount').textContent=`Выбрано карточек: ${selectedExerciseIds.size}`;
  $('applyBulkTagBtn').disabled=selectedExerciseIds.size===0;
  $('clearSelectionBtn').disabled=selectedExerciseIds.size===0;
}
function renderLibrary(){
  const list=getFilteredExercises();
  $('exerciseGrid').innerHTML='';
  $('emptyLibrary').classList.toggle('hidden',list.length>0);
  list.forEach(e=>{
    const card=document.createElement('article');card.className='exercise-card';
    const thumb=document.createElement('div');thumb.className='thumb';
    if(e.images?.[0]){const img=document.createElement('img');img.src=e.images[0].data;thumb.append(img);}else thumb.textContent='🏸';
    const body=document.createElement('div');body.className='card-body';
    if(selectionMode){
      const selectLabel=document.createElement('label');selectLabel.className='card-select';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=selectedExerciseIds.has(String(e.id));
      checkbox.setAttribute('aria-label',`Выбрать ${e.name}`);
      checkbox.onchange=()=>{if(checkbox.checked)selectedExerciseIds.add(String(e.id));else selectedExerciseIds.delete(String(e.id));renderBulkTools();};
      selectLabel.append(checkbox,document.createTextNode('Выбрать'));
      body.append(selectLabel);
    }
    const title=document.createElement('h3');title.textContent=e.name;
    const meta=document.createElement('div');meta.className='muted';meta.textContent=`${e.topic||'Без темы'} · ${e.level||'—'} · ${e.duration||'—'} мин`;
    const chips=document.createElement('div');chips.className='chips';
    [...(e.shots||[]),...(e.tags||[])].slice(0,4).forEach(t=>{const c=document.createElement('span');c.className='chip';c.textContent=t;chips.append(c);});
    const actions=document.createElement('div');actions.className='card-actions';
    const open=document.createElement('button');open.className='button ghost';open.textContent='Карточка';open.onclick=()=>showDetail(e.id);
    const add=document.createElement('button');add.className='button primary';add.textContent='＋ В план';add.onclick=()=>addToPlan(e);
    const remove=document.createElement('button');remove.className='button danger';remove.textContent='Удалить';remove.onclick=()=>deleteExerciseById(e.id);
    actions.append(open,add,remove);body.append(title,meta,chips,actions);card.append(thumb,body);$('exerciseGrid').append(card);
  });
  renderBulkTools();
}
$('searchInput').addEventListener('input',renderLibrary);
$('topicFilter').addEventListener('change',renderLibrary);
$('levelFilter').addEventListener('change',renderLibrary);
$('toggleSelectionBtn').addEventListener('click',()=>{
  selectionMode=!selectionMode;
  if(!selectionMode)selectedExerciseIds.clear();
  renderLibrary();
});
$('selectAllVisibleBtn').addEventListener('click',()=>{
  getFilteredExercises().forEach(e=>selectedExerciseIds.add(String(e.id)));
  renderLibrary();
});
$('clearSelectionBtn').addEventListener('click',()=>{selectedExerciseIds.clear();renderLibrary();});
$('applyBulkTagBtn').addEventListener('click',async()=>{
  const tag=$('bulkTagInput').value.trim();
  if(!tag){toast('Введите тег');return;}
  if(tag.includes(',')){toast('Добавляйте по одному тегу за раз');return;}
  if(!selectedExerciseIds.size){toast('Сначала выберите карточки');return;}
  let changed=0;
  exercises.forEach(e=>{
    if(!selectedExerciseIds.has(String(e.id)))return;
    e.tags=e.tags||[];
    if(!e.tags.some(existing=>String(existing).toLocaleLowerCase('ru')===tag.toLocaleLowerCase('ru'))){e.tags.push(tag);changed++;}
  });
  selectedExerciseIds.clear();
  $('bulkTagInput').value='';
  updateBulkTagOptions();
  await persist();
  toast(changed?`Тег добавлен в ${changed} карточек`:'У выбранных карточек такой тег уже есть');
});

function renderTopicManager(){
  const box=$('topicList');box.innerHTML='';
  if(!topics.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Тем пока нет. Добавьте первую тему выше.';box.append(empty);return;}
  topics.forEach(topic=>{
    const row=document.createElement('div');row.className='topic-row';
    const input=document.createElement('input');input.type='text';input.value=topic;input.setAttribute('aria-label',`Название темы ${topic}`);
    const rename=document.createElement('button');rename.className='button ghost small';rename.textContent='Сохранить';
    rename.onclick=async()=>{
      const next=input.value.trim();
      if(!next){toast('Название темы не может быть пустым');return;}
      if(next===topic){toast('Название не изменилось');return;}
      if(topics.some(t=>t.toLocaleLowerCase('ru')===next.toLocaleLowerCase('ru'))){toast('Такая тема уже существует');return;}
      topics=topics.map(t=>t===topic?next:t);
      exercises.forEach(e=>{if(e.topic===topic)e.topic=next;});
      plans.forEach(plan=>(plan.items||[]).forEach(item=>{if(item.topic===topic)item.topic=next;}));
      currentPlan.forEach(item=>{if(item.topic===topic)item.topic=next;});
      fillTopics();await persist();renderTopicManager();toast('Тема переименована');
    };
    const remove=document.createElement('button');remove.className='button danger small';remove.textContent='Удалить';
    remove.onclick=async()=>{
      const affected=exercises.filter(e=>e.topic===topic).length;
      const message=affected
        ? `Удалить тему «${topic}»? ${affected} карточек останутся в библиотеке без темы. Сами карточки и их данные не удалятся.`
        : `Удалить тему «${topic}»?`;
      if(!confirm(message))return;
      topics=topics.filter(t=>t!==topic);
      exercises.forEach(e=>{if(e.topic===topic)e.topic='';});
      plans.forEach(plan=>(plan.items||[]).forEach(item=>{if(item.topic===topic)item.topic='';}));
      currentPlan.forEach(item=>{if(item.topic===topic)item.topic='';});
      fillTopics();await persist();renderTopicManager();toast('Тема удалена');
    };
    row.append(input,rename,remove);box.append(row);
  });
}
$('manageTopicsBtn').onclick=()=>{renderTopicManager();$('topicsDialog').showModal();};
$('closeTopicsDialog').onclick=()=>$('topicsDialog').close();
$('closeTopicsDone').onclick=()=>$('topicsDialog').close();
$('addTopicBtn').onclick=async()=>{
  const input=$('newTopicInput');const name=input.value.trim();
  if(!name){toast('Введите название темы');return;}
  if(topics.some(t=>t.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'))){toast('Такая тема уже существует');return;}
  topics.push(name);input.value='';fillTopics();await persist();renderTopicManager();toast('Тема добавлена');
};
$('newTopicInput').addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();$('addTopicBtn').click();}});

function addToPlan(e){currentPlan.push({...structuredClone(e),itemId:uid(),duration:Number(e.duration)||8});renderPlan();switchTab('builder');toast('Добавлено в тренировку');}
function renderPlan(){$('planList').innerHTML='';currentPlan.forEach((e,i)=>{const row=document.createElement('div');row.className='plan-item';const head=document.createElement('div');head.className='plan-item-head';const title=document.createElement('strong');title.textContent=`${i+1}. ${e.name}`;const remove=document.createElement('button');remove.className='mini-btn';remove.textContent='Удалить';remove.onclick=()=>{currentPlan.splice(i,1);renderPlan();};head.append(title,remove);const meta=document.createElement('div');meta.className='muted';meta.textContent=e.topic;const controls=document.createElement('div');controls.className='plan-item-controls';const label=document.createElement('span');label.className='muted';label.textContent='Минуты:';const input=document.createElement('input');input.type='number';input.min='1';input.value=e.duration;input.onchange=()=>{e.duration=Math.max(1,Number(input.value)||1);renderPlan();};const up=document.createElement('button');up.className='mini-btn';up.textContent='↑';up.disabled=i===0;up.onclick=()=>{[currentPlan[i-1],currentPlan[i]]=[currentPlan[i],currentPlan[i-1]];renderPlan();};const down=document.createElement('button');down.className='mini-btn';down.textContent='↓';down.disabled=i===currentPlan.length-1;down.onclick=()=>{[currentPlan[i+1],currentPlan[i]]=[currentPlan[i],currentPlan[i+1]];renderPlan();};controls.append(label,input,up,down);row.append(head,meta,controls);$('planList').append(row);});const total=currentPlan.reduce((s,e)=>s+Number(e.duration||0),0);$('planTotal').textContent=`${total} мин`;$('planItems').textContent=`${currentPlan.length} упражнений`;$('planCount').textContent=currentPlan.length;$('emptyPlan').classList.toggle('hidden',currentPlan.length>0);$('savePlanBtn').disabled=!currentPlan.length;$('clearPlanBtn').disabled=!currentPlan.length;}
$('clearPlanBtn').onclick=()=>{currentPlan=[];renderPlan();};
$('savePlanBtn').onclick=async()=>{const name=$('trainingName').value.trim()||'Тренировка';plans.unshift({id:uid(),name,date:new Date().toISOString(),items:structuredClone(currentPlan)});currentPlan=[];await persist();$('trainingName').value='Новая тренировка';switchTab('plans');toast('Тренировка сохранена');};
function renderPlans(){$('savedPlans').innerHTML='';$('emptyPlans').classList.toggle('hidden',plans.length>0);plans.forEach(p=>{const card=document.createElement('div');card.className='saved-plan';const h=document.createElement('strong');h.textContent=p.name;const d=document.createElement('p');d.className='muted';d.textContent=`${new Date(p.date).toLocaleDateString('ru-RU')} · ${p.items.length} упражнений · ${p.items.reduce((s,x)=>s+Number(x.duration||0),0)} мин`;const names=document.createElement('p');names.textContent=p.items.map(x=>x.name).join(' · ');const actions=document.createElement('div');actions.className='card-actions';const edit=document.createElement('button');edit.className='button ghost';edit.textContent='Открыть копию';edit.onclick=()=>{$('trainingName').value=p.name+' — копия';currentPlan=structuredClone(p.items).map(x=>({...x,itemId:uid()}));renderPlan();switchTab('builder');};const del=document.createElement('button');del.className='button danger';del.textContent='Удалить';del.onclick=async()=>{if(confirm('Удалить этот план?')){plans=plans.filter(x=>x.id!==p.id);await persist();}};actions.append(edit,del);card.append(h,d,names,actions);$('savedPlans').append(card);});}
function resetForm(){ $('exerciseForm').reset();$('exerciseId').value='';$('exTopic').value=topics[0]||'';$('exDuration').value=8;pendingImages=[];existingImageUrls=[];$('imagePreview').innerHTML='';$('existingImages').innerHTML='';$('videoFields').innerHTML='';$('deleteExerciseBtn').classList.add('hidden');$('dialogTitle').textContent='Новое упражнение';}
function videoRow(v={title:'',url:'',note:''}){const row=document.createElement('div');row.className='video-row';['title','url','note'].forEach((k,i)=>{const input=document.createElement('input');input.placeholder=['Название видео','https://…','Комментарий'][i];input.value=v[k]||'';input.dataset.key=k;row.append(input);});const rm=document.createElement('button');rm.type='button';rm.className='mini-btn';rm.textContent='×';rm.onclick=()=>row.remove();row.append(rm);$('videoFields').append(row);}
$('addVideoBtn').onclick=()=>videoRow();
$('exImages').addEventListener('change',async ev=>{for(const file of ev.target.files){if(!file.type.startsWith('image/'))continue;const data=await resizeImage(file);pendingImages.push({name:file.name,data});}renderImagePreviews();ev.target.value='';});
function resizeImage(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const max=1400,scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',.82));};img.onerror=reject;img.src=reader.result;};reader.onerror=reject;reader.readAsDataURL(file);});}
function renderImagePreviews(){const box=$('imagePreview');box.innerHTML='';pendingImages.forEach((im,i)=>{const wrap=document.createElement('div');wrap.style.position='relative';const img=document.createElement('img');img.src=im.data;img.title=i===0&&!existingImageUrls.length?'Главное изображение':'Изображение галереи';const b=document.createElement('button');b.className='mini-btn';b.type='button';b.textContent='×';b.onclick=()=>{pendingImages.splice(i,1);renderImagePreviews();};wrap.append(img,b);box.append(wrap);});}
function editExercise(id){const e=exercises.find(x=>x.id===id);if(!e)return;resetForm();$('dialogTitle').textContent='Редактировать упражнение';$('exerciseId').value=e.id;$('exName').value=e.name;$('exDescription').value=e.description||'';$('exTopic').value=e.topic;$('exLevel').value=e.level;$('exDuration').value=e.duration;$('exFormat').value=e.format||'Индивидуально';$('exShots').value=(e.shots||[]).join(', ');$('exTags').value=(e.tags||[]).join(', ');$('exZones').value=(e.zones||[]).join(', ');$('exEquipment').value=e.equipment||'';$('exNotes').value=e.notes||'';existingImageUrls=structuredClone(e.images||[]);renderExistingImages();(e.videos||[]).forEach(videoRow);$('deleteExerciseBtn').classList.remove('hidden');$('exerciseDialog').showModal();}
function renderExistingImages(){const box=$('existingImages');box.innerHTML='';existingImageUrls.forEach((im,i)=>{const wrap=document.createElement('div');wrap.style.position='relative';const img=document.createElement('img');img.src=im.data;img.title=i===0?'Главное изображение':'Галерея';const b=document.createElement('button');b.type='button';b.className='mini-btn';b.textContent='×';b.onclick=()=>{existingImageUrls.splice(i,1);renderExistingImages();};wrap.append(img,b);box.append(wrap);});}
$('addExerciseBtn').onclick=()=>{resetForm();$('exerciseDialog').showModal();};
$('closeDialog').onclick=()=>$('exerciseDialog').close();
async function deleteExerciseById(id){
  const exercise=exercises.find(e=>String(e.id)===String(id));if(!exercise)return;
  if(!confirm(`Удалить упражнение «${exercise.name}» из библиотеки? Сохранённые планы останутся без изменений.`))return;
  exercises=exercises.filter(e=>String(e.id)!==String(id));selectedExerciseIds.delete(String(id));
  await persist();if($('exerciseDialog').open)$('exerciseDialog').close();toast('Упражнение удалено');
}
$('deleteExerciseBtn').onclick=()=>deleteExerciseById($('exerciseId').value);
$('exerciseForm').addEventListener('submit',async ev=>{ev.preventDefault();const id=$('exerciseId').value;const videos=[...$('videoFields').children].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.key,i.value.trim()]))).filter(v=>v.url);const old=exercises.find(e=>String(e.id)===id);const images=[...existingImageUrls,...pendingImages];const e={id:id?Number(id):Date.now(),name:$('exName').value.trim(),description:$('exDescription').value,topic:$('exTopic').value,level:$('exLevel').value,duration:Math.max(1,Number($('exDuration').value)||1),format:$('exFormat').value,shots:parseList($('exShots').value),tags:parseList($('exTags').value),zones:parseList($('exZones').value),equipment:$('exEquipment').value,notes:$('exNotes').value,images,videos,personalDifficulty:old?.personalDifficulty||'',trainingNotes:old?.trainingNotes||[]};if(old)exercises=exercises.map(x=>x.id===old.id?e:x);else exercises.unshift(e);await persist();$('exerciseDialog').close();toast(old?'Изменения сохранены':'Упражнение добавлено');});

async function copyLink(value){
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);toast('Ссылка скопирована');return;}
  }catch{}
  const field=document.createElement('textarea');field.value=value;field.setAttribute('readonly','');
  field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();
  let copied=false;try{copied=document.execCommand('copy');}catch{}
  field.remove();
  if(copied)toast('Ссылка скопирована');else window.prompt('Скопируйте ссылку:',value);
}

function showDetail(id){const e=exercises.find(x=>x.id===id);if(!e)return;selectedDetail=id;$('detailTitle').textContent=e.name;$('detailMeta').textContent=`${e.topic||'Без темы'} · ${e.level||'—'} · ${e.duration||'—'} мин · ${e.format||''}`;const box=$('detailContent');box.innerHTML='';if(e.images?.[0]){const img=document.createElement('img');img.className='detail-hero';img.src=e.images[0].data;box.append(img);}if(e.images?.length>1){const gallery=document.createElement('div');gallery.className='gallery';e.images.slice(1).forEach(im=>{const img=document.createElement('img');img.src=im.data;gallery.append(img);});box.append(gallery);}const section=(title,content)=>{if(!content)return;const s=document.createElement('div');s.className='detail-section';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('div');p.textContent=content;s.append(h,p);box.append(s);};section('Описание',e.description);section('Виды ударов',(e.shots||[]).join(', '));section('Дополнительные теги',(e.tags||[]).join(', '));section('Область применения (зона корта / часть тела)',(e.zones||[]).join(', '));section('Инвентарь',e.equipment);section('Постоянные заметки',e.notes);if(e.videos?.length){
  const s=document.createElement('div');s.className='detail-section';
  const h=document.createElement('h3');h.textContent='Видео и ссылки';s.append(h);
  e.videos.forEach(v=>{
    const item=document.createElement('div');item.className='video-item';
    const info=document.createElement('div');info.className='video-info';
    let isWeChat=false;
    try{const host=new URL(v.url).hostname.toLowerCase();isWeChat=host==='weixin.qq.com'||host.endsWith('.weixin.qq.com');}catch{}
    const title=document.createElement('div');title.className='video-title';title.textContent=(v.title||'Видео')+(v.note?' — '+v.note:'');
    info.append(title);
    if(isWeChat){
      const urlText=document.createElement('div');urlText.className='video-url';urlText.textContent=v.url;info.append(urlText);
      const badge=document.createElement('span');badge.className='platform-chip';badge.textContent='WeChat';info.append(badge);
    }else{
      const a=document.createElement('a');a.className='video-link';a.textContent=v.url;a.href=v.url;a.target='_blank';a.rel='noopener noreferrer';info.append(a);
    }
    const copy=document.createElement('button');copy.type='button';copy.className='button ghost small copy-link-btn';
    copy.textContent=isWeChat?'Копировать ссылку':'Копировать';
    copy.onclick=()=>copyLink(v.url);
    item.append(info,copy);s.append(item);
  });
  box.append(s);
}const pd=document.createElement('div');pd.className='detail-section';const h=document.createElement('h3');h.textContent='Моя оценка сложности';const sel=document.createElement('select');sel.innerHTML='<option value="">Не оценено</option><option>Легко</option><option>Средне</option><option>Трудно</option>';sel.value=e.personalDifficulty||'';sel.onchange=async()=>{e.personalDifficulty=sel.value;await persist();toast('Оценка сохранена');};pd.append(h,sel);box.append(pd);const notes=document.createElement('div');notes.className='detail-section';const nh=document.createElement('h3');nh.textContent='Заметка после тренировки';const ta=document.createElement('textarea');ta.rows=2;ta.placeholder='Что получилось, что стоит исправить…';const nb=document.createElement('button');nb.className='button ghost';nb.textContent='Сохранить заметку';nb.onclick=async()=>{e.trainingNotes=e.trainingNotes||[];e.trainingNotes.unshift({date:new Date().toISOString(),text:ta.value});await persist();ta.value='';toast('Заметка сохранена');};notes.append(nh,ta,nb);(e.trainingNotes||[]).slice(0,5).forEach(n=>{const p=document.createElement('p');p.className='muted';p.textContent=`${new Date(n.date).toLocaleDateString('ru-RU')}: ${n.text}`;notes.append(p);});box.append(notes);$('detailDialog').showModal();}
$('closeDetail').onclick=()=>$('detailDialog').close();$('detailAddBtn').onclick=()=>{const e=exercises.find(x=>x.id===selectedDetail);if(e)addToPlan(e);$('detailDialog').close();};$('detailEditBtn').onclick=()=>{$('detailDialog').close();editExercise(selectedDetail);};
$('exerciseGrid').addEventListener('click',ev=>{});
$('exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify({format:'badminton-training-backup',version:2,exportedAt:new Date().toISOString(),exercises,plans,topics},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`badminton-training-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);toast('Резервная копия подготовлена');};
$('importInput').onchange=async ev=>{const file=ev.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(data.format!=='badminton-training-backup'||!Array.isArray(data.exercises)||!Array.isArray(data.plans))throw new Error('Неподходящий формат файла');if(!confirm(`Импортировать ${data.exercises.length} упражнений и ${data.plans.length} планов? Текущая библиотека будет заменена.`))return;exercises=data.exercises;plans=data.plans;topics=Array.isArray(data.topics)?data.topics.map(t=>String(t).trim()).filter(Boolean):collectLegacyTopics(exercises);fillTopics();await persist();toast('Данные импортированы');}catch(err){alert('Не удалось импортировать файл: '+err.message);}finally{ev.target.value='';}};
// ---------------- Google Drive synchronisation ----------------
// Apps Script is called as a normal web endpoint (no iframe / HtmlService).
// Reads use Google's documented JSONP pattern. Writes use a simple text/plain
// POST with no-cors; the result is verified with a subsequent JSONP read.
function initSyncBridge(){
  // The endpoint is checked when the user saves the token and syncNow() runs.
  syncBridgeReady=false;
  updateSyncUI();
}
function jsonpRequest(action){
  return new Promise((resolve,reject)=>{
    const callbackName=`__btSyncJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script=document.createElement('script');
    const url=new URL(SYNC_EXEC_URL);
    let settled=false;
    const cleanup=()=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      script.remove();
      try{delete window[callbackName];}catch{window[callbackName]=undefined;}
    };
    const timer=setTimeout(()=>{
      cleanup();
      reject(new Error('Google Apps Script не ответил на запрос чтения. Проверьте публикацию Code.gs и доступ к скрипту.'));
    },30000);
    window[callbackName]=(response)=>{
      cleanup();
      if(!response || response.ok!==true){
        reject(new Error(response?.error || 'Google Apps Script вернул некорректный ответ.'));
        return;
      }
      resolve(response);
    };
    script.async=true;
    script.referrerPolicy='no-referrer';
    script.onerror=()=>{
      cleanup();
      reject(new Error('Не удалось обратиться к Google Apps Script. Проверьте URL веб-приложения и публикацию новой версии.'));
    };
    url.searchParams.set('action',action);
    url.searchParams.set('token',syncToken);
    url.searchParams.set('prefix',callbackName);
    url.searchParams.set('_',String(Date.now()));
    script.src=url.toString();
    document.head.appendChild(script);
  });
}
async function callSyncBridge(action,payload=null){
  if(!syncToken) throw new Error('Сначала сохраните SYNC_TOKEN на этом устройстве.');
  if(action==='read' || action==='ping'){
    const response=await jsonpRequest(action);
    syncBridgeReady=true;
    updateSyncUI();
    return action==='read' ? response.record : response;
  }
  if(action==='write'){
    const writeId=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body={action:'write',token:syncToken,payload:{...payload,writeId}};
    const json=JSON.stringify(body);
    if(json.length>7.5*1024*1024) throw new Error('Данные занимают слишком много места для текущей версии синхронизации (лимит около 7,5 МБ). Уменьшите размер или число фотографий.');

    try{
      // text/plain is a CORS-safelisted content type, so the browser does not
      // issue an OPTIONS preflight. The response is intentionally opaque.
      await fetch(SYNC_EXEC_URL,{
        method:'POST',
        mode:'no-cors',
        redirect:'follow',
        headers:{'Content-Type':'text/plain;charset=UTF-8'},
        body:json
      });
    }catch(err){
      throw new Error('Не удалось отправить данные в Google Apps Script: '+(err?.message||String(err)));
    }

    // Since no-cors responses are unreadable, verify the write by reading the
    // record back and checking its unique writeId.
    const response=await jsonpRequest('read');
    syncBridgeReady=true;
    updateSyncUI();
    const current=response.record;
    if(current && current.lastWriteId===writeId){
      return {ok:true,revision:Number(current.revision),updatedAt:current.updatedAt};
    }
    if(current && Number(current.revision)!==Number(payload.baseRevision)){
      return {ok:false,conflict:true,current};
    }
    throw new Error('Google Apps Script принял запрос, но не удалось подтвердить запись в Google Drive. Повторите синхронизацию.');
  }
  throw new Error('Неизвестная операция синхронизации: '+action);
}
function updateSyncUI(){
  const tokenInput=$('syncTokenInput');
  if(tokenInput && tokenInput.value!==syncToken && document.activeElement!==tokenInput) tokenInput.value=syncToken;
  const configured=Boolean(syncToken);
  const status=$('syncStatus');
  const syncButton=$('syncNowBtn'), downloadButton=$('downloadCloudBtn'), uploadButton=$('uploadCloudBtn');
  if(syncButton) syncButton.disabled=!configured || syncInProgress;
  if(downloadButton) downloadButton.disabled=!configured || syncInProgress;
  if(uploadButton) uploadButton.disabled=!configured || syncInProgress;
  if($('saveSyncTokenBtn')) $('saveSyncTokenBtn').disabled=syncInProgress;
  if(status){
    if(syncInProgress) status.textContent='Выполняется синхронизация…';
    else if(syncErrorMessage) status.textContent='Ошибка синхронизации: '+syncErrorMessage;
    else if(!configured) status.textContent='Синхронизация ещё не настроена на этом устройстве. Введите SYNC_TOKEN.';
    else if(!syncBridgeReady) status.textContent='Ключ сохранён. Проверяем соединение с Google Apps Script…';
    else if(syncMeta.dirty) status.textContent='Есть локальные изменения, ожидающие отправки в Google Drive.';
    else status.textContent='Подключение настроено. Локальная копия синхронизирована.';
  }
  const last=$('syncLastSync');
  if(last) last.textContent=syncMeta.lastSyncedAt ? `Последняя синхронизация: ${new Date(syncMeta.lastSyncedAt).toLocaleString('ru-RU')} · версия облака ${syncMeta.revision||0}` : (syncMeta.revision ? `Версия облака: ${syncMeta.revision}` : 'Облачная копия ещё не синхронизировалась.');
}
function scheduleAutoSync(){
  if(!syncToken || applyingCloudData || !navigator.onLine) return;
  clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>syncNow({silent:true}).catch(err=>{
    console.warn('Автоматическая синхронизация не выполнена:',err);
    if($('syncStatus')) $('syncStatus').textContent='Автосинхронизация не выполнена: '+err.message;
  }),1800);
}
function localHasData(){return exercises.length>0 || plans.length>0 || JSON.stringify(topics)!==JSON.stringify(DEFAULT_TOPICS);}
function validateCloudRecord(record){
  if(!record || !Number.isFinite(Number(record.revision))) throw new Error('Google Drive вернул некорректную запись.');
  if(record.data!==null && record.data!==undefined && (!Array.isArray(record.data.exercises) || !Array.isArray(record.data.plans) || (record.data.topics!==undefined && !Array.isArray(record.data.topics)))) throw new Error('Формат данных в Google Drive не распознан. Локальная библиотека не изменена.');
  return record;
}
async function applyCloudRecord(record){
  validateCloudRecord(record);
  if(!record.data) throw new Error('В Google Drive пока нет сохранённой библиотеки.');
  applyingCloudData=true;
  try{
    exercises=structuredClone(record.data.exercises);
    plans=structuredClone(record.data.plans);
    topics=Array.isArray(record.data.topics)?structuredClone(record.data.topics):collectLegacyTopics(exercises);
    await putRecord('exercises',exercises);
    await putRecord('plans',plans);
    await putRecord('topics',topics);
    syncMeta={revision:Number(record.revision),dirty:false,lastSyncedAt:record.updatedAt||new Date().toISOString()};
    await putRecord('syncMeta',syncMeta);
    renderAll();
  }finally{applyingCloudData=false;}
}
async function uploadLocalRecord(baseRevision){
  const data={exercises,plans,topics};
  const json=JSON.stringify(data);
  if(json.length>7.5*1024*1024) throw new Error('Данные занимают слишком много места для текущей версии синхронизации (лимит около 7,5 МБ). Уменьшите размер или число фотографий.');
  const result=await callSyncBridge('write',{baseRevision:Number(baseRevision),data});
  if(result && result.conflict) return {conflict:true,current:validateCloudRecord(result.current)};
  if(!result || result.ok!==true) throw new Error('Google Drive не подтвердил сохранение данных.');
  syncMeta={revision:Number(result.revision),dirty:false,lastSyncedAt:result.updatedAt||new Date().toISOString()};
  await putRecord('syncMeta',syncMeta);
  updateSyncUI();
  return {ok:true};
}
async function reconcileCloudRecord(record,token,depth=0){
  validateCloudRecord(record);
  const cloudHasData=Boolean(record.data);
  const hasLocal=localHasData();
  const knownRevision=Number(syncMeta.revision||0);
  const cloudRevision=Number(record.revision||0);
  const localDirty=Boolean(syncMeta.dirty);

  if(!cloudHasData){
    const uploaded=await uploadLocalRecord(cloudRevision);
    if(uploaded.conflict){
      if(depth>=2) throw new Error('Облако изменилось одновременно на другом устройстве. Повторите синхронизацию.');
      return reconcileCloudRecord(uploaded.current,token,depth+1);
    }
    return;
  }

  if(knownRevision===0 && !hasLocal){
    await applyCloudRecord(record);
    return;
  }

  const cloudChanged=cloudRevision!==knownRevision;
  if(knownRevision===0 && hasLocal){
    const useLocal=confirm('В Google Drive уже есть библиотека, и на этом устройстве тоже есть данные.\n\nOK — отправить данные этого устройства в облако (заменить облачную копию).\nОтмена — загрузить библиотеку из облака (заменить локальную копию).');
    if(useLocal){
      const uploaded=await uploadLocalRecord(cloudRevision);
      if(uploaded.conflict){
        if(depth>=2) throw new Error('Облако снова изменилось. Повторите синхронизацию.');
        return reconcileCloudRecord(uploaded.current,token,depth+1);
      }
    }else await applyCloudRecord(record);
    return;
  }

  if(!cloudChanged){
    if(localDirty){
      const uploaded=await uploadLocalRecord(cloudRevision);
      if(uploaded.conflict){
        if(depth>=2) throw new Error('Облако изменилось одновременно на другом устройстве. Повторите синхронизацию.');
        return reconcileCloudRecord(uploaded.current,token,depth+1);
      }
    }
    return;
  }

  if(!localDirty){
    await applyCloudRecord(record);
    return;
  }

  const keepLocal=confirm('Облачная библиотека изменилась на другом устройстве, и здесь тоже есть несинхронизированные изменения.\n\nOK — отправить локальную версию в облако, заменив облачные изменения.\nОтмена — загрузить облачную версию, заменив локальные изменения.');
  if(keepLocal){
    const uploaded=await uploadLocalRecord(cloudRevision);
    if(uploaded.conflict){
      if(depth>=2) throw new Error('Облако снова изменилось. Повторите синхронизацию.');
      return reconcileCloudRecord(uploaded.current,token,depth+1);
    }
  }else await applyCloudRecord(record);
}
async function syncNow(options={}){
  if(syncInProgress) return;
  if(!syncToken){
    if(!options.silent) alert('Сначала введите и сохраните SYNC_TOKEN из Google Apps Script.');
    return;
  }
  if(!navigator.onLine){
    if(!options.silent) toast('Нет подключения к интернету. Изменения останутся на устройстве.');
    return;
  }
  syncInProgress=true;
  updateSyncUI();
  try{
    const record=validateCloudRecord(await callSyncBridge('read'));
    await reconcileCloudRecord(record,syncToken);
    syncErrorMessage='';
    if($('syncStatus')) $('syncStatus').textContent='Синхронизация завершена.';
    updateSyncUI();
    if(!options.silent) toast('Синхронизация завершена');
  }catch(err){
    console.error('Google Drive sync error:',err);
    syncErrorMessage=err.message;
    if(!options.silent) alert('Не удалось синхронизировать данные: '+err.message);
  }finally{
    syncInProgress=false;
    updateSyncUI();
  }
}
async function downloadCloudNow(){
  if(!syncToken) return;
  syncInProgress=true; updateSyncUI();
  try{
    const record=validateCloudRecord(await callSyncBridge('read'));
    if(!record.data) throw new Error('В Google Drive пока нет данных.');
    if(localHasData() && !confirm('Заменить библиотеку и планы на этом устройстве данными из Google Drive?')) return;
    await applyCloudRecord(record);
    toast('Данные загружены из Google Drive');
  }catch(err){alert('Не удалось загрузить данные: '+err.message);}
  finally{syncInProgress=false;updateSyncUI();}
}
async function uploadCloudNow(){
  if(!syncToken) return;
  syncInProgress=true; updateSyncUI();
  try{
    const record=validateCloudRecord(await callSyncBridge('read'));
    const message=record.data ? 'Заменить текущую облачную библиотеку данными этого устройства?' : 'Загрузить библиотеку этого устройства в Google Drive?';
    if(!confirm(message)) return;
    const result=await uploadLocalRecord(Number(record.revision||0));
    if(result.conflict) throw new Error('Облако изменилось во время операции. Повторите попытку.');
    toast('Данные отправлены в Google Drive');
  }catch(err){alert('Не удалось отправить данные: '+err.message);}
  finally{syncInProgress=false;updateSyncUI();}
}
$('saveSyncTokenBtn').addEventListener('click',async()=>{
  const nextToken=$('syncTokenInput').value.trim();
  if(!nextToken){alert('Вставьте SYNC_TOKEN из журнала выполнения Apps Script.');return;}
  const changed=nextToken!==syncToken;
  syncErrorMessage='';
  syncToken=nextToken;
  localStorage.setItem('badminton-training-sync-token',syncToken);
  if(changed){syncMeta={revision:0,dirty:syncMeta.dirty,lastSyncedAt:null};await putRecord('syncMeta',syncMeta);}
  updateSyncUI();
  toast('Ключ сохранён только в этом браузере');
  await syncNow();
});
$('syncNowBtn').addEventListener('click',()=>syncNow());
$('downloadCloudBtn').addEventListener('click',downloadCloudNow);
$('uploadCloudBtn').addEventListener('click',uploadCloudNow);
window.addEventListener('online',()=>{if(syncToken)scheduleAutoSync();});

let deferredInstall=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$('installBtn').classList.remove('hidden');});$('installBtn').onclick=async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('installBtn').classList.add('hidden');};
(async()=>{
  fillTopics();
  syncToken=localStorage.getItem('badminton-training-sync-token')||'';
  db=await openDB();
  await loadAll();
  initSyncBridge();
  if('serviceWorker'in navigator){
    navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>reg.update()).catch(()=>{});
  }
  if(syncToken) syncNow({silent:true});
})().catch(err=>{console.error(err);alert('Не удалось открыть локальную базу данных браузера.');});
