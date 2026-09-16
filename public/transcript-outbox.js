// Durable, bounded, acknowledged final-text delivery. Audio is never stored.
export class TranscriptOutbox {
  constructor(sessionId, send, warn) { this.id=sessionId; this.send=send; this.warn=warn; this.items=[]; this.serial=Promise.resolve(); this.gap=false; }
  async open() {
    try {
      this.db=await new Promise((resolve,reject)=>{const r=indexedDB.open('subtitle-outbox-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('rooms');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const saved=await new Promise((resolve,reject)=>{const r=this.db.transaction('rooms').objectStore('rooms').get(this.id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      this.items=saved?.items||[];this.gap=!!saved?.gap;
      await this.prune();
    } catch { this.gap=true;this.warn('瀏覽器無法保存補送文字，請保持本頁開啟；逐字稿可能不完整。'); }
    this.timer=setInterval(()=>this.pump(),2000);
    return this;
  }
  enqueue(work){ const result=this.serial.then(work);this.serial=result.catch(()=>{this.gap=true;this.warn('補送文字保存失敗，逐字稿可能不完整。');});return this.serial; }
  async save(){if(!this.db)return;await new Promise((resolve,reject)=>{const tx=this.db.transaction('rooms','readwrite');tx.objectStore('rooms').put({items:this.items,gap:this.gap},this.id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async prune(){const old=this.items.length;this.items=this.items.filter(x=>Date.now()-x.ts<=300000).slice(-500);if(old!==this.items.length){this.gap=true;this.warn('有字幕超過補送期限或容量，逐字稿可能不完整。');}await this.save();}
  add(original,translations){return this.enqueue(async()=>{this.items.push({type:'host_utterance',clientMessageId:crypto.randomUUID(),ts:Date.now(),original,translations});await this.prune();this.send(this.items[0]);});}
  ack(id,rejected=false){return this.enqueue(async()=>{this.items=this.items.filter(x=>x.clientMessageId!==id);if(rejected){this.gap=true;this.warn('部分字幕未能保存，逐字稿可能不完整。');}await this.save();});}
  gapAck(){return this.enqueue(async()=>{this.gap=false;await this.save();});}
  pump(){return this.enqueue(async()=>{await this.prune();if(this.gap)this.send({type:'host_gap'});if(this.items[0])this.send(this.items[0]);});}
  async drain(timeout=10000){const end=Date.now()+timeout;do{await this.pump();if(!this.items.length&&!this.gap)return true;await new Promise(r=>setTimeout(r,200));}while(Date.now()<end);return false;}
}
