const DB_NAME='badminton-training-db', DB_VERSION=1, STORE='records';
const SYNC_EXEC_URL='https://script.google.com/macros/s/AKfycbwi4GIckQ2ZmeMlUu54b9ZmqYOUln-ADMRs7hTs54ILgCNGOg73iiB7DAOFL4w4PPVabQ/exec';
const SYNC_CHANNEL='badminton-training-sync';
const DEFAULT_TOPICS=['Техника','Перемещения','Игра у сетки','Атака и защита','Подача и приём','Тактика','Физическая подготовка'];
let db, exercises=[], plans=[], topics=[...DEFAULT_TOPICS], workoutHistory=[], currentPlan=[], selectedDetail=null, pendingImages=[], existingImageUrls=[], activeWorkoutLogPlan=null, editingWorkoutRecordId=null, activeHistoryCategory='all', activePlanCategory='all';
let selectionMode=false, lightboxImages=[], lightboxIndex=0;
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
  workoutHistory=await getRecord('workoutHistory')||[];
  let historyCategoriesMigrated=false;
  workoutHistory.forEach(record=>{if(!record.category){record.category=inferWorkoutCategory(record);historyCategoriesMigrated=true;}});
  const savedTopics=await getRecord('topics');
  topics=Array.isArray(savedTopics)?savedTopics:collectLegacyTopics(exercises);
  syncMeta=await getRecord('syncMeta')||{revision:0,dirty:false,lastSyncedAt:null};
  // Repair malformed field headings left by earlier Markdown imports.
  // Do this for both the library and exercise snapshots inside saved plans.
  let repaired=cleanMarkdownFieldArtifacts(exercises);
  for(const plan of plans){
    if(Array.isArray(plan.items)) repaired=cleanMarkdownFieldArtifacts(plan.items)||repaired;
    if(!WORKOUT_CATEGORIES.includes(plan.category)){
      plan.category=inferWorkoutCategory({planName:plan.name,items:plan.items||[]});
      repaired=true;
    }
  }
  for(const entry of workoutHistory){
    if(Array.isArray(entry.items)) repaired=cleanMarkdownFieldArtifacts(entry.items.map(item=>item.exerciseSnapshot).filter(Boolean))||repaired;
  }
  if(repaired || historyCategoriesMigrated){
    await putRecord('exercises',exercises);
    await putRecord('plans',plans);
    await putRecord('workoutHistory',workoutHistory);
    syncMeta={...syncMeta,dirty:true,localUpdatedAt:new Date().toISOString()};
    await putRecord('syncMeta',syncMeta);
  }
  fillTopics();
  renderAll();
}
function decodePossibleMarkdownArtifact(value){
  return String(value??'')
    .replace(/&#x20;|&#32;|&nbsp;/gi,' ')
    .replace(/\\\*/g,'*')
    .replace(/&#x2a;|&#42;|&ast;/gi,'*')
    .trim();
}
function getAccidentalFieldHeading(value){
  const text=decodePossibleMarkdownArtifact(value);
  const match=text.match(/^\*\*\s*(Основная тема|Дополнительные теги|Область применения|Виды ударов|Видео)\s*:\s*\*\*\s*(.*)$/i);
  return match?{label:match[1].toLocaleLowerCase('ru'),value:match[2].trim()}:null;
}
function asStoredList(value){
  if(Array.isArray(value))return value.map(item=>String(item??'').trim()).filter(Boolean);
  if(value===null||value===undefined||value==='')return [];
  return String(value).split(/[,;；、]/).map(item=>item.trim()).filter(Boolean);
}
function appendUniqueFieldValues(target,values){
  for(const value of values){
    const item=String(value??'').trim();
    if(item&&!target.some(existing=>String(existing).toLocaleLowerCase('ru')===item.toLocaleLowerCase('ru')))target.push(item);
  }
}
function expandLegacyBilingualShot(value){
  const text=String(value??'').trim();
  const match=text.match(/^(.+?)\s+\(([A-Za-z][A-Za-z -]*)\)$/);
  if(!match)return [text];
  let russian=match[1].trim();
  if(russian.toLocaleLowerCase('ru')==='укороченный')russian='Укороченный удар';
  return [russian,match[2].trim()];
}
function cleanMarkdownFieldArtifacts(items=exercises){
  // The older parser used \s* after a field label. For an empty value that
  // could consume the newline and put the next field heading into this field.
  // Repair those records, including copies embedded in saved plans.
  const destination={
    'дополнительные теги':'tags',
    'область применения':'zones',
    'виды ударов':'shots'
  };
  let changed=false;
  for(const exercise of items||[]){
    if(!exercise||typeof exercise!=='object')continue;
    const fields={};
    for(const field of ['tags','zones','shots']){
      const normalized=asStoredList(exercise[field]);
      if(!Array.isArray(exercise[field])||JSON.stringify(normalized)!==JSON.stringify(exercise[field]))changed=true;
      fields[field]=[];
    }
    const misplaced=[];
    // First keep all values that already belong to their own fields.
    for(const field of ['tags','zones','shots']){
      for(const rawValue of asStoredList(exercise[field])){
        const artifact=getAccidentalFieldHeading(rawValue);
        if(artifact){misplaced.push(artifact);changed=true;}
        else{
          const decoded=decodePossibleMarkdownArtifact(rawValue);
          appendUniqueFieldValues(fields[field],field==='shots'?expandLegacyBilingualShot(decoded):[decoded]);
        }
      }
    }
    // Only recover text from a misplaced heading if its correct field is empty.
    // Correct values are collected first, so this cannot create duplicates.
    for(const artifact of misplaced){
      const targetField=destination[artifact.label];
      if(targetField&&artifact.value&&!fields[targetField].length){
        appendUniqueFieldValues(fields[targetField],artifact.value.split(/[,;；、]/).map(x=>x.trim()).filter(Boolean));
      }
    }
    for(const field of ['tags','zones','shots']){
      if(JSON.stringify(exercise[field]??[])!==JSON.stringify(fields[field])){
        exercise[field]=fields[field];
        changed=true;
      }
    }
  }
  return changed;
}
async function persist(){
  await putRecord('exercises',exercises);
  await putRecord('plans',plans);
  await putRecord('topics',topics);
  await putRecord('workoutHistory',workoutHistory);
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
  renderLibrary();renderPlan();renderPlans();renderWorkoutHistory();
  $('exerciseCount').textContent=`${exercises.length} упражнений`;
  $('storageInfo').textContent=`Локальная копия: ${exercises.length} упражнений, ${plans.length} планов и ${workoutHistory.length} записей о тренировках. Фото хранятся в базе браузера и синхронизируются вместе с карточками.`;
  const historyCount=$('workoutHistoryCount');if(historyCount)historyCount.textContent=workoutHistory.length;
  renderBulkTools();
  if(typeof updateSyncUI==='function')updateSyncUI();
}
function getFilteredExercises(){
  const q=$('searchInput').value.toLowerCase();
  const topic=$('topicFilter').value;
  const level=$('levelFilter').value;
  return exercises.filter(e=>(!topic||e.topic===topic)&&(!level||e.level===level)&&[e.name,e.description,e.topic,e.shots,e.tags,e.zones].flat().join(' ').toLowerCase().includes(q));
}
// The UI values are intentionally different from the data keys. This explicit
// mapping prevents an application-area value from accidentally being written to tags.
const BULK_TAG_TYPES={
  additionalTags:{field:'tags',label:'Дополнительные теги',noun:'дополнительный тег',placeholder:'Дополнительный тег для выбранных карточек'},
  applicationArea:{field:'zones',label:'Область применения',noun:'область применения',placeholder:'Зона корта или часть тела'},
  shotType:{field:'shots',label:'Вид удара',noun:'вид удара',placeholder:'Вид удара для выбранных карточек'}
};
function getSelectedBulkTagType(){
  const key=$('bulkTagType')?.value;
  return Object.prototype.hasOwnProperty.call(BULK_TAG_TYPES,key)?BULK_TAG_TYPES[key]:null;
}
function updateBulkTagOptions(){
  const list=$('existingTagOptions');
  const type=getSelectedBulkTagType();
  const input=$('bulkTagInput');
  if(!list||!input)return;
  list.innerHTML='';
  if(!type){
    input.placeholder='Сначала выберите тип значения';
    $('bulkTagTargetHint').textContent='Выберите тип значения, чтобы указать поле назначения.';
    return;
  }
  const values=[...new Set(exercises.flatMap(e=>Array.isArray(e[type.field])?e[type.field]:[]).map(t=>String(t).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  values.forEach(value=>list.append(new Option(value,value)));
  input.placeholder=type.placeholder;
  input.setAttribute('aria-label',type.label);
  $('bulkTagTargetHint').textContent=`Значение будет добавлено в поле «${type.label}» у всех выбранных карточек.`;
}
function renderBulkTools(){
  const tools=$('bulkTools');
  if(!tools)return;
  const selectedCount=selectedExerciseIds.size;
  const filteredCount=getFilteredExercises().length;
  tools.classList.toggle('hidden',!selectionMode);
  $('toggleSelectionBtn').textContent=selectionMode?'Завершить выбор':'Выбрать несколько';
  $('selectedCount').textContent=`Выбрано карточек: ${selectedCount}`;
  $('selectAllVisibleBtn').textContent=`Выбрать все найденные (${filteredCount})`;
  $('applyBulkTagBtn').disabled=selectedCount===0;
  $('deleteSelectedBtn').textContent=`Удалить выбранные (${selectedCount})`;
  $('deleteSelectedBtn').disabled=selectedCount===0;
  $('clearSelectionBtn').disabled=selectedCount===0;
}
function renderLibrary(){
  const list=getFilteredExercises();
  $('exerciseGrid').innerHTML='';
  $('emptyLibrary').classList.toggle('hidden',list.length>0);
  list.forEach(e=>{
    const card=document.createElement('article');card.className='exercise-card';
    const thumb=document.createElement('div');thumb.className='thumb';
    if(e.images?.[0]){const img=document.createElement('img');img.src=e.images[0].data;bindImageZoom(img,e.images,0);thumb.append(img);}else thumb.textContent='🏸';
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
  // Replace the previous selection with exactly the cards matching the current
  // search text and active topic/level filters.
  const matches=getFilteredExercises();
  selectedExerciseIds.clear();
  matches.forEach(e=>selectedExerciseIds.add(String(e.id)));
  renderLibrary();
  toast(`Выбрано карточек по текущему поиску: ${matches.length}`);
});
$('deleteSelectedBtn').addEventListener('click',async()=>{
  const selectedIds=new Set([...selectedExerciseIds].map(String));
  const targets=exercises.filter(e=>selectedIds.has(String(e.id)));
  if(!targets.length){toast('Нет выбранных карточек для удаления');return;}
  const sample=targets.slice(0,4).map(e=>`• ${e.name}`).join('\n');
  const more=targets.length>4?`\n…и ещё ${targets.length-4}`:'';
  const message=`Удалить ${targets.length} карточек из библиотеки?\n\n${sample}${more}\n\nЭто действие нельзя отменить. Сохранённые планы не изменятся: упражнения останутся в них как сохранённые копии.`;
  if(!confirm(message))return;
  exercises=exercises.filter(e=>!selectedIds.has(String(e.id)));
  selectedExerciseIds.clear();
  await persist();
  toast(`Удалено карточек: ${targets.length}`);
});
$('clearSelectionBtn').addEventListener('click',()=>{selectedExerciseIds.clear();renderLibrary();});
$('bulkTagType').addEventListener('change',()=>{
  $('bulkTagInput').value='';
  updateBulkTagOptions();
});
$('applyBulkTagBtn').addEventListener('click',async()=>{
  const value=$('bulkTagInput').value.trim();
  const typeInfo=getSelectedBulkTagType();
  if(!typeInfo){toast('Выберите тип значения');return;}
  const field=typeInfo.field;
  if(!value){toast('Введите значение');return;}
  if(value.includes(',')){toast('Добавляйте по одному значению за раз');return;}
  if(!selectedExerciseIds.size){toast('Сначала выберите карточки');return;}
  let changed=0;
  exercises.forEach(e=>{
    if(!selectedExerciseIds.has(String(e.id)))return;
    if(!Array.isArray(e[field]))e[field]=[];
    const exists=e[field].some(existing=>String(existing).trim().toLocaleLowerCase('ru')===value.toLocaleLowerCase('ru'));
    if(!exists){e[field].push(value);changed++;}
  });
  selectedExerciseIds.clear();
  $('bulkTagInput').value='';
  updateBulkTagOptions();
  await persist();
  toast(changed?`Добавлено: ${typeInfo.noun} — в ${changed} карточек`:'У выбранных карточек такое значение уже есть');
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
function renderPlan(){$('planList').innerHTML='';currentPlan.forEach((e,i)=>{const row=document.createElement('div');row.className='plan-item';const head=document.createElement('div');head.className='plan-item-head';const title=document.createElement('strong');title.textContent=`${i+1}. ${e.name}`;const headActions=document.createElement('div');headActions.className='plan-row-actions';const view=document.createElement('button');view.type='button';view.className='mini-btn';view.textContent='Просмотр';view.onclick=()=>showDetail(e,{readOnly:true});const remove=document.createElement('button');remove.className='mini-btn';remove.textContent='Удалить';remove.onclick=()=>{currentPlan.splice(i,1);renderPlan();};headActions.append(view,remove);head.append(title,headActions);const meta=document.createElement('div');meta.className='muted';meta.textContent=e.topic||'Без темы';const controls=document.createElement('div');controls.className='plan-item-controls';const label=document.createElement('span');label.className='muted';label.textContent='Минуты:';const input=document.createElement('input');input.type='number';input.min='1';input.value=e.duration;input.onchange=()=>{e.duration=Math.max(1,Number(input.value)||1);renderPlan();};const up=document.createElement('button');up.className='mini-btn';up.textContent='↑';up.disabled=i===0;up.onclick=()=>{[currentPlan[i-1],currentPlan[i]]=[currentPlan[i],currentPlan[i-1]];renderPlan();};const down=document.createElement('button');down.className='mini-btn';down.textContent='↓';down.disabled=i===currentPlan.length-1;down.onclick=()=>{[currentPlan[i+1],currentPlan[i]]=[currentPlan[i],currentPlan[i+1]];renderPlan();};controls.append(label,input,up,down);row.append(head,meta,controls);$('planList').append(row);});const total=currentPlan.reduce((s,e)=>s+Number(e.duration||0),0);$('planTotal').textContent=`${total} мин`;$('planItems').textContent=`${currentPlan.length} упражнений`;$('planCount').textContent=currentPlan.length;$('emptyPlan').classList.toggle('hidden',currentPlan.length>0);$('savePlanBtn').disabled=!currentPlan.length;$('clearPlanBtn').disabled=!currentPlan.length;}
$('clearPlanBtn').onclick=()=>{currentPlan=[];renderPlan();};
$('savePlanBtn').onclick=async()=>{const name=$('trainingName').value.trim()||'Тренировка';const category=$('trainingCategory').value||'Бадминтон';plans.unshift({id:uid(),name,category,date:new Date().toISOString(),items:structuredClone(currentPlan)});currentPlan=[];await persist();$('trainingName').value='Новая тренировка';$('trainingCategory').value='Бадминтон';switchTab('plans');toast('Тренировка сохранена');};
function getPlanCategory(plan){
  return WORKOUT_CATEGORIES.includes(plan?.category)?plan.category:inferWorkoutCategory({planName:plan?.name,items:plan?.items||[]});
}
function renderPlans(){
  const list=$('savedPlans');
  list.innerHTML='';
  const filteredPlans=plans.filter(plan=>activePlanCategory==='all'||getPlanCategory(plan)===activePlanCategory);
  document.querySelectorAll('[data-plan-category]').forEach(button=>button.classList.toggle('active',button.dataset.planCategory===activePlanCategory));
  const empty=$('emptyPlans');
  empty.textContent=plans.length===0?'Сохранённых тренировок пока нет.':`В категории «${activePlanCategory}» пока нет планов.`;
  empty.classList.toggle('hidden',filteredPlans.length>0);
  filteredPlans.forEach(p=>{
    const card=document.createElement('div');card.className='saved-plan';
    const h=document.createElement('strong');h.textContent=p.name;
    const items=p.items||[];
    const categoryField=document.createElement('label');categoryField.className='plan-category-field';categoryField.textContent='Тема плана';
    const categorySelect=document.createElement('select');categorySelect.className='plan-category-select';
    categorySelect.add(new Option('Бадминтон','Бадминтон'));
    categorySelect.add(new Option('Растяжка','Растяжка'));
    categorySelect.add(new Option('Физическая подготовка','Физическая подготовка'));
    categorySelect.value=getPlanCategory(p);
    categorySelect.onchange=async()=>{p.category=categorySelect.value;await persist();toast('Тема плана обновлена');};
    categoryField.append(categorySelect);
    const d=document.createElement('p');d.className='muted';
    d.textContent=`${new Date(p.date).toLocaleDateString('ru-RU')} · ${items.length} упражнений · ${items.reduce((s,x)=>s+Number(x.duration||0),0)} мин`;
    const itemList=document.createElement('div');itemList.className='saved-plan-items';
    items.forEach((item,index)=>{
      const line=document.createElement('div');line.className='saved-plan-item';
      const name=document.createElement('span');name.textContent=`${index+1}. ${item.name} · ${Number(item.duration||0)} мин`;
      const view=document.createElement('button');view.type='button';view.className='mini-btn';view.textContent='Карточка';view.onclick=()=>showDetail(item,{readOnly:true});
      line.append(name,view);itemList.append(line);
    });
    const actions=document.createElement('div');actions.className='card-actions';
    const log=document.createElement('button');log.className='button primary';log.type='button';log.textContent='Записать выполнение';log.onclick=()=>openWorkoutLogDialog(p);
    const edit=document.createElement('button');edit.className='button ghost';edit.type='button';edit.textContent='Открыть копию';
    edit.onclick=()=>{$('trainingName').value=p.name+' — копия';$('trainingCategory').value=getPlanCategory(p);currentPlan=structuredClone(items).map(x=>({...x,itemId:uid()}));renderPlan();switchTab('builder');};
    
const del=document.createElement('button');del.className='button danger';del.type='button';del.textContent='Удалить';
    del.onclick=async()=>{if(confirm('Удалить этот план? Записи о ранее выполненных тренировках сохранятся.')){plans=plans.filter(x=>x.id!==p.id);await persist();}};
    actions.append(log,edit,del);card.append(h,categoryField,d,itemList,actions);list.append(card);
  });
}
function localDateTimeInputValue(date=new Date()){
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,16);
}
function compactExerciseSnapshot(item){
  const snapshot=structuredClone(item||{});
  // Avoid duplicating large base64 images in every history record. The rest of
  // the card's text, technique tags and video references remain available.
  snapshot.images=[];
  delete snapshot.trainingNotes;
  delete snapshot.personalDifficulty;
  return snapshot;
}
const WORKOUT_CATEGORIES=['Бадминтон','Растяжка','Физическая подготовка'];
function inferWorkoutCategory(record){
  if(WORKOUT_CATEGORIES.includes(record?.category))return record.category;
  const values=[record?.planName,...(record?.items||[]).flatMap(item=>[item.topic,item.exerciseSnapshot?.topic,item.name])].filter(Boolean).join(' ').toLocaleLowerCase('ru');
  if(/растяж|stretch|мобил|гибкост/.test(values))return 'Растяжка';
  if(/физическ|силов|кардио|тренажер|мышц|корпус|ноги|пресс/.test(values))return 'Физическая подготовка';
  return 'Бадминтон';
}
function workoutSourceForItem(item){
  const current=exercises.find(e=>String(e.id)===String(item?.id??item?.exerciseId));
  return current||item?.exerciseSnapshot||item||{};
}
function addWorkoutLogRow(source, values={}){
  const box=$('workoutLogExerciseRows');
  const row=document.createElement('div');row.className='workout-log-exercise';
  const snapshot=compactExerciseSnapshot(source||{});
  row.dataset.item=JSON.stringify(snapshot);
  const head=document.createElement('div');head.className='workout-log-exercise-head';
  const name=document.createElement('strong');name.textContent=source?.name||'Новое упражнение';
  const planned=document.createElement('span');planned.className='muted';planned.textContent=Number(source?.duration)>0?`План: ${Number(source.duration)} мин`:'Добавлено вручную';
  head.append(name,planned);
  const completeLabel=document.createElement('label');completeLabel.className='workout-log-complete';
  const complete=document.createElement('input');complete.type='checkbox';complete.checked=values.completed!==false;complete.dataset.logField='completed';
  completeLabel.append(complete,document.createTextNode('Выполнено'));
  const fields=document.createElement('div');fields.className='workout-log-fields';
  const repsLabel=document.createElement('label');repsLabel.className='field';repsLabel.textContent='Повторений / раз';
  const reps=document.createElement('input');reps.type='number';reps.min='0';reps.step='1';reps.placeholder='Например, 20';reps.dataset.logField='repetitions';reps.value=values.repetitions??'';repsLabel.append(reps);
  const minutesLabel=document.createElement('label');minutesLabel.className='field';minutesLabel.textContent='Фактически, мин';
  const minutes=document.createElement('input');minutes.type='number';minutes.min='0';minutes.step='0.5';minutes.placeholder='Например, 10';minutes.dataset.logField='actualMinutes';minutes.value=values.actualMinutes??'';minutesLabel.append(minutes);
  fields.append(repsLabel,minutesLabel);
  const comment=document.createElement('textarea');comment.rows=2;comment.placeholder='Короткий комментарий: самочувствие, качество, что улучшить…';comment.dataset.logField='comment';comment.value=values.comment||'';
  const remove=document.createElement('button');remove.type='button';remove.className='button danger small';remove.textContent='Убрать упражнение';remove.onclick=()=>row.remove();
  row.append(head,completeLabel,fields,comment,remove);box.append(row);
}
function populateWorkoutExercisePicker(){
  const select=$('workoutAddExerciseSelect');select.innerHTML='';
  select.add(new Option('Выбрать упражнение из библиотеки…',''));
  exercises.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name),'ru')).forEach(item=>select.add(new Option(`${item.name}${item.topic?' · '+item.topic:''}`,String(item.id))));
}
function openWorkoutLogDialog(plan, record=null){
  editingWorkoutRecordId=record?.id??null;
  activeWorkoutLogPlan=plan||{id:null,name:'Самостоятельная тренировка',items:[]};
  $('workoutLogPlanName').textContent=record?'Редактирование записи':(plan?.name||'Самостоятельная тренировка');
  $('workoutLogDate').value=localDateTimeInputValue(record?.date?new Date(record.date):new Date());
  $('workoutLogLocation').value=record?.location||'';
  $('workoutLogPartners').value=record?.partners||'';
  $('workoutLogNote').value=record?.note||'';
  $('workoutLogCategory').value=record?.category||inferWorkoutCategory(plan||record);
  const box=$('workoutLogExerciseRows');box.innerHTML='';
  const initialItems=record?.items||plan?.items||[];
  initialItems.forEach(item=>{
    const source=record?workoutSourceForItem(item):item;
    addWorkoutLogRow(source,record?item:{completed:true});
  });
  populateWorkoutExercisePicker();
  $('workoutLogFormTitle').textContent=record?'Редактировать тренировку':'Запись о тренировке';
  $('saveWorkoutLogBtn').textContent=record?'Сохранить изменения':'Сохранить запись';
  $('workoutLogDialog').showModal();
}
$('workoutAddExerciseBtn').onclick=()=>{
  const id=$('workoutAddExerciseSelect').value;
  const source=exercises.find(e=>String(e.id)===id);
  if(!source){toast('Сначала выбери упражнение из списка');return;}
  addWorkoutLogRow(source,{completed:true});$('workoutAddExerciseSelect').value='';
};
$('workoutAddCustomExerciseBtn').onclick=()=>{
  const name=$('workoutCustomExerciseName').value.trim();
  if(!name){toast('Введи название упражнения');return;}
  addWorkoutLogRow({id:null,name,topic:'',duration:0,description:'',images:[],videos:[]},{completed:true});
  $('workoutCustomExerciseName').value='';
};
$('closeWorkoutLogDialog').onclick=()=>{$('workoutLogDialog').close();activeWorkoutLogPlan=null;editingWorkoutRecordId=null;};
$('cancelWorkoutLogBtn').onclick=()=>{$('workoutLogDialog').close();activeWorkoutLogPlan=null;editingWorkoutRecordId=null;};
$('workoutLogForm').addEventListener('submit',async ev=>{
  ev.preventDefault();
  if(!activeWorkoutLogPlan)return;
  const dateValue=$('workoutLogDate').value;
  const date=new Date(dateValue);
  if(!dateValue||Number.isNaN(date.getTime())){alert('Укажи корректные дату и время тренировки.');return;}
  const rows=[...$('workoutLogExerciseRows').children];
  const items=rows.map(row=>{
    const get=field=>row.querySelector(`[data-log-field="${field}"]`);
    const source=JSON.parse(row.dataset.item||'{}');
    const repsRaw=get('repetitions').value.trim(),minutesRaw=get('actualMinutes').value.trim();
    return {
      exerciseId:source.id??null,name:source.name||'Упражнение',topic:source.topic||'',
      completed:get('completed').checked,plannedMinutes:Number(source.duration)||0,
      repetitions:repsRaw===''?null:Math.max(0,Number(repsRaw)||0),
      actualMinutes:minutesRaw===''?null:Math.max(0,Number(minutesRaw)||0),
      comment:get('comment').value.trim(),exerciseSnapshot:compactExerciseSnapshot(source)
    };
  });
  const existing=editingWorkoutRecordId?workoutHistory.find(x=>String(x.id)===String(editingWorkoutRecordId)):null;
  const record={
    id:existing?.id||uid(),planId:activeWorkoutLogPlan.id??existing?.planId??null,
    planName:existing?.planName||activeWorkoutLogPlan.name||'Самостоятельная тренировка',
    category:$('workoutLogCategory').value,date:date.toISOString(),
    location:$('workoutLogLocation').value.trim(),partners:$('workoutLogPartners').value.trim(),
    note:$('workoutLogNote').value.trim(),items
  };
  if(existing){workoutHistory=workoutHistory.map(x=>String(x.id)===String(existing.id)?record:x);}
  else workoutHistory.unshift(record);
  activeWorkoutLogPlan=null;editingWorkoutRecordId=null;
  $('workoutLogDialog').close();await persist();switchTab('history');
  toast(existing?'Запись тренировки обновлена':'Выполнение тренировки записано');
});
function createPlanFromHistory(record){
  currentPlan=(record.items||[]).map(item=>{
    const current=exercises.find(e=>String(e.id)===String(item.exerciseId));
    const source=item.exerciseSnapshot||current||{id:item.exerciseId,name:item.name,topic:item.topic||'',duration:item.plannedMinutes||8};
    return {...structuredClone(source),itemId:uid(),duration:Number(item.actualMinutes)||Number(item.plannedMinutes)||Number(source.duration)||8};
  });
  $('trainingName').value=`${record.planName||'Тренировка'} — по журналу`;
  $('trainingCategory').value=record.category||inferWorkoutCategory(record);
  renderPlan();switchTab('builder');toast('План подготовлен по записи из журнала');
}
function formatLoggedDate(value){
  const date=new Date(value);
  return Number.isNaN(date.getTime())?String(value||'Дата не указана'):date.toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'});
}
function renderWorkoutHistory(){
  const list=$('workoutHistoryList'),empty=$('emptyWorkoutHistory'),summary=$('workoutHistorySummary'),progress=$('exerciseProgressList');
  if(!list||!empty||!summary||!progress)return;
  list.innerHTML='';progress.innerHTML='';
  document.querySelectorAll('[data-history-category]').forEach(button=>button.classList.toggle('active',button.dataset.historyCategory===activeHistoryCategory));
  const filtered=workoutHistory.filter(record=>activeHistoryCategory==='all'||(record.category||inferWorkoutCategory(record))===activeHistoryCategory);
  const ordered=[...filtered].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const allItems=filtered.flatMap(entry=>entry.items||[]);
  const completed=allItems.filter(item=>item.completed!==false);
  const trackedMinutes=completed.reduce((sum,item)=>sum+(Number(item.actualMinutes)||0),0);
  const trackedReps=completed.reduce((sum,item)=>sum+(Number(item.repetitions)||0),0);
  summary.innerHTML='';
  [
    [filtered.length,'Тренировок'],
    [completed.length,'Выполненных упражнений'],
    [`${trackedMinutes} мин`,'Записанное время'],
    [trackedReps,'Повторений']
  ].forEach(([value,label])=>{
    const stat=document.createElement('div');stat.className='history-stat';
    const strong=document.createElement('strong');strong.textContent=String(value);
    const caption=document.createElement('span');caption.textContent=label;
    stat.append(strong,caption);summary.append(stat);
  });
  empty.classList.toggle('hidden',ordered.length>0);
  ordered.forEach(record=>{
    const card=document.createElement('article');card.className='saved-plan history-card';
    const head=document.createElement('div');head.className='history-card-head';
    const title=document.createElement('strong');title.textContent=record.planName||'Тренировка';
    const category=document.createElement('span');category.className='platform-chip';category.textContent=record.category||inferWorkoutCategory(record);
    const date=document.createElement('span');date.className='muted';date.textContent=formatLoggedDate(record.date);
    const headTitle=document.createElement('div');headTitle.className='history-title-group';headTitle.append(title,category);
    head.append(headTitle,date);
    const items=record.items||[];
    const done=items.filter(item=>item.completed!==false).length;
    const minutes=items.filter(item=>item.completed!==false).reduce((sum,item)=>sum+(Number(item.actualMinutes)||0),0);
    const reps=items.filter(item=>item.completed!==false).reduce((sum,item)=>sum+(Number(item.repetitions)||0),0);
    const meta=document.createElement('p');meta.className='muted history-meta';
    const facts=[`${done} из ${items.length} упражнений выполнено`];
    if(minutes)facts.push(`${minutes} мин`);if(reps)facts.push(`${reps} повторений`);
    if(record.location)facts.push(`Место: ${record.location}`);if(record.partners)facts.push(`С кем: ${record.partners}`);
    meta.textContent=facts.join(' · ');
    card.append(head,meta);
    if(record.note){const note=document.createElement('p');note.className='history-note';note.textContent=record.note;card.append(note);}
    const details=document.createElement('details');details.className='history-details';
    const summaryLine=document.createElement('summary');summaryLine.textContent='Результаты по упражнениям';details.append(summaryLine);
    items.forEach((item,index)=>{
      const line=document.createElement('div');line.className='history-exercise-line';
      const info=document.createElement('div');info.className='history-exercise-info';
      const exerciseName=document.createElement('strong');exerciseName.textContent=`${index+1}. ${item.name||'Упражнение'}`;
      const pieces=[item.completed===false?'Не выполнено':'Выполнено'];
      if(item.repetitions!==null&&item.repetitions!==undefined)pieces.push(`${item.repetitions} раз`);
      if(item.actualMinutes!==null&&item.actualMinutes!==undefined)pieces.push(`${item.actualMinutes} мин`);
      const values=document.createElement('span');values.className='muted';values.textContent=pieces.join(' · ');
      info.append(exerciseName,values);
      if(item.comment){const comment=document.createElement('p');comment.className='history-exercise-comment';comment.textContent=item.comment;info.append(comment);}
      const view=document.createElement('button');view.type='button';view.className='mini-btn';view.textContent='Карточка';
      view.onclick=()=>{const current=exercises.find(e=>String(e.id)===String(item.exerciseId));const snapshot=item.exerciseSnapshot?{...item.exerciseSnapshot,images:current?.images||[]}:current;if(snapshot)showDetail(snapshot,{readOnly:true});else toast('Карточка упражнения больше недоступна');};
      line.append(info,view);details.append(line);
    });
    card.append(details);
    const actions=document.createElement('div');actions.className='card-actions';
    const reuse=document.createElement('button');reuse.type='button';reuse.className='button ghost';reuse.textContent='Собрать план по этой записи';reuse.onclick=()=>createPlanFromHistory(record);
    const edit=document.createElement('button');edit.type='button';edit.className='button primary';edit.textContent='Редактировать';edit.onclick=()=>openWorkoutLogDialog({id:record.planId,name:record.planName,items:[]},record);
    const remove=document.createElement('button');remove.type='button';remove.className='button danger';remove.textContent='Удалить запись';
    remove.onclick=async()=>{if(confirm('Удалить эту запись из журнала?')){workoutHistory=workoutHistory.filter(x=>x.id!==record.id);await persist();}};
    actions.append(reuse,edit,remove);card.append(actions);list.append(card);
  });
  const aggregates=new Map();
  filtered.forEach(record=>{
    (record.items||[]).forEach(item=>{
      if(item.completed===false)return;
      const key=String(item.exerciseId??item.name);
      if(!aggregates.has(key))aggregates.set(key,{name:item.name||'Упражнение',sessions:0,repetitions:0,minutes:0,lastDate:null});
      const stat=aggregates.get(key);stat.sessions++;
      stat.repetitions+=Number(item.repetitions)||0;stat.minutes+=Number(item.actualMinutes)||0;
      if(!stat.lastDate||new Date(record.date)>new Date(stat.lastDate))stat.lastDate=record.date;
    });
  });
  const sortedStats=[...aggregates.values()].sort((a,b)=>b.sessions-a.sessions||new Date(b.lastDate)-new Date(a.lastDate));
  if(!sortedStats.length){const p=document.createElement('p');p.className='muted';p.textContent='Статистика появится после первых записанных тренировок.';progress.append(p);}
  sortedStats.forEach(stat=>{
    const row=document.createElement('div');row.className='progress-exercise';
    const name=document.createElement('strong');name.textContent=stat.name;
    const values=document.createElement('span');values.className='muted';
    const pieces=[`${stat.sessions} тренировок`];if(stat.repetitions)pieces.push(`${stat.repetitions} повторений`);if(stat.minutes)pieces.push(`${stat.minutes} мин`);pieces.push(`последний раз: ${new Date(stat.lastDate).toLocaleDateString('ru-RU')}`);
    values.textContent=pieces.join(' · ');row.append(name,values);progress.append(row);
  });
}


document.querySelectorAll('[data-history-category]').forEach(button=>button.addEventListener('click',()=>{activeHistoryCategory=button.dataset.historyCategory;renderWorkoutHistory();}));
document.querySelectorAll('[data-plan-category]').forEach(button=>button.addEventListener('click',()=>{activePlanCategory=button.dataset.planCategory;renderPlans();}));
$('newWorkoutLogBtn').addEventListener('click',()=>openWorkoutLogDialog({id:null,name:'Самостоятельная тренировка',items:[]}));
function resetForm(){ $('exerciseForm').reset();$('exerciseId').value='';$('exTopic').value=topics[0]||'';$('exDuration').value=8;pendingImages=[];existingImageUrls=[];$('imagePreview').innerHTML='';$('existingImages').innerHTML='';$('videoFields').innerHTML='';$('deleteExerciseBtn').classList.add('hidden');$('dialogTitle').textContent='Новое упражнение';}
function videoRow(v={title:'',url:'',note:''}){const row=document.createElement('div');row.className='video-row';['title','url','note'].forEach((k,i)=>{const input=document.createElement('input');input.placeholder=['Название видео','https://…','Комментарий'][i];input.value=v[k]||'';input.dataset.key=k;row.append(input);});const rm=document.createElement('button');rm.type='button';rm.className='mini-btn';rm.textContent='×';rm.onclick=()=>row.remove();row.append(rm);$('videoFields').append(row);}
$('addVideoBtn').onclick=()=>videoRow();
$('exImages').addEventListener('change',async ev=>{for(const file of ev.target.files){if(!file.type.startsWith('image/'))continue;const data=await resizeImage(file);pendingImages.push({name:file.name,data});}renderImagePreviews();ev.target.value='';});
function resizeImage(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const max=1400,scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',.82));};img.onerror=reject;img.src=reader.result;};reader.onerror=reject;reader.readAsDataURL(file);});}
function renderImagePreviews(){const box=$('imagePreview');box.innerHTML='';const allImages=[...existingImageUrls,...pendingImages];pendingImages.forEach((im,i)=>{const wrap=document.createElement('div');wrap.style.position='relative';const img=document.createElement('img');img.src=im.data;img.title='Нажмите, чтобы увеличить';bindImageZoom(img,allImages,existingImageUrls.length+i);const b=document.createElement('button');b.className='mini-btn';b.type='button';b.textContent='×';b.onclick=()=>{pendingImages.splice(i,1);renderImagePreviews();};wrap.append(img,b);box.append(wrap);});}
function editExercise(id){const e=exercises.find(x=>x.id===id);if(!e)return;resetForm();$('dialogTitle').textContent='Редактировать упражнение';$('exerciseId').value=e.id;$('exName').value=e.name;$('exDescription').value=e.description||'';$('exTopic').value=e.topic;$('exLevel').value=e.level;$('exDuration').value=e.duration;$('exFormat').value=e.format||'Индивидуально';$('exShots').value=(e.shots||[]).join(', ');$('exTags').value=(e.tags||[]).join(', ');$('exZones').value=(e.zones||[]).join(', ');$('exEquipment').value=e.equipment||'';$('exNotes').value=e.notes||'';existingImageUrls=structuredClone(e.images||[]);renderExistingImages();(e.videos||[]).forEach(videoRow);$('deleteExerciseBtn').classList.remove('hidden');$('exerciseDialog').showModal();}
function renderExistingImages(){const box=$('existingImages');box.innerHTML='';const allImages=[...existingImageUrls,...pendingImages];existingImageUrls.forEach((im,i)=>{const wrap=document.createElement('div');wrap.style.position='relative';const img=document.createElement('img');img.src=im.data;img.title='Нажмите, чтобы увеличить';bindImageZoom(img,allImages,i);const b=document.createElement('button');b.type='button';b.className='mini-btn';b.textContent='×';b.onclick=()=>{existingImageUrls.splice(i,1);renderExistingImages();};wrap.append(img,b);box.append(wrap);});}
$('addExerciseBtn').onclick=()=>{resetForm();$('exerciseDialog').showModal();};
$('closeDialog').onclick=()=>$('exerciseDialog').close();
async function deleteExerciseById(id){
  const exercise=exercises.find(e=>String(e.id)===String(id));if(!exercise)return;
  if(!confirm(`Удалить упражнение «${exercise.name}» из библиотеки? Сохранённые планы останутся без изменений.`))return;
  exercises=exercises.filter(e=>String(e.id)!==String(id));selectedExerciseIds.delete(String(id));
  await persist();if($('exerciseDialog').open)$('exerciseDialog').close();toast('Упражнение удалено');
}
$('deleteExerciseBtn').onclick=()=>deleteExerciseById($('exerciseId').value);
$('exerciseForm').addEventListener('submit',async ev=>{ev.preventDefault();const id=$('exerciseId').value;const videos=[...$('videoFields').children].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.key,i.value.trim()]))).filter(v=>v.url);const old=exercises.find(e=>String(e.id)===id);const images=[...existingImageUrls,...pendingImages];const e={id:old?old.id:Date.now(),name:$('exName').value.trim(),description:$('exDescription').value,topic:$('exTopic').value,level:$('exLevel').value,duration:Math.max(1,Number($('exDuration').value)||1),format:$('exFormat').value,shots:parseList($('exShots').value),tags:parseList($('exTags').value),zones:parseList($('exZones').value),equipment:$('exEquipment').value,notes:$('exNotes').value,images,videos,personalDifficulty:old?.personalDifficulty||'',trainingNotes:old?.trainingNotes||[]};if(old)exercises=exercises.map(x=>x.id===old.id?e:x);else exercises.unshift(e);await persist();$('exerciseDialog').close();toast(old?'Изменения сохранены':'Упражнение добавлено');});

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

function getVideoPlatformName(rawUrl){
  try{
    const host=new URL(rawUrl).hostname.toLowerCase().replace(/^(www|m|mobile)\./,'');
    if(host==='youtu.be'||host.endsWith('youtube.com')||host.endsWith('youtube-nocookie.com'))return 'YouTube';
    if(host==='vk.com'||host.endsWith('.vk.com')||host==='vkvideo.ru'||host.endsWith('.vkvideo.ru'))return 'VK';
    if(host==='rutube.ru'||host.endsWith('.rutube.ru'))return 'Rutube';
    if(host==='dzen.ru'||host.endsWith('.dzen.ru'))return 'Дзен';
    if(host==='t.me'||host.endsWith('.telegram.org'))return 'Telegram';
    if(host==='instagram.com'||host.endsWith('.instagram.com'))return 'Instagram';
    if(host==='tiktok.com'||host.endsWith('.tiktok.com'))return 'TikTok';
    if(host==='weixin.qq.com'||host.endsWith('.weixin.qq.com')||host==='wechat.com'||host.endsWith('.wechat.com'))return 'WeChat';
    if(host==='vimeo.com'||host.endsWith('.vimeo.com'))return 'Vimeo';
    if(host==='twitch.tv'||host.endsWith('.twitch.tv'))return 'Twitch';
    if(host==='bilibili.com'||host.endsWith('.bilibili.com'))return 'Bilibili';
    return host.replace(/^www\./,'')||'Ссылка';
  }catch{return 'Ссылка';}
}
// Safe, offline Markdown renderer for exercise descriptions.
// It supports headings, bold/italic, inline code, links, blockquotes and nested lists.
function appendInlineMarkdown(parent,text){
  const pattern=/(`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+)/g;
  const source=String(text??'');let cursor=0,match;
  while((match=pattern.exec(source))){
    if(match.index>cursor)parent.append(document.createTextNode(source.slice(cursor,match.index)));
    const token=match[0];let node=null;
    if(token.startsWith('**')||token.startsWith('__')){node=document.createElement('strong');node.textContent=token.slice(2,-2);}
    else if(token.startsWith('`')){node=document.createElement('code');node.textContent=token.slice(1,-1);}
    else if(token.startsWith('*')||token.startsWith('_')){node=document.createElement('em');node.textContent=token.slice(1,-1);}
    else{
      const link=token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if(link){try{const url=new URL(link[2]);if(url.protocol==='http:'||url.protocol==='https:'){node=document.createElement('a');node.textContent=link[1];node.href=url.href;node.target='_blank';node.rel='noopener noreferrer';}}catch{}}
      else if(/^https?:\/\//i.test(token)){
        const suffix=(token.match(/[.,;!?]+$/)||[''])[0];
        const cleanUrl=suffix?token.slice(0,-suffix.length):token;
        try{const url=new URL(cleanUrl);node=document.createElement('a');node.className='video-link';node.textContent=`(${getVideoPlatformName(cleanUrl)})`;node.href=url.href;node.target='_blank';node.rel='noopener noreferrer';if(suffix)node.append(document.createTextNode(suffix));}catch{}
      }
      if(!node)node=document.createTextNode(token);
    }
    parent.append(node);cursor=pattern.lastIndex;
  }
  if(cursor<source.length)parent.append(document.createTextNode(source.slice(cursor)));
}
function markdownListMarker(line){
  const match=String(line).match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  if(!match)return null;
  return {indent:match[1].replace(/\t/g,'    ').length,type:/^\d/.test(match[2])?'ol':'ul',text:match[3]};
}
function parseMarkdownList(lines,start,indent){
  const first=markdownListMarker(lines[start]);const list=document.createElement(first.type);let i=start,lastItem=null;
  while(i<lines.length){
    if(!lines[i].trim()){
      let next=i;while(next<lines.length&&!lines[next].trim())next++;
      const following=markdownListMarker(lines[next]);
      if(following&&following.indent>=indent){i=next;continue;}
      break;
    }
    const marker=markdownListMarker(lines[i]);
    if(!marker){
      const leading=(lines[i].match(/^\s*/)||[''])[0].replace(/\t/g,'    ').length;
      if(lastItem&&leading>indent){lastItem.append(document.createElement('br'));appendInlineMarkdown(lastItem,lines[i].trim());i++;continue;}
      break;
    }
    if(marker.indent<indent)break;
    if(marker.indent>indent){
      if(lastItem){const nested=parseMarkdownList(lines,i,marker.indent);lastItem.append(nested.node);i=nested.next;continue;}
      break;
    }
    if(marker.type!==first.type)break;
    lastItem=document.createElement('li');appendInlineMarkdown(lastItem,marker.text);list.append(lastItem);i++;
  }
  return {node:list,next:i};
}
function renderMarkdown(markdown){
  const root=document.createElement('div');root.className='markdown-content';
  const lines=String(markdown??'').replace(/\r\n?/g,'\n').split('\n');let i=0;
  while(i<lines.length){
    if(!lines[i].trim()){i++;continue;}
    const heading=lines[i].match(/^(#{1,3})\s+(.+)$/);
    if(heading){const h=document.createElement(`h${heading[1].length}`);appendInlineMarkdown(h,heading[2]);root.append(h);i++;continue;}
    const marker=markdownListMarker(lines[i]);
    if(marker){const parsed=parseMarkdownList(lines,i,marker.indent);root.append(parsed.node);i=Math.max(i+1,parsed.next);continue;}
    if(/^>\s?/.test(lines[i])){
      const quote=document.createElement('blockquote');
      while(i<lines.length&&/^>\s?/.test(lines[i])){const line=lines[i].replace(/^>\s?/,'');if(quote.childNodes.length)quote.append(document.createElement('br'));appendInlineMarkdown(quote,line);i++;}
      root.append(quote);continue;
    }
    const paragraph=document.createElement('p');
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,3})\s+/.test(lines[i])&&!markdownListMarker(lines[i])&&!/^>\s?/.test(lines[i])){
      if(paragraph.childNodes.length)paragraph.append(document.createElement('br'));
      appendInlineMarkdown(paragraph,lines[i]);i++;
    }
    if(paragraph.childNodes.length)root.append(paragraph);else i++;
  }
  return root;
}

