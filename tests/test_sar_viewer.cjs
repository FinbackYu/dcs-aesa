'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const viewerHtml=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
const {C_MPS,PROTOCOL}=require('../src/shared/config.cjs');
const SIZE=PROTOCOL.sar.default_size_m,N=PROTOCOL.sar.default_n;
const script=viewerHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
// 假 <select> 带上页面里真实的 <option>：storage 恢复用的就是这份选项表，"存下来的值已不是合法选项"
// 这类回退才有意义（否则假 DOM 会照单全收）。
const selectOptions=Object.fromEntries([...viewerHtml.matchAll(/<select id="([^"]+)">([\s\S]*?)<\/select>/g)]
  .map(([,id,body])=>[id,[...body.matchAll(/<option value="([^"]*)"/g)].map(([,value])=>value)]));
async function load(width,overrides={},browser={},options={}){
  const elements=new Map(),requests=[],canvas={},rasters=new Map(),contexts=new Map(),timers=[];
  function makeContext(id){
    const ctx={calls:[],createImageData:(w,h)=>{if(id==='image')canvas.dimensions=[w,h];return {width:w,height:h,data:new Uint8ClampedArray(w*h*4)};},
      putImageData:im=>{rasters.set(id,im);if(id==='image')canvas.image=im;},
      clearRect:()=>{rasters.delete(id);ctx.calls.push({op:'clearRect'});}};
    for(const op of ['save','restore','beginPath','closePath','fill','clip','fillRect','strokeRect'])
      ctx[op]=()=>ctx.calls.push({op});
    // 线型在 stroke 时快照：调用方只改 ctx 属性，假上下文不实现状态栈，只有这样断言样式才可靠。
    ctx.stroke=()=>ctx.calls.push({op:'stroke',strokeStyle:ctx.strokeStyle,lineWidth:ctx.lineWidth,dash:ctx.dash});
    ctx.setLineDash=dash=>{ctx.dash=dash;ctx.calls.push({op:'setLineDash',dash});};
    ctx.moveTo=(x,y)=>ctx.calls.push({op:'moveTo',x,y});
    ctx.lineTo=(x,y)=>ctx.calls.push({op:'lineTo',x,y});
    ctx.arc=(x,y,r,start,end)=>ctx.calls.push({op:'arc',x,y,r});
    ctx.fillText=(text,x,y)=>ctx.calls.push({op:'fillText',text,x,y});
    return ctx;
  }
  function element(id){
    if(!elements.has(id)){
      const node={value:({range:'20',side:'1',quality:'standard',focuser:'backprojection',displayRange:'30',footprint:'detail',sceneModel:'classified',referenceView:'height',looks:'2',continuousMode:'relative'})[id]||'hann',textContent:'',disabled:true,width:65,height:65,
        play:async()=>{},getBoundingClientRect:()=>({left:0,top:0,width:512,height:512}),
        getContext:()=>{if(!contexts.has(id))contexts.set(id,makeContext(id));return contexts.get(id);}};
      if(selectOptions[id])node.options=selectOptions[id].map(value=>({value}));
      elements.set(id,node);
    }
    return elements.get(id);
  }
  const db=Array.from({length:width*width},(_,i)=>i<width?-40:0);
  const state={mode:'replay',phase:'成像完成',canCapture:false,canReprocess:true,completed:1000,
    target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45},
    result:{width,size_m:SIZE,source:'dcs',db,power:db.map(v=>10**(v/10)),metadata:{window:'hann'}},...overrides};
  // Each /state poll (in order, the last payload repeats) answers one element of `states`; /image/<seq>
  // answers from `images`, and anything not in it is answered like the service does: 404, not retained.
  // /designate/check defaults to the healthy answer below; a test may pass options.designate (object or
  // function of the query) to model unimageable geometry, a flight advisory, or no pose (error → 409).
  const payloads=(options.states||[options.state||{}]).map(patch=>({...state,...patch})),images=options.images||{};
  let polls=0;
  const sandbox={document:{getElementById:element},setTimeout:fn=>{timers.push(fn);},Date,JSON,Number,Math,
    ...browser,fetch:async(url,options_={})=>{
      requests.push({url,options:options_});
      if(url.startsWith('/state'))return {ok:true,json:async()=>payloads[Math.min(polls++,payloads.length-1)]};
      if(url.startsWith('/image/')){
        const image=images[Number(url.slice('/image/'.length))];
        return image?{ok:true,json:async()=>image}:{ok:false,status:404,json:async()=>({error:'Mosaic image not retained'})};
      }
      // /state 只回 reference 的描述；栅格走 /reference，和真实服务一样。用例用 options.reference
      // 给出这张图的高程栅格，未给出时按服务端无输入回答 409。
      if(url.startsWith('/reference')){
        const reference=options.reference||(state.reference&&state.reference.heights?state.reference:null);
        return reference?{ok:true,status:200,json:async()=>reference}:{ok:false,status:409,json:async()=>({error:'No complete raw input retained'})};
      }
      if(url.startsWith('/designate/check')){
        const asked=options.designate===undefined?{}:typeof options.designate==='function'?options.designate(new URLSearchParams(url.slice(url.indexOf('?')+1))):options.designate;
        // 也接受未决 promise：用例据此让某一次的判定迟到，检验页面丢掉过期结论。
        const late=asked&&typeof asked.then==='function'?await asked:asked;
        const answer={ok:true,reasons:[],range_km:20,relative_track_deg:45,side:1,flightIssue:null,...(late||{})};
        const code=Number.isInteger(answer.status)?answer.status:answer.error?409:200;
        return code===200?{ok:true,status:200,json:async()=>answer}:{ok:false,status:code,json:async()=>({error:answer.error||'No ownship pose'})};
      }
      return {ok:true,json:async()=>({reprocessed:true})};
    }};
  vm.runInNewContext(script,sandbox);
  // 顶层 const 不会挂到全局对象上；mosaicState()/sweepState()/designationState() 返回同一份状态对象，用例据此断言。
  Object.defineProperty(sandbox,'mosaic',{get:()=>sandbox.mosaicState()});
  Object.defineProperty(sandbox,'sweep',{get:()=>sandbox.sweepState()});
  Object.defineProperty(sandbox,'designation',{get:()=>sandbox.designationState()});
  const flush=async(turns=6)=>{for(let i=0;i<turns;i++)await new Promise(r=>setImmediate(r));};
  const pump=async()=>{for(const timer of timers.splice(0))await timer();await flush();};
  await flush();return {element,requests,canvas,rasters,contexts,state,sandbox,timers,pump,flush};
}
test('Viewer handles new and legacy widths and preserves ground-axis orientation',async()=>{
  for(const width of [65,129,257]){
    const {element,canvas}=await load(width);assert.equal(element('image').width,width);assert.equal(element('image').height,width);
    assert.deepEqual(canvas.dimensions,[width,width]);assert.equal(canvas.image.data[0],255);assert.equal(canvas.image.data[(width-1)*width*4],0);
    assert.match(element('mode').textContent,/录制回放/);assert.match(element('stamp').textContent,/来源 dcs/);assert.match(element('stamp').textContent,/地形间隔仍为 8 m/);
    assert.equal(element('capture').disabled,true);assert.equal(element('reprocess').disabled,false);
  }
});
test('Continuous UI starts without coordinates, can stop while disconnected, and locks settings while running',async()=>{
  const {element,requests}=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}});
  assert.equal(element('continuousStart').disabled,false);
  await element('continuousStart').onclick();assert.equal(requests.at(-1).url,'/continuous/start');
  assert.deepEqual(JSON.parse(requests.at(-1).options.body),{side:1,range:20000,record:false,mode:'relative',quality:'standard',window:'hann',footprint:'detail',sceneModel:'classified',focuser:'backprojection'});
  const active=await load(129,{mode:'live',connected:false,continuous:{enabled:true,side:-1,range:10000,record:false,completed:2,note:'等待连接'}});
  assert.equal(active.element('continuousStop').disabled,false);assert.equal(active.element('side').disabled,true);
  assert.equal(active.element('continuousMode').disabled,true);
  assert.match(active.element('continuousStatus').textContent,/已完成 2 张/);
  // 没有 mode 字段的旧服务端：状态行与旧版逐字一致，不出现扫掠字样。
  assert.equal(active.element('continuousStatus').textContent,'连续采集已开启 · 已完成 2 张 · 等待连接 · 左侧 45° / 10 km · 未开启持续录制');
  await active.element('continuousStop').onclick();assert.equal(active.requests.at(-1).url,'/continuous/stop');
});
test('F10 decimal degrees, decimal minutes and DMS target the same point; invalid input sends nothing',async()=>{
  const {element,requests}=await load(129);
  for(const [lat,lon] of [['41.5','42.25'],['N 41° 30.0′','E 042° 15.0′'],['41°30′0″N','042°15′0″E']]){
    element('latitude').value=lat;element('longitude').value=lon;await element('captureGeo').onclick();
    assert.deepEqual(JSON.parse(requests.at(-1).options.body),{latitude:41.5,longitude:42.25,quality:'standard',window:'hann',footprint:'detail',sceneModel:'classified',focuser:'backprojection'});
  }
  element('latitude').value='S41 30';element('longitude').value='W42 15';await element('captureGeo').onclick();
  assert.equal(JSON.parse(requests.at(-1).options.body).latitude,-41.5);
  const count=requests.length;
  for(const lat of ['', '91', 'N41 60', '41 30 60', 'E41', '41.5 30', '-41N', '41junk', 'N41S']){
    element('latitude').value=lat;await element('captureGeo').onclick();assert.equal(requests.length,count,lat);assert.match(element('error').textContent,/坐标/);
  }
  assert.match(element('target').textContent,/41.500000/);assert.match(element('target').textContent,/20.00 km/);
  assert.equal(element('captureGeo').disabled,true);
});
test('Reprocess sends selected window without requesting new DCS acquisition',async()=>{
  const {element,requests}=await load(129);element('window').value='rect';await element('reprocess').onclick();
  const command=requests.at(-1);assert.equal(command.url,'/reprocess');assert.deepEqual(JSON.parse(command.options.body),{quality:'standard',window:'rect',footprint:'detail',sceneModel:'classified',focuser:'backprojection'});
});
test('Contrast redraws the same data locally; fine profile is sent for actual reprocessing',async()=>{
  const {element,requests,canvas,state}=await load(129);
  state.result.db[(129-1)*129]=-20;const original=JSON.stringify(state.result),count=requests.length;
  element('displayRange').value='40';element('displayRange').onchange();assert.equal(canvas.image.data[0],128);
  element('displayRange').value='20';element('displayRange').onchange();assert.equal(canvas.image.data[0],0);
  assert.equal(JSON.stringify(state.result),original);assert.equal(requests.length,count);
  element('quality').value='fine';await element('reprocess').onclick();assert.equal(JSON.parse(requests.at(-1).options.body).quality,'fine');
  const active=await load(129,{mode:'live',restoredDisplay:true,continuous:{enabled:true,side:1,range:20000,record:false,quality:'fine',window:'rect',completed:0,note:'等待连接'}});
  assert.equal(active.element('quality').value,'fine');assert.equal(active.element('window').value,'rect');assert.match(active.element('stamp').textContent,/历史图像/);
});

test('Height/SAR reference shares ground orientation, shows real relief and rejects another image timestamp',async()=>{
  const reference={completed:1000,source:'dcs',center:[1000,50,2000],bearing:Math.PI/2,size:SIZE,n:N,
    heights:Array.from({length:289},(_,i)=>50+Math.floor(i/17))};
  const {element,rasters,requests}=await load(129,{reference});
  const im=rasters.get('heightImage');assert.deepEqual(Array.from(im.data.slice(0,3)),[234,215,140]);
  assert.deepEqual(Array.from(im.data.slice(128*129*4,128*129*4+3)),[25,55,110]);
  assert.match(element('heightScale').textContent,/50.00 m.*66.00 m/);
  element('sarCursor').onmousemove({currentTarget:element('sarCursor'),clientX:512,clientY:0});
  assert.match(element('cursorInfo').textContent,/横向 64.0 m.*地距偏移 64.0 m.*66.00 m.*1064.0 \/ 2064.0/);
  // D3: /state carries the descriptor only; the raster arrives once through /reference.
  assert.deepEqual(requests.map(request=>request.url),['/state','/reference'],'poll + one raster fetch');
  assert.match(element('mapCenter').textContent,/N41°30′00.00″.*E042°15′00.00″/);
  const other=await load(129,{reference:{...reference,completed:2000}});
  assert.equal(other.rasters.has('heightImage'),false);assert.match(other.element('heightScale').textContent,/缺少对应/);
  const flat=await load(129,{reference:{...reference,heights:Array(289).fill(50)}});
  assert.match(flat.element('heightScale').textContent,/起伏 0.00 m/);
  assert.ok(flat.rasters.get('heightImage').data.every(Number.isFinite));
});

test('Overview keeps real extent, classified input and world-coordinate detail targeting',async()=>{
 const reference={completed:1000,source:'dcs',center:[1000,100,2000],bearing:Math.PI/2,size:2048,n:65,heights:Array(4225).fill(100),surfaces:Array(4225).fill('runway'),objects:[],scene_data:{surface_provider:'land.getSurfaceType',object_provider:'world.searchObjects',note:'completed'}};
 const {element,requests,flush,sandbox}=await load(257,{mode:'live',canCapture:true,exportCapabilities:{version:2},reference,result:{width:257,size_m:2048,source:'dcs',db:Array(257**2).fill(-10),metadata:{window:'hann'}}});
 assert.match(element('sarRegion').textContent,/2048 × 2048/);assert.match(element('scale').textContent,/1024/);assert.match(element('inputInfo').textContent,/32 m.*land.getSurfaceType/);
 element('referenceView').value='surface';element('referenceView').onchange();assert.match(element('heightScale').textContent,/跑道/);
 // ③ 栏点选与主视图同一条工作流：先得到指定点，再问服务端几何，最后才按按钮成像。
 element('sarCursor').onclick({currentTarget:element('sarCursor'),clientX:384,clientY:256});
 await flush();
 assert.equal(sandbox.designation.point.worldX,1512);assert.equal(sandbox.designation.point.worldZ,2000);
 assert.equal(sandbox.designation.point.source,'③ 栏');
 assert.deepEqual(requests.filter(request=>request.url.startsWith('/designate/check')).map(request=>request.url),['/designate/check?x=1512.00&z=2000.00']);
 assert.equal(requests.at(-1).url,'/designate/check?x=1512.00&z=2000.00','判定走 GET，不带请求体');
 assert.deepEqual(requests.at(-1).options,{});
 assert.equal(element('designateDetail').disabled,false);
 await element('designateDetail').onclick();
 const params=JSON.parse(requests.at(-1).options.body);assert.equal(params.worldX,1512);assert.equal(params.worldZ,2000);assert.equal(params.footprint,'detail');assert.equal(params.quality,'fine');assert.equal(params.sceneModel,'classified');
});

test('F10 stream needs explicit click, requests no audio, stays local, and releases tracks on stop/end/failure',async()=>{
  let starts=0,stops=0;const track={stop:()=>stops++},stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const browser={navigator:{mediaDevices:{getDisplayMedia:async options=>{starts++;assert.equal(options.audio,false);assert.equal(options.video.displaySurface,'window');return stream;}}}};
  const {element,requests}=await load(129,{},browser);assert.equal(starts,0);
  await element('shareF10').onclick();assert.equal(starts,1);assert.equal(element('f10Video').srcObject,stream);assert.equal(element('stopF10').disabled,false);
  track.onmute();assert.match(element('f10Status').textContent,/暂停/);track.onunmute();assert.match(element('f10Status').textContent,/未与扫描区自动配准/);
  element('stopF10').onclick();assert.equal(stops,1);assert.equal(element('f10Video').srcObject,null);
  await element('shareF10').onclick();track.onended();assert.equal(stops,2);assert.equal(element('stopF10').disabled,true);
  element('f10Video').play=async()=>{throw Error('play failed');};await element('shareF10').onclick();assert.equal(stops,3);assert.match(element('f10Status').textContent,/失败/);
  assert.equal(requests.length,1); // No frame, recording or sharing request is sent to the server.
  const denied=await load(129,{}, {navigator:{mediaDevices:{getDisplayMedia:async()=>{throw {name:'NotAllowedError'};}}}});
  await denied.element('shareF10').onclick();assert.match(denied.element('f10Status').textContent,/未授权/);assert.equal(denied.element('shareF10').disabled,false);
});

