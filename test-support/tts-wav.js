function wav() {
  const data = Buffer.alloc(44 + 4800);
  data.write('RIFF'); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(24000,24); data.writeUInt32LE(48000,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34);
  data.write('data',36); data.writeUInt32LE(4800,40); return data;
}
const payload = () => ({ candidates: [{ finishReason:'STOP', content: { parts: [{ inlineData: { mimeType:'audio/wav', data:wav().toString('base64') } }] } }] });
module.exports = { wav, payload };
