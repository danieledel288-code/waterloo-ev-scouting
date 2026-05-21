// Web Serial wrapper for the LoRa pit-side USB receiver.
// Browsers: Chrome / Edge only. Safari has no Web Serial.

export const isWebSerialSupported = () =>
  typeof navigator !== 'undefined' && !!navigator.serial;

/**
 * Open the user-picked serial port at 115200, read newline-delimited bytes,
 * call onLine() per line. Returns a controller with .disconnect().
 *
 *   const ctrl = await connectLora({ onLine: handleLine, onClose: r => ... });
 *   await ctrl.disconnect();
 */
export async function connectLora({ baudRate = 115200, onLine, onClose }) {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge.');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  if (!port.readable) throw new Error('Serial port has no readable stream');

  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let active = true;

  (async function readLoop() {
    try {
      while (active) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.trim()) onLine(line);
        }
      }
    } catch (err) {
      if (onClose) onClose(String(err));
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  })();

  return {
    disconnect: async () => {
      active = false;
      try { await reader.cancel(); } catch {}
      try { await port.close(); } catch {}
      if (onClose) onClose('disconnected');
    },
  };
}