// Tap any exercise image to open it in a full-screen viewer.
function bindImageZoom(img,images,index){
  img.classList.add('zoomable-image');img.title='Нажмите, чтобы увеличить';img.setAttribute('role','button');img.tabIndex=0;
  img.setAttribute('aria-label','Открыть изображение в увеличенном размере');
  const open=()=>openImageViewer(images,index);
  img.addEventListener('click',open);
  img.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();open();}});
}
function openImageViewer(images,index=0){
  lightboxImages=(images||[]).filter(im=>im&&typeof im.data==='string'&&im.data);
  if(!lightboxImages.length)return;
  lightboxIndex=Math.max(0,Math.min(Number(index)||0,lightboxImages.length-1));
  updateImageViewer();
  if(!$('imageViewer').open)$('imageViewer').showModal();
}
function updateImageViewer(){
  const image=lightboxImages[lightboxIndex];$('imageViewerImage').src=image.data;
  $('imageViewerImage').alt=image.name||`Изображение ${lightboxIndex+1}`;
  $('imageViewerCount').textContent=`${lightboxIndex+1} / ${lightboxImages.length}`;
  $('imageViewerCaption').textContent=image.name||'';
  $('imageViewerPrev').disabled=lightboxImages.length<2;
  $('imageViewerNext').disabled=lightboxImages.length<2;
}
function moveImageViewer(delta){if(!lightboxImages.length)return;lightboxIndex=(lightboxIndex+delta+lightboxImages.length)%lightboxImages.length;updateImageViewer();}
$('imageViewerPrev').onclick=()=>moveImageViewer(-1);
$('imageViewerNext').onclick=()=>moveImageViewer(1);
$('closeImageViewer').onclick=()=>$('imageViewer').close();
$('imageViewer').addEventListener('click',ev=>{if(ev.target===$('imageViewer'))$('imageViewer').close();});
$('imageViewer').addEventListener('keydown',ev=>{if(ev.key==='ArrowLeft'){ev.preventDefault();moveImageViewer(-1);}else if(ev.key==='ArrowRight'){ev.preventDefault();moveImageViewer(1);}});

