// Visual compositing only: no world tracking, recognition, recording or upload.
export function setupCameraPreview({ onCameraChange, onReferenceChange }) {
  const video = document.getElementById('camera-feed');
  const cameraButton = document.getElementById('camera-toggle');
  const modelButton = document.getElementById('reference-toggle');
  const status = document.getElementById('camera-status');
  let stream = null, pending = false, requestId = 0, modelVisible = true;

  function stopCamera(message = '摄像头已关闭 · 仅视觉预览，不做定位') {
    requestId++;
    pending = false;
    if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    stream = null;
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    if (cameraButton) {
      cameraButton.textContent = '开启摄像头';
      cameraButton.setAttribute('aria-pressed', 'false');
      cameraButton.removeAttribute('aria-busy');
    }
    if (status) status.textContent = message;
    document.querySelector('.stage').classList.remove('camera-live');
    onCameraChange(false);
  }

  async function startCamera() {
    if (stream || pending) { stopCamera(); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      if (status) status.textContent = '当前浏览器无法开启摄像头，请在 Safari / Chrome 中通过 localhost 或 HTTPS 打开。';
      return;
    }
    const id = ++requestId;
    pending = true;
    if (cameraButton) {
      cameraButton.textContent = '取消开启';
      cameraButton.setAttribute('aria-busy', 'true');
    }
    if (status) status.textContent = '正在请求摄像头，请允许浏览器访问…';
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (id !== requestId) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      video.srcObject = acquired;
      await video.play();
      if (id !== requestId) return;
      pending = false;
      video.hidden = false;
      if (cameraButton) {
        cameraButton.textContent = '关闭摄像头';
        cameraButton.setAttribute('aria-pressed', 'true');
        cameraButton.removeAttribute('aria-busy');
      }
      if (status) status.textContent = modelVisible ? '摄像头已开启 · 关闭参考模型可查看纯实景叠加' : '实景叠加中 · 仅视觉评估，不做空间定位';
      document.querySelector('.stage').classList.add('camera-live');
      onCameraChange(true);
      for (const track of stream.getVideoTracks()) track.onended = () => stopCamera('摄像头连接已结束，可重新开启。');
    } catch (error) {
      if (id !== requestId) return;
      const messages = {
        NotAllowedError: '未获得摄像头权限，请在浏览器中允许访问后重试。',
        NotFoundError: '未检测到摄像头，请连接摄像头后重试。',
        NotReadableError: '摄像头暂时无法使用，可能被其他应用占用。',
        SecurityError: '浏览器限制了摄像头访问，请改用 Safari / Chrome 打开本页。'
      };
      stopCamera(messages[error.name] || '摄像头开启失败，请检查设备与浏览器权限后重试。');
    }
  }

  if (cameraButton) {
    cameraButton.addEventListener('click', startCamera);
  }

  /* 默认直接开启摄像头背景 */
  startCamera();

  if (modelButton) {
  modelButton.addEventListener('click', () => {
    modelVisible = !modelVisible;
    modelButton.textContent = modelVisible ? '关闭参考模型' : '显示参考模型';
    modelButton.setAttribute('aria-pressed', String(!modelVisible));
    document.querySelector('.stage').classList.toggle('reference-hidden', !modelVisible);
    onReferenceChange(modelVisible);
    if (stream && !pending) status.textContent = modelVisible ? '摄像头已开启 · 关闭参考模型可查看纯实景叠加' : '实景叠加中 · 仅视觉评估，不做空间定位';
  });
  }
  // Release hardware on navigation and allow a fresh start after bfcache restore.
  window.addEventListener('pagehide', () => stopCamera());
}
