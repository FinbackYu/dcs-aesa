'use strict';
// Offline cockpit C1.6 tests: DCS page/controller executed against a Lua 5.1
// stub environment, plus installer patch/restore against a temporary module
// tree. No DCS process is started. When Lua 5.1 is unavailable this file
// fails (the unified runner skips the suite before invoking it).
//
// Beyond element declarations, the stub snapshots every element's
// controllers/element_params/formats at Add() time and fails if any of them
// is mutated afterwards — the C1.5 real-machine defect ("all elements stuck
// on their default text, NO DATA forever") came from assigning bindings after
// Add(), which the engine ignores. The suite also pins the AESA_* parameter
// set identical across controller predeclaration, the installer's device_init
// block, and the page's referenced names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const install = require('../scripts/install_cockpit.cjs');
const common = require('../scripts/install_common.cjs');
const { findLua: findDcsLua } = require('../scripts/build_common.cjs');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'adapters', 'dcs', 'cockpit', 'page', 'MFD_FCR_AESA_AA.lua');
const CONTROLLER = path.join(ROOT, 'src', 'adapters', 'dcs', 'cockpit', 'controller.lua');
const detectedLua = process.env.AESA_LUA || findDcsLua();
const DCS_ROOT = process.env.AESA_DCS_DIR || (detectedLua ? path.dirname(path.dirname(detectedLua)) : null);
const LUA = process.env.AESA_LUA || (DCS_ROOT ? path.join(DCS_ROOT, 'bin', 'luae.exe') : null);

// Declared elements in the C1.6 layout (5 PB labels + masks, scales, carets,
// horizon, scan limits, cursor, 8 track slots x 23, STT row, etc). The page
// draws no bezel frame and no bottom format row (SUBSET_BASE_MENU provides it).
const ELEMENT_COUNT = 265;

function luaAvailable() {
  try { return fs.statSync(LUA).isFile(); } catch { return false; }
}