const mean=values=>values.reduce((sum,v)=>sum+v,0)/values.length;
const variance=values=>{const m=mean(values);return values.reduce((sum,v)=>sum+(v-m)**2,0)/values.length;};

test('Multi-look averages linear power in N×N blocks and averages remaining edge pixels in place',async()=>{
  const {sandbox}=await load(65),square=(values,looks)=>sandbox.multiLookPower(values,Math.sqrt(values.length),looks);
  const even=square([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],2);
  assert.equal(even.width,2);assert.deepEqual(Array.from(even.power),[3.5,5.5,11.5,13.5]);
  const odd=square([1,2,3,4,5,6,7,8,9],2);
  assert.equal(odd.width,2);assert.deepEqual(Array.from(odd.power),[3,4.5,7.5,9]);
  const one=sandbox.multiLookPower([1,2,3,4,5,6,7,8,9],3,1);
  assert.equal(one.width,3);assert.deepEqual(Array.from(one.power),[1,2,3,4,5,6,7,8,9]);
  const wide=sandbox.multiLookPower(Array.from({length:129*129},(_,i)=>i),129,2);
  assert.equal(wide.width,65);assert.equal(wide.power.length,65*65);
  assert.equal(wide.power[64],192.5);assert.equal(wide.power[64*65],16512.5);assert.equal(wide.power[64*65+64],16640);
});

test('Multi-look keeps a uniform field and lowers speckle variance with the look count',async()=>{
  const {sandbox}=await load(65);
  const flat=sandbox.multiLookPower(Array(129*129).fill(.25),129,3);
  assert.equal(flat.width,43);assert.ok(flat.power.every(v=>v===.25));
  let seed=123456789;const rand=()=>((seed=Math.imul(seed^seed>>>15,0x2545f491)>>>0)/4294967296);
  const speckle=Array.from({length:129*129},()=>-Math.log(Math.max(1e-12,1-rand())));
  const two=sandbox.multiLookPower(speckle,129,2).power,three=sandbox.multiLookPower(speckle,129,3).power;
  assert.ok(Math.abs(mean(two)-mean(speckle))/mean(speckle)<.02,'block averaging keeps the mean level');
  const ratio=variance(two)/variance(speckle);
  assert.ok(ratio>.1&&ratio<.35,'2×2 incoherent averaging approaches one quarter, not an erasure of the speckle');
  assert.ok(variance(three)<variance(two)/1.5,'3×3 combines nine looks');
  assert.deepEqual(sandbox.powerDb([4,1,.0001]),[0,10*Math.log10(1/4),-40]);
});

test('Multi-look switch redraws the current frame at block resolution without new requests',async()=>{
  const {element,requests,canvas}=await load(129);
  element('multiLook').checked=true;element('multiLook').onchange();
  assert.deepEqual(canvas.dimensions,[65,65]);assert.equal(element('image').width,65);
  assert.match(element('scale').textContent,/多视 2×2 线性功率块均值：输出 65×65 块/);
  const row=index=>canvas.image.data[index*4];
  assert.equal(row(0),255);assert.equal(row(64*65),229);assert.equal(row(64*65+64),229);
  element('looks').value='3';element('looks').onchange();
  assert.deepEqual(canvas.dimensions,[43,43]);assert.equal(row(42*43),240);
  element('looks').value='1';element('looks').onchange();
  assert.deepEqual(canvas.dimensions,[129,129]);assert.equal(row(0),255);assert.equal(row(128*129),0);
  const readout=(x,y)=>{element('sarCursor').onmousemove({currentTarget:element('sarCursor'),clientX:x,clientY:y});return element('cursorInfo').textContent;};
  element('multiLook').checked=false;element('multiLook').onchange();
  assert.match(readout(0,512),/SAR -40\.0 dB（相对峰值，单视）/);
  element('multiLook').checked=true;element('looks').value='2';element('multiLook').onchange();
  assert.match(readout(0,512),/SAR -3\.0 dB（相对峰值，多视 2×2 块）/);
  assert.match(readout(512,0),/SAR 0\.0 dB（相对峰值，多视 2×2 块）/);
  assert.equal(requests.length,1); // Only the first /state poll; multi-look never queries the service.
});

test('Multi-look falls back to the single-look frame without linear power and defaults to 2×2',async()=>{
  const legacy=await load(129,{result:{width:129,size_m:SIZE,source:'dcs',db:Array(129*129).fill(-10),metadata:{window:'hann'}}});
  legacy.element('multiLook').checked=true;legacy.element('multiLook').onchange();
  assert.deepEqual(legacy.canvas.dimensions,[129,129]);assert.match(legacy.element('scale').textContent,/缺少可用的线性功率/);
  const {sandbox}=await load(65);
  for(const [width,counts] of [[65,[33,22]],[129,[65,43]],[257,[129,86]]])
    assert.deepEqual([2,3].map(looks=>sandbox.multiLookPower(Array(width*width).fill(1),width,looks).width),counts);
  const html=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
  assert.match(html,/<input id="multiLook" type="checkbox" checked>多视降斑/);
  assert.match(html,/<select id="looks"><option value="2">/);
});

test('Fast test profile is selectable, sent verbatim and keeps its lossy marking on the restored image',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
  assert.match(html,/<option value="fast">快速测试：出图优先，分辨率减半<\/option>/);
  const fast={width:65,size_m:SIZE,source:'dcs',db:Array(65*65).fill(-10),metadata:{window:'hann',quality:'fast',scatter_spacing_m:2,pulse_oversampling:1.5}};
  const {element,requests}=await load(65,{result:fast});
  assert.equal(element('quality').value,'fast');
  assert.match(element('stamp').textContent,/快速测试档/);assert.match(element('stamp').textContent,/降低过采样，可能混叠/);
  await element('reprocess').onclick();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body),{quality:'fast',window:'hann',footprint:'detail',sceneModel:'classified',focuser:'backprojection'});
  const legacy=await load(65,{result:{...fast,metadata:{window:'hann'}}});
  assert.equal(legacy.element('quality').value,'standard');
});

test('Focuser select is sent with every request and restored from the image metadata',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
  assert.match(html,/<select id="focuser"><option value="backprojection">/);
  assert.match(html,/<option value="pfa">PFA：极坐标格式/);
  const pfa={width:129,size_m:SIZE,source:'dcs',db:Array(129*129).fill(-10),metadata:{window:'hann',quality:'standard',focuser:'pfa'}};
  const {element,requests}=await load(129,{result:pfa});
  assert.equal(element('focuser').value,'pfa');
  assert.match(element('stamp').textContent,/聚焦 PFA/);
  element('focuser').value='backprojection';await element('reprocess').onclick();
  assert.equal(JSON.parse(requests.at(-1).options.body).focuser,'backprojection');
  const active=await load(129,{mode:'live',continuous:{enabled:true,side:1,range:20000,record:false,quality:'standard',focuser:'pfa',window:'hann',completed:0,note:'等待连接'}});
  assert.equal(active.element('focuser').value,'pfa');assert.equal(active.element('focuser').disabled,true);
  const back=await load(129,{result:{...pfa,metadata:{window:'hann'}}});
  assert.equal(back.element('focuser').value,'backprojection');
});

const mosaicEntry=(seq,overrides={})=>({seq,completed:1000+seq*10,source:'dcs',record:null,width:129,size_m:SIZE,bearing:0,center:[0,0,0],
  footprint:'detail',target:null,quality:'standard',focuser:'backprojection',scene_model:'classified',image_step_m:1,compute_ms:12,...overrides});
const mosaicTile=(entry,value)=>({...entry,db:Array(entry.width*entry.width).fill(value)});
const mosaicPayload=(overrides={})=>({limit:50,count:0,dropped:0,firstSeq:1,latestSeq:0,dB_step:.25,incremental:false,entries:[],...overrides});
const urls=requests=>requests.map(request=>request.url);

test('Mosaic converts texels to DCS world coordinates with the viewer bearing convention',async()=>{
  const {sandbox}=await load(65);
  const east={center:[1000,50,2000],bearing:Math.PI/2,size_m:SIZE,width:129};
  // 与 ②③ 栏同一换算：cross=+64、ground=+64 对应存储 (col=w−1,row=w−1)，即光标右上角。
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(east,128,128)),[1064,2064]);
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(east,0,0)),[936,1936]);
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(east,64,64)),[1000,2000]);
  const north={center:[1000,50,2000],bearing:0,size_m:SIZE,width:129};
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(north,128,0)),[936,1936]); // SAR 场景：+col → −z
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(north,0,128)),[1064,2064]); // +row → +x
  for(const [col,row] of [[0,0],[128,0],[0,128],[128,128],[64.5,64.5]]){
    const [x,z]=sandbox.mosaicTexelToWorld(north,col,row),back=Array.from(sandbox.mosaicWorldToTexel(north,x,z));
    assert.ok(Math.abs(back[0]-col)<1e-9&&Math.abs(back[1]-row)<1e-9,`texel ${col},${row} 往返`);
  }
  // MAP tiles declare their own canonical layout: col -> +x, row -> +z, with no scene rotation.
  const mapTile={...north,grid_layout:'col_x_row_z'};
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(mapTile,128,0)),[1064,1936]); // col → +x, row 0 → −z
  assert.deepEqual(Array.from(sandbox.mosaicTexelToWorld(mapTile,0,128)),[936,2064]);   // col 0 → −x, row → +z
  for(const [col,row] of [[0,0],[128,0],[0,128],[128,128],[64.5,64.5]]){
    const [x,z]=sandbox.mosaicTexelToWorld(mapTile,col,row),back=Array.from(sandbox.mosaicWorldToTexel(mapTile,x,z));
    assert.ok(Math.abs(back[0]-col)<1e-9&&Math.abs(back[1]-row)<1e-9,`MAP texel ${col},${row} 往返`);
  }
  const view={x:1000,z:2000,scale:2};
  assert.deepEqual({...sandbox.mosaicWorldToScreen(view,320,200,1000,2000)},{x:160,y:100});
  assert.deepEqual({...sandbox.mosaicWorldToScreen(view,320,200,1010,1990)},{x:180,y:80});
  assert.deepEqual({...sandbox.mosaicScreenToWorld(view,320,200,180,80)},{x:1010,z:1990});
});

test('Mosaic paints every retained image at its anchor with the newest over older overlaps',async()=>{
  const first=mosaicEntry(1),second=mosaicEntry(2,{center:[32,0,0]});
  const {sandbox,element,requests,rasters}=await load(129,{},{},{
    state:{mosaic:mosaicPayload({count:2,latestSeq:2,entries:[first,second]})},
    images:{1:mosaicTile(first,-40),2:mosaicTile(second,0)}});
  assert.deepEqual(urls(requests),['/state','/image/1','/image/2']);
  assert.equal(sandbox.mosaic.images.size,2);assert.equal(sandbox.mosaic.latest,2);
  sandbox.mosaic.view={x:0,z:0,scale:1};sandbox.mosaic.fade=false;sandbox.mosaicDraw();
  const canvas=element('mosaic');
  const pixel=(x,y)=>{const im=rasters.get('mosaic');return Array.from(im.data.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+3));};
  assert.deepEqual([canvas.width,canvas.height],[320,200]);
  assert.deepEqual(pixel(110,100),[170,170,170]);   // 仅 #1：db −40 ÷4 = −10 dB → (30−10)/30×255
  assert.deepEqual(pixel(240,100),[255,255,255]);   // 仅 #2：0 dB
  assert.deepEqual(pixel(160,100),[255,255,255]);   // 重叠处后完成的 #2 覆盖 #1
  assert.deepEqual(pixel(50,100),[9,13,18]);        // 两张之外：背景
  assert.deepEqual(pixel(160,20),[9,13,18]);        // 纵向越界（128 m 图只覆盖 ±64.5 m）
  sandbox.mosaic.fade=true;sandbox.mosaicDraw();
  const dimmed=pixel(110,100);
  assert.ok(dimmed[0]>9&&dimmed[0]<170,'旧图变淡但仍可见');assert.equal(pixel(240,100)[0],255,'最新图不淡');
});

test('MAP tiles paint canonical col=x/row=z, so canvas y follows +z and nothing is transposed',async()=>{
  const entry=mosaicEntry(1,{mode:'map',quality:'map',focuser:'real-beam',grid_layout:'col_x_row_z',
    center:[0,0,0],width:3,size_m:2,bearing:0});
  const db=Array(9).fill(-80);                       // −20 dB everywhere
  db[0*3+2]=0;                                       // bright texel: col=2,row=0 -> world (+1,−1)
  db[2*3+0]=-127;                                    // dark texel: col=0,row=2 -> world (−1,+1)
  const {sandbox,element,rasters}=await load(3,{},{},{
    state:{mosaic:mosaicPayload({count:1,latestSeq:1,incremental:false,entries:[entry]})},
    images:{1:{...entry,db}}});
  sandbox.mosaic.view={x:0,z:0,scale:50};sandbox.mosaic.fade=false;sandbox.mosaicDraw();
  const canvas=element('mosaic');
  const pixel=(x,y)=>{const im=rasters.get('mosaic');return Array.from(im.data.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+3));};
  assert.deepEqual(pixel(210,50),[255,255,255],'col=2,row=0 is right of and above the centre');
  assert.deepEqual(pixel(110,150),[0,0,0],'col=0,row=2 is left of and below the centre');
  assert.deepEqual(pixel(110,50),[85,85,85],'the transposed corner is ordinary ground, not the bright texel');
  assert.deepEqual(pixel(210,150),[85,85,85]);
});

test('Mosaic paints a rotated anchor and reads out the image under the cursor',async()=>{
  const rotated=mosaicEntry(1,{bearing:Math.PI/4});
  const {sandbox,element,rasters}=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,latestSeq:1,incremental:false,entries:[rotated]})},images:{1:mosaicTile(rotated,-40)}});
  sandbox.mosaic.view={x:0,z:0,scale:1};sandbox.mosaic.fade=false;sandbox.mosaicDraw();
  const canvas=element('mosaic');
  const pixel=(x,y)=>{const im=rasters.get('mosaic');return Array.from(im.data.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+3));};
  // bearing 45°：texel 右缘 (w−1,0) 落在世界 (64√2,0) → 屏幕 (250,100)，texel (0,w−1) 落在 (0,64√2) → (160,190)。
  assert.deepEqual(pixel(250,100),[170,170,170]);assert.deepEqual(pixel(160,190),[170,170,170]);
  assert.deepEqual(pixel(250,190),[9,13,18]);assert.deepEqual(pixel(80,20),[9,13,18]); // 外接框内、菱形之外：旋转生效
  assert.deepEqual(pixel(160,10),[170,170,170]);
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:256,clientY:256});
  const readout=element('mosaicReadout').textContent;
  assert.match(readout,/#1 · /);assert.match(readout,/128 × 128 m · 129×129/);assert.match(readout,/标准 · 反投影 · 计算 12 ms/);
  assert.match(readout,/方位 45\.0°/);assert.match(readout,/中心 x\/z 0\.0 \/ 0\.0 · 源 dcs/);
  assert.equal(sandbox.mosaic.hover.seq,1);
  assert.deepEqual(pixel(10,10),[9,13,18]);
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:0,clientY:0});
  assert.match(element('mosaicReadout').textContent,/将鼠标移到拼接视图/);
  assert.equal(sandbox.mosaic.hover,null);
});

