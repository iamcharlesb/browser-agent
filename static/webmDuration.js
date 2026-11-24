(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiloWebM = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";
  function element(bytes, offset) {
    function vint(at, id) {
      var first = bytes[at], length = 1, mask = 128;
      if (!first) throw new Error("Invalid EBML element.");
      while (!(first & mask)) { length++; mask >>= 1; }
      if (length > (id ? 4 : 8) || at + length > bytes.length) throw new Error("Invalid EBML length.");
      var value = BigInt(id ? first : first & (mask - 1));
      for (var i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[at + i]);
      return { length: length, value: value, unknown: !id && value === (1n << BigInt(7 * length)) - 1n };
    }
    var id = vint(offset, true), size = vint(offset + id.length, false);
    var data = offset + id.length + size.length;
    return { id: Number(id.value), sizeOffset: offset + id.length, sizeLength: size.length,
      unknown: size.unknown, data: data, end: size.unknown ? bytes.length : data + Number(size.value) };
  }
  // MediaRecorder produces a streaming WebM Segment with an unknown size and no
  // duration. Insert Duration into Info so saved takes have a usable timeline.
  function setDuration(bytes, milliseconds) {
    try {
      var segment, info, scale = 1000000;
      for (var at = 0; at < bytes.length;) { var item = element(bytes, at); if (item.id === 0x18538067) { segment = item; break; } at = item.end; }
      if (!segment || !segment.unknown) return bytes;
      for (at = segment.data; at < segment.end;) {
        item = element(bytes, at);
        if (item.id === 0x114d9b74) return bytes; // Do not invalidate SeekHead offsets.
        if (item.id === 0x1549a966) { info = item; break; }
        if (item.end <= at) return bytes; at = item.end;
      }
      if (!info || info.unknown || info.end > bytes.length) return bytes;
      var duration;
      for (at = info.data; at < info.end;) {
        item = element(bytes, at);
        if (item.id === 0x2ad7b1) { scale = 0; for (var i = item.data; i < item.end; i++) scale = scale * 256 + bytes[i]; }
        if (item.id === 0x4489) duration = item;
        if (item.end <= at) return bytes; at = item.end;
      }
      if (!Number.isFinite(milliseconds) || milliseconds <= 0 || scale <= 0) return bytes;
      var value = milliseconds * 1000000 / scale;
      if (duration && duration.end - duration.data === 8) {
        var copy = bytes.slice(); new DataView(copy.buffer).setFloat64(duration.data, value); return copy;
      }
      if (duration) return bytes;
      var length = info.end - info.data + 11;
      if (BigInt(length) >= (1n << BigInt(7 * info.sizeLength)) - 1n) return bytes;
      var result = new Uint8Array(bytes.length + 11);
      result.set(bytes.subarray(0, info.end)); result.set([0x44, 0x89, 0x88], info.end);
      new DataView(result.buffer).setFloat64(info.end + 3, value);
      result.set(bytes.subarray(info.end), info.end + 11);
      var encoded = BigInt(length) | (1n << BigInt(7 * info.sizeLength));
      for (i = info.sizeLength - 1; i >= 0; i--) { result[info.sizeOffset + i] = Number(encoded & 255n); encoded >>= 8n; }
      return result;
    } catch (_) { return bytes; }
  }
  return { setDuration: setDuration };
});
