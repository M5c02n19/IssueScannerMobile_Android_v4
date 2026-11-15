(() => {
  "use strict";
  // ใช้ key เดิม "scans" เพื่อรักษาข้อมูลจากโปรเจกต์ต้นฉบับ
  const STORAGE_KEY = "scans";
  const SOUND_KEY = "issue_scanner_sound";
  const $ = id => document.getElementById(id);
  let scans = readSavedScans();
  let soundEnabled = localStorage.getItem(SOUND_KEY) !== "off";
  let audioCtx = null;

  let cameraStream = null;
  let detector = null;
  let cameraRunning = false;
  let lastCameraRaw = "";
  let lastCameraTime = 0;
  let detectTimer = null;
  let modalOpen = false;
  let afterModalCallback = null;

  // --- ระบบเสียง: ใช้ไฟล์เสียง sounds/*.wav เป็นหลัก และมี Web Audio API สำรอง ---
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playSynthTone(freq, durationMs, type = "sine", volume = 0.16, delaySec = 0) {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime + delaySec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationMs / 1000);
    } catch (e) { /* ignore */ }
  }

  function playAudioElement(elementId, fallbackFn) {
    if (!soundEnabled) return;
    const el = $(elementId);
    if (el) {
      try {
        el.currentTime = 0;
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => { if (fallbackFn) fallbackFn(); });
        }
        return;
      } catch (e) { /* fallback below */ }
    }
    if (fallbackFn) fallbackFn();
  }

  function playBeepClick() {
    playAudioElement("sndClick", () => playSynthTone(700, 45, "sine", 0.08, 0));
  }

  function playBeepSuccess() {
    playAudioElement("sndSuccess", () => {
      playSynthTone(880, 95, "sine", 0.18, 0);
      playSynthTone(1320, 150, "sine", 0.2, 0.11);
    });
    if (navigator.vibrate) navigator.vibrate(80);
  }

  function playBeepError() {
    playAudioElement("sndError", () => {
      playSynthTone(300, 120, "sawtooth", 0.15, 0);
      playSynthTone(220, 200, "sawtooth", 0.15, 0.15);
    });
    if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
  }

  function updateSoundButton() {
    const btn = $("toggleSound");
    if (!btn) return;
    btn.textContent = soundEnabled ? "🔊 เสียง: เปิด" : "🔇 เสียง: ปิด";
    btn.classList.toggle("muted", !soundEnabled);
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
    updateSoundButton();
    if (soundEnabled) playBeepSuccess();
  }

  // --- หน้าต่างแจ้งผลการสแกน (ผ่าน / ไม่ผ่าน) พร้อมปุ่ม OK ---
  function showScanModal(isSuccess, title, lines, onClose = null) {
    modalOpen = true;
    afterModalCallback = onClose;
    if (detectTimer) {
      clearTimeout(detectTimer);
      detectTimer = null;
    }

    const modal = $("scanResultModal");
    const card = $("modalCard");
    const icon = $("modalIcon");
    const titleEl = $("modalTitle");
    const msgEl = $("modalMessage");

    card.className = "modal-card " + (isSuccess ? "is-success" : "is-error");
    icon.textContent = isSuccess ? "✅" : "❌";
    titleEl.textContent = title;

    msgEl.replaceChildren();
    lines.forEach(line => {
      const p = document.createElement("p");
      p.textContent = line;
      msgEl.append(p);
    });

    modal.hidden = false;
    setTimeout(() => {
      const okBtn = $("modalOkBtn");
      if (okBtn) okBtn.focus();
    }, 30);
  }

  function closeScanModal() {
    if (!modalOpen) return;
    playBeepClick();
    modalOpen = false;
    $("scanResultModal").hidden = true;

    const cb = afterModalCallback;
    afterModalCallback = null;
    if (typeof cb === "function") {
      cb();
    } else if (!cameraRunning) {
      $("scanInput").focus();
    }

    // หากเปิดโหมดสแกนอัตโนมัติต่อเนื่องไว้ ให้กลับมาทำงานต่อหลังกด OK
    if (cameraRunning && $("autoScanCheck").checked && !detectTimer) {
      lastCameraTime = Date.now();
      detectTimer = setTimeout(detectNextFrame, 400);
    }
  }

  // --- จัดการข้อมูล & แสดงผล ---
  function readSavedScans() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(value)) return [];
      return value.filter(x => x && typeof x.raw === "string" &&
        typeof x.part === "string" && Number.isFinite(Number(x.qty)))
        .map(x => ({raw:x.raw, part:x.part, qty:Number(x.qty), time:x.time || ""}));
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scans)); }
    catch (e) { notify("บันทึกไม่สำเร็จ: พื้นที่จัดเก็บอาจเต็ม", "error"); }
  }
  function notify(message, type="") {
    const el=$("notice"); el.textContent=message; el.className="notice "+type;
  }
  function safeCell(value) {
    const td=document.createElement("td"); td.textContent=String(value ?? ""); return td;
  }
  function makeEmptyRow(body, colspan, text) {
    const tr=document.createElement("tr"), td=safeCell(text);
    td.colSpan=colspan; td.className="empty"; tr.append(td); body.append(tr);
  }
  function formula(values) {
    const counts=new Map();
    values.forEach(v=>counts.set(v,(counts.get(v)||0)+1));
    return [...counts].map(([v,n])=>n>1?`${v}*${n}`:String(v)).join("+");
  }
  function render() {
    $("scanCount").textContent=scans.length;
    $("totalQty").textContent=scans.reduce((n,s)=>n+Number(s.qty),0);
    const grouped=new Map();
    scans.forEach(s=>{
      if(!grouped.has(s.part)) grouped.set(s.part,{total:0,qtys:[]});
      const g=grouped.get(s.part); g.total+=Number(s.qty); g.qtys.push(Number(s.qty));
    });
    $("partCount").textContent=grouped.size;
    const body=$("scanBody"); body.replaceChildren();
    if(!scans.length) makeEmptyRow(body,5,"ยังไม่มีข้อมูล");
    scans.forEach((s,i)=>{
      const tr=document.createElement("tr");
      tr.append(safeCell(i+1),safeCell(s.part),safeCell(s.qty),safeCell(s.time));
      const action=safeCell("");
      const btn=document.createElement("button"); btn.type="button"; btn.className="delete";
      btn.textContent="ลบ"; btn.setAttribute("aria-label",`ลบรายการที่ ${i+1}`);
      btn.addEventListener("click",()=>{
        playBeepClick();
        if(!confirm(`ยืนยันลบรายการ ${s.part} จำนวน ${s.qty} ?`)) return;
        scans.splice(i,1); save(); render();
        playBeepClick();
        notify("ลบรายการแล้ว","success");
      });
      action.append(btn); tr.append(action); body.append(tr);
    });
    const summary=$("summaryBody"); summary.replaceChildren();
    if(!grouped.size) makeEmptyRow(summary,3,"ยังไม่มีข้อมูล");
    for(const [part,g] of grouped){
      const tr=document.createElement("tr");
      tr.append(safeCell(part),safeCell(g.total),safeCell(formula(g.qtys)));
      summary.append(tr);
    }
  }

  function processScan(raw, source="manual", onModalClose=null) {
    const original=String(raw ?? "").trim();
    const sourceLabel = source === "camera" ? "กล้องมือถือ" : "เครื่องสแกน / กรอกมือ";

    if(!original) {
      playBeepError();
      notify("กรุณาสแกนหรือกรอก Barcode","error");
      showScanModal(false, "สแกนไม่ผ่าน", [
        "ไม่พบข้อมูล Barcode",
        "กรุณาสแกนหรือกรอกข้อมูลก่อนกดบันทึก"
      ], onModalClose);
      return false;
    }

    const fields=original.split(";");
    if(fields.length<8) {
      playBeepError();
      const msg = `พบ ${fields.length} ช่อง (ต้องมีอย่างน้อย 8 ช่องคั่นด้วย ;)`;
      notify(`Barcode ไม่ถูกต้อง: ${msg}`,"error");
      showScanModal(false, "สแกนไม่ผ่าน · รูปแบบไม่ถูกต้อง", [
        msg,
        `ข้อมูลที่อ่านได้: ${original}`
      ], onModalClose);
      return false;
    }

    const part=fields[0].trim();
    const qtyText=fields[4].trim();
    const qty=Number(qtyText);
    if(!part || qtyText==="" || !Number.isFinite(qty) || qty<=0) {
      playBeepError();
      const msg = "ช่องที่ 1 ต้องมี Part No. และช่องที่ 5 ต้องเป็น Qty มากกว่า 0";
      notify(`ข้อมูลไม่ถูกต้อง: ${msg}`,"error");
      showScanModal(false, "สแกนไม่ผ่าน · ข้อมูลไม่ครบถ้วน", [
        msg,
        `Part No. (ช่อง 1): ${part || "-"} | Qty (ช่อง 5): ${qtyText || "-"}`
      ], onModalClose);
      return false;
    }

    if(scans.some(s=>s.raw.trim()===original)) {
      playBeepError();
      notify("Barcode นี้ถูกบันทึกไปแล้ว ไม่เพิ่มรายการซ้ำ","error");
      showScanModal(false, "สแกนไม่ผ่าน · ข้อมูลซ้ำ", [
        "Barcode นี้ถูกบันทึกในรายการไปแล้ว",
        `Part No.: ${part} · Qty: ${qty}`
      ], onModalClose);
      return false;
    }

    scans.unshift({raw:original,part,qty,time:new Date().toLocaleString("th-TH")});
    save(); render();
    playBeepSuccess();
    notify(`บันทึกสำเร็จ · ${part} · Qty ${qty} · ${sourceLabel}`,"success");
    showScanModal(true, "สแกนผ่าน · บันทึกสำเร็จ", [
      `Part No.: ${part}`,
      `จำนวน (Qty): ${qty}`,
      `ช่องทาง: ${sourceLabel}`
    ], onModalClose);
    return true;
  }

  function submitInput() {
    const input=$("scanInput");
    const val = input.value;
    processScan(val, "bluetooth", () => {
      input.value = "";
      input.focus();
    });
  }

  function setActiveMode(modeId) {
    $("focusScanner").classList.toggle("active", modeId === "focusScanner");
    $("openCamera").classList.toggle("active", modeId === "openCamera");
  }

  function focusScanner() {
    playBeepClick();
    stopCamera();
    setActiveMode("focusScanner");
    $("scanInput").focus();
    notify("พร้อมรับข้อมูลจาก Bluetooth scanner: สแกนลงช่องนี้และให้เครื่องส่ง Enter ท้ายข้อมูล","success");
  }

  async function startCamera() {
    playBeepClick();
    if(!window.isSecureContext) {
      playBeepError();
      notify("การใช้กล้องต้องเปิดเว็บไซต์ผ่าน HTTPS หรือ localhost","error"); return;
    }
    if(!navigator.mediaDevices?.getUserMedia) {
      playBeepError();
      notify("เบราว์เซอร์นี้ไม่รองรับการเข้าถึงกล้อง","error"); return;
    }
    if(!("BarcodeDetector" in window)) {
      playBeepError();
      notify("Chrome/เบราว์เซอร์นี้ยังไม่รองรับ BarcodeDetector ใช้ Bluetooth scanner ได้ตามปกติ","error"); return;
    }
    try {
      const available=await BarcodeDetector.getSupportedFormats();
      const preferred=["code_128","code_39","ean_13","ean_8","upc_a","upc_e","itf","qr_code","codabar","data_matrix"];
      const formats=preferred.filter(f=>available.includes(f));
      if(!formats.length) throw new Error("ไม่พบชนิด Barcode ที่กล้องรองรับ");
      detector=new BarcodeDetector({formats});
      cameraStream=await navigator.mediaDevices.getUserMedia({
        audio:false, video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}}
      });
      $("cameraVideo").srcObject=cameraStream;
      $("cameraPanel").hidden=false;
      $("stopCamera").disabled=false;
      $("openCamera").disabled=true;
      setActiveMode("openCamera");
      cameraRunning=true;
      updateCameraModeUI();
    } catch(err) {
      stopCamera();
      playBeepError();
      notify(`เปิดกล้องไม่สำเร็จ: ${err.message || err}`,"error");
    }
  }

  function updateCameraModeUI() {
    const isAuto = $("autoScanCheck").checked;
    const triggerBtn = $("triggerScanBtn");
    if (isAuto) {
      triggerBtn.disabled = true;
      $("cameraStatus").textContent = "โหมดสแกนอัตโนมัติ: เล็งกล้องไปที่ Barcode ให้อยู่ในกรอบ";
      if (cameraRunning && !detectTimer && !modalOpen) detectNextFrame();
    } else {
      triggerBtn.disabled = false;
      if (detectTimer) { clearTimeout(detectTimer); detectTimer = null; }
      $("cameraStatus").textContent = "เล็งกล้องไปที่ Barcode แล้วกดปุ่ม \"🎯 กดเพื่อสแกน\"";
    }
  }

  async function triggerManualCameraScan() {
    if (modalOpen) return;
    if (!cameraRunning || !detector) {
      playBeepError();
      notify("กรุณาเปิดกล้องก่อนกดสแกน", "error");
      return;
    }
    const video = $("cameraVideo");
    if (video.readyState < 2) {
      playBeepError();
      $("cameraStatus").textContent = "กล้องยังไม่พร้อม กรุณารอสักครู่แล้วกดอีกครั้ง";
      return;
    }
    const triggerBtn = $("triggerScanBtn");
    triggerBtn.classList.add("scanning");
    playBeepClick();
    $("cameraStatus").textContent = "กำลังอ่าน Barcode...";

    try {
      let hits = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        hits = await detector.detect(video);
        if (hits.length) break;
        await new Promise(r => setTimeout(r, 150));
      }

      if (hits.length && hits[0].rawValue) {
        const raw = hits[0].rawValue;
        const ok = processScan(raw, "camera");
        $("cameraStatus").textContent = ok
          ? `อ่านสำเร็จ: ${raw.split(";")[0]} (กด OK แล้วสแกนรายการถัดไป)`
          : "พบ Barcode แต่ข้อมูลไม่ผ่านเงื่อนไข (กด OK เพื่อดำเนินการต่อ)";
      } else {
        playBeepError();
        $("cameraStatus").textContent = "ไม่พบ Barcode ในกรอบภาพ กรุณาขยับกล้องให้ชัดเจนแล้วกดใหม่";
        notify("ไม่พบ Barcode กรุณาลองกดสแกนอีกครั้ง", "error");
        showScanModal(false, "สแกนไม่ผ่าน · ไม่พบ Barcode", [
          "ไม่พบ Barcode ในกรอบภาพ",
          "กรุณาเล็ง Barcode ให้อยู่ในกรอบเส้นประให้ชัดเจน แล้วกดสแกนอีกครั้ง"
        ]);
      }
    } catch (e) {
      playBeepError();
      $("cameraStatus").textContent = "เกิดข้อผิดพลาดในการอ่านภาพ กรุณาลองใหม่";
      showScanModal(false, "สแกนไม่ผ่าน · อ่านภาพไม่สำเร็จ", [
        "เกิดข้อผิดพลาดในการประมวลผลภาพจากกล้อง",
        "กรุณาลองกดสแกนอีกครั้ง"
      ]);
    } finally {
      setTimeout(() => triggerBtn.classList.remove("scanning"), 200);
    }
  }

  async function detectNextFrame() {
    if(!cameraRunning || !$("autoScanCheck").checked || modalOpen) {
      detectTimer = null;
      return;
    }
    const video=$("cameraVideo");
    if(video.readyState>=2) {
      try {
        const hits=await detector.detect(video);
        if(hits.length) {
          const raw=hits[0].rawValue || "";
          const now=Date.now();
          if(raw && (raw!==lastCameraRaw || now-lastCameraTime>2500)) {
            lastCameraRaw=raw; lastCameraTime=now;
            processScan(raw,"camera");
            return; // หยุดรอผู้ใช้กดปุ่ม OK บนหน้าต่างแจ้งผลก่อนสแกนต่อ
          }
        }
      } catch(e) { /* ลองเฟรมถัดไป */ }
    }
    if(cameraRunning && $("autoScanCheck").checked && !modalOpen) {
      detectTimer=setTimeout(detectNextFrame,220);
    } else {
      detectTimer=null;
    }
  }

  function stopCamera() {
    cameraRunning=false;
    if(detectTimer) clearTimeout(detectTimer);
    detectTimer=null;
    if(cameraStream) cameraStream.getTracks().forEach(t=>t.stop());
    cameraStream=null;
    if($("cameraVideo")) $("cameraVideo").srcObject=null;
    if($("cameraPanel")) $("cameraPanel").hidden=true;
    if($("stopCamera")) $("stopCamera").disabled=true;
    if($("openCamera")) $("openCamera").disabled=false;
    setActiveMode("focusScanner");
  }

  function download(name,content,type) {
    const blob=new Blob([content],{type}), url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1200);
  }
  function exportJson() {
    playBeepClick();
    download(`IssueScan_${new Date().toISOString().slice(0,10)}.json`,
      JSON.stringify(scans,null,2),"application/json;charset=utf-8");
  }
  function csvQuote(v) { return `"${String(v??"").replace(/"/g,'""')}"`; }
  function exportCsv() {
    playBeepClick();
    const rows=[["Part No.","Qty","Barcode","Scan Time"],
      ...scans.map(s=>[s.part,s.qty,s.raw,s.time])];
    download(`IssueScan_${new Date().toISOString().slice(0,10)}.csv`,
      "\uFEFF"+rows.map(r=>r.map(csvQuote).join(",")).join("\r\n"),
      "text/csv;charset=utf-8");
  }
  function importJson(file) {
    const reader=new FileReader();
    reader.onload=()=>{
      try {
        const data=JSON.parse(reader.result);
        if(!Array.isArray(data) || !data.every(x=>x && typeof x.raw==="string" &&
          typeof x.part==="string" && Number.isFinite(Number(x.qty)) && Number(x.qty)>0))
          throw new Error("โครงสร้างไฟล์ไม่ถูกต้อง");
        const existing=new Set(scans.map(x=>x.raw.trim())); let added=0;
        data.forEach(x=>{
          const raw=x.raw.trim();
          if(raw && !existing.has(raw)) {
            scans.push({raw,part:x.part,qty:Number(x.qty),time:x.time||""});
            existing.add(raw); added++;
          }
        });
        save(); render();
        playBeepSuccess();
        notify(`นำเข้าสำเร็จ ${added} รายการ (ข้าม Barcode ที่ซ้ำ)`,"success");
      } catch(e) {
        playBeepError();
        notify(`นำเข้าไม่สำเร็จ: ${e.message}`,"error");
      }
      $("importFile").value="";
    };
    reader.readAsText(file);
  }
  function updateNetwork() {
    const el=$("networkState"), online=navigator.onLine;
    el.textContent=online?"ออนไลน์":"ออฟไลน์";
    el.classList.toggle("offline",!online);
  }
  document.addEventListener("DOMContentLoaded",()=>{
    updateSoundButton();
    render(); updateNetwork();
    $("toggleSound").addEventListener("click", toggleSound);
    $("modalOkBtn").addEventListener("click", closeScanModal);
    document.addEventListener("keydown", e => {
      if (modalOpen && (e.key === "Enter" || e.key === "Escape" || e.key === " ")) {
        e.preventDefault();
        closeScanModal();
      }
    });
    $("scanInput").addEventListener("keydown",e=>{
      if(e.key==="Enter") {
        e.preventDefault();
        if (!modalOpen) submitInput();
      }
    });
    $("submitScan").addEventListener("click",submitInput);
    $("focusScanner").addEventListener("click",focusScanner);
    $("openCamera").addEventListener("click",startCamera);
    $("stopCamera").addEventListener("click",()=>{ playBeepClick(); stopCamera(); });
    $("triggerScanBtn").addEventListener("click",triggerManualCameraScan);
    $("autoScanCheck").addEventListener("change",()=>{ playBeepClick(); updateCameraModeUI(); });
    $("clearInput").addEventListener("click",()=>{ playBeepClick(); $("scanInput").value="";$("scanInput").focus(); });
    $("exportJson").addEventListener("click",exportJson);
    $("exportCsv").addEventListener("click",exportCsv);
    $("importJson").addEventListener("click",()=>{ playBeepClick(); $("importFile").click(); });
    $("importFile").addEventListener("change",e=>{if(e.target.files[0])importJson(e.target.files[0]);});
    $("clearAll").addEventListener("click",()=>{
      playBeepClick();
      if(confirm("ยืนยันลบข้อมูลการสแกนทั้งหมดในเครื่องนี้หรือไม่?")) {
        scans=[];save();render();
        playBeepClick();
        notify("ล้างข้อมูลทั้งหมดแล้ว","success");
      }
    });
    window.addEventListener("online",updateNetwork);
    window.addEventListener("offline",updateNetwork);
    if("serviceWorker" in navigator && (location.protocol==="http:" || location.protocol==="https:")) {
      navigator.serviceWorker.register("./sw.js").catch(()=>{});
    }
  });
  window.addEventListener("pagehide",stopCamera);
})();