test('Mosaic leaves the −128 no-data sentinel transparent so a map sector keeps its outline',async()=>{
  const first=mosaicEntry(1),second=mosaicEntry(2,{quality:'map',focuser:'real-beam'});
  const base=mosaicTile(first,-40),shaped=mosaicTile(second,0);
  // #2 是 MAP 帧：扇形外与尚未采集的格子写哨兵 −128；#1 是更早的一帧，先贴、再被 #2 的有数据格覆盖。
  // 左上 32×32 两张都空、col≥64 只有 #2 空——一段同时验证“透出旧图”与“透出背景”。bearing 0 时
  // 行沿 +x（屏幕向右）、列沿 −z（屏幕向上），所以 row<32 是画布左侧、col≥64 是画布上半。
  for(let row=0;row<129;row++)for(let col=0;col<129;col++){
    if(row<32||col>=64)shaped.db[row*129+col]=-128;
    if(row<32&&col<32)base.db[row*129+col]=-128;
  }
  const {sandbox,element,rasters}=await load(129,{},{},{state:{mosaic:mosaicPayload({count:2,latestSeq:2,incremental:false,entries:[first,second]})},images:{1:base,2:shaped}});
  sandbox.mosaic.view={x:0,z:0,scale:1};sandbox.mosaic.fade=false;sandbox.mosaicDraw();
  const canvas=element('mosaic');
  const pixel=(x,y)=>{const im=rasters.get('mosaic');return Array.from(im.data.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+3));};
  assert.deepEqual(pixel(196,136),[255,255,255],'有数据的格子照常贴入');
  assert.deepEqual(pixel(196,56),[170,170,170],'哨兵格跳过不画，#1 的旧图透出来');
  assert.deepEqual(pixel(160,100),[170,170,170],'画布中心也是 #2 的哨兵格，同样透出旧图');
  assert.deepEqual(pixel(116,56),[170,170,170],'只有 #2 空的地方一样透出旧图');
  assert.deepEqual(pixel(116,136),[9,13,18],'两层都空的地方保持背景色，扇形轮廓就是这样留出来的');
  // 悬停读数要说清这一格没有数据，而不是把图元数据当成这格的取值（事件坐标按 512 宽的客户端尺寸给）。
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:196*1.6,clientY:56*2.56});
  assert.match(element('mosaicReadout').textContent,/· 源 dcs · 本格无数据（扇形外或尚未采集）$/);
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:196*1.6,clientY:136*2.56});
  assert.doesNotMatch(element('mosaicReadout').textContent,/本格无数据/);
  // SAR 帧的量化钳位在 −127，哨兵只可能出现在 MAP 帧里——有数据的图像路径完全不受影响。
  assert.equal(sandbox.mosaic.images.get(2).db[100*129+100],-128);
});

test('Mosaic pulls incrementally, skips sequence gaps and drops the oldest past the limit',async()=>{
  const images={};for(const seq of [1,2,3,5,6])images[seq]=mosaicTile(mosaicEntry(seq),-40);
  const states=[
    {mosaic:mosaicPayload({limit:3,count:3,latestSeq:3,incremental:false,entries:[1,2,3].map(seq=>mosaicEntry(seq))})},
    {mosaic:mosaicPayload({limit:3,count:3,dropped:1,firstSeq:2,latestSeq:5,incremental:true,entries:[mosaicEntry(5)]})},
    {mosaic:mosaicPayload({limit:3,count:3,dropped:2,firstSeq:3,latestSeq:6,incremental:true,entries:[mosaicEntry(6)]})},
    {mosaic:mosaicPayload({limit:3,count:3,dropped:2,firstSeq:3,latestSeq:6,incremental:true,entries:[]})}];
  const {sandbox,requests,pump}=await load(129,{},{},{states,images});
  assert.deepEqual(urls(requests),['/state','/image/1','/image/2','/image/3']);
  await pump();
  assert.deepEqual(urls(requests).slice(4),['/state?since=3','/image/5']); // 序号缺口 4 直接跳过，不重建
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[2,3,5]);
  assert.equal(sandbox.mosaic.images.has(1),false);assert.equal(sandbox.mosaic.images.has(2),true);
  assert.equal(sandbox.mosaic.images.has(5),true);assert.equal(sandbox.mosaic.dropped,1);
  await pump();
  assert.deepEqual(urls(requests).slice(6),['/state?since=5','/image/6']);
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[3,5,6]);
  assert.equal(sandbox.mosaic.images.has(2),false);
  const count=requests.length;
  await pump(); // 没有新摘要时不再请求矩阵
  assert.deepEqual(urls(requests).slice(count),['/state?since=6']);
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[3,5,6]);
});

test('Mosaic skips a small gap but rebuilds when the service window passes its cache',async()=>{
  const images={};for(const seq of [1,2,3,5,9,10,11,12])images[seq]=mosaicTile(mosaicEntry(seq),-40);
  const states=[
    {mosaic:mosaicPayload({limit:4,count:3,latestSeq:3,incremental:false,entries:[1,2,3].map(seq=>mosaicEntry(seq))})},
    {mosaic:mosaicPayload({limit:4,count:4,dropped:1,firstSeq:4,latestSeq:5,incremental:true,entries:[mosaicEntry(5)]})},
    {mosaic:mosaicPayload({limit:4,count:4,dropped:3,firstSeq:9,latestSeq:12,incremental:true,entries:[9,10,11,12].map(seq=>mosaicEntry(seq))})},
    {mosaic:mosaicPayload({limit:4,count:4,latestSeq:12,firstSeq:9,incremental:false,entries:[9,10,11,12].map(seq=>mosaicEntry(seq))})}];
  const {sandbox,requests,pump}=await load(129,{},{},{states,images});
  assert.deepEqual(urls(requests),['/state','/image/1','/image/2','/image/3']);
  await pump(); // firstSeq 只比本地最新大 1：按缺口跳过
  assert.deepEqual(urls(requests).slice(4),['/state?since=3','/image/5']);
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[1,2,3,5]);
  await pump(); // 保留窗口整体越过本地缓存：清空等待完整 /state
  assert.deepEqual(urls(requests).slice(6),['/state?since=5']);
  assert.equal(sandbox.mosaic.entries.length,0);assert.equal(sandbox.mosaic.seq,null);assert.equal(sandbox.mosaic.images.size,0);
  await pump(); // 完整 /state 重建，上一次取过的序号也重新取
  assert.deepEqual(urls(requests).slice(7),['/state','/image/9','/image/10','/image/11','/image/12']);
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[9,10,11,12]);assert.equal(sandbox.mosaic.images.size,4);
});

test('Mosaic rebuilds after a restarted service and refetches the new window',async()=>{
  const images={1:mosaicTile(mosaicEntry(1),-40),2:mosaicTile(mosaicEntry(2),-40),3:mosaicTile(mosaicEntry(3),-40)};
  const states=[
    {mosaic:mosaicPayload({count:3,latestSeq:3,incremental:false,entries:[1,2,3].map(seq=>mosaicEntry(seq))})},
    {mosaic:mosaicPayload({count:0,dropped:0,firstSeq:0,latestSeq:0,incremental:true,entries:[]})},
    {mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[mosaicEntry(1)]})}];
  const {sandbox,requests,pump}=await load(129,{},{},{states,images});
  assert.deepEqual(urls(requests),['/state','/image/1','/image/2','/image/3']);
  await pump(); // 序号从 #3 回到 #0：按服务重启重建
  assert.deepEqual(urls(requests).slice(4),['/state?since=3']);
  assert.equal(sandbox.mosaic.entries.length,0);assert.equal(sandbox.mosaic.seq,null);assert.equal(sandbox.mosaic.images.size,0);
  await pump();
  assert.deepEqual(urls(requests).slice(5),['/state','/image/1']);
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[1]);assert.equal(sandbox.mosaic.seq,1);
});

test('Mosaic drops summaries the service no longer retains instead of retrying them',async()=>{
  const states=[{mosaic:mosaicPayload({count:2,latestSeq:2,incremental:false,entries:[mosaicEntry(1),mosaicEntry(2)]})},
    {mosaic:mosaicPayload({count:1,latestSeq:2,incremental:true,entries:[]})}];
  const {sandbox,requests,pump}=await load(129,{},{},{states,images:{1:mosaicTile(mosaicEntry(1),-40)}});
  assert.deepEqual(urls(requests),['/state','/image/1','/image/2']);
  assert.deepEqual(Array.from(sandbox.mosaic.entries,entry=>entry.seq),[1]);
  assert.equal(sandbox.mosaic.images.size,1);assert.equal(sandbox.mosaic.misses,1);
  await pump();
  assert.deepEqual(urls(requests).slice(3),['/state?since=2']);
  assert.equal(requests.filter(request=>request.url==='/image/2').length,1,'不保留的图不再重试');
});

test('Mosaic stays idle while the service reports no mosaic data at all',async()=>{
  const {element,sandbox,requests,pump}=await load(129);
  assert.deepEqual(urls(requests),['/state'],'未收到 mosaic 摘要前不发增量与矩阵请求');
  await pump();await pump();
  assert.deepEqual(urls(requests),['/state','/state','/state'],'旧服务端仍按完整 /state 轮询');
  assert.equal(sandbox.mosaic.images.size,0);assert.equal(sandbox.mosaic.dirty,false);
  assert.equal(element('image').width,129,'③ 栏不受影响');
  const html=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
  assert.match(html,/<section class="panel mosaic-panel"><h2>雷达主视图（实波束地图 \+ GMTI \+ SAR 贴片）<\/h2>/);
  assert.ok(html.indexOf('<div class="panels">')<html.indexOf('<section class="panel mosaic-panel">'),'主视图在面板容器里');
  assert.ok(html.indexOf('<section class="panel mosaic-panel">')<html.indexOf('<section class="panel window-panel">'),'主视图是第一栏，其余三栏排在它后面');
  assert.match(html,/<input id="mosaicFollow" type="checkbox" checked>跟随本机居中/);
  assert.match(html,/<input id="mosaicFade" type="checkbox" checked>旧图变淡/);
  assert.match(html,/<canvas id="mosaic" width="960" height="640">/);
  assert.match(html,/<p id="mosaicInfo" class="hint">等待拼接数据/);
  assert.match(html,/\.mosaic-panel\{grid-column:1\/-1;/);
  assert.match(html,/<button id="radarStart" disabled>开始雷达监视<\/button>/);
  assert.match(html,/<button id="radarStop" disabled>停止雷达监视<\/button>/);
  assert.match(html,/<p id="radarStatus" class="hint">雷达监视未启动/);
  assert.match(html,/<button id="designateDetail" disabled>SAR 精看 128 m<\/button> <button id="designateArea" disabled>SAR 区域 512 m<\/button> <button id="designateDbs" disabled>DBS 放大 512 m<\/button> <button id="addTarget" disabled>加入目标清单<\/button>/);
  assert.match(html,/<p id="designationInfo"/);assert.match(html,/<p id="designateStatus"/);
  assert.doesNotMatch(html,/id="captureDetail"|id="selectionInfo"/,'旧的独立精看按钮已被主视图的指定工作流取代');
});

test('Mosaic follows ownship, draws its track and pans or zooms without new requests',async()=>{
  const entry=mosaicEntry(1,{center:[500,0,1500]});
  const ownship={pos:[500,1200,1500],t:10,age_s:1.2,heading_deg:90,speed_mps:200,track:[[480,1480],[500,1500]]};
  const {sandbox,element,contexts,requests}=await load(129,{},{},{
    state:{mosaic:mosaicPayload({count:1,latestSeq:1,incremental:false,entries:[entry]}),ownship},
    images:{1:mosaicTile(entry,-40)}});
  assert.deepEqual([sandbox.mosaic.view.x,sandbox.mosaic.view.z],[500,1500],'跟随本机居中');
  sandbox.mosaic.view.scale=1;
  const calls=contexts.get('mosaic').calls,start=calls.length;
  sandbox.mosaicDraw();
  const drawn=calls.slice(start),at=(op,x,y)=>drawn.some(call=>call.op===op&&call.x===x&&call.y===y);
  assert.ok(at('moveTo',140,80)&&drawn.some(call=>call.op==='lineTo'&&call.x===160&&call.y===100),'航迹折线贴在世界坐标上');
  assert.ok(at('moveTo',171,100),'航向 90°（东）时机头朝右');
  assert.ok(at('lineTo',153,106)&&at('lineTo',153,94),'机头两侧尾翼');
  assert.ok(drawn.some(call=>call.op==='fillText'&&call.text==='200 m'),'比例尺标注');
  const count=requests.length;
  element('mosaic').onpointerdown({currentTarget:element('mosaic'),pointerId:7,clientX:256,clientY:256});
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:7,clientX:320,clientY:256});
  assert.equal(sandbox.mosaic.follow,false);assert.equal(element('mosaicFollow').checked,false,'拖动改为自由查看');
  assert.equal(sandbox.mosaic.view.x,460);assert.equal(sandbox.mosaic.view.z,1500);
  element('mosaic').onpointerup({currentTarget:element('mosaic'),pointerId:7});
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:7,clientX:100,clientY:100});
  assert.equal(sandbox.mosaic.view.x,460,'松开后不再平移');
  element('mosaic').onwheel({currentTarget:element('mosaic'),clientX:256,clientY:256,deltaY:-100});
  assert.equal(sandbox.mosaic.view.scale,1.2);assert.equal(sandbox.mosaic.view.x,460,'以光标为中心缩放，中心不动');
  element('mosaicFit').onclick();
  assert.equal(sandbox.mosaic.view.x,500);assert.equal(sandbox.mosaic.view.z,1500);
  assert.ok(sandbox.mosaic.view.scale*129<=200*.91,'适应全部图像：整批留在画布内');
  assert.equal(element('mosaicFit').disabled,false);
  assert.equal(requests.length,count,'交互不请求服务端');
});

test('Mosaic keeps the current window when the service answers a full state again',async()=>{
  const entry=mosaicEntry(2,{center:[1024,0,2048]});
  const {sandbox,element}=await load(129,{},{},{state:{mosaic:mosaicPayload({limit:50,count:1,firstSeq:2,latestSeq:2,incremental:false,entries:[entry]})},images:{2:mosaicTile(entry,-40)}});
  assert.equal(sandbox.mosaic.limit,50);assert.equal(sandbox.mosaic.first,2);assert.equal(element('mosaicFit').disabled,false);
  assert.match(element('mosaicInfo').textContent,/已贴入 1 \/ 本地保留 1 张/);assert.match(element('mosaicInfo').textContent,/跟随本机居中/);
  sandbox.mosaic.follow=false;element('mosaicFollow').checked=false;element('mosaicFollow').onchange();
  assert.match(element('mosaicInfo').textContent,/自由查看/);
  element('mosaicFade').checked=false;element('mosaicFade').onchange();
  assert.equal(sandbox.mosaic.fade,false);
});

// ---- 广域扫掠：服务端在 /state 的 continuous 里给 mode/sweepPlan/sweepIndex ----
const sweepCell=(overrides={})=>({center:[1000,50,2000],bearing:0,size_m:SIZE,side:1,rangeM:20000,status:'pending',...overrides});
const sweepCells=(count,step=200)=>Array.from({length:count},(_,i)=>sweepCell({center:[1000+step*i,50,2000]}));
const sweepShape=cells=>Array.from(cells,cell=>`${cell.index}:${cell.status}`);

