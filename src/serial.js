let port;
let reader;
let keepReading = false;

export async function connectSerial(onData, onStatus) {
  if (!("serial" in navigator)) {
    throw new Error("Web Serial is not supported in this browser. Use Chrome or Edge.");
  }

  port = await navigator.serial.requestPort();

  await port.open({
    baudRate: 115200
  });

  onStatus?.("Connected");

  reader = port.readable.getReader();
  keepReading = true;

  readLoop(onData);
}

async function readLoop(onData) {
  const textDecoder = new TextDecoder();

  try {
    while (keepReading) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      // value is the raw byte array from the serial port
      console.log("Raw bytes:", value);

      // Decode bytes as text
      const text = textDecoder.decode(value, {
        stream: true
      });

      console.log("Raw text:", text);

      if (onData) {
        onData(text);
      }
    }
  } catch (err) {
    console.error("Serial read error:", err);
  }
}

export async function disconnectSerial() {
  keepReading = false;

  if (reader) {
    await reader.cancel();
    reader.releaseLock();
  }

  if (port) {
    await port.close();
  }
}