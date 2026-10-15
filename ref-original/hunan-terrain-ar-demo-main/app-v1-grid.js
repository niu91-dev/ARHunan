import * as THREE from 'three';

const sceneHost = document.getElementById('scene');
const readout = document.getElementById('scan-readout');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const settings = { height: 1.8, distance: 4.4, lateral: 0, yaw: 0, pitch: 0, idle: true };
const limits = { yaw: 18, pitch: 12 };
const TERRAIN_WIDTH = 4.8;
const TERRAIN_DEPTH = 5.5;
const clock = new THREE.Clock();
let renderer, camera, terrain, maskPixels, maskWidth, maskHeight, uniforms;
let clickCount = 0;
let nextIdle = 0;
let idleSlot = 0;
const idleStarts = [-100, -100, -100];
const idlePositions = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function updateCamera() {
  if (!camera) return;
  camera.position.set(settings.lateral, settings.height, settings.distance);
  camera.lookAt(0, 0.12, 0);
  camera.rotateY(THREE.MathUtils.degToRad(settings.yaw));
  camera.rotateX(THREE.MathUtils.degToRad(settings.pitch));
  camera.updateMatrixWorld();
  document.getElementById('yaw-value').textContent = `${Math.round(settings.yaw)}°`;
  document.getElementById('pitch-value').textContent = `${Math.round(settings.pitch)}°`;
  document.getElementById('pad-icon').style.transform = `translateY(${-((settings.height - 1.8) * 3)}px)`;
}

function setAngle(yaw, pitch) {
  settings.yaw = clamp(yaw, -limits.yaw, limits.yaw);
  settings.pitch = clamp(pitch, -limits.pitch, limits.pitch);
  updateCamera();
}

function setStatus(message, duration = 2200) {
  readout.textContent = message;
  clearTimeout(setStatus.timeout);
  setStatus.timeout = setTimeout(() => { readout.textContent = settings.idle ? '待机扫描中' : '待机扫描已暂停'; }, duration);
}

function maskAt(uv) {
  const x = clamp(Math.floor(uv.x * maskWidth), 0, maskWidth - 1);
  const y = clamp(Math.floor((1 - uv.y) * maskHeight), 0, maskHeight - 1);
  return maskPixels[(y * maskWidth + x) * 4] > 127;
}

function scanAt(uv) {
  uniforms.uClickPos.value.copy(uv);
  uniforms.uClickStart.value = clock.getElapsedTime();
  clickCount += 1;
  setStatus(`定点扫描  /  第 ${String(clickCount).padStart(2, '0')} 次`);
}

function randomLandPoint() {
  for (let i = 0; i < 100; i++) {
    const uv = new THREE.Vector2(0.08 + Math.random() * 0.84, 0.08 + Math.random() * 0.84);
    if (maskAt(uv)) return uv;
  }
  return new THREE.Vector2(0.5, 0.5);
}