test('Sweep plan boxes follow center/bearing/size_m and leave the cells that already have an image alone',async()=>{
  const plan=[sweepCell(),sweepCell({center:[1200,50,2000]}),sweepCell({center:[1400,50,2000],status:'done'}),sweepCell({center:[1600,50,2000],status:'skipped'})];
  const entry=mosaicEntry(1);
  const {sandbox,element,contexts}=await load(129,{mode:'live',continuous:{enabled:true,mode:'sweep',side:1,range:20000,record:false,completed:1,note:'正在采集第 2 张',sweepIndex:0,sweepPlan:plan}},
    {},{state:{mosaic:mosaicPayload({count:1,latestSeq:1,incremental:false,entries:[entry]})},images:{1:mosaicTile(entry,-40)}});
  // 与贴图同一换算：bearing 0 时 cross 沿 −z、ground 沿 +x，方框边长 128 m。
  assert.deepEqual(Array.from(sandbox.sweepCellCorners(sweepCell()),point=>Array.from(point)),[[936,2064],[936,1936],[1064,1936],[1064,2064]]);
  const diamond=sandbox.sweepCellCorners({center:[0,0,0],bearing:Math.PI/4,size_m:SIZE});
  assert.ok(Math.abs(diamond[0][0]+64*Math.SQRT2)<1e-9&&Math.abs(diamond[0][1])<1e-9,'方框随 bearing 旋转');
  assert.ok(Math.abs(diamond[2][0]-64*Math.SQRT2)<1e-9&&Math.abs(diamond[2][1])<1e-9);
  assert.equal(sandbox.sweepOverlayCells(plan,new Map([[3,{at:Date.now()}]]),0,Date.now()).length,3,'done 不画，其余三个都在');
  assert.match(element('sweepInfo').textContent,/本圈计划 4 格：待拍 1、正在拍 1、已完成 1、已跳过 1/);
  sandbox.mosaic.follow=false;sandbox.mosaic.fade=false;sandbox.mosaic.view={x:1300,z:2000,scale:.5};
  const calls=contexts.get('mosaic').calls,start=calls.length;
  sandbox.mosaicDraw();
  const drawn=calls.slice(start),strokes=drawn.filter(call=>call.op==='stroke');
  const colorOf=status=>sandbox.sweepStyle(status).color;
  const strokeCount=color=>strokes.filter(call=>call.strokeStyle===color).length;
  const at=(op,x,y)=>drawn.some(call=>call.op===op&&call.x===x&&call.y===y);
  assert.equal(strokeCount(colorOf('capturing')),1,'在拍格一个高亮框');
  assert.equal(strokeCount(colorOf('pending')),1,'待拍格一个虚线框');
  assert.equal(strokeCount(colorOf('skipped')),2,'跳过格：框 + 红叉');
  assert.ok(at('moveTo',-22,132)&&at('lineTo',42,68),'在拍格（下标 0）');
  assert.ok(at('moveTo',78,132)&&at('lineTo',142,68),'待拍格（下标 1）');
  assert.ok(at('moveTo',278,132)&&at('lineTo',342,68),'跳过格（下标 3）');
  assert.ok(!at('moveTo',178,132),'已达成的格子不画框：图像已经在画布上');
  assert.ok(drawn.some(call=>call.op==='fillText'&&call.text==='第 1 格'),'在拍格标出计划序号');
  assert.ok(strokes.some(call=>call.dash?.length)&&strokes.some(call=>call.dash?.length===0),'待拍虚线、在拍实线');
  const pending=sandbox.sweepStyle('pending'),capturing=sandbox.sweepStyle('capturing');
  assert.notEqual(pending.color,capturing.color);assert.ok(capturing.lineWidth>pending.lineWidth);
  element('mosaicPlan').checked=false;element('mosaicPlan').onchange();
  assert.equal(sandbox.sweep.visible,false);
  assert.match(element('sweepInfo').textContent,/计划格轮廓已隐藏/);
  const off=calls.length;sandbox.mosaicDraw();
  const planColors=new Set(['pending','capturing','skipped'].map(colorOf));
  assert.equal(calls.slice(off).filter(call=>call.op==='stroke'&&planColors.has(call.strokeStyle)).length,0,'关掉开关后不画计划格');
  element('mosaicPlan').checked=true;element('mosaicPlan').onchange();
  assert.equal(sandbox.sweep.visible,true);
  // 取景跟着画布上画的内容走：计划格纳入包围盒，关掉开关后回到只按图像取景。
  sandbox.sweepApplyState({mode:'sweep',sweepIndex:0,sweepPlan:[sweepCell({center:[9000,50,9000]})]});
  const withPlan=sandbox.mosaicFitView(320,200);
  assert.ok(withPlan.scale<1,'计划格把视野拉开，否则 20–30 km 外的格子永远在视野外');
  assert.ok((9000-withPlan.x)*withPlan.scale<=160&&(9000-withPlan.z)*withPlan.scale<=100,'格子仍在画布内');
  sandbox.sweepApplyState({mode:'sweep',sweepIndex:0,sweepPlan:[]});
  const withoutPlan=sandbox.mosaicFitView(320,200);
  assert.ok(withPlan.scale<withoutPlan.scale&&withoutPlan.x===0,'没有计划格时仍按图像取景');
  element('mosaicPlan').checked=false;element('mosaicPlan').onchange();
  sandbox.sweepApplyState({mode:'sweep',sweepIndex:0,sweepPlan:[sweepCell({center:[9000,50,9000]})]});
  assert.equal(sandbox.mosaicFitView(320,200).scale,withoutPlan.scale,'隐藏的格子不参与取景');
  element('mosaicPlan').checked=true;element('mosaicPlan').onchange();
  const html=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
  assert.match(html,/<input id="mosaicPlan" type="checkbox" checked>显示扫掠计划格/);
  assert.match(html,/<p id="sweepInfo" class="hint"><\/p>/);
});

test('Sweep overlay keeps done cells off the canvas and marks skipped cells only briefly',async()=>{
  const {sandbox}=await load(65);
  const plan=[sweepCell({status:'skipped'}),sweepCell({center:[1200,50,2000],status:'done'}),sweepCell({center:[1400,50,2000]}),sweepCell({center:[1600,50,2000],status:'capturing'})];
  const now=Date.now();
  assert.deepEqual(sweepShape(sandbox.sweepOverlayCells(plan,new Map([[0,{at:now}]]),2,now)),['0:skipped','2:capturing','3:capturing'],'sweepIndex 让待拍格显示为在拍，done 不出现');
  assert.deepEqual(sweepShape(sandbox.sweepOverlayCells(plan,new Map([[0,{at:now-1000}]]),null,now)),['0:skipped','2:pending','3:capturing'],'刚跳过的格子仍在标记时间内');
  assert.deepEqual(sweepShape(sandbox.sweepOverlayCells(plan,new Map([[0,{at:now-5000}]]),null,now)),['2:pending','3:capturing'],'标记过期后消失，不长期占用画面');
  assert.deepEqual(sweepShape(sandbox.sweepOverlayCells(plan,new Map(),null,now)),['2:pending','3:capturing'],'没有标记的跳过格不画');
  const broken=[sweepCell({status:'pending'}),{center:[1,0,0],bearing:NaN,size_m:0,status:'pending'},{center:'x',bearing:0,size_m:SIZE,status:'pending'}];
  assert.deepEqual(sweepShape(sandbox.sweepOverlayCells(broken,new Map(),null,now)),['0:pending'],'缺字段的计划格直接跳过');
  assert.deepEqual(sweepShape(sandbox.sweepOverlayCells(null,new Map(),null,now)),[]);
});

test('Sweep marks are timed once per skip event and the mode falls back without sweep fields',async()=>{
  const {sandbox}=await load(65);
  const skipped=sweepCell({status:'skipped'});
  const apply=cell=>sandbox.sweepApplyState({mode:'sweep',sweepIndex:0,sweepPlan:[cell]});
  apply(skipped);
  const mark=sandbox.sweep.marks.get(0);
  assert.ok(mark&&Number.isFinite(mark.at));
  assert.deepEqual([sandbox.sweep.mode,sandbox.sweep.modeKnown,sandbox.sweep.index,sandbox.sweep.plan.length],['sweep',true,0,1]);
  apply({...skipped});
  assert.equal(sandbox.sweep.marks.get(0),mark,'同一格持续跳过不刷新标记时间');
  apply({...skipped,center:[5000,50,5000]});
  assert.notEqual(sandbox.sweep.marks.get(0),mark,'换了格子重新计时');
  apply({...skipped,center:[5000,50,5000],status:'pending'});
  assert.equal(sandbox.sweep.marks.has(0),false,'不再跳过就不再标记');
  sandbox.sweepApplyState({sweepPlan:[sweepCell()]});
  assert.equal(sandbox.sweep.mode,'sweep','有计划但没有 mode 字段时按广域扫掠显示');
  sandbox.sweepApplyState({mode:'relative',sweepIndex:0,sweepPlan:[sweepCell()]});
  assert.equal(sandbox.sweep.mode,'relative','明确的 mode 优先');
  sandbox.sweepApplyState({sweepPlan:[]});
  assert.deepEqual([sandbox.sweep.mode,sandbox.sweep.modeKnown,sandbox.sweep.plan.length],['relative',false,0]);
  sandbox.sweepApplyState(undefined);
  assert.deepEqual([sandbox.sweep.plan.length,sandbox.sweep.index,sandbox.sweep.modeKnown],[0,null,false]);
});

test('Sweep mode is selectable, travels with the start request and reports the cell in progress',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','tools','sar_viewer.html'),'utf8');
  assert.match(html,/<select id="continuousMode"><option value="relative">相对单点/);
  assert.match(html,/<option value="sweep">广域扫掠/);
  const idle=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动',mode:'sweep'}});
  assert.equal(idle.element('continuousMode').disabled,false);
  assert.match(idle.element('continuousStatus').textContent,/连续采集未运行/);
  idle.element('continuousMode').value='sweep';
  await idle.element('continuousStart').onclick();
  assert.equal(idle.requests.at(-1).url,'/continuous/start');
  assert.equal(JSON.parse(idle.requests.at(-1).options.body).mode,'sweep');
  idle.element('continuousMode').value='relative';
  await idle.element('continuousStart').onclick();
  assert.equal(JSON.parse(idle.requests.at(-1).options.body).mode,'relative');
  const running=await load(129,{mode:'live',continuous:{enabled:true,mode:'sweep',side:0,range:30000,record:true,completed:2,note:'正在采集第 3 张',sweepIndex:2,sweepPlan:sweepCells(18)}});
  assert.equal(running.element('continuousMode').value,'sweep');
  assert.equal(running.element('continuousMode').disabled,true,'运行时锁定模式');
  assert.equal(running.element('side').value,'1','side=0（左右交替）不清空下拉框');
  const text=running.element('continuousStatus').textContent;
  assert.match(text,/连续采集已开启 · 已完成 2 张 · 正在采集第 3 张 · 广域扫掠 第 3\/18 格/);
  assert.match(text,/右侧 · 地距 20\.0 km · 原始数据保存开启/);
  assert.equal(running.sandbox.sweep.index,2);
  assert.match(running.element('sweepInfo').textContent,/本圈计划 18 格/);
  const relative=await load(129,{mode:'live',continuous:{enabled:true,mode:'relative',side:1,range:20000,record:false,completed:5,note:'本张完成'}});
  assert.match(relative.element('continuousStatus').textContent,/· 相对单点 · 右侧 45° \/ 20 km/);
  assert.equal(relative.sandbox.sweep.plan.length,0);
});

test('Sweep display degrades without the fields, and a plan arriving later shows up on its own',async()=>{
  const legacy=await load(129,{mode:'live',canStartContinuous:true},{},{states:[
    {continuous:{enabled:false,completed:0,note:'未启动'}},
    {continuous:{enabled:true,side:1,range:20000,record:false,completed:0,note:'等待连接'}}]});
  assert.equal(legacy.sandbox.sweep.modeKnown,false);
  assert.equal(legacy.sandbox.sweep.plan.length,0);
  assert.equal(legacy.element('sweepInfo').textContent,'','旧服务端不显示计划格说明');
  assert.equal(legacy.element('continuousStatus').textContent,'连续采集未运行 · 已完成 0 张 · 未启动');
  legacy.element('continuousMode').value='sweep';
  await legacy.element('continuousStart').onclick();
  assert.equal(JSON.parse(legacy.requests.at(-1).options.body).mode,'sweep','未知字段照发，旧服务端忽略它');
  await legacy.pump();
  const started=legacy.element('continuousStatus').textContent;
  assert.match(started,/连续采集已开启 · 已完成 0 张 · 等待连接 · 右侧 45° \/ 20 km · 未开启持续录制/,'旧服务端的运行状态行保持原样');
  assert.match(started,/服务端未报告扫掠模式/,'选了广域扫掠但服务端没有该字段时明说，而不是静默按单点采集');
  const states=[{continuous:{enabled:true,mode:'sweep',side:1,range:20000,record:false,completed:0,note:'等待采集'}},
    {continuous:{enabled:true,mode:'sweep',side:1,range:20000,record:false,completed:0,note:'等待采集',sweepIndex:0,sweepPlan:[sweepCell()]}}];
  const late=await load(129,{mode:'live'},{},{states});
  assert.match(late.element('continuousStatus').textContent,/广域扫掠：等待计划/);
  assert.equal(late.element('sweepInfo').textContent,'');
  assert.equal(late.sandbox.sweep.plan.length,0);
  await late.pump();
  assert.equal(late.sandbox.sweep.plan.length,1);
  assert.match(late.element('continuousStatus').textContent,/广域扫掠 第 1\/1 格/);
  assert.match(late.element('sweepInfo').textContent,/本圈计划 1 格：待拍 0、正在拍 1、已完成 0、已跳过 0/);
  assert.equal(late.requests.filter(request=>request.url.startsWith('/image/')).length,0,'计划不产生额外的矩阵请求');
});

// ---- MAP 实波束底图：continuous.mode==='map'，实时进度在 /state 的 map 段 ------------------
// MAP 不聚焦成像，服务端启动时把 quality/footprint 写成 'map'、window/focuser 写成 'real-beam'，
// 这些占位值在下拉框里不存在，页面必须自己管住这四项并只从 map 段取进度。
const mapContinuous=overrides=>({enabled:true,mode:'map',side:1,range:18000,record:false,quality:'map',window:'real-beam',
  focuser:'real-beam',footprint:'map',sceneModel:'classified',completed:0,note:'等待地图采集',...overrides});
const mapSummary=overrides=>({active:true,continuous:true,note:'底图第 3 帧：覆盖 78%（11420/14641 格），渲染 63 ms',
  frames:3,jobs:5,failures:0,cells:11420,surfaces:9000,coverage:.78,window:{center:[1000,2000],cells:121,ix0:2,iz0:2},
  lastFrame:{seq:7,completed:1,fraction:.78,compute_ms:63},progress:'地图 1204/14641',reason:null,supported:true,
  params:{span:30000,cell:250,side:1,angle:45,range:18000,beam:3,looks:1,stc:true},pose:null,track:null,...overrides});

test('MAP mode disables every control the forward sector cannot use and starts without side/range',async()=>{
  assert.match(viewerHtml,/<option value="map">MAP 底图：实波束粗扫大范围（滚动跟随）<\/option>/,'连续模式下拉的第三项');
  const unused=['footprint','sceneModel','focuser','quality','side','range'];  // 扇形没有侧向，半径也不是「地距」那个量
  const idle=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动',mode:'relative'}});
  for(const id of unused)assert.equal(idle.element(id).disabled,false,`未选 MAP 时 ${id} 保持可用`);
  assert.equal(idle.element('modeInfo').textContent,'');
  idle.element('continuousMode').value='map';idle.element('continuousMode').onchange();
  for(const id of unused)assert.equal(idle.element(id).disabled,true,`选 MAP 后 ${id} 禁用`);
  for(const id of ['window','recordContinuous','continuousMode','preset'])
    assert.equal(idle.element(id).disabled,false,`${id} 不受 MAP 影响`);
  assert.match(idle.element('modeInfo').textContent,/前向扇形/);
  assert.match(idle.element('modeInfo').textContent,/没有侧向与地距/);
  // 「地距」控件留给单次采集与另两种连续模式：MAP 起拍命令不带 side/range，扇形口径由服务端默认给出。
  idle.element('side').value='-1';idle.element('range').value='25';
  await idle.element('continuousStart').onclick();
  assert.equal(idle.requests.at(-1).url,'/continuous/start');
  const body=JSON.parse(idle.requests.at(-1).options.body);
  assert.equal(body.mode,'map');assert.equal(body.record,false);
  assert.deepEqual(Object.keys(body).sort(),['focuser','footprint','mode','quality','record','sceneModel','window'],'MAP 的起拍命令只带模式与录制，其余是 MAP 分支不读的占位成像字段');
  // 预设不变：广域快扫仍是扫掠，套用后模式换回 sweep，这六项重新可用。
  idle.element('preset').value='wide';idle.element('preset').onchange();
  assert.equal(idle.element('continuousMode').value,'sweep');
  for(const id of unused)assert.equal(idle.element(id).disabled,false,'模式换回扫掠后恢复可用');
  assert.equal(idle.element('modeInfo').textContent,'');
});

