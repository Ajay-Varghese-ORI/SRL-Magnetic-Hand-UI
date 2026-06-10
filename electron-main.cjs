const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");

function createWindow()
{
    const win = new BrowserWindow(
    {
        width: 1400,
        height: 900,
        title: "SRL Hand",
        webPreferences:
        {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    const session = win.webContents.session;

    session.on("select-serial-port", async (event, portList, webContents, callback) =>
    {
        event.preventDefault();

        if (portList.length === 0)
        {
            await dialog.showMessageBox(win,
            {
                type: "warning",
                title: "No Serial Ports Found",
                message: "No serial ports were found.",
                detail: "Check that the device is plugged in and that no other program is using the port.",
                buttons:
                [
                    "OK"
                ]
            });

            callback("");
            return;
        }

        const portLabels = portList.map((port, index) =>
        {
            return getSerialPortLabel(port, index);
        });

        const buttons =
        [
            ...portLabels,
            "Cancel"
        ];

        const result = await dialog.showMessageBox(win,
        {
            type: "question",
            title: "Select Serial Port",
            message: "Select the COM port to connect to.",
            detail: "Choose the serial port for the SRL Hand connection.",
            buttons: buttons,
            cancelId: buttons.length - 1,
            defaultId: 0,
            noLink: true
        });

        const selectedIndex = result.response;

        if (selectedIndex < 0 || selectedIndex >= portList.length)
        {
            console.log("Serial port selection cancelled.");
            callback("");
            return;
        }

        const selectedPort = portList[selectedIndex];

        console.log("Selected serial port:");
        console.table(selectedPort);

        callback(selectedPort.portId);
    });

    session.setPermissionCheckHandler((webContents, permission) =>
    {
        if (permission === "serial")
        {
            return true;
        }

        return false;
    });

    session.setDevicePermissionHandler((details) =>
    {
        if (details.deviceType === "serial")
        {
            return true;
        }

        return false;
    });

    win.loadFile(path.join(__dirname, "index.html"));

    // win.webContents.openDevTools();
}

function getSerialPortLabel(port, index)
{
    const name = port.portName || port.displayName || `Serial Port ${index + 1}`;
    const vendorId = port.vendorId || port.usbVendorId;
    const productId = port.productId || port.usbProductId;

    let label = name;

    if (vendorId || productId)
    {
        label += " ";

        if (vendorId)
        {
            label += `VID:${vendorId}`;
        }

        if (vendorId && productId)
        {
            label += " ";
        }

        if (productId)
        {
            label += `PID:${productId}`;
        }
    }

    return label;
}

app.whenReady().then(() =>
{
    createWindow();

    app.on("activate", () =>
    {
        if (BrowserWindow.getAllWindows().length === 0)
        {
            createWindow();
        }
    });
});

app.on("window-all-closed", () =>
{
    if (process.platform !== "darwin")
    {
        app.quit();
    }
});