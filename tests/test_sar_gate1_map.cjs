'use strict';
// Gate 1 regression: MAP collection and rendering share one canonical grid.
// Export/Collector use col -> +x, row -> +z (see src/export/aesa_sar_export.lua), so the renderer's
// matrix must use the same mapping: index = row*n+col, x = x0+col*step, z = z0+row*step. The previous
// renderer used row -> +x and col -> -z, which transposed and mirrored every frame relative to the DEM.
const test=require('node:test'),assert=require('node:assert/strict');
const map=require('../src/sar_core/map.cjs');

test('MAP render interprets the matrix as canonical col=x, row=z and declares col_x_row_z',()=>{
  const cell=250,n=21,center=[0,0];
  const cache=map.createCache({cell_m:cell});
  for(let ix=-20;ix<=20;ix++)for(let iz=-20;iz<=20;iz++){
    cache.setHeight(ix,iz,100);
    cache.setSurface(ix,iz,'land');
  }
  // A narrow wedge pointing along +z: only some rows/columns are inside, so a transposed or mirrored
  // render cannot accidentally match the mask. heading=0 is +z in this project's atan2(dx,dz) convention.
  const sector={heading:0,azimuth_deg:8,range_m:1500};
  const request={center,sensor:[0,3000,0],cells:n,cell_m:cell,sector};
  const result=map.renderFrame(cache,request);
  assert.equal(result.metadata.grid_layout,'col_x_row_z','the tile states the layout its matrix uses');
  const half=(n-1)/2,mask=map.sectorMask({center,heading:sector.heading,azimuth_deg:sector.azimuth_deg,range_m:sector.range_m});
  let inside=0,outside=0;
  for(let row=0;row<n;row++)for(let col=0;col<n;col++){
    const index=row*n+col,x=center[0]+(col-half)*cell,z=center[1]+(row-half)*cell;
    const expected=mask(x,z),noData=Number.isNaN(result.db[index]);
    assert.equal(noData,!expected,`cell col=${col} row=${row} at world x=${x} z=${z} follows col=x,row=z`);
    if(expected)inside++;else outside++;
  }
  assert.ok(inside>0&&outside>0,'the fixture exercises both sides of the wedge');
  assert.equal(result.metadata.sector.cells,inside);
  assert.equal(result.metadata.sector.outside_cells,outside);
  // An explicit canonical declaration is accepted and reported.
  const explicit=map.renderFrame(cache,{...request,grid_layout:'col_x_row_z'});
  assert.equal(explicit.metadata.grid_layout,'col_x_row_z');
  assert.deepEqual(explicit.db,result.db,'the default is the canonical layout, not a second mode');
  // Unknown layouts fail closed instead of silently guessing an orientation.
  assert.throws(()=>map.renderFrame(cache,{...request,grid_layout:'legacy_x_row_negz_col'}),/Invalid map grid layout/);
  assert.throws(()=>map.renderFrame(cache,{...request,grid_layout:'x_col_z_row'}),/Invalid map grid layout/);
});

test('MAP anchor and metadata keep the frame centred on the lattice point',()=>{
  const cell=250,n=33;
  const cache=map.createCache({cell_m:cell});
  for(let ix=-20;ix<=20;ix++)for(let iz=-20;iz<=20;iz++){cache.setHeight(ix,iz,100);cache.setSurface(ix,iz,'land');}
  const result=map.renderFrame(cache,{center:[520,0],sensor:[520,3000,0],cells:n,cell_m:cell});
  assert.deepEqual(result.metadata.center,[500,0],'the origin snaps to the lattice');
  assert.equal(result.metadata.cell_m,cell);
  assert.equal(result.metadata.span_m,(n-1)*cell);
  assert.equal(result.metadata.grid_layout,'col_x_row_z');
  const anchor=map.anchor(result);
  assert.deepEqual(anchor.center,[500,anchor.center[1],0]);
  assert.equal(anchor.bearing,0);
});