test('MAP status line reports frames, sector aperture, coverage and the cells being collected',async()=>{
  const running=await load(129,{mode:'live',continuous:mapContinuous(),map:mapSummary()});
  assert.equal(running.sandbox.sweep.mode,'map');
  assert.equal(running.element('continuousStatus').textContent,
    '连续采集已开启 · MAP 底图：已渲染 3 帧 · 窗口覆盖 78% · 采集中 1204/14641 格 · 底图第 3 帧：覆盖 78%（11420/14641 格），渲染 63 ms · 未开启持续录制');
  assert.equal(running.element('continuousMode').value,'map');assert.equal(running.element('continuousMode').disabled,true);
  for(const id of ['footprint','sceneModel','focuser','quality','side','range'])assert.equal(running.element(id).disabled,true);
  assert.deepEqual(['quality','window','focuser','footprint','sceneModel','side','range'].map(id=>running.element(id).value),
    ['standard','hann','backprojection','detail','classified','1','20'],'MAP 的占位值不回填控件，侧向与地距是扇形用不到的项也不回填');
  assert.equal(running.element('sweepInfo').textContent,'','MAP 没有计划格，④ 栏说明保持空白');
  // 底图会话停在空中（保留已出帧）：进度仍按覆盖率还原格数，笔记换成服务端的停止说明。
  const stopped=await load(129,{mode:'live',continuous:mapContinuous({enabled:false,note:'已停止'}),
    map:mapSummary({active:false,continuous:false,note:'已停止地图采集，保留已采集格与拼接层图像',progress:null,frames:3,window:{cells:121}})});
  assert.equal(stopped.element('continuousStatus').textContent,
    '连续采集未运行 · MAP 底图：已渲染 3 帧 · 窗口覆盖 78% · 采集中 11420/14641 格 · 已停止地图采集，保留已采集格与拼接层图像');
  // 段内各字段独立降级：没有 A/B 进度就不编造格数，连窗口都不知道时报世界栅格总数。
  const {sandbox}=await load(65);
  assert.equal(sandbox.mapStatusText({frames:3,coverage:.78,progress:'地图 1204/14641',window:{cells:121}}),'MAP 底图：已渲染 3 帧 · 窗口覆盖 78% · 采集中 1204/14641 格');
  assert.equal(sandbox.mapStatusText({frames:0,coverage:0,progress:'地图 121×121 等待地形',window:null}),'MAP 底图：已渲染 0 帧 · 窗口覆盖 0%');
  assert.equal(sandbox.mapStatusText({frames:2,cells:5000}),'MAP 底图：已渲染 2 帧 · 已采集 5000 格');
  assert.equal(sandbox.mapStatusText(undefined),'');
  // 新服务端按扇形报口径：窗口那一套（span/angle/side）之外多出 window.sector{heading_deg, azimuth_deg, range_m}。
  // 有扇区就说「扇区口径」与「扇区覆盖」，且不再拿外接方窗的格数去乘扇区覆盖率（那会把扇区外的空格算进去）。
  const sectorSummary=mapSummary({coverage:.65,progress:null,window:{cells:201,sector:{heading_deg:90,azimuth_deg:60,range_m:20000}}});
  assert.equal(sandbox.mapStatusText(sectorSummary),'MAP 底图：已渲染 3 帧 · 扇区 ±60°、半径 20.0 km · 扇区覆盖 65% · 已采集 11420 格');
  assert.equal(sandbox.mapSectorText({window:{sector:{azimuth_deg:30,range_m:25000}}}),'扇区 ±30°、半径 25.0 km');
  assert.equal(sandbox.mapSectorText({window:{sector:{range_m:25000}}}),'半径 25.0 km','只报半径时报半径，不编造张角');
  assert.equal(sandbox.mapSectorText({window:{sector:{azimuth_deg:30}}}),'扇区 ±30°','只报张角时报张角');
  assert.equal(sandbox.mapSectorText(mapSummary()),'','旧口径的 params.angle/range 不是扇区半宽与外半径，不能拿来充数');
  assert.equal(sandbox.mapSectorInfo(sectorSummary).headingDeg,90);
});

test('主视图按 window.sector 画出当前扫描扇形：圆心取 MAP 会话位姿，两边线加外半径弧',async()=>{
  const sector={heading_deg:170,azimuth_deg:60,range_m:20000};
  const anchored=window_=>({...mapSummary(),pose:{pos:[1000,1200,2000],heading_deg:170,age_s:.5},window:{center:[1000,2000],cells:161,ix0:2,iz0:2,...window_}});
  const chart=await load(129,{mode:'live',continuous:mapContinuous(),map:anchored({sector})});
  chart.sandbox.mosaic.view={x:1000,z:2000,scale:.02};
  const calls=chart.element('mosaic').getContext('2d').calls,start=calls.length;
  chart.sandbox.mosaicDraw();
  const drawn=calls.slice(start);
  // 扇形轮廓自成一条路径：找到那次描边并回溯到它自己的 beginPath，后面就是它的 moveTo/lineTo 序列。
  const strokeAt=drawn.findIndex(call=>call.op==='stroke'&&call.strokeStyle==='rgba(122,196,255,.55)');
  assert.ok(strokeAt>0,'扇形轮廓要画出来');
  assert.equal(drawn.filter(call=>call.op==='stroke'&&call.strokeStyle==='rgba(122,196,255,.55)').length,1,'一次描边');
  let beginAt=strokeAt-1;while(beginAt>=0&&drawn[beginAt].op!=='beginPath')beginAt--;
  const path=drawn.slice(beginAt+1,strokeAt);
  const moves=path.filter(call=>call.op==='moveTo'),lines=path.filter(call=>call.op==='lineTo');
  const at=(list,x,y)=>list.some(call=>Math.abs(call.x-x)<1e-9&&Math.abs(call.y-y)<1e-9);
  const point=angle=>chart.sandbox.mosaicWorldToScreen(chart.sandbox.mosaic.view,320,200,1000+Math.sin(angle)*20000,2000+Math.cos(angle)*20000);
  const right=point((170-60)*Math.PI/180),left=point((170+60)*Math.PI/180),ahead=point(170*Math.PI/180);
  // 圆心是 MAP 会话自己的位姿 [1000,1200,2000]（不是本机符号），半径 20 km、航向 170°、半张角 60°。
  assert.ok(at(moves,160,100),'圆心落在 MAP 会话位姿 (1000,2000)');
  assert.ok(at(lines,right.x,right.y)&&at(lines,left.x,left.y),'两条边线画到 ±60° 的边界');
  assert.equal(moves.length,3,'三次起笔：两条边线各回圆心一次，加弧的起点');
  assert.equal(lines.length,2+64,'两条边线 + 64 段外半径弧');
  assert.ok(at(lines,ahead.x,ahead.y),'外半径弧经过机头正前方（航向 170°）');
  assert.ok(drawn.slice(strokeAt).some(call=>call.op==='arc'&&Math.abs(call.x-160)<1e-9&&Math.abs(call.y-100)<1e-9&&call.r===2.5),'圆心点标在锚点处');
  // 本机符号也在画布上时，扇形仍以 MAP 锚点为准：航向 90° 与锚点航向 170° 差 80°，不会重合。
  const withOwn=await load(129,{mode:'live',continuous:mapContinuous(),map:anchored({sector})},{},{state:{mosaic:mosaicPayload({count:0,latestSeq:0,incremental:false,entries:[]}),ownship:{pos:[-5000,800,-5000],heading_deg:90}}});
  withOwn.sandbox.mosaic.view={x:1000,z:2000,scale:.02};withOwn.sandbox.mosaic.follow=false;
  const ownCalls=withOwn.element('mosaic').getContext('2d').calls,ownStart=ownCalls.length;
  withOwn.sandbox.mosaicDraw();
  const ownDrawn=ownCalls.slice(ownStart);
  const ownStroke=ownDrawn.findIndex(call=>call.op==='stroke'&&call.strokeStyle==='rgba(122,196,255,.55)');
  assert.ok(ownStroke>0,'扇形仍要画');
  let ownBegin=ownStroke-1;while(ownBegin>=0&&ownDrawn[ownBegin].op!=='beginPath')ownBegin--;
  assert.ok(ownDrawn.slice(ownBegin+1,ownStroke).some(call=>call.op==='moveTo'&&Math.abs(call.x-160)<1e-9&&Math.abs(call.y-100)<1e-9),'锚点在 MAP 会话位姿，不跟本机符号跑');
  // 没有 window.sector（旧服务端）或没有航向时，宁可不画也不编造一个扇形。
  const legacy=await load(129,{mode:'live',continuous:mapContinuous(),map:mapSummary()});
  legacy.sandbox.mosaic.view={x:1000,z:2000,scale:.02};
  const legacyCalls=legacy.element('mosaic').getContext('2d').calls,legacyStart=legacyCalls.length;
  legacy.sandbox.mosaicDraw();
  assert.equal(legacyCalls.slice(legacyStart).filter(call=>call.op==='stroke'&&call.strokeStyle==='rgba(122,196,255,.55)').length,0,'旧口径没有扇区可画');
  const bare=await load(129,{mode:'live',continuous:mapContinuous(),map:mapSummary({window:{cells:161,ix0:2,iz0:2},pose:null,params:{range_m:20000,azimuth_deg:60}})});
  bare.sandbox.mosaic.view={x:1000,z:2000,scale:.02};
  const bareCalls=bare.element('mosaic').getContext('2d').calls,bareStart=bareCalls.length;
  bare.sandbox.mosaicDraw();
  assert.equal(bareCalls.slice(bareStart).filter(call=>call.op==='stroke'&&call.strokeStyle==='rgba(122,196,255,.55)').length,0,'只有半径与张角、没有航向就没有扇形');
});

// ---- SAR 可成像区叠加层与两个叠加开关 --------------------------------------------------------
const sarWindowColor='rgba(120,214,160,.5)';
test('SAR 可成像区画成航迹两侧的环扇形：±20–160°、1–50 km，开关与说明行跟着走',async()=>{
  assert.match(viewerHtml,/<input id="mosaicSector" type="checkbox" checked>显示底图扇形轮廓/);
  assert.match(viewerHtml,/<input id="mosaicSar" type="checkbox" checked>显示 SAR 可成像区/);
  assert.match(viewerHtml,/<p id="sectorInfo" class="hint"><\/p>/);
  const entry=mosaicEntry(1);
  const summary={...mapSummary(),window:{center:[0,0],cells:161,ix0:0,iz0:0,sector:{heading_deg:90,azimuth_deg:60,range_m:20000}},pose:{pos:[0,1000,0],heading_deg:90}};
  // 窗口只有一个来源：服务端在 /state.imageWindow 里给出它实际执行的 20–160° / 1–50 km。
  const {element,sandbox,contexts}=await load(129,{mode:'live',continuous:mapContinuous(),map:summary,
    imageWindow:{min_angle_deg:20,max_angle_deg:160,min_range_m:1000,max_range_m:50000}},{},
    {state:{mosaic:mosaicPayload({count:1,latestSeq:1,incremental:false,entries:[entry]}),ownship:{pos:[0,1000,0],heading_deg:90,age_s:.2}},images:{1:mosaicTile(entry,-40)}});
  sandbox.mosaic.follow=false;sandbox.mosaic.view={x:0,z:0,scale:.01};
  const calls=contexts.get('mosaic').calls,start=calls.length;
  sandbox.mosaicDraw();
  const drawn=calls.slice(start),moves=drawn.filter(call=>call.op==='moveTo');
  const near=(call,x,y)=>Math.abs(call.x-x)<1e-6&&Math.abs(call.y-y)<1e-6;
  const point=(deg,radius)=>{const a=deg*Math.PI/180;return {x:Math.sin(a)*radius*.01+160,y:Math.cos(a)*radius*.01+100};};
  assert.equal(drawn.filter(call=>call.op==='stroke'&&call.strokeStyle===sarWindowColor).length,2,'航迹左右各一条环扇形');
  // 航向 90°（东）：右耳覆盖世界 110°…250°（=航迹右侧 20°…160°），左耳覆盖 −70°…70°（=左侧 20°…160°）；
  // 环扇形的第一条折线从外半径的起始边开始，两条耳各 48 段外弧 + 48 段内弧。
  assert.ok(moves.some(call=>near(call,point(110,50000).x,point(110,50000).y)),'右耳外弧起于航迹右 20°、半径 50 km');
  assert.ok(moves.some(call=>near(call,point(-70,50000).x,point(-70,50000).y)),'左耳外弧起于航迹左 160°');
  assert.ok(drawn.some(call=>call.op==='lineTo'&&near(call,point(110,1000).x,point(110,1000).y)),'内弧收到 1 km（近距盲区之外）');
  assert.ok(drawn.some(call=>call.op==='fillText'&&call.text==='SAR 可成像区 ±20–160°'));
  assert.match(element('sectorInfo').textContent,/底图扇形：±60° \/ 半径 20\.0 km · 圆心 0 \/ 0 m · 航向 90°/);
  assert.match(element('sectorInfo').textContent,/扇区外与未采集的像元不绘制/);
  assert.match(element('sectorInfo').textContent,/SAR 可成像区：航迹左右各 20–160°、地距 1–50 km 的环扇形/);
  // 关掉开关只影响那一层：说明行改口说已隐藏，画布上不再出现它的颜色。
  element('mosaicSar').checked=false;element('mosaicSar').onchange();
  const off=calls.length;sandbox.mosaicDraw();
  assert.equal(calls.slice(off).filter(call=>call.op==='stroke'&&call.strokeStyle===sarWindowColor).length,0);
  assert.match(element('sectorInfo').textContent,/SAR 可成像区已隐藏（勾选“显示 SAR 可成像区”重新显示）/);
  element('mosaicSector').checked=false;element('mosaicSector').onchange();
  const off2=calls.length;sandbox.mosaicDraw();
  assert.equal(calls.slice(off2).filter(call=>call.op==='stroke'&&call.strokeStyle==='rgba(122,196,255,.55)').length,0,'关掉扇形轮廓开关后底图扇形也不画');
  assert.match(element('sectorInfo').textContent,/底图扇形轮廓已隐藏（勾选“显示底图扇形轮廓”重新显示）/);
  // 没有本机位姿就没有“相对航迹”的两侧可言：宁可少画一层，也不拿猜测的角度凑一个环扇形。
  const bare=await load(129,{mode:'live',continuous:mapContinuous(),map:summary});
  bare.sandbox.mosaic.follow=false;bare.sandbox.mosaic.view={x:0,z:0,scale:.01};
  const bareCalls=bare.element('mosaic').getContext('2d').calls,bareStart=bareCalls.length;
  bare.sandbox.mosaicDraw();
  assert.equal(bareCalls.slice(bareStart).filter(call=>call.op==='stroke'&&call.strokeStyle===sarWindowColor).length,0);
  assert.doesNotMatch(bare.element('sectorInfo').textContent,/SAR 可成像区：航迹左右各/,'没有本机位姿时不描述画不出来的那一层');
});

test('两个叠加开关与其它主视图开关一起记住',async()=>{
  const storage=memoryStorage();
  const first=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}},{localStorage:storage});
  first.element('mosaicSar').checked=false;first.element('mosaicSar').onchange();
  first.element('mosaicSector').checked=false;first.element('mosaicSector').onchange();
  const saved=JSON.parse(storage.getItem('sar-viewer/controls/1'));
  assert.deepEqual([saved.mosaicSector,saved.mosaicSar],[false,false]);
  const second=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}},{localStorage:storage});
  assert.equal(second.element('mosaicSar').checked,false);assert.equal(second.element('mosaicSector').checked,false);
  assert.equal(second.sandbox.mosaic.sarWindow,false,'勾选框与内部状态一起恢复');
  assert.equal(second.sandbox.mosaic.outline,false);
  const back=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}},{localStorage:memoryStorage({mosaicSector:true,mosaicSar:true})});
  assert.equal(back.sandbox.mosaic.outline,true);assert.equal(back.sandbox.mosaic.sarWindow,true);
});

