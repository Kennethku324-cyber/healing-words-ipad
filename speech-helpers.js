// 療心之言 語音診斷＋手勢覆蓋層 helpers（普通 JS，index.html 直接載入）。
// 唔放喺 .jslib 入面：emscripten 只會帶 mergeInto 物件內嘅函數入最終輸出，
// 檔案其他位置嘅 helper 會被丟棄（實測 ReferenceError: hwLogInit is not defined）。
// 捕捉 Unity 用嘅 AudioContext（喺 Unity 載入前 wrap 個 constructor）：
// iOS 辨識期間要「完全 suspend」個 context 先放到個音訊 session 俾辨識器 —
// 淨係 AudioListener.pause（出靜音）唔夠，個 session 仲係俾遊戲佔住（實測收唔到音）。
(function () {
  window.__hwAudioContexts = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function () {
      var ctx = new Orig();
      window.__hwAudioContexts.push(ctx);
      return ctx;
    };
    Wrapped.prototype = Orig.prototype;
    window[name] = Wrapped;
  });
})();

// ---- 真凍結：閘住 requestAnimationFrame ----
// Unity WebGL 成個引擎（邏輯＋渲染）靠 rAF 行；targetFrameRate 喺呢個 build 嘅
// WebGL glue 冇實作（grep framework.js 0 次，實測凍唔到）→ 喺 Unity 載入「之前」
// 包住 rAF：凍結期間唔派幀（callback 排隊），解凍一次過沖返出嚟，引擎喺原地續
// （Unity maximumDeltaTime 會 clamp 追帧幅度，遊戲邏輯唔會跳）。
(function () {
  var orig = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  if (!orig) return;
  window.__hwOrigRaf = orig;
  window.__hwFrozenRafQueue = null;
  window.requestAnimationFrame = function (cb) {
    if (window.__hwFrozenRafQueue) { window.__hwFrozenRafQueue.push(cb); return 0; }
    return orig(cb);
  };
  window.hwSetUnityFrozen = function (on) {
    if (on) {
      if (!window.__hwFrozenRafQueue) {
        window.__hwFrozenRafQueue = [];
        window.__hwFreezeAt = Date.now();
        window.hwLog('🧊 引擎真凍結（rAF 閘）');
      }
    } else if (window.__hwFrozenRafQueue) {
      var q = window.__hwFrozenRafQueue;
      window.__hwFrozenRafQueue = null;
      window.__hwFreezeAt = 0;
      q.forEach(function (cb) { orig(cb); });
      window.hwLog('🧊 引擎解凍（沖返 ' + q.length + ' 個排隊幀）');
    }
  };
  // 安全網：凍結超過 20 秒（session 死埋連 onend 都冇）強制解凍，唔會永遠黑屏
  setInterval(function () {
    if (window.__hwFrozenRafQueue && window.__hwFreezeAt && Date.now() - window.__hwFreezeAt > 20000) {
      window.hwLog('⏱ 凍結 20 秒安全網：強制解凍');
      window.hwSetUnityFrozen(false);
    }
  }, 5000);
  // 講完／出錯之後排定解凍：iOS 節流見過 → 等 7.5 秒（節流窗＋2 秒緩衝）先解凍；
  // 未見過 → 即刻解凍。解凍同時通知 C# 清 flag。
  window.hwScheduleUnfreeze = function () {
    clearTimeout(window.__hwUnfreezeTimer);
    var delay = window.__hwIosClampSeen ? 7500 : 0;
    window.__hwUnfreezeTimer = setTimeout(function () {
      window.hwSetUnityFrozen(false);
      try { window.unityInstance.SendMessage('VoiceCast', 'OnWebEngineUnfrozen'); } catch (e) { }
    }, delay);
  };
})();

window.hwSuspendAudio = function () {
  window.__hwAudioDirty = true;   // 用過咪：session 切過錄音模式，下次播聲前要暖場
  window.__hwChainWarm = false;   // gain 鏈都要重新暖
  var n = 0;
  (window.__hwAudioContexts || []).forEach(function (c) {
    if (c && c.state === 'running') {
      c.suspend().catch(function () { });
      n++;
    }
  });
  window.hwLog('🔇 遊戲音訊 suspend（' + n + ' 個 context，放個 session 俾辨識器）');
};

window.hwResumeAudio = function () {
  var n = 0;
  (window.__hwAudioContexts || []).forEach(function (c) {
    if (c && c.state === 'suspended') {
      c.resume().catch(function () { });
      n++;
    }
  });
  if (n > 0) window.hwLog('🔊 遊戲音訊 resume（' + n + ' 個 context）');
};