function setupControls() {
  for (const key of ['height', 'distance', 'lateral']) {
    const input = document.getElementById(key);
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      document.getElementById(`${key}-value`).textContent = `${settings[key].toFixed(1)} m`;
      updateCamera();
    });
  }
  document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => {
    const dir = button.dataset.dir;
    if (dir === 'reset') setAngle(0, 0);
    if (dir === 'up') setAngle(settings.yaw, settings.pitch + 3);
    if (dir === 'down') setAngle(settings.yaw, settings.pitch - 3);
    if (dir === 'left') setAngle(settings.yaw - 3, settings.pitch);
    if (dir === 'right') setAngle(settings.yaw + 3, settings.pitch);
  }));
  window.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement) return;
    const dirs = { ArrowUp: [0, 3], ArrowDown: [0, -3], ArrowLeft: [-3, 0], ArrowRight: [3, 0] };
    if (!dirs[event.key]) return;
    event.preventDefault();
    setAngle(settings.yaw + dirs[event.key][0], settings.pitch + dirs[event.key][1]);
  });
  document.getElementById('idle-toggle').addEventListener('change', event => {
    settings.idle = event.target.checked;
    readout.textContent = settings.idle ? '待机扫描中' : '待机扫描已暂停';
    if (settings.idle) nextIdle = clock.getElapsedTime() + 0.3;
  });
  document.getElementById('center-scan').addEventListener('click', () => scanAt(new THREE.Vector2(0.5, 0.5)));

  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down = null;
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    down = { x: event.clientX, y: event.clientY, yaw: settings.yaw, pitch: settings.pitch, dragged: false };
  });
  canvas.addEventListener('pointermove', event => {
    if (!down) return;
    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    if (Math.hypot(dx, dy) > 5) down.dragged = true;
    if (down.dragged) setAngle(down.yaw - dx * 0.075, down.pitch + dy * 0.075);
  });
  canvas.addEventListener('pointerup', event => {
    if (!down) return;
    const dragged = down.dragged;
    down = null;
    if (dragged) return;
    const bounds = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(terrain, false).find(item => item.uv && maskAt(item.uv));
    if (hit) scanAt(hit.uv);
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    settings.distance = clamp(settings.distance + Math.sign(event.deltaY) * 0.2, 4.2, 9.5);
    document.getElementById('distance').value = settings.distance;
    document.getElementById('distance-value').textContent = `${settings.distance.toFixed(1)} m`;
    updateCamera();
  }, { passive: false });
}

function buildTerrain(heightGrid, meta, colorTexture, maskTexture) {
  const geometry = new THREE.PlaneGeometry(TERRAIN_WIDTH, TERRAIN_DEPTH, meta.width - 1, meta.height - 1);
  geometry.rotateX(-Math.PI / 2);
  const vertices = geometry.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const elevation = Math.max(0, heightGrid[i]);
    vertices.setY(i, 0.025 + elevation / 2076 * 0.29);
  }
  vertices.needsUpdate = true;
  geometry.computeVertexNormals();
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  colorTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: colorTexture, alphaTest: 0.5, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide }));
  terrain.name = 'HunanTerrain';
  scene.add(terrain);

  uniforms = {
    uTime: { value: 0 },
    uMask: { value: maskTexture },
    uClickPos: { value: new THREE.Vector2(0.5, 0.5) },
    uClickStart: { value: -100 },
    uIdlePos: { value: idlePositions },
    uIdleAge: { value: [100, 100, 100] },
    uIdleEnabled: { value: 1 },
  };
  const scanMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `
      uniform float uTime; uniform sampler2D uMask;
      uniform vec2 uClickPos; uniform float uClickStart;
      uniform vec2 uIdlePos[3]; uniform float uIdleAge[3]; uniform float uIdleEnabled;
      varying vec2 vUv;
      float metric(vec2 a, vec2 b){return length((a-b)*vec2(4.8,5.5));}
      float ring(vec2 center,float age,float speed,float width){
        float dist=metric(vUv,center); float radius=age*speed;
        return exp(-pow((dist-radius)/width,2.0))*exp(-age*0.28)*step(0.0,age)*step(age,3.5);
      }
      void main(){
        if(texture2D(uMask,vUv).r<0.5) discard;
        vec2 g=abs(fract(vUv*vec2(48.0,56.0))-0.5);
        float line=1.0-smoothstep(0.471,0.493,max(g.x,g.y));
        float clickAge=uTime-uClickStart;
        float clickWave=ring(uClickPos,clickAge,1.55,0.105);
        float idleWave=0.0;
        for(int i=0;i<3;i++) idleWave+=ring(uIdlePos[i],uIdleAge[i],1.15,0.09);
        idleWave*=uIdleEnabled;
        float sweep=(1.0-smoothstep(0.0,0.055,abs(vUv.x-(0.5+0.58*sin(uTime*0.34))))) * (0.55+0.45*sin(uTime*1.2));
        float energy=0.18+clickWave*2.5+idleWave*1.15+sweep*0.24;
        float glow=clickWave*0.18+idleWave*0.055;
        vec3 color=mix(vec3(0.19,0.72,0.62),vec3(0.48,1.0,0.87),clamp(clickWave+idleWave,0.0,1.0));
        float alpha=clamp(line*energy+glow,0.0,0.9);
        gl_FragColor=vec4(color,alpha);
      }`,
  });
  const scan = new THREE.Mesh(geometry, scanMaterial);
  scan.position.y = 0.012;
  scan.renderOrder = 2;
  scene.add(scan);
}

