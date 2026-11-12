import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  const crcInput = Buffer.concat([typeBuf, data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeRgbaPng(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) {
    throw new Error('Invalid PNG signature');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let ihdrData = null;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdrData = Buffer.from(data);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error(`Unsupported PNG format: depth=${data[8]} color=${data[9]} interlace=${data[12]}`);
      }
    } else if (type === 'IDAT') {
      idats.push(data);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const byte = raw[rowIn + x];
      const a = x >= bpp ? pixels[rowOut + x - bpp] : 0;
      const b = y > 0 ? pixels[rowOut - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[rowOut - stride + x - bpp] : 0;
      let val = byte;
      if (filter === 1) val = (byte + a) & 0xff;
      else if (filter === 2) val = (byte + b) & 0xff;
      else if (filter === 3) val = (byte + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (byte + paeth(a, b, c)) & 0xff;
      pixels[rowOut + x] = val;
    }
  }
  return { width, height, ihdrData, pixels };
}

function optimizePng(filePath) {
  const beforeBuf = readFileSync(filePath);
  const { width, height, ihdrData, pixels } = decodeRgbaPng(beforeBuf);
  const origPixels = Buffer.from(pixels);

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) {
      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
    }
  }

  const bpp = 4;
  const stride = width * bpp;
  const outRaw = Buffer.alloc(height * (stride + 1));
  const cands = Array.from({ length: 5 }, () => Buffer.alloc(stride));

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    let bestF = 0;
    let bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      const dst = cands[f];
      for (let x = 0; x < stride; x++) {
        const cur = pixels[rowOff + x];
        const a = x >= bpp ? pixels[rowOff + x - bpp] : 0;
        const b = y > 0 ? pixels[rowOff - stride + x] : 0;
        const c = x >= bpp && y > 0 ? pixels[rowOff - stride + x - bpp] : 0;
        let d = cur;
        if (f === 1) d = (cur - a) & 0xff;
        else if (f === 2) d = (cur - b) & 0xff;
        else if (f === 3) d = (cur - ((a + b) >> 1)) & 0xff;
        else if (f === 4) d = (cur - paeth(a, b, c)) & 0xff;
        dst[x] = d;
        score += d < 128 ? d : 256 - d;
      }
      if (score < bestScore) {
        bestScore = score;
        bestF = f;
      }
    }
    const outOff = y * (stride + 1);
    outRaw[outOff] = bestF;
    cands[bestF].copy(outRaw, outOff + 1);
  }

  const compressed = deflateSync(outRaw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const afterBuf = Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);

  const check = decodeRgbaPng(afterBuf);
  if (check.width !== width || check.height !== height) {
    throw new Error(`Dimension mismatch on ${filePath}`);
  }
  for (let i = 0; i < origPixels.length; i += 4) {
    const aOrig = origPixels[i + 3];
    const aNew = check.pixels[i + 3];
    if (aOrig !== aNew) throw new Error(`Alpha mismatch at byte ${i}`);
    if (aOrig > 0) {
      if (
        origPixels[i] !== check.pixels[i] ||
        origPixels[i + 1] !== check.pixels[i + 1] ||
        origPixels[i + 2] !== check.pixels[i + 2]
      ) {
        throw new Error(`RGB mismatch on visible pixel at byte ${i}`);
      }
    }
  }

  if (afterBuf.length < beforeBuf.length) {
    writeFileSync(filePath, afterBuf);
  }
  return {
    file: filePath.slice(rootDir.length + 1),
    beforeBytes: beforeBuf.length,
    afterBytes: Math.min(beforeBuf.length, afterBuf.length),
  };
}

