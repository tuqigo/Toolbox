const fs = require('fs');
const path = require('path');
const os = require('os');
const fsExtra = require('fs-extra');

class FileLogger {
  constructor(options = {}) {
    this.dir = options.dir || '';
    this.prefix = options.prefix || 'MiniToolbox';
    this.maxSizeBytes = Number(options.maxSizeBytes || 5 * 1024 * 1024); // 5MB
    this.stream = null;
    this.currentFile = '';
    this.originalConsole = null;
  }

  ensureDir() {
    try { fsExtra.mkdirpSync(this.dir); } catch {}
  }

  getLogFilePath() {
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return path.join(this.dir, `${this.prefix}-${yyyy}${mm}${dd}.log`);
  }

  rotateIfNeeded() {
    try {
      if (!this.currentFile) return;
      const stat = fs.existsSync(this.currentFile) && fs.statSync(this.currentFile);
      if (stat && stat.size >= this.maxSizeBytes) {
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const rotated = this.currentFile.replace(/\.log$/, `-${ts}.log`);
          fs.renameSync(this.currentFile, rotated);
        } catch {}
        this.reopen();
      }
    } catch {}
  }

  reopen() {
    try { if (this.stream) { this.stream.end(); this.stream = null; } } catch {}
    this.ensureDir();
    this.currentFile = this.getLogFilePath();
    this.stream = fs.createWriteStream(this.currentFile, { flags: 'a', encoding: 'utf8' });
  }

  writeLine(level, message) {
    try {
      if (!this.stream) this.reopen();
      const time = new Date().toISOString();
      const line = `[${time}] [${level}] ${message}${os.EOL}`;
      this.stream.write(line);
      this.rotateIfNeeded();
    } catch {}
  }

  patchConsole() {
    if (this.originalConsole) return;
    this.originalConsole = {
      log: console.log.bind(console),
      info: console.info ? console.info.bind(console) : console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
    };

    const forward = (level, args) => {
      try {
        const text = args.map(a => {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
          }
          return String(a);
        }).join(' ');
        this.writeLine(level, text);
      } catch {}
    };

    console.log = (...args) => { try { this.originalConsole.log(...args); } catch {} forward('LOG', args); };
    console.info = (...args) => { try { this.originalConsole.info(...args); } catch {} forward('INFO', args); };
    console.warn = (...args) => { try { this.originalConsole.warn(...args); } catch {} forward('WARN', args); };
    console.error = (...args) => { try { this.originalConsole.error(...args); } catch {} forward('ERROR', args); };
    console.debug = (...args) => { try { this.originalConsole.debug(...args); } catch {} forward('DEBUG', args); };
  }

  unpatchConsole() {
    if (!this.originalConsole) return;
    console.log = this.originalConsole.log;
    console.info = this.originalConsole.info;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.debug = this.originalConsole.debug;
    this.originalConsole = null;
  }

  close() {
    try { if (this.stream) { this.stream.end(); this.stream = null; } } catch {}
  }
}

module.exports = { FileLogger };


