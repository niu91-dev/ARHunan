// R04 · surface-locked spatial scan. A partial triangular topology gives the
// HoloLens spatial-mapping character; brightness moves, the geometry never does.
const SIGNAL = `
  uniform float uTime, uSweepX, uSweepDir, uSweepActive;
  uniform vec2 uClickPos, uFocusPos, uFocusRadius, uFocusBand;
  uniform vec4 uLocalPulses[4];
  uniform float uClickStart, uFocusAngle, uFocusAmount, uFocusStart;
  uniform float uEffectGain, uRippleGain, uFocusReach;
  float focusDistance(vec2 uv) {
    vec2 d=(uv-uFocusPos)*vec2(4.8,5.5);
    float c=cos(uFocusAngle), s=sin(uFocusAngle);
    return length(vec2(d.x*c+d.y*s,-d.x*s+d.y*c)/uFocusRadius);
  }
  // Wide, low-contrast waves only modulate surface samples. No ring geometry.
  float wave(float distance, float age, float speed, float width) {
    float radius=age*speed;
    return exp(-pow((distance-radius)/width,2.0))
      *smoothstep(0.0,0.7,age)*(1.0-smoothstep(4.4,6.0,age));
  }
  vec3 illumination(vec2 uv, float surfaceY) {
    vec2 metres=(uv-0.5)*vec2(4.8,5.5);
    float field=0.76+0.24*sin(metres.x*4.2+sin(metres.y*3.1)+uTime*0.33);
    float behind=(uSweepX-uv.x+0.012*sin(uv.y*18.0))*uSweepDir;
    float front=exp(-pow(behind/0.15,2.0))*uSweepActive;
    float trail=smoothstep(-0.05,0.15,behind)*exp(-max(behind,0.0)*5.0)*uSweepActive;
    float fd=focusDistance(uv);
    float elevation=(surfaceY-.025)*2076.0/.29;
    float band=smoothstep(uFocusBand.x-160.0,uFocusBand.x+40.0,elevation)
      *(1.0-smoothstep(uFocusBand.y-40.0,uFocusBand.y+180.0,elevation));
    float footprint=exp(-pow(fd,3.0))*mix(.18,1.0,band);
    float focus=footprint*uFocusAmount;
    // Selection waves use world metres, independently of the small geological
    // highlight footprint. Travel to the farthest masked terrain sample before
    // fading, with a quiet gap after the complete wave has left the province.
    float travelDistance=length((uv-uFocusPos)*vec2(4.8,5.5));
    float speed=.68, width=.40;
    float endRadius=uFocusReach+width;
    float age=mod(max(uTime-uFocusStart,0.0),endRadius/speed+.85);
    float radius=age*speed;
    float edgeFade=1.0-smoothstep(uFocusReach*.90,endRadius,radius);
    float ripple=exp(-pow((travelDistance-radius)/width,2.0))
      *smoothstep(0.0,.65,age)*edgeFade*uFocusAmount;
    float clickAge=uTime-uClickStart;
    float clickDistance=length((uv-uClickPos)*vec2(4.8,5.5));
    float clickWave=wave(clickDistance,max(clickAge,0.0),0.56,0.36)*step(0.0,clickAge);
    float glints=0.0;
    for(int i=0;i<4;i++){
      vec4 pulse=uLocalPulses[i];
      float a=uTime-pulse.z;
      float d=length((uv-pulse.xy)*vec2(4.8,5.5));
      float onset=smoothstep(0.0,.35,a);
      float fade=1.0-smoothstep(1.0,3.2,a);
      float core=exp(-pow(d/.20,2.0))*(1.0-smoothstep(.2,1.1,a));
      float expanding=exp(-pow((d-max(a,0.0)*.26)/.11,2.0));
      glints+=(core*.3+expanding*.40)*pulse.w*onset*fade;
    }
    float ambient=mix(0.065,0.014,uFocusAmount);
    float energy=ambient+(front*0.38+trail*0.14)*(1.0-uFocusAmount)
      +focus*0.56+(ripple*0.48+clickWave*0.58)*uRippleGain+glints;
    return vec3(energy*field,front,focus);
  }
`;