window.hwLog = function (msg) {
  try {
    var line = new Date().toISOString().slice(11, 23) + ' ' + msg;
    if (!window.__hwLogs) window.__hwLogs = [];
    window.__hwLogs.push(line);
    if (window.__hwLogs.length > 300) window.__hwLogs.shift();
    // localStorage 同步寫入係主線程 I/O — lag 螺旋時長帧 log 每幀一行會自我放大。
    // 節流：最多 2 秒寫一次磁（「記錄」掣開嗰陣照睇到記憶體入面最新 300 行）
    var nowMs = Date.now();
    if (!window.__hwLastPersist || nowMs - window.__hwLastPersist > 2000) {
      window.__hwLastPersist = nowMs;
      try { localStorage.setItem('hw_speech_log', JSON.stringify(window.__hwLogs.slice(-150))); } catch (e) { }
    }
    console.log('[HWLOG] ' + msg);
  } catch (e) { /* ignore */ }
};

// SW 版本回報：記錄視圖會顯示「SW: hw-xxxx」— 用嚟確認部機行緊邊個 build
window.__hwSwVersion = '(查詢中)';
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'hw-sw-version') {
      window.__hwSwVersion = e.data.v;
      window.hwLog('SW 版本：' + e.data.v);
    }
  });
}
// 主動查詢：SW 版本平時只會喺新 SW activate 嗰下廣播，但廣播完個頁面會自動
// reload — reload 後嘅頁面永遠收唔到，頭一行就永遠「查詢中」（實測）。
// 所以打開記錄／開機時主動向 SW 攞版本。
window.hwAskSwVersion = function () {
  try {
    if (!navigator.serviceWorker) return;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'hw-get-version' });
    } else {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.active) reg.active.postMessage({ type: 'hw-get-version' });
      }).catch(function () { });
    }
  } catch (e) { /* ignore */ }
};

