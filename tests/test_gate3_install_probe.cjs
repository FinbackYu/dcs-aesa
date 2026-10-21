'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BEGIN, END, span } = require('../scripts/install_compat_probe.cjs');

function fixture(nl = '\r\n') {
  const before = [
    '-- header',
    'pcall(function() local dcsSr=require("lfs");dofile(dcsSr.writedir()..[[Mods\\Services\\DCS-SRS\\Scripts\\DCS-SimpleRadioStandalone.lua]]); end,nil)',
    '',
    '',
  ].join(nl);
  const block = [
    BEGIN,
    'pcall(function()',
    '    local fsapi = require("lfs")',
    'end)',
    END,
    '',
  ].join(nl);
  return { before, block, raw: Buffer.from(before + block) };
}

test('compat probe marker span uses byte offsets on CRLF files', () => {
  const { before, block, raw } = fixture('\r\n');
  const [begin, end] = span(raw);
  assert.equal(raw.subarray(0, begin).toString('utf8'), before);
  assert.equal(raw.subarray(begin, end).toString('utf8'), block);
  assert.equal(raw.subarray(end).toString('utf8'), '');
});

test('compat probe marker span keeps the SRS line intact', () => {
  const { before, raw } = fixture('\r\n');
  const [begin] = span(raw);
  const head = raw.subarray(0, begin).toString('utf8');
  assert.ok(head.includes('DCS-SimpleRadioStandalone.lua'), 'SRS loader must survive');
  assert.ok(head.endsWith('\r\n\r\n'), 'separator before the marker must survive');
});

test('compat probe marker span rejects incomplete or duplicate markers', () => {
  const nl = '\r\n';
  assert.throws(() => span(Buffer.from(`x${nl}${BEGIN}${nl}`)), /incomplete/);
  assert.throws(() => span(Buffer.from(`${BEGIN}${nl}${END}${nl}${BEGIN}${nl}${END}${nl}`)), /duplicated/);
  assert.equal(span(Buffer.from('plain file\n')), null);
});