function optimizeWav(filePath) {
  const buf = readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV header');
  }
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  if (channels === 1 && sampleRate === 24000) {
    return { file: filePath.slice(rootDir.length + 1), beforeBytes: buf.length, afterBytes: buf.length, idempotent: true };
  }
  if (channels !== 2 || sampleRate !== 48000 || bitsPerSample !== 16) {
    throw new Error(`Unexpected WAV format: ch=${channels} sr=${sampleRate} bps=${bitsPerSample}`);
  }

  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4);
    const chunkLen = buf.readUInt32LE(dataOffset + 4);
    if (chunkId === 'data') {
      dataOffset += 8;
      dataSize = chunkLen;
      break;
    }
    dataOffset += 8 + chunkLen;
  }

  const totalFrames = Math.floor(dataSize / 4);
  const mono48k = new Float64Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const off = dataOffset + i * 4;
    const l = buf.readInt16LE(off);
    const r = buf.readInt16LE(off + 2);
    mono48k[i] = 0.5 * (l + r);
  }

  const threshold = 48;
  let startFrame = 0;
  while (startFrame < totalFrames && Math.abs(mono48k[startFrame]) <= threshold) startFrame++;
  let endFrame = totalFrames - 1;
  while (endFrame > startFrame && Math.abs(mono48k[endFrame]) <= threshold) endFrame--;

  startFrame = Math.max(0, startFrame - 96);
  endFrame = Math.min(totalFrames - 1, endFrame + 96);

  const trimmedLen = endFrame - startFrame + 1;
  const outFrames = Math.floor(trimmedLen / 2);
  const outSampleRate = 24000;
  const outSamples = new Int16Array(outFrames);
  const fadeFrames = Math.min(48, Math.floor(outFrames / 10));

  for (let j = 0; j < outFrames; j++) {
    const idx = startFrame + j * 2;
    const prev = idx > startFrame ? mono48k[idx - 1] : mono48k[idx];
    const cur = mono48k[idx];
    const next = idx + 1 <= endFrame ? mono48k[idx + 1] : cur;
    let filtered = 0.25 * prev + 0.5 * cur + 0.25 * next;
    if (j < fadeFrames) filtered *= j / fadeFrames;
    else if (j >= outFrames - fadeFrames) filtered *= (outFrames - 1 - j) / fadeFrames;
    outSamples[j] = Math.max(-32768, Math.min(32767, Math.round(filtered)));
  }

  const pcmBytes = outFrames * 2;
  const outBuf = Buffer.alloc(44 + pcmBytes);
  outBuf.write('RIFF', 0, 'ascii');
  outBuf.writeUInt32LE(36 + pcmBytes, 4);
  outBuf.write('WAVE', 8, 'ascii');
  outBuf.write('fmt ', 12, 'ascii');
  outBuf.writeUInt32LE(16, 16);
  outBuf.writeUInt16LE(1, 20);
  outBuf.writeUInt16LE(1, 22);
  outBuf.writeUInt32LE(outSampleRate, 24);
  outBuf.writeUInt32LE(outSampleRate * 2, 28);
  outBuf.writeUInt16LE(2, 32);
  outBuf.writeUInt16LE(16, 34);
  outBuf.write('data', 36, 'ascii');
  outBuf.writeUInt32LE(pcmBytes, 40);
  for (let j = 0; j < outFrames; j++) {
    outBuf.writeInt16LE(outSamples[j], 44 + j * 2);
  }

  writeFileSync(filePath, outBuf);
  return {
    file: filePath.slice(rootDir.length + 1),
    beforeBytes: buf.length,
    afterBytes: outBuf.length,
    durationMs: Math.round((outFrames / outSampleRate) * 1000),
  };
}

const orphanSvg = join(rootDir, 'assets', 'logo.svg');
if (existsSync(orphanSvg)) {
  rmSync(orphanSvg);
  console.log('Removed orphaned assets/logo.svg');
}

const results = [
  optimizePng(join(rootDir, 'sidecars', 'pet_panel', 'pet.png')),
  optimizePng(join(rootDir, 'sidecars', 'pet_panel', 'pet-claude.png')),
  optimizePng(join(rootDir, 'assets', 'logo.png')),
  optimizeWav(join(rootDir, 'sidecars', 'pet_panel', 'nyaa.wav')),
];

console.table(results);
