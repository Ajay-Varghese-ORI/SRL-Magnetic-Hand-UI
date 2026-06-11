let socket = null;
let isConnected = false;

/**
 * Connect to a rosbridge websocket and subscribe to magnetic hand topics.
 *
 * @param {object} options Connection and topic options.
 * @param {string} options.url rosbridge websocket URL.
 * @param {string} options.frameTopic ROS topic that publishes MagneticHandFrame messages.
 * @param {string} options.metadataTopic ROS topic that publishes SensorMetadataArray messages.
 * @param {Function} options.onFrame Called with every frame message.
 * @param {Function} options.onMetadata Called with metadata messages.
 * @param {Function} options.onStatus Called with human-readable status text.
 * @param {Function} options.onError Called with errors.
*/
export function connectRosBridge(options)
{
    disconnectRosBridge();

    const url = options.url;
    const frameTopic = options.frameTopic;
    const metadataTopic = options.metadataTopic;

    socket = new WebSocket(url);

    socket.addEventListener("open", () =>
    {
        isConnected = true;
        options.onStatus?.(`Connected to ROS bridge at ${url}`);

        subscribe(frameTopic);

        if (metadataTopic)
        {
            subscribe(metadataTopic);
        }
    });

    socket.addEventListener("message", (event) =>
    {
        let packet;

        try
        {
            packet = JSON.parse(event.data);
        }
        catch (err)
        {
            options.onError?.(`Bad rosbridge JSON: ${err.message}`);
            return;
        }

        if (packet.op !== "publish")
        {
            return;
        }

        if (packet.topic === frameTopic)
        {
            options.onFrame?.(packet.msg);
            return;
        }

        if (packet.topic === metadataTopic)
        {
            options.onMetadata?.(packet.msg);
        }
    });

    socket.addEventListener("close", () =>
    {
        isConnected = false;
        options.onStatus?.("Disconnected from ROS bridge");
    });

    socket.addEventListener("error", () =>
    {
        options.onError?.(`Could not connect to ROS bridge at ${url}`);
    });
}

/**
 * Disconnect from rosbridge.
*/
export function disconnectRosBridge()
{
    if (!socket)
    {
        return;
    }

    try
    {
        if (isConnected)
        {
            socket.send(JSON.stringify(
            {
                op: "unsubscribe",
                topic: "/srl_magnetic_hand/frame"
            }));
        }

        socket.close();
    }
    catch (err)
    {
        console.warn("ROS bridge disconnect error:", err);
    }

    socket = null;
    isConnected = false;
}

/**
 * Return whether the websocket is currently connected.
 *
 * @return {boolean} True when connected.
*/
export function getRosBridgeConnected()
{
    return isConnected;
}

/**
 * Send a rosbridge subscribe operation.
 *
 * @param {string} topic ROS topic name to subscribe to.
*/
function subscribe(topic)
{
    if (!socket || !topic)
    {
        return;
    }

    socket.send(JSON.stringify(
    {
        op: "subscribe",
        topic: topic,
        queue_length: 1
    }));
}