window.hwLogInit = function () {
  if (window.__hwLogsDone) return;
  window.__hwLogsDone = true;
  try { window.__hwLogs = JSON.parse(localStorage.getItem('hw_speech_log') || '[]'); } catch (e) { window.__hwLogs = []; }
  window.hwLog('── session 開始 ──');
  window.hwLog('UA: ' + navigator.userAgent);
  var standalone = (window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  window.hwLog('standalone=' + standalone + ' online=' + navigator.onLine +
    ' https=' + (location.protocol === 'https:'));
  window.hwLog('SpeechRecognition 支援=' + !!(window.SpeechRecognition || window.webkitSpeechRecognition));

  // 「記錄」掣（左上小掣）：彈成個 log 出嚟影相用
  if (!document.getElementById('hw-log-btn')) {
    var btn = document.createElement('button');
    btn.id = 'hw-log-btn';
    btn.textContent = '記錄';
    btn.style.cssText = 'position:fixed;top:6px;left:6px;z-index:1001;padding:6px 10px;' +
      'font-size:13px;background:rgba(0,0,0,0.55);color:#f9a8d4;border:1px solid #f472b6;' +
      'border-radius:8px;font-family:sans-serif;';
    btn.onclick = function (ev) {
      ev.preventDefault();
      window.hwAskSwVersion(); // 每次打開記錄都問一次 SW 版本（reload 後都問得到）
      var old = document.getElementById('hw-log-view');
      if (old) { old.remove(); return; }
      var view = document.createElement('pre');
      view.id = 'hw-log-view';
      view.style.cssText = 'position:fixed;inset:0;z-index:1002;margin:0;padding:16px;' +
        'background:rgba(10,4,8,0.94);color:#fce7f3;font-size:12px;line-height:1.5;' +
        'white-space:pre-wrap;overflow:auto;font-family:monospace;';
      view.textContent = 'SW: ' + (window.__hwSwVersion || '(未知)') + '\n\n' +
        (window.__hwLogs || []).join('\n') + '\n\n（再撳「記錄」掣收埋；可以影相抄低）';
      document.body.appendChild(view);
      try { navigator.clipboard && navigator.clipboard.writeText(view.textContent); } catch (e) { }
    };
    document.body.appendChild(btn);
  }
  window.hwAskSwVersion(); // 開機問一次（之後每次撳「記錄」都會再問）
};

window.hwSpeechSupported = function () {
  window.hwLogInit();
  return (window.SpeechRecognition || window.webkitSpeechRecognition) ? 1 : 0;
};

window.hwSpeechMode = function () {
  var standalone = (window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return standalone ? 1 : 0;
};

window.hwStopSpeech = function () {
  // 放手：排定收遮罩＋解凍（防 onend 唔射時賴死唔走）
  window.hwScheduleListenOverlayHide();
  window.hwScheduleUnfreeze();
  try { if (window.__hwRecog) window.__hwRecog.stop(); } catch (e) { /* ignore */ }
};

// ---- 「聆聽中」遮罩（用家規格：全螢幕半透明黑，正中央文字）----
// 三個狀態：
//   準備中 — 撳咪嗰下（iOS 語音引擎開機要 0.3~2 秒，逐次增長；呢陣講嘢會食字）
//   聆聽中 — onaudiostart（真正開始收音）→ 呢個先係開口訊號
//   聽到「字」 — interim 結果實時反饋
// 收起時機：辨識結果／session 結束後 — iOS 節流見過（__hwIosClampSeen）→ 等 7.5 秒
// （節流窗過、同解凍同步）先收；未見過 → 即刻收。
window.hwShowListenOverlay = function () {
  try {
    var ov = document.getElementById('hw-listen-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'hw-listen-overlay';
      ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:999;' +
        'background:rgba(0,0,0,0.55);display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;pointer-events:none;' +
        'font-family:-apple-system,"PingFang HK",sans-serif;';
      var st = document.createElement('style');
      st.textContent = '@keyframes hwListenBeat{0%,100%{transform:scale(1);opacity:0.8}' +
        '50%{transform:scale(1.15);opacity:1}}';
      var heart = document.createElement('div');
      heart.textContent = '❤';
      heart.style.cssText = 'font-size:56px;color:#fb7185;animation:hwListenBeat 1.1s ease-in-out infinite;';
      var t1 = document.createElement('div');
      t1.style.cssText = 'margin-top:14px;color:#fce7f3;font-size:19px;letter-spacing:2px;';
      var t2 = document.createElement('div');
      t2.style.cssText = 'margin-top:6px;color:#f9a8d4;font-size:15px;';
      ov.appendChild(st);
      ov.appendChild(heart);
      ov.appendChild(t1);
      ov.appendChild(t2);
      ov._t1 = t1;
      ov._t2 = t2;
      document.body.appendChild(ov);
    }
    ov.style.display = 'flex';
    hwListenState('準備中……', '米開始收音');
  } catch (e) { /* ignore */ }
};
function hwListenState(main, sub) {
  try {
    var ov = document.getElementById('hw-listen-overlay');
    if (!ov || ov.style.display === 'none') return;
    ov._t1.textContent = main;
    ov._t2.textContent = sub;
  } catch (e) { /* ignore */ }
}
window.hwListenReady = function () {
  hwListenState('聆聽中……', '請講出字卡內容');
};
window.hwListenHeard = function (word) {
  hwListenState('聽到「' + word + '」……', '繼續講，講完先放手');
};
window.hwHideListenOverlay = function () {
  try {
    var ov = document.getElementById('hw-listen-overlay');
    if (ov) ov.style.display = 'none';
  } catch (e) { /* ignore */ }
};
window.hwScheduleListenOverlayHide = function () {
  try {
    clearTimeout(window.__hwListenHideTimer);
    if (window.__hwIosClampSeen) {
      window.__hwListenHideTimer = setTimeout(window.hwHideListenOverlay, 7500);
    } else {
      window.hwHideListenOverlay();
    }
  } catch (e) { /* ignore */ }
};

window.hwStartSpeech = function (target) {
  if (window.__hwHolding === false) { window.hwLog('跳過：已放手'); return; }
  window.hwSetUnityFrozen(true); // 撳咪：引擎即刻真凍結（rAF 閘）
  window.hwShowListenOverlay(); // 遮罩：凍結期間全螢幕半透明黑＋中央文字
  window.hwLogInit();
  window.__hwRestarts = window.__hwRestarts || 0;
  window.hwLog('▶ start 辨識' + (window.__hwRestarts > 0 ? '（第 ' + (window.__hwRestarts + 1) + ' 次）' : ''));
  try {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      window.hwLog('✗ 唔支援 SpeechRecognition');
      window.unityInstance.SendMessage(target, 'OnWebSpeechError', 'unsupported');
      return;
    }
    if (window.__hwRecog) {
      try { window.__hwRecog.abort(); window.hwLog('abort 咗上一個 recognition'); } catch (e) { /* ignore */ }
      window.__hwRecog = null;
    }
    var r = new SR();
    r.lang = 'zh-HK';
    // continuous＋interimResults：連續模式撐住唔早死（每個中間結果都算「有嘢發生」，
    // iOS 唔會當靜音自動收線）；講完放手我哋先主動 stop
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    window.__hwRecog = r;
    window.__hwGotFinal = false;
    window.__hwLoggedInterim = false;
    window.__hwLastActivity = Date.now(); // 最後活動時間（重啟邏輯用）

    // watchdog 唔再用固定 10 秒：改成「15 秒冇任何 callback」先斬 —
    // 連續模式下次 callback 會不斷重設（有嘢發生就唔會斬到實施講話中嘅你）
    clearTimeout(window.__hwWatchdog);
    var armWatchdog = function () {
      clearTimeout(window.__hwWatchdog);
      window.__hwWatchdog = setTimeout(function () {
        window.hwLog('⏱ watchdog 15s 冇活動：強制 stop');
        try { r.stop(); } catch (e) { /* ignore */ }
      }, 15000);
    };
    window.__hwArmWatchdog = armWatchdog;
    armWatchdog();

    // 管道每格都記錄：邊一格冇出現＝邊度斷咗
    r.onstart = function () { window.hwLog('· onstart（引擎開咗）'); armWatchdog(); };
    r.onaudiostart = function () {
      window.hwLog('· onaudiostart（麥克風開咗）');
      // 心跳：餵 C# 辨識活動時間戳（12 秒無活動自動解凍嘅依據）
      try { window.unityInstance.SendMessage(target, 'OnWebSpeechKeepalive'); } catch (e) { }
      window.hwListenReady(); // 真正開始收音：話俾玩家知可以開口
      armWatchdog();
    };
    r.onsoundstart = function () { window.hwLog('· onsoundstart（收到聲音）'); armWatchdog(); };
    r.onspeechstart = function () { window.hwLog('· onspeechstart（偵測到語音）'); armWatchdog(); };
    r.onspeechend = function () { window.hwLog('· onspeechend（語音結束）'); armWatchdog(); };
    r.onaudioend = function () { window.hwLog('· onaudioend（麥克風閂咗）'); armWatchdog(); };
    r.onresult = function (ev) {
      armWatchdog(); // 有嘢發生：watchdog 重設
      var text = '', interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) text += ev.results[i][0].transcript;
        else interim += ev.results[i][0].transcript;
      }
      if (interim && !window.__hwLoggedInterim) {
        window.__hwLoggedInterim = true;
        window.hwLog('· 中間結果「' + interim + '」（講緊收到字）');
      }
      if (interim) {
        // 心跳：講緊嘢期间不斷餵 C# 活動時間戳
        try { window.unityInstance.SendMessage(target, 'OnWebSpeechKeepalive'); } catch (e) { }
        window.hwListenHeard(interim); // 實時反饋：遮罩顯示聽到嘅字
      }
      if (text) {
        window.__hwGotFinal = true;
        window.hwLog('· onresult「' + text + '」');
        window.hwScheduleListenOverlayHide(); // 講完：遮罩＋引擎等節流窗過先收／解凍
        window.hwScheduleUnfreeze();
        window.unityInstance.SendMessage(target, 'OnWebSpeechResult', text.trim());
      }
    };
    r.onerror = function (ev) {
      window.hwLog('✗ onerror: ' + (ev.error || 'unknown'));
      // aborted/no-speech 係連續模式嘅日常：唔彈提示，交畀重啟邏輯
      if (ev.error === 'aborted' || ev.error === 'no-speech') return;
      window.hwResumeAudio(); // 權限類錯誤：開返音訊，唔好留喺 suspend
      window.hwScheduleListenOverlayHide(); // 出錯收工：遮罩／解凍照排（防 onend 唔射）
      window.hwScheduleUnfreeze();
      window.unityInstance.SendMessage(target, 'OnWebSpeechError', ev.error || 'error');
    };
    r.onend = function () {
      // session 真正結束（非重啟）：排定收遮罩＋解凍（C# 側經 OnWebSpeechEnd 收尾）
      window.hwLog('■ onend（結束）');
      if (!window.__hwHolding) {
        window.hwScheduleListenOverlayHide();
        window.hwScheduleUnfreeze();
      }
      // 放手：真正收工（連續模式下用戶放手會先 stop → 行到嚟呢度）
      if (!window.__hwHolding) {
        window.hwResumeAudio();
        window.unityInstance.SendMessage(target, 'OnWebSpeechEnd');
        return;
      }
      // 仲撳住：無論咩原因（靜音收線/no-speech/aborted）都重開繼續聽 —
      // 呢個就係「唔准佢早死」嘅核心：你撳住幾耐，咪就開幾耐
      if ((window.__hwRestarts || 0) < 12) {
        window.__hwRestarts++;
        window.hwLog('↻ 仲撳住：重開辨識（第 ' + window.__hwRestarts + ' 次）');
        setTimeout(function () { window.hwStartSpeech(target); }, 120);
        return;
      }
      window.hwLog('重開次數用盡，收工');
      window.hwResumeAudio();
      window.unityInstance.SendMessage(target, 'OnWebSpeechEnd');
    };
    // 凍結由 C# 側 OnWebSpeechStart 負責（targetFrameRate=2＋OnDemandRendering，
    // 見 VoiceCastController.FreezeForSpeech — 呢個 Unity build 嘅 WebGL API 冇 SetPaused）
    r.start();
    window.hwLog('r.start() 已叫（lang=zh-HK, interim=on）');
  } catch (e) {
    window.hwLog('✗ start 拋異常: ' + e);
    try { window.unityInstance.SendMessage(target, 'OnWebSpeechError', String(e)); } catch (e2) { /* ignore */ }
  }
};

