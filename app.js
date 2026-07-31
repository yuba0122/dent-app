const APP_VERSION='1.6.0', APP_BUILD='20260731-1625';
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.min.mjs';
const $=s=>document.querySelector(s), esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let cards=JSON.parse(localStorage.getItem('dentanki.cards')||'[]'), attempts=JSON.parse(localStorage.getItem('dentanki.attempts')||'[]'), deletedCardIds=JSON.parse(localStorage.getItem('dentanki.deletedCardIds')||'[]'), deletedAttemptIds=JSON.parse(localStorage.getItem('dentanki.deletedAttemptIds')||'[]'), selectedCardIds=new Set(), queue=[], current=null, selected='', startedAt=0, sb=null, user=null, ocrWorker=null, cancelRequested=false;
const save=()=>{localStorage.setItem('dentanki.cards',JSON.stringify(cards));localStorage.setItem('dentanki.attempts',JSON.stringify(attempts));localStorage.setItem('dentanki.deletedCardIds',JSON.stringify(deletedCardIds));localStorage.setItem('dentanki.deletedAttemptIds',JSON.stringify(deletedAttemptIds));refresh();syncPush()};
const now=()=>new Date().toISOString(), due=c=>!c.nextReview||new Date(c.nextReview)<=new Date();
function schedule(c,grade){const intervals=[0,1,3,7,14,30,60,120];c.level=Math.max(0,Math.min(intervals.length-1,(c.level||0)+(grade?1:-1)));const d=new Date();d.setDate(d.getDate()+intervals[c.level]);c.nextReview=d.toISOString();}
function tabs(){document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('#nav button,.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');refresh()})}
function cleanCanvas(c,mode){
  if(mode==='none'||mode==='annotations')return c;
  const ctx=c.getContext('2d',{willReadFrequently:true}),img=ctx.getImageData(0,0,c.width,c.height),d=img.data;
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b),sat=mx-mn,lum=.299*r+.587*g+.114*b;
    if(mode==='color'&&sat>28&&mx>70){d[i]=d[i+1]=d[i+2]=255;continue}
    if(mode==='strong'){
      if(sat>22&&mx>60){d[i]=d[i+1]=d[i+2]=255;continue}
      const v=lum>215?255:lum<135?0:Math.round((lum-135)/80*255);d[i]=d[i+1]=d[i+2]=v;
    }
  }
  ctx.putImageData(img,0,0);return c
}
function enhanceCanvas(source,level='balanced'){
  if(level==='none')return source;
  const out=document.createElement('canvas');out.width=source.width;out.height=source.height;
  const ctx=out.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0);
  const img=ctx.getImageData(0,0,out.width,out.height),d=img.data,gray=new Uint8ClampedArray(out.width*out.height);
  let sum=0,sum2=0;
  for(let i=0,j=0;i<d.length;i+=4,j++){const v=.299*d[i]+.587*d[i+1]+.114*d[i+2];gray[j]=v;sum+=v;sum2+=v*v}
  const n=gray.length,mean=sum/n,sd=Math.sqrt(Math.max(1,sum2/n-mean*mean));
  const contrast=level==='strong'?1.75:1.35, threshold=Math.max(125,Math.min(210,mean-(level==='strong'?.12:.02)*sd));
  for(let i=0,j=0;i<d.length;i+=4,j++){
    let v=128+(gray[j]-mean)*contrast;
    if(level==='strong')v=v>threshold?255:0; else {v=Math.max(0,Math.min(255,v));if(v>238)v=255;if(v<35)v=0}
    d[i]=d[i+1]=d[i+2]=v;
  }
  ctx.putImageData(img,0,0);return out
}
async function renderPageCanvas(page,scale=2,cleanupMode='annotations',enhance='balanced'){
  const vp=page.getViewport({scale}),c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);
  await page.render({canvasContext:c.getContext('2d',{alpha:false}),viewport:vp,background:'white',annotationMode:cleanupMode==='none'?pdfjsLib.AnnotationMode.ENABLE:pdfjsLib.AnnotationMode.DISABLE}).promise;
  const cleaned=cleanCanvas(c,cleanupMode);return enhanceCanvas(cleaned,enhance)
}
async function pageImage(page,cleanupMode){const c=await renderPageCanvas(page,.9,cleanupMode,'none');const url=c.toDataURL('image/jpeg',.82);c.width=c.height=1;return url}
function logOCR(message){const el=$('#ocrLog');el.textContent+=(el.textContent?'\n':'')+message;el.scrollTop=el.scrollHeight}
async function getOCRWorker(){
  if(ocrWorker)return ocrWorker;if(!window.Tesseract)throw new Error('OCRライブラリを読み込めませんでした。通信状態を確認してください。');
  logOCR('日本語OCRエンジンを準備しています…');
  ocrWorker=await Tesseract.createWorker('jpn+eng',1,{logger:m=>{if(m.status==='recognizing text')$('#status').textContent=`OCR処理中：${Math.round((m.progress||0)*100)}%`}});
  await ocrWorker.setParameters({preserve_interword_spaces:'1',user_defined_dpi:'300'});return ocrWorker
}
function textQuality(text){
  const t=(text||'').trim();if(!t)return -999;
  const useful=(t.match(/[一-龠々ぁ-んァ-ヶA-Za-z0-9]/g)||[]).length;
  const junk=(t.match(/[�□■◆◇※]{1}|[_|]{2,}|[^\s一-龠々ぁ-んァ-ヶA-Za-z0-9。、．，・：；？！「」『』（）()\[\]【】%＋+−\-＝=／/<>]/g)||[]).length;
  const prompts=(t.match(/正しい|誤って|どれか|選べ|組合せ|組み合わせ|該当する/g)||[]).length;
  const choices=(t.match(/(?:^|\n)\s*(?:[A-Ea-e]|[1-9]|[①-⑩]|[ア-オ])[.．、:：)）]?\s*\S/g)||[]).length;
  return useful-junk*4+prompts*35+choices*8+Math.min(80,(t.match(/\n/g)||[]).length*2)
}
function normalizeOCRText(text){
  return (text||'').normalize('NFKC').replace(/\r/g,'')
    .replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n')
    .replace(/[|｜][|｜]+/g,'').replace(/([①-⑩])\s*[.．、]/g,'$1 ')
    .replace(/([A-Ea-eア-オ0-9])\s*[・･]/g,'$1. ')
    .replace(/問\s+(\d+)/g,'問$1')
    .replace(/(?:^|\n)\s*[Il|]\s*[.．、]\s*/g,'\n1. ')
    .replace(/(?:^|\n)\s*[Oo]\s*[.．、]\s*/g,'\n0. ')
    .replace(/([①-⑩A-Ea-eア-オ1-9])\s*[)）]\s*/g,'$1. ')
    .trim()
}
function embeddedTextWithLines(tc){
  const items=(tc.items||[]).filter(i=>i.str&&i.str.trim()).map(i=>({str:i.str,x:i.transform?.[4]||0,y:i.transform?.[5]||0,h:Math.abs(i.height||i.transform?.[3]||10)}));
  items.sort((a,b)=>Math.abs(b.y-a.y)>Math.max(a.h,b.h)*.55?b.y-a.y:a.x-b.x);
  const lines=[];
  for(const it of items){let line=lines.find(l=>Math.abs(l.y-it.y)<=Math.max(l.h,it.h)*.55);if(!line){line={y:it.y,h:it.h,items:[]};lines.push(line)}line.items.push(it)}
  lines.sort((a,b)=>b.y-a.y);return normalizeOCRText(lines.map(l=>l.items.sort((a,b)=>a.x-b.x).map(i=>i.str).join(' ')).join('\n'))
}
function detectVerticalGutter(canvas){
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),w=canvas.width,h=canvas.height,data=ctx.getImageData(0,0,w,h).data;
  const from=Math.floor(w*.38),to=Math.floor(w*.62),stepY=Math.max(1,Math.floor(h/700));let best={x:0,ink:Infinity};
  for(let x=from;x<to;x+=Math.max(2,Math.floor(w/250))){let ink=0,total=0;for(let y=0;y<h;y+=stepY){const i=(y*w+x)*4,lum=(data[i]+data[i+1]+data[i+2])/3;if(lum<210)ink++;total++}const ratio=ink/total;if(ratio<best.ink)best={x,ink:ratio}}
  return best.ink<.018?best.x:null
}
function cropCanvas(src,x,y,w,h){const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(src,x,y,w,h,0,0,w,h);return c}
async function recognizePass(worker,canvas,psm){
  await worker.setParameters({
    tessedit_pageseg_mode:String(psm),preserve_interword_spaces:'1',user_defined_dpi:'300',
    tessedit_char_blacklist:'{}~`^',textord_tabfind_find_tables:'1'
  });
  const r=await worker.recognize(canvas);
  return {text:normalizeOCRText(r.data.text||''),confidence:Number(r.data.confidence||0)}
}
function candidateScore(candidate){
  if(!candidate)return -9999;
  const q=splitQuestions(candidate.text||'').length;
  const choiceLines=((candidate.text||'').split('\n').filter(x=>CHOICE_RE.test(x))).length;
  return textQuality(candidate.text)+(candidate.confidence||0)*.8+q*90+Math.min(80,choiceLines*5)
}
function mergeEmbeddedAndOCR(embedded,ocr){
  if(!embedded)return ocr;
  if(!ocr)return embedded;
  const eParts=splitQuestions(embedded),oParts=splitQuestions(ocr);
  if(oParts.length>eParts.length)return ocr;
  if(eParts.length>oParts.length)return embedded;
  return textQuality(ocr)>textQuality(embedded)+25?ocr:embedded
}
async function highAccuracyOCR(canvas,layout='auto'){
  const worker=await getOCRWorker(),results=[];
  results.push(await recognizePass(worker,canvas,3));
  if(layout!=='fast'){
    results.push(await recognizePass(worker,canvas,6));
    // 疎な文字・図表混在ページ向け
    results.push(await recognizePass(worker,canvas,11));
  }
  const gutter=layout!=='single'?detectVerticalGutter(canvas):null;
  if(gutter){
    logOCR('2段組みを検出：左右を分けて再認識');
    const overlap=Math.round(canvas.width*.025),left=cropCanvas(canvas,0,0,Math.min(canvas.width,gutter+overlap),canvas.height),right=cropCanvas(canvas,Math.max(0,gutter-overlap),0,canvas.width-Math.max(0,gutter-overlap),canvas.height);
    const lt=await recognizePass(worker,left,6),rt=await recognizePass(worker,right,6);
    results.push({text:lt.text+'\n'+rt.text,confidence:(lt.confidence+rt.confidence)/2+4});
    left.width=left.height=right.width=right.height=1
  }
  results.sort((a,b)=>candidateScore(b)-candidateScore(a));
  return results[0]||{text:'',confidence:0}
}
async function extractText(page,mode,scale,fileName,pageNo,cleanupMode){
  const tc=await page.getTextContent({includeMarkedContent:true}),embedded=embeddedTextWithLines(tc);
  const embeddedQuestions=splitQuestions(embedded).length;
  const embeddedChoices=embedded.split('\n').filter(x=>CHOICE_RE.test(x)).length;
  const needsOCR=mode==='always'||(mode==='auto'&&(
    embedded.replace(/\s/g,'').length<80||textQuality(embedded)<70||embeddedQuestions===0||embeddedChoices<2
  ));
  if(!needsOCR||mode==='never')return{text:embedded,method:'文字情報'};
  logOCR(`${fileName} ${pageNo}頁：ハイブリッド高精度OCR開始`);
  const canvas=await renderPageCanvas(page,scale,cleanupMode,$('#preprocessMode')?.value||'balanced');
  const result=await highAccuracyOCR(canvas,$('#layoutMode')?.value||'auto');
  const text=mergeEmbeddedAndOCR(embedded,result.text);
  const method=embedded&&text===embedded?'文字情報優先（OCR比較済み）':'ハイブリッド高精度OCR';
  logOCR(`${fileName} ${pageNo}頁：OCR完了（${result.text.length}文字、信頼度 ${Math.round(result.confidence)}、品質 ${Math.round(textQuality(text))}）`);canvas.width=canvas.height=1;
  return{text,method}
}
function inkBounds(canvas,pad=18){
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),w=canvas.width,h=canvas.height,d=ctx.getImageData(0,0,w,h).data;
  let minX=w,minY=h,maxX=-1,maxY=-1;const sx=Math.max(1,Math.floor(w/900)),sy=Math.max(1,Math.floor(h/1200));
  for(let y=0;y<h;y+=sy)for(let x=0;x<w;x+=sx){const i=(y*w+x)*4,lum=.299*d[i]+.587*d[i+1]+.114*d[i+2];if(lum<242){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}}
  if(maxX<0)return{x:0,y:0,w,h};
  return{x:Math.max(0,minX-pad),y:Math.max(0,minY-pad),w:Math.min(w,maxX+pad)-Math.max(0,minX-pad),h:Math.min(h,maxY+pad)-Math.max(0,minY-pad)}
}
function canvasDataURL(canvas){const url=canvas.toDataURL('image/jpeg',.88);canvas.width=canvas.height=1;return url}
async function questionImages(page,count,cleanupMode,layout='auto'){
  if(count<=0)return[];
  const full=await renderPageCanvas(page,1.15,cleanupMode,'none'),gutter=layout!=='single'?detectVerticalGutter(full):null,images=[];
  const make=(x,y,w,h)=>{const c=cropCanvas(full,Math.max(0,Math.round(x)),Math.max(0,Math.round(y)),Math.max(1,Math.round(w)),Math.max(1,Math.round(h)));const b=inkBounds(c,24);const trimmed=cropCanvas(c,b.x,b.y,b.w,b.h);c.width=c.height=1;return canvasDataURL(trimmed)};
  if(count===1){images.push(make(0,0,full.width,full.height));}
  else if(gutter){
    const leftN=Math.ceil(count/2),rightN=count-leftN,over=Math.round(full.width*.02);
    for(let i=0;i<leftN;i++){const y=full.height*i/leftN,h=full.height/leftN;images.push(make(0,y,gutter+over,h));}
    for(let i=0;i<rightN;i++){const y=full.height*i/rightN,h=full.height/rightN;images.push(make(gutter-over,y,full.width-gutter+over,h));}
  }else{
    for(let i=0;i<count;i++){const y=full.height*i/count,h=full.height/count;images.push(make(0,y,full.width,h));}
  }
  full.width=full.height=1;return images
}
const CHOICE_RE=/^\s*(?:([A-Ea-e])|([1-9])|([①②③④⑤⑥⑦⑧⑨⑩])|([ア-オ]))\s*[.．、:：)）]?\s*(.+?)\s*$/;
const QUESTION_HEAD_RE=/^\s*(?:(?:問|Q)\s*\d{1,4}|\d{2,3}[A-D]\d{2,3}|第\s*\d+\s*問)\s*[.．、:：]?\s*/i;
function parseChoices(text){
  const lines=normalizeOCRText(text).split('\n').map(x=>x.trim()).filter(Boolean),choices=[],body=[];let activeChoice=-1;
  for(const line of lines){
    const m=line.match(CHOICE_RE);
    if(m&&m[5]&&m[5].length>1){choices.push(m[5].trim());activeChoice=choices.length-1;continue}
    const continuation=activeChoice>=0&&!QUESTION_HEAD_RE.test(line)&&!/(正しい|誤って|どれか|選べ|該当する)[。．]?$/.test(line)&&line.length<90;
    if(continuation){choices[activeChoice]+=' '+line;continue}
    activeChoice=-1;body.push(line)
  }
  return{body:body.join('\n').replace(/\n{3,}/g,'\n\n').trim(),choices:choices.map(x=>x.replace(/\s{2,}/g,' ').trim())}
}
function isQuestionLike(block){
  const p=/正しい|誤っている|誤って|適切|不適切|どれか|選べ|選択せよ|組合せ|組み合わせ|該当する|最も/g.test(block);
  const c=(block.split('\n').filter(x=>CHOICE_RE.test(x)).length);
  return (p&&c>=2)||(QUESTION_HEAD_RE.test(block)&&c>=2)
}
function splitQuestions(raw){
  const lines=normalizeOCRText(raw).split('\n').filter((x,i,a)=>x.trim()||a[i-1]?.trim());let blocks=[],cur=[];
  const flush=()=>{const b=cur.join('\n').trim();if(b)blocks.push(b);cur=[]};
  for(const line of lines){
    if(QUESTION_HEAD_RE.test(line)&&cur.length)flush();
    cur.push(line);
  }flush();
  if(blocks.length===1){
    const rebuilt=[];cur=[];
    for(const line of lines){
      if(cur.length&&QUESTION_HEAD_RE.test(line)){const b=cur.join('\n').trim();if(b)rebuilt.push(b);cur=[]}
      cur.push(line)
    }const b=cur.join('\n').trim();if(b)rebuilt.push(b);if(rebuilt.length>1)blocks=rebuilt
  }
  const candidates=blocks.filter(b=>b.length>20&&isQuestionLike(b));
  if(candidates.length)return candidates;
  // 問題番号がOCRで失われた場合、設問文＋複数選択肢をひとまとまりにする
  const fallback=[];cur=[];let choiceCount=0;
  for(const line of lines){
    if(cur.length&&QUESTION_HEAD_RE.test(line)&&choiceCount>=2){const b=cur.join('\n').trim();if(b)fallback.push(b);cur=[];choiceCount=0}
    cur.push(line);if(CHOICE_RE.test(line))choiceCount++;
    if(choiceCount>=2&&/(どれか|選べ|該当する|正しい|誤って)/.test(cur.join(' '))&&cur.length>3){const b=cur.join('\n').trim();fallback.push(b);cur=[];choiceCount=0}
  }
  return fallback.filter(isQuestionLike)
}
$('#cancelExtract').onclick=()=>{cancelRequested=true;$('#status').textContent='中止処理中…'};
$('#extractBtn').onclick=async()=>{const fs=[...$('#pdfInput').files];if(!fs.length)return alert('PDFを選択してください');cancelRequested=false;$('#cancelExtract').hidden=false;$('#extractBtn').disabled=true;$('#ocrLog').textContent='';let finishedPages=0,totalPages=0,added=0;try{const loaded=[];for(const f of fs){const pdf=await pdfjsLib.getDocument({data:await f.arrayBuffer()}).promise;loaded.push({f,pdf});totalPages+=pdf.numPages}for(const {f,pdf} of loaded){for(let p=1;p<=pdf.numPages;p++){if(cancelRequested)throw new Error('USER_CANCELLED');$('#status').textContent=`解析中：${f.name} ${p}/${pdf.numPages}頁`;const page=await pdf.getPage(p);const cleanupMode=$('#cleanupMode').value;const annotations=cleanupMode==='none'?[]:await page.getAnnotations({intent:'display'});if(annotations.length)logOCR(`${f.name} ${p}頁：PDF注釈 ${annotations.length}件を除外`);const {text,method}=await extractText(page,$('#ocrMode').value,Number($('#ocrScale').value),f.name,p,cleanupMode);const parts=splitQuestions(text);if(parts.length){const images=await questionImages(page,parts.length,cleanupMode,$('#layoutMode')?.value||'auto');for(let pi=0;pi<parts.length;pi++){const q=parseChoices(parts[pi]);if(!q.body||q.choices.length<2)continue;cards.push({id:crypto.randomUUID(),text:q.body,choices:q.choices,answer:'',explanation:'',subject:$('#importSubject').value||'未分類',tags:$('#importTags').value.split(',').map(x=>x.trim()).filter(Boolean),favorite:false,source:f.name,page:p,image:images[pi]||'',extractionMethod:method,correct:0,wrong:0,level:0,nextReview:now(),createdAt:now(),updatedAt:now()});added++}}finishedPages++;$('#progress').value=finishedPages/totalPages*100;await new Promise(r=>setTimeout(r,0))}}save();$('#status').textContent=`抽出完了：${added}件。問題一覧で内容と正答を確認してください。`}catch(e){if(e.message==='USER_CANCELLED'){$('#status').textContent=`処理を中止しました。抽出済み${added}件は保存しました。`;save()}else{console.error(e);$('#status').textContent='エラー：'+e.message;alert('PDF解析中にエラーが発生しました：'+e.message)}}finally{$('#cancelExtract').hidden=true;$('#extractBtn').disabled=false}};
function filteredCards(){const q=$('#search').value.toLowerCase(),sub=$('#subjectFilter').value,fil=$('#cardFilter').value;return cards.filter(c=>(!q||(c.text+' '+(c.tags||[]).join(' ')).toLowerCase().includes(q))&&(!sub||c.subject===sub)&&(fil==='all'||fil==='wrong'&&c.wrong>0||fil==='favorite'&&c.favorite||fil==='due'&&due(c)))}
function updateBulkUI(list=filteredCards()){for(const id of [...selectedCardIds])if(!cards.some(c=>c.id===id))selectedCardIds.delete(id);const visibleIds=list.map(c=>c.id),checked=visibleIds.length>0&&visibleIds.every(id=>selectedCardIds.has(id));$('#selectAllCards').checked=checked;$('#selectAllCards').indeterminate=!checked&&visibleIds.some(id=>selectedCardIds.has(id));$('#selectedCount').textContent=`${selectedCardIds.size}件選択`;$('#bulkDelete').disabled=selectedCardIds.size===0}
function renderCards(){const list=filteredCards();$('#cardList').innerHTML=list.map(c=>`<article class="question selectable"><label class="cardcheck"><input type="checkbox" data-card-select="${c.id}" ${selectedCardIds.has(c.id)?'checked':''}> 選択</label><div class="meta">${esc(c.subject)}・${esc(c.source||'手動')} ${c.page?'/ '+c.page+'頁':''}　正${c.correct} 誤${c.wrong}</div><h3>${esc(c.text)}</h3>${(c.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}<div class="actions"><button onclick="editCard('${c.id}')">編集</button><button onclick="toggleFav('${c.id}')">${c.favorite?'★':'☆'}</button><button onclick="deleteCard('${c.id}')">削除</button></div></article>`).join('')||'<div class="card">該当する問題はありません。</div>';document.querySelectorAll('[data-card-select]').forEach(x=>x.onchange=()=>{x.checked?selectedCardIds.add(x.dataset.cardSelect):selectedCardIds.delete(x.dataset.cardSelect);updateBulkUI(list)});updateBulkUI(list)}
window.editCard=id=>{const c=cards.find(x=>x.id===id)||{id:'',text:'',choices:[],answer:'',explanation:'',subject:'',tags:[],favorite:false};$('#editId').value=c.id;$('#editText').value=c.text;$('#editChoices').value=(c.choices||[]).join('\n');$('#editAnswer').value=c.answer;$('#editExplanation').value=c.explanation;$('#editSubject').value=c.subject;$('#editTags').value=(c.tags||[]).join(',');$('#editFavorite').checked=c.favorite;$('#editDialog').showModal()};
window.toggleFav=id=>{const c=cards.find(x=>x.id===id);c.favorite=!c.favorite;c.updatedAt=now();save()};function deleteCards(ids){const set=new Set(ids),related=attempts.filter(a=>set.has(a.cardId)).map(a=>a.id);deletedCardIds=[...new Set([...deletedCardIds,...set])];deletedAttemptIds=[...new Set([...deletedAttemptIds,...related])];cards=cards.filter(x=>!set.has(x.id));attempts=attempts.filter(a=>!set.has(a.cardId));for(const id of set)selectedCardIds.delete(id);save()}window.deleteCard=id=>{if(confirm('この問題と関連する回答履歴を削除しますか？'))deleteCards([id])};$('#selectAllCards').onchange=e=>{const list=filteredCards();if(e.target.checked)list.forEach(c=>selectedCardIds.add(c.id));else list.forEach(c=>selectedCardIds.delete(c.id));renderCards()};$('#bulkDelete').onclick=()=>{const n=selectedCardIds.size;if(!n)return;if(confirm(`選択した${n}件の問題と関連する回答履歴を削除しますか？`))deleteCards([...selectedCardIds])};$('#newCard').onclick=()=>editCard('');$('#cancelEdit').onclick=()=>$('#editDialog').close();$('#editForm').onsubmit=e=>{e.preventDefault();let c=cards.find(x=>x.id===$('#editId').value);if(!c){c={id:crypto.randomUUID(),correct:0,wrong:0,level:0,nextReview:now(),createdAt:now(),image:'',source:'手動'};cards.push(c)}Object.assign(c,{text:$('#editText').value,choices:$('#editChoices').value.split('\n').filter(Boolean),answer:$('#editAnswer').value.trim(),explanation:$('#editExplanation').value,subject:$('#editSubject').value||'未分類',tags:$('#editTags').value.split(',').map(x=>x.trim()).filter(Boolean),favorite:$('#editFavorite').checked,updatedAt:now()});$('#editDialog').close();save()};
$('#search').oninput=renderCards;$('#subjectFilter').onchange=renderCards;$('#cardFilter').onchange=renderCards;
function begin(mode=$('#studyMode').value){const sub=$('#studySubject').value;queue=cards.filter(c=>(!sub||c.subject===sub)&&(mode==='all'||mode==='due'&&due(c)||mode==='wrong'&&c.wrong>0||mode==='favorite'&&c.favorite||mode==='exam')).sort(()=>Math.random()-.5);if(mode==='exam')queue=queue.slice(0,100);next()}
$('#startStudy').onclick=()=>begin();$('#studyDue').onclick=()=>{document.querySelector('[data-tab="study"]').click();$('#studyMode').value='due';begin('due')};
function next(){selected='';current=queue.shift();startedAt=Date.now();if(!current){$('#quizCard').innerHTML='<h2>学習終了</h2><p>お疲れさまでした。</p>';return}$('#quizCard').innerHTML=`<div class="meta">${esc(current.subject)}　残り${queue.length}</div><h2>${esc(current.text)}</h2>${current.image?`<img class="quiz-image" src="${current.image}">`:''}${(current.choices||[]).map((x,i)=>`<button class="choice" data-a="${i+1}">${i+1}. ${esc(x)}</button>`).join('')||'<input id="free" placeholder="回答を入力">'}<div class="quiz-actions"><button id="judge" class="primary">回答する</button><button id="skip">回答せず次へ</button></div><div id="result"></div>`;document.querySelectorAll('.choice').forEach(b=>b.onclick=()=>{document.querySelectorAll('.choice').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');selected=b.dataset.a});$('#judge').onclick=judge;$('#skip').onclick=()=>{if(confirm('この問題を未回答のまま次へ進みますか？'))next()}}
function judge(){const a=selected||($('#free')?.value||'').trim();if(!a)return alert('回答してください');const ok=String(a).toLowerCase()===String(current.answer).trim().toLowerCase()&&current.answer!=='';ok?current.correct++:current.wrong++;schedule(current,ok);current.updatedAt=now();attempts.push({id:crypto.randomUUID(),cardId:current.id,correct:ok,answeredAt:now(),seconds:Math.max(1,Math.round((Date.now()-startedAt)/1000)),subject:current.subject});save();$('#judge').disabled=true;$('#result').innerHTML=`<p class="${ok?'good':'bad'}">${ok?'正解':'不正解'}　正答：${esc(current.answer||'未登録')}</p><p>${esc(current.explanation||'解説未登録')}</p><button id="next">次へ</button>`;$('#next').onclick=next}
function refresh(){const subjects=[...new Set(cards.map(c=>c.subject))].sort();for(const id of ['subjectFilter','studySubject']){const el=$(id.startsWith('#')?id:'#'+id);const v=el.value;el.innerHTML=`<option value="">全科目</option>`+subjects.map(s=>`<option>${esc(s)}</option>`).join('');el.value=v}$('#totalCount').textContent=cards.length;$('#wrongCount').textContent=cards.filter(c=>c.wrong>0).length;$('#dueCount').textContent=cards.filter(due).length;const today=new Date().toISOString().slice(0,10),ta=attempts.filter(a=>a.answeredAt.startsWith(today));$('#todayCount').textContent=ta.length;$('#answersTotal').textContent=attempts.length;$('#accuracy').textContent=(attempts.length?Math.round(attempts.filter(a=>a.correct).length/attempts.length*100):0)+'%';$('#studyTime').textContent=Math.round(attempts.reduce((s,a)=>s+(a.seconds||0),0)/60)+'分';const days=new Set(attempts.map(a=>a.answeredAt.slice(0,10)));let st=0,d=new Date();while(days.has(d.toISOString().slice(0,10))){st++;d.setDate(d.getDate()-1)}$('#streak').textContent=st+'日';$('#subjectSummary').innerHTML=subjects.map(s=>`<p><b>${esc(s)}</b>　${cards.filter(c=>c.subject===s).length}問</p>`).join('')||'未登録';$('#weakList').innerHTML=[...cards].filter(c=>c.wrong).sort((a,b)=>b.wrong-a.wrong).slice(0,10).map(c=>`<p><b>誤${c.wrong}</b> ${esc(c.text.slice(0,70))}</p>`).join('')||'誤答なし';renderCards();drawChart()}
function drawChart(){const c=$('#chart'),x=c.getContext('2d'),w=c.width=c.clientWidth*devicePixelRatio,h=c.height=180*devicePixelRatio;x.clearRect(0,0,w,h);const arr=[];for(let i=13;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const k=d.toISOString().slice(0,10);arr.push(attempts.filter(a=>a.answeredAt.startsWith(k)).length)}const m=Math.max(1,...arr),bw=w/14;x.fillStyle='#0f766e';arr.forEach((v,i)=>x.fillRect(i*bw+4,h-(v/m)*(h-20),bw-8,(v/m)*(h-20)))}
$('#exportBtn').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({cards,attempts})],{type:'application/json'}));a.download='dentanki-backup.json';a.click()};$('#importBackup').onchange=async e=>{const d=JSON.parse(await e.target.files[0].text());cards=d.cards||[];attempts=d.attempts||[];save()};$('#clearBtn').onclick=()=>{if(confirm('全データを削除しますか？')){cards=[];attempts=[];save()}};
function initCloud(){const u=localStorage.getItem('dentanki.supabaseUrl'),k=localStorage.getItem('dentanki.supabaseKey');if(u&&k){sb=supabase.createClient(u,k);sb.auth.getUser().then(r=>{user=r.data.user;syncPull()})}}$('#saveCloud').onclick=()=>{localStorage.setItem('dentanki.supabaseUrl',$('#supabaseUrl').value);localStorage.setItem('dentanki.supabaseKey',$('#supabaseKey').value);location.reload()};$('#login').onclick=async()=>{if(!sb)return alert('接続設定を保存してください');const {error}=await sb.auth.signInWithOtp({email:$('#email').value,options:{emailRedirectTo:location.href}});alert(error?error.message:'ログインリンクを送信しました')};$('#logout').onclick=async()=>{await sb?.auth.signOut();user=null;$('#syncBadge').textContent='ローカル'};
async function syncPull(){if(!sb)return;const {data:{user:u}}=await sb.auth.getUser();if(!u)return;user=u;$('#syncBadge').textContent='同期中';const [{data:c},{data:a}]=await Promise.all([sb.from('cards').select('*'),sb.from('attempts').select('*')]);if(c){const blocked=new Set(deletedCardIds),map=new Map(cards.map(x=>[x.id,x]));c.forEach(r=>{if(!blocked.has(r.id))map.set(r.id,r.data)});cards=[...map.values()]}if(a){const blocked=new Set(deletedAttemptIds),map=new Map(attempts.map(x=>[x.id,x]));a.forEach(r=>{if(!blocked.has(r.id)&&!deletedCardIds.includes(r.data?.cardId))map.set(r.id,r.data)});attempts=[...map.values()]}localStorage.setItem('dentanki.cards',JSON.stringify(cards));localStorage.setItem('dentanki.attempts',JSON.stringify(attempts));$('#syncBadge').textContent='同期済み';refresh()}
let syncTimer;function syncPush(){clearTimeout(syncTimer);syncTimer=setTimeout(async()=>{if(!sb||!user)return;$('#syncBadge').textContent='同期中';try{if(deletedAttemptIds.length)await sb.from('attempts').delete().in('id',deletedAttemptIds);if(deletedCardIds.length)await sb.from('cards').delete().in('id',deletedCardIds);await Promise.all([cards.length?sb.from('cards').upsert(cards.map(x=>({id:x.id,user_id:user.id,data:x,updated_at:x.updatedAt||now()}))):Promise.resolve(),attempts.length?sb.from('attempts').upsert(attempts.map(x=>({id:x.id,user_id:user.id,data:x,updated_at:x.answeredAt||now()}))):Promise.resolve()]);deletedCardIds=[];deletedAttemptIds=[];localStorage.setItem('dentanki.deletedCardIds','[]');localStorage.setItem('dentanki.deletedAttemptIds','[]');$('#syncBadge').textContent='同期済み'}catch(e){console.error(e);$('#syncBadge').textContent='同期エラー'}},800)}
$('#saveAI').onclick=()=>{localStorage.setItem('dentanki.aiEndpoint',$('#aiEndpoint').value);alert('保存しました')};
async function clearOldAppCaches(){
  if(!('caches' in window))return;
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('dentanki-')&&!k.includes(`${APP_VERSION}-${APP_BUILD}`)).map(k=>caches.delete(k)));
}
function showUpdate(version='最新版'){
  const banner=$('#updateBanner');if(!banner)return;
  $('#updateVersion').textContent=`現在 ${APP_VERSION} ／ 新版 ${version}`;
  banner.hidden=false;
}
async function hardReloadToLatest(){
  $('#applyUpdate').disabled=true;$('#applyUpdate').textContent='更新中…';
  try{
    const reg=await navigator.serviceWorker?.getRegistration();
    if(reg?.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});
    await clearOldAppCaches();
    const url=new URL(location.href);url.searchParams.set('_update',Date.now());
    location.replace(url.toString());
  }catch(e){console.error(e);location.reload();}
}
async function checkForAppUpdate(){
  try{
    const res=await fetch(`./version.json?_=${Date.now()}`,{cache:'no-store',headers:{'cache-control':'no-cache'}});
    if(!res.ok)return;
    const remote=await res.json();
    if(remote.build&&remote.build!==APP_BUILD)showUpdate(remote.version||remote.build);
  }catch(e){console.debug('更新確認をスキップ',e);}
}
async function setupAutoUpdate(){
  $('#applyUpdate').onclick=hardReloadToLatest;
  $('#dismissUpdate').onclick=()=>{$('#updateBanner').hidden=true};
  if(!('serviceWorker' in navigator)){checkForAppUpdate();return;}
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)return;refreshing=true;location.reload()});
  navigator.serviceWorker.addEventListener('message',e=>{
    if(e.data?.type==='SW_ACTIVATED'&&e.data.build!==APP_BUILD)showUpdate(e.data.version||e.data.build);
  });
  const reg=await navigator.serviceWorker.register(`./sw.js?v=${APP_BUILD}`,{updateViaCache:'none'});
  if(reg.waiting)showUpdate('ダウンロード済み');
  reg.addEventListener('updatefound',()=>{
    const worker=reg.installing;if(!worker)return;
    worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdate('ダウンロード済み')});
  });
  await reg.update().catch(()=>{});
  await checkForAppUpdate();
  setInterval(()=>{reg.update().catch(()=>{});checkForAppUpdate()},15*60*1000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){reg.update().catch(()=>{});checkForAppUpdate()}});
}
tabs();$('#supabaseUrl').value=localStorage.getItem('dentanki.supabaseUrl')||'';$('#supabaseKey').value=localStorage.getItem('dentanki.supabaseKey')||'';$('#aiEndpoint').value=localStorage.getItem('dentanki.aiEndpoint')||'';initCloud();refresh();setupAutoUpdate();
