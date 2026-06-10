import { useEffect, useRef, useState } from "react";
import "./style.css";
import { connectSerial } from "./serial";
import { initViewer, resetCamera } from "./viewer";

function App() {
  const viewerRef = useRef(null);
  const [status, setStatus] = useState("Not connected");
  const [lastMessage, setLastMessage] = useState("");

  useEffect(() => {
    initViewer(viewerRef.current);
  }, []);

  async function handleConnect() {
    setStatus("Connecting...");

    try {
      await connectSerial(
        (text) => {
          console.log("Received serial text:", text);
          setLastMessage((previous) => text);
        },
        (newStatus) => {
          setStatus(newStatus);
        }
      );
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }

  return (
    <div className="app">
      <div className="sidebar">
        <h1>SRL Hand</h1>

        <button onClick={handleConnect}>
          Connect Serial
        </button>

        <button onClick={resetCamera}>
          Reset View
        </button>

        <p>Status: {status}</p>

        <h3>Last Message</h3>
        <pre>{lastMessage}</pre>
      </div>

      <div className="viewer" ref={viewerRef}></div>
    </div>
  );
}

export default App;