// VRM 資料夾支援檢查
window.hwVrmFolderSupported = function () {
  return (window.showDirectoryPicker && window.indexedDB) ? 1 : 0;
};

// 掃資料夾所有 .vrm/.glb → 「名;名;…」回傳 Unity（同時存 handle 落 IndexedDB）
window.hwListVrmFolder = function (target) {
  if (!window.__hwVrmFolderHandle) {
    try { window.unityInstance.SendMessage(target, 'OnVrmFolderList', ''); } catch (e) { }
    return;
  }
  var handle = window.__hwVrmFolderHandle;
  (async function () {
    try {
      var names = [];
      for await (var entry of handle.values()) {
        if (entry.kind === 'file' &&
            (entry.name.toLowerCase().endsWith('.vrm') || entry.name.toLowerCase().endsWith('.glb'))) {
          names.push(entry.name);
        }
      }
      names.sort();
      try {
        var db = await new Promise(function (res, rej) {
          var rq = indexedDB.open('hw_vrm_folder', 1);
          rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
          rq.onsuccess = function () { res(rq.result); };
          rq.onerror = function () { rej(rq.error); };
        });
        await new Promise(function (res, rej) {
          var tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(handle, 'dir');
          tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
        });
      } catch (e) { /* metadata 存唔到唔阻住今次 */ }
      window.hwLog('📁 掃描 VRM 資料夾：' + names.length + ' 個檔');
      try { window.unityInstance.SendMessage(target, 'OnVrmFolderList', names.join(';')); } catch (e) { }
    } catch (e) {
      window.hwLog('📁 掃描 VRM 資料夾失敗：' + e);
      try { window.unityInstance.SendMessage(target, 'OnVrmFolderList', ''); } catch (e2) { }
    }
  })();
};