test('A remembered MAP mode comes back with its controls disabled and follows a running MAP session',async()=>{
  const storage=memoryStorage({continuousMode:'map',side:'-1',range:'24'});
  const idle=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动',mode:'relative'}},{localStorage:storage});
  assert.equal(idle.element('continuousMode').value,'map','存过的模式恢复后正常显示');
  assert.equal(idle.element('side').value,'-1');assert.equal(idle.element('range').value,'24');
  for(const id of ['footprint','sceneModel','focuser','quality'])assert.equal(idle.element(id).disabled,true);
  assert.match(idle.element('modeInfo').textContent,/已禁用/);
  const running=await load(129,{mode:'live',continuous:mapContinuous(),map:mapSummary({frames:0,coverage:0,cells:0,progress:null})},{localStorage:storage});
  assert.equal(running.element('continuousMode').value,'map');
  assert.equal(running.element('continuousMode').disabled,true,'运行中的 MAP 锁定模式下拉');
  assert.match(running.element('continuousStatus').textContent,/MAP 底图：已渲染 0 帧 · 窗口覆盖 0%/);
  const saved=JSON.parse(storage.getItem(storedKey));
  assert.equal(saved.continuousMode,'map');
  assert.equal(saved.quality,'standard','服务端的 quality:map 不会被存成空值或占位值');
});

// ---- 雷达主视图工作流：一键雷达监视、指定点判定、相对本机方位 ------------------------------------
test('主视图的一键雷达监视启动 MAP 底图巡逻，状态行复用 map 的帧数/覆盖/格数与 note',async()=>{
  const html=viewerHtml;
  assert.ok(html.indexOf('<div class="panels">')<html.indexOf('<section class="panel mosaic-panel">'),'主视图在面板容器里');
  assert.ok(html.indexOf('<section class="panel mosaic-panel">')<html.indexOf('<section class="panel window-panel">'),'主视图排在 ① 栏之前');
  const idle=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动',mode:'relative'}});
  assert.equal(idle.element('radarStart').disabled,false);assert.equal(idle.element('radarStop').disabled,true);
  assert.match(idle.element('radarStatus').textContent,/^雷达监视未启动/);
  idle.element('side').value='-1';idle.element('range').value='25';
  await idle.element('radarStart').onclick();
  const start=idle.requests.at(-1);
  assert.equal(start.url,'/continuous/start');
  assert.deepEqual(JSON.parse(start.options.body),{record:false,mode:'map',quality:'standard',window:'hann',footprint:'detail',sceneModel:'classified',focuser:'backprojection'},'扇形巡逻不带侧向与地距');
  assert.equal(idle.element('continuousMode').value,'map','一键入口把连续模式写成 MAP，控件禁用状态立刻跟上');
  for(const id of ['footprint','sceneModel','focuser','quality','side','range'])assert.equal(idle.element(id).disabled,true,'扇形用不到的六项立刻禁用');
  const running=await load(129,{mode:'live',continuous:mapContinuous(),map:mapSummary()});
  assert.equal(running.element('radarStart').disabled,true);assert.equal(running.element('radarStop').disabled,false);
  assert.equal(running.element('radarStatus').textContent,'雷达监视进行中 · MAP 底图：已渲染 3 帧 · 窗口覆盖 78% · 采集中 1204/14641 格 · 底图第 3 帧：覆盖 78%（11420/14641 格），渲染 63 ms · 可对指定点做 SAR 精看');
  await running.element('radarStop').onclick();
  assert.equal(running.requests.at(-1).url,'/continuous/stop');
  // 底图停在空中：帧数与覆盖保留，说明用服务端的停止 note。
  const stopped=await load(129,{mode:'live',continuous:mapContinuous({enabled:false,note:'已停止'}),
    map:mapSummary({active:false,continuous:false,note:'已停止地图采集，保留已采集格与拼接层图像',progress:null,frames:3,window:{cells:121}})});
  assert.equal(stopped.element('radarStatus').textContent,'雷达监视已停止，已出的底图帧仍留在画布上 · MAP 底图：已渲染 3 帧 · 窗口覆盖 78% · 采集中 11420/14641 格 · 已停止地图采集，保留已采集格与拼接层图像');
  // 跑着别的连续模式：明说底图没在跑，别让用户以为按钮没生效。
  const sweeping=await load(129,{mode:'live',continuous:{enabled:true,mode:'sweep',side:1,range:20000,record:false,completed:2,note:'正在采集第 3 张',sweepIndex:2,sweepPlan:sweepCells(18)}});
  assert.match(sweeping.element('radarStatus').textContent,/连续采集进行中（广域扫掠），MAP 底图未运行/);
  assert.equal(sweeping.element('radarStop').disabled,false,'停止按钮同样能停掉正在跑的连续采集');
  // 旧服务端完全不给 map 段：状态行只说没启动，不编造帧数。
  const plain=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}});
  assert.match(plain.element('radarStatus').textContent,/^雷达监视未启动：/);
});

test('指定点先问 /designate/check：不可成像列原因、劝告不阻断、无位姿与不接单都禁用按钮',async()=>{
  const anchor=mosaicEntry(1,{center:[1000,0,2000],target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  const tap=async(options={},overrides={})=>{
    const page=await load(129,{mode:'live',canCapture:true,...overrides},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[anchor]})},images:{1:mosaicTile(anchor,-40)},...options});
    page.sandbox.mosaic.view={x:1000,z:2000,scale:1};
    const event={currentTarget:page.element('mosaic'),pointerId:5,clientX:160*1.6,clientY:100*2.56};
    page.element('mosaic').onpointerdown(event);page.element('mosaic').onpointerup(event);
    await page.flush();return page;
  };
  // 几何不满足：reasons 逐条列出，两个 SAR 按钮都禁用（“大 X”的等价物就是这里的文字加禁用按钮）。
  const blocked=await tap({designate:{ok:false,reasons:['斜视角 8°（正右/负左），等待进入 20–160° 侧视窗口','地距 62.0 km 超出 1–50 km'],range_km:62,relative_track_deg:8,side:1,flightIssue:null}});
  assert.equal(blocked.element('designateDetail').disabled,true);assert.equal(blocked.element('designateArea').disabled,true);
  assert.equal(blocked.element('designateStatus').textContent,'不可成像：斜视角 8°（正右/负左），等待进入 20–160° 侧视窗口；地距 62.0 km 超出 1–50 km · 地距 62.0 km · 相对航迹 右 8° · 右侧');
  assert.equal(blocked.element('addTarget').disabled,false,'不能成像也允许先把点记进清单');
  // 飞行状态劝告只劝告：按钮照常可用，劝告写在判定后面。
  const advised=await tap({designate:{ok:true,flightIssue:'地面速度 512 m/s 超出 20–400 m/s'}});
  assert.equal(advised.element('designateDetail').disabled,false);assert.equal(advised.element('designateArea').disabled,false);
  assert.equal(advised.element('designateStatus').textContent,'可成像 · 地距 20.0 km · 相对航迹 右 45° · 右侧 · 飞行状态劝告：地面速度 512 m/s 超出 20–400 m/s（不阻断成像）');
  // 无位姿（409）：按服务端的 error 文案说，不编造几何数字。
  const posed=await tap({designate:{error:'No ownship pose; cannot assess geometry'}});
  assert.equal(posed.element('designateDetail').disabled,true);
  assert.equal(posed.element('designateStatus').textContent,'不可成像：No ownship pose; cannot assess geometry');
  // 旧服务端没有这个接口（404）：同样只是禁用并说明。
  const legacy=await tap({designate:{status:404,error:'Not found'}});
  assert.equal(legacy.element('designateStatus').textContent,'不可成像：Not found');
  // 几何可以、服务端却不接单（canCapture=false，例如 SAR 忙）：判定照显示，按钮不动并说明原因。
  const busy=await tap({designate:{}},{canCapture:false});
  assert.equal(busy.element('designateDetail').disabled,true);
  assert.equal(busy.element('designateStatus').textContent,'可成像 · 地距 20.0 km · 相对航迹 右 45° · 右侧 · 但服务端当前不能接单（SAR 忙、未在 MAP 巡逻或未连接），按钮暂不可按');
});

test('迟到的可成像性判定不会覆盖后一次选取的结论',async()=>{
  const anchor=mosaicEntry(1,{center:[1000,0,2000],target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  let late=null;
  const page=await load(129,{mode:'live',canCapture:true},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[anchor]})},images:{1:mosaicTile(anchor,-40)},
    designate:query=>query.get('x')==='1000.00'?new Promise(resolve=>{late=resolve;}):{ok:false,reasons:['第二次选取：几何不满足'],range_km:62,relative_track_deg:-8,side:-1}});
  page.sandbox.mosaic.view={x:1000,z:2000,scale:1};
  const click=canvasX=>{const event={currentTarget:page.element('mosaic'),pointerId:6,clientX:canvasX*1.6,clientY:100*2.56};
    page.element('mosaic').onpointerdown(event);page.element('mosaic').onpointerup(event);};
  click(160);  // 第一点：判定悬着不返回
  click(210);  // 第二点：立刻拿到结论
  await page.flush();
  assert.equal(page.sandbox.designation.point.worldX,1050);
  assert.equal(page.element('designateStatus').textContent,'不可成像：第二次选取：几何不满足 · 地距 62.0 km · 相对航迹 左 8° · 左侧');
  assert.equal(page.element('designateDetail').disabled,true);
  late({ok:true,reasons:[],range_km:20,relative_track_deg:45,side:1,flightIssue:null});  // 第一点的判定迟到
  await page.flush();
  assert.equal(page.element('designateStatus').textContent,'不可成像：第二次选取：几何不满足 · 地距 62.0 km · 相对航迹 左 8° · 左侧','过期结论被丢弃');
  assert.equal(page.element('designateDetail').disabled,true);
});

test('页面自算的相对本机航向按正右/负左（与 Export 的 TARGET 相对角同约定）',async()=>{
  const {sandbox,element,flush}=await load(65,{canCapture:true});
  sandbox.mosaic.own={pos:[0,0,0],heading_deg:90};  // 机头朝东（heading 90° = 世界 +x）
  const east=sandbox.ownshipRelative(0,3000),west=sandbox.ownshipRelative(0,-3000),ahead=sandbox.ownshipRelative(3000,0);
  assert.ok(Math.abs(east.rangeKm-3)<1e-9);assert.ok(Math.abs(east.angleDeg-90)<1e-9,'朝东时正南在右侧');
  assert.ok(Math.abs(west.angleDeg+90)<1e-9,'朝东时正北在左侧');
  assert.ok(Math.abs(ahead.angleDeg)<1e-9,'正前方 0°');
  sandbox.mosaic.own={pos:[0,0,0],heading_deg:180};  // 朝北（-z）：右侧是东
  const northbound=sandbox.ownshipRelative(3000,0);
  assert.ok(Math.abs(northbound.angleDeg-90)<1e-9);
  sandbox.designateWorldPoint(-3000,0,'主视图');
  assert.match(element('designationInfo').textContent,/· 距本机地距 3\.0 km · 相对本机航向 左 90°/,'机头朝北时正西在左侧');
  await flush();
  // 服务端的 /designate/check 结论原样显示（那一行是“相对航迹”，以最近一次采集的平均速度为准）。
  assert.equal(element('designateStatus').textContent,'可成像 · 地距 20.0 km · 相对航迹 右 45° · 右侧');
  assert.equal(element('designateDetail').disabled,false);
});

// ---- 座舱化交互：冻结、理论分辨率、目标点、GMTI 动目标 ---------------------------------------
test('Freeze pins panels ②③ on the frozen frame while ④ keeps taking new images',async()=>{
  assert.match(viewerHtml,/<button id="freezeToggle">冻结显示<\/button>/,'③ 栏有冻结按钮');
  const row=Array.from({length:129*129},(_,i)=>i<129?-40:0),dark=Array(129*129).fill(-40);
  const first=mosaicEntry(1),second=mosaicEntry(2,{center:[512,0,0]});
  const states=[
    {completed:1000,result:{width:129,size_m:SIZE,source:'dcs',db:row,power:row.map(v=>10**(v/10)),metadata:{window:'hann'}},
      mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[first]})},
    {completed:2000,result:{width:129,size_m:SIZE,source:'dcs',db:dark,power:dark.map(v=>10**(v/10)),metadata:{window:'hann'}},
      mosaic:mosaicPayload({count:2,firstSeq:1,latestSeq:2,incremental:true,entries:[second]})}];
  const {element,canvas,sandbox,pump}=await load(129,{},{},{states,images:{1:mosaicTile(first,-40),2:mosaicTile(second,0)}});
  const pinned=element('stamp').textContent;
  assert.equal(canvas.image.data[0],255);assert.equal(sandbox.freezeState().on,false);
  assert.equal(element('freezeToggle').textContent,'冻结显示');
  element('freezeToggle').onclick();
  assert.equal(sandbox.freezeState().on,true);assert.equal(element('freezeToggle').textContent,'解冻显示');
  assert.match(element('status').textContent,/已冻结显示/);
  assert.match(element('freezeInfo').textContent,/已冻结：②③ 停在/);
  await pump(); // 冻结期间服务端又完成一张
  assert.equal(canvas.image.data[0],255,'冻结后 ②③ 不重画');
  assert.equal(element('stamp').textContent,pinned,'说明行仍描述冻结那张');
  assert.match(element('freezeInfo').textContent,/服务端已有更新的一张待解冻显示/);
  assert.equal(sandbox.mosaic.images.size,2,'④ 拼接层照常收新图');
  assert.match(element('mosaicInfo').textContent,/已贴入 2 \/ 本地保留 2 张/);
  assert.match(element('status').textContent,/已冻结显示/);
  element('freezeToggle').onclick();
  assert.doesNotMatch(element('status').textContent,/已冻结/);
  await pump(); // 解冻后下一轮回到最新一张
  assert.equal(sandbox.freezeState().on,false);
  assert.equal(canvas.image.data[0],0,'解冻后显示最新一张');
});

