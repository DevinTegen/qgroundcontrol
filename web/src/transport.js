// Byte transports the browser can use: Web Serial (USB) and WebSocket (Wi-Fi bridges).

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class WebSerialTransport {
  constructor(baudRate) {
    this.baudRate = baudRate;
    this.onData = () => {};
    this.onClose = () => {};
    this.label = `USB serial @ ${baudRate}`;
  }

  async connect() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baudRate, bufferSize: 65536 });
    this.writer = this.port.writable.getWriter();
    this._closing = false;
    this._readLoop();
  }

  async _readLoop() {
    while (this.port?.readable && !this._closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) {
            break;
          }
          if (value) {
            this.onData(value);
          }
        }
      } catch (e) {
        console.warn('Serial read error', e);
      } finally {
        this.reader.releaseLock();
      }
      if (!this._closing) {
        break; // device unplugged
      }
    }
    if (!this._closing) {
      this.onClose('Serial device disconnected');
    }
  }

  async send(bytes) {
    await this.writer?.write(bytes);
  }

  async close() {
    this._closing = true;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port?.close(); } catch { /* already closed */ }
    this.onClose('Disconnected');
  }
}

export class WebSocketTransport {
  constructor(url) {
    this.url = url;
    this.onData = () => {};
    this.onClose = () => {};
    this.label = url;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`No answer from ${this.url}`));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${this.url}`));
      };
      ws.onmessage = (ev) => this.onData(new Uint8Array(ev.data));
      ws.onclose = () => this.onClose('Wi-Fi connection closed');
    });
  }

  async send(bytes) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }

  async close() {
    this.ws?.close();
  }
}