// 由資料夾讀指定 VRM → blob URL 回傳 Unity
window.hwReadVrmFolder = function (name, target) {
  if (!window.__hwVrmFolderHandle) return;
  (async function () {
    try {
      var fh = await window.__hwVrmFolderHandle.getFileHandle(name);
      var file = await fh.getFile();
      var url = URL.createObjectURL(file);
      window.hwLog('📁 讀取 VRM：' + name + '（' + Math.round(file.size / 1048576) + 'MB）');
      try { window.unityInstance.SendMessage(target, 'OnVrmFolderFile', url); } catch (e) { }
    } catch (e) {
      window.hwLog('📁 讀取 VRM 失敗：' + name + ' ' + e);
      try { window.unityInstance.SendMessage(target, 'OnVrmFolderFile', ''); } catch (e2) { }
    }
  })();
};

// ---- 渲染解析度 0.6×（iPad retina 全解析度渲染係 WebGL 最大負荷）----
// 直接設 canvas width/height（Unity WebGL 嘅標準 resize 機制）；
// 唔用 Screen.SetResolution — 佢喺 WebGL 會行 requestFullscreen，冇手勢就爆錯誤框（實測）。
window.hwRenderScale = 0.6;
window.hwApplyCanvasScale = function () {
  // （撤收）行緊途中改 canvas 尺寸喺 iOS 會令 CanvasScaler 重算 → UI 變巨／排版亂。
  // 渲染解析度維持 index.html 開機時設定（0.6×），唔再動態改。
};
// （撤收）動態 resize 會令 iOS CanvasScaler 重算 → UI 變巨排版全亂。渲染解析度維持開機時設定。

// VFX 播放期間：渲染解析度暫時減半（粒子＋全解析度係 iPad WebGL 最大負荷，實測被治癒嗰刻 lag）
// 播完自動還原 0.6×。用 debounce 防連續 VFX 不斷切換。
window.__hwVfxScaleTimer = null;
window.hwVfxPerformanceMode = function (seconds) {
  // （撤收）動態 canvas resize 令 iOS CanvasScaler 重算 → UI 變巨。粒子減量已足夠。
  window.hwLog('VFX 效能模式已停用（避免 iOS 排版問題）');
};

// VRM 資料夾：揀資料夾（一定要喺用戶手勢入面叫 showDirectoryPicker）＋開機恢復授權
window.hwConnectVrmFolder = function (target) {
  window.hwLogInit();
  try {
    window.showDirectoryPicker({ mode: 'read' }).then(function (handle) {
      window.__hwVrmFolderHandle = handle;
      window.hwLog('📁 已連接 VRM 資料夾：' + handle.name);
      try { window.unityInstance.SendMessage(target, 'OnVrmFolderConnected', handle.name); } catch (e) { }
    }).catch(function (e) {
      if (e && e.name !== 'AbortError') window.hwLog('📁 連接資料夾失敗：' + e);
    });
  } catch (e) {
    window.hwLog('📁 showDirectoryPicker 唔存在：' + e);
    try { window.unityInstance.SendMessage(target, 'OnVrmFolderError', 'unsupported'); } catch (e2) { }
  }
};