test('The viewer no longer re-derives resolution: the frame panel shows the server metadata only',async()=>{
  const metadata={window:'hann',quality:'standard',focuser:'backprojection',lambda_m:.03,bandwidth_hz:75e6,duration_s:2,transverse_aperture_m:450};
  const {element,sandbox}=await load(129,{result:{width:129,size_m:SIZE,source:'dcs',db:Array(129*129).fill(-10),metadata},
    target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  // Gate 5: 分辨率重算（c/2B、λR/(2vT sinθ)、以及页面自己那份 c 与 λ 默认值）从页面删除。
  // 服务端给的 nominal_* 只随 metadata 原样显示在 #meta，页面不再挑选、换算或补默认值。
  assert.equal(sandbox.resolutionText,undefined,'页面不再导出一个分辨率重算函数');
  assert.doesNotMatch(viewerHtml,new RegExp(String(C_MPS)),'光速不再在页面里出现第二份');
  assert.doesNotMatch(viewerHtml,/λR\/\(2·v·T·sinθ\)/,'方位向公式不再在页面里重算');
  assert.doesNotMatch(viewerHtml,/resolutionInfo/,'分辨率行与它的占位文本已从页面删除');
  assert.match(element('meta').textContent,/"transverse_aperture_m": 450/,'服务端元数据原样可见');
});

test('Clicking the radar main view designates a point, gates the SAR buttons on the check and adds it to the list on demand',async()=>{
  assert.match(viewerHtml,/<ol id="targetList" class="targets"><\/ol>/);
  const anchor=mosaicEntry(1,{center:[1000,0,2000],target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  const {element,sandbox,contexts,requests,flush}=await load(129,{mode:'live',canCapture:true},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[anchor]})},images:{1:mosaicTile(anchor,-40)}});
  sandbox.mosaic.view={x:1000,z:2000,scale:1};
  const click=(canvasX,canvasY,pointerId=9)=>{
    const event={currentTarget:element('mosaic'),pointerId,clientX:canvasX*1.6,clientY:canvasY*2.56};
    element('mosaic').onpointerdown(event);element('mosaic').onpointerup(event);};
  assert.equal(element('designateDetail').disabled,true);assert.equal(element('addTarget').disabled,true,'没选点前两个按钮都不亮');
  const calls=contexts.get('mosaic').calls,start=calls.length;
  click(160,100); // 画布中心 = 锚点图像中心 = 世界 (1000,2000)
  const point=sandbox.designation.point;
  assert.equal(sandbox.targetsState().length,0,'单击只选取，不直接记入目标清单');
  assert.equal(point.source,'主视图');assert.equal(point.anchorSeq,1);
  assert.ok(Math.abs(point.latitude-41.5)<1e-9&&Math.abs(point.longitude-42.25)<1e-9,'锚点处点击给出锚点自己的经纬度');
  assert.match(element('designationInfo').textContent,/指定点（主视图）· DCS x\/z 1000 \/ 2000 m · 41\.500000°, 42\.250000°（按 #1 锚点做局部平面近似）/);
  const drawn=calls.slice(start),at=(op,x,y)=>drawn.some(call=>call.op===op&&call.x===x&&call.y===y);
  assert.ok(at('moveTo',149,100)&&at('lineTo',171,100),'指定点画成十字');
  assert.ok(at('moveTo',160,89)&&at('lineTo',160,111));
  assert.ok(drawn.some(call=>call.op==='arc'&&call.x===160&&call.y===100&&call.r===6),'指定点加圆圈，与清单里的 T 记号区分');
  assert.ok(drawn.some(call=>call.op==='fillText'&&call.text==='指定'));
  // 选取后自动问服务端：默认应答几何可成像，两个 SAR 按钮点亮；加入清单要另外按按钮。
  await flush();
  assert.equal(requests.at(-1).url,'/designate/check?x=1000.00&z=2000.00');
  assert.equal(element('designateDetail').disabled,false);assert.equal(element('designateArea').disabled,false);
  assert.equal(element('designateStatus').textContent,'可成像 · 地距 20.0 km · 相对航迹 右 45° · 右侧');
  assert.equal(element('addTarget').disabled,false);
  await element('designateDetail').onclick();
  let params=JSON.parse(requests.at(-1).options.body);
  assert.equal(requests.at(-1).url,'/capture');assert.deepEqual(params,{worldX:1000,worldZ:2000,footprint:'detail',quality:'fine',window:'hann',sceneModel:'classified',focuser:'backprojection'});
  await element('designateArea').onclick();
  params=JSON.parse(requests.at(-1).options.body);
  assert.equal(params.footprint,'area');assert.equal(params.quality,'fine');
  element('addTarget').onclick();
  const first=sandbox.targetsState()[0];
  assert.equal(sandbox.targetsState().length,1);assert.equal(first.anchorSeq,1);
  assert.match(element('targetPointInfo').textContent,/已加入目标清单：T1 · 41\.500000°, 42\.250000° · N41°30′00\.00″ E042°15′00\.00″ · DCS x\/z 1000 \/ 2000 m/);
  assert.match(element('targetList').innerHTML,/data-target="1">删除<\/button>/);
  // 东偏 50 m、北偏 50 m 的落点：dlat=+50/111320、dlon=+50/(111320·cos41.5°)；新选取替换旧选取，不动清单。
  click(210,50);
  const second=sandbox.designation.point;
  assert.ok(Math.abs(second.latitude-(41.5+50/111320))<1e-9);
  assert.ok(Math.abs(second.longitude-(42.25+50/(111320*Math.cos(41.5*Math.PI/180))))<1e-9);
  assert.equal(sandbox.targetsState().length,1,'第二次选取只换指定点');
  element('addTarget').onclick();
  assert.equal(sandbox.targetsState().length,2);assert.equal(element('clearTargets').disabled,false);
  // 拖动仍然是平移，不换指定点也不加清单。
  element('mosaic').onpointerdown({currentTarget:element('mosaic'),pointerId:11,clientX:256,clientY:256});
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:11,clientX:320,clientY:256});
  element('mosaic').onpointerup({currentTarget:element('mosaic'),pointerId:11,clientX:320,clientY:256});
  assert.equal(sandbox.designation.point,second,'拖动不换指定点');
  assert.equal(sandbox.targetsState().length,2);
  element('targetList').onclick({target:{dataset:{target:'1'}}});
  assert.deepEqual(Array.from(sandbox.targetsState(),point=>point.id),[2]);
  element('clearTargets').onclick();
  assert.equal(sandbox.targetsState().length,0);assert.equal(element('clearTargets').disabled,true);
  assert.equal(element('targetList').innerHTML,'');
  assert.match(element('targetPointInfo').textContent,/尚未加入目标点/);
  // 没有任何带经纬度的图像时只记 DCS 世界坐标。
  const plain=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[mosaicEntry(1,{target:null})]})},images:{1:mosaicTile(mosaicEntry(1),-40)}});
  plain.sandbox.mosaic.view={x:0,z:0,scale:1};
  plain.element('mosaic').onpointerdown({currentTarget:plain.element('mosaic'),pointerId:3,clientX:256,clientY:256});
  plain.element('mosaic').onpointerup({currentTarget:plain.element('mosaic'),pointerId:3,clientX:256,clientY:256});
  const bare=plain.sandbox.designation.point;
  assert.equal(bare.latitude,null);assert.equal(bare.longitude,null);
  assert.match(plain.element('designationInfo').textContent,/DCS x\/z 0 \/ 0 m · （本机图像未回报 target 经纬度，无法换算）/);
  plain.element('addTarget').onclick();
  assert.match(plain.element('targetList').innerHTML,/DCS x\/z 0 \/ 0 m（本机图像未回报 target 经纬度，无法换算）/);
});

// ---- DBS 放大小块（POST /dbs，MAP 家族，产物走 mosaic 通道） ----------------------------------
test('DBS 放大按钮：有指定点 + canDbs 才亮，近前视给劝告但不阻断，SAR 的门控不受影响',async()=>{
  const anchor=mosaicEntry(1,{center:[1000,0,2000],target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  const tap=async(state,designate)=>{
    const page=await load(129,{mode:'live',canCapture:true,...state},{},
      {state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[anchor]})},images:{1:mosaicTile(anchor,-40)},designate});
    page.sandbox.mosaic.view={x:1000,z:2000,scale:1};
    const event={currentTarget:page.element('mosaic'),pointerId:5,clientX:160*1.6,clientY:100*2.56};
    page.element('mosaic').onpointerdown(event);page.element('mosaic').onpointerup(event);
    await page.flush();return page;
  };
  const side={ok:true,reasons:[],range_km:12,relative_track_deg:45,side:1,flightIssue:null};
  // 没选点：三个按钮都不亮。
  const idle=await load(129,{mode:'live',canCapture:true,canDbs:true});
  for(const id of ['designateDetail','designateArea','designateDbs'])assert.equal(idle.element(id).disabled,true);
  // 服务端忙（canDbs=false）：按钮灭，判定行说明原因。
  const busy=await tap({canDbs:false},side);
  assert.equal(busy.element('designateDbs').disabled,true);
  assert.match(busy.element('designateStatus').textContent,/· DBS 放大暂不可用（服务端忙或未连接）$/);
  // 选了点、服务端不忙：DBS 亮，命令按契约发 {x,z,span_m,sharpen}。
  const ready=await tap({canDbs:true},side);
  assert.equal(ready.element('designateDbs').disabled,false);
  assert.equal(ready.element('designateDetail').disabled,false);
  assert.doesNotMatch(ready.element('designateStatus').textContent,/近前视/,'侧视窗口内不提近前视');
  await ready.element('designateDbs').onclick();
  const command=ready.requests.at(-1);
  assert.equal(command.url,'/dbs');
  const body=JSON.parse(command.options.body);
  assert.deepEqual({x:body.x,z:body.z,span_m:body.span_m,sharpen:body.sharpen},{x:1000,z:2000,span_m:512,sharpen:8});
  // 近前视（|相对航迹角| < 20°）：SAR 按服务端的 reasons 禁用，DBS 照常可用，只把退化说清楚。
  const near={ok:false,reasons:['斜视角 8°（正右/负左）不在 20–160° 侧视窗内'],range_km:12,relative_track_deg:8,side:1,flightIssue:null};
  const forward=await tap({canDbs:true},near);
  assert.equal(forward.element('designateDetail').disabled,true);assert.equal(forward.element('designateArea').disabled,true);
  assert.equal(forward.element('designateDbs').disabled,false,'近前视恰恰是 DBS 还能用的地方');
  assert.equal(forward.element('designateStatus').textContent,
    '不可成像：斜视角 8°（正右/负左）不在 20–160° 侧视窗内 · 地距 12.0 km · 相对航迹 右 8° · 右侧 · 近前视（相对航迹 8° < 20°）：DBS 放大可用，但锐化失效、退化为实波束画质');
  assert.equal(forward.element('designateDbs').disabled,false,'劝告不阻断');
  // 旧服务端没有 canDbs：页面不替它宣告 DBS，判定行里一个字都不提。
  const legacy=await tap({},near);
  assert.equal(legacy.element('designateDbs').disabled,true);
  assert.doesNotMatch(legacy.element('designateStatus').textContent,/DBS/);
  assert.doesNotMatch(legacy.element('designateStatus').textContent,/近前视/);
});

test('DBS 状态进主视图状态行，mode:dbs 的读数带放大倍数',async()=>{
  assert.match(viewerHtml,/<button id="designateDbs" disabled>DBS 放大 512 m<\/button>/);
  const entry=mosaicEntry(3,{mode:'dbs',quality:'dbs',focuser:'real-beam',metadata:{dbs:{factor:8}}});
  const {element,sandbox,requests,flush}=await load(129,{mode:'live',canCapture:true,canDbs:true,
    dbs:{active:true,note:'正在算第 2 块（12 km）',lastFrame:{seq:3,completed:1}}},{},
    {state:{mosaic:mosaicPayload({count:1,firstSeq:3,latestSeq:3,incremental:false,entries:[entry]})},images:{3:mosaicTile(entry,-40)}});
  assert.match(element('radarStatus').textContent,/· DBS 放大：正在算第 2 块（12 km） · 最近一块 #3/);
  // 悬停读数：dbs 条目点明放大倍数，与 map 底图、sar 贴片区分。
  sandbox.mosaic.view={x:0,z:0,scale:1};
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:256,clientY:256});
  assert.match(element('mosaicReadout').textContent,/129×129 · dbs · 8:1 · dbs · real-beam/);
  // 缺 metadata.dbs.factor 就按服务端默认 8:1 说；map/sar 条目一个 dbs 字样都不加。
  assert.equal(sandbox.dbsFactor({metadata:{dbs:{factor:16}}}),16);
  assert.equal(sandbox.dbsFactor({dbs:{factor:4}}),4);
  assert.equal(sandbox.dbsFactor({}),8);
  assert.equal(sandbox.dbsFactor({metadata:{dbs:{factor:0}}}),8,'0 或负数不是一个倍数，按默认说');
  sandbox.mosaicDraw();
  assert.match(element('mosaicReadout').textContent.length>0?element('mosaicReadout').textContent:'',/dbs · 8:1/);
  const plainEntry=mosaicEntry(4,{mode:'sar',metadata:{}});
  const plain=await load(129,{mode:'live',canCapture:true,canDbs:true},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:4,latestSeq:4,incremental:false,entries:[plainEntry]})},images:{4:mosaicTile(plainEntry,-40)}});
  plain.sandbox.mosaic.view={x:0,z:0,scale:1};
  plain.element('mosaic').onpointermove({currentTarget:plain.element('mosaic'),pointerId:1,clientX:256,clientY:256});
  assert.doesNotMatch(plain.element('mosaicReadout').textContent,/dbs/);
  // 没有服务端的 dbs 段时状态行不提 DBS；悬停与重画也不会替用户发 /dbs 请求。
  const silent=await load(129,{mode:'live',canCapture:true});
  assert.doesNotMatch(silent.element('radarStatus').textContent,/DBS/);
  assert.equal(requests.filter(request=>request.url==='/dbs').length,0,'读数与重画不会自己发 /dbs');
  await flush();
});

// ---- 指定产物“出图即跳转”：512 m 的块在 0.04 px/m 下只有 20 px、128 m 的切片只有 5 px ------------------
test('点 DBS 放大后新块贴入即跳转：居中放大到短边 60%、关闭跟随、描边并提示，几秒后反馈自己消失',async()=>{
  // 冻结页面时钟：60 s 期望有效期与 6 s 描边都按 Date.now() 算，真实等待只会让用例变慢。
  let now=Date.now();
  class FakeDate extends Date{static now(){return now;}}
  const anchor=mosaicEntry(1,{center:[0,0,0],target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  const block=mosaicEntry(9,{mode:'dbs',quality:'dbs',focuser:'real-beam',center:[1000,0,2000],size_m:512,completed:now,metadata:{dbs:{factor:8}}});
  const states=[
    {mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[anchor]})},
    {mosaic:mosaicPayload({count:2,firstSeq:1,latestSeq:9,incremental:true,entries:[block]})}];
  const page=await load(129,{mode:'live',canCapture:true,canDbs:true},{Date:FakeDate},
    {states,images:{1:mosaicTile(anchor,-40),9:mosaicTile(block,0)}});
  page.sandbox.mosaic.view={x:0,z:0,scale:1};
  page.sandbox.designateWorldPoint(1000,2000,'主视图');
  await page.flush();
  assert.equal(page.element('designateDbs').disabled,false);
  assert.equal(page.element('zoomInfo').textContent,'','还没出图时没有提示行');
  await page.element('designateDbs').onclick();   // 置期望并发出 POST /dbs
  assert.equal(page.requests.at(-1).url,'/dbs');
  await page.pump();                               // 下一轮 /state：DBS 块贴入
  // 假 DOM 的画布是 320×200 → 短边 200；512 m 块占 60% ⇒ 200×0.6/512 = 0.234375 px/m。
  assert.equal(page.sandbox.mosaic.view.x,1000);assert.equal(page.sandbox.mosaic.view.z,2000);
  assert.ok(Math.abs(page.sandbox.mosaic.view.scale-200*.6/512)<1e-9,'比例 = 短边×0.6 / 条目边长');
  assert.equal(page.sandbox.mosaic.follow,false);assert.equal(page.element('mosaicFollow').checked,false,'跟随必须关掉，否则下一帧被拉回本机');
  assert.equal(page.element('zoomInfo').textContent,'DBS 放大完成：已跳转到该块，滚轮可继续放大');
  // 描边：亮青 2 px 方框，贴住条目自己的世界边界（中心 ±256 m，在 0.234375 px/m 下 ≈ ±60 px）。
  // 指定点记号也是同色同宽的，所以按方框的角坐标认，而不是数同色描边的条数。
  const calls=page.contexts.get('mosaic').calls;
  const at=(op,x,y)=>calls.some(call=>call.op===op&&Math.abs(call.x-x)<1e-6&&Math.abs(call.y-y)<1e-6);
  assert.ok(at('moveTo',100,160)&&at('lineTo',220,40),'跳转后给该块画描边，方框四角落在 ±60 px 上');
  // 6 秒后描边擦掉、提示行清空，视图保持不动（只收反馈，不弹回本机）。
  const before=calls.length;
  now+=7000;
  await page.pump();
  const fresh=calls.slice(before),during=(op,x,y)=>fresh.some(call=>call.op===op&&Math.abs(call.x-x)<1e-6&&Math.abs(call.y-y)<1e-6);
  assert.ok(!during('moveTo',100,160),'过期后不再画描边');
  assert.equal(page.element('zoomInfo').textContent,'','提示行不永久占位');
  assert.equal(page.sandbox.mosaic.view.x,1000);assert.equal(page.sandbox.mosaic.view.scale,200*.6/512);
});

