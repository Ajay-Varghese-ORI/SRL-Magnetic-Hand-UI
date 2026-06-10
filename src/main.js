import { connectSerial } from "./serial.js";
import { initViewer, resetCamera } from "./viewer.js";

const viewerElement = document.getElementById("viewer");
const connectSerialButton = document.getElementById("connectSerialButton");
const resetViewButton = document.getElementById("resetViewButton");
const clearLogButton = document.getElementById("clearLogButton");
const statusElement = document.getElementById("status");
const lastMessageElement = document.getElementById("lastMessage");

initViewer(viewerElement);

connectSerialButton.addEventListener("click", async () =>
{
    statusElement.textContent = "Connecting...";

    try
    {
        await connectSerial(
            (text) =>
            {
                console.log("Received serial text:", text);
                lastMessageElement.textContent = text;
            },
            (newStatus) =>
            {
                statusElement.textContent = newStatus;
            }
        );
    }
    catch (err)
    {
        console.error(err);
        statusElement.textContent = "Error: " + err.message;
    }
});

resetViewButton.addEventListener("click", () =>
{
    resetCamera();
});

clearLogButton.addEventListener("click", () =>
{
    lastMessageElement.textContent = "";
    console.clear();
});