// 開機恢復：上一次授權過嘅資料夾（handle 存喺 IndexedDB；iOS 17+ 會彈一次「允許再次存取」）
window.hwRestoreVrmFolder = function (target) {
  if (!window.indexedDB || window.__hwVrmFolderHandle) return;
  try {
    var rq = indexedDB.open('hw_vrm_folder', 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
    rq.onsuccess = function (ev) {
      var db = ev.target.result;
      try {
        var tx = db.transaction('kv', 'readonly');
        var get = tx.objectStore('kv').get('dir');
        get.onsuccess = function () {
          if (!get.result) return;
          get.result.queryPermission({ mode: 'read' }).then(function (state) {
            if (state === 'granted') {
              window.__hwVrmFolderHandle = get.result;
              window.hwLog('📁 已恢復 VRM 資料夾授權：' + get.result.name);
              try { window.unityInstance.SendMessage(target, 'OnVrmFolderConnected', get.result.name); } catch (e) { }
            } else {
              window.hwLog('📁 VRM 資料夾授權需要重新確認（state=' + state + '）');
            }
          });
        };
      } catch (e) { /* 冇 store 正常 */ }
    };
  } catch (e) { /* ignore */ }
};

// ---- NPC 廣東話 TTS（iOS 內建 speechSynthesis，離線即時）----
// iOS 內建 zh-HK 得女聲（Sin-ji）；男 NPC 用 pitch 調低模擬（0.7-0.8）。
// iOS 規定 speak() 之後要有用戶手勢先解鎖 → 第一次 pointerdown 先 prime 一次。
window.hwTtsVoice = function () {
  if (window.__hwHkVoice !== undefined) return window.__hwHkVoice;
  var voices = speechSynthesis.getVoices() || [];
  var pick = null;
  for (var i = 0; i < voices.length; i++) {
    var lang = (voices[i].lang || '').toLowerCase().replace('_', '-');
    if (lang.indexOf('zh-hk') === 0 || voices[i].name.indexOf('Sin-ji') === 0) { pick = voices[i]; break; }
  }
  if (!pick) { // 冇 zh-HK：退而求其次搵任何廣東話／中文聲
    for (var j = 0; j < voices.length; j++) {
      var l = (voices[j].lang || '').toLowerCase();
      if (l.indexOf('zh') === 0 || l.indexOf('yue') === 0) { pick = voices[j]; break; }
    }
  }
  window.__hwHkVoice = pick || null;
  window.hwLog('TTS 聲線：' + (pick ? pick.name + '（' + pick.lang + '）' : '用預設（搵唔到 zh-HK）'));
  return window.__hwHkVoice;
};

window.hwTtsSpeak = function (text, pitch, rate, target) {
  try {
    if (!window.speechSynthesis) {
      window.hwLog('✗ TTS：speechSynthesis 唔存在');
      return;
    }
    // 人聲閘：引擎凍結期間唔出聲（等解凍先播，同 MP3 路徑一致）
    if (window.__hwFrozenRafQueue) {
      setTimeout(function () { window.hwTtsSpeak(text, pitch, rate, target); }, 200);
      return;
    }
    speechSynthesis.cancel(); // 新一句頂走舊一句
    var u = new SpeechSynthesisUtterance(text);
    var v = window.hwTtsVoice();
    if (v) u.voice = v;
    u.lang = 'zh-HK';
    u.pitch = Math.min(2, Math.max(0.1, pitch));
    u.rate = Math.min(2, Math.max(0.5, rate));
    u.onend = function () {
      window.hwLog('· TTS onend');
      try { window.unityInstance.SendMessage(target, 'OnWebTtsEnd'); } catch (e) { }
    };
    u.onerror = function (ev) {
      window.hwLog('✗ TTS onerror: ' + (ev.error || '?'));
      try { window.unityInstance.SendMessage(target, 'OnWebTtsEnd'); } catch (e) { }
    };
    speechSynthesis.speak(u);
    window.hwLog('· TTS speak（pitch=' + u.pitch.toFixed(2) + ' rate=' + u.rate.toFixed(2) + '）');
  } catch (e) {
    window.hwLog('✗ TTS 拋異常: ' + e);
  }
};

window.hwTtsStop = function () {
  try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  try { if (window.__hwTtsSrc) { window.__hwTtsSrc.onended = null; window.__hwTtsSrc.stop(); window.__hwTtsSrc = null; } } catch (e) { /* ignore */ }
};

// ---- 預錄 MP3 播放（Web Audio 解碼 — Unity WebGL 嘅 MP3 解碼器有 bug：length 0，實測）----
window.hwTtsCtx = function () {
  if (!window.__hwTtsAudioCtx) {
    var AC = window.AudioContext || window.webkitAudioContext;
    window.__hwTtsAudioCtx = new AC();
  }
  if (window.__hwTtsAudioCtx.state === 'suspended') window.__hwTtsAudioCtx.resume().catch(function () { });
  return window.__hwTtsAudioCtx;
};

window.hwTtsPlayUrl = function (url, text, target) {
  window.hwLogInit();
  window.hwLog('▶ MP3 播放：' + url);
  var ctx = window.hwTtsCtx();
  // 人聲增益鏈：source → gain(2.5×) → 輸出
  // （唔用 DynamicsCompressor：WebKit 佢開頭會淡入 — 實測由細聲升上嚟嘅嫌疑之一）
  if (!window.__hwTtsGain) {
    var gain = ctx.createGain();
    gain.gain.value = 2.5;
    gain.connect(ctx.destination);
    window.__hwTtsGain = gain;
  }

  // 先確保 context 完全 running（iOS resume 有 fade-in，未 running 就開聲會由細聲升上嚟）
  var ensureRunning = function () {
    ctx.resume().catch(function () { });
    return new Promise(function (res) {
      var t0 = Date.now();
      var chk = setInterval(function () {
        if (ctx.state === 'running' || Date.now() - t0 > 2000) {
          clearInterval(chk); res();
        }
      }, 50);
    });
  };

  var startBuffer = function (audio) {
    // 人聲閘：引擎凍結（rAF 閘）期間唔出聲 — 等解凍（遮罩收）嗰刻先播
    // （Web Audio 計時唔受 rAF 閘影響，所以暖場照行，人聲淨係延到解凍）
    if (window.__hwFrozenRafQueue) {
      setTimeout(function () { startBuffer(audio); }, 200);
      return;
    }
    var src = ctx.createBufferSource();
    src.buffer = audio;
    src.onended = function () {
      window.hwLog('· MP3 onend');
      window.__hwTtsSrc = null;
      try { window.unityInstance.SendMessage(target, 'OnWebTtsEnd'); } catch (e) { }
    };
    src.connect(window.__hwTtsGain);
    src.start();
    window.__hwTtsSrc = src;
  };

  // 出聲前暖場：播 1 秒靜音行同一條 gain 鏈 — iOS 喺一段靜音之後，
  // Web Audio 輸出頭一秒會由細聲升上嚟（實測）；暖場完，人聲一出就全音量
  var playWithWarmup = function (audio) {
    try { if (window.__hwTtsSrc) { window.__hwTtsSrc.onended = null; window.__hwTtsSrc.stop(); window.__hwTtsSrc = null; } } catch (e) { }
    // 每一次回覆都暖場 1 秒：iOS 喺一段靜音之後，輸出頭一秒會由細聲升上嚟（實測），
    // 下一關／隔一段時間都會再發生 — 所以唔再分「鏈熱未熱」，每次都暖，保證出聲即全音量
    window.hwLog('· 暖場 1 秒（行 gain 鏈）後出聲');
    var silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate);
    silent.connect(window.__hwTtsGain);
    silent.onended = function () {
      window.__hwChainWarm = true;
      window.hwLog('· 暖場完成，出聲');
      startBuffer(audio);
    };
    silent.start();
  };

  var play = function (audio) {
    ensureRunning().then(function () { playWithWarmup(audio); });
  };

  // 快取優先：關卡開始已預載就即播（零延遲零 fade）
  if (window.__hwClipCache && window.__hwClipCache[url]) {
    play(window.__hwClipCache[url]);
    return;
  }
  fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (buf) {
    return ctx.decodeAudioData(buf);
  }).then(function (audio) {
    window.__hwClipCache = window.__hwClipCache || {};
    window.__hwClipCache[url] = audio;
    window.hwLog('· MP3 解碼成功（' + audio.duration.toFixed(1) + 's）');
    play(audio);
  }).catch(function (e) {
    window.hwLog('✗ MP3 播放失敗：' + e + ' — 退返瀏覽器 TTS');
    // 失敗 fallback：用返 speechSynthesis（冇 pitch 資料，用中性設置）
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text || '');
      var v = window.hwTtsVoice();
      if (v) u.voice = v;
      u.lang = 'zh-HK';
      u.onend = function () { try { window.unityInstance.SendMessage(target, 'OnWebTtsEnd'); } catch (e2) { } };
      speechSynthesis.speak(u);
    } catch (e2) { /* ignore */ }
  });
};