test('只有点了指定按钮才跳转：map 巡逻帧与别处的 sar 贴片都不动视图，命中指定点的产物才跳',async()=>{
  let now=Date.now();
  class FakeDate extends Date{static now(){return now;}}
  const anchor=mosaicEntry(1,{center:[0,0,0],target:{latitude:41.5,longitude:42.25,ground_range_m:20000,relative_track_deg:45}});
  const patrol=mosaicEntry(2,{mode:'map',quality:'map',focuser:'real-beam',center:[1000,0,2000],size_m:8000,completed:now});
  const elsewhere=mosaicEntry(3,{mode:'sar',center:[9000,0,9000],size_m:512,completed:now});
  const atPoint=mosaicEntry(4,{mode:'sar',center:[1000,0,2000],size_m:512,completed:now});
  const states=[
    {mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[anchor]})},
    {mosaic:mosaicPayload({count:2,firstSeq:1,latestSeq:2,incremental:true,entries:[patrol]})},
    {mosaic:mosaicPayload({count:3,firstSeq:1,latestSeq:3,incremental:true,entries:[elsewhere]})},
    {mosaic:mosaicPayload({count:4,firstSeq:1,latestSeq:4,incremental:true,entries:[atPoint]})}];
  const page=await load(129,{mode:'live',canCapture:true,canDbs:true},{Date:FakeDate},
    {states,images:{1:mosaicTile(anchor,-40),2:mosaicTile(patrol,0),3:mosaicTile(elsewhere,0),4:mosaicTile(atPoint,0)}});
  page.sandbox.designateWorldPoint(1000,2000,'主视图');
  await page.flush();
  page.sandbox.mosaic.view={x:0,z:0,scale:1};
  await page.element('designateArea').onclick();   // 期望 mode:'sar'，带指定点位置
  const view=()=>[page.sandbox.mosaic.view.x,page.sandbox.mosaic.view.z,page.sandbox.mosaic.view.scale];
  await page.pump();
  assert.deepEqual(view(),[0,0,1],'MAP 巡逻帧 mode:map 不触发跳转');
  assert.equal(page.element('zoomInfo').textContent,'');
  await page.pump();
  assert.deepEqual(view(),[0,0,1],'连续采集在别处拍的 sar 贴片盖不住指定点，也不跳');
  await page.pump();
  assert.equal(page.sandbox.mosaic.view.x,1000);assert.equal(page.sandbox.mosaic.view.z,2000);
  assert.ok(Math.abs(page.sandbox.mosaic.view.scale-200*.6/512)<1e-9);
  assert.equal(page.sandbox.mosaic.follow,false);
  assert.equal(page.element('zoomInfo').textContent,'SAR 区域成像完成：已跳转到该块，滚轮可继续放大');
  // 期望是一次性的：跳过一次就清掉，之后的产物不再抢视图。
  page.sandbox.mosaic.view={x:0,z:0,scale:1};
  await page.pump();
  assert.deepEqual(view(),[0,0,1],'没有新的指定就不会再跳');
});

test('GMTI movers draw as symbols with speed vectors, fade when stale and stay silent when unavailable',async()=>{
  assert.match(viewerHtml,/动目标符号来自 GMTI 报告/,'④ 栏说明动目标符号与 SAR 图像不做配准');
  const entry=mosaicEntry(1,{center:[0,0,0]}),tile=mosaicTile(entry,-40);
  const fresh={x:60,z:0,speed:12,headingDeg:90,ageS:.4},stale={x:-60,z:40,speed:0,headingDeg:0,ageS:9};
  const {element,sandbox,contexts}=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[entry]}),movers:[fresh,stale]},images:{1:tile}});
  sandbox.mosaic.view={x:0,z:0,scale:1};
  const calls=contexts.get('mosaic').calls,start=calls.length;
  sandbox.mosaicDraw();
  const drawn=calls.slice(start),strokes=drawn.filter(call=>call.op==='stroke');
  const at=(op,x,y)=>drawn.some(call=>call.op===op&&call.x===x&&call.y===y);
  assert.ok(at('moveTo',220,94)&&at('lineTo',226,100)&&at('lineTo',214,100),'新报告画成菱形');
  assert.ok(strokes.some(call=>call.strokeStyle==='#ff6b5a'),'新报告用亮色');
  assert.ok(drawn.some(call=>call.op==='fillText'&&call.text==='12 m/s'));
  assert.ok(drawn.find(call=>call.op==='lineTo'&&call.x>221&&call.x<229&&Math.abs(call.y-100)<.001),'速度矢量短线沿航向');
  assert.ok(at('moveTo',100,134),'过期报告画在 (‑60,40)');
  assert.ok(strokes.some(call=>call.strokeStyle==='#8a5148'),'过期报告变淡');
  assert.ok(drawn.some(call=>call.op==='fillText'&&call.text==='动目标 · 旧'),'过期报告标“旧”');
  assert.match(element('mosaicInfo').textContent,/动目标 2 个（含过期报告）/);
  // 悬停读数：动目标优先于它下面的图像元数据。
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:352,clientY:256});
  assert.match(element('mosaicReadout').textContent,/动目标（GMTI）· 速度 12\.0 m\/s · 航向 90° · 世界 x\/z 60 \/ 0 m · 报告 0\.4 s 前/);
  assert.equal(sandbox.mosaic.hover,null);
  element('mosaic').onpointermove({currentTarget:element('mosaic'),pointerId:1,clientX:160,clientY:358.4});
  assert.match(element('mosaicReadout').textContent,/报告 9\.0 s 前 · 已过期，位置可能不再成立/);
  // 桥不可用（null）：不画、不报错，只在 ④ 栏说明层不可用。
  const off=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[entry]}),movers:null},images:{1:tile}});
  const offStart=off.contexts.get('mosaic').calls.length;
  off.sandbox.mosaicDraw();
  const offDrawn=off.contexts.get('mosaic').calls.slice(offStart);
  assert.equal(offDrawn.filter(call=>call.op==='stroke'&&['#ff6b5a','#8a5148'].includes(call.strokeStyle)).length,0);
  assert.match(off.element('mosaicInfo').textContent,/动目标层不可用（任务桥未连接）/);
  // 服务端带 moversNote 时用它的说法：多普勒门限、降级原因都比页面自己数个数准确。
  const noted=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[entry]}),movers:[fresh],moversNote:'1 个动目标（径向 |v| ≥ 2 m/s；入检 3 个）'},images:{1:tile}});
  noted.sandbox.mosaicDraw();
  assert.match(noted.element('mosaicInfo').textContent,/动目标：1 个动目标（径向 \|v\| ≥ 2 m\/s；入检 3 个）/);
  const blocked=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[entry]}),movers:null,moversNote:'任务桥未就绪'},images:{1:tile}});
  blocked.sandbox.mosaicDraw();
  assert.match(blocked.element('mosaicInfo').textContent,/动目标层不可用：任务桥未就绪/);
  // 旧服务端完全不上报该字段：不画也不提。
  const legacy=await load(129,{},{},{state:{mosaic:mosaicPayload({count:1,firstSeq:1,latestSeq:1,incremental:false,entries:[entry]})},images:{1:tile}});
  assert.equal(legacy.sandbox.mosaic.moversKnown,false);
  legacy.sandbox.mosaicDraw();
  assert.doesNotMatch(legacy.element('mosaicInfo').textContent,/动目标/);
});

// ---- 操作界面简化：模式预设、折叠的高级项、控件记忆 ----
const storedKey='sar-viewer/controls/1';
// 只实现页面用到的三个方法。传入 stored 时按控件快照预置：键与页面一致，值就是页面写下的那份 JSON。
const memoryStorage=stored=>{const store=new Map();if(stored)store.set(storedKey,JSON.stringify(stored));return {
  getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>store.set(key,String(value)),removeItem:key=>store.delete(key)};
};

test('Preset batches the documented parameters, travels with the request and never locks a control',async()=>{
  assert.ok(viewerHtml.includes('<select id="preset"><option value="wide">广域快扫（推荐默认）</option>'),'控制区顶部有模式预设下拉');
  assert.match(viewerHtml,/<option value="observe">精细观察<\/option><option value="inspect">局部精看<\/option>/);
  assert.match(viewerHtml,/<option value="0">左右交替/,'服务端 side=0 = 每次采集左右轮流，下拉框要能表达它');
  const {element,requests}=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}});
  assert.equal(element('preset').value,'custom','页面默认值不对应任何预设时如实显示自定义');
  assert.match(element('presetInfo').textContent,/逐项设置/);
  element('preset').value='wide';element('preset').onchange();
  assert.deepEqual([element('quality').value,element('window').value,element('focuser').value,element('sceneModel').value,element('footprint').value,element('continuousMode').value,element('side').value,element('looks').value,element('multiLook').checked],
    ['fast','hann','pfa','classified','area','sweep','0','2',true]);
  assert.match(element('presetInfo').textContent,/已应用「广域快扫（推荐默认）」/);
  assert.match(element('presetInfo').textContent,/可继续单独调整/);
  await element('continuousStart').onclick();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body),{side:0,range:20000,record:false,mode:'sweep',quality:'fast',window:'hann',footprint:'area',sceneModel:'classified',focuser:'pfa'});
  // 不锁定：套用后每一项仍能单独改，下拉框跟着回到「自定义」
  element('quality').value='standard';element('quality').onchange();
  assert.equal(element('quality').value,'standard');assert.equal(element('preset').value,'custom');
  element('preset').value='observe';element('preset').onchange();
  assert.deepEqual([element('quality').value,element('focuser').value,element('footprint').value,element('continuousMode').value,element('looks').value,element('multiLook').checked],['standard','pfa','area','relative','2',true]);
  element('preset').value='inspect';element('preset').onchange();
  assert.deepEqual([element('quality').value,element('footprint').value,element('looks').value,element('multiLook').checked],['fine','detail','1',false]);
  assert.match(element('presetInfo').textContent,/已应用「局部精看」/);
});

test('Advanced controls sit in a collapsed details block and keep working from inside it',async()=>{
  assert.doesNotMatch(viewerHtml,/<details id="advanced"[^>]*\sopen/,'默认收起');
  const start=viewerHtml.indexOf('<details id="advanced">');
  assert.ok(start>0,'高级选项是一个 details 块');
  const block=viewerHtml.slice(start,viewerHtml.indexOf('</details>',start));
  assert.match(block,/<summary>高级选项：/);
  for(const id of ['quality','window','focuser','displayRange','multiLook','looks','reprocess'])assert.match(block,new RegExp(`id="${id}"`),id);
  for(const id of ['preset','continuousMode','continuousStart','continuousStop','recordContinuous'])assert.ok(!block.includes(`id="${id}"`),`${id} 留在常用区`);
  // 连续采集的模式与手动启停收在另一个折叠块里；主视图的一键雷达监视不依赖它。
  assert.doesNotMatch(viewerHtml,/<details id="continuousControls"[^>]*\sopen/,'连续采集高级项同样默认收起');
  const start2=viewerHtml.indexOf('<details id="continuousControls">');
  assert.ok(start2>0,'连续采集高级项是一个 details 块');
  const block2=viewerHtml.slice(start2,viewerHtml.indexOf('</details>',start2));
  assert.match(block2,/<summary>高级：连续采集模式/);
  for(const id of ['continuousMode','continuousStart','continuousStop','recordContinuous','modeInfo'])assert.match(block2,new RegExp(`id="${id}"`),id);
  for(const id of ['preset','radarStart','radarStop','side','range','footprint','sceneModel'])assert.ok(!block2.includes(`id="${id}"`),`${id} 留在常用区`);
  const {element,requests,canvas}=await load(129);
  element('quality').value='fine';element('focuser').value='pfa';element('window').value='rect';element('displayRange').value='20';
  await element('reprocess').onclick();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body),{quality:'fine',window:'rect',footprint:'detail',sceneModel:'classified',focuser:'pfa'});
  element('multiLook').checked=true;element('looks').value='3';element('looks').onchange();
  assert.deepEqual(canvas.dimensions,[43,43],'折叠区里的视数照样生效');
  assert.match(element('scale').textContent,/黑 −20 dB，白 0 dB/,'折叠区里的显示对比度照样生效');
});

test('Every control choice is remembered in localStorage and restored on the next load',async()=>{
  const storage=memoryStorage();
  const first=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}},{localStorage:storage});
  first.element('preset').value='inspect';first.element('preset').onchange();
  first.element('range').value='30';first.element('range').onchange();
  first.element('recordContinuous').checked=true;first.element('recordContinuous').onchange();
  first.element('mosaicPlan').checked=false;first.element('mosaicPlan').onchange();
  first.element('referenceView').value='surface';first.element('referenceView').onchange();
  const saved=JSON.parse(storage.getItem('sar-viewer/controls/1'));
  assert.deepEqual({quality:saved.quality,footprint:saved.footprint,looks:saved.looks,multiLook:saved.multiLook,range:saved.range,recordContinuous:saved.recordContinuous,mosaicPlan:saved.mosaicPlan,referenceView:saved.referenceView},
    {quality:'fine',footprint:'detail',looks:'1',multiLook:false,range:'30',recordContinuous:true,mosaicPlan:false,referenceView:'surface'});
  const second=await load(129,{mode:'live',canStartContinuous:true,continuous:{enabled:false,completed:0,note:'未启动'}},{localStorage:storage});
  assert.deepEqual([second.element('quality').value,second.element('footprint').value,second.element('looks').value,second.element('multiLook').checked],['fine','detail','1',false]);
  assert.equal(second.element('range').value,'30');assert.equal(second.element('recordContinuous').checked,true);
  assert.equal(second.element('mosaicPlan').checked,false);assert.equal(second.sandbox.sweep.visible,false,'勾选框与内部状态一起恢复');
  assert.equal(second.element('referenceView').value,'surface');
  assert.equal(second.element('preset').value,'inspect','下拉框按恢复后的各项反推');
  await second.element('continuousStart').onclick();
  assert.deepEqual(JSON.parse(second.requests.at(-1).options.body),{side:1,range:30000,record:true,mode:'relative',quality:'fine',window:'hann',footprint:'detail',sceneModel:'classified',focuser:'backprojection'});
});

test('Stored choices fall back when storage is unreadable, an option is gone or a number is out of range',async()=>{
  const page=await load(129,{},{localStorage:memoryStorage({quality:'legacy-fine',window:'rect',side:'7',range:'999',multiLook:true})});
  assert.equal(page.element('quality').value,'standard','选项已不存在的字段回退到页面默认');
  assert.equal(page.element('side').value,'1');assert.equal(page.element('range').value,'20','地距越界不采用');
  assert.equal(page.element('window').value,'rect','能识别的字段照常恢复');assert.equal(page.element('multiLook').checked,true);
  const corrupt=await load(129,{},{localStorage:{getItem:()=>'{半截',setItem:()=>{},removeItem:()=>{}}});
  assert.equal(corrupt.element('quality').value,'standard');assert.equal(corrupt.element('preset').value,'custom');
  assert.match(corrupt.element('presetInfo').textContent,/逐项设置/);
  const none=await load(129); // 页面没有 localStorage（隐私模式）时照常加载
  assert.equal(none.element('quality').value,'standard');assert.equal(none.element('range').value,'20');
});

test('Stored choices beat the image-metadata backfill, a running capture still beats stored choices',async()=>{
  const storage=memoryStorage({quality:'fine',window:'rect',side:'-1',footprint:'detail'});
  const backfill=await load(129,{result:{width:129,size_m:SIZE,source:'dcs',db:Array(129*129).fill(-10),power:Array(129*129).fill(1),metadata:{window:'hann',quality:'fast',focuser:'pfa'}}},{localStorage:storage});
  assert.equal(backfill.element('quality').value,'fine','用户存过的字段不被图像元数据覆盖');
  assert.equal(backfill.element('window').value,'rect');assert.equal(backfill.element('side').value,'-1');
  assert.equal(backfill.element('focuser').value,'pfa','没存过的字段仍按图像元数据回填');
  const running=await load(129,{mode:'live',continuous:{enabled:true,side:1,range:20000,record:false,quality:'standard',window:'hann',focuser:'backprojection',footprint:'area',completed:1,note:'等待采集'}},{localStorage:storage});
  assert.deepEqual([running.element('quality').value,running.element('window').value,running.element('focuser').value,running.element('side').value,running.element('footprint').value],
    ['standard','hann','backprojection','1','area']);
  assert.equal(running.element('preset').value,'custom','运行中的设置对不上任何预设就不冒充预设');
});
