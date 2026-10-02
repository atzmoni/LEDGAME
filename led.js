// Web Bluetooth driver for the duoCo StripX MELK-OA10 controller.
// Frames are 9 bytes: 7E <len> <op> ... EF, no checksum, write-without-response on FFF0/FFF3.
const SERVICE = 0xfff0, WRITE = 0xfff3, NOTIFY = 0xfff4;

export const frames = {
  on:  () => [0x7E, 0x04, 0x04, 0xF0, 0x00, 0x01, 0xFF, 0x00, 0xEF],
  off: () => [0x7E, 0x04, 0x04, 0x00, 0x00, 0x00, 0xFF, 0x00, 0xEF],
  rgb: (r, g, b, fmt = "a") => fmt === "a"
    ? [0x7E, 0x07, 0x05, 0x03, r, g, b, 0x10, 0xEF]
    : [0x7E, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xEF],
  bri: v => [0x7E, 0x04, 0x01, v, 0x01, 0xFF, 0xFF, 0x00, 0xEF],
  fx:  id => [0x7E, 0x05, 0x03, id, 0x06, 0xFF, 0xFF, 0x00, 0xEF],
  spd: v => [0x7E, 0x04, 0x02, v, 0xFF, 0xFF, 0xFF, 0x00, 0xEF],
  // Controller's built-in microphone. Verified on MELK-OC21 only; the EQ frame is what engages reactive mode.
  mic:   on => [0x7E, 0x04, 0x07, on ? 1 : 0, 0xFF, 0xFF, 0xFF, 0x00, 0xEF],
  micEq: eq => [0x7E, 0x07, 0x03, 0x80 + eq, 0x04, 0xFF, 0xFF, 0x00, 0xEF],
  micSens: v => [0x7E, 0x04, 0x06, v, 0xFF, 0xFF, 0xFF, 0x00, 0xEF],
  // State query listed for MELK-OA10 by elkbledom; any answer arrives on FFF4.
  query: () => [0x7E, 0x00, 0x01, 0xFA, 0x00, 0x00, 0x00, 0x00, 0xEF],
  // Addressable pixel count, 16-bit little-endian. Persists in the controller, like the duoCo app's own setting.
  count: n => [0x7E, 0x07, 0x21, n & 0xFF, (n >> 8) & 0xFF, 0x00, 0xFF, 0x00, 0xEF],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Strip extends EventTarget {
  constructor() { super(); this.ch = null; this.queue = Promise.resolve(); this.pending = 0; }

  get connected() { return !!this.ch; }

  async connect() {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "MELK" }, { namePrefix: "ELK" }, { namePrefix: "OA10" }],
      optionalServices: [SERVICE],
    });
    dev.addEventListener("gattserverdisconnected", () => {
      this.ch = null;
      this.dispatchEvent(new Event("disconnect"));
    });
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    this.ch = await svc.getCharacteristic(WRITE);
    // Handshake the open-source integration sends to MELK units first.
    await this.send([0x7E, 0x07, 0x83]);
    await sleep(300);
    await this.send([0x7E, 0x04, 0x04]);
    this.svc = svc;
    return dev.name || "";
  }

  // Optional read-back channel; OC21 units stay silent, OA10 may answer queries on FFF4.
  // Subscribed only on request: on Android a pending GATT call makes concurrent writes fail.
  async listen() {
    if (this.canListen) return true;
    try {
      const n = await this.svc.getCharacteristic(NOTIFY);
      n.addEventListener("characteristicvaluechanged", e =>
        this.dispatchEvent(new CustomEvent("notify", { detail: new Uint8Array(e.target.value.buffer) })));
      await Promise.race([n.startNotifications(), sleep(3000).then(() => { throw new Error("timeout"); })]);
      this.canListen = true;
    } catch { this.canListen = false; }
    return this.canListen;
  }

  // Serialized writes with a 30 ms gap; the controller drops frames sent back to back.
  send(bytes) {
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        if (!this.ch) return;
        const data = new Uint8Array(bytes);
        if (this.ch.writeValueWithoutResponse) await this.ch.writeValueWithoutResponse(data);
        else await this.ch.writeValue(data);
        this.dispatchEvent(new CustomEvent("sent", { detail: data }));
      } catch (e) {
        this.dispatchEvent(new CustomEvent("error", { detail: e }));
      } finally {
        this.pending--;
      }
      await sleep(30);
    });
    return this.queue;
  }

  // Drops the frame when the queue is backed up, so live controls never lag behind the hand.
  sendLatest(bytes) { if (this.pending < 2) this.send(bytes); }
}

// Inside the LedGame hub, every tab is a same-origin iframe that reuses the hub's one Bluetooth connection.
export const embedded = (() => { try { return window.parent !== window && !!window.parent.ledgameStrip; } catch { return false; } })();
if (embedded) document.documentElement.classList.add("embedded");

export function sharedStrip() {
  if (embedded) return window.parent.ledgameStrip;
  return (window.ledgameStrip ||= new Strip());
}

export function colorFormat() {
  try { return localStorage.getItem("ledgame.fmt") || "a"; } catch { return "a"; }
}
export function setColorFormat(f) {
  try { localStorage.setItem("ledgame.fmt", f); } catch {}
}

// Hue 0-360 to RGB at full saturation and value.
export function hueToRgb(h) {
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}