function showDetail(idOrExercise,options={}){
  const e=(idOrExercise&&typeof idOrExercise==='object')?idOrExercise:exercises.find(x=>String(x.id)===String(idOrExercise));
  if(!e)return;
  selectedDetail=e;
  const readOnly=!!options.readOnly;
  $('detailTitle').textContent=e.name;
  $('detailMeta').textContent=`${e.topic||'Без темы'} · ${e.level||'—'} · ${e.duration||'—'} мин · ${e.format||''}`;
  const box=$('detailContent');box.innerHTML='';
  if(e.images?.[0]){const img=document.createElement('img');img.className='detail-hero';img.src=e.images[0].data;bindImageZoom(img,e.images,0);box.append(img);}
  if(e.images?.length>1){const gallery=document.createElement('div');gallery.className='gallery';e.images.slice(1).forEach((im,i)=>{const img=document.createElement('img');img.src=im.data;bindImageZoom(img,e.images,i+1);gallery.append(img);});box.append(gallery);}
  const section=(title,content)=>{if(!content)return;const s=document.createElement('div');s.className='detail-section';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('div');if(title==='Описание')p.append(renderMarkdown(content));else p.textContent=content;s.append(h,p);box.append(s);};
  section('Описание',e.description);section('Виды ударов',(e.shots||[]).join(', '));section('Дополнительные теги',(e.tags||[]).join(', '));section('Область применения (зона корта / часть тела)',(e.zones||[]).join(', '));section('Инвентарь',e.equipment);section('Постоянные заметки',e.notes);
  if(e.videos?.length){
    const s=document.createElement('div');s.className='detail-section';const h=document.createElement('h3');h.textContent='Видео и ссылки';s.append(h);
    e.videos.forEach(v=>{
      if(!v.url)return;
      const item=document.createElement('div');item.className='video-item';
      const info=document.createElement('div');info.className='video-info';
      const platform=getVideoPlatformName(v.url);const isWeChat=platform==='WeChat';
      const title=document.createElement('div');title.className='video-title';title.textContent=(v.title||'Видео')+(v.note?' — '+v.note:'');info.append(title);
      if(isWeChat){const badge=document.createElement('span');badge.className='platform-chip';badge.textContent='(WeChat)';info.append(badge);}
      else{const a=document.createElement('a');a.className='video-link';a.textContent=`(${platform})`;a.href=v.url;a.target='_blank';a.rel='noopener noreferrer';info.append(a);}
      const copy=document.createElement('button');copy.type='button';copy.className='button ghost small copy-link-btn';copy.textContent='Копировать ссылку';copy.onclick=()=>copyLink(v.url);
      item.append(info,copy);s.append(item);
    });
    box.append(s);
  }
  if(!readOnly){
    const pd=document.createElement('div');pd.className='detail-section';const h=document.createElement('h3');h.textContent='Моя оценка сложности';const sel=document.createElement('select');sel.innerHTML='<option value="">Не оценено</option><option>Легко</option><option>Средне</option><option>Трудно</option>';sel.value=e.personalDifficulty||'';sel.onchange=async()=>{e.personalDifficulty=sel.value;await persist();toast('Оценка сохранена');};pd.append(h,sel);box.append(pd);
    const notes=document.createElement('div');notes.className='detail-section';const nh=document.createElement('h3');nh.textContent='Заметка после тренировки';const ta=document.createElement('textarea');ta.rows=2;ta.placeholder='Что получилось, что стоит исправить…';const nb=document.createElement('button');nb.className='button ghost';nb.textContent='Сохранить заметку';nb.onclick=async()=>{e.trainingNotes=e.trainingNotes||[];e.trainingNotes.unshift({date:new Date().toISOString(),text:ta.value});await persist();ta.value='';toast('Заметка сохранена');};notes.append(nh,ta,nb);(e.trainingNotes||[]).slice(0,5).forEach(n=>{const p=document.createElement('p');p.className='muted';p.textContent=`${new Date(n.date).toLocaleDateString('ru-RU')}: ${n.text}`;notes.append(p);});box.append(notes);
  }
  $('detailAddBtn').classList.toggle('hidden',readOnly);$('detailEditBtn').classList.toggle('hidden',readOnly);$('detailDialog').showModal();
}
$('closeDetail').onclick=()=>$('detailDialog').close();$('detailAddBtn').onclick=()=>{if(selectedDetail)addToPlan(selectedDetail);$('detailDialog').close();};$('detailEditBtn').onclick=()=>{if(selectedDetail){const live=exercises.find(x=>String(x.id)===String(selectedDetail.id));if(live){$('detailDialog').close();editExercise(live.id);}}};
$('exerciseGrid').addEventListener('click',ev=>{});
// Canonical bilingual badminton shot labels. Unknown labels are retained verbatim.
const SHOT_TRANSLATIONS={
  'укороченный':'Укороченный (Drop shot)','укороченные':'Укороченный (Drop shot)','укороченный удар':'Укороченный (Drop shot)','укороченные удары':'Укороченный (Drop shot)','дроп':'Укороченный (Drop shot)','drop':'Укороченный (Drop shot)','drop shot':'Укороченный (Drop shot)',
  'смеш':'Смеш (Smash)','смеши':'Смеш (Smash)','смэш':'Смеш (Smash)','смэши':'Смеш (Smash)','smash':'Смеш (Smash)',
  'плоский':'Плоский удар (Drive)','плоские':'Плоский удар (Drive)','плоский удар':'Плоский удар (Drive)','плоские удары':'Плоский удар (Drive)','драйв':'Плоский удар (Drive)','drive':'Плоский удар (Drive)',
  'высокий':'Высокий удар (Clear)','высокие':'Высокий удар (Clear)','высокий удар':'Высокий удар (Clear)','клир':'Высокий удар (Clear)','clear':'Высокий удар (Clear)',
  'свеча':'Свеча (Lob)','свечи':'Свеча (Lob)','лоб':'Свеча (Lob)','lob':'Свеча (Lob)',
  'подставка у сетки':'Подставка у сетки (Net shot)','сеточный':'Подставка у сетки (Net shot)','net shot':'Подставка у сетки (Net shot)',
  'подъём от сетки':'Подъём от сетки (Lift)','подъем от сетки':'Подъём от сетки (Lift)','подъём':'Подъём от сетки (Lift)','подъем':'Подъём от сетки (Lift)','лифт':'Подъём от сетки (Lift)','lift':'Подъём от сетки (Lift)',
  'защитный удар':'Защитный удар (Defensive shot)','defensive shot':'Защитный удар (Defensive shot)',
  'блок':'Блок (Block)','блоки':'Блок (Block)','block':'Блок (Block)',
  'пуш':'Пуш (Push)','push':'Пуш (Push)','подкидка':'Подкидка (Flick)','флик':'Подкидка (Flick)','flick':'Подкидка (Flick)',
  'подача':'Подача (Serve)','serve':'Подача (Serve)',
  'короткая подача':'Короткая подача (Short serve)','short serve':'Короткая подача (Short serve)',
  'длинная подача':'Длинная подача (Long serve)','long serve':'Длинная подача (Long serve)',
  'срезка':'Срезка (Slice)','slice':'Срезка (Slice)',
  'обманный удар':'Обманный удар (Deceptive shot)','deceptive shot':'Обманный удар (Deceptive shot)'
};
function normalizeShotTypes(values){const result=[];for(const raw of values||[]){const value=String(raw).trim();if(!value)continue;const translated=SHOT_TRANSLATIONS[value.toLocaleLowerCase('ru')];const finalValue=translated||value;if(!result.some(x=>x.toLocaleLowerCase('ru')===finalValue.toLocaleLowerCase('ru')))result.push(finalValue);}return result;}
function splitImportedList(value){return String(value||'').split(/[,;；、]/).map(x=>x.trim()).filter(Boolean);}
function parseMarkdownExerciseCards(markdown){
  const source=String(markdown||'').replace(/\r\n?/g,'\n');
  const blocks=[...source.matchAll(/^##\s*Карточка\s+\d+\.\s*(.+?)\s*$/gmi)];
  return blocks.map((match,index)=>{
    const begin=match.index+match[0].length;
    const end=index+1<blocks.length?blocks[index+1].index:source.length;
    const body=source.slice(begin,end);
    const metadata=body.split(/^\*\*Описание\s*\(скопировать в поле «Описание»\):\*\*/mi)[0];
    const readField=(label)=>{
      const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      // Match a single metadata line only: an empty value stays empty and
      // cannot consume the heading of the next field.
      const re=new RegExp('^[\\t ]*\\*\\*'+escaped+'[\\t ]*:[\\t ]*\\*[\\t ]*\\*[\\t ]*(.*)$','mi');
      const value=metadata.match(re)?.[1]||'';
      return decodePossibleMarkdownArtifact(value);
    };
    let description='';
    const descMatch=body.match(/\*\*Описание\s*\(скопировать в поле «Описание»\):\*\*\s*\n+~~~(?:markdown)?\s*\n([\s\S]*?)\n~~~/i);
    if(descMatch)description=descMatch[1].trim();
    else{
      const alt=body.match(/\*\*Описание[^\n]*\*\*\s*\n+([\s\S]*?)(?=\n\*\*[^\n]+\*\*\s*:|$)/i);
      if(alt)description=alt[1].trim();
    }
    const title=match[1].trim();
    return {
      name:title,
      topic:readField('Основная тема'),
      tags:splitImportedList(readField('Дополнительные теги')),
      zones:splitImportedList(readField('Область применения')),
      // Russian and English shot labels remain separate tags, as in the file.
      shots:splitImportedList(readField('Виды ударов')),
      description
    };
  }).filter(card=>card.name);
}
async function importMarkdownCards(file){
  const parsed=parseMarkdownExerciseCards(await file.text());if(!parsed.length)throw new Error('В файле не найдены карточки формата «## Карточка N. Название»');
  const known=new Set(exercises.map(e=>String(e.name||'').trim().toLocaleLowerCase('ru')));const unique=[];let duplicates=0;
  for(const card of parsed){const key=card.name.toLocaleLowerCase('ru');if(known.has(key)){duplicates++;continue;}known.add(key);unique.push(card);}
  const preview=`Найдено карточек: ${parsed.length}\nНовых для импорта: ${unique.length}\nПропущено совпадений по названию: ${duplicates}\n\nИмпортировать новые карточки? Существующие карточки, планы и заметки не будут изменены.`;
  if(!unique.length){alert(preview+'\n\nНовых карточек нет.');return;}
  if(!confirm(preview))return;
  unique.forEach((card,index)=>{
    if(card.topic&&!topics.some(t=>t.toLocaleLowerCase('ru')===card.topic.toLocaleLowerCase('ru')))topics.push(card.topic);
    const imported={id:`import-${Date.now()}-${index}-${Math.random().toString(16).slice(2,7)}`,name:card.name,description:card.description,topic:card.topic||'',level:'Начальный',duration:8,format:'Индивидуально',shots:card.shots,tags:card.tags,zones:card.zones,equipment:'',notes:'',images:[],videos:[],personalDifficulty:'',trainingNotes:[]};
    cleanMarkdownFieldArtifacts([imported]);
    exercises.push(imported);
  });
  fillTopics();await persist();toast(`Импортировано карточек: ${unique.length}`);
}
$('markdownImportInput').onchange=async ev=>{const file=ev.target.files?.[0];if(!file)return;try{await importMarkdownCards(file);}catch(err){alert('Не удалось импортировать Markdown: '+err.message);}finally{ev.target.value='';}};
$('exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify({format:'badminton-training-backup',version:3,exportedAt:new Date().toISOString(),exercises,plans,topics,workoutHistory},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`badminton-training-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);toast('Резервная копия подготовлена');};
$('importInput').onchange=async ev=>{const file=ev.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(data.format!=='badminton-training-backup'||!Array.isArray(data.exercises)||!Array.isArray(data.plans))throw new Error('Неподходящий формат файла');if(!confirm(`Импортировать ${data.exercises.length} упражнений и ${data.plans.length} планов? Текущая библиотека будет заменена.`))return;exercises=data.exercises;plans=data.plans;topics=Array.isArray(data.topics)?data.topics.map(t=>String(t).trim()).filter(Boolean):collectLegacyTopics(exercises);if(Array.isArray(data.workoutHistory))workoutHistory=data.workoutHistory;fillTopics();await persist();toast('Данные импортированы');}catch(err){alert('Не удалось импортировать файл: '+err.message);}finally{ev.target.value='';}};
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
function localHasData(){return exercises.length>0 || plans.length>0 || workoutHistory.length>0 || JSON.stringify(topics)!==JSON.stringify(DEFAULT_TOPICS);}
function validateCloudRecord(record){
  if(!record || !Number.isFinite(Number(record.revision))) throw new Error('Google Drive вернул некорректную запись.');
  if(record.data!==null && record.data!==undefined && (!Array.isArray(record.data.exercises) || !Array.isArray(record.data.plans) || (record.data.topics!==undefined && !Array.isArray(record.data.topics)) || (record.data.workoutHistory!==undefined && !Array.isArray(record.data.workoutHistory)))) throw new Error('Формат данных в Google Drive не распознан. Локальная библиотека не изменена.');
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
    // Old cloud records don't have workoutHistory. Keep the local journal in that case.
    if(Array.isArray(record.data.workoutHistory))workoutHistory=structuredClone(record.data.workoutHistory);
    let repaired=cleanMarkdownFieldArtifacts(exercises);
    for(const plan of plans){
      if(Array.isArray(plan.items))repaired=cleanMarkdownFieldArtifacts(plan.items)||repaired;
    }
    for(const entry of workoutHistory){
      if(Array.isArray(entry.items))repaired=cleanMarkdownFieldArtifacts(entry.items.map(item=>item.exerciseSnapshot).filter(Boolean))||repaired;
    }
    await putRecord('exercises',exercises);
    await putRecord('plans',plans);
    await putRecord('topics',topics);
    await putRecord('workoutHistory',workoutHistory);
    syncMeta={revision:Number(record.revision),dirty:repaired || !Array.isArray(record.data.workoutHistory),lastSyncedAt:record.updatedAt||new Date().toISOString()};
    await putRecord('syncMeta',syncMeta);
    renderAll();
  }finally{applyingCloudData=false;}
  if(syncMeta.dirty)scheduleAutoSync();
}
async function uploadLocalRecord(baseRevision){
  const data={exercises,plans,topics,workoutHistory};
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
