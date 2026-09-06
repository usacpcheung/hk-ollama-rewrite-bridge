const fs = require('node:fs/promises');
const path = require('node:path');

async function prepareDirectory(root) {
  await fs.mkdir(root, { mode: 0o700, recursive: true });
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
    throw new Error('Transcription directory must be private and owned by the service');
  }
  // Only our exact job names for dead processes qualify for crash cleanup.
  // Live processes (and permission-denied PID checks) are always left alone.
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const match = /^job-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    let dead = false;
    try { process.kill(Number(match[1]), 0); } catch (error) { dead = error.code === 'ESRCH'; }
    if (dead) await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

async function createJobDirectory(root) {
  return fs.mkdtemp(path.join(root, `job-${process.pid}-`));
}
module.exports = { prepareDirectory, createJobDirectory };
