const test = require('node:test');
const assert = require('node:assert/strict');
const {setDuration} = require('../static/webmDuration');
test('streaming WebM gets a finite duration without modifying cluster bytes',()=>{
  const bytes=Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x80, 0x18,0x53,0x80,0x67,0xff, 0x15,0x49,0xa9,0x66,0x87, 0x2a,0xd7,0xb1,0x83,0x0f,0x42,0x40, 0x1f,0x43,0xb6,0x75,0x80]);
  const output=setDuration(bytes,1250);
  assert.equal(output.length,bytes.length+11);
  assert.equal(output[14],0x92);
  assert.deepEqual([...output.subarray(22,25)],[0x44,0x89,0x88]);
  assert.equal(new DataView(output.buffer).getFloat64(25),1250);
  assert.deepEqual([...output.subarray(-5)],[0x1f,0x43,0xb6,0x75,0x80]);
  const replaced=setDuration(output,1500);
  assert.equal(replaced.length,output.length);
  assert.equal(new DataView(replaced.buffer).getFloat64(25),1500);
});
test('invalid or unsupported containers are left intact',()=>{
  const invalid=Uint8Array.from([0,1,2]);
  assert.equal(setDuration(invalid,1000),invalid);
  const finiteSegment=Uint8Array.from([0x18,0x53,0x80,0x67,0x80]);
  assert.equal(setDuration(finiteSegment,1000),finiteSegment);
});
