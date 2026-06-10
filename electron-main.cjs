const { app, BrowserWindow } = require("electron/main");
const path = require("node:path");

const isDev = !app.isPackaged;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "SRL Hand",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const session = mainWindow.webContents.session;

  session.on("select-serial-port", (event, portList, webContents, callback) => {
    event.preventDefault();

    console.log("Available serial ports:", portList);

    if (portList && portList.length > 0) {
      callback(portList[0].portId);
    } else {
      callback("");
    }
  });

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === "serial") {
      return true;
    }

    return false;
  });

  session.setDevicePermissionHandler((details) => {
    if (details.deviceType === "serial") {
      return true;
    }

    return false;
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});