export function createTerrainScan({THREE, scene, uniforms, heightAt, maskAt, width, depth}) {
  // Deterministic topology: reloading does not replace the surface with new noise.
  let randomState=0x1a72c4;
  const random=()=>{randomState=(Math.imul(1664525,randomState)+1013904223)>>>0;return randomState/4294967296;};
  const spacing=0.058, rowStep=spacing*Math.sqrt(3)/2, lift=0.0035;
  const nodes=[], lattice=new Map();
  const positions=[], uvs=[], seeds=[], sizes=[];
  for(let row=0; row*rowStep<depth; row++) for(let col=0;col*spacing<width;col++) {
    const x=(col+(row%2)*0.5)*spacing+(random()-.5)*spacing*.42;
    const z=row*rowStep+(random()-.5)*rowStep*.42;
    const uv=new THREE.Vector2(x/width,z/depth);
    if(uv.x<=0||uv.x>=1||uv.y<=0||uv.y>=1||!maskAt(uv))continue;
    const node={uv,x:x-width/2,z:depth/2-z,y:heightAt(uv)+lift,seed:random()};
    lattice.set(`${row},${col}`,nodes.length);nodes.push(node);
    positions.push(node.x,node.y,node.z);uvs.push(uv.x,uv.y);seeds.push(node.seed);sizes.push(.78+random()*.52);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('aUv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('aSeed',new THREE.Float32BufferAttribute(seeds,1));
  geometry.setAttribute('aSize',new THREE.Float32BufferAttribute(sizes,1));
  const points=new THREE.Points(geometry,new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,
    vertexShader:`attribute vec2 aUv;attribute float aSeed,aSize;varying vec2 vUv;varying float vSeed,vHeight;uniform float uPixelRatio;
      void main(){vUv=aUv;vSeed=aSeed;vHeight=position.y;vec4 mv=modelViewMatrix*vec4(position,1.0);
      /* ★ DPR 补偿：gl_PointSize 是 framebuffer 物理像素。DPR 2~3 的平板上
         不乘 uPixelRatio 的话点只剩 0.7 CSS px（≈0.2 mm），扫描网络整片消失。 */
      gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*9.0*uPixelRatio/-mv.z,2.0,7.0);}`,
    fragmentShader:`${SIGNAL} varying vec2 vUv;varying float vSeed,vHeight;
      void main(){vec3 light=illumination(vUv,vHeight);
      float breath=0.78+0.22*sin(uTime*(.65+vSeed*.35)+vSeed*31.0);
      vec2 p=gl_PointCoord-.5;float disc=1.0-smoothstep(.18,.245,dot(p,p));
      float alpha=disc*light.x*(.64+vSeed*.5)*breath*uEffectGain;
      gl_FragColor=vec4(mix(vec3(.60,.95,1.12),vec3(1.12,1.22,1.28),light.y*.35+light.z*.25),alpha);}`
  }));
  points.renderOrder=3;scene.add(points);

  const lp=[],lu=[],ls=[],lseed=[],lside=[];let edgeCount=0,maxEdgeLength=0;
  const addEdge=(a,b)=>{
    if(!a||!b||random()>.67)return;
    const distance=Math.hypot(a.x-b.x,a.z-b.z);
    if(distance>.079||Math.abs(a.y-b.y)>.055)return;
    // Resample throughout the edge against the exact rendered DEM triangles.
    // There are no cross-valley chords, detached midpoints, or animated vertices.
    const divisions=Math.max(4,Math.ceil(distance/.004));
    const samples=[];
    for(let i=0;i<=divisions;i++){
      const uv=a.uv.clone().lerp(b.uv,i/divisions);
      if(!maskAt(uv))return;
      samples.push({uv,y:heightAt(uv)+lift});
    }
    const strength=.60+random()*.4,seed=random();
    /* ★ WebGL 线宽锁 1 物理像素，DPR 2~3 的平板上细到不可见。
       改成屏幕空间加宽的四边形（每段一对三角，两侧顶点 aSide=±1），
       宽度按 framebuffer 像素给，任何 DPR 下都保持 1.8 CSS px 的稳定线宽。 */
    for(let i=0;i<divisions;i++)for(const p of [samples[i],samples[i+1]]){
      for(const side of [-1,1]){
        lp.push((p.uv.x-.5)*width,p.y,(.5-p.uv.y)*depth);
        lu.push(p.uv.x,p.uv.y);ls.push(strength);lseed.push(seed);lside.push(side);
      }
    }
    edgeCount++;maxEdgeLength=Math.max(maxEdgeLength,distance);
  };
  for(const [key,index] of lattice){
    const [r,c]=key.split(',').map(Number);
    const next=(row,col)=>nodes[lattice.get(`${row},${col}`)];
    addEdge(nodes[index],next(r,c+1));
    addEdge(nodes[index],next(r+1,c));
    addEdge(nodes[index],next(r+1,c+(r%2?1:-1)));
  }
  const lg=new THREE.BufferGeometry();
  lg.setAttribute('position',new THREE.Float32BufferAttribute(lp,3));
  lg.setAttribute('aUv',new THREE.Float32BufferAttribute(lu,2));
  lg.setAttribute('aStrength',new THREE.Float32BufferAttribute(ls,1));
  lg.setAttribute('aSeed',new THREE.Float32BufferAttribute(lseed,1));
  lg.setAttribute('aSide',new THREE.Float32BufferAttribute(lside,1));
  const li=[];for(let v=0;v<lp.length/3;v+=4){li.push(v,v+1,v+2,v+1,v+3,v+2);}
  lg.setIndex(li);
  const links=new THREE.Mesh(lg,new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    vertexShader:`attribute vec2 aUv;attribute float aStrength,aSeed,aSide;
      varying vec2 vUv;varying float vStrength,vSeed,vHeight;
      uniform float uPixelRatio;uniform vec2 uViewport;
      void main(){vUv=aUv;vStrength=aStrength;vSeed=aSeed;vHeight=position.y;
      vec4 mv=modelViewMatrix*vec4(position,1.0);
      vec4 clip=projectionMatrix*mv;
      /* 沿视空间下的线段方向取垂直向量，偏移出半宽（framebuffer px → NDC）。
         退化的退化情形（视线与线段重合时 mv.xy≈0）给个 fallback，防 normalize 爆掉。 */
      vec2 dir=mv.xy;float L=length(dir);
      dir=L<1e-5?vec2(1.0,0.0):dir/L;
      vec2 perp=vec2(-dir.y,dir.x);
      clip.xy+=perp*aSide*(uPixelRatio*0.9)*2.0/uViewport*clip.w;
      gl_Position=clip;}`,
    fragmentShader:`${SIGNAL} varying vec2 vUv;varying float vStrength,vSeed,vHeight;
      void main(){vec3 light=illumination(vUv,vHeight);
      float breath=.80+.20*sin(uTime*.72+vSeed*14.0);
      float alpha=light.x*vStrength*breath*uEffectGain*.88;
      gl_FragColor=vec4(mix(vec3(.42,.88,1.08),vec3(.90,1.12,1.22),light.y*.4+light.z*.2),min(alpha,.86));}`
  }));
  links.renderOrder=2;scene.add(links);
  // Nodes are mask-clipped: use the actual province outline, not empty corners
  // of the rectangular DEM. The spacing margin covers its sampled boundary.
  const radiusFrom=uv=>nodes.reduce((radius,node)=>Math.max(radius,
    Math.hypot((node.uv.x-uv.x)*width,(node.uv.y-uv.y)*depth)),0)+spacing;
  return {points,links,radiusFrom,stats:{points:nodes.length,edges:edgeCount,maxEdgeLength,surfaceLift:lift}};
}