// Runs the page and controller under a Lua 5.1 stub. stateText is the first
// frame; when frameB is given the state file is rewritten and update() runs
// once more so dynamic behaviour (TUC, STT transitions) can be observed.
// Returns one "key=value" line per published handle (a./b. prefixes), the
// page-referenced AESA_* names (refs), the controller-declared names (decl)
// and page geometry facts (~meta lines); newlines in values are '|'.
function runLuaHarness(stateText, frameB) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-cockpit-lua-'));
  const dir = path.join(temp, 'Scripts', 'AESA-COCKPIT');
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.txt');
  fs.writeFileSync(stateFile, stateText);
  const q = value => JSON.stringify(value.replace(/\\/g, '/'));
  const source = `
LockOn_Options={script_path='X/'}
STROKE_FNT_DFLT_8_12=1; STROKE_FNT_DFLT_10_14=2; STROKE_FNT_DFLT_14_18=3; STROKE_FNT_DFLT_20_28=4; STROKE_FNT_DFLT_28_36=5; STROKE_FNT_DFLT_6_9=6
function dofile(path) end
local elements={}
local function ser(v)
    if type(v)~='table' then return tostring(v) end
    local p={}
    for i=1,#v do p[#p+1]=ser(v[i]) end
    return '{'..table.concat(p,',')..'}'
end
local function fp(e) return ser(e.controllers)..'|'..ser(e.element_params)..'|'..ser(e.formats) end
local function reg(e)
    e._fp=fp(e)
    elements[#elements+1]=e
    if e.name then elements[e.name]=e end
    return e
end
function CreateElement(kind) return {kind=kind} end
function Add(e) return reg(e) end
function setPlaceholderCommonProperties(ph,name,pos,parent,controllers)
    ph.name=name; pos=pos or {0,0}; ph.init_pos={pos[1],pos[2],0}
    if parent then ph.parent_element=parent end
    if controllers then ph.controllers=controllers end
end
function addStrokeText(name,value,font,align,pos,parent,controllers,formats,outlined) return reg({kind='text',name=name,value=value,pos=pos,align=align,controllers=controllers,formats=formats}) end
function addStrokeLine(name,length,pos,rot,parent,controllers) return reg({kind='line',name=name,pos=pos,controllers=controllers}) end
function addStrokeCircle(name,radius,pos,parent,controllers) return reg({kind='circle',name=name,pos=pos,controllers=controllers}) end
function addStrokeSymbol(name,set,align,pos,parent,controllers,scale,material) return reg({kind='sym',name=name,pos=pos,controllers=controllers,scale=scale}) end
function addFillBox(name,sx,sy,align,pos,parent,controllers) return reg({kind='box',name=name,pos=pos,controllers=controllers}) end
function addFcrSteerpoint(name,pos,parent,controllers,material) return reg({kind='mesh',name=name,pos=pos,controllers=controllers}) end
function addPlaceholder(name,pos,parent,controllers) return reg({kind='ph',name=name,pos=pos,controllers=controllers}) end
function addSizeClipMask(symbol,width,height,maskController,offset) return reg({kind='mask',name=tostring(symbol and symbol.name or '?')..'_MASK',controllers=maskController}) end
-- Native text anchors: PB label root pushed to the +-240 edge, text 3 inward.
local PB_TEXT_POS={{-158,237},{-79,237},{0,237},{79,237},{158,237},{237,155},{237,77},{237,-1},{237,-79},{237,-157},{158,-237},{79,-237},{0,-237},{-79,-237},{-158,-237},{-237,-157},{-237,-79},{-237,-1},{-237,77},{-237,155}}
function add_PB_label(number,string,parent,controller,maskController,formats,outlined)
    return reg({kind='pblabel',name='PB_'..number,value=string,pos=PB_TEXT_POS[number],controllers=controller})
end
assert(loadfile(${q(PAGE)}))()
for _,e in ipairs(elements) do
    assert(fp(e)==e._fp, 'post-Add binding mutation on '..tostring(e.name))
end
local referenced={}
local function collect(list)
    if type(list)~='table' then return end
    for _,entry in ipairs(list) do
        local name=type(entry)=='table' and entry[1] or entry
        if type(name)=='string' and name:match('^AESA_') then referenced[name]=true end
    end
end
for _,e in ipairs(elements) do collect(e.controllers); collect(e.element_params) end
local required={'PB_1','PB_2','PB_3','PB_4','PB_5','AESA_CONT','AESA_CONT_MASK',
    'AESA_RANGE_ROOT','AESA_RANGE','AESA_RANGE_OUTLINED','AESA_RANGE_UP_SYM','AESA_RANGE_DOWN_SYM','AESA_RANGE_ROOT_MASK',
    'AESA_AZ','AESA_BARS','AESA_M4','AESA_M4_MASK',
    'AESA_AZ_TIC_3','AESA_EL_TIC_3','AESA_AZ_CARET','AESA_EL_CARET','AESA_HORI_ROOT',
    'AESA_SCANLIM_L_LINE','AESA_SCANLIM_R_LINE','AESA_BULL_1','AESA_BULL_2','AESA_BULL_3','AESA_STPT',
    'AESA_CUR_GATE','AESA_CUR_MOVE','AESA_CUR_MAX','AESA_CUR_MIN','AESA_STT_ROW','AESA_STT_ASPECT',
    'AESA_BLOS','AESA_BLOS_RNG','AESA_BLOS_BRG','AESA_CUR_BRG','AESA_ALL','AESA_WPN','AESA_HINT'}
for _,n in ipairs(required) do assert(elements[n], 'element '..n..' missing') end
for i=1,8 do
    assert(elements['AESA_TRK_'..i..'_GATE'], 'track gate '..i..' missing')
    assert(elements['AESA_TRK_'..i..'_ROT'], 'track rot '..i..' missing')
    assert(elements['AESA_TRK_'..i..'_SEARCH'], 'track search '..i..' missing')
    assert(elements['AESA_TRK_'..i..'_TRACK'], 'track track '..i..' missing')
    assert(elements['AESA_TRK_'..i..'_STT'], 'track stt '..i..' missing')
end
io.write('~pb1x='..tostring(elements['PB_1'].pos[1])..'\\n')
io.write('~pb2y='..tostring(elements['PB_2'].pos[2])..'\\n')
io.write('~m4x='..tostring(elements['AESA_M4'].pos[1])..'\\n')
io.write('~m4y='..tostring(elements['AESA_M4'].pos[2])..'\\n')
io.write('~azx='..tostring(elements['AESA_AZ'].pos[1])..'\\n')
io.write('~azy='..tostring(elements['AESA_AZ'].pos[2])..'\\n')
io.write('~upsym='..tostring(elements['AESA_RANGE_UP_SYM'].kind)..'\\n')
local tup=0
for _,e in ipairs(elements) do
    if type(e.controllers)=='table' then
        for _,c in ipairs(e.controllers) do
            if type(c)=='table' and c[1]=='text_using_parameter' then tup=tup+1 end
        end
    end
end
io.write('~tup='..tup..'\\n')
local reflist={}
for n in pairs(referenced) do reflist[#reflist+1]=n end
table.sort(reflist)
for _,n in ipairs(reflist) do io.write('ref='..n..'\\n') end
local function h(name) return {name=name, value=nil, set=function(self,v) self.value=v end, get=function(self) return self.value end} end
_G.handles={}
local declared={}
_G.get_param_handle=function(name)
    if not _G.handles[name] then _G.handles[name]=h(name); declared[#declared+1]=name end
    return _G.handles[name]
end
_G.lfs={writedir=function() return ${q(temp)}..'/' end}
_G.log={write=function() end, WARNING=2}
function make_default_activity(dt) end
assert(loadfile(${q(CONTROLLER)}))()
for _,n in ipairs(declared) do io.write('decl='..n..'\\n') end
post_initialize()
local function dump(tag)
    local keys={'AESA_MODE','AESA_RANGE','AESA_RANGE_UP','AESA_RANGE_DOWN','AESA_AZ','AESA_BARS','AESA_WPN',
        'AESA_BEAM_X','AESA_BEAM_EL','AESA_PITCH','AESA_ROLL','AESA_SCAN_LIM',
        'AESA_CUR_X','AESA_CUR_Y','AESA_CUR_MAX','AESA_CUR_MIN','AESA_CUR_BRG',
        'AESA_STT_SHOW','AESA_STT_ASPECT','AESA_STT_TRK','AESA_STT_CAS','AESA_STT_CLOSE','AESA_HINT',
        'AESA_TRK_1_SHOW','AESA_TRK_1_STATUS','AESA_TRK_1_X','AESA_TRK_1_Y','AESA_TRK_1_HDG','AESA_TRK_1_ALT','AESA_TRK_1_TUC','AESA_TRK_1_HOT',
        'AESA_TRK_2_SHOW','AESA_TRK_2_STATUS','AESA_TRK_2_X','AESA_TRK_2_Y','AESA_TRK_2_TUC',
        'AESA_TRK_3_SHOW','AESA_TRK_3_STATUS','AESA_TRK_3_HDG','AESA_TRK_3_ALT'}
    for _,k in ipairs(keys) do
        local v=handles[k] and handles[k].value
        io.write(tag..k..'='..tostring(v):gsub('\\n','|')..'\\n')
    end
    io.write(tag..'elements='..#elements..'\\n')
end
dump('a.')
${frameB ? `
local f2=io.open(${q(stateFile)},'w'); f2:write(${q(frameB)}); f2:close()
update()
dump('b.')
` : ''}
`;
  const result = spawnSync(LUA, ['-'], { input: source, encoding: 'utf8', windowsHide: true });
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(result.status, 0, (result.stderr || '') + (result.stdout || ''));
  const out = { a: {}, b: {}, refs: [], decl: [], meta: {} };
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = line.match(/^([ab])\.([\w]+)=(.*)$/);
    if (m) { out[m[1]][m[2]] = m[3]; continue; }
    const ref = line.match(/^ref=(.+)$/);
    if (ref) { out.refs.push(ref[1]); continue; }
    const decl = line.match(/^decl=(.+)$/);
    if (decl) { out.decl.push(decl[1]); continue; }
    const meta = line.match(/^~([\w]+)=(.*)$/);
    if (meta) out.meta[meta[1]] = meta[2];
  }
  return out;
}