// 關卡開始時預載：該關 4 句 MP3 事先 fetch＋解碼（玩到嗰刻零延遲零 lag）
window.hwTtsPreload = function (urlsJoined) {
  var urls = (urlsJoined || '').split(';').filter(function (u) { return u; });
  if (!urls.length) return;
  var ctx = window.hwTtsCtx(); // 順便喺關卡開始 warm 起（通常喺手勢鏈附近）
  window.__hwClipCache = window.__hwClipCache || {};
  var pending = urls.filter(function (u) { return !window.__hwClipCache[u]; });
  if (!pending.length) return;
  window.hwLog('預載 ' + pending.length + ' 句 TTS clip…');
  pending.forEach(function (u) {
    fetch(u).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) {
      return ctx.decodeAudioData(b);
    }).then(function (audio) {
      window.__hwClipCache[u] = audio;
      window.hwLog('· 預載完成：' + u.split('/').pop());
    }).catch(function (e) {
      window.hwLog('· 預載失敗：' + u.split('/').pop() + ' ' + e);
    });
  });
};

// keep-alive：iOS 會閒置幾十秒後 suspend 靜音嘅 context → suspend 期间 NPC 聲會 fade-in
// 每 10 秒檢查一次，suspended 就 resume（context 一經手勢解鎖，之後 resume 都有效）
setInterval(function () {
  var c = window.__hwTtsAudioCtx;
  if (c && c.state === 'suspended') c.resume().catch(function () { });
}, 10000);

