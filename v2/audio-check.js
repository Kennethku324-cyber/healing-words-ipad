// Standalone diagnostic: no game state, microphone acquisition stays on the page's buttons.
(function () {
  var mode = document.getElementById('audio-mode');
  var status = document.getElementById('audio-status');
  var prepare = document.getElementById('prepare-audio');
  var play = document.getElementById('play-audio');
  var contexts = [], buffer = null, media = null, source = null, ready = 'none';
  var generation = 0, gpu = null, gpuFrame = 0;
  var clip = new URL('StreamingAssets/TtsClips/pee_01_1.mp3', location.href).href;
  function log(line) { window.hwDiagLog('[音訊] ' + line); }
  function stopPlayback() {
    if (source) { source.onended = null; try { source.stop(); } catch (e) {} source = null; }
    if (media) { media.onended = null; media.pause(); }
    window.__hwAudioCheckPhase = '閒置';
  }
  async function resetAudio() {
    generation++; stopPlayback();
    var old = contexts; contexts = []; buffer = null; media = null; ready = 'none';
    await Promise.all(old.map(function (c) { return c.close().catch(function () {}); }));
  }
  mode.onchange = async function () {
    document.getElementById('start').disabled = true;
    prepare.disabled = true; play.disabled = true;
    await resetAudio(); prepare.disabled = false;
    document.getElementById('start').disabled = !(window.SpeechRecognition || window.webkitSpeechRecognition);
    status.textContent = '已切換，請先按準備'; log('模式切換為 ' + mode.value);
  };
  prepare.onclick = async function () {
    var selected = mode.value, current = ++generation;
    prepare.disabled = true; play.disabled = true; status.textContent = '準備中……';
    document.getElementById('start').disabled = true;
    window.__hwAudioCheckPhase = '準備音訊';
    try {
      if (selected === 'web') {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw Error('不支援 Web Audio');
        if (!contexts.length) contexts = [new AC(), new AC()];
        // Resume synchronously from the gesture, before awaiting fetch/decode.
        var resumes = contexts.map(function (c) { return c.resume(); });
        var bytes = await (await fetch(clip)).arrayBuffer();
        var decoded = await contexts[1].decodeAudioData(bytes);
        await Promise.all(resumes);
        if (current !== generation) return;
        buffer = decoded;
      } else if (selected === 'media') {
        media = new Audio(clip); media.preload = 'auto'; media.muted = true;
        // Unlock this element with the prepare gesture; preparation is measured separately.
        await media.play(); media.pause(); media.currentTime = 0; media.muted = false;
      }
      if (current !== generation) return;
      ready = selected; play.disabled = selected === 'none';
      status.textContent = '已準備；先等 10 秒，再開始辨識';
      log('準備完成：' + selected + '；context=' + contexts.map(function (c) { return c.state + '/' + c.sampleRate; }).join(','));
    } catch (e) { status.textContent = String(e); log('準備失敗：' + e); }
    finally {
      if (current === generation) {
        window.__hwAudioCheckPhase = '閒置';
        prepare.disabled = false;
        document.getElementById('start').disabled = !(window.SpeechRecognition || window.webkitSpeechRecognition);
      }
    }
  };
  async function playNpc() {
    if (ready === 'none') return;
    stopPlayback(); window.__hwAudioCheckPhase = 'NPC 開聲／播放';
    var started = performance.now(); log('NPC 播放請求：' + ready);
    function ended() { window.__hwAudioCheckPhase = '閒置'; log('NPC 播放結束'); }
    try {
      if (ready === 'web') {
        await contexts[1].resume();
        source = contexts[1].createBufferSource(); source.buffer = buffer;
        source.connect(contexts[1].destination); source.onended = ended; source.start();
      } else {
        media.currentTime = 0; media.onended = ended; await media.play();
      }
      log('NPC 播放已啟動，用時 ' + Math.round(performance.now() - started) + 'ms');
    } catch (e) { log('NPC 播放失敗：' + e); ended(); }
  }
  play.onclick = playNpc;
  window.hwDiagAfterRecognition = function () {
    if (document.getElementById('auto-audio').checked) playNpc();
  };
  document.getElementById('gpu-mode').onchange = function (ev) {
    cancelAnimationFrame(gpuFrame);
    if (gpu) {
      var ext = gpu.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
      gpu.canvas.remove(); gpu = null;
    }
    if (!ev.target.checked) { log('WebGL 動畫已關閉'); return; }
    var canvas = document.createElement('canvas'); canvas.width = 1640; canvas.height = 1040;
    document.getElementById('gpu-slot').appendChild(canvas);
    var gl = canvas.getContext('webgl2');
    if (!gl) { canvas.remove(); ev.target.checked = false; log('WebGL2 不支援'); return; }
    gpu = {canvas: canvas, gl: gl};
    function draw(t) {
      gl.clearColor(0.2 + 0.1 * Math.sin(t / 500), 0.1, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gpuFrame = requestAnimationFrame(draw);
    }
    gpuFrame = requestAnimationFrame(draw); log('WebGL 動畫已開啟（1640×1040）');
  };
  window.__hwAudioCheckPhase = '閒置';
  window.addEventListener('pagehide', function () { resetAudio(); cancelAnimationFrame(gpuFrame); });
})();