function copyModule(root) {
  const source = path.join(DCS_ROOT, 'Mods', 'aircraft', 'F-16C', 'Cockpit');
  const dest = path.join(root, 'Mods', 'aircraft', 'F-16C', 'Cockpit');
  fs.cpSync(source, dest, { recursive: true });
  // Normalize the copy to a stock module: when the real module currently has
  // our patch installed, revert the two patched files to the manifest's
  // recorded originals and drop our files from the copy (temp tree only).
  const manifestPath = path.join(dest, 'Scripts', 'AESA', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(path.join(dest, 'Scripts', 'Displays', 'MFD', 'indicator', 'MFD_Pages_Init.lua'), Buffer.from(m.pages_before, 'base64'));
    fs.writeFileSync(path.join(dest, 'Scripts', 'device_init.lua'), Buffer.from(m.device_before, 'base64'));
    fs.rmSync(path.join(dest, 'Scripts', 'AESA'), { recursive: true, force: true });
    fs.rmSync(path.join(dest, 'Scripts', 'Displays', 'MFD', 'indicator', 'Pages', 'FCR', 'MFD_FCR_AESA_AA.lua'), { force: true });
  }
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'DCS.exe'), 'test');
  return dest;
}

// Executes the patched MFD_Pages_Init.lua from a (temporary) module tree under
// a minimal global stub and reports the final PAGE_FCR_AA composition. The
// override must survive the stock makePagesCommon() call — a patch placed
// before it is silently overwritten (2026-10-19 real-machine finding).
function initComposition(root) {
  const scripts = path.join(root, 'Mods', 'aircraft', 'F-16C', 'Cockpit', 'Scripts');
  const q = value => JSON.stringify(value.replace(/\\/g, '/'));
  const source = `
LockOn_Options={script_path=${q(scripts + '/')}}
BasePage='BasePage'
function clear_mode_table(t,a,b,c) for i=0,a do t[i]={} for j=0,b do t[i][j]={} for k=0,c do t[i][j][k]={} end end end end
function get_page_by_mode_global() return nil end
assert(loadfile(${q(path.join(scripts, 'Displays', 'MFD', 'indicator', 'MFD_Pages_Init.lua'))}))()
local comp=pages[PAGE_FCR_AA]
io.write('n='..#comp..'\\n')
for i=1,#comp do io.write('sub'..i..'='..tostring(page_subsets[comp[i]])..'\\n') end
`;
  const result = spawnSync(LUA, ['-'], { input: source, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, (result.stderr || '') + (result.stdout || ''));
  const out = { subs: [] };
  for (const line of result.stdout.split(/\r?\n/)) {
    const n = line.match(/^n=(\d+)$/);
    if (n) out.n = Number(n[1]);
    const sub = line.match(/^sub(\d+)=(.*)$/);
    if (sub) out.subs[Number(sub[1]) - 1] = sub[2];
  }
  return out;
}

if (!luaAvailable()) {
  test('cockpit tests require Lua 5.1', () => {
    assert.fail('Lua 5.1 luae.exe unavailable; set AESA_LUA or AESA_DCS_DIR');
  });
} else {
  test('cockpit page declares the C1.6 layout and publishes the projection model', () => {
    const out = runLuaHarness([
      'AESA1', 'seq=42', 'valid=1', 'mode=TWS', 'range=40', 'az=60', 'bars=4',
      'alt=20K', 'beam=-12', 'beam_el=10', 'own=305,8,-12', 'cursor=25,22', 'wpn=RDY',
      'track=1,-34,20,-120,22000,TRACK,140',
      'track=2,17,36,-240,18500,SEARCH,265',
      'track=3,-7,24,-350,24800,STT,40', '',
    ].join('\n'), [
      'AESA1', 'seq=43', 'valid=1', 'mode=RWS', 'range=40', 'az=60', 'bars=4',
      'alt=20K', 'beam=-12', 'cursor=25,22',
      'track=1,-34,20,-120,22000,TRACK,140',
      'track=2,17,36,-240,18500,SEARCH,265',
      'track=3,-7,24,-350,24800,TRACK,40', '',
    ].join('\n'));
    // Frame A: TWS with an STT lock.
    assert.equal(Number(out.a.elements), ELEMENT_COUNT);
    assert.equal(out.a.AESA_MODE, 'TWS');
    assert.equal(Number(out.a.AESA_TRK_1_X), -68); // az -34 x2
    assert.equal(Number(out.a.AESA_TRK_1_Y), 0);   // -240 + 20/40 x480
    assert.equal(out.a.AESA_TRK_1_STATUS, '1');
    assert.equal(out.a.AESA_TRK_1_HDG, '140');
    assert.equal(out.a.AESA_TRK_1_ALT, '22');
    assert.equal(out.a.AESA_TRK_1_HOT, '-1');      // vc -120: hotline down
    assert.equal(Number(out.a.AESA_TRK_2_Y), 192); // -240 + 36/40 x480
    assert.equal(out.a.AESA_TRK_2_TUC, '0');       // TUC suppressed while STT
    assert.equal(out.a.AESA_TRK_3_STATUS, '2');
    assert.equal(out.a.AESA_TRK_3_ALT, '25');
    assert.equal(out.a.AESA_STT_SHOW, '1');
    assert.equal(out.a.AESA_STT_ASPECT, '133L');
    assert.equal(out.a.AESA_STT_TRK, '040°');
    assert.equal(out.a.AESA_STT_CAS, '415');
    assert.equal(out.a.AESA_STT_CLOSE, '+350K');
    // Ownship attitude, antenna elevation and scan width.
    assert.equal(out.a.AESA_PITCH, '8');
    assert.equal(out.a.AESA_ROLL, '-12');
    assert.equal(out.a.AESA_BEAM_X, '-24');
    assert.equal(out.a.AESA_BEAM_EL, '20');
    assert.equal(out.a.AESA_SCAN_LIM, '120');
    assert.equal(out.a.AESA_RANGE_UP, '1');
    assert.equal(out.a.AESA_RANGE_DOWN, '1');
    assert.equal(out.a.AESA_AZ, 'A|6');
    assert.equal(out.a.AESA_WPN, 'RDY');
    // TDC cursor projection and readouts.
    assert.equal(Number(out.a.AESA_CUR_X), 50);    // cursor az 25 x2
    assert.equal(Number(out.a.AESA_CUR_Y), 24);    // -240 + 22/40 x480
    assert.equal(out.a.AESA_CUR_BRG, '141 09');    // relative to steerpoint
    assert.equal(out.a.AESA_CUR_MAX, '27');
    assert.equal(out.a.AESA_CUR_MIN, '13');
    // Frame B: STT dropped; the only SEARCH track becomes the TUC readout.
    assert.equal(out.b.AESA_STT_SHOW, '0');
    assert.equal(out.b.AESA_TRK_3_STATUS, '1');
    assert.equal(out.b.AESA_TRK_2_TUC, '1');
    assert.equal(out.b.AESA_TRK_1_TUC, '0');
    // Native geometry anchors (C1.6 alignment with the stock FCR A/A page).
    assert.equal(out.meta.pb1x, '-158');           // PB1 top label x
    assert.equal(out.meta.pb2y, '237');            // top label text edge y
    assert.equal(out.meta.m4x, '-235');            // IFF mode readout anchor
    assert.equal(out.meta.m4y, '-145');
    assert.equal(out.meta.azx, '-237');            // azimuth setting anchor
    assert.equal(out.meta.azy, '-1');
    assert.equal(out.meta.upsym, 'sym');           // native Decrement-symbol arrow
    assert.equal(out.meta.tup, '0');               // no text_using_parameter anywhere
  });

  test('invalid state clears the page instead of keeping stale tracks', () => {
    const out = runLuaHarness('AESA1\nseq=7\nvalid=0\n');
    assert.equal(out.a.AESA_MODE, '---');
    assert.equal(out.a.AESA_HINT, 'NO DATA');
    assert.equal(out.a.AESA_TRK_1_SHOW, '0');
    assert.equal(out.a.AESA_STT_SHOW, '0');
    assert.equal(out.a.AESA_RANGE_UP, '0');
    assert.equal(out.a.AESA_CUR_MAX, '');
  });

  test('controller, installer and page agree on the AESA_* parameter set', () => {
    const out = runLuaHarness('AESA1\nseq=1\nvalid=0\n');
    // The controller predeclares exactly the installer's device_init list.
    assert.deepEqual([...out.decl].sort(), [...install.AESA_PARAMS].sort());
    // The page never references a parameter nobody declares.
    for (const ref of out.refs) {
      assert.ok(install.AESA_PARAMS.includes(ref), `page references undeclared param ${ref}`);
    }
  });

  const f16 = DCS_ROOT && path.join(DCS_ROOT, 'Mods', 'aircraft', 'F-16C', 'Cockpit', 'Scripts', 'device_init.lua');
  if (f16 && fs.existsSync(f16) && !common.dcsProcesses()) {
    test('installer patches and exactly restores a temporary F-16C module', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aesa-cockpit-install-'));
      try {
        const cockpit = copyModule(root);
        const pages = path.join(cockpit, 'Scripts', 'Displays', 'MFD', 'indicator', 'MFD_Pages_Init.lua');
        const device = path.join(cockpit, 'Scripts', 'device_init.lua');
        const beforePages = fs.readFileSync(pages);
        const beforeDevice = fs.readFileSync(device);
        install.install(root, { lua: LUA });
        install.verify(root);
        assert.match(fs.readFileSync(pages, 'utf8'), /AESA_COCKPIT_C0/);
        const deviceText = fs.readFileSync(device, 'utf8');
        assert.match(deviceText, /devices\.AESA = 240/);
        // The device_init block predeclares exactly AESA_PARAMS, in order.
        const quoted = [...deviceText.matchAll(/'(AESA_[A-Z0-9_]+)'/g)].map((m) => m[1]);
        assert.deepEqual(quoted, install.AESA_PARAMS);
        const comp = initComposition(root);
        assert.equal(comp.n, 4, `PAGE_FCR_AA composition must stay the AESA override after makePagesCommon(), got: ${comp.subs.join(', ')}`);
        assert.match(comp.subs[1] || '', /FCR\/MFD_FCR_AESA_AA\.lua$/);
        assert.match(comp.subs[2] || '', /MFD_BASE_MENU\.lua$/);
        install.uninstall(root);
        assert.deepEqual(fs.readFileSync(pages), beforePages);
        assert.deepEqual(fs.readFileSync(device), beforeDevice);
        assert.equal(fs.existsSync(path.join(cockpit, 'Scripts', 'AESA', 'controller.lua')), false);
        assert.equal(fs.existsSync(path.join(cockpit, 'Scripts', 'AESA', 'manifest.json')), false);
        assert.equal(fs.existsSync(path.join(cockpit, 'Scripts', 'Displays', 'MFD', 'indicator', 'Pages', 'FCR', 'MFD_FCR_AESA_AA.lua')), false);
        assert.throws(() => install.verify(root), /not installed/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