// session 暖場：1.2 秒靜音，等 iOS 音訊 session 由錄音模式完全切返播放模式
window.hwWarmSession = function () {
  try {
    var ctx = window.hwTtsCtx();
    if (ctx.state !== 'running') ctx.resume().catch(function () { });
    var warm = ctx.createBufferSource();
    warm.buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
    warm.connect(ctx.destination);
    warm.onended = function () {
      window.__hwAudioDirty = false;
      window.hwLog('session 暖場完成（1.2s）');
    };
    warm.start();
    window.hwLog('session 暖場 1.2s 開始（錄音→播放切換緩衝）');
  } catch (e) { window.hwLog('暖場失敗：' + e); }
};

// 調整人聲音量（1 = 原聲；C# 端可叫）
window.hwSetTtsVolume = function (v) {
  if (window.__hwTtsGain) window.__hwTtsGain.gain.value = Math.max(0.5, Math.min(5, v));
  window.hwLog('TTS 音量設為 ' + v);
};

// 首次手勢解鎖 TTS context（同 speechSynthesis prime 一齊做）
window.hwTtsPrime = function () {
  try {
    window.hwTtsCtx(); // 建立＋resume
    speechSynthesis.getVoices(); // 觸發聲線清單載入
    var u = new SpeechSynthesisUtterance('　');
    u.volume = 0; u.rate = 2;
    speechSynthesis.speak(u);
    window.hwLog('TTS 已解鎖（prime：context＋speechSynthesis）');
  } catch (e) { /* ignore */ }
};
document.addEventListener('pointerdown', function () {
  if (!window.__hwTtsPrimed) { window.__hwTtsPrimed = true; window.hwTtsPrime(); }
}, { once: false, capture: true });

// 「咪」掣 DOM 覆蓋層：iOS Safari 要求 start() 喺用戶手勢同步呼叫鏈入面發起。
window.hwSetMicOverlay = function (x, y, w, h, target) {
  // 「連接 VRM 資料夾」DOM 掣：showDirectoryPicker 都要喺手勢入面叫，
  // 借同一套覆蓋層機制 — 撳 Unity 畫面「連接資料夾」掣上面嘅透明層就同步發起。
  window.hwSetFolderOverlay = function (x2, y2, w2, h2, target2) {
    var fo = window.__hwFolderOverlay;
    if (!fo) {
      fo = document.createElement('div');
      fo.id = 'hw-folder-overlay';
      fo.style.cssText = 'position:fixed;z-index:1000;background:transparent;touch-action:none;';
      fo.addEventListener('pointerdown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        window.hwLogInit();
        window.hwLog('📁 撳咗「連接 VRM 資料夾」（手勢內）');
        window.hwConnectVrmFolder(target2);
      });
      document.body.appendChild(fo);
      window.__hwFolderOverlay = fo;
    }
    fo.style.left = x2 + 'px';
    fo.style.top = (window.innerHeight - y2 - h2) + 'px';
    fo.style.width = w2 + 'px';
    fo.style.height = h2 + 'px';
  };

  window.hwLogInit();
  var ov = window.__hwMicOverlay;
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'hw-mic-overlay';
    ov.style.position = 'fixed';
    ov.style.zIndex = '1000';
    ov.style.background = 'transparent';
    ov.style.touchAction = 'none';
    var press = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.hwLogInit();
      window.__hwHolding = true;   // 撳住狀態：onend 冇結果會自動重開繼續聽
      window.__hwRestarts = 0;     // 每次撳掣重設重啟次數
      window.hwLog('👆 撳咗咪掣（DOM 覆蓋層，手勢內）— 撳住即刻開口講');
      window.hwSuspendAudio();     // 完全放低遊戲音訊 session（iOS 衝突排障）
      try { window.unityInstance.SendMessage(target, 'OnWebSpeechStart'); } catch (e) { /* ignore */ }
      window.hwStartSpeech(target);
    };
    var release = function (ev) {
      if (ev.cancelable) { ev.preventDefault(); ev.stopPropagation(); }
      window.__hwHolding = false;
      window.hwLog('👆 放手（stop 辨識）');
      window.hwStopSpeech();
      // 放手即刻開返所有音訊 — STT 期間 suspend 咗嘅 context 唔 resume 嘅話，
      // 之後 NPC MP3 會喺 iOS resume fade-in 途中開播（由細聲升上嚟，實測）
      window.hwResumeAudio();
      // session 由「錄音模式」切返「播放模式」有過渡 fade（實測人聲由細聲升上嚟）
      // → 放手嗰刻即刻播 1.2 秒靜音暖場，等 session 完全切換完；你讀卡嗰陣佢喺背景做
      if (window.__hwAudioDirty) hwWarmSession();
    };
    ov.addEventListener('pointerdown', press);
    ov.addEventListener('pointerup', release);
    ov.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    document.body.appendChild(ov);
    window.__hwMicOverlay = ov;
    window.hwLog('咪掣覆蓋層已建立');
  }
  // Unity 座標（左下原點）→ 網頁座標（左上原點）
  ov.style.left = x + 'px';
  ov.style.top = (window.innerHeight - y - h) + 'px';
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
};