function buildEnvironment() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a1512');
  scene.fog = new THREE.Fog('#0a1512', 13, 25);
  scene.add(new THREE.HemisphereLight(0xd1e7dc, 0x314d41, 2.15));
  const sun = new THREE.DirectionalLight(0xf4f0d5, 2.2);
  sun.position.set(-3, 8, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x50baa3, 0.7);
  fill.position.set(3, 4, -5);
  scene.add(fill);

  const slab = new THREE.Mesh(new THREE.BoxGeometry(5.12, 0.25, 5.82), new THREE.MeshStandardMaterial({ color: 0x172721, roughness: 0.83, metalness: 0.1 }));
  slab.position.y = -0.105;
  scene.add(slab);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: 0x537768, transparent: true, opacity: 0.6 }));
  edge.position.copy(slab.position);
  scene.add(edge);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x0c1915, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.25;
  scene.add(floor);
  const floorGrid = new THREE.GridHelper(18, 48, 0x24463b, 0x1a352d);
  floorGrid.position.y = -0.244;
  scene.add(floorGrid);
}

let scene;
function resize() {
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  const time = clock.getElapsedTime();
  uniforms.uTime.value = time;
  uniforms.uIdleEnabled.value = settings.idle ? 1 : 0;
  if (settings.idle && time >= nextIdle) {
    idlePositions[idleSlot].copy(randomLandPoint());
    idleStarts[idleSlot] = time;
    idleSlot = (idleSlot + 1) % 3;
    nextIdle = time + 1.5 + Math.random() * 1.5;
  }
  for (let i = 0; i < 3; i++) uniforms.uIdleAge.value[i] = time - idleStarts[i];
  renderer.render(scene, camera);
}

async function load() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    sceneHost.appendChild(renderer.domElement);
    camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);
    buildEnvironment();
    const textureLoader = new THREE.TextureLoader();
    const [meta, buffer, color, maskTexture, maskImage] = await Promise.all([
      fetch('./assets/terrain-meta.json').then(r => r.json()),
      fetch('./assets/terrain-height.f32').then(r => r.arrayBuffer()),
      textureLoader.loadAsync('./assets/terrain-color.png'),
      textureLoader.loadAsync('./assets/terrain-mask.png'),
      new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = './assets/terrain-mask.png'; }),
    ]);
    const heightGrid = new Float32Array(buffer);
    if (heightGrid.length !== meta.width * meta.height) throw new Error('地形网格尺寸与数据不匹配');
    const canvas = document.createElement('canvas');
    canvas.width = maskImage.width; canvas.height = maskImage.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(maskImage, 0, 0);
    maskPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    maskWidth = canvas.width; maskHeight = canvas.height;
    buildTerrain(heightGrid, meta, color, maskTexture);
    updateCamera();
    resize();
    new ResizeObserver(resize).observe(sceneHost);
    setupControls();
    nextIdle = clock.getElapsedTime() + 0.6;
    window.__demoState = () => ({ ...settings, clickCount, terrainReady: true, canvasSize: [sceneHost.clientWidth, sceneHost.clientHeight] });
    animate();
  } catch (error) {
    console.error(error);
    errorBox.hidden = false;
    errorBox.textContent = `地形加载失败：${error.message}`;
    hint.textContent = '请通过本地 HTTP 服务打开此页面';
  }
}

load